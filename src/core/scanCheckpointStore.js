const fs = require('fs-extra');
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

async function findCheckpointByRelativePath(targetRoot, machineId, sourceId, scanId, relativePath) {
  const checkpoints = await listFolderCheckpoints(targetRoot, machineId, sourceId, scanId);
  return checkpoints.find((checkpoint) => checkpoint.relativePath === relativePath) || null;
}

module.exports = {
  findCheckpointByRelativePath,
  listFolderCheckpoints
};
