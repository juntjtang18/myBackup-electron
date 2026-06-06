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

function createResumeCursor(input = {}, now = new Date()) {
  const relativePath = normalizeRelativePath(input.relativePath);
  const updatedAt = input.updatedAt || now;
  return {
    scanId: input.scanId || input.backupId || null,
    folderHash: input.folderHash || createFolderHash(relativePath),
    relativePath,
    folderPath: path.resolve(input.folderPath || '.'),
    status: input.status || 'scanning',
    updatedAt: updatedAt.toISOString ? updatedAt.toISOString() : updatedAt
  };
}

function normalizeResumeCursor(cursor) {
  if (!cursor) {
    return null;
  }
  return createResumeCursor(cursor, cursor.updatedAt || new Date());
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
  createFolderHash,
  createResumeCursor,
  cursorMatchesFolder,
  normalizeResumeCursor,
  normalizeRelativePath
};
