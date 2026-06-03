const path = require('path');
const { loadLocalConfig, saveLocalConfig } = require('./localConfig');
const { createTargetId, normalizeTargets } = require('./targetConfig');

async function listTargets(appDataRoot) {
  const config = await loadLocalConfig(appDataRoot);
  return config.targets || [];
}

async function addTarget(appDataRoot, targetPath, now = new Date()) {
  const resolvedPath = path.resolve(targetPath);
  const current = await listTargets(appDataRoot);
  const existing = current.find((entry) => entry.path === resolvedPath);
  if (existing) {
    return existing;
  }

  const nextTarget = {
    id: createTargetId(resolvedPath),
    path: resolvedPath,
    collapsed: false,
    addedAt: now.toISOString()
  };

  await saveLocalConfig(appDataRoot, {
    targets: [...current, nextTarget]
  }, now);

  return nextTarget;
}

async function removeTarget(appDataRoot, targetId, now = new Date()) {
  const current = await listTargets(appDataRoot);
  await saveLocalConfig(appDataRoot, {
    targets: current.filter((entry) => entry.id !== targetId)
  }, now);
}

async function setTargetCollapsed(appDataRoot, targetId, collapsed, now = new Date()) {
  const current = await listTargets(appDataRoot);
  await saveLocalConfig(appDataRoot, {
    targets: current.map((entry) => (
      entry.id === targetId
        ? { ...entry, collapsed: Boolean(collapsed) }
        : entry
    ))
  }, now);
}

async function requireRegisteredTarget(appDataRoot, targetRoot) {
  if (!targetRoot) {
    throw new Error('Backup target is required.');
  }

  const resolvedPath = path.resolve(targetRoot);
  const current = await listTargets(appDataRoot);
  const match = current.find((entry) => entry.path === resolvedPath);
  if (!match) {
    throw new Error(`Unknown backup target: ${resolvedPath}`);
  }

  return match.path;
}

module.exports = {
  addTarget,
  listTargets,
  normalizeTargets,
  removeTarget,
  requireRegisteredTarget,
  setTargetCollapsed
};
