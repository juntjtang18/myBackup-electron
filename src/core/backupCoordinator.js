const fs = require('fs-extra');
const path = require('path');
const { cleanupTempFiles } = require('./plainFileStorage');
const { loadBackupSchema, loadBackupSource, updateBackupSource } = require('./backupSchema');
const { loadIgnoreMatcher } = require('./ignoreMatcher');
const { createErrorReportWriter } = require('./errorReportStore');
const { toPosixPath } = require('./layout');
const { createFolderHash } = require('./cursor');
const { createFileQueue } = require('./engine/fileQueue');
const { createFileWorkerPool } = require('./engine/fileWorkerPool');
const { scanFullSource } = require('./engine/fullScanner');
const { scanDirtyFolders, selectDirtyFolders } = require('./engine/dirtyFolderScanner');
const { processFileTask } = require('./engine/fileTaskProcessor');
const { ChangeTracker } = require('./changeTracking/ChangeTracker');
const { createScanId } = require('./ids');
const { createLogger } = require('./logger');
const { createStatusCheckpointWriter } = require('./statusCheckpointWriter');

const logger = createLogger('BackupCoordinator', 'backupCoordinator.js');

function nowIso(now = new Date()) {
  return now.toISOString();
}

function isMissingPathError(error) {
  return Boolean(error && error.code === 'ENOENT');
}

function determineBackupMode(source, options) {
  if (options.forceNewScan) {
    return 'full';
  }
  if (!source.baselineAt) {
    return 'full';
  }
  if (source.sourceSizeBytes === null || source.sourceSizeBytes === undefined) {
    return 'full';
  }
  if (source.watchState && source.watchState.needsRescan) {
    return 'full';
  }
  return 'incremental';
}

async function loadTargetEntry(appDataRoot, targetRoot) {
  const schema = await loadBackupSchema(appDataRoot);
  const resolvedTargetRoot = path.resolve(targetRoot);
  const target = (schema?.targets || []).find((entry) => entry.path === resolvedTargetRoot);
  if (!target) {
    throw new Error(`Unknown backup target: ${resolvedTargetRoot}`);
  }
  return target;
}

function buildDefaultWatchState(sourceId) {
  return {
    dirtyRef: `watch/${sourceId}.dirty.json`,
    needsRescan: false,
    lastEventAt: null
  };
}

async function updateSourceRuntimeState(appDataRoot, targetRoot, machineId, sourceId, updater, now = new Date()) {
  return updateBackupSource(
    appDataRoot,
    targetRoot,
    machineId,
    sourceId,
    (current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      return {
        ...current,
        ...next
      };
    },
    now
  );
}

function cloneBackupCursor(cursor, now = new Date()) {
  if (!cursor || !cursor.relativePath) {
    return null;
  }
  return {
    ...cursor,
    relativePath: cursor.relativePath,
    updatedAt: cursor.updatedAt || nowIso(now)
  };
}

function cloneProgress(summary, progress) {
  return {
    summary: { ...summary },
    progress: JSON.parse(JSON.stringify(progress))
  };
}

