const fs = require('fs-extra');
const path = require('path');
const { restorePlainFile } = require('./plainFileStorage');
const { loadBackupSchema, updateBackupSource } = require('./backupSchema');
const { getSourceFolderName, getSourceTargetRoot } = require('./pathPlanner');
const { toPosixPath } = require('./layout');
const { ChangeTracker } = require('./changeTracking/ChangeTracker');
const {
  clearRestoreJob,
  loadRestoreJob,
  saveRestoreJob
} = require('./restoreJobStore');

async function findSourceRecord(appDataRoot, machineId, sourceId) {
  const schema = await loadBackupSchema(appDataRoot);
  for (const target of schema?.targets || []) {
    for (const source of target.sources || []) {
      if (source.machineId === machineId && source.sourceId === sourceId) {
        return {
          targetRoot: target.path,
          source
        };
      }
    }
  }
  return null;
}

async function walkFiles(rootPath, onFile, relativeRoot = '.') {
  if (!(await fs.pathExists(rootPath))) {
    return;
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    const relativePath = relativeRoot === '.'
      ? entry.name
      : path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(absolutePath, onFile, relativePath);
    } else if (entry.isFile()) {
      await onFile({
        absolutePath,
        relativePath: toPosixPath(relativePath)
      });
    }
  }
}

function createRestoreProgressState({
  mode,
  status,
  startedAt,
  destinationRoot,
  filesProcessed,
  filesCopied,
  copiedBytes,
  totalBytes,
  workers,
  queue,
  throughputBytesPerSecond,
  message
}) {
  return {
    mode,
    status,
    startedAt,
    destinationRoot,
    filesProcessed,
    filesCopied,
    copiedBytes,
    totalBytes,
    throughputBytesPerSecond,
    message: message || null,
    workers,
    queues: {
      file: queue
    }
  };
}

function createRestoreQueueSnapshot(tasks, nextTaskIndex, activeTasks) {
  const waiting = tasks.slice(nextTaskIndex, nextTaskIndex + 24).map((task) => ({
    sourceRelativePath: task.relativePath,
    logicalPath: task.logicalPath,
    totalBytes: task.totalBytes
  }));
  const activeItems = Object.values(activeTasks).map((task) => ({
    sourceRelativePath: task.relativePath,
    logicalPath: task.logicalPath,
    totalBytes: task.totalBytes
  }));
  const depth = Math.max(tasks.length - nextTaskIndex, 0);
  return {
    depth,
    pending: depth + activeItems.length,
    active: activeItems.length,
    waitingItems: waiting,
    activeItems
  };
}

function createRestoreWorker(workerId) {
  return {
    workerId,
    pool: 'file',
    state: 'idle',
    sourceRelativePath: null,
    logicalPath: null,
    lastAction: null,
    copiedBytes: 0,
    totalBytes: 0
  };
}

async function collectRestoreTasks(targetRoot, source) {
  const sourceRoot = getSourceTargetRoot(source.machineId, source);
  const sourceTargetRoot = path.join(targetRoot, sourceRoot);
  const tasks = [];

  await walkFiles(sourceTargetRoot, async ({ absolutePath, relativePath }) => {
    const stat = await fs.stat(absolutePath);
    tasks.push({
      relativePath,
      logicalPath: path.posix.join(sourceRoot, relativePath),
      totalBytes: Number(stat.size || 0)
    });
  });

  return {
    sourceRoot,
    sourceTargetRoot,
    tasks
  };
}

function resolveDestinationRoot(requestedDestinationRoot, source, appendFolder) {
  if (!appendFolder) {
    return requestedDestinationRoot;
  }
  const folderName = getSourceFolderName(source);
  return path.join(requestedDestinationRoot, folderName);
}

async function markSourceNeedsRescanAfterRestore(appDataRoot, targetRoot, machineId, sourceId) {
  if (!appDataRoot || !targetRoot || !machineId || !sourceId) {
    return;
  }

  const tracker = new ChangeTracker(appDataRoot);
  await tracker.clearAfterFullBackup({ sourceId });

  await updateBackupSource(appDataRoot, targetRoot, machineId, sourceId, (current) => ({
    ...current,
    watchState: {
      ...(current.watchState || {}),
      dirtyRef: current.watchState?.dirtyRef || `watch/${sourceId}.dirty.json`,
      needsRescan: true,
      lastEventAt: current.watchState?.lastEventAt || null
    }
  }));
}

