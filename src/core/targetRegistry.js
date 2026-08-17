const {
  addBackupTarget,
  listBackupTargets,
  listTargetBackupSources,
  loadBackupMachine,
  removeBackupTarget,
  requireBackupTarget,
  setBackupTargetCollapsed
} = require('./backupSchema');
const { normalizeTargets } = require('./targetConfig');
const { clearCatalog, ensureCatalog } = require('./targetCatalog');
const { cleanupSourceRegistrations } = require('./sourceRegistry');
const { createLogger } = require('./logger');

const logger = createLogger('TargetRegistry', 'targetRegistry.js');

async function listTargets(appDataRoot) {
  return listBackupTargets(appDataRoot);
}

async function addTarget(appDataRoot, targetPath, now = new Date()) {
  const added = await addBackupTarget(appDataRoot, targetPath, now);
  const machine = await loadBackupMachine(appDataRoot);
  const sources = await listTargetBackupSources(appDataRoot, added.path, now).catch(() => []);
  await ensureCatalog(added.path, {
    appDataRoot,
    sources,
    computer: machine,
    now
  });
  return added;
}

async function removeTarget(appDataRoot, targetId, now = new Date()) {
  const targets = await listBackupTargets(appDataRoot);
  const target = (targets || []).find((entry) => entry.id === targetId);
  if (target) {
    const sources = await listTargetBackupSources(appDataRoot, target.path, now).catch(() => []);
    for (const source of sources) {
      await cleanupSourceRegistrations(appDataRoot, source);
    }
    try {
      await clearCatalog(target.path);
    } catch (error) {
      logger.warn('Failed to remove target catalog; continuing with local unregister.', {
        targetId,
        targetRoot: target.path,
        error: error && error.message ? error.message : String(error)
      });
    }
  }
  await removeBackupTarget(appDataRoot, targetId, now);
}

async function setTargetCollapsed(appDataRoot, targetId, collapsed, now = new Date()) {
  await setBackupTargetCollapsed(appDataRoot, targetId, collapsed, now);
}

async function requireRegisteredTarget(appDataRoot, targetRoot) {
  return requireBackupTarget(appDataRoot, targetRoot);
}

module.exports = {
  addTarget,
  listTargets,
  normalizeTargets,
  removeTarget,
  requireRegisteredTarget,
  setTargetCollapsed
};
