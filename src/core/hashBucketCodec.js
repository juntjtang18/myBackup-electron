const { SCHEMA_VERSION, validateHashRecord } = require('./schema');
const {
  packContent,
  unpackContent,
  packOrigin,
  unpackOrigin
} = require('./hashRecordCodec');
const { BUCKET_PREFIX_LENGTH, bucketPrefix, rebuildHash, recordSuffix } = require('./hashBucketLayout');

function packBucketRecord(record) {
  validateHashRecord(record);

  return [
    recordSuffix(record.fileHash),
    [
      record.size,
      record.logicalPath,
      record.aliases,
      record.kind || 'file',
      packContent(record.content),
      record.origins.map(packOrigin),
      record.createdAt,
      record.updatedAt
    ]
  ];
}

function unpackBucketRecord(prefix, suffix, payload) {
  if (!Array.isArray(payload) || payload.length < 8) {
    throw new Error('Invalid bucket hash record payload.');
  }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    fileHash: rebuildHash(prefix, suffix),
    size: payload[0],
    logicalPath: payload[1],
    aliases: Array.isArray(payload[2]) ? payload[2] : [],
    kind: payload[3] || 'file',
    content: unpackContent(payload[4]),
    origins: Array.isArray(payload[5]) ? payload[5].map(unpackOrigin) : [],
    createdAt: payload[6],
    updatedAt: payload[7]
  };

  return validateHashRecord(record);
}

function packBucketDocument(prefix, records) {
  return {
    v: SCHEMA_VERSION,
    p: prefix,
    r: records.map(packBucketRecord)
  };
}

function unpackBucketDocument(document) {
  if (!document || typeof document !== 'object') {
    throw new Error('hash bucket must be an object.');
  }

  if (document.v !== SCHEMA_VERSION) {
    throw new Error(`Unsupported hash bucket schema version: ${document.v}`);
  }

  const prefix = String(document.p || '').toLowerCase();
  if (prefix.length !== BUCKET_PREFIX_LENGTH) {
    throw new Error('Invalid hash bucket prefix.');
  }

  const records = new Map();
  for (const row of document.r || []) {
    if (!Array.isArray(row) || row.length < 2) {
      continue;
    }

    const record = unpackBucketRecord(prefix, String(row[0]).toLowerCase(), row[1]);
    records.set(recordSuffix(record.fileHash), record);
  }

  return {
    prefix,
    records
  };
}

module.exports = {
  packBucketDocument,
  packBucketRecord,
  unpackBucketDocument,
  unpackBucketRecord
};
