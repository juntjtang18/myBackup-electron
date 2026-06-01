const {
  configPath,
  folderCheckpointPath,
  hashPath,
  machinePath,
  scanCurrentPath,
  sourcePath,
  tempRoot
} = require('./layout');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const {
  validateAppConfig,
  validateFolderCheckpoint,
  validateHashRecord,
  validateMachineRecord,
  validateScanState,
  validateSourceRecord
} = require('./schema');

async function loadAppConfig(targetRoot) {
  return readJsonIfExists(configPath(targetRoot), validateAppConfig);
}

async function saveAppConfig(targetRoot, document) {
  validateAppConfig(document);
  await writeJsonAtomic(configPath(targetRoot), document);
}

async function loadMachine(targetRoot, machineId) {
  return readJsonIfExists(machinePath(targetRoot, machineId), validateMachineRecord);
}

async function saveMachine(targetRoot, document) {
  validateMachineRecord(document);
  await writeJsonAtomic(machinePath(targetRoot, document.machineId), document);
}

async function loadSource(targetRoot, machineId, sourceId) {
  return readJsonIfExists(sourcePath(targetRoot, machineId, sourceId), validateSourceRecord);
}

async function saveSource(targetRoot, document) {
  validateSourceRecord(document);
  await writeJsonAtomic(sourcePath(targetRoot, document.machineId, document.sourceId), document);
}

async function loadHashRecord(targetRoot, fileHash) {
  return readJsonIfExists(hashPath(targetRoot, fileHash), validateHashRecord);
}

async function saveHashRecord(targetRoot, document) {
  validateHashRecord(document);
  await writeJsonAtomic(hashPath(targetRoot, document.fileHash), document);
}

async function loadScanState(targetRoot, machineId, sourceId) {
  return readJsonIfExists(scanCurrentPath(targetRoot, machineId, sourceId), validateScanState);
}

async function saveScanState(targetRoot, document) {
  validateScanState(document);
  await writeJsonAtomic(scanCurrentPath(targetRoot, document.machineId, document.sourceId), document);
}

async function loadFolderCheckpoint(targetRoot, machineId, sourceId, scanId, folderId) {
  return readJsonIfExists(
    folderCheckpointPath(targetRoot, machineId, sourceId, scanId, folderId),
    validateFolderCheckpoint
  );
}

async function saveFolderCheckpoint(targetRoot, machineId, sourceId, scanId, document) {
  validateFolderCheckpoint(document);
  await writeJsonAtomic(
    folderCheckpointPath(targetRoot, machineId, sourceId, scanId, document.folderId),
    document
  );
}

function getTempRoot(targetRoot) {
  return tempRoot(targetRoot);
}

module.exports = {
  getTempRoot,
  loadAppConfig,
  loadFolderCheckpoint,
  loadHashRecord,
  loadMachine,
  loadScanState,
  loadSource,
  saveAppConfig,
  saveFolderCheckpoint,
  saveHashRecord,
  saveMachine,
  saveScanState,
  saveSource
};
