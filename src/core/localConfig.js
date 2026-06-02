const path = require('path');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');

function getLocalConfigPath(appDataRoot) {
  return path.join(path.resolve(appDataRoot), 'mybackup-ui.json');
}

async function loadLocalConfig(appDataRoot) {
  const config = await readJsonIfExists(getLocalConfigPath(appDataRoot));
  return config || {
    targetRoot: null,
    logLevel: 'info',
    updatedAt: null
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
