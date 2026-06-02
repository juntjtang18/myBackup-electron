const path = require('path');
const fs = require('fs-extra');
const { metadataRoot } = require('./layout');
const { loadAppConfig, loadMachine, loadScanState, loadSource } = require('./metadataStore');

async function listSourcesForMachine(targetRoot, machineId) {
  const sourcesDir = path.join(metadataRoot(targetRoot), 'sources', machineId);
  if (!(await fs.pathExists(sourcesDir))) {
    return [];
  }

  const entries = await fs.readdir(sourcesDir, { withFileTypes: true });
  const sources = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const sourceId = path.basename(entry.name, '.json');
    const source = await loadSource(targetRoot, machineId, sourceId);
    if (!source) {
      continue;
    }

    const scanState = await loadScanState(targetRoot, machineId, sourceId);
    sources.push({
      ...source,
      scanState
    });
  }

  sources.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  return sources;
}

async function loadCurrentMachineContext(targetRoot) {
  const appConfig = await loadAppConfig(targetRoot);
  if (!appConfig) {
    return {
      appConfig: null,
      machine: null,
      sources: []
    };
  }

  const machine = await loadMachine(targetRoot, appConfig.machineId);
  const sources = await listSourcesForMachine(targetRoot, appConfig.machineId);
  return {
    appConfig,
    machine,
    sources
  };
}

module.exports = {
  listSourcesForMachine,
  loadCurrentMachineContext
};
