const { listBackupTargets, registerBackupSource, updateBackupSource } = require('./backupSchema');
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
      lastCompletedAt: scanState.lastCompletedAt || current.lastCompletedAt
    }),
    now
  );

  return updated;
}

async function updateSourceWatchState(appDataRoot, machineId, sourceId, updater, now = new Date(), options = {}) {
  const targets = await listBackupTargets(appDataRoot);
  const updates = [];

  for (const target of targets) {
    const matchesSource = (target.sources || []).some((source) => (
      source.machineId === machineId
      && source.sourceId === sourceId
      && (!options.sourcePath || source.sourcePath === options.sourcePath)
    ));
    if (!matchesSource) {
      continue;
    }

    const updated = await updateBackupSource(
      appDataRoot,
      target.path,
      machineId,
      sourceId,
      (current) => ({
        ...current,
        watchState: typeof updater === 'function'
          ? updater(current.watchState || {
            dirtyRef: `watch/${sourceId}.dirty.json`,
            needsRescan: false,
            lastEventAt: null
          }, current)
          : {
            ...(current.watchState || {
              dirtyRef: `watch/${sourceId}.dirty.json`,
              needsRescan: false,
              lastEventAt: null
            }),
            ...updater
          }
      }),
      now
    );
    updates.push(updated);
  }

  return updates;
}

module.exports = {
  registerSource,
  updateSourceScanState,
  updateSourceWatchState
};
