const {
  deleteHashRecord,
  listHashRecords,
  loadHashRecord,
  saveHashRecord
} = require('./hashBucketStore');

async function deleteFileIndexRecord(targetRoot, fileHash) {
  return deleteHashRecord(targetRoot, fileHash);
}

async function listFileIndexRecords(targetRoot) {
  return listHashRecords(targetRoot);
}

async function loadFileIndexRecord(targetRoot, fileHash) {
  return loadHashRecord(targetRoot, fileHash);
}

async function saveFileIndexRecord(targetRoot, record) {
  return saveHashRecord(targetRoot, record);
}

module.exports = {
  deleteFileIndexRecord,
  listFileIndexRecords,
  loadFileIndexRecord,
  saveFileIndexRecord
};
