const path = require('path');

const APP_METADATA_ROOT = '.mybackup';
const TARGET_METADATA_ROOT = '.mybackup';
const TARGET_SOURCES_FILE = '.backup_source.json';
const BACKUPS_ROOT = 'Backups';
const BACKUPS_MACHINES_ROOT = path.posix.join(BACKUPS_ROOT, 'Machines');
const IMAGES_ROOT = 'Images';
const VIDEOS_ROOT = 'Videos';

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function resolveAppDataRoot(appDataRoot) {
  return path.resolve(appDataRoot);
}

function appMetadataRoot(appDataRoot) {
  return path.join(resolveAppDataRoot(appDataRoot), APP_METADATA_ROOT);
}

function backupSchemaPath(appDataRoot) {
  return path.join(appMetadataRoot(appDataRoot), 'schema.json');
}

function schemaMigrationMarkerPath(appDataRoot) {
  return path.join(appMetadataRoot(appDataRoot), 'schema-migration.json');
}

function localConfigPath(appDataRoot) {
  return path.join(appMetadataRoot(appDataRoot), 'local-config.json');
}

function legacyLocalConfigPath(appDataRoot) {
  return path.join(resolveAppDataRoot(appDataRoot), 'mybackup-ui.json');
}

function resolveTargetRoot(targetRoot) {
  return path.resolve(targetRoot);
}

function backupSourcesPath(targetRoot) {
  return path.join(resolveTargetRoot(targetRoot), TARGET_SOURCES_FILE);
}

function targetMetadataRoot(targetRoot) {
  return path.join(resolveTargetRoot(targetRoot), TARGET_METADATA_ROOT);
}

function configPath(targetRoot) {
  return path.join(targetMetadataRoot(targetRoot), 'config.json');
}

function machinePath(targetRoot, machineId) {
  return path.join(targetMetadataRoot(targetRoot), 'machines', `${machineId}.json`);
}

function sourcePath(targetRoot, machineId, sourceId) {
  return path.join(targetMetadataRoot(targetRoot), 'sources', machineId, `${sourceId}.json`);
}

function sourceSnapshotPath(targetRoot, machineId, sourceId) {
  return path.join(targetMetadataRoot(targetRoot), 'source-state', machineId, `${sourceId}.json`);
}

function fileIndexRoot(targetRoot) {
  return path.join(targetMetadataRoot(targetRoot), 'hashes');
}

function fileIndexBucketPath(targetRoot, ...segments) {
  return path.join(fileIndexRoot(targetRoot), ...segments);
}

function legacyHashRecordPath(targetRoot, fileHash) {
  return fileIndexBucketPath(targetRoot, fileHash.slice(0, 2), fileHash.slice(2, 4), `${fileHash}.json`);
}

function hashPath(targetRoot, fileHash) {
  return legacyHashRecordPath(targetRoot, fileHash);
}

function scanCurrentPath(targetRoot, machineId, sourceId) {
  return path.join(targetMetadataRoot(targetRoot), 'scans', machineId, sourceId, 'current.json');
}

function errorReportPath(targetRoot, machineId, sourceId, scanId) {
  return path.join(targetMetadataRoot(targetRoot), 'reports', machineId, sourceId, `${scanId}.jsonl`);
}

function tempRoot(targetRoot) {
  return path.join(targetMetadataRoot(targetRoot), 'tmp');
}

function machineBackupRoot(machineId, sourceId) {
  return path.posix.join(BACKUPS_MACHINES_ROOT, machineId, sourceId);
}

function mergedBackupRoot(mergeKey) {
  return toPosixPath(mergeKey);
}

function mediaRoot(kind, year, day, tail) {
  const topLevel = kind === 'video' ? VIDEOS_ROOT : IMAGES_ROOT;
  return path.posix.join(topLevel, year, day, tail);
}

module.exports = {
  APP_METADATA_ROOT,
  BACKUPS_MACHINES_ROOT,
  BACKUPS_ROOT,
  IMAGES_ROOT,
  TARGET_SOURCES_FILE,
  TARGET_METADATA_ROOT,
  VIDEOS_ROOT,
  appMetadataRoot,
  backupSourcesPath,
  backupSchemaPath,
  schemaMigrationMarkerPath,
  configPath,
  errorReportPath,
  fileIndexBucketPath,
  fileIndexRoot,
  hashPath,
  legacyHashRecordPath,
  legacyLocalConfigPath,
  localConfigPath,
  machineBackupRoot,
  machinePath,
  mediaRoot,
  mergedBackupRoot,
  resolveAppDataRoot,
  resolveTargetRoot,
  scanCurrentPath,
  sourcePath,
  sourceSnapshotPath,
  targetMetadataRoot,
  tempRoot,
  toPosixPath
};
