const path = require('path');
const fs = require('fs-extra');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');

function getLocalConfigPath(appDataRoot) {
  return path.join(path.resolve(appDataRoot), 'mybackup-ui.json');
}

const { normalizeTargets } = require('./targetConfig');

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
  const config = await readJsonIfExists(getLocalConfigPath(appDataRoot));
  const base = config || {
    logLevel: 'info',
    workerPools: DEFAULT_WORKER_POOLS,
    updatedAt: null
  };
  return {
    logLevel: base.logLevel || 'info',
    targetRoot: base.targetRoot || null,
    targets: normalizeTargets(base),
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
  await writeJsonAtomic(getLocalConfigPath(appDataRoot), nextConfig);
  return nextConfig;
}

async function ensureLocalConfig(appDataRoot, now = new Date()) {
  const configPath = getLocalConfigPath(appDataRoot);
  if (await fs.pathExists(configPath)) {
    return loadLocalConfig(appDataRoot);
  }

  const initialConfig = {
    logLevel: 'info',
    targets: [],
    workerPools: DEFAULT_WORKER_POOLS,
    updatedAt: now.toISOString()
  };
  await writeJsonAtomic(configPath, initialConfig);
  return loadLocalConfig(appDataRoot);
}

module.exports = {
  DEFAULT_WORKER_POOLS,
  ensureLocalConfig,
  getLocalConfigPath,
  loadLocalConfig,
  normalizeWorkerPools,
  saveLocalConfig
};
