const fs = require('fs-extra');
const path = require('path');
const { cleanupTempFiles, ensureStoredDirectory } = require('./plainFileStorage');
const { loadBackupSchema, loadBackupSource, updateBackupSource } = require('./backupSchema');
const { loadIgnoreMatcher } = require('./ignoreMatcher');
const { writeBackupCard } = require('./backupCard');
const { recordCatalogBackup } = require('./targetCatalog');
const { getSourceFolderName, getSourceTargetRoot, planLogicalTarget, shouldIncludeSourceRoot } = require('./pathPlanner');
const { createBackupJob, createScanResult } = require('./schema');
const { createErrorReportWriter } = require('./errorReportStore');
const { toPosixPath } = require('./layout');
const { createFolderHash } = require('./cursor');
const { createFileQueue } = require('./engine/fileQueue');
const { createFileWorkerPool } = require('./engine/fileWorkerPool');
const { scanFullSource } = require('./engine/fullScanner');
const { scanDirtyFolders, selectDirtyFolders } = require('./engine/dirtyFolderScanner');
const { inventorySourceTree } = require('./engine/scannerUtils');
const { isTransientSourceFileError, processFileTask } = require('./engine/fileTaskProcessor');
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

async function clearBackupRunState(appDataRoot, targetRoot, machineId, sourceId, now = new Date()) {
  return updateBackupSource(appDataRoot, targetRoot, machineId, sourceId, (current) => ({
    ...current,
    backupJob: null,
    backupStatus: {
      ...(current.backupStatus || {}),
      status: current.lastCompletedAt ? 'completed' : null,
      cursor: null,
      error: null,
      updatedAt: nowIso(now)
    }
  }), now);
}

