const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { buildConflictPath, classifyMedia, planLogicalTarget } = require('./pathPlanner');
const { createHashRecordSession } = require('./hashRecordSession');
const { hashFile } = require('./hashService');
const {
  cleanupTempFiles,
  finalizePlainFile,
  resolveLogicalPath,
  verifyStoredPlainFile,
  writePlainFile
} = require('./plainFileStorage');
const {
  ensureScanState,
  markGenerationCompleted,
  markGenerationPaused,
  saveDiscoveredFolders,
  updateFolderStatus
} = require('./scanManager');
const { findNextPendingCheckpoint } = require('./scanCheckpointStore');
const { loadSource } = require('./metadataStore');
const { loadIgnoreMatcher } = require('./ignoreMatcher');
const { createErrorReportWriter } = require('./errorReportStore');
const { loadSourceSnapshot } = require('./sourceSnapshotStore');
const { updateSourceScanState } = require('./sourceRegistry');
const { toPosixPath } = require('./layout');
const { shortHash } = require('./ids');
const { createWorkScheduler } = require('./workScheduler');
const { createLogger } = require('./logger');

const logger = createLogger('BackupCoordinator', 'backupCoordinator.js');

function createConcurrencyGate(limit) {
  const max = Math.max(1, limit);
  let active = 0;
  const waiters = [];

  return {
    async acquire() {
      if (active < max) {
        active += 1;
        return;
      }

      await new Promise((resolve) => {
        waiters.push(resolve);
      });
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      const next = waiters.shift();
      if (next) {
        next();
      }
    }
  };
}

async function readFolderEntries(folderPath, relativeRoot = '.', ignoreMatcher = null) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const files = [];
  const directories = [];

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    const relativePath = relativeRoot === '.'
      ? entry.name
      : path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      if (ignoreMatcher && ignoreMatcher.shouldIgnore(relativePath, true)) {
        continue;
      }
      directories.push({ name: entry.name, path: fullPath });
    } else if (entry.isFile()) {
      if (relativePath === '.mbignore') {
        continue;
      }
      if (ignoreMatcher && ignoreMatcher.shouldIgnore(relativePath, false)) {
        continue;
      }
      files.push({ name: entry.name, path: fullPath });
    }
  }

  directories.sort((left, right) => left.name.localeCompare(right.name));
  files.sort((left, right) => left.name.localeCompare(right.name));
  return { directories, files };
}

function isMissingPathError(error) {
  return Boolean(error && error.code === 'ENOENT');
}

async function chooseLogicalPath(
  targetRoot,
  source,
  machineId,
  sourceRelativePath,
  fileHash,
  kind,
  timestamp,
  options = {}
) {
  const desiredPath = planLogicalTarget({
    machineId,
    source,
    sourceRelativePath,
    kind,
    timestamp
  });

  const desiredAbsolutePath = resolveLogicalPath(targetRoot, desiredPath);
  if (!(await fs.pathExists(desiredAbsolutePath))) {
    return desiredPath;
  }

  if (options.allowOverwriteExisting) {
    return desiredPath;
  }

  const sameContent = await verifyStoredPlainFile(
    targetRoot,
    { type: 'plain', path: desiredPath },
    fileHash
  );

  if (sameContent) {
    return desiredPath;
  }

  return buildConflictPath(desiredPath, machineId, source.sourceId);
}

async function ensurePlainLogicalPath(targetRoot, sourceFilePath, logicalPath, fileHash, expectedSize, jobId, onCopyProgress) {
  const absolutePath = resolveLogicalPath(targetRoot, logicalPath);
  if (await fs.pathExists(absolutePath)) {
    return false;
  }

  const pendingWrite = await writePlainFile(targetRoot, {
    sourcePath: sourceFilePath,
    logicalPath,
    expectedHash: fileHash,
    expectedSize,
    jobId,
    onProgress: onCopyProgress
  });
  await finalizePlainFile(targetRoot, pendingWrite);
  return true;
}

function createInFlightHashCoordinator() {
  const entries = new Map();

  return {
    claim(fileHash) {
      const existing = entries.get(fileHash);
      if (existing) {
        return {
          leader: false,
          promise: existing.promise
        };
      }

      let resolveEntry;
      let rejectEntry;
      const promise = new Promise((resolve, reject) => {
        resolveEntry = resolve;
        rejectEntry = reject;
      });
      entries.set(fileHash, {
        promise,
        resolve: resolveEntry,
        reject: rejectEntry
      });
      return {
        leader: true,
        promise
      };
    },
    resolve(fileHash, result) {
      const entry = entries.get(fileHash);
      if (!entry) {
        return;
      }
      entries.delete(fileHash);
      entry.resolve(result);
    },
    reject(fileHash, error) {
      const entry = entries.get(fileHash);
      if (!entry) {
        return;
      }
      entries.delete(fileHash);
      entry.reject(error);
    }
  };
}

