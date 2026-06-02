const { sourceSnapshotPath, toPosixPath } = require('./layout');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('source snapshot must be an object.');
  }
  if (typeof snapshot.machineId !== 'string' || !snapshot.machineId) {
    throw new Error('source snapshot machineId is required.');
  }
  if (typeof snapshot.sourceId !== 'string' || !snapshot.sourceId) {
    throw new Error('source snapshot sourceId is required.');
  }
  if (!snapshot.files || typeof snapshot.files !== 'object') {
    throw new Error('source snapshot files must be an object.');
  }

  for (const [relativePath, entry] of Object.entries(snapshot.files)) {
    if (toPosixPath(relativePath) !== relativePath) {
      throw new Error('source snapshot keys must be posix paths.');
    }
    if (!entry || typeof entry !== 'object') {
      throw new Error('source snapshot entry must be an object.');
    }
    if (typeof entry.size !== 'number' || entry.size < 0) {
      throw new Error('source snapshot entry size must be a non-negative number.');
    }
    if (typeof entry.mtimeMs !== 'number' || entry.mtimeMs < 0) {
      throw new Error('source snapshot entry mtimeMs must be a non-negative number.');
    }
    if (typeof entry.fileHash !== 'string' || !entry.fileHash) {
      throw new Error('source snapshot entry fileHash is required.');
    }
    if (typeof entry.logicalPath !== 'string' || !entry.logicalPath) {
      throw new Error('source snapshot entry logicalPath is required.');
    }
  }

  return snapshot;
}

function createSourceSnapshot(machineId, sourceId, current = null, now = new Date()) {
  const existingFiles = current && current.files ? current.files : {};
  return {
    machineId,
    sourceId,
    createdAt: current && current.createdAt ? current.createdAt : now.toISOString(),
    updatedAt: now.toISOString(),
    files: { ...existingFiles }
  };
}

async function loadSourceSnapshot(targetRoot, machineId, sourceId) {
  return readJsonIfExists(sourceSnapshotPath(targetRoot, machineId, sourceId), validateSnapshot);
}

async function saveSourceSnapshot(targetRoot, snapshot) {
  validateSnapshot(snapshot);
  await writeJsonAtomic(sourceSnapshotPath(targetRoot, snapshot.machineId, snapshot.sourceId), snapshot);
}

module.exports = {
  createSourceSnapshot,
  loadSourceSnapshot,
  saveSourceSnapshot,
  validateSnapshot
};
