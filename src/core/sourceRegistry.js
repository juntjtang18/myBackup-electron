const { loadSource, saveSource } = require('./metadataStore');
const { createSourceRecord, validateSourceRecord } = require('./schema');

async function registerSource(targetRoot, input, now = new Date()) {
  const candidate = createSourceRecord(input, now);
  const current = await loadSource(targetRoot, candidate.machineId, candidate.sourceId);

  const merged = createSourceRecord({
    ...current,
    ...candidate,
    createdAt: current ? current.createdAt : undefined,
    lastCompletedScan: current ? current.lastCompletedScan : null,
    lastCompletedAt: current ? current.lastCompletedAt : null,
    updatedAt: now.toISOString()
  }, now);

  validateSourceRecord(merged);
  await saveSource(targetRoot, merged);
  return merged;
}

async function updateSourceScanState(targetRoot, machineId, sourceId, scanState, now = new Date()) {
  const current = await loadSource(targetRoot, machineId, sourceId);
  if (!current) {
    throw new Error(`Source not found: ${machineId}/${sourceId}`);
  }

  const updated = createSourceRecord({
    ...current,
    lastCompletedScan: scanState.lastCompletedScan || current.lastCompletedScan,
    lastCompletedAt: scanState.lastCompletedAt || current.lastCompletedAt,
    updatedAt: now.toISOString()
  }, now);

  await saveSource(targetRoot, updated);
  return updated;
}

module.exports = {
  registerSource,
  updateSourceScanState
};