async function buildPlanFromExistingRecord(
  targetRoot,
  machineId,
  source,
  sourceFilePath,
  sourceRelativePath,
  stats,
  now,
  fileHash,
  kind,
  logicalPath,
  existing,
  hashSession = null
) {
  const absolutePath = existing.content.type === 'plain'
    ? resolveLogicalPath(targetRoot, logicalPath)
    : null;
  const needsMaterializedCopy = existing.content.type === 'plain' && !(await fs.pathExists(absolutePath));

  if (needsMaterializedCopy) {
    return {
      type: 'copy-duplicate',
      fileHash,
      kind,
      logicalPath,
      sourceFilePath,
      sourceRelativePath,
      stats,
      jobId: `${shortHash(`${machineId}:${source.sourceId}:${sourceRelativePath}:${now.toISOString()}`, 12)}-alias`,
      now,
      existingContent: existing.content
    };
  }

  const registration = await hashSession.register({
    fileHash,
    size: stats.size,
    logicalPath,
    kind,
    content: existing.content,
    origin: {
      machineId,
      sourceId: source.sourceId,
      sourceRelativePath
    }
  }, now);

  logger.debug('Indexed existing content.', {
    fileHash,
    logicalPath,
    action: registration.pathStatus === 'alias-added' ? 'indexed-alias' : 'indexed-existing',
    pathStatus: registration.pathStatus,
    originStatus: registration.originStatus
  });

  return {
    action: registration.pathStatus === 'alias-added' ? 'indexed-alias' : 'indexed-existing',
    fileHash,
    logicalPath,
    sourceRelativePath,
    bytesProcessed: stats.size,
    record: registration.record
  };
}

async function planFileOperation(
  targetRoot,
  machineId,
  source,
  sourceFilePath,
  sourceRelativePath,
  stats,
  now = new Date(),
  coordination = null,
  sourceSnapshotCache = null,
  hashSession = null
) {
  logger.debug('Planning file operation.', {
    machineId,
    sourceId: source.sourceId,
    sourceRelativePath,
    size: stats.size
  });
  const cachedEntry = sourceSnapshotCache ? sourceSnapshotCache.get(sourceRelativePath) : null;
  const cachedHashUsable = Boolean(
    cachedEntry &&
    cachedEntry.size === stats.size &&
    cachedEntry.mtimeMs === stats.mtimeMs &&
    cachedEntry.fileHash
  );
  const fileHash = cachedHashUsable ? cachedEntry.fileHash : await hashFile(sourceFilePath, stats.size);
  const kind = classifyMedia(sourceFilePath);
  const jobId = shortHash(`${machineId}:${source.sourceId}:${sourceRelativePath}:${now.toISOString()}`, 12);
  const baseLogicalPath = planLogicalTarget({
    machineId,
    source,
    sourceRelativePath,
    kind,
    timestamp: new Date(stats.mtimeMs)
  });
  const allowOverwriteExisting = Boolean(
    !source.mergeEnabled &&
    cachedEntry &&
    cachedEntry.logicalPath === baseLogicalPath &&
    cachedEntry.fileHash &&
    cachedEntry.fileHash !== fileHash
  );
  const logicalPath = await chooseLogicalPath(
    targetRoot,
    source,
    machineId,
    sourceRelativePath,
    fileHash,
    kind,
    new Date(stats.mtimeMs),
    {
      allowOverwriteExisting
    }
  );
  while (true) {
    const existing = await hashSession.lookup(fileHash);
    if (existing) {
      return buildPlanFromExistingRecord(
        targetRoot,
        machineId,
        source,
        sourceFilePath,
        sourceRelativePath,
        stats,
        now,
        fileHash,
        kind,
        logicalPath,
        existing,
        hashSession
      );
    }

    if (!coordination) {
      return {
        type: 'copy-new',
        fileHash,
        kind,
        logicalPath,
        sourceFilePath,
        sourceRelativePath,
        stats,
        jobId,
        now,
        overwriteExisting: allowOverwriteExisting,
        previousHash: allowOverwriteExisting ? cachedEntry.fileHash : null
      };
    }

    const claim = coordination.claim(fileHash);
    if (claim.leader) {
      logger.debug('Claimed in-flight hash as primary writer.', {
        fileHash,
        logicalPath,
        sourceRelativePath
      });
      return {
        type: 'copy-new',
        fileHash,
        kind,
        logicalPath,
        sourceFilePath,
        sourceRelativePath,
        stats,
        jobId,
        now,
        overwriteExisting: allowOverwriteExisting,
        previousHash: allowOverwriteExisting ? cachedEntry.fileHash : null
      };
    }

    logger.debug('Waiting for in-flight hash registration.', {
      fileHash,
      logicalPath,
      sourceRelativePath
    });

    try {
      await claim.promise;
    } catch (error) {
      logger.warn('In-flight hash registration failed; retrying plan.', {
        fileHash,
        logicalPath,
        sourceRelativePath,
        error: error.message
      });
    }
  }
}

