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
  markGenerationPaused
} = require('./scanManager');
const { loadSource } = require('./metadataStore');
const { loadIgnoreMatcher } = require('./ignoreMatcher');
const { createErrorReportWriter } = require('./errorReportStore');
const { createSourceSnapshot, loadSourceSnapshot, saveSourceSnapshot } = require('./sourceSnapshotStore');
const { updateSourceScanState } = require('./sourceRegistry');
const { toPosixPath } = require('./layout');
const { shortHash } = require('./ids');
const {
  completeResumeRun,
  markResumeFolder,
  pauseResumeRun,
  saveResumeCursor,
  startResumeRun
} = require('./resume');
const { createWorkScheduler } = require('./workScheduler');
const { createBoundedQueue } = require('./pipeline/boundedQueue');
const { createFixedWorkerPool } = require('./pipeline/fixedWorkerPool');
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
    cachedEntry.logicalPath &&
    cachedEntry.fileHash &&
    cachedEntry.fileHash !== fileHash
  );
  const logicalPath = allowOverwriteExisting
    ? cachedEntry.logicalPath
    : await chooseLogicalPath(
      targetRoot,
      source,
      machineId,
      sourceRelativePath,
      fileHash,
      kind,
      new Date(stats.mtimeMs)
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
        sourceRelativePath: plan.sourceRelativePath,
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
    sourceRelativePath: plan.sourceRelativePath,
    bytesProcessed: plan.stats.size,
    record: registration.record
  };
}

