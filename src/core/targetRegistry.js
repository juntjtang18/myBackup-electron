const {
  addBackupTarget,
  listBackupTargets,
  removeBackupTarget,
  requireBackupTarget,
  setBackupTargetCollapsed
} = require('./backupSchema');
const { normalizeTargets } = require('./targetConfig');

async function listTargets(appDataRoot) {
  return listBackupTargets(appDataRoot);
}

async function addTarget(appDataRoot, targetPath, now = new Date()) {
  return addBackupTarget(appDataRoot, targetPath, now);
}

async function removeTarget(appDataRoot, targetId, now = new Date()) {
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
