const path = require('path');
const { readJsonIfExists, writeJsonAtomic } = require('../jsonStore');
const { createFolderHash, normalizeRelativePath } = require('./resumeCursor');
const { resumeFolderProgressPath } = require('./resumePaths');

const FOLDER_PROGRESS_VERSION = 1;

function createFolderProgress(input = {}, now = new Date()) {
  const relativePath = normalizeRelativePath(input.relativePath);
  return {
    version: FOLDER_PROGRESS_VERSION,
    backupId: input.backupId,
    folderHash: input.folderHash || createFolderHash(relativePath),
    parentHash: input.parentHash || null,
    relativePath,
    folderPath: path.resolve(input.folderPath || '.'),
    status: input.status || 'pending',
    filesSeen: input.filesSeen || 0,
    filesDone: input.filesDone || 0,
    childrenSeen: input.childrenSeen || 0,
    childrenDone: input.childrenDone || 0,
    updatedAt: (input.updatedAt || now).toISOString
      ? (input.updatedAt || now).toISOString()
      : input.updatedAt || now.toISOString()
  };
}

function validateFolderProgress(document) {
  if (!document || document.version !== FOLDER_PROGRESS_VERSION) {
    throw new Error('Unsupported resume folder progress version.');
  }
  if (!document.backupId || !document.folderHash || !document.relativePath) {
    throw new Error('Invalid resume folder progress.');
  }
  return document;
}

async function loadFolderProgress(targetRoot, machineId, sourceId, backupId, folderHash) {
  return readJsonIfExists(
    resumeFolderProgressPath(targetRoot, machineId, sourceId, backupId, folderHash),
    validateFolderProgress
  );
}

async function saveFolderProgress(targetRoot, machineId, sourceId, progress) {
  validateFolderProgress(progress);
  await writeJsonAtomic(
    resumeFolderProgressPath(targetRoot, machineId, sourceId, progress.backupId, progress.folderHash),
    progress
  );
  return progress;
}

module.exports = {
  FOLDER_PROGRESS_VERSION,
  createFolderProgress,
  loadFolderProgress,
  saveFolderProgress,
  validateFolderProgress
};