async function backupSourceLegacy(targetRoot, machineId, sourceId, options = {}) {
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
  const traceProgressUi = String(process.env.MYBACKUP_TRACE_PROGRESS_UI || '1').trim() !== '0';
  const progressTraceLogLimit = Number(options.progressTraceLogLimit || 160);
  let progressTraceLogCount = 0;
  let progressTraceSequence = 0;
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
  const summarizeTraceWorker = (worker) => ({
    id: worker.workerId,
    pool: worker.pool,
    state: worker.state,
    sourceRelativePath: worker.sourceRelativePath || null,
    logicalPath: worker.logicalPath || null,
    lastAction: worker.lastAction || null,
    copiedBytes: worker.copiedBytes || 0,
    totalBytes: worker.totalBytes || 0
  });
  const summarizeTraceQueue = (queue) => ({
    depth: queue?.depth || 0,
    pending: queue?.pending || 0,
    active: queue?.active || 0,
    waitingItems: (queue?.waitingItems || []).slice(0, 8),
    activeItems: (queue?.activeItems || []).slice(0, 8),
    feedItems: (queue?.feedItems || []).slice(0, 8),
    handoffItems: (queue?.handoffItems || []).slice(0, 8)
  });
  const buildProgressTrace = (event, emitted) => {
    if (!traceProgressUi) {
      return null;
    }
    const workers = Object.values(progress.workers || {});
    return {
      sequence: progressTraceSequence,
      stage: emitted ? 'coordinator-emitted' : 'coordinator-throttled',
      emitted,
      timestamp: new Date().toISOString(),
      event: event ? {
        type: event.type,
        pool: event.pool || null,
        workerId: event.workerId || null,
        sourceRelativePath: event.sourceRelativePath || null
      } : null,
      status: progress.status,
      counters: {
        foldersProcessed: progress.foldersProcessed,
        filesProcessed: progress.filesProcessed,
        filesCopied: progress.filesCopied,
        filesIndexed: progress.filesIndexed,
        errors: progress.errors
      },
      hashWorkers: workers.filter((worker) => worker.pool === 'hash').map(summarizeTraceWorker),
      copyWorkers: workers.filter((worker) => worker.pool === 'copy').map(summarizeTraceWorker),
      invalidWorkers: workers.filter((worker) => worker.pool !== 'hash' && worker.pool !== 'copy').map(summarizeTraceWorker),
      hashQueue: summarizeTraceQueue(progress.queues?.hash),
      copyQueue: summarizeTraceQueue(progress.queues?.copy)
    };
  };
  const emitProgress = (event) => {
    progressTraceSequence += 1;
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
        if (traceProgressUi && progressTraceLogCount < progressTraceLogLimit) {
          progressTraceLogCount += 1;
          logger.info('Progress trace: coordinator throttled event.', buildProgressTrace(event, false));
        }
        return;
      }
      lastProgressEmitAt = now;
      const trace = buildProgressTrace(event, true);
      if (traceProgressUi && progressTraceLogCount < progressTraceLogLimit) {
        progressTraceLogCount += 1;
        logger.info('Progress trace: coordinator emitted event.', trace);
      }
      options.onProgress({
        summary: { ...summary },
        progress: JSON.parse(JSON.stringify(progress)),
        event,
        trace
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
  const resumeRun = await startResumeRun(targetRoot, machineId, sourceId, source.sourcePath, {
    backupId: scanId,
    forceNew: options.forceNewScan,
    ignoreMatcher,
    now: options.now || new Date()
  });
  logger.info('Resume run initialized.', {
    machineId,
    sourceId,
    scanId,
    backupId: resumeRun.backupId,
    resumed: resumeRun.resumed,
    cursor: resumeRun.cursor
      ? {
          relativePath: resumeRun.cursor.relativePath,
          folderHash: resumeRun.cursor.folderHash,
          status: resumeRun.cursor.status
        }
      : null
  });
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
          logicalPath: null,
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

  let activeResumeCursor = null;
  let lastScheduledResumeCursor = resumeRun.cursor || null;
  let lastCompletedResumeCursor = resumeRun.cursor || null;

  try {
    for await (const resumeFolder of resumeRun.folders) {
      if (shouldStopForPause()) {
        paused = true;
        logger.info('Pause: scan loop stopping at folder boundary.', pauseWorkSnapshot());
        break;
      }

      logger.debug('Scanning resume folder.', {
        scanId,
        folderPath: resumeFolder.folderPath,
        relativePath: resumeFolder.relativePath,
        folderHash: resumeFolder.folderHash
      });

      activeResumeCursor = {
        folderHash: resumeFolder.folderHash,
        folderPath: resumeFolder.folderPath,
        relativePath: resumeFolder.relativePath,
        status: 'scanning'
      };
      logger.info('Processing folder from traversal stack.', {
        scanId,
        folderPath: resumeFolder.folderPath,
        relativePath: resumeFolder.relativePath,
        folderHash: resumeFolder.folderHash,
        resumed: resumeRun.resumed,
        foldersProcessed: summary.foldersProcessed,
        filesProcessed: summary.filesProcessed,
        filesCopied: summary.filesCopied
      });
      lastScheduledResumeCursor = activeResumeCursor;
      await saveResumeCursor(targetRoot, machineId, sourceId, resumeRun.backupId, activeResumeCursor, {
        status: 'running',
        now: options.now || new Date()
      });
      await markResumeFolder(
        targetRoot,
        machineId,
        sourceId,
        resumeRun.backupId,
        resumeFolder,
        'scanning',
        {},
        options.now || new Date()
      );

      let directories;
      let files;
      try {
        ({ directories, files } = await readFolderEntries(
          resumeFolder.folderPath,
          resumeFolder.relativePath,
          ignoreMatcher
        ));
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }

        logger.warn('Skipped missing folder during scan.', {
          scanId,
          folderPath: resumeFolder.folderPath,
          relativePath: resumeFolder.relativePath
        });
        await errorReport.append({
          type: 'missing-folder',
          relativePath: resumeFolder.relativePath,
          path: resumeFolder.folderPath,
          code: error.code,
          message: error.message
        });
        await markResumeFolder(
          targetRoot,
          machineId,
          sourceId,
          resumeRun.backupId,
          resumeFolder,
          'failed',
          {},
          options.now || new Date()
        );
        lastCompletedResumeCursor = {
          folderHash: resumeFolder.folderHash,
          folderPath: resumeFolder.folderPath,
          relativePath: resumeFolder.relativePath,
          status: 'done'
        };
        await saveResumeCursor(targetRoot, machineId, sourceId, resumeRun.backupId, lastCompletedResumeCursor, {
          status: 'running',
          now: options.now || new Date()
        });
        summary.skippedFolders += 1;
        summary.errors += 1;
        progress.skippedFolders = summary.skippedFolders;
        progress.errors = summary.errors;
        emitProgress({
          type: 'folder-skipped',
          relativePath: resumeFolder.relativePath
        });
        continue;
      }
      logger.debug('Folder entries discovered.', {
        scanId,
        relativePath: resumeFolder.relativePath,
        files: files.length,
        directories: directories.length
      });
      await markResumeFolder(
        targetRoot,
        machineId,
        sourceId,
        resumeRun.backupId,
        resumeFolder,
        'scanning',
        {
          filesSeen: files.length,
          childrenSeen: directories.length
        },
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
            relativePath: resumeFolder.relativePath,
            filesScanned: fileTasks.length,
            filesRemaining: files.length - fileTasks.length,
            ...pauseWorkSnapshot()
          });
          break;
        }

        const sourceRelativePath = resumeFolder.relativePath === '.'
          ? fileEntry.name
          : path.posix.join(resumeFolder.relativePath, fileEntry.name);
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

      const folderCompletion = (async () => {
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

      await markResumeFolder(
        targetRoot,
        machineId,
        sourceId,
        resumeRun.backupId,
        resumeFolder,
        'done',
        {
          filesSeen: files.length,
          filesDone: fileResults.filter(Boolean).length,
          childrenSeen: directories.length,
          childrenDone: directories.length
        },
        options.now || new Date()
      );
      lastCompletedResumeCursor = {
        folderHash: resumeFolder.folderHash,
        folderPath: resumeFolder.folderPath,
        relativePath: resumeFolder.relativePath,
        status: 'done'
      };
      await saveResumeCursor(targetRoot, machineId, sourceId, resumeRun.backupId, lastCompletedResumeCursor, {
        status: 'running',
        now: options.now || new Date()
      });

      summary.foldersProcessed += 1;
      progress.foldersProcessed = summary.foldersProcessed;
      await hashRecordSession.flush();
      emitProgress({
        type: 'folder-completed',
        relativePath: resumeFolder.relativePath
      });
      })();
      folderCompletions.push(folderCompletion);
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
    const pausedCursor = activeResumeCursor
      && lastCompletedResumeCursor
      && activeResumeCursor.folderHash === lastCompletedResumeCursor.folderHash
      && activeResumeCursor.relativePath === lastCompletedResumeCursor.relativePath
      ? lastCompletedResumeCursor
      : activeResumeCursor || lastCompletedResumeCursor;
    await markGenerationPaused(targetRoot, machineId, sourceId, options.now || new Date(), pausedCursor);
    await pauseResumeRun(
      targetRoot,
      machineId,
      sourceId,
      resumeRun.backupId,
      pausedCursor,
      options.now || new Date()
    );
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
  await completeResumeRun(
    targetRoot,
    machineId,
    sourceId,
    resumeRun.backupId,
    lastScheduledResumeCursor
      ? { ...lastScheduledResumeCursor, status: 'done' }
      : lastCompletedResumeCursor,
    options.now || new Date()
  );
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

async function backupSource(targetRoot, machineId, sourceId, options = {}) {
  if (options.useLegacyPipeline) {
    return backupSourceLegacy(targetRoot, machineId, sourceId, options);
  }

  const source = await loadSource(targetRoot, machineId, sourceId);
  if (!source) {
    throw new Error(`Source not found: ${machineId}/${sourceId}`);
  }

  const now = options.now || new Date();
  const hashWorkerCount = Math.max(1, options.initialHashWorkers || options.maxHashWorkers || 6);
  const copyWorkerCount = Math.max(1, options.initialCopyWorkers || options.maxCopyWorkers || 6);
  const hashQueueCapacity = Math.max(hashWorkerCount * 8, options.hashQueueCapacity || 64);
  const copyQueueCapacity = Math.max(copyWorkerCount * 8, options.copyQueueCapacity || 64);
  const shouldStopForPause = () => typeof options.shouldPause === 'function' && options.shouldPause();

  logger.info('Backup source started.', {
    machineId,
    sourceId,
    targetRoot,
    sourcePath: source.sourcePath,
    pipeline: 'fixed-worker',
    workerPools: {
      hash: hashWorkerCount,
      copy: copyWorkerCount
    }
  });

  await cleanupTempFiles(targetRoot);

  const stateBundle = await ensureScanState(targetRoot, machineId, sourceId, {
    forceNew: options.forceNewScan,
    now
  });
  const scanId = stateBundle.scanState.activeGeneration;
  const startedAt = Date.now();
  let hashTaskCount = 0;
  let copyTaskCount = 0;
  let paused = false;
  let pausePhase = null;
  let activeResumeCursor = null;
  let lastScheduledResumeCursor = null;
  let lastCompletedResumeCursor = null;
  let firstCopyTaskLogged = false;
  let lastProgressEmitAt = 0;
  let hashBytesProcessed = 0;
  let copyBytesProcessed = 0;

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
    startedAt: now.toISOString(),
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

  const loadedSourceSnapshot = await loadSourceSnapshot(targetRoot, machineId, sourceId);
  const sourceSnapshot = createSourceSnapshot(machineId, sourceId, loadedSourceSnapshot, now);
  const sourceSnapshotCache = new Map(Object.entries(sourceSnapshot.files || {}));
  const errorReport = await createErrorReportWriter(targetRoot, machineId, sourceId, scanId);
  summary.reportPath = errorReport.reportPath;
  const ignoreMatcher = await loadIgnoreMatcher(source.sourcePath);
  const resumeRun = await startResumeRun(targetRoot, machineId, sourceId, source.sourcePath, {
    backupId: scanId,
    forceNew: options.forceNewScan,
    ignoreMatcher,
    now
  });
  lastScheduledResumeCursor = resumeRun.cursor || null;
  lastCompletedResumeCursor = resumeRun.cursor || null;

  logger.info('Resume run initialized.', {
    machineId,
    sourceId,
    scanId,
    backupId: resumeRun.backupId,
    resumed: resumeRun.resumed,
    cursor: resumeRun.cursor
      ? {
          relativePath: resumeRun.cursor.relativePath,
          folderHash: resumeRun.cursor.folderHash,
          status: resumeRun.cursor.status
        }
      : null
  });

  const hashRecordSession = createHashRecordSession(targetRoot);
  const inFlightHashes = createInFlightHashCoordinator();
  const hashQueue = createBoundedQueue({ name: 'hash', capacity: hashQueueCapacity });
  const copyQueue = createBoundedQueue({ name: 'copy', capacity: copyQueueCapacity });
  const pendingFilePromises = new Set();

  function queuePreview(queue, mapper) {
    return queue.preview(20, mapper);
  }

  function refreshQueues() {
    const hashSnapshot = hashQueue.snapshot();
    const copySnapshot = copyQueue.snapshot();
    const hashWorkers = Object.values(progress.workers).filter((worker) => worker.pool === 'hash' && worker.state === 'hashing');
    const copyWorkers = Object.values(progress.workers).filter((worker) => worker.pool === 'copy' && worker.state === 'copying');

    progress.queues = {
      hash: {
        depth: hashSnapshot.depth,
        pending: hashSnapshot.depth + hashWorkers.length,
        active: hashWorkers.length,
        waitingItems: queuePreview(hashQueue, (item) => ({
          sourceRelativePath: item.sourceRelativePath,
          totalBytes: item.stats?.size || 0
        })),
        activeItems: hashWorkers.map((worker) => ({
          sourceRelativePath: worker.sourceRelativePath,
          totalBytes: worker.totalBytes || 0
        })),
        feedItems: []
      },
      copy: {
        depth: copySnapshot.depth,
        pending: copySnapshot.depth + copyWorkers.length,
        active: copyWorkers.length,
        waitingItems: queuePreview(copyQueue, (item) => ({
          sourceRelativePath: item.plan?.sourceRelativePath || null,
          logicalPath: item.plan?.logicalPath || null,
          totalBytes: item.plan?.stats?.size || 0
        })),
        activeItems: copyWorkers.map((worker) => ({
          sourceRelativePath: worker.sourceRelativePath,
          logicalPath: worker.logicalPath,
          totalBytes: worker.totalBytes || 0
        })),
        handoffItems: []
      }
    };
  }

  function emitProgress(event, force = false) {
    refreshQueues();
    if (typeof options.onProgress !== 'function') {
      return;
    }
    const forceEmit = force
      || event?.type === 'backup-started'
      || event?.type === 'backup-paused'
      || event?.type === 'backup-completed'
      || event?.type === 'backup-pausing'
      || event?.type === 'folder-completed'
      || event?.type === 'folder-skipped'
      || event?.type === 'copy-progress';
    const interval = options.progressEmitIntervalMs === undefined ? 250 : options.progressEmitIntervalMs;
    const current = Date.now();
    if (!forceEmit && interval > 0 && current - lastProgressEmitAt < interval) {
      return;
    }
    lastProgressEmitAt = current;
    options.onProgress({
      summary: { ...summary },
      progress: JSON.parse(JSON.stringify(progress)),
      event,
      trace: null
    });
  }

  function setPausePhase(phase, message) {
    pausePhase = phase;
    progress.status = 'pausing';
    progress.pausePhase = phase;
    logger.info(message, {
      hash: progress.queues.hash,
      copy: progress.queues.copy,
      pendingFiles: pendingFilePromises.size
    });
    emitProgress({ type: 'backup-pausing', phase }, true);
  }

  function updateCompletedResult(result, stats) {
    if (!result) {
      return;
    }
    summary.filesProcessed += 1;
    if (result.action === 'copied' || result.action === 'copied-duplicate') {
      summary.filesCopied += 1;
    } else {
      summary.filesIndexed += 1;
    }
    if (result.logicalPath && result.logicalPath.includes(' [')) {
      summary.conflicts += 1;
    }

    progress.filesProcessed = summary.filesProcessed;
    progress.filesCopied = summary.filesCopied;
    progress.filesIndexed = summary.filesIndexed;
    progress.conflicts = summary.conflicts;

    sourceSnapshot.files[result.sourceRelativePath] = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      fileHash: result.fileHash,
      logicalPath: result.logicalPath,
      updatedAt: now.toISOString()
    };
    sourceSnapshotCache.set(result.sourceRelativePath, sourceSnapshot.files[result.sourceRelativePath]);
  }

  async function handleFileError(error, fileItem) {
    if (error && error.code === 'PAUSE_CANCELLED') {
      return null;
    }
    logger.error('File backup failed; continuing with next file.', {
      sourceRelativePath: fileItem.sourceRelativePath,
      code: error.code || null,
      message: error.message
    });
    await errorReport.append({
      type: 'file-error',
      relativePath: fileItem.sourceRelativePath,
      path: fileItem.sourceFilePath,
      code: error.code || null,
      message: error.message
    });
    summary.errors += 1;
    progress.errors = summary.errors;
    emitProgress({ type: 'file-error', sourceRelativePath: fileItem.sourceRelativePath }, true);
    return null;
  }

  async function enqueueFile(fileItem) {
    let resolveFile;
    let rejectFile;
    const done = new Promise((resolve, reject) => {
      resolveFile = resolve;
      rejectFile = reject;
    });
    const tracked = done.finally(() => pendingFilePromises.delete(tracked));
    pendingFilePromises.add(tracked);

    await hashQueue.push({
      ...fileItem,
      resolveFile,
      rejectFile
    });

    return tracked
      .then((result) => {
        updateCompletedResult(result, fileItem.stats);
        return result;
      })
      .catch((error) => handleFileError(error, fileItem));
  }

  const hashPool = createFixedWorkerPool({
    queue: hashQueue,
    size: hashWorkerCount,
    prefix: 'H',
    process: async (item, worker) => {
      const started = Date.now();
      try {
        const result = await planFileOperation(
          targetRoot,
          machineId,
          source,
          item.sourceFilePath,
          item.sourceRelativePath,
          item.stats,
          item.now,
          inFlightHashes,
          sourceSnapshotCache,
          hashRecordSession
        );

        if (result.type === 'copy-new' || result.type === 'copy-duplicate') {
          await copyQueue.push({
            plan: result,
            resolveFile: item.resolveFile,
            rejectFile: item.rejectFile
          });
        } else {
          item.resolveFile(result);
        }
        return result;
      } catch (error) {
        item.rejectFile(error);
        throw error;
      } finally {
        summary.hashTaskDurationMs += Date.now() - started;
        hashTaskCount += 1;
        hashBytesProcessed += item.stats?.size || 0;
        progress.hashThroughputBytesPerSecond = Date.now() > startedAt
          ? Math.round(hashBytesProcessed / ((Date.now() - startedAt) / 1000))
          : 0;
        emitProgress({ type: 'task-completed', pool: 'hash', workerId: worker.id, sourceRelativePath: item.sourceRelativePath });
      }
    },
    onEvent: (event) => {
      const workerKey = `hash:${event.workerId}`;
      if (event.type === 'worker-started') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'hash',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: 0
        };
      } else if (event.type === 'task-started') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'hash',
          state: 'hashing',
          sourceRelativePath: event.item.sourceRelativePath,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: event.item.stats.size
        };
        emitProgress({ type: 'task-started', pool: 'hash', workerId: event.workerId, sourceRelativePath: event.item.sourceRelativePath });
      } else if (event.type === 'task-completed') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'hash',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: null,
          copiedBytes: event.result?.bytesProcessed || 0,
          totalBytes: event.result?.bytesProcessed || 0,
          lastAction: event.result?.action || event.result?.type || null,
          lastTaskDurationMs: event.durationMs || 0
        };
      } else if (event.type === 'task-failed') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'hash',
          state: 'error',
          sourceRelativePath: event.item?.sourceRelativePath || null,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: event.item?.stats?.size || 0,
          error: event.error.message,
          lastTaskDurationMs: event.durationMs || 0
        };
      } else if (event.type === 'worker-stopped' && progress.workers[workerKey]) {
        progress.workers[workerKey].state = 'idle';
        progress.workers[workerKey].sourceRelativePath = null;
      }
    }
  });

  const copyPool = createFixedWorkerPool({
    queue: copyQueue,
    size: copyWorkerCount,
    prefix: 'C',
    process: async (item, worker) => {
      const started = Date.now();
      try {
        const result = await executeCopyOperation(
          targetRoot,
          machineId,
          source,
          item.plan,
          {
            onCopyProgress: (copyProgress) => {
              const workerKey = `copy:${worker.id}`;
              progress.workers[workerKey] = {
                workerId: worker.id,
                pool: 'copy',
                state: 'copying',
                sourceRelativePath: item.plan.sourceRelativePath,
                logicalPath: copyProgress.logicalPath,
                copiedBytes: copyProgress.copiedBytes,
                totalBytes: copyProgress.totalBytes
              };
              emitProgress({ type: 'copy-progress', pool: 'copy', workerId: worker.id, sourceRelativePath: item.plan.sourceRelativePath }, true);
            }
          },
          inFlightHashes,
          hashRecordSession
        );
        item.resolveFile(result);
        copyBytesProcessed += result?.bytesProcessed || 0;
        progress.copyThroughputBytesPerSecond = Date.now() > startedAt
          ? Math.round(copyBytesProcessed / ((Date.now() - startedAt) / 1000))
          : 0;
        return result;
      } catch (error) {
        item.rejectFile(error);
        throw error;
      } finally {
        summary.copyTaskDurationMs += Date.now() - started;
        copyTaskCount += 1;
      }
    },
    onEvent: (event) => {
      const workerKey = `copy:${event.workerId}`;
      if (event.type === 'worker-started') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'copy',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: 0
        };
      } else if (event.type === 'task-started') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'copy',
          state: 'copying',
          sourceRelativePath: event.item.plan.sourceRelativePath,
          logicalPath: event.item.plan.logicalPath,
          copiedBytes: 0,
          totalBytes: event.item.plan.stats.size
        };
        if (!firstCopyTaskLogged) {
          firstCopyTaskLogged = true;
          logger.info('First copy task started.', {
            machineId,
            sourceId,
            scanId,
            sourceRelativePath: event.item.plan.sourceRelativePath,
            logicalPath: event.item.plan.logicalPath,
            elapsedMsSinceRunStart: Date.now() - startedAt
          });
        }
        emitProgress({ type: 'task-started', pool: 'copy', workerId: event.workerId, sourceRelativePath: event.item.plan.sourceRelativePath }, true);
      } else if (event.type === 'task-completed') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'copy',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: event.result?.logicalPath || null,
          copiedBytes: event.result?.bytesProcessed || 0,
          totalBytes: event.result?.bytesProcessed || 0,
          lastAction: event.result?.action || null,
          lastTaskDurationMs: event.durationMs || 0
        };
        emitProgress({ type: 'task-completed', pool: 'copy', workerId: event.workerId, sourceRelativePath: event.item.plan.sourceRelativePath }, true);
      } else if (event.type === 'task-failed') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'copy',
          state: 'error',
          sourceRelativePath: event.item?.plan?.sourceRelativePath || null,
          logicalPath: event.item?.plan?.logicalPath || null,
          copiedBytes: 0,
          totalBytes: event.item?.plan?.stats?.size || 0,
          error: event.error.message,
          lastTaskDurationMs: event.durationMs || 0
        };
      } else if (event.type === 'worker-stopped' && progress.workers[workerKey]) {
        progress.workers[workerKey].state = 'idle';
        progress.workers[workerKey].sourceRelativePath = null;
      }
    }
  });

  hashPool.start();
  copyPool.start();
  emitProgress({ type: 'backup-started' }, true);

  try {
    for await (const resumeFolder of resumeRun.folders) {
      if (shouldStopForPause()) {
        paused = true;
        break;
      }

      activeResumeCursor = {
        folderHash: resumeFolder.folderHash,
        folderPath: resumeFolder.folderPath,
        relativePath: resumeFolder.relativePath,
        status: 'scanning'
      };
      logger.info('Processing folder from traversal stack.', {
        scanId,
        folderPath: resumeFolder.folderPath,
        relativePath: resumeFolder.relativePath,
        folderHash: resumeFolder.folderHash,
        resumed: resumeRun.resumed,
        foldersProcessed: summary.foldersProcessed,
        filesProcessed: summary.filesProcessed,
        filesCopied: summary.filesCopied
      });
      lastScheduledResumeCursor = activeResumeCursor;
      await saveResumeCursor(targetRoot, machineId, sourceId, resumeRun.backupId, activeResumeCursor, {
        status: 'running',
        now
      });
      await markResumeFolder(targetRoot, machineId, sourceId, resumeRun.backupId, resumeFolder, 'scanning', {}, now);

      let directories;
      let files;
      try {
        ({ directories, files } = await readFolderEntries(resumeFolder.folderPath, resumeFolder.relativePath, ignoreMatcher));
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
        await errorReport.append({
          type: 'missing-folder',
          relativePath: resumeFolder.relativePath,
          path: resumeFolder.folderPath,
          code: error.code,
          message: error.message
        });
        summary.skippedFolders += 1;
        summary.errors += 1;
        progress.skippedFolders = summary.skippedFolders;
        progress.errors = summary.errors;
        await markResumeFolder(targetRoot, machineId, sourceId, resumeRun.backupId, resumeFolder, 'failed', {}, now);
        emitProgress({ type: 'folder-skipped', relativePath: resumeFolder.relativePath }, true);
        continue;
      }

      await markResumeFolder(targetRoot, machineId, sourceId, resumeRun.backupId, resumeFolder, 'scanning', {
        filesSeen: files.length,
        childrenSeen: directories.length
      }, now);

      const folderFilePromises = [];
      for (const fileEntry of files) {
        if (shouldStopForPause()) {
          paused = true;
          break;
        }

        const sourceRelativePath = resumeFolder.relativePath === '.'
          ? fileEntry.name
          : path.posix.join(resumeFolder.relativePath, fileEntry.name);
        const normalizedRelativePath = toPosixPath(sourceRelativePath);

        let stats;
        try {
          stats = await fs.stat(fileEntry.path);
        } catch (error) {
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
          emitProgress({ type: 'file-skipped', sourceRelativePath: normalizedRelativePath }, true);
          continue;
        }

        folderFilePromises.push(enqueueFile({
          sourceFilePath: fileEntry.path,
          sourceRelativePath: normalizedRelativePath,
          stats,
          now
        }));
      }

      if (paused) {
        break;
      }

      const folderResults = await Promise.all(folderFilePromises);
      await markResumeFolder(targetRoot, machineId, sourceId, resumeRun.backupId, resumeFolder, 'done', {
        filesSeen: files.length,
        filesDone: folderResults.filter(Boolean).length,
        childrenSeen: directories.length,
        childrenDone: directories.length
      }, now);

      lastCompletedResumeCursor = {
        folderHash: resumeFolder.folderHash,
        folderPath: resumeFolder.folderPath,
        relativePath: resumeFolder.relativePath,
        status: 'done'
      };
      await saveResumeCursor(targetRoot, machineId, sourceId, resumeRun.backupId, lastCompletedResumeCursor, {
        status: 'running',
        now
      });
      summary.foldersProcessed += 1;
      progress.foldersProcessed = summary.foldersProcessed;
      await hashRecordSession.flush();
      emitProgress({ type: 'folder-completed', relativePath: resumeFolder.relativePath }, true);
    }
  } finally {
    if (paused) {
      setPausePhase('cancelling-queues', 'Pause: cancelling fixed pipeline queues.');
      const cancelledHash = hashQueue.cancel();
      const cancelledCopy = copyQueue.cancel();
      for (const item of cancelledHash) {
        item.rejectFile(Object.assign(new Error('Queue cancelled.'), { code: 'PAUSE_CANCELLED' }));
      }
      for (const item of cancelledCopy) {
        item.rejectFile(Object.assign(new Error('Queue cancelled.'), { code: 'PAUSE_CANCELLED' }));
      }
      setPausePhase('waiting-workers', 'Pause: waiting for fixed pipeline workers to stop.');
      await Promise.allSettled(Array.from(pendingFilePromises));
    } else {
      hashQueue.close();
      await Promise.allSettled(Array.from(pendingFilePromises));
      copyQueue.close();
    }
    await hashPool.wait();
    await copyPool.wait();
    await hashRecordSession.flush();
  }

  sourceSnapshot.updatedAt = now.toISOString();
  await saveSourceSnapshot(targetRoot, sourceSnapshot);

  if (paused) {
    const pausedCursor = activeResumeCursor
      && lastCompletedResumeCursor
      && activeResumeCursor.folderHash === lastCompletedResumeCursor.folderHash
      && activeResumeCursor.relativePath === lastCompletedResumeCursor.relativePath
      ? lastCompletedResumeCursor
      : activeResumeCursor || lastCompletedResumeCursor;
    await markGenerationPaused(targetRoot, machineId, sourceId, now, pausedCursor);
    await pauseResumeRun(targetRoot, machineId, sourceId, resumeRun.backupId, pausedCursor, now);
    progress.status = 'paused';
    delete progress.pausePhase;
    emitProgress({ type: 'backup-paused' }, true);
    logger.info('Pause: backup run paused.', {
      scanId,
      foldersProcessed: summary.foldersProcessed,
      filesProcessed: summary.filesProcessed,
      filesCopied: summary.filesCopied,
      durationMs: Date.now() - startedAt
    });
    return {
      ...summary,
      status: 'paused'
    };
  }

  await markGenerationCompleted(targetRoot, machineId, sourceId, now);
  await completeResumeRun(
    targetRoot,
    machineId,
    sourceId,
    resumeRun.backupId,
    lastScheduledResumeCursor
      ? { ...lastScheduledResumeCursor, status: 'done' }
      : lastCompletedResumeCursor,
    now
  );
  await updateSourceScanState(
    targetRoot,
    machineId,
    sourceId,
    {
      lastCompletedScan: scanId,
      lastCompletedAt: now.toISOString()
    },
    now
  );

  progress.status = 'completed';
  emitProgress({ type: 'backup-completed' }, true);
  summary.hashTaskAverageMs = hashTaskCount > 0 ? Math.round(summary.hashTaskDurationMs / hashTaskCount) : 0;
  summary.copyTaskAverageMs = copyTaskCount > 0 ? Math.round(summary.copyTaskDurationMs / copyTaskCount) : 0;
  logger.info('Backup source completed.', {
    ...summary,
    pipeline: 'fixed-worker',
    durationMs: Date.now() - startedAt
  });

  return {
    ...summary,
    status: 'completed'
  };
}

module.exports = {
  backupSource
};
