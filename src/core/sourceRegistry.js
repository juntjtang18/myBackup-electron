const { registerBackupSource, updateBackupSource } = require('./backupSchema');
const { createSourceRecord, validateSourceRecord } = require('./schema');

async function registerSource(appDataRoot, input, now = new Date()) {
  const targetRoot = input.targetRoot || appDataRoot;
  const candidate = createSourceRecord(input, now);
  const registered = await registerBackupSource(appDataRoot, {
    ...input,
    targetRoot,
    machineId: candidate.machineId,
    sourceId: candidate.sourceId
  }, now);

  validateSourceRecord(registered);
  return registered;
}

async function updateSourceScanState(appDataRoot, machineId, sourceId, scanState, now = new Date()) {
  const targetRoot = scanState.targetRoot || appDataRoot;
  const updated = await updateBackupSource(
    appDataRoot,
    targetRoot,
    machineId,
    sourceId,
    (current) => ({
      ...current,
      lastCompletedScan: scanState.lastCompletedScan || current.lastCompletedScan,
      lastCompletedAt: scanState.lastCompletedAt || current.lastCompletedAt
    }),
    now
  );

  return updated;
}

module.exports = {
  registerSource,
  updateSourceScanState
};
