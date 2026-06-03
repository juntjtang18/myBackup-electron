const crypto = require('crypto');
const path = require('path');

function createTargetId(targetPath) {
  return crypto.createHash('sha1').update(path.resolve(targetPath)).digest('hex').slice(0, 12);
}

function normalizeTargetEntry(entry) {
  if (!entry || !entry.path) {
    return null;
  }

  const resolvedPath = path.resolve(entry.path);
  return {
    id: entry.id || createTargetId(resolvedPath),
    path: resolvedPath,
    collapsed: Boolean(entry.collapsed),
    addedAt: entry.addedAt || null
  };
}

function normalizeTargets(config = {}) {
  if (Array.isArray(config.targets)) {
    return config.targets.map(normalizeTargetEntry).filter(Boolean);
  }

  if (config.targetRoot) {
    const resolvedPath = path.resolve(config.targetRoot);
    return [{
      id: createTargetId(resolvedPath),
      path: resolvedPath,
      collapsed: false,
      addedAt: config.updatedAt || null
    }];
  }

  return [];
}

module.exports = {
  createTargetId,
  normalizeTargetEntry,
  normalizeTargets
};
