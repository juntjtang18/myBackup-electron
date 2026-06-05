const { loadScanState, saveScanState } = require('../metadataStore');
const { createResumeCursor, normalizeResumeCursor } = require('./resumeCursor');
const { createLogger } = require('../logger');

const logger = createLogger('ResumeStateService', 'resumeStateService.js');

async function loadResumeState(targetRoot, machineId, sourceId) {
  const state = await loadScanState(targetRoot, machineId, sourceId);
  if (!state) {
    return null;
  }

  return {
    ...state,
    resumeCursor: normalizeResumeCursor(state.resumeCursor)
  };
}

async function updateResumeCursor(targetRoot, machineId, sourceId, cursor, now = new Date()) {
  const state = await loadScanState(targetRoot, machineId, sourceId);
  if (!state) {
    throw new Error(`Scan state not found: ${machineId}/${sourceId}`);
  }

  const nextCursor = cursor ? createResumeCursor(cursor, now) : null;
  const updated = {
    ...state,
    resumeCursor: nextCursor,
    updatedAt: now.toISOString()
  };

  await saveScanState(targetRoot, updated);
  logger.debug('Updated resume cursor.', {
    targetRoot,
    machineId,
    sourceId,
    relativePath: nextCursor ? nextCursor.relativePath : null,
    folderHash: nextCursor ? nextCursor.folderHash : null
  });

  return updated;
}

async function clearResumeCursor(targetRoot, machineId, sourceId, now = new Date()) {
  return updateResumeCursor(targetRoot, machineId, sourceId, null, now);
}

module.exports = {
  clearResumeCursor,
  loadResumeState,
  updateResumeCursor
};
