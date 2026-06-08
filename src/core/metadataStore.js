const fs = require('fs-extra');
const { hashPath, tempRoot } = require('./layout');
const {
  deleteHashRecord,
  listHashRecords,
  loadHashRecord,
  saveHashRecord
} = require('./hashBucketStore');

function getTempRoot(targetRoot) {
  return tempRoot(targetRoot);
}

module.exports = {
  getTempRoot,
  hashPath,
  listHashRecords,
  loadHashRecord,
  saveHashRecord,
  deleteHashRecord
};
