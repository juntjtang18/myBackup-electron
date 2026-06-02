const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { buildConflictPath, classifyMedia, planLogicalTarget } = require('./pathPlanner');
const { lookupHashRecord, registerHashRecord, unregisterHashRecord } = require('./hashIndex');
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
const { listFolderCheckpoints } = require('./scanCheckpointStore');
const { loadSource } = require('./metadataStore');
const { loadIgnoreMatcher } = require('./ignoreMatcher');
const { createErrorReportWriter } = require('./errorReportStore');
const { createSourceSnapshot, loadSourceSnapshot, saveSourceSnapshot } = require('./sourceSnapshotStore');
const { updateSourceScanState } = require('./sourceRegistry');
const { toPosixPath } = require('./layout');
const { shortHash } = require('./ids');
const { createWorkScheduler } = require('./workScheduler');
const { createLogger } = require('./logger');

const logger = createLogger('BackupCoordinator', 'backupCoordinator.js');

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
  existing
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

  const registration = await registerHashRecord(targetRoot, {
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
  sourceSnapshot = null
) {
  logger.debug('Planning file operation.', {
    machineId,
    sourceId: source.sourceId,
    sourceRelativePath,
    size: stats.size
  });
  const cachedEntry = sourceSnapshot && sourceSnapshot.files
    ? sourceSnapshot.files[sourceRelativePath]
    : null;
  const cachedHashUsable = Boolean(
    cachedEntry &&
    cachedEntry.size === stats.size &&
    cachedEntry.mtimeMs === stats.mtimeMs &&
    cachedEntry.fileHash
  );
  const fileHash = cachedHashUsable ? cachedEntry.fileHash : await hashFile(sourceFilePath);
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
    const existing = await lookupHashRecord(targetRoot, fileHash);
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
        existing
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

async function executeCopyOperation(targetRoot, machineId, source, plan, callbacks = {}, coordination = null) {
  if (plan.type === 'copy-new') {
    try {
      if (plan.overwriteExisting && plan.previousHash) {
        await unregisterHashRecord(targetRoot, {
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
      const registration = await registerHashRecord(targetRoot, {
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

      logger.info('Copied new file into backup.', {
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
  const registration = await registerHashRecord(targetRoot, {
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
    logger.info('Materialized same-content file at alias path.', {
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
    workers: {}
  };
  const emitProgress = (event) => {
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        summary: { ...summary },
        progress: JSON.parse(JSON.stringify(progress)),
        event
      });
    }
  };
  const defaultHashWorkers = Math.min(os.cpus().length || 4, 4);
  const defaultCopyWorkers = Math.min(os.cpus().length || 4, 4);
  const sourceSnapshot = createSourceSnapshot(
    machineId,
    sourceId,
    await loadSourceSnapshot(targetRoot, machineId, sourceId),
    options.now || new Date()
  );
  const errorReport = await createErrorReportWriter(targetRoot, machineId, sourceId, scanId);
  summary.reportPath = errorReport.reportPath;
  const ignoreMatcher = await loadIgnoreMatcher(source.sourcePath);
  const inFlightHashes = createInFlightHashCoordinator();
  const hashScheduler = createWorkScheduler({
    processTask: async (payload) => planFileOperation(
      targetRoot,
      machineId,
      source,
      payload.sourceFilePath,
      payload.sourceRelativePath,
      payload.stats,
      payload.now,
      inFlightHashes,
      sourceSnapshot
    ),
    getTaskBytes: (result, payload) => result?.bytesProcessed || payload.stats.size || 0,
    initialWorkers: options.initialHashWorkers || defaultHashWorkers,
    maxWorkers: options.maxHashWorkers || 8,
    backlogFactor: options.hashWorkerBacklogFactor || 4,
    trialWindowMs: options.hashWorkerTrialWindowMs || 20000,
    throughputImprovementThreshold: options.hashWorkerThroughputImprovementThreshold || 1.15,
    idleWaitMs: options.hashWorkerIdleWaitMs || 10,
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
          lastAction: workerEvent.result.action
        };
        if (workerEvent.result.action === 'indexed-existing' || workerEvent.result.action === 'indexed-alias') {
          progress.filesIndexed += 1;
          progress.filesProcessed += 1;
        }
        if (workerEvent.snapshot && typeof workerEvent.snapshot.throughputBytesPerSecond === 'number') {
          progress.hashThroughputBytesPerSecond = workerEvent.snapshot.throughputBytesPerSecond;
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
          error: workerEvent.error.message
        };
      }
      emitProgress({ ...workerEvent, pool: 'hash' });
    }
  });
  const copyScheduler = createWorkScheduler({
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
          emitProgress({
            type: 'copy-progress',
            pool: 'copy',
            workerId: workerContext.workerId,
            sourceRelativePath: payload.plan.sourceRelativePath
          });
        }
      },
      inFlightHashes
    ),
    getTaskBytes: (result, payload) => result?.bytesProcessed || payload.plan.stats.size || 0,
    initialWorkers: options.initialCopyWorkers || defaultCopyWorkers,
    maxWorkers: options.maxCopyWorkers || 8,
    backlogFactor: options.copyWorkerBacklogFactor || 4,
    trialWindowMs: options.copyWorkerTrialWindowMs || 20000,
    throughputImprovementThreshold: options.copyWorkerThroughputImprovementThreshold || 1.15,
    idleWaitMs: options.copyWorkerIdleWaitMs || 10,
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
          lastAction: workerEvent.result.action
        };
        if (workerEvent.result.action === 'copied' || workerEvent.result.action === 'copied-duplicate') {
          progress.filesCopied += 1;
          progress.filesProcessed += 1;
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
          error: workerEvent.error.message
        };
      }
      emitProgress({ ...workerEvent, pool: 'copy' });
      if (workerEvent.snapshot && typeof workerEvent.snapshot.throughputBytesPerSecond === 'number') {
        progress.copyThroughputBytesPerSecond = workerEvent.snapshot.throughputBytesPerSecond;
      }
    }
  });
  emitProgress({ type: 'backup-started' });

  let paused = false;
  try {
    while (true) {
      if (typeof options.shouldPause === 'function' && options.shouldPause()) {
        paused = true;
        break;
      }

      const checkpoints = await listFolderCheckpoints(targetRoot, machineId, sourceId, scanId);
      const nextCheckpoint = checkpoints.find((entry) => entry.status === 'pending' || entry.status === 'scanning');
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
      const activeFiles = [];
      for (const fileEntry of files) {
        const sourceRelativePath = scanningCheckpoint.relativePath === '.'
          ? fileEntry.name
          : path.posix.join(scanningCheckpoint.relativePath, fileEntry.name);
        let stats;
        try {
          stats = await fs.stat(fileEntry.path);
        } catch (error) {
          logger.warn('Skipped unreadable or missing file during scan.', {
            scanId,
            sourceRelativePath: toPosixPath(sourceRelativePath),
            code: error.code || null
          });
          await errorReport.append({
            type: isMissingPathError(error) ? 'missing-file' : 'file-stat-error',
            relativePath: sourceRelativePath,
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
            sourceRelativePath: toPosixPath(sourceRelativePath)
          });
          continue;
        }
        fileStatsByRelativePath.set(toPosixPath(sourceRelativePath), stats);
        activeFiles.push({
          fileEntry,
          sourceRelativePath: toPosixPath(sourceRelativePath),
          stats
        });
      }

      const fileResults = [];
      for (const { fileEntry, sourceRelativePath, stats } of activeFiles) {
        try {
          const planResult = await hashScheduler.push({
            sourceFilePath: fileEntry.path,
            sourceRelativePath,
            stats,
            now: options.now || new Date()
          });
          const finalResult = (planResult.type === 'copy-new' || planResult.type === 'copy-duplicate')
            ? await copyScheduler.push({ plan: planResult })
            : planResult;
          fileResults.push(finalResult);
        } catch (error) {
          logger.error('File backup failed; continuing with next file.', {
            sourceRelativePath,
            code: error.code || null,
            message: error.message
          });
          await errorReport.append({
            type: 'file-error',
            relativePath: sourceRelativePath,
            path: fileEntry.path,
            code: error.code || null,
            message: error.message
          });
          summary.errors += 1;
          progress.errors = summary.errors;
          emitProgress({
            type: 'file-error',
            sourceRelativePath
          });
        }
      }

      for (const result of fileResults) {
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
        const matchingResult = fileResults.find((entry) => entry.record.origins.some(
          (origin) => origin.sourceRelativePath === sourceRelativePath
        ));
        if (matchingResult) {
          sourceSnapshot.files[sourceRelativePath] = {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            fileHash: matchingResult.fileHash,
            logicalPath: matchingResult.logicalPath,
            updatedAt: (options.now || new Date()).toISOString()
          };
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
      await saveSourceSnapshot(targetRoot, {
        ...sourceSnapshot,
        updatedAt: (options.now || new Date()).toISOString()
      });
      emitProgress({
        type: 'folder-completed',
        relativePath: scanningCheckpoint.relativePath
      });
    }
  } finally {
    await hashScheduler.closeAndDrain();
    await copyScheduler.closeAndDrain();
  }

  if (paused) {
    await markGenerationPaused(targetRoot, machineId, sourceId, options.now || new Date());
    await saveSourceSnapshot(targetRoot, {
      ...sourceSnapshot,
      updatedAt: (options.now || new Date()).toISOString()
    });
    progress.status = 'paused';
    emitProgress({ type: 'backup-paused' });
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

  logger.info('Backup source completed.', summary);

  return {
    ...summary,
    status: 'completed'
  };
}

module.exports = {
  backupSource
};
