const { ensureBackupSchema } = require('./backupSchema');

async function listSourcesForMachine(targetRoot, machineId, options = {}) {
  const appDataRoot = options.appDataRoot || targetRoot;
  const schema = await ensureBackupSchema(appDataRoot);
  const target = (schema.targets || []).find((entry) => entry.path === targetRoot);
  if (!target) {
    return [];
  }
  return (target.sources || [])
    .filter((source) => source.machineId === machineId)
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

async function loadCurrentMachineContext(targetRoot, options = {}) {
  const appDataRoot = options.appDataRoot || targetRoot;
  const schema = await ensureBackupSchema(appDataRoot);
  const target = (schema.targets || []).find((entry) => entry.path === targetRoot);
  return {
    appConfig: {
      ...schema,
      machineId: schema.machine ? schema.machine.machineId : null
    },
    machine: schema.machine || null,
    sources: target ? (target.sources || []).slice().sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)) : []
  };
}

module.exports = {
  listSourcesForMachine,
  loadCurrentMachineContext
};
