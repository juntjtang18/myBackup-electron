const { loadBackupSource, updateBackupSource } = require('../backupSchema');
const { normalizeCursor } = require('../cursor/cursorState');

function nowIso(now = new Date()) {
  return now.toISOString();
}

function createLegacyScanState(input = {}, now = new Date()) {
  return {
    status: input.status || 'idle',
    activeGeneration: input.activeGeneration || null,
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
    updatedAt: input.updatedAt || nowIso(now),
    resumeCursor: input.resumeCursor ? normalizeCursor(input.resumeCursor) : null
  };
}

async function loadLegacyBackupScanState(appDataRoot, targetRoot, machineId, sourceId) {
  const source = await loadBackupSource(appDataRoot, targetRoot, machineId, sourceId);
  return source ? source.scanState || null : null;
}

async function saveLegacyBackupScanState(appDataRoot, targetRoot, machineId, sourceId, scanState, now = new Date()) {
  const nextScanState = createLegacyScanState(scanState, now);
  const updated = await updateBackupSource(
    appDataRoot,
    targetRoot,
    machineId,
    sourceId,
    (source) => ({
      ...source,
      scanState: nextScanState
    }),
    now
  );
  return updated.scanState;
}

module.exports = {
  createLegacyScanState,
  loadLegacyBackupScanState,
  saveLegacyBackupScanState
};
