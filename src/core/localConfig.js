const fs = require('fs-extra');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { appMetadataRoot, legacyLocalConfigPath, localConfigPath } = require('./paths');

const DEFAULT_WORKER_POOLS = Object.freeze({
  hash: 6,
  copy: 6
});

function normalizeWorkerPoolValue(value, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    return fallback;
  }
  return Math.min(numeric, 64);
}

function normalizeWorkerPools(value = {}) {
  return {
    hash: normalizeWorkerPoolValue(value.hash, DEFAULT_WORKER_POOLS.hash),
    copy: normalizeWorkerPoolValue(value.copy, DEFAULT_WORKER_POOLS.copy)
  };
}

async function loadLocalConfig(appDataRoot) {
  const config = await readJsonIfExists(localConfigPath(appDataRoot))
    || await readJsonIfExists(legacyLocalConfigPath(appDataRoot));
  const base = config || {
    targetRoot: null,
    logLevel: 'info',
    workerPools: DEFAULT_WORKER_POOLS,
    updatedAt: null
  };
  return {
    targetRoot: base.targetRoot || null,
    logLevel: base.logLevel || 'info',
    workerPools: normalizeWorkerPools(base.workerPools),
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
  await fs.ensureDir(appMetadataRoot(appDataRoot));
  await writeJsonAtomic(localConfigPath(appDataRoot), nextConfig);
  return nextConfig;
}

async function ensureLocalConfig(appDataRoot, now = new Date()) {
  const configPath = localConfigPath(appDataRoot);
  if (await fs.pathExists(configPath)) {
    return loadLocalConfig(appDataRoot);
  }
  const legacyConfigPath = legacyLocalConfigPath(appDataRoot);
  if (await fs.pathExists(legacyConfigPath)) {
    const migrated = await loadLocalConfig(appDataRoot);
    await saveLocalConfig(appDataRoot, migrated, now);
    return loadLocalConfig(appDataRoot);
  }

  const initialConfig = {
    targetRoot: null,
    logLevel: 'info',
    workerPools: DEFAULT_WORKER_POOLS,
    updatedAt: now.toISOString()
  };
  await fs.ensureDir(appMetadataRoot(appDataRoot));
  await writeJsonAtomic(configPath, initialConfig);
  return loadLocalConfig(appDataRoot);
}

module.exports = {
  DEFAULT_WORKER_POOLS,
  ensureLocalConfig,
  getLocalConfigPath: localConfigPath,
  loadLocalConfig,
  normalizeWorkerPools,
  saveLocalConfig
};
