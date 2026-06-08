const { createScanId } = require('./ids');
const { createBackupScanState, loadBackupScanState, saveBackupScanState } = require('./backupSchema');
const { normalizeCursor } = require('./cursor/cursorState');
const { createLogger } = require('./logger');

const logger = createLogger('ScanManager', 'scanManager.js');

async function startNewGeneration(targetRoot, machineId, sourceId, options = {}) {
  const now = options.now || new Date();
  const scanState = createBackupScanState({
    activeGeneration: options.scanId || createScanId(now),
    status: 'running',
    startedAt: now.toISOString(),
    completedAt: null,
    updatedAt: now.toISOString()
  }, now);

  await saveBackupScanState(options.appDataRoot || targetRoot, targetRoot, machineId, sourceId, scanState, now);
  return scanState;
}

async function getResumeState(targetRoot, machineId, sourceId, options = {}) {
  const appDataRoot = options.appDataRoot || targetRoot;
  const state = await loadBackupScanState(appDataRoot, targetRoot, machineId, sourceId);
  if (!state || !state.activeGeneration || state.status === 'completed' || state.status === 'idle') {
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
  const resume = await getResumeState(targetRoot, machineId, sourceId, options);
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

async function markGenerationCompleted(targetRoot, machineId, sourceId, now = new Date(), appDataRoot = targetRoot) {
  const state = await loadBackupScanState(appDataRoot, targetRoot, machineId, sourceId);
  if (!state) {
    throw new Error(`Scan state not found: ${machineId}/${sourceId}`);
  }

  const completed = createBackupScanState({
    ...state,
    status: 'completed',
    completedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    resumeCursor: null
  }, now);

  await saveBackupScanState(appDataRoot, targetRoot, machineId, sourceId, completed, now);
  return completed;
}

async function markGenerationPaused(targetRoot, machineId, sourceId, now = new Date(), resumeCursor = null, appDataRoot = targetRoot) {
  const state = await loadBackupScanState(appDataRoot, targetRoot, machineId, sourceId);
  if (!state) {
    throw new Error(`Scan state not found: ${machineId}/${sourceId}`);
  }

  const persistedCursor = resumeCursor
    ? normalizeCursor({
        ...resumeCursor,
        scanId: resumeCursor.scanId || state.activeGeneration,
        updatedAt: now.toISOString()
      })
    : state.resumeCursor || null;

  const paused = createBackupScanState({
    ...state,
    status: 'paused',
    completedAt: null,
    updatedAt: now.toISOString(),
    resumeCursor: persistedCursor
  }, now);

  await saveBackupScanState(appDataRoot, targetRoot, machineId, sourceId, paused, now);
  return paused;
}

module.exports = {
  ensureScanState,
  getResumeState,
  markGenerationCompleted,
  markGenerationPaused,
  startNewGeneration
};
