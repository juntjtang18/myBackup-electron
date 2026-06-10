const fs = require('fs-extra');
const path = require('path');
const { createHashRecordSession } = require('./hashRecordSession');
const { cleanupTempFiles } = require('./plainFileStorage');
const {
  ensureScanState,
  markGenerationCompleted,
  markGenerationPaused
} = require('./scanManager');
const { loadBackupSource } = require('./backupSchema');
const { loadIgnoreMatcher } = require('./ignoreMatcher');
const { createErrorReportWriter } = require('./errorReportStore');
const { createSourceSnapshot, loadSourceSnapshot, saveSourceSnapshot } = require('./sourceSnapshotStore');
const { updateSourceScanState } = require('./sourceRegistry');
const { toPosixPath } = require('./layout');
const { openCursorRun, saveCursorFolder } = require('./cursor');
const { createBoundedQueue } = require('./pipeline/boundedQueue');
const { createFixedWorkerPool } = require('./pipeline/fixedWorkerPool');
const { createInFlightHashCoordinator: createFileTaskHashCoordinator, processFileTask } = require('./fileTaskProcessor');
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

async function backupSource(targetRoot, machineId, sourceId, options = {}) {
  const appDataRoot = options.appDataRoot || targetRoot;
  const source = await loadBackupSource(appDataRoot, targetRoot, machineId, sourceId);
  if (!source) {
    throw new Error(`Source not found: ${machineId}/${sourceId}`);
  }

  const now = options.now || new Date();
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
  const shouldStopForPause = () => typeof options.shouldPause === 'function' && options.shouldPause();

  logger.info('Backup source started.', {
    machineId,
    sourceId,
    targetRoot,
    sourcePath: source.sourcePath,
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

  const stateBundle = await ensureScanState(targetRoot, machineId, sourceId, {
    appDataRoot,
    forceNew: options.forceNewScan,
    now
  });
  const scanId = stateBundle.scanState.activeGeneration;
  const startedAt = Date.now();
  let fileTaskCount = 0;
  let paused = false;
  let pausePhase = null;
  let activeResumeCursor = null;
  let lastCompletedResumeCursor = null;
  let firstFileTaskLogged = false;
  let lastProgressEmitAt = 0;
  let throughputBytesProcessed = 0;

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
    recoveredTempFiles,
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
    throughputBytesPerSecond: 0,
    hashThroughputBytesPerSecond: 0,
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

  const loadedSourceSnapshot = await loadSourceSnapshot(targetRoot, machineId, sourceId);
  const sourceSnapshot = createSourceSnapshot(machineId, sourceId, loadedSourceSnapshot, now);
  const sourceSnapshotCache = new Map(Object.entries(sourceSnapshot.files || {}));
  const errorReport = await createErrorReportWriter(targetRoot, machineId, sourceId, scanId);
  summary.reportPath = errorReport.reportPath;
  const ignoreMatcher = await loadIgnoreMatcher(source.sourcePath);
  const resumeRun = await openCursorRun(targetRoot, machineId, sourceId, source.sourcePath, {
    appDataRoot,
    backupId: scanId,
    forceNew: options.forceNewScan,
    ignoreMatcher,
    now
  });
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
        }
      : null
  });

  const hashRecordSession = createHashRecordSession(targetRoot);
  const inFlightHashes = createFileTaskHashCoordinator();
  const fileQueue = createBoundedQueue({ name: 'file', capacity: queueCapacity });
  const pendingFilePromises = new Set();

  function queuePreview(queue, mapper) {
    return queue.preview(20, mapper);
  }

  function refreshQueues() {
    const fileSnapshot = fileQueue.snapshot();
    const fileWorkers = Object.values(progress.workers).filter((worker) => worker.pool === 'file' && worker.state !== 'idle');

    progress.queues = {
      file: {
        depth: fileSnapshot.depth,
        pending: fileSnapshot.depth + fileWorkers.length,
        active: fileWorkers.length,
        waitingItems: queuePreview(fileQueue, (item) => ({
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
      file: progress.queues.file,
      pendingFiles: pendingFilePromises.size
    });
    emitProgress({ type: 'backup-pausing', phase }, true);
  }

  function updateCompletedResult(result, stats) {
    if (!result) {
      return;
    }
    summary.filesProcessed += 1;
    if (result.action === 'copied') {
      summary.filesCopied += 1;
    } else if (result.action === 'indexed-existing' || result.action === 'indexed-alias') {
      summary.filesIndexed += 1;
    }
    if (result.logicalPath && result.logicalPath.includes(' [')) {
      summary.conflicts += 1;
    }

    progress.filesProcessed = summary.filesProcessed;
    progress.filesCopied = summary.filesCopied;
    progress.filesIndexed = summary.filesIndexed;
    progress.conflicts = summary.conflicts;

    if (result.fileHash && result.logicalPath) {
      sourceSnapshot.files[result.sourceRelativePath] = {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        fileHash: result.fileHash,
        logicalPath: result.logicalPath,
        updatedAt: now.toISOString()
      };
      sourceSnapshotCache.set(result.sourceRelativePath, sourceSnapshot.files[result.sourceRelativePath]);
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
      .then((result) => {
        updateCompletedResult(result, fileItem.stats);
        return result;
      })
      .catch((error) => handleFileError(error, fileItem));
  }

  const filePool = createFixedWorkerPool({
    queue: fileQueue,
    size: workerCount,
    prefix: 'W',
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
          sourceSnapshotCache,
          hashSession: hashRecordSession,
          inFlightHashes,
          chunkSize: options.stageChunkSize,
          shouldAbort: shouldStopForPause,
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
        item.resolveFile(result);
        throughputBytesProcessed += result.bytesProcessed || 0;
        progress.throughputBytesPerSecond = Date.now() > startedAt
          ? Math.round(throughputBytesProcessed / ((Date.now() - startedAt) / 1000))
          : 0;
        progress.copyThroughputBytesPerSecond = progress.throughputBytesPerSecond;
        progress.hashThroughputBytesPerSecond = 0;
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
        fileTaskCount += 1;
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
          state: 'checking-snapshot',
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
      } else if (event.type === 'worker-stopped' && progress.workers[workerKey]) {
        progress.workers[workerKey].state = 'idle';
        progress.workers[workerKey].sourceRelativePath = null;
      }
    }
  });
  filePool.start();
  emitProgress({ type: 'backup-started' }, true);

  try {
    for await (const resumeFolder of resumeRun.folders) {
      if (shouldStopForPause()) {
        paused = true;
        break;
      }

      activeResumeCursor = {
        folderHash: resumeFolder.folderHash,
        relativePath: resumeFolder.relativePath
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
      await saveCursorFolder(targetRoot, machineId, sourceId, resumeRun.backupId, activeResumeCursor, {
        appDataRoot,
        status: 'running',
        now
      });

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
        emitProgress({ type: 'folder-skipped', relativePath: resumeFolder.relativePath }, true);
        continue;
      }

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

      lastCompletedResumeCursor = {
        folderHash: resumeFolder.folderHash,
        relativePath: resumeFolder.relativePath
      };
      await saveCursorFolder(targetRoot, machineId, sourceId, resumeRun.backupId, lastCompletedResumeCursor, {
        appDataRoot,
        status: 'running',
        now
      });
      summary.foldersProcessed += 1;
      progress.foldersProcessed = summary.foldersProcessed;
      await hashRecordSession.flush();
      emitProgress({ type: 'folder-completed', relativePath: resumeFolder.relativePath }, true);
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
    await markGenerationPaused(targetRoot, machineId, sourceId, now, pausedCursor, appDataRoot);
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

  await markGenerationCompleted(targetRoot, machineId, sourceId, now, appDataRoot);
  await updateSourceScanState(
    appDataRoot,
    machineId,
    sourceId,
    {
      targetRoot,
      lastCompletedScan: scanId,
      lastCompletedAt: now.toISOString()
    },
    now
  );

  progress.status = 'completed';
  emitProgress({ type: 'backup-completed' }, true);
  summary.hashTaskAverageMs = 0;
  summary.copyTaskAverageMs = fileTaskCount > 0 ? Math.round(summary.copyTaskDurationMs / fileTaskCount) : 0;
  logger.info('Backup source completed.', {
    ...summary,
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