async function backupSource(targetRoot, machineId, sourceId, options = {}) {
  const appDataRoot = options.appDataRoot || targetRoot;
  const source = await loadBackupSource(appDataRoot, targetRoot, machineId, sourceId);
  if (!source) {
    throw new Error(`Source not found: ${machineId}/${sourceId}`);
  }

  const target = await loadTargetEntry(appDataRoot, targetRoot);
  const now = options.now || new Date();
  const mode = determineBackupMode(source, options);
  const shouldStopForPause = () => typeof options.shouldPause === 'function' && options.shouldPause();
  const changeTracker = new ChangeTracker(appDataRoot);
  const workerCount = Math.max(
    1,
    options.initialWorkers
      || options.initialHashWorkers
      || options.maxHashWorkers
      || options.initialCopyWorkers
      || options.maxCopyWorkers
      || 6
  );
  const queueCapacity = Math.max(
    workerCount * 8,
    options.queueCapacity || options.hashQueueCapacity || options.copyQueueCapacity || 64
  );

  logger.info('Backup source started.', {
    machineId,
    sourceId,
    targetRoot,
    sourcePath: source.sourcePath,
    mode,
    pipeline: 'single-queue',
    workerPools: {
      file: workerCount
    }
  });

  const recoveredTempFiles = await cleanupTempFiles(targetRoot);
  if (recoveredTempFiles > 0) {
    logger.info('Recovered stale temp files before backup start.', {
      machineId,
      sourceId,
      targetRoot,
      recoveredTempFiles
    });
  }

  const ignoreMatcher = await loadIgnoreMatcher(source.sourcePath, {
    appDataRoot,
    source
  });
  let errorReport = null;
  const fileQueue = createFileQueue({ capacity: queueCapacity });
  const pendingFilePromises = new Set();

  const summary = {
    machineId,
    sourceId,
    scanId: null,
    foldersProcessed: 0,
    filesProcessed: 0,
    filesCopied: 0,
    copiedBytes: 0,
    filesIndexed: 0,
    copyTaskDurationMs: 0,
    conflicts: 0,
    skippedFolders: 0,
    skippedFiles: 0,
    errors: 0,
    recoveredTempFiles,
    reportPath: null
  };

  const progress = {
    machineId,
    sourceId,
    scanId: null,
    startedAt: nowIso(now),
    status: 'running',
    mode,
    resumed: false,
    foldersProcessed: 0,
    filesProcessed: 0,
    filesCopied: 0,
    copiedBytes: 0,
    filesIndexed: 0,
    throughputBytesPerSecond: 0,
    copyThroughputBytesPerSecond: 0,
    conflicts: 0,
    skippedFolders: 0,
    skippedFiles: 0,
    errors: 0,
    recoveredTempFiles,
    workers: {},
    queues: {
      file: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [] }
    }
  };

  let scanId = null;
  let backupStatus = source.backupStatus || {};
  let dirtyStateSnapshot = null;
  let dirtyScanSeq = null;
  let selectedDirtyFolders = [];
  let paused = false;
  let pausePhase = null;
  let activeFolder = null;
  let lastCompletedFolder = null;
  let resumed = false;
  let throughputBytesProcessed = 0;
  let taskCount = 0;
  let lastProgressEmitAt = 0;
  let firstFileTaskLogged = false;
  const completedDirtyFolders = new Set();
  let discoveredSourceBytes = 0;

  if (mode === 'full') {
    const existingBackupStatus = !options.forceNewScan ? (source.backupStatus || {}) : null;
    const resumeFrom = (!options.forceNewScan
      && existingBackupStatus
      && existingBackupStatus.mode === 'full'
      && existingBackupStatus.status === 'paused'
      && existingBackupStatus.cursor
      && existingBackupStatus.cursor.relativePath)
      ? {
          backupId: existingBackupStatus.runId,
          relativePath: existingBackupStatus.cursor.relativePath,
          folderHash: existingBackupStatus.cursor.folderHash || createFolderHash(existingBackupStatus.cursor.relativePath)
        }
      : null;
    resumed = Boolean(resumeFrom);
    scanId = resumed ? existingBackupStatus.runId : createScanId(now);
    dirtyStateSnapshot = await changeTracker.getChangeList(source, now);
    dirtyScanSeq = dirtyStateSnapshot.scanSeq;
    backupStatus = (await updateSourceRuntimeState(appDataRoot, targetRoot, machineId, sourceId, (current) => ({
      backupStatus: {
        ...(current.backupStatus || {}),
        status: 'running',
        mode: 'full',
        runId: scanId,
        copiedBytes: resumed && existingBackupStatus ? Number(existingBackupStatus.copiedBytes || 0) : 0,
        startedAt: resumed ? (existingBackupStatus.startedAt || nowIso(now)) : nowIso(now),
        updatedAt: nowIso(now),
        completedAt: null,
        cursor: resumeFrom ? {
          backupId: scanId,
          relativePath: resumeFrom.relativePath,
          folderHash: resumeFrom.folderHash,
          status: 'running',
          updatedAt: nowIso(now)
        } : null,
        scanSeq: dirtyScanSeq,
        error: null
      }
    }), now)).backupStatus;

    logger.info('Resume run initialized.', {
      machineId,
      sourceId,
      scanId,
      backupId: scanId,
      resumed,
      copiedBytesReadFromStatus: Number(existingBackupStatus?.copiedBytes || 0),
      copiedBytesInitialized: Number(backupStatus.copiedBytes || 0),
      cursor: resumeFrom
        ? {
            relativePath: resumeFrom.relativePath,
            folderHash: resumeFrom.folderHash
          }
        : null
    });
  } else {
    dirtyStateSnapshot = await changeTracker.getChangeList(source, now);
    dirtyScanSeq = dirtyStateSnapshot.scanSeq;
    const existingBackupStatus = !options.forceNewScan ? (source.backupStatus || {}) : null;
    const resumeFrom = (!options.forceNewScan
      && existingBackupStatus
      && existingBackupStatus.mode === 'incremental'
      && existingBackupStatus.status === 'paused'
      && existingBackupStatus.cursor
      && existingBackupStatus.cursor.relativePath)
      ? existingBackupStatus.cursor.relativePath
      : null;
    resumed = Boolean(resumeFrom);
    selectedDirtyFolders = selectDirtyFolders(dirtyStateSnapshot.legacyDirtyState, dirtyScanSeq, resumeFrom)
      .map((entry) => entry.relativePath);
    scanId = existingBackupStatus && existingBackupStatus.mode === 'incremental' && existingBackupStatus.status === 'paused'
      ? existingBackupStatus.runId
      : createScanId(now);
    backupStatus = (await updateSourceRuntimeState(appDataRoot, targetRoot, machineId, sourceId, (current) => ({
      backupStatus: {
        ...(current.backupStatus || {}),
        status: 'running',
        mode: 'incremental',
        runId: scanId,
        copiedBytes: existingBackupStatus ? Number(existingBackupStatus.copiedBytes || 0) : 0,
        startedAt: existingBackupStatus && existingBackupStatus.status === 'paused'
          ? (existingBackupStatus.startedAt || nowIso(now))
          : nowIso(now),
        updatedAt: nowIso(now),
        completedAt: null,
        cursor: resumeFrom ? {
          backupId: scanId,
          relativePath: resumeFrom,
          status: 'running',
          updatedAt: nowIso(now)
        } : null,
        scanSeq: dirtyScanSeq,
        error: null
      }
    }), now)).backupStatus;
    logger.info('Resume run initialized.', {
      machineId,
      sourceId,
      scanId,
      backupId: scanId,
      resumed,
      mode: 'incremental',
      copiedBytesReadFromStatus: Number(existingBackupStatus?.copiedBytes || 0),
      copiedBytesInitialized: Number(backupStatus.copiedBytes || 0),
      cursor: resumeFrom ? { relativePath: resumeFrom } : null
    });
  }

  summary.scanId = scanId;
  summary.copiedBytes = Number(backupStatus.copiedBytes || 0);
  errorReport = await createErrorReportWriter(targetRoot, machineId, sourceId, scanId);
  summary.reportPath = errorReport.reportPath;
  progress.scanId = scanId;
  progress.copiedBytes = summary.copiedBytes;
  progress.resumed = resumed;

  function refreshQueues() {
    const fileSnapshot = fileQueue.snapshot();
    const fileWorkers = Object.values(progress.workers).filter((worker) => worker.pool === 'file' && worker.state !== 'idle');

    progress.queues = {
      file: {
        depth: fileSnapshot.depth,
        pending: fileSnapshot.depth + fileWorkers.length,
        active: fileWorkers.length,
        waitingItems: fileQueue.preview(20, (item) => ({
          sourceRelativePath: item.sourceRelativePath,
          totalBytes: item.stats?.size || 0
        })),
        activeItems: fileWorkers.map((worker) => ({
          sourceRelativePath: worker.sourceRelativePath,
          logicalPath: worker.logicalPath,
          totalBytes: worker.totalBytes || 0
        }))
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
      || event?.type === 'file-progress';
    const interval = options.progressEmitIntervalMs === undefined ? 250 : options.progressEmitIntervalMs;
    const current = Date.now();
    if (!forceEmit && interval > 0 && current - lastProgressEmitAt < interval) {
      return;
    }
    lastProgressEmitAt = current;

    options.onProgress({
      ...cloneProgress(summary, progress),
      event,
      trace: null
    });
  }

  function setPausePhase(phase, message) {
    pausePhase = phase;
    progress.status = 'pausing';
    progress.pausePhase = phase;
    logger.info(message, {
      file: progress.queues.file,
      pendingFiles: pendingFilePromises.size
    });
    emitProgress({ type: 'backup-pausing', phase }, true);
  }

  async function persistBackupStatusState(patch, nowValue = now) {
    const updated = await updateSourceRuntimeState(appDataRoot, targetRoot, machineId, sourceId, (current) => {
      const nextBackupStatus = {
        ...(current.backupStatus || {}),
        ...patch
      };
      if (Object.prototype.hasOwnProperty.call(patch, 'cursor')) {
        nextBackupStatus.cursor = patch.cursor ? cloneBackupCursor(patch.cursor, nowValue) : null;
      }
      nextBackupStatus.updatedAt = patch.updatedAt || nowIso(nowValue);
      return {
        backupStatus: nextBackupStatus
      };
    }, nowValue);
    backupStatus = updated.backupStatus;
    return updated;
  }
  let checkpointCursor = backupStatus.cursor ? cloneBackupCursor(backupStatus.cursor, now) : null;
  const statusCheckpointWriter = createStatusCheckpointWriter({
    buildSnapshot: () => ({
      status: 'running',
      copiedBytes: summary.copiedBytes,
      cursor: checkpointCursor,
      scanSeq: dirtyScanSeq
    }),
    persistSnapshot: async (snapshot, snapshotNow) => {
      await persistBackupStatusState(snapshot, snapshotNow);
      logger.debug('Persisted coalesced running checkpoint.', {
        machineId,
        sourceId,
        scanId,
        copiedBytes: snapshot.copiedBytes,
        cursor: snapshot.cursor ? snapshot.cursor.relativePath : null
      });
    },
    nowFactory: () => new Date()
  });

  function updateCompletedResult(result, stats) {
    if (!result) {
      return;
    }
    summary.filesProcessed += 1;
    summary.copiedBytes += result.bytesProcessed || 0;
    if (result.action === 'copied') {
      summary.filesCopied += 1;
    }
    if (result.logicalPath && result.logicalPath.includes(' [')) {
      summary.conflicts += 1;
    }

    progress.filesProcessed = summary.filesProcessed;
    progress.filesCopied = summary.filesCopied;
    progress.copiedBytes = summary.copiedBytes;
    progress.filesIndexed = summary.filesIndexed;
    progress.conflicts = summary.conflicts;
    if (resumed) {
      logger.info('Resume copied bytes trace: accumulated completed file bytes.', {
        machineId,
        sourceId,
        scanId,
        sourceRelativePath: result.sourceRelativePath || null,
        bytesProcessed: result.bytesProcessed || 0,
        copiedBytesAccumulated: summary.copiedBytes,
        resumed
      });
    }
  }

  async function handleFileError(error, fileItem) {
    if (error && error.code === 'PAUSE_CANCELLED') {
      paused = true;
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
    if (mode === 'full' && fileItem.stats && typeof fileItem.stats.size === 'number') {
      discoveredSourceBytes += fileItem.stats.size;
    }
    let resolveFile;
    let rejectFile;
    const done = new Promise((resolve, reject) => {
      resolveFile = resolve;
      rejectFile = reject;
    });
    const tracked = done.finally(() => pendingFilePromises.delete(tracked));
    pendingFilePromises.add(tracked);

    await fileQueue.push({
      ...fileItem,
      resolveFile,
      rejectFile
    });

    return tracked
      .then((result) => result)
      .catch((error) => handleFileError(error, fileItem));
  }

  const startedAt = Date.now();

  const filePool = createFileWorkerPool({
    queue: fileQueue,
    size: workerCount,
    process: async (item, worker) => {
      const started = Date.now();
      try {
        const result = await processFileTask({
          targetRoot,
          machineId,
          source,
          sourceFilePath: item.sourceFilePath,
          sourceRelativePath: item.sourceRelativePath,
          stats: item.stats,
          now: item.now,
          chunkSize: options.stageChunkSize,
          shouldAbort: shouldStopForPause,
          mtimeToleranceMs: options.mtimeToleranceMs,
          compareBySourceNewerOnly: mode === 'full',
          onProgress: (stageProgress) => {
            const workerKey = `file:${worker.id}`;
            progress.workers[workerKey] = {
              workerId: worker.id,
              pool: 'file',
              state: 'processing',
              sourceRelativePath: item.sourceRelativePath,
              logicalPath: null,
              copiedBytes: stageProgress.copiedBytes,
              totalBytes: stageProgress.totalBytes
            };
            emitProgress({ type: 'file-progress', pool: 'file', workerId: worker.id, sourceRelativePath: item.sourceRelativePath }, true);
          }
        });

        if (!result) {
          item.resolveFile(null);
          return null;
        }

        updateCompletedResult(result, item.stats);
        statusCheckpointWriter.markDirty();
        item.resolveFile(result);
        throughputBytesProcessed += result.bytesProcessed || 0;
        progress.throughputBytesPerSecond = Date.now() > startedAt
          ? Math.round(throughputBytesProcessed / ((Date.now() - startedAt) / 1000))
          : 0;
        progress.copyThroughputBytesPerSecond = progress.throughputBytesPerSecond;
        return result;
      } catch (error) {
        if (error && error.code === 'PAUSE_CANCELLED') {
          item.resolveFile(null);
          return null;
        }
        item.rejectFile(error);
        throw error;
      } finally {
        summary.copyTaskDurationMs += Date.now() - started;
        taskCount += 1;
        emitProgress({ type: 'task-completed', pool: 'file', workerId: worker.id, sourceRelativePath: item.sourceRelativePath });
      }
    },
    onEvent: (event) => {
      const workerKey = `file:${event.workerId}`;
      if (event.type === 'worker-started') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'file',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: 0
        };
      } else if (event.type === 'task-started') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'file',
          state: 'checking-target-stat',
          sourceRelativePath: event.item.sourceRelativePath,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: event.item.stats.size
        };
        if (!firstFileTaskLogged) {
          firstFileTaskLogged = true;
          logger.info('First file task started.', {
            machineId,
            sourceId,
            scanId,
            sourceRelativePath: event.item.sourceRelativePath,
            elapsedMsSinceRunStart: Date.now() - startedAt
          });
        }
        emitProgress({ type: 'task-started', pool: 'file', workerId: event.workerId, sourceRelativePath: event.item.sourceRelativePath });
      } else if (event.type === 'task-completed') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'file',
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: event.result?.logicalPath || null,
          copiedBytes: event.result?.bytesProcessed || 0,
          totalBytes: event.result?.bytesProcessed || 0,
          lastAction: event.result?.action || event.result?.type || null,
          lastTaskDurationMs: event.durationMs || 0
        };
        emitProgress({
          type: 'task-state-updated',
          pool: 'file',
          workerId: event.workerId,
          sourceRelativePath: event.item?.sourceRelativePath || null
        }, true);
      } else if (event.type === 'task-failed') {
        progress.workers[workerKey] = {
          workerId: event.workerId,
          pool: 'file',
          state: 'error',
          sourceRelativePath: event.item?.sourceRelativePath || null,
          logicalPath: null,
          copiedBytes: 0,
          totalBytes: event.item?.stats?.size || 0,
          error: event.error.message,
          lastTaskDurationMs: event.durationMs || 0
        };
        emitProgress({
          type: 'task-state-updated',
          pool: 'file',
          workerId: event.workerId,
          sourceRelativePath: event.item?.sourceRelativePath || null
        }, true);
      } else if (event.type === 'worker-stopped' && progress.workers[workerKey]) {
        progress.workers[workerKey].state = 'idle';
        progress.workers[workerKey].sourceRelativePath = null;
        emitProgress({
          type: 'worker-stopped',
          pool: 'file',
          workerId: event.workerId
        }, true);
      }
    }
  });

  async function handleFolderStart(folder) {
    const folderHash = folder.folderHash || createFolderHash(folder.relativePath);
    activeFolder = {
      relativePath: folder.relativePath,
      folderHash
    };

    logger.info('Processing folder from traversal stack.', {
      scanId,
      folderPath: folder.folderPath,
      relativePath: folder.relativePath,
      folderHash,
      resumed: mode === 'full' ? resumed : Boolean(backupStatus.cursor),
      foldersProcessed: summary.foldersProcessed,
      filesProcessed: summary.filesProcessed,
      filesCopied: summary.filesCopied
    });

    checkpointCursor = {
      backupId: scanId,
      relativePath: folder.relativePath,
      folderHash,
      status: 'running'
    };
    statusCheckpointWriter.markDirty();
  }

  async function handleFolderCompleted(folder) {
    const folderHash = folder.folderHash || createFolderHash(folder.relativePath);
    lastCompletedFolder = {
      relativePath: folder.relativePath,
      folderHash
    };
    summary.foldersProcessed += 1;
    progress.foldersProcessed = summary.foldersProcessed;

    if (mode === 'incremental') {
      completedDirtyFolders.add(folder.relativePath);
      await changeTracker.clearChangeIfUnchanged(source, folder.relativePath, dirtyScanSeq, now);
      statusCheckpointWriter.markDirty();
    }

    emitProgress({ type: 'folder-completed', relativePath: folder.relativePath }, true);
  }

  async function handleMissingFolder(folder, error) {
    await errorReport.append({
      type: 'missing-folder',
      relativePath: folder.relativePath,
      path: folder.folderPath,
      code: error.code,
      message: error.message
    });
    summary.skippedFolders += 1;
    summary.errors += 1;
    progress.skippedFolders = summary.skippedFolders;
    progress.errors = summary.errors;
    if (mode === 'incremental') {
      completedDirtyFolders.add(folder.relativePath);
      await changeTracker.clearChangeIfUnchanged(source, folder.relativePath, dirtyScanSeq, now);
      statusCheckpointWriter.markDirty();
    }
    emitProgress({ type: 'folder-skipped', relativePath: folder.relativePath }, true);
  }

  async function handleMissingFile(fileEntry, error) {
    await errorReport.append({
      type: isMissingPathError(error) ? 'missing-file' : 'file-stat-error',
      relativePath: toPosixPath(fileEntry.relativePath),
      path: fileEntry.path,
      code: error.code || null,
      message: error.message
    });
    summary.skippedFiles += 1;
    summary.errors += 1;
    progress.skippedFiles = summary.skippedFiles;
    progress.errors = summary.errors;
    emitProgress({ type: 'file-skipped', sourceRelativePath: toPosixPath(fileEntry.relativePath) }, true);
  }

  filePool.start();
  emitProgress({ type: 'backup-started' }, true);

  try {
    if (mode === 'full') {
      await scanFullSource({
        sourcePath: source.sourcePath,
        resumeFrom: backupStatus.cursor,
        ignoreMatcher,
        shouldAbort: shouldStopForPause,
        onFolder: handleFolderStart,
        onFolderCompleted: handleFolderCompleted,
        onMissingFolder: handleMissingFolder,
        onMissingFile: handleMissingFile,
        enqueueFile: async (fileItem) => enqueueFile({
          ...fileItem,
          sourceRelativePath: toPosixPath(fileItem.sourceRelativePath),
          now
        })
      });
      if (shouldStopForPause()) {
        paused = true;
      }
    } else {
      await scanDirtyFolders({
        sourcePath: source.sourcePath,
        dirtyState: dirtyStateSnapshot.legacyDirtyState,
        scanSeq: dirtyScanSeq,
        resumeFrom: backupStatus.cursor ? backupStatus.cursor.relativePath : null,
        ignoreMatcher,
        shouldAbort: shouldStopForPause,
        onFolder: handleFolderStart,
        onFolderCompleted: handleFolderCompleted,
        onMissingFolder: handleMissingFolder,
        onMissingFile: handleMissingFile,
        enqueueFile: async (fileItem) => enqueueFile({
          ...fileItem,
          sourceRelativePath: toPosixPath(fileItem.sourceRelativePath),
          now
        })
      });
      if (shouldStopForPause()) {
        paused = true;
      }
    }
  } finally {
    if (!paused && shouldStopForPause()) {
      paused = true;
    }
    if (paused) {
      setPausePhase('cancelling-queues', 'Pause: cancelling fixed pipeline queues.');
      const cancelledItems = fileQueue.cancel();
      for (const item of cancelledItems) {
        item.resolveFile(null);
      }
      setPausePhase('waiting-workers', 'Pause: waiting for fixed pipeline workers to stop.');
      await Promise.allSettled(Array.from(pendingFilePromises));
    } else {
      fileQueue.close();
      await Promise.allSettled(Array.from(pendingFilePromises));
    }
    await filePool.wait();
  }

  if (paused) {
    const pausedFolder = activeFolder
      && lastCompletedFolder
      && activeFolder.relativePath === lastCompletedFolder.relativePath
      ? lastCompletedFolder
      : activeFolder || lastCompletedFolder || (backupStatus.cursor ? {
        relativePath: backupStatus.cursor.relativePath,
        folderHash: backupStatus.cursor.folderHash || createFolderHash(backupStatus.cursor.relativePath)
      } : null);

    await statusCheckpointWriter.flushPending();
    const pauseCleanedTempFiles = await cleanupTempFiles(targetRoot);
    if (pauseCleanedTempFiles > 0) {
      logger.info('Pause: removed unfinished temp files.', {
        machineId,
        sourceId,
        scanId,
        pauseCleanedTempFiles
      });
    }

    await persistBackupStatusState({
      status: 'paused',
      copiedBytes: summary.copiedBytes,
      cursor: pausedFolder ? {
        backupId: scanId,
        relativePath: pausedFolder.relativePath,
        folderHash: pausedFolder.folderHash,
        status: 'paused'
      } : null,
      scanSeq: dirtyScanSeq
    }, new Date());
    await statusCheckpointWriter.close();
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

  if (mode === 'full') {
    await changeTracker.clearAfterFullBackup(source, now);
  }

  await statusCheckpointWriter.flushPending();
  await persistBackupStatusState({
      status: 'completed',
      copiedBytes: summary.copiedBytes,
      cursor: null,
      completedAt: nowIso(now)
  }, new Date());
  await statusCheckpointWriter.close();

  const backupSizeBytes = mode === 'full'
    ? discoveredSourceBytes
    : (source.backupSizeBytes ?? source.sourceSizeBytes ?? null);

  await updateSourceRuntimeState(appDataRoot, targetRoot, machineId, sourceId, (current) => ({
    lastCompletedAt: nowIso(now),
    baselineAt: mode === 'full' && !current.baselineAt ? nowIso(now) : current.baselineAt,
    sourceSizeBytes: mode === 'full' ? discoveredSourceBytes : current.sourceSizeBytes ?? null,
    backupSizeBytes: mode === 'full' ? backupSizeBytes : current.backupSizeBytes ?? null,
    backupStatus: {
      ...(current.backupStatus || {}),
      ...backupStatus,
      status: 'completed',
      mode,
      runId: scanId,
      copiedBytes: summary.copiedBytes,
      completedAt: nowIso(now),
      updatedAt: nowIso(now),
      cursor: null,
      scanSeq: dirtyScanSeq,
      error: null
    },
    watchState: {
      ...(current.watchState || buildDefaultWatchState(sourceId)),
      needsRescan: mode === 'full' ? false : Boolean((current.watchState || {}).needsRescan),
      lastEventAt: (current.watchState || {}).lastEventAt || null
    }
  }), now);

  progress.status = 'completed';
  emitProgress({ type: 'backup-completed' }, true);
  summary.hashTaskAverageMs = 0;
  summary.copyTaskAverageMs = taskCount > 0 ? Math.round(summary.copyTaskDurationMs / taskCount) : 0;
  logger.info('Backup source completed.', {
    ...summary,
    mode,
    pipeline: 'single-queue',
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
