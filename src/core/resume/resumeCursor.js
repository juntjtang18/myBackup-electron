const { createFolderId } = require('../ids');
const { toPosixPath } = require('../layout');

function createResumeCursor(input = {}, now = new Date()) {
  const relativePath = toPosixPath(input.relativePath || '.');
  return {
    scanId: input.scanId || null,
    folderHash: input.folderHash || createFolderId(relativePath),
    relativePath,
    folderPath: input.folderPath || null,
    nextChildIndex: typeof input.nextChildIndex === 'number' && input.nextChildIndex >= 0
      ? input.nextChildIndex
      : 0,
    updatedAt: input.updatedAt || now.toISOString()
  };
}

function normalizeResumeCursor(cursor) {
  if (!cursor) {
    return null;
  }

  return createResumeCursor(cursor, new Date(cursor.updatedAt || Date.now()));
}

module.exports = {
  createResumeCursor,
  normalizeResumeCursor
};