async function restoreSource(targetRoot, input) {
  const appDataRoot = input.appDataRoot || targetRoot;
  const requestedDestinationRoot = path.resolve(input.destinationRoot);
  const sourceRecord = await findSourceRecord(appDataRoot, input.machineId, input.sourceId);
  const onProgress = typeof input.onProgress === 'function' ? input.onProgress : null;
  const shouldPause = typeof input.shouldPause === 'function' ? input.shouldPause : () => false;
  const shouldStop = typeof input.shouldStop === 'function' ? input.shouldStop : () => false;
  const appendFolder = Boolean(input.appendFolder);
  const maxWorkers = Math.max(1, Number(input.maxWorkers || 1));
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const summary = {
    machineId: input.machineId,
    sourceId: input.sourceId,
    restoredFiles: 0,
    skippedRecords: 0,
    destinationRoot: requestedDestinationRoot,
    requestedDestinationRoot,
    copiedBytes: 0,
    totalBytes: 0,
    status: 'completed',
    message: null,
    appendFolder
  };

  if (!sourceRecord) {
    summary.message = `Source not found: ${input.machineId}/${input.sourceId}`;
    summary.status = 'completed';
    return summary;
  }

  const destinationRoot = resolveDestinationRoot(
    requestedDestinationRoot,
    sourceRecord.source,
    appendFolder
  );
  summary.destinationRoot = destinationRoot;

  const { sourceTargetRoot, tasks: collectedTasks } = await collectRestoreTasks(
    targetRoot,
    sourceRecord.source
  );

  let tasks = collectedTasks;
  let nextTaskIndex = 0;
  let copiedBytes = 0;
  let resumed = false;

  const existingJob = input.forceNewRestore
    ? null
    : await loadRestoreJob(appDataRoot, input.sourceId);
  if (
    existingJob
    && existingJob.status === 'paused'
    && existingJob.targetRoot === path.resolve(targetRoot)
    && existingJob.destinationRoot === destinationRoot
    && Array.isArray(existingJob.tasks)
  ) {
    tasks = existingJob.tasks;
    nextTaskIndex = Number(existingJob.nextTaskIndex || 0);
    copiedBytes = Number(existingJob.copiedBytes || 0);
    summary.restoredFiles = Number(existingJob.restoredFiles || 0);
    resumed = true;
  }

  const totalBytes = tasks.reduce((sum, task) => sum + Number(task.totalBytes || 0), 0);
  summary.totalBytes = totalBytes;
  summary.copiedBytes = copiedBytes;

  if (!(await fs.pathExists(sourceTargetRoot)) || tasks.length === 0) {
    summary.message = `Backup folder empty or missing: ${sourceTargetRoot}`;
    summary.status = 'completed';
    summary.restoredFiles = 0;
    summary.copiedBytes = 0;
    summary.totalBytes = 0;
    await clearRestoreJob(appDataRoot, input.sourceId);
    if (onProgress) {
      onProgress({
        summary,
        progress: createRestoreProgressState({
          mode: 'restore',
          status: 'completed',
          startedAt: startedAtIso,
          destinationRoot,
          filesProcessed: 0,
          filesCopied: 0,
          copiedBytes: 0,
          totalBytes: 0,
          workers: {},
          queue: createRestoreQueueSnapshot([], 0, {}),
          throughputBytesPerSecond: 0,
          message: summary.message
        }),
        event: {
          type: 'restore-completed',
          pool: 'file',
          message: summary.message
        }
      });
    }
    return summary;
  }

  const workers = {};
  const activeTasks = {};
  const workerCount = Math.min(maxWorkers, Math.max(1, tasks.length - nextTaskIndex || 1));
  for (let index = 0; index < workerCount; index += 1) {
    const workerId = `restore-file-${index + 1}`;
    workers[workerId] = createRestoreWorker(workerId);
  }

  let terminalStatus = 'completed';
  let pauseRequestedSeen = false;

  const emitProgress = (event) => {
    if (!onProgress) {
      return;
    }
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAtMs) / 1000);
    const queue = createRestoreQueueSnapshot(tasks, nextTaskIndex, activeTasks);
    let status = 'running';
    if (event?.type === 'restore-completed') {
      status = 'completed';
    } else if (event?.type === 'restore-paused' || event?.type === 'restore-pausing') {
      status = event?.type === 'restore-pausing' ? 'pausing' : 'paused';
    } else if (event?.type === 'restore-stopped') {
      status = 'stopped';
    } else if (pauseRequestedSeen && event?.type !== 'restore-completed') {
      status = 'pausing';
    }

    const progress = createRestoreProgressState({
      mode: 'restore',
      status,
      startedAt: startedAtIso,
      destinationRoot,
      filesProcessed: summary.restoredFiles,
      filesCopied: summary.restoredFiles,
      copiedBytes,
      totalBytes,
      workers,
      queue,
      throughputBytesPerSecond: copiedBytes / elapsedSeconds,
      message: summary.message
    });
    progress.resumed = resumed;

    onProgress({
      summary: {
        ...summary,
        copiedBytes,
        totalBytes,
        status
      },
      progress,
      event
    });
  };

  emitProgress({
    type: resumed ? 'restore-resumed' : 'restore-started',
    pool: 'file'
  });

  const workerIds = Object.keys(workers);
  await Promise.all(workerIds.map(async (workerId) => {
    while (true) {
      if (shouldStop()) {
        terminalStatus = 'stopped';
        return;
      }
      if (shouldPause()) {
        pauseRequestedSeen = true;
        terminalStatus = 'paused';
        emitProgress({
          type: 'restore-pausing',
          pool: 'file',
          workerId
        });
        return;
      }

      const taskIndex = nextTaskIndex;
      nextTaskIndex += 1;
      const task = tasks[taskIndex];
      if (!task) {
        workers[workerId] = {
          ...workers[workerId],
          state: 'idle',
          sourceRelativePath: null,
          logicalPath: null,
          lastAction: 'idle',
          copiedBytes: 0,
          totalBytes: 0
        };
        emitProgress({
          type: 'task-idle',
          pool: 'file',
          workerId
        });
        return;
      }

      workers[workerId] = {
        ...workers[workerId],
        state: 'copying',
        sourceRelativePath: task.relativePath,
        logicalPath: task.logicalPath,
        lastAction: 'copying',
        copiedBytes: 0,
        totalBytes: task.totalBytes
      };
      activeTasks[workerId] = task;
      emitProgress({
        type: 'task-started',
        pool: 'file',
        workerId,
        sourceRelativePath: task.relativePath
      });

      const restorePath = path.join(destinationRoot, ...task.relativePath.split('/'));
      await restorePlainFile(targetRoot, { type: 'plain', path: task.logicalPath }, restorePath);

      if (shouldStop()) {
        terminalStatus = 'stopped';
        delete activeTasks[workerId];
        return;
      }

      summary.restoredFiles += 1;
      copiedBytes += task.totalBytes;
      summary.copiedBytes = copiedBytes;
      workers[workerId] = {
        ...workers[workerId],
        state: 'idle',
        sourceRelativePath: null,
        logicalPath: task.logicalPath,
        lastAction: 'completed',
        copiedBytes: task.totalBytes,
        totalBytes: task.totalBytes
      };
      delete activeTasks[workerId];

      emitProgress({
        type: 'file-progress',
        pool: 'file',
        workerId,
        sourceRelativePath: task.relativePath
      });
    }
  }));

  summary.copiedBytes = copiedBytes;
  summary.status = terminalStatus;

  if (terminalStatus === 'paused') {
    await saveRestoreJob(appDataRoot, input.sourceId, {
      status: 'paused',
      targetRoot: path.resolve(targetRoot),
      machineId: input.machineId,
      sourceId: input.sourceId,
      destinationRoot,
      requestedDestinationRoot,
      appendFolder,
      nextTaskIndex,
      restoredFiles: summary.restoredFiles,
      copiedBytes,
      totalBytes,
      tasks,
      updatedAt: new Date().toISOString()
    });
    emitProgress({
      type: 'restore-paused',
      pool: 'file'
    });
    return summary;
  }

  await clearRestoreJob(appDataRoot, input.sourceId);

  if (terminalStatus === 'stopped') {
    summary.message = summary.message || 'Restore stopped.';
    emitProgress({
      type: 'restore-stopped',
      pool: 'file'
    });
    return summary;
  }

  await markSourceNeedsRescanAfterRestore(
    appDataRoot,
    sourceRecord.targetRoot || targetRoot,
    input.machineId,
    input.sourceId
  );

  emitProgress({
    type: 'restore-completed',
    pool: 'file'
  });

  return summary;
}

