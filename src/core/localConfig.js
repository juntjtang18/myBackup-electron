const path = require('path');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');

function getLocalConfigPath(appDataRoot) {
  return path.join(path.resolve(appDataRoot), 'mybackup-ui.json');
}

const { normalizeTargets } = require('./targetConfig');

async function loadLocalConfig(appDataRoot) {
  const config = await readJsonIfExists(getLocalConfigPath(appDataRoot));
  const base = config || {
    logLevel: 'info',
    updatedAt: null
  };
  return {
    logLevel: base.logLevel || 'info',
    targets: normalizeTargets(base),
    updatedAt: base.updatedAt || null
  };
}

async function saveLocalConfig(appDataRoot, updates, now = new Date()) {
  const current = await loadLocalConfig(appDataRoot);
  const nextConfig = {
    ...current,
    ...updates,
    updatedAt: now.toISOString()
  };
  await writeJsonAtomic(getLocalConfigPath(appDataRoot), nextConfig);
  return nextConfig;
}

module.exports = {
  getLocalConfigPath,
  loadLocalConfig,
  saveLocalConfig
};