function determineBackupMode(source, options) {
  if (!options.forceNewScan && source.backupJob?.status === 'paused') {
    return source.backupJob.type === 'full' ? 'full' : 'incremental';
  }
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

function backupModeToJobType(mode) {
  return mode === 'full' ? 'full' : 'changes';
}

function jobTypeToBackupMode(type) {
  return type === 'full' ? 'full' : 'incremental';
}

function createJobCursor(cursor, summary = {}, dirtyScanSeq = null) {
  if (!cursor) {
    return null;
  }
  return {
    phase: cursor.status || 'scanning',
    currentPath: cursor.relativePath || null,
    relativePath: cursor.relativePath || null,
    folderHash: cursor.folderHash || null,
    processedFiles: Number(summary.filesProcessed || 0),
    processedBytes: Number(summary.copiedBytes || 0),
    lastSnapshotId: dirtyScanSeq === null || dirtyScanSeq === undefined ? null : String(dirtyScanSeq),
    pendingItems: []
  };
}

function legacyCursorFromJob(job) {
  const cursor = job?.cursor || null;
  const relativePath = cursor?.relativePath || cursor?.currentPath || null;
  if (!relativePath) {
    return null;
  }
  return {
    backupId: job.id,
    relativePath,
    folderHash: cursor.folderHash || createFolderHash(relativePath),
    status: job.status === 'paused' ? 'paused' : 'running',
    updatedAt: cursor.updatedAt || null
  };
}

function buildBackupJob({
  existingJob,
  id,
  source,
  target,
  mode,
  status,
  cursor,
  summary,
  dirtyScanSeq,
  now,
  startedAt,
  completedAt,
  error
}) {
  const completedBytes = Number(summary?.copiedBytes ?? existingJob?.progress?.completedBytes ?? 0);
  const completedFiles = Number(summary?.filesProcessed ?? existingJob?.progress?.completedFiles ?? 0);
  return createBackupJob({
    ...(existingJob || {}),
    id,
    sourcePath: source.sourcePath,
    destinationPath: path.join(target.path, getSourceTargetRoot(source.machineId, source)),
    type: backupModeToJobType(mode),
    status,
    cursor: createJobCursor(cursor, summary, dirtyScanSeq),
    progress: {
      totalFiles: existingJob?.progress?.totalFiles ?? null,
      completedFiles,
      totalBytes: mode === 'full' ? null : (source.backupSizeBytes ?? source.sourceSizeBytes ?? null),
      completedBytes
    },
    createdAt: existingJob?.createdAt || startedAt || nowIso(now),
    startedAt: startedAt || existingJob?.startedAt || nowIso(now),
    pausedAt: status === 'paused' ? nowIso(now) : existingJob?.pausedAt || null,
    resumedAt: existingJob?.status === 'paused' && status === 'running' ? nowIso(now) : existingJob?.resumedAt || null,
    completedAt: status === 'completed' ? completedAt || nowIso(now) : null,
    error: error || null
  }, now);
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
  const shouldPause = () => typeof options.shouldPause === 'function' && options.shouldPause();
  const shouldStop = () => typeof options.shouldStop === 'function' && options.shouldStop();
  const shouldStopForPause = () => shouldPause() || shouldStop();
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
  const skippedNewerRows = [];
  const failedRows = [];
  let inSyncFiles = 0;
  let inSyncBytes = 0;
  let discoveredSourceBytes = 0;
  let sourceFilesEnqueued = 0;
  let folderCountBaseline = {
    copiedBytes: 0,
    filesProcessed: 0,
    filesCopied: 0
  };

  function captureFolderCountBaseline() {
    folderCountBaseline = {
      copiedBytes: summary.copiedBytes,
      filesProcessed: summary.filesProcessed,
      filesCopied: summary.filesCopied
    };
  }

  if (mode === 'full') {
    const existingBackupStatus = !options.forceNewScan ? (source.backupStatus || {}) : null;
    const existingJob = !options.forceNewScan
      && source.backupJob?.status === 'paused'
      && jobTypeToBackupMode(source.backupJob.type) === 'full'
      ? source.backupJob
      : null;
    const jobCursor = legacyCursorFromJob(existingJob);
    const statusCursor = (!options.forceNewScan
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
    const resumeFrom = statusCursor || (jobCursor ? {
      backupId: jobCursor.backupId,
      relativePath: jobCursor.relativePath,
      folderHash: jobCursor.folderHash || createFolderHash(jobCursor.relativePath)
    } : null);
    resumed = Boolean(resumeFrom);
    const resumedCopiedBytes = Number(existingJob?.progress?.completedBytes ?? existingBackupStatus?.copiedBytes ?? 0);
    const resumedFilesProcessed = Number(existingJob?.progress?.completedFiles ?? 0);
    scanId = resumed ? (existingJob?.id || existingBackupStatus?.runId) : createScanId(now);
    dirtyStateSnapshot = await changeTracker.getChangeList(source, now);
    dirtyScanSeq = dirtyStateSnapshot.scanSeq;
    backupStatus = (await updateSourceRuntimeState(appDataRoot, targetRoot, machineId, sourceId, (current) => ({
      backupStatus: {
        ...(current.backupStatus || {}),
        status: 'running',
        mode: 'full',
        runId: scanId,
        copiedBytes: resumed ? resumedCopiedBytes : 0,
        startedAt: resumed ? (existingJob?.startedAt || existingBackupStatus?.startedAt || nowIso(now)) : nowIso(now),
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
      },
      backupJob: buildBackupJob({
        existingJob,
        id: scanId,
        source: current,
        target,
        mode,
        status: 'running',
        cursor: resumeFrom ? {
          relativePath: resumeFrom.relativePath,
          folderHash: resumeFrom.folderHash,
          status: 'running'
        } : null,
        summary: {
          copiedBytes: resumed ? resumedCopiedBytes : 0,
          filesProcessed: resumed ? resumedFilesProcessed : 0
        },
        dirtyScanSeq,
        now,
        startedAt: resumed ? (existingJob?.startedAt || existingBackupStatus.startedAt || nowIso(now)) : nowIso(now)
      })
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
    const existingJob = !options.forceNewScan
      && source.backupJob?.status === 'paused'
      && jobTypeToBackupMode(source.backupJob.type) === 'incremental'
      ? source.backupJob
      : null;
    const jobCursor = legacyCursorFromJob(existingJob);
    const resumeFrom = (!options.forceNewScan
      && existingBackupStatus
      && existingBackupStatus.mode === 'incremental'
      && existingBackupStatus.status === 'paused'
      && existingBackupStatus.cursor
      && existingBackupStatus.cursor.relativePath)
      ? existingBackupStatus.cursor.relativePath
      : jobCursor?.relativePath || null;
    resumed = Boolean(resumeFrom);
    const resumedCopiedBytes = Number(existingJob?.progress?.completedBytes ?? existingBackupStatus?.copiedBytes ?? 0);
    const resumedFilesProcessed = Number(existingJob?.progress?.completedFiles ?? 0);
    selectedDirtyFolders = selectDirtyFolders(dirtyStateSnapshot.legacyDirtyState, dirtyScanSeq, resumeFrom)
      .map((entry) => entry.relativePath);
    scanId = existingJob?.id || (existingBackupStatus && existingBackupStatus.mode === 'incremental' && existingBackupStatus.status === 'paused'
      ? existingBackupStatus.runId
      : null)
      || createScanId(now);
    backupStatus = (await updateSourceRuntimeState(appDataRoot, targetRoot, machineId, sourceId, (current) => ({
      backupStatus: {
        ...(current.backupStatus || {}),
        status: 'running',
        mode: 'incremental',
        runId: scanId,
        copiedBytes: resumed ? resumedCopiedBytes : 0,
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
      },
      backupJob: buildBackupJob({
        existingJob,
        id: scanId,
        source: current,
        target,
        mode,
        status: 'running',
        cursor: resumeFrom ? {
          relativePath: resumeFrom,
          folderHash: createFolderHash(resumeFrom),
          status: 'running'
        } : null,
        summary: {
          copiedBytes: resumed ? resumedCopiedBytes : 0,
          filesProcessed: resumed ? resumedFilesProcessed : 0
        },
        dirtyScanSeq,
        now,
        startedAt: existingBackupStatus && existingBackupStatus.status === 'paused'
          ? (existingJob?.startedAt || existingBackupStatus.startedAt || nowIso(now))
          : nowIso(now)
      })
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
  summary.filesProcessed = resumed ? Number(source.backupJob?.progress?.completedFiles || 0) : 0;
  errorReport = await createErrorReportWriter(targetRoot, machineId, sourceId, scanId);
  summary.reportPath = errorReport.reportPath;
  progress.scanId = scanId;
  progress.copiedBytes = summary.copiedBytes;
  progress.filesProcessed = summary.filesProcessed;
  progress.resumed = resumed;
  captureFolderCountBaseline();

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
      const nextBackupJob = buildBackupJob({
        existingJob: current.backupJob || null,
        id: scanId,
        source: current,
        target,
        mode,
        status: patch.status || current.backupJob?.status || nextBackupStatus.status || 'running',
        cursor: nextBackupStatus.cursor,
        summary: {
          copiedBytes: patch.copiedBytes ?? summary.copiedBytes,
          filesProcessed: patch.filesProcessed ?? summary.filesProcessed
        },
        dirtyScanSeq: patch.scanSeq ?? dirtyScanSeq,
        now: nowValue,
        startedAt: nextBackupStatus.startedAt || current.backupJob?.startedAt || nowIso(nowValue),
        completedAt: patch.completedAt || null,
        error: patch.error || null
      });
      return {
        backupStatus: nextBackupStatus,
        backupJob: nextBackupJob
      };
    }, nowValue);
    backupStatus = updated.backupStatus;
    return updated;
  }
  let checkpointCursor = backupStatus.cursor ? cloneBackupCursor(backupStatus.cursor, now) : null;
  const statusCheckpointWriter = createStatusCheckpointWriter({
    buildSnapshot: () => ({
      status: 'running',
      copiedBytes: folderCountBaseline.copiedBytes,
      filesProcessed: folderCountBaseline.filesProcessed,
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
    onError: (error) => {
      logger.warn('Failed to persist running checkpoint.', {
        machineId,
        sourceId,
        error: error && error.message ? error.message : String(error)
      });
    },
    nowFactory: () => new Date()
  });

  function updateCompletedResult(result, stats) {
    if (!result) {
      return;
    }
    if (result.action === 'skipped-missing') {
      summary.skippedFiles += 1;
      progress.skippedFiles = summary.skippedFiles;
      return;
    }
    if (result.action === 'failed') {
      return;
    }
    summary.filesProcessed += 1;
    if (result.action === 'skipped-newer') {
      skippedNewerRows.push({
        path: result.sourceRelativePath,
        sourceBytes: Number(result.sourceBytes || stats?.size || 0),
        targetBytes: Number(result.targetBytes || 0)
      });
    } else if (result.action === 'copied' || result.action === 'unchanged' || result.action === 'skipped-target-stat') {
      inSyncFiles += 1;
      inSyncBytes += Number(result.sourceBytes || stats?.size || 0);
    }
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
    if (isTransientSourceFileError(error)) {
      logger.warn('Skipped file that disappeared or changed during backup.', {
        sourceRelativePath: fileItem.sourceRelativePath,
        code: error.code || null,
        message: error.message
      });
      summary.skippedFiles += 1;
      progress.skippedFiles = summary.skippedFiles;
      emitProgress({ type: 'file-skipped', sourceRelativePath: fileItem.sourceRelativePath }, true);
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
    failedRows.push({
      path: fileItem.sourceRelativePath,
      error: error.message,
      sourceBytes: Number(fileItem.stats?.size || 0)
    });
    emitProgress({ type: 'file-error', sourceRelativePath: fileItem.sourceRelativePath }, true);
    return null;
  }

  async function enqueueFile(fileItem) {
    if (fileItem.stats && typeof fileItem.stats.size === 'number') {
      discoveredSourceBytes += fileItem.stats.size;
      sourceFilesEnqueued += 1;
    }
    let resolveFile;
    let rejectFile;
    const done = new Promise((resolve, reject) => {
      resolveFile = resolve;
      rejectFile = reject;
    });
    const tracked = done.finally(() => pendingFilePromises.delete(tracked));
    pendingFilePromises.add(tracked);

    try {
      await fileQueue.push({
        ...fileItem,
        resolveFile,
        rejectFile
      });
    } catch (error) {
      if (error && error.code === 'PAUSE_CANCELLED') {
        resolveFile(null);
      } else {
        rejectFile(error);
      }
    }

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

        if (result.action === 'failed') {
          const copyError = new Error(result.error || 'File copy failed');
          copyError.code = result.errorCode || null;
          await handleFileError(copyError, item);
          item.resolveFile(result);
          return result;
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
        if (isTransientSourceFileError(error)) {
          const skipped = {
            action: 'skipped-missing',
            sourceRelativePath: item.sourceRelativePath,
            sourceBytes: 0,
            bytesProcessed: 0
          };
          updateCompletedResult(skipped, item.stats);
          item.resolveFile(skipped);
          return skipped;
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

    captureFolderCountBaseline();
    checkpointCursor = {
      backupId: scanId,
      relativePath: folder.relativePath,
      folderHash,
      status: 'running'
    };
    statusCheckpointWriter.markDirty();

    try {
      const logicalPath = planLogicalTarget({
        machineId,
        source,
        sourceRelativePath: folder.relativePath === '.' ? '' : folder.relativePath
      });
      await ensureStoredDirectory(targetRoot, logicalPath);
    } catch (error) {
      logger.error('Failed to create target folder.', {
        relativePath: folder.relativePath,
        code: error.code || null,
        message: error.message
      });
      if (errorReport) {
        await errorReport.append({
          type: 'folder-error',
          relativePath: folder.relativePath,
          path: folder.folderPath,
          code: error.code || null,
          message: error.message
        });
      }
      summary.errors += 1;
      progress.errors = summary.errors;
    }
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
      try {
        await changeTracker.clearChangeIfUnchanged(source, folder.relativePath, dirtyScanSeq, now);
      } catch (error) {
        logger.warn('Failed to clear dirty folder after scan; continuing.', {
          relativePath: folder.relativePath,
          error: error && error.message ? error.message : String(error)
        });
      }
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
      try {
        await changeTracker.clearChangeIfUnchanged(source, folder.relativePath, dirtyScanSeq, now);
      } catch (clearError) {
        logger.warn('Failed to clear dirty folder after skip; continuing.', {
          relativePath: folder.relativePath,
          error: clearError && clearError.message ? clearError.message : String(clearError)
        });
      }
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
    failedRows.push({
      path: toPosixPath(fileEntry.relativePath),
      error: error.message,
      sourceBytes: 0
    });
    emitProgress({ type: 'file-skipped', sourceRelativePath: toPosixPath(fileEntry.relativePath) }, true);
  }

  const emptyIncremental = mode === 'incremental' && selectedDirtyFolders.length === 0;

  if (!emptyIncremental) {
    filePool.start();
  }
  emitProgress({ type: 'backup-started' }, true);

  let fatalError = null;
  if (!emptyIncremental) {
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
    } catch (error) {
      fatalError = error;
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
  }

  if (fatalError && !paused) {
    logger.error('Backup scan failed; finishing remaining files and recording the error.', {
      machineId,
      sourceId,
      scanId,
      error: fatalError.message
    });
    try {
      await statusCheckpointWriter.flushPending();
      await persistBackupStatusState({
        status: 'failed',
        copiedBytes: summary.copiedBytes,
        cursor: checkpointCursor,
        scanSeq: dirtyScanSeq,
        error: fatalError.message
      }, new Date());
      await statusCheckpointWriter.close();
    } catch (persistError) {
      logger.warn('Failed to persist backup failure state; continuing.', {
        machineId,
        sourceId,
        error: persistError && persistError.message ? persistError.message : String(persistError)
      });
    }
    progress.status = 'failed';
    progress.error = fatalError.message;
    emitProgress({ type: 'backup-failed', error: fatalError.message }, true);
    return {
      ...summary,
      status: 'failed',
      error: fatalError.message,
      forceNewScan: Boolean(options.forceNewScan),
      mode
    };
  }

  if (paused) {
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

    if (shouldStop()) {
      await statusCheckpointWriter.close();
      await clearBackupRunState(appDataRoot, targetRoot, machineId, sourceId, new Date());
      progress.status = 'stopped';
      delete progress.pausePhase;
      emitProgress({ type: 'backup-stopped' }, true);
      logger.info('Stop: backup run abandoned.', {
        scanId,
        durationMs: Date.now() - startedAt
      });
      return {
        ...summary,
        status: 'stopped'
      };
    }

    const pausedFolder = activeFolder
      && lastCompletedFolder
      && activeFolder.relativePath === lastCompletedFolder.relativePath
      ? lastCompletedFolder
      : activeFolder || lastCompletedFolder || (backupStatus.cursor ? {
        relativePath: backupStatus.cursor.relativePath,
        folderHash: backupStatus.cursor.folderHash || createFolderHash(backupStatus.cursor.relativePath)
      } : null);

    await persistBackupStatusState({
      status: 'paused',
      copiedBytes: folderCountBaseline.copiedBytes,
      filesProcessed: folderCountBaseline.filesProcessed,
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
      copiedBytes: folderCountBaseline.copiedBytes,
      filesProcessed: folderCountBaseline.filesProcessed,
      filesCopied: folderCountBaseline.filesCopied,
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
    backupJob: buildBackupJob({
      existingJob: current.backupJob || null,
      id: scanId,
      source: current,
      target,
      mode,
      status: 'completed',
      cursor: null,
      summary,
      dirtyScanSeq,
      now,
      startedAt: current.backupJob?.startedAt || backupStatus.startedAt || nowIso(now),
      completedAt: nowIso(now)
    }),
    watchState: {
      ...(current.watchState || buildDefaultWatchState(sourceId)),
      needsRescan: mode === 'full' ? false : Boolean((current.watchState || {}).needsRescan),
      lastEventAt: (current.watchState || {}).lastEventAt || null
    }
  }), now);

  let scanResult = null;
  if (mode === 'full') {
    let inventory = {
      totalFiles: 0,
      totalBytes: 0,
      ignoredFiles: 0,
      ignoredBytes: 0
    };
    try {
      inventory = await inventorySourceTree(source.sourcePath, ignoreMatcher);
    } catch (error) {
      logger.warn('Failed to inventory source tree after backup; continuing.', {
        sourcePath: source.sourcePath,
        error: error && error.message ? error.message : String(error)
      });
    }
    const failedSizeBytes = failedRows.reduce((sum, row) => sum + Number(row.sourceBytes || 0), 0);
    const skippedNewerSourceSizeBytes = skippedNewerRows.reduce((sum, row) => sum + Number(row.sourceBytes || 0), 0);
    const skippedNewerTargetSizeBytes = skippedNewerRows.reduce((sum, row) => sum + Number(row.targetBytes || 0), 0);
    scanResult = {
      kind: 'full',
      sourceFileCount: inSyncFiles,
      sourceSizeBytes: inSyncBytes,
      targetFileCount: inSyncFiles,
      targetSizeBytes: inSyncBytes,
      totalFileCount: inventory.totalFiles,
      totalSizeBytes: inventory.totalBytes,
      ignoredFileCount: inventory.ignoredFiles,
      ignoredSizeBytes: inventory.ignoredBytes,
      failedFileCount: failedRows.length,
      failedSizeBytes,
      skippedNewerFileCount: skippedNewerRows.length,
      skippedNewerSourceSizeBytes,
      skippedNewerTargetSizeBytes,
      failed: failedRows,
      skippedNewer: skippedNewerRows,
      missingCount: failedRows.length,
      backedUp: failedRows.length === 0 && skippedNewerRows.length === 0,
      filesCopied: summary.filesCopied,
      errors: summary.errors
    };
  } else {
    scanResult = {
      kind: 'changes',
      sourceFileCount: sourceFilesEnqueued,
      sourceSizeBytes: discoveredSourceBytes,
      targetFileCount: summary.filesCopied,
      targetSizeBytes: summary.copiedBytes,
      missingCount: 0,
      backedUp: summary.errors === 0,
      filesCopied: summary.filesCopied,
      errors: summary.errors
    };
  }
  scanResult = createScanResult(scanResult);
  await updateSourceRuntimeState(appDataRoot, targetRoot, machineId, sourceId, (current) => ({
    scanResult
  }), now);

  const schema = await loadBackupSchema(appDataRoot);
  try {
    await writeBackupCard({
      backupSetRoot: path.join(target.path, getSourceTargetRoot(source.machineId, source)),
      identity: {
        from: source.sourcePath,
        hostname: schema?.machine?.hostname || schema?.machine?.displayName || '',
        machineId,
        folderName: getSourceFolderName(source),
        includeSourceRoot: shouldIncludeSourceRoot(source)
      },
      scanResult,
      now
    });
  } catch (error) {
    logger.warn('Failed to write backup card on the target.', {
      machineId,
      sourceId,
      error: error && error.message ? error.message : String(error)
    });
  }

  try {
    await recordCatalogBackup({
      appDataRoot,
      targetRoot,
      source,
      computer: schema?.machine || null,
      kind: mode,
      now
    });
  } catch (error) {
    logger.warn('Failed to update target catalog after backup.', {
      machineId,
      sourceId,
      error: error && error.message ? error.message : String(error)
    });
  }

  summary.scanResult = scanResult;
  summary.mode = mode;
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
    status: 'completed',
    forceNewScan: Boolean(options.forceNewScan),
    mode,
    scanResult
  };
}

module.exports = {
  backupSource,
  clearBackupRunState
};
