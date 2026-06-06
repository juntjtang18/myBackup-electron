const path = require('path');
const { metadataRoot } = require('../layout');

function resumeRoot(targetRoot, machineId, sourceId) {
  return path.join(metadataRoot(targetRoot), 'resume', machineId, sourceId);
}

function resumeManifestPath(targetRoot, machineId, sourceId) {
  return path.join(resumeRoot(targetRoot, machineId, sourceId), 'manifest.json');
}

function resumeFolderProgressPath(targetRoot, machineId, sourceId, backupId, folderHash) {
  return path.join(resumeRoot(targetRoot, machineId, sourceId), backupId, 'folders', `${folderHash}.json`);
}

module.exports = {
  resumeFolderProgressPath,
  resumeManifestPath,
  resumeRoot
};
