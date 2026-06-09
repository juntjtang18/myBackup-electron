const {
  ensureBackupSchema,
  listTargetBackupSources,
  loadBackupMachine
} = require('./backupSchema');

async function listSourcesForMachine(targetRoot, machineId, options = {}) {
  const appDataRoot = options.appDataRoot || targetRoot;
  const sources = await listTargetBackupSources(appDataRoot, targetRoot).catch(() => []);
  return sources
    .filter((source) => source.machineId === machineId)
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

async function loadCurrentMachineContext(targetRoot, options = {}) {
  const appDataRoot = options.appDataRoot || targetRoot;
  const schema = await ensureBackupSchema(appDataRoot);
  const machine = await loadBackupMachine(appDataRoot);
  const sources = await listTargetBackupSources(appDataRoot, targetRoot).catch(() => []);
  return {
    appConfig: {
      ...schema,
      machineId: machine ? machine.machineId : null
    },
    machine: machine || null,
    sources
  };
}

module.exports = {
  listSourcesForMachine,
  loadCurrentMachineContext
};
