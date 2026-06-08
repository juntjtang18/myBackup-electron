const path = require('path');
const { createFolderId } = require('../ids');

function normalizeRelativePath(relativePath) {
  if (!relativePath || relativePath === '.') {
    return '.';
  }
  return String(relativePath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
}

function createFolderHash(relativePath) {
  return createFolderId(normalizeRelativePath(relativePath));
}

function createCursor(input = {}, now = new Date()) {
  const relativePath = normalizeRelativePath(input.relativePath);
  const updatedAt = input.updatedAt || now;
  return {
    scanId: input.scanId || input.backupId || null,
    folderHash: input.folderHash || createFolderHash(relativePath),
    relativePath,
    updatedAt: updatedAt.toISOString ? updatedAt.toISOString() : updatedAt
  };
}

function normalizeCursor(cursor) {
  if (!cursor) {
    return null;
  }
  return createCursor(cursor, cursor.updatedAt || new Date());
}

function hydrateCursor(sourcePath, cursor) {
  const normalized = normalizeCursor(cursor);
  if (!normalized) {
    return null;
  }
  return {
    ...normalized,
    folderPath: normalized.relativePath === '.'
      ? path.resolve(sourcePath)
      : path.join(path.resolve(sourcePath), ...normalized.relativePath.split('/'))
  };
}

function cursorMatchesFolder(cursor, folder) {
  if (!cursor || !folder) {
    return false;
  }
  const relativePath = normalizeRelativePath(folder.relativePath);
  return normalizeRelativePath(cursor.relativePath) === relativePath
    && cursor.folderHash === createFolderHash(relativePath);
}

module.exports = {
  createCursor,
  createFolderHash,
  cursorMatchesFolder,
  hydrateCursor,
  normalizeCursor,
  normalizeRelativePath
};
