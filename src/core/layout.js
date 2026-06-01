const path = require('path');

const METADATA_ROOT = '.mybackup';
const BACKUPS_ROOT = 'Backups';
const BACKUPS_MACHINES_ROOT = path.posix.join(BACKUPS_ROOT, 'Machines');
const BACKUPS_MERGED_ROOT = path.posix.join(BACKUPS_ROOT, 'Merged');
const IMAGES_ROOT = 'Images';
const VIDEOS_ROOT = 'Videos';

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function resolveTargetRoot(targetRoot) {
  return path.resolve(targetRoot);
}

function metadataRoot(targetRoot) {
  return path.join(resolveTargetRoot(targetRoot), METADATA_ROOT);
}

function configPath(targetRoot) {
  return path.join(metadataRoot(targetRoot), 'config.json');
}

function machinePath(targetRoot, machineId) {
  return path.join(metadataRoot(targetRoot), 'machines', `${machineId}.json`);
}

function sourcePath(targetRoot, machineId, sourceId) {
  return path.join(metadataRoot(targetRoot), 'sources', machineId, `${sourceId}.json`);
}

function hashPath(targetRoot, fileHash) {
  return path.join(metadataRoot(targetRoot), 'hashes', fileHash.slice(0, 2), fileHash.slice(2, 4), `${fileHash}.json`);
}

function scanCurrentPath(targetRoot, machineId, sourceId) {
  return path.join(metadataRoot(targetRoot), 'scans', machineId, sourceId, 'current.json');
}

function scanGenerationRoot(targetRoot, machineId, sourceId, scanId) {
  return path.join(metadataRoot(targetRoot), 'scans', machineId, sourceId, 'generations', scanId);
}

function folderCheckpointPath(targetRoot, machineId, sourceId, scanId, folderId) {
  return path.join(scanGenerationRoot(targetRoot, machineId, sourceId, scanId), 'folders', `${folderId}.json`);
}

function tempRoot(targetRoot) {
  return path.join(metadataRoot(targetRoot), 'tmp');
}

function machineBackupRoot(machineId, sourceId) {
  return path.posix.join(BACKUPS_MACHINES_ROOT, machineId, sourceId);
}

function mergedBackupRoot(mergeKey) {
  return path.posix.join(BACKUPS_MERGED_ROOT, mergeKey);
}

function mediaRoot(kind, year, day, tail) {
  const topLevel = kind === 'video' ? VIDEOS_ROOT : IMAGES_ROOT;
  return path.posix.join(topLevel, year, day, tail);
}

module.exports = {
  BACKUPS_MACHINES_ROOT,
  BACKUPS_MERGED_ROOT,
  BACKUPS_ROOT,
  IMAGES_ROOT,
  METADATA_ROOT,
  VIDEOS_ROOT,
  configPath,
  folderCheckpointPath,
  hashPath,
  machineBackupRoot,
  machinePath,
  mediaRoot,
  mergedBackupRoot,
  metadataRoot,
  resolveTargetRoot,
  scanCurrentPath,
  scanGenerationRoot,
  sourcePath,
  tempRoot,
  toPosixPath
};
