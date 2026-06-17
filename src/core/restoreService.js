const fs = require('fs-extra');
const path = require('path');
const { restorePlainFile } = require('./plainFileStorage');
const { loadBackupSchema } = require('./backupSchema');
const { getSourceTargetRoot } = require('./pathPlanner');
const { toPosixPath } = require('./layout');

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
  throughputBytesPerSecond
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

  return tasks;
}

async function restoreSource(targetRoot, input) {
  const requestedDestinationRoot = path.resolve(input.destinationRoot);
  const sourceRecord = await findSourceRecord(input.appDataRoot || targetRoot, input.machineId, input.sourceId);
  const onProgress = typeof input.onProgress === 'function' ? input.onProgress : null;
  const maxWorkers = Math.max(1, Number(input.maxWorkers || 1));
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const summary = {
    machineId: input.machineId,
    sourceId: input.sourceId,
    restoredFiles: 0,
    skippedRecords: 0,
    destinationRoot: requestedDestinationRoot,
    copiedBytes: 0,
    totalBytes: 0
  };

  if (!sourceRecord) {
    return summary;
  }

  const sourceRoot = getSourceTargetRoot(sourceRecord.source.machineId, sourceRecord.source);
  const sourceRestoreFolderName = path.basename(sourceRoot) || path.basename(sourceRecord.source.sourcePath || '') || 'restored-source';
  const destinationRoot = path.join(requestedDestinationRoot, sourceRestoreFolderName);
  summary.destinationRoot = destinationRoot;
  summary.requestedDestinationRoot = requestedDestinationRoot;

  const tasks = await collectRestoreTasks(targetRoot, sourceRecord.source);
  const workers = {};
  const activeTasks = {};
  let nextTaskIndex = 0;
  let copiedBytes = 0;
  const totalBytes = tasks.reduce((sum, task) => sum + task.totalBytes, 0);
  summary.totalBytes = totalBytes;
  const workerCount = Math.min(maxWorkers, Math.max(1, tasks.length || 1));
  for (let index = 0; index < workerCount; index += 1) {
    const workerId = `restore-file-${index + 1}`;
    workers[workerId] = createRestoreWorker(workerId);
  }

  const emitProgress = (event) => {
    if (!onProgress) {
      return;
    }
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAtMs) / 1000);
    const queue = createRestoreQueueSnapshot(tasks, nextTaskIndex, activeTasks);
    const progress = createRestoreProgressState({
      mode: 'restore',
      status: event?.type === 'restore-completed' ? 'completed' : 'running',
      startedAt: startedAtIso,
      destinationRoot,
      filesProcessed: summary.restoredFiles,
      filesCopied: summary.restoredFiles,
      copiedBytes,
      totalBytes,
      workers,
      queue,
      throughputBytesPerSecond: copiedBytes / elapsedSeconds
    });

    onProgress({
      summary: {
        ...summary,
        copiedBytes,
        totalBytes
      },
      progress,
      event
    });
  };

  emitProgress({
    type: 'restore-started',
    pool: 'file'
  });

  const workerIds = Object.keys(workers);
  await Promise.all(workerIds.map(async (workerId) => {
    while (true) {
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
  restoreLogicalFile,
  restoreLogicalTree,
  restoreSource
};
