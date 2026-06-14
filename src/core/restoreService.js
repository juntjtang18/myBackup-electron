const fs = require('fs-extra');
const path = require('path');
const { restorePlainFile } = require('./plainFileStorage');
const { loadBackupSchema } = require('./backupSchema');
const { getSourceTargetRoot } = require('./pathPlanner');
const { toPosixPath } = require('./layout');

async function findSourceRecord(targetRoot, machineId, sourceId) {
  const schema = await loadBackupSchema(targetRoot);
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

async function restoreSource(targetRoot, input) {
  const destinationRoot = path.resolve(input.destinationRoot);
  const sourceRecord = await findSourceRecord(targetRoot, input.machineId, input.sourceId);
  const summary = {
    machineId: input.machineId,
    sourceId: input.sourceId,
    restoredFiles: 0,
    skippedRecords: 0
  };

  if (!sourceRecord) {
    return summary;
  }

  const sourceTargetRoot = path.join(targetRoot, getSourceTargetRoot(sourceRecord.source.machineId, sourceRecord.source));
  await walkFiles(sourceTargetRoot, async ({ relativePath }) => {
    const logicalPath = path.posix.join(getSourceTargetRoot(sourceRecord.source.machineId, sourceRecord.source), relativePath);
    const restorePath = path.join(destinationRoot, ...relativePath.split('/'));
    await restorePlainFile(targetRoot, { type: 'plain', path: logicalPath }, restorePath);
    summary.restoredFiles += 1;
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
