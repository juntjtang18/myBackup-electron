const fs = require('fs-extra');
const { createFolderId } = require('./ids');
const { folderCheckpointPath, scanGenerationRoot } = require('./layout');
const { readJsonIfExists } = require('./jsonStore');
const { validateFolderCheckpoint } = require('./schema');

async function listFolderCheckpoints(targetRoot, machineId, sourceId, scanId) {
  const folderDir = scanGenerationRoot(targetRoot, machineId, sourceId, scanId);
  const checkpointsDir = `${folderDir}/folders`;

  if (!(await fs.pathExists(checkpointsDir))) {
    return [];
  }

  const entries = await fs.readdir(checkpointsDir);
  const checkpoints = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    const checkpoint = await readJsonIfExists(
      folderCheckpointPath(targetRoot, machineId, sourceId, scanId, entry.slice(0, -5)),
      validateFolderCheckpoint
    );

    if (checkpoint) {
      checkpoints.push(checkpoint);
    }
  }

  checkpoints.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return checkpoints;
}

async function loadFolderCheckpoint(targetRoot, machineId, sourceId, scanId, folderId) {
  return readJsonIfExists(
    folderCheckpointPath(targetRoot, machineId, sourceId, scanId, folderId),
    validateFolderCheckpoint
  );
}

async function findCheckpointByRelativePath(targetRoot, machineId, sourceId, scanId, relativePath) {
  const folderId = createFolderId(relativePath);
  const checkpoint = await loadFolderCheckpoint(targetRoot, machineId, sourceId, scanId, folderId);
  if (!checkpoint || checkpoint.relativePath !== relativePath) {
    return null;
  }

  return checkpoint;
}

async function findNextPendingCheckpoint(targetRoot, machineId, sourceId, scanId) {
  const folderDir = scanGenerationRoot(targetRoot, machineId, sourceId, scanId);
  const checkpointsDir = `${folderDir}/folders`;

  if (!(await fs.pathExists(checkpointsDir))) {
    return null;
  }

  const entries = await fs.readdir(checkpointsDir);
  let nextCheckpoint = null;

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    const checkpoint = await loadFolderCheckpoint(
      targetRoot,
      machineId,
      sourceId,
      scanId,
      entry.slice(0, -5)
    );

    if (!checkpoint || (checkpoint.status !== 'pending' && checkpoint.status !== 'scanning')) {
      continue;
    }

    if (!nextCheckpoint || checkpoint.relativePath.localeCompare(nextCheckpoint.relativePath) < 0) {
      nextCheckpoint = checkpoint;
    }
  }

  return nextCheckpoint;
}

module.exports = {
  findCheckpointByRelativePath,
  findNextPendingCheckpoint,
  listFolderCheckpoints,
  loadFolderCheckpoint
};
