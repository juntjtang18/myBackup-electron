const {
  ensureBackupSchema,
  listTargetBackupSources,
  loadBackupMachine
} = require('./backupSchema');
const { loadCatalog, mergeDashboardSources } = require('./targetCatalog');

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
  const localSources = await listTargetBackupSources(appDataRoot, targetRoot).catch(() => []);
  const catalog = await loadCatalog(targetRoot);
  const sources = await mergeDashboardSources({
    localSources,
    catalog,
    computerId: machine ? machine.computerId : null
  });
  return {
    appConfig: {
      ...schema,
      machineId: machine ? machine.machineId : null,
      computerId: machine ? machine.computerId : null
    },
    machine: machine || null,
    catalog,
    sources
  };
}

module.exports = {
  listSourcesForMachine,
  loadCurrentMachineContext
};