async function restoreLogicalTree(targetRoot, input) {
  const logicalRoot = toPosixPath(input.logicalRoot).replace(/\/+$/, '');
  const destinationRoot = path.resolve(input.destinationRoot);
  const sourceRoot = path.join(targetRoot, ...logicalRoot.split('/'));
  const restoredPaths = new Set();
  const summary = {
    logicalRoot,
    restoredFiles: 0
  };

  await walkFiles(sourceRoot, async ({ relativePath }) => {
    const logicalPath = logicalRoot ? path.posix.join(logicalRoot, relativePath) : relativePath;
    if (restoredPaths.has(logicalPath)) {
      return;
    }

    const restorePath = path.join(destinationRoot, ...relativePath.split('/'));
    await restorePlainFile(targetRoot, { type: 'plain', path: logicalPath }, restorePath);
    restoredPaths.add(logicalPath);
    summary.restoredFiles += 1;
  });

  return summary;
}

async function restoreLogicalFile(targetRoot, input) {
  const logicalPath = toPosixPath(input.logicalPath);
  const sourcePath = path.join(targetRoot, ...logicalPath.split('/'));
  const destinationPath = path.resolve(input.destinationPath);

  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(`Logical path not found: ${logicalPath}`);
  }

  await restorePlainFile(targetRoot, { type: 'plain', path: logicalPath }, destinationPath);
  return {
    logicalPath,
    restored: true
  };
}

module.exports = {
  collectRestoreTasks,
  findSourceRecord,
  resolveDestinationRoot,
  restoreLogicalFile,
  restoreLogicalTree,
  restoreSource
};
