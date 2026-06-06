const { createScanId } = require('./ids');
const { loadScanState, saveScanState } = require('./metadataStore');
const { createScanState } = require('./schema');
const { createLogger } = require('./logger');

const logger = createLogger('ScanManager', 'scanManager.js');

async function startNewGeneration(targetRoot, machineId, sourceId, options = {}) {
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
  return scanState;
}

async function getResumeState(targetRoot, machineId, sourceId) {
  const state = await loadScanState(targetRoot, machineId, sourceId);
  if (!state || state.status === 'completed') {
    return null;
  }

  logger.info('Loaded resumable scan state.', {
    targetRoot,
    machineId,
    sourceId,
    scanId: state.activeGeneration,
    status: state.status
  });

  return {
    scanState: state
  };
}

async function ensureScanState(targetRoot, machineId, sourceId, options = {}) {
  const resume = await getResumeState(targetRoot, machineId, sourceId);
  if (resume && !options.forceNew) {
    logger.info('Reusing resumable scan state.', {
      targetRoot,
      machineId,
      sourceId,
      scanId: resume.scanState.activeGeneration,
      status: resume.scanState.status
    });
    return resume;
  }

  const scanState = await startNewGeneration(targetRoot, machineId, sourceId, options);
  return {
    scanState
  };
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
    updatedAt: now.toISOString(),
    resumeCursor: null
  }, now);

  await saveScanState(targetRoot, completed);
  return completed;
}

async function markGenerationPaused(targetRoot, machineId, sourceId, now = new Date(), resumeCursor = null) {
  const state = await loadScanState(targetRoot, machineId, sourceId);
  if (!state) {
    throw new Error(`Scan state not found: ${machineId}/${sourceId}`);
  }

  const persistedCursor = resumeCursor
    ? {
        ...resumeCursor,
        scanId: resumeCursor.scanId || state.activeGeneration,
        updatedAt: now.toISOString()
      }
    : state.resumeCursor || null;

  const paused = createScanState({
    ...state,
    status: 'paused',
    completedAt: null,
    updatedAt: now.toISOString(),
    resumeCursor: persistedCursor
  }, now);

  await saveScanState(targetRoot, paused);
  return paused;
}

module.exports = {
  ensureScanState,
  getResumeState,
  markGenerationCompleted,
  markGenerationPaused,
  startNewGeneration
};
