const path = require('path');
const { createFolderId, createScanId } = require('./ids');
const { loadScanState, loadSource, saveFolderCheckpoint, saveScanState } = require('./metadataStore');
const { findCheckpointByRelativePath, listFolderCheckpoints } = require('./scanCheckpointStore');
const { createFolderCheckpoint, createScanState } = require('./schema');

async function startNewGeneration(targetRoot, machineId, sourceId, options = {}) {
  const source = await loadSource(targetRoot, machineId, sourceId);
  if (!source) {
    throw new Error(`Source not found: ${machineId}/${sourceId}`);
  }

  const now = options.now || new Date();
  const scanState = createScanState({
    machineId,
    sourceId,
    activeGeneration: options.scanId || createScanId(now),
    status: 'running',
    startedAt: now.toISOString(),
    completedAt: null,
    updatedAt: now.toISOString()
  }, now);

  await saveScanState(targetRoot, scanState);

  const rootCheckpoint = createFolderCheckpoint({
    folderId: createFolderId('.'),
    folderPath: source.sourcePath,
    relativePath: '.',
    status: 'pending',
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null
  }, now);

  await saveFolderCheckpoint(targetRoot, machineId, sourceId, scanState.activeGeneration, rootCheckpoint);
  return scanState;
}

async function getResumeState(targetRoot, machineId, sourceId) {
  const state = await loadScanState(targetRoot, machineId, sourceId);
  if (!state || state.status === 'completed') {
    return null;
  }

  const checkpoints = await listFolderCheckpoints(targetRoot, machineId, sourceId, state.activeGeneration);
  return {
    scanState: state,
    checkpoints
  };
}

async function ensureScanState(targetRoot, machineId, sourceId, options = {}) {
  const resume = await getResumeState(targetRoot, machineId, sourceId);
  if (resume && !options.forceNew) {
    return resume;
  }

  const scanState = await startNewGeneration(targetRoot, machineId, sourceId, options);
  return {
    scanState,
    checkpoints: await listFolderCheckpoints(targetRoot, machineId, sourceId, scanState.activeGeneration)
  };
}

async function saveDiscoveredFolders(targetRoot, machineId, sourceId, scanId, parentRelativePath, childFolders, now = new Date()) {
  const created = [];

  for (const childFolder of childFolders) {
    const relativePath = parentRelativePath === '.'
      ? childFolder.name
      : path.posix.join(parentRelativePath, childFolder.name);

    const existing = await findCheckpointByRelativePath(targetRoot, machineId, sourceId, scanId, relativePath);
    if (existing) {
      created.push(existing);
      continue;
    }

    const checkpoint = createFolderCheckpoint({
      folderId: createFolderId(relativePath),
      folderPath: childFolder.path,
      relativePath,
      status: 'pending',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null
    }, now);

    await saveFolderCheckpoint(targetRoot, machineId, sourceId, scanId, checkpoint);
    created.push(checkpoint);
  }

  return created;
}

async function updateFolderStatus(targetRoot, machineId, sourceId, scanId, checkpoint, status, metrics = {}, now = new Date()) {
  const updated = createFolderCheckpoint({
    ...checkpoint,
    status,
    filesSeen: metrics.filesSeen !== undefined ? metrics.filesSeen : checkpoint.filesSeen,
    subfoldersSeen: metrics.subfoldersSeen !== undefined ? metrics.subfoldersSeen : checkpoint.subfoldersSeen,
    startedAt: checkpoint.startedAt || now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: status === 'done' ? now.toISOString() : null
  }, now);

  await saveFolderCheckpoint(targetRoot, machineId, sourceId, scanId, updated);
  return updated;
}

async function markGenerationCompleted(targetRoot, machineId, sourceId, now = new Date()) {
  const state = await loadScanState(targetRoot, machineId, sourceId);
  if (!state) {
    throw new Error(`Scan state not found: ${machineId}/${sourceId}`);
  }

  const completed = createScanState({
    ...state,
    status: 'completed',
    completedAt: now.toISOString(),
    updatedAt: now.toISOString()
  }, now);

  await saveScanState(targetRoot, completed);
  return completed;
}

module.exports = {
  ensureScanState,
  getResumeState,
  markGenerationCompleted,
  saveDiscoveredFolders,
  startNewGeneration,
  updateFolderStatus
};