async function executeCopyOperation(targetRoot, machineId, source, plan, callbacks = {}, coordination = null, hashSession = null) {
  if (plan.type === 'copy-new') {
    try {
      if (plan.overwriteExisting && plan.previousHash) {
        await hashSession.unregister({
          fileHash: plan.previousHash,
          logicalPath: plan.logicalPath,
          origin: {
            machineId,
            sourceId: source.sourceId,
            sourceRelativePath: plan.sourceRelativePath
          }
        }, plan.now);
        await fs.remove(resolveLogicalPath(targetRoot, plan.logicalPath));
      }

      const pendingWrite = await writePlainFile(targetRoot, {
        sourcePath: plan.sourceFilePath,
        logicalPath: plan.logicalPath,
        expectedHash: plan.fileHash,
        expectedSize: plan.stats.size,
        jobId: plan.jobId,
        onProgress: callbacks.onCopyProgress
      });
      const content = await finalizePlainFile(targetRoot, pendingWrite);
      const registration = await hashSession.register({
        fileHash: plan.fileHash,
        size: plan.stats.size,
        logicalPath: plan.logicalPath,
        kind: plan.kind,
        content,
        origin: {
          machineId,
          sourceId: source.sourceId,
          sourceRelativePath: plan.sourceRelativePath
        }
      }, plan.now);

      if (coordination) {
        coordination.resolve(plan.fileHash, registration.record);
      }

      logger.debug('Copied new file into backup.', {
        fileHash: plan.fileHash,
        logicalPath: plan.logicalPath,
        sourceRelativePath: plan.sourceRelativePath
      });

      return {
        action: 'copied',
        fileHash: plan.fileHash,
        logicalPath: plan.logicalPath,
        bytesProcessed: plan.stats.size,
        record: registration.record
      };
    } catch (error) {
      if (coordination) {
        coordination.reject(plan.fileHash, error);
      }
      throw error;
    }
  }

  const materialized = await ensurePlainLogicalPath(
    targetRoot,
    plan.sourceFilePath,
    plan.logicalPath,
    plan.fileHash,
    plan.stats.size,
    plan.jobId,
    callbacks.onCopyProgress
  );
  const registration = await hashSession.register({
    fileHash: plan.fileHash,
    size: plan.stats.size,
    logicalPath: plan.logicalPath,
    kind: plan.kind,
    content: plan.existingContent,
    origin: {
      machineId,
      sourceId: source.sourceId,
      sourceRelativePath: plan.sourceRelativePath
    }
  }, plan.now);

  if (materialized) {
    logger.debug('Materialized same-content file at alias path.', {
      fileHash: plan.fileHash,
      logicalPath: plan.logicalPath,
      sourceRelativePath: plan.sourceRelativePath
    });
  }

  return {
    action: materialized ? 'copied-duplicate' : 'indexed-existing',
    fileHash: plan.fileHash,
    logicalPath: plan.logicalPath,
    bytesProcessed: plan.stats.size,
    record: registration.record
  };
}

