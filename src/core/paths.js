const path = require('path');

const APP_METADATA_ROOT = 'data';
const TARGET_METADATA_ROOT = '.mybackup';
const TARGET_SOURCES_FILE = 'backup_source.json';
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
  return resolveAppDataRoot(appDataRoot);
}

function backupSchemaPath(appDataRoot) {
  return path.join(appMetadataRoot(appDataRoot), 'backup_target.json');
}

function watchStateRoot(appDataRoot) {
  return path.join(appMetadataRoot(appDataRoot), 'watch');
}

function dirtyStatePath(appDataRoot, dirtyRefOrSourceId) {
  const reference = String(dirtyRefOrSourceId || '').trim();
  if (!reference) {
    throw new Error('dirty state reference is required.');
  }
  const relativePath = reference.endsWith('.json')
    ? reference
    : path.join('watch', `${reference}.dirty.json`);
  return path.join(appMetadataRoot(appDataRoot), relativePath);
}

function runStateRoot(appDataRoot) {
  return path.join(appMetadataRoot(appDataRoot), 'run');
}

function runStatePath(appDataRoot, targetId, sourceId) {
  const normalizedTargetId = String(targetId || '').trim();
  const normalizedSourceId = String(sourceId || '').trim();
  if (!normalizedTargetId) {
    throw new Error('targetId is required.');
  }
  if (!normalizedSourceId) {
    throw new Error('sourceId is required.');
  }
  return path.join(runStateRoot(appDataRoot), normalizedTargetId, `${normalizedSourceId}.run.json`);
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
  return path.join(targetMetadataRoot(targetRoot), TARGET_SOURCES_FILE);
}

function legacyBackupSourcesPath(targetRoot) {
  return path.join(resolveTargetRoot(targetRoot), '.backup_source.json');
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

function fileIndexRoot(targetRoot) {
  return path.join(targetMetadataRoot(targetRoot), 'index');
}

function legacyFileIndexRoot(targetRoot) {
  return path.join(targetMetadataRoot(targetRoot), 'hashes');
}

function fileIndexBucketPath(targetRoot, ...segments) {
  return path.join(fileIndexRoot(targetRoot), ...segments);
}

function legacyHashRecordPath(targetRoot, fileHash) {
  return path.join(legacyFileIndexRoot(targetRoot), fileHash.slice(0, 2), fileHash.slice(2, 4), `${fileHash}.json`);
}

function hashPath(targetRoot, fileHash) {
  return fileIndexBucketPath(targetRoot, fileHash.slice(0, 2), fileHash.slice(2, 4), `${fileHash}.json`);
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
  dirtyStatePath,
  schemaMigrationMarkerPath,
  configPath,
  errorReportPath,
  fileIndexBucketPath,
  fileIndexRoot,
  hashPath,
  legacyBackupSourcesPath,
  legacyFileIndexRoot,
  legacyHashRecordPath,
  legacyLocalConfigPath,
  localConfigPath,
  machineBackupRoot,
  machinePath,
  mediaRoot,
  mergedBackupRoot,
  resolveAppDataRoot,
  resolveTargetRoot,
  runStatePath,
  runStateRoot,
  scanCurrentPath,
  sourcePath,
  targetMetadataRoot,
  tempRoot,
  toPosixPath,
  watchStateRoot
};