async function backupSource(targetRoot, machineId, sourceId, options = {}) {
  const source = await loadSource(targetRoot, machineId, sourceId);
  if (!source) {
    throw new Error(`Source not found: ${machineId}/${sourceId}`);
  }

  logger.info('Backup source started.', {
    machineId,
    sourceId,
    targetRoot,
    sourcePath: source.sourcePath
  });

  const traceTaskTimings = String(process.env.MYBACKUP_TRACE_TASK_TIMINGS || '').trim() === '1';
  let hashTaskCount = 0;
  let copyTaskCount = 0;

  await cleanupTempFiles(targetRoot);

  const stateBundle = await ensureScanState(targetRoot, machineId, sourceId, {
    forceNew: options.forceNewScan,
    now: options.now || new Date()
  });

  const scanId = stateBundle.scanState.activeGeneration;
  const summary = {
    machineId,
    sourceId,
    scanId,
    foldersProcessed: 0,
    filesProcessed: 0,
    filesCopied: 0,
    filesIndexed: 0,
    hashTaskDurationMs: 0,
    copyTaskDurationMs: 0,
    conflicts: 0,
    skippedFolders: 0,
    skippedFiles: 0,
    errors: 0,
    reportPath: null
  };
  const progress = {
    machineId,
    sourceId,
    scanId,
    startedAt: (options.now || new Date()).toISOString(),
    status: 'running',
    foldersProcessed: 0,
    filesProcessed: 0,
    filesCopied: 0,
    filesIndexed: 0,
    conflicts: 0,
    skippedFolders: 0,
    skippedFiles: 0,
    errors: 0,
    workers: {},
    queues: {
      hash: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [], feedItems: [] },
      copy: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [], handoffItems: [] }
    }
  };
  let hashScheduler;
  let copyScheduler;
  let schedulersReady = false;
  let pipelineFeed = [];
  const copyHandoffQueue = [];
  const emitProgress = (event) => {
    if (schedulersReady) {
      const hashSnapshot = hashScheduler.snapshot();
      const copySnapshot = copyScheduler.snapshot();
      progress.queues = {
        hash: {
          depth: hashSnapshot.queueDepth,
          pending: hashSnapshot.pendingTasks,
          active: hashSnapshot.inFlightCount,
          waitingItems: hashSnapshot.queuedItems,
          activeItems: hashSnapshot.inFlightItems,
          feedItems: pipelineFeed.slice(0, 20)
        },
        copy: {
          depth: copySnapshot.queueDepth,
          pending: copySnapshot.pendingTasks,
          active: copySnapshot.inFlightCount,
          waitingItems: copySnapshot.queuedItems,
          activeItems: copySnapshot.inFlightItems,
          handoffItems: copyHandoffQueue.slice(0, 20)
        }
      };
    }
    if (typeof options.onProgress === 'function') {
      const forceEmit = event?.type === 'backup-started'
        || event?.type === 'backup-paused'
        || event?.type === 'backup-completed'
        || event?.type === 'backup-pausing'
        || event?.type === 'folder-completed'
        || event?.type === 'folder-skipped';
      const now = Date.now();
      if (!forceEmit && now - lastProgressEmitAt < progressEmitIntervalMs) {
        return;
      }
      lastProgressEmitAt = now;
      options.onProgress({
        summary: { ...summary },
        progress: JSON.parse(JSON.stringify(progress)),
        event
      });
    }
  };
  const cpuCount = os.cpus().length || 4;
  const defaultHashWorkers = Math.min(cpuCount, 8);
  const defaultCopyWorkers = Math.min(cpuCount, 8);
  const maxConcurrentFileTasks = options.maxConcurrentFileTasks
    || Math.max(defaultHashWorkers * 4, 16);
  const progressEmitIntervalMs = options.progressEmitIntervalMs || 150;
  let lastProgressEmitAt = 0;
  const copyProgressEmitIntervalMs = options.copyProgressEmitIntervalMs || 150;
  let lastCopyProgressEmitAt = 0;
  const emitCopyProgress = (event) => {
    const now = Date.now();
    if (now - lastCopyProgressEmitAt < copyProgressEmitIntervalMs) {
      return;
    }
    lastCopyProgressEmitAt = now;
    emitProgress(event);
  };
  const loadedSourceSnapshot = await loadSourceSnapshot(targetRoot, machineId, sourceId);
  const sourceSnapshotCache = new Map(Object.entries((loadedSourceSnapshot && loadedSourceSnapshot.files) || {}));
  const errorReport = await createErrorReportWriter(targetRoot, machineId, sourceId, scanId);
  summary.reportPath = errorReport.reportPath;
  const ignoreMatcher = await loadIgnoreMatcher(source.sourcePath);
  const hashRecordSession = createHashRecordSession(targetRoot);
  const inFlightHashes = createInFlightHashCoordinator();
  const fileTaskGate = createConcurrencyGate(maxConcurrentFileTasks);
  hashScheduler = createWorkScheduler({
    processTask: async (payload) => planFileOperation(
      targetRoot,
      machineId,
      source,
      payload.sourceFilePath,
      payload.sourceRelativePath,
      payload.stats,
      payload.now,
      inFlightHashes,
      sourceSnapshotCache,
      hashRecordSession
    ),
    getTaskBytes: (result, payload) => result?.bytesProcessed || payload.stats.size || 0,
    initialWorkers: options.initialHashWorkers || defaultHashWorkers,
    maxWorkers: options.maxHashWorkers || defaultHashWorkers,
    backlogFactor: options.hashWorkerBacklogFactor || 4,
    trialWindowMs: options.hashWorkerTrialWindowMs || 20000,
    throughputImprovementThreshold: options.hashWorkerThroughputImprovementThreshold || 1.15,
    idleWaitMs: options.hashWorkerIdleWaitMs || 10,
    summarizePayload: (payload) => ({
      sourceRelativePath: payload.sourceRelativePath,
      totalBytes: payload.stats?.size || 0
    }),
    onWorkerEvent: (workerEvent) => {
      const workerKey = `hash:${workerEvent.workerId}`;
      if (workerEvent.type === 'worker-started') {
        progress.workers[workerKey] = {
          workerId: workerEvent.workerId,
          pool: 'hash',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: 0
        };
      } else if (workerEvent.type === 'task-started') {
        progress.workers[workerKey] = {
          workerId: workerEvent.workerId,
          pool: 'hash',
          state: 'hashing',
          sourceRelativePath: workerEvent.payload.sourceRelativePath,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: workerEvent.payload.stats.size
        };
      } else if (workerEvent.type === 'task-completed') {
        progress.workers[workerKey] = {
          workerId: workerEvent.workerId,
          pool: 'hash',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: workerEvent.result.logicalPath,
          copiedBytes: workerEvent.result.bytesProcessed || 0,
          totalBytes: workerEvent.result.bytesProcessed || 0,
          lastAction: workerEvent.result.action,
          lastTaskDurationMs: workerEvent.durationMs || 0
        };
        if (workerEvent.result.action === 'indexed-existing' || workerEvent.result.action === 'indexed-alias') {
          progress.filesIndexed += 1;
          progress.filesProcessed += 1;
        }
        hashTaskCount += 1;
        summary.hashTaskDurationMs += workerEvent.durationMs || 0;
        if (workerEvent.snapshot && typeof workerEvent.snapshot.throughputBytesPerSecond === 'number') {
          progress.hashThroughputBytesPerSecond = workerEvent.snapshot.throughputBytesPerSecond;
        }
        if (traceTaskTimings) {
          logger.info('Hash task completed.', {
            sourceRelativePath: workerEvent.payload.sourceRelativePath,
            logicalPath: workerEvent.result.logicalPath,
            action: workerEvent.result.action,
            durationMs: workerEvent.durationMs || 0,
            bytesProcessed: workerEvent.result.bytesProcessed || 0
          });
        }
      } else if (workerEvent.type === 'task-failed') {
        progress.workers[workerKey] = {
          workerId: workerEvent.workerId,
          pool: 'hash',
          state: 'error',
          sourceRelativePath: workerEvent.payload.sourceRelativePath,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: workerEvent.payload.stats.size,
          error: workerEvent.error.message,
          lastTaskDurationMs: workerEvent.durationMs || 0
        };
        logger.warn('Hash task failed.', {
          sourceRelativePath: workerEvent.payload.sourceRelativePath,
          durationMs: workerEvent.durationMs || 0,
          error: workerEvent.error.message
        });
      }
      emitProgress({ ...workerEvent, pool: 'hash' });
    }
  });
  copyScheduler = createWorkScheduler({
    processTask: async (payload, workerContext) => executeCopyOperation(
      targetRoot,
      machineId,
      source,
      payload.plan,
      {
        onCopyProgress: (copyProgress) => {
          const workerKey = `copy:${workerContext.workerId}`;
          progress.workers[workerKey] = {
            workerId: workerContext.workerId,
            pool: 'copy',
            state: 'copying',
            sourceRelativePath: payload.plan.sourceRelativePath,
            logicalPath: copyProgress.logicalPath,
            copiedBytes: copyProgress.copiedBytes,
            totalBytes: copyProgress.totalBytes
          };
          emitCopyProgress({
            type: 'copy-progress',
            pool: 'copy',
            workerId: workerContext.workerId,
            sourceRelativePath: payload.plan.sourceRelativePath
          });
        }
      },
      inFlightHashes,
      hashRecordSession
    ),
    getTaskBytes: (result, payload) => result?.bytesProcessed || payload.plan.stats.size || 0,
    initialWorkers: options.initialCopyWorkers || defaultCopyWorkers,
    maxWorkers: options.maxCopyWorkers || defaultCopyWorkers * 2,
    backlogFactor: options.copyWorkerBacklogFactor || 4,
    trialWindowMs: options.copyWorkerTrialWindowMs || 20000,
    throughputImprovementThreshold: options.copyWorkerThroughputImprovementThreshold || 1.15,
    idleWaitMs: options.copyWorkerIdleWaitMs || 10,
    summarizePayload: (payload) => ({
      sourceRelativePath: payload.plan?.sourceRelativePath || null,
      logicalPath: payload.plan?.logicalPath || null,
      totalBytes: payload.plan?.stats?.size || 0
    }),
    onWorkerEvent: (workerEvent) => {
      const workerKey = `copy:${workerEvent.workerId}`;
      if (workerEvent.type === 'worker-started') {
        progress.workers[workerKey] = {
          workerId: workerEvent.workerId,
          pool: 'copy',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: 0
        };
      } else if (workerEvent.type === 'task-started') {
        progress.workers[workerKey] = {
          workerId: workerEvent.workerId,
          pool: 'copy',
          state: 'queued-copy',
          sourceRelativePath: workerEvent.payload.plan.sourceRelativePath,
          logicalPath: workerEvent.payload.plan.logicalPath,
          copiedBytes: 0,
          totalBytes: workerEvent.payload.plan.stats.size
        };
      } else if (workerEvent.type === 'task-completed') {
        progress.workers[workerKey] = {
          workerId: workerEvent.workerId,
          pool: 'copy',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: workerEvent.result.logicalPath,
          copiedBytes: workerEvent.result.bytesProcessed || 0,
          totalBytes: workerEvent.result.bytesProcessed || 0,
          lastAction: workerEvent.result.action,
          lastTaskDurationMs: workerEvent.durationMs || 0
        };
        if (workerEvent.result.action === 'copied' || workerEvent.result.action === 'copied-duplicate') {
          progress.filesCopied += 1;
          progress.filesProcessed += 1;
        }
        copyTaskCount += 1;
        summary.copyTaskDurationMs += workerEvent.durationMs || 0;
        if (traceTaskTimings) {
          logger.info('Copy task completed.', {
            sourceRelativePath: workerEvent.payload.plan.sourceRelativePath,
            logicalPath: workerEvent.result.logicalPath,
            action: workerEvent.result.action,
            durationMs: workerEvent.durationMs || 0,
            bytesProcessed: workerEvent.result.bytesProcessed || 0
          });
        }
      } else if (workerEvent.type === 'task-failed') {
        progress.workers[workerKey] = {
          workerId: workerEvent.workerId,
          pool: 'copy',
          state: 'error',
          sourceRelativePath: workerEvent.payload.plan.sourceRelativePath,
          logicalPath: workerEvent.payload.plan.logicalPath,
          copiedBytes: 0,
          totalBytes: workerEvent.payload.plan.stats.size,
          error: workerEvent.error.message,
          lastTaskDurationMs: workerEvent.durationMs || 0
        };
        logger.warn('Copy task failed.', {
          sourceRelativePath: workerEvent.payload.plan.sourceRelativePath,
          logicalPath: workerEvent.payload.plan.logicalPath,
          durationMs: workerEvent.durationMs || 0,
          error: workerEvent.error.message
        });
      }
      emitProgress({ ...workerEvent, pool: 'copy' });
      if (workerEvent.snapshot && typeof workerEvent.snapshot.throughputBytesPerSecond === 'number') {
        progress.copyThroughputBytesPerSecond = workerEvent.snapshot.throughputBytesPerSecond;
      }
    }
  });
  schedulersReady = true;
  emitProgress({ type: 'backup-started' });

  let paused = false;
  let pausePhase = null;
  const folderCompletions = [];
  const shouldStopForPause = () => typeof options.shouldPause === 'function' && options.shouldPause();

  function pauseWorkSnapshot() {
    if (!schedulersReady) {
      return {
        folderCompletions: folderCompletions.length,
        pipelineFeed: pipelineFeed.length,
        copyHandoff: copyHandoffQueue.length
      };
    }

    const hashSnapshot = hashScheduler.snapshot();
    const copySnapshot = copyScheduler.snapshot();
    return {
      folderCompletions: folderCompletions.length,
      pipelineFeed: pipelineFeed.length,
      copyHandoff: copyHandoffQueue.length,
      hash: {
        pending: hashSnapshot.pendingTasks,
        queueDepth: hashSnapshot.queueDepth,
        inFlight: hashSnapshot.inFlightCount
      },
      copy: {
        pending: copySnapshot.pendingTasks,
        queueDepth: copySnapshot.queueDepth,
        inFlight: copySnapshot.inFlightCount
      }
    };
  }

  async function emitPausePhase(phase, message) {
    pausePhase = phase;
    progress.status = 'pausing';
    progress.pausePhase = phase;
    logger.info(message, pauseWorkSnapshot());
    emitProgress({ type: 'backup-pausing', phase });
  }

  async function shutdownForPause() {
    await emitPausePhase('cancelling-queues', 'Pause: cancelling queued hash/copy work.');
    await hashScheduler.closeAndCancel();
    await emitPausePhase('hash-cancelled', 'Pause: hash scheduler queue cancelled; waiting for in-flight hash tasks.');
    await copyScheduler.closeAndCancel();
    await emitPausePhase('copy-cancelled', 'Pause: copy scheduler queue cancelled; waiting for in-flight copy tasks.');
    await emitPausePhase('waiting-folder-tasks', 'Pause: waiting for in-flight folder tasks to settle.');
    await Promise.allSettled(folderCompletions);
    await emitPausePhase('folder-tasks-settled', 'Pause: in-flight folder tasks settled.');
  }

  try {
    while (true) {
      if (shouldStopForPause()) {
        paused = true;
        logger.info('Pause: scan loop stopping at folder boundary.', pauseWorkSnapshot());
        break;
      }

      const nextCheckpoint = await findNextPendingCheckpoint(targetRoot, machineId, sourceId, scanId);
      if (!nextCheckpoint) {
        break;
      }

      logger.debug('Scanning folder checkpoint.', {
        scanId,
        folderPath: nextCheckpoint.folderPath,
        relativePath: nextCheckpoint.relativePath,
        status: nextCheckpoint.status
      });

      const scanningCheckpoint = await updateFolderStatus(
        targetRoot,
        machineId,
        sourceId,
        scanId,
        nextCheckpoint,
        'scanning',
        {
          filesSeen: nextCheckpoint.filesSeen,
          subfoldersSeen: nextCheckpoint.subfoldersSeen
        },
        options.now || new Date()
      );

      let directories;
      let files;
      try {
        ({ directories, files } = await readFolderEntries(
          scanningCheckpoint.folderPath,
          scanningCheckpoint.relativePath,
          ignoreMatcher
        ));
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }

        logger.warn('Skipped missing folder during scan.', {
          scanId,
          folderPath: scanningCheckpoint.folderPath,
          relativePath: scanningCheckpoint.relativePath
        });
        await errorReport.append({
          type: 'missing-folder',
          relativePath: scanningCheckpoint.relativePath,
          path: scanningCheckpoint.folderPath,
          code: error.code,
          message: error.message
        });
        await updateFolderStatus(
          targetRoot,
          machineId,
          sourceId,
          scanId,
          scanningCheckpoint,
          'failed',
          {
            filesSeen: 0,
            subfoldersSeen: 0
          },
          options.now || new Date()
        );
        summary.skippedFolders += 1;
        summary.errors += 1;
        progress.skippedFolders = summary.skippedFolders;
        progress.errors = summary.errors;
        emitProgress({
          type: 'folder-skipped',
          relativePath: scanningCheckpoint.relativePath
        });
        continue;
      }
      logger.debug('Folder entries discovered.', {
        scanId,
        relativePath: scanningCheckpoint.relativePath,
        files: files.length,
        directories: directories.length
      });
      await saveDiscoveredFolders(
        targetRoot,
        machineId,
        sourceId,
        scanId,
        scanningCheckpoint.relativePath,
        directories,
        options.now || new Date()
      );

      const fileStatsByRelativePath = new Map();
      const fileResults = [];
      const fileResultsByRelativePath = new Map();
      const fileTasks = [];

      for (const fileEntry of files) {
        if (shouldStopForPause()) {
          paused = true;
          logger.info('Pause: stopping file scan mid-folder.', {
            relativePath: scanningCheckpoint.relativePath,
            filesScanned: fileTasks.length,
            filesRemaining: files.length - fileTasks.length,
            ...pauseWorkSnapshot()
          });
          break;
        }

        const sourceRelativePath = scanningCheckpoint.relativePath === '.'
          ? fileEntry.name
          : path.posix.join(scanningCheckpoint.relativePath, fileEntry.name);
        const normalizedRelativePath = toPosixPath(sourceRelativePath);

        fileTasks.push((async () => {
          await fileTaskGate.acquire();
          try {
          let stats;
          try {
            stats = await fs.stat(fileEntry.path);
          } catch (error) {
            logger.warn('Skipped unreadable or missing file during scan.', {
              scanId,
              sourceRelativePath: normalizedRelativePath,
              code: error.code || null
            });
            await errorReport.append({
              type: isMissingPathError(error) ? 'missing-file' : 'file-stat-error',
              relativePath: normalizedRelativePath,
              path: fileEntry.path,
              code: error.code || null,
              message: error.message
            });
            summary.skippedFiles += 1;
            summary.errors += 1;
            progress.skippedFiles = summary.skippedFiles;
            progress.errors = summary.errors;
            emitProgress({
              type: 'file-skipped',
              sourceRelativePath: normalizedRelativePath
            });
            return null;
          }

          fileStatsByRelativePath.set(normalizedRelativePath, stats);
          pipelineFeed.push({
            sourceRelativePath: normalizedRelativePath,
            totalBytes: stats.size
          });

          const feedIndex = pipelineFeed.findIndex(
            (entry) => entry.sourceRelativePath === normalizedRelativePath
          );
          if (feedIndex >= 0) {
            pipelineFeed.splice(feedIndex, 1);
          }

          const finalResult = await hashScheduler.push({
            sourceFilePath: fileEntry.path,
            sourceRelativePath: normalizedRelativePath,
            stats,
            now: options.now || new Date()
          })
            .then((planResult) => {
              if (planResult.type === 'copy-new' || planResult.type === 'copy-duplicate') {
                const handoffItem = {
                  sourceRelativePath: planResult.sourceRelativePath,
                  logicalPath: planResult.logicalPath,
                  totalBytes: planResult.stats?.size || stats.size
                };
                copyHandoffQueue.push(handoffItem);
                return copyScheduler.push({ plan: planResult })
                  .finally(() => {
                    const handoffIndex = copyHandoffQueue.findIndex(
                      (entry) => entry.sourceRelativePath === handoffItem.sourceRelativePath
                        && entry.logicalPath === handoffItem.logicalPath
                    );
                    if (handoffIndex >= 0) {
                      copyHandoffQueue.splice(handoffIndex, 1);
                    }
                  });
              }
              return planResult;
            });

          fileResults.push(finalResult);
          if (finalResult) {
            fileResultsByRelativePath.set(normalizedRelativePath, finalResult);
          }
          return finalResult;
          } finally {
            fileTaskGate.release();
          }
        })().catch(async (error) => {
          if (error && error.code === 'PAUSE_CANCELLED') {
            return null;
          }
          logger.error('File backup failed; continuing with next file.', {
            sourceRelativePath: normalizedRelativePath,
            code: error.code || null,
            message: error.message
          });
          await errorReport.append({
            type: 'file-error',
            relativePath: normalizedRelativePath,
            path: fileEntry.path,
            code: error.code || null,
            message: error.message
          });
          summary.errors += 1;
          progress.errors = summary.errors;
          emitProgress({
            type: 'file-error',
            sourceRelativePath: normalizedRelativePath
          });
          return null;
        }));
      }

      if (paused) {
        break;
      }

      folderCompletions.push((async () => {
      await Promise.all(fileTasks);

      for (const result of fileResults.filter(Boolean)) {
        summary.filesProcessed += 1;
        if (result.action === 'copied' || result.action === 'copied-duplicate') {
          summary.filesCopied += 1;
        } else {
          summary.filesIndexed += 1;
        }
        if (result.logicalPath.includes(' [')) {
          summary.conflicts += 1;
        }
        progress.conflicts = summary.conflicts;
      }

      for (const [sourceRelativePath, stats] of fileStatsByRelativePath.entries()) {
        const matchingResult = fileResultsByRelativePath.get(sourceRelativePath);
        if (matchingResult) {
          sourceSnapshotCache.set(sourceRelativePath, {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            fileHash: matchingResult.fileHash,
            logicalPath: matchingResult.logicalPath,
            updatedAt: (options.now || new Date()).toISOString()
          });
        }
      }

      await updateFolderStatus(
        targetRoot,
        machineId,
        sourceId,
        scanId,
        scanningCheckpoint,
        'done',
        {
          filesSeen: files.length,
          subfoldersSeen: directories.length
        },
        options.now || new Date()
      );

      summary.foldersProcessed += 1;
      progress.foldersProcessed = summary.foldersProcessed;
      await hashRecordSession.flush();
      emitProgress({
        type: 'folder-completed',
        relativePath: scanningCheckpoint.relativePath
      });
      })());
    }
  } finally {
    await hashRecordSession.flush();
    if (paused) {
      await shutdownForPause();
    } else {
      await Promise.all(folderCompletions);
      await hashScheduler.closeAndDrain();
      await copyScheduler.closeAndDrain();
    }
  }

  if (paused) {
    logger.info('Pause: persisting paused scan state.', {
      scanId,
      pausePhase,
      ...pauseWorkSnapshot()
    });
    await markGenerationPaused(targetRoot, machineId, sourceId, options.now || new Date());
    progress.status = 'paused';
    delete progress.pausePhase;
    emitProgress({ type: 'backup-paused' });
    logger.info('Pause: backup run paused.', {
      scanId,
      foldersProcessed: summary.foldersProcessed,
      filesProcessed: summary.filesProcessed,
      filesCopied: summary.filesCopied
    });
    return {
      ...summary,
      status: 'paused'
    };
  }

  await markGenerationCompleted(targetRoot, machineId, sourceId, options.now || new Date());
  await updateSourceScanState(
    targetRoot,
    machineId,
    sourceId,
    {
      lastCompletedScan: scanId,
      lastCompletedAt: (options.now || new Date()).toISOString()
    },
    options.now || new Date()
  );
  progress.status = 'completed';
  progress.filesProcessed = summary.filesProcessed;
  progress.filesCopied = summary.filesCopied;
  progress.filesIndexed = summary.filesIndexed;
  progress.conflicts = summary.conflicts;
  progress.errors = summary.errors;
  emitProgress({ type: 'backup-completed' });

  summary.hashTaskAverageMs = hashTaskCount > 0 ? Math.round(summary.hashTaskDurationMs / hashTaskCount) : 0;
  summary.copyTaskAverageMs = copyTaskCount > 0 ? Math.round(summary.copyTaskDurationMs / copyTaskCount) : 0;
  logger.info('Backup source completed.', summary);

  return {
    ...summary,
    status: 'completed'
  };
}

module.exports = {
  backupSource
};
