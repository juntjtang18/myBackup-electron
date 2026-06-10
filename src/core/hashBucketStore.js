const fs = require('fs-extra');
const path = require('path');
const { fileIndexRoot, hashPath, legacyFileIndexRoot, legacyHashRecordPath } = require('./paths');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { unpackHashRecord } = require('./hashRecordCodec');
const {
  bucketKey,
  bucketPath,
  bucketPrefix,
  currentLegacyBucketPath,
  legacyBucketPath,
  recordSuffix,
  sampleHashForBucket
} = require('./hashBucketLayout');
const { packBucketDocument, unpackBucketDocument } = require('./hashBucketCodec');

function createEmptyBucket(prefix) {
  return {
    prefix,
    records: new Map()
  };
}

async function readLegacyHashRecord(targetRoot, fileHash) {
  const document = await readJsonIfExists(hashPath(targetRoot, fileHash))
    || await readJsonIfExists(legacyHashRecordPath(targetRoot, fileHash));
  if (!document) {
    return null;
  }

  return unpackHashRecord(document);
}

async function loadHashBucket(targetRoot, fileHash) {
  const prefix = bucketPrefix(fileHash);
  const document = await readJsonIfExists(bucketPath(targetRoot, fileHash))
    || await readJsonIfExists(currentLegacyBucketPath(targetRoot, fileHash))
    || await readJsonIfExists(legacyBucketPath(targetRoot, fileHash));
  if (!document) {
    return createEmptyBucket(prefix);
  }

  return unpackBucketDocument(document);
}

async function saveHashBucket(targetRoot, bucket) {
  const bucketFilePath = bucketPath(targetRoot, sampleHashForBucket(bucket.prefix));
  const currentLegacyBucketFilePath = currentLegacyBucketPath(targetRoot, sampleHashForBucket(bucket.prefix));
  const oldBucketFilePath = legacyBucketPath(targetRoot, sampleHashForBucket(bucket.prefix));

  if (bucket.records.size === 0) {
    if (await fs.pathExists(bucketFilePath)) {
      await fs.remove(bucketFilePath);
    }
    if (await fs.pathExists(currentLegacyBucketFilePath)) {
      await fs.remove(currentLegacyBucketFilePath);
    }
    if (await fs.pathExists(oldBucketFilePath)) {
      await fs.remove(oldBucketFilePath);
    }
    return;
  }

  const packed = packBucketDocument(
    bucket.prefix,
    Array.from(bucket.records.values())
  );
  await writeJsonAtomic(bucketFilePath, packed, { compact: true });
  if (await fs.pathExists(currentLegacyBucketFilePath)) {
    await fs.remove(currentLegacyBucketFilePath);
  }
  if (await fs.pathExists(oldBucketFilePath)) {
    await fs.remove(oldBucketFilePath);
  }
}

async function loadHashRecord(targetRoot, fileHash) {
  const bucket = await loadHashBucket(targetRoot, fileHash);
  const suffix = recordSuffix(fileHash);
  const fromBucket = bucket.records.get(suffix);
  if (fromBucket) {
    return fromBucket;
  }

  return readLegacyHashRecord(targetRoot, fileHash);
}

async function saveHashRecord(targetRoot, record) {
  const bucket = await loadHashBucket(targetRoot, record.fileHash);
  bucket.records.set(recordSuffix(record.fileHash), record);
  await saveHashBucket(targetRoot, bucket);
  if (await fs.pathExists(hashPath(targetRoot, record.fileHash))) {
    await fs.remove(hashPath(targetRoot, record.fileHash));
  }
  if (await fs.pathExists(legacyHashRecordPath(targetRoot, record.fileHash))) {
    await fs.remove(legacyHashRecordPath(targetRoot, record.fileHash));
  }
}

async function deleteHashRecord(targetRoot, fileHash) {
  const bucket = await loadHashBucket(targetRoot, fileHash);
  const suffix = recordSuffix(fileHash);
  bucket.records.delete(suffix);
  await saveHashBucket(targetRoot, bucket);
  await fs.remove(hashPath(targetRoot, fileHash));
  await fs.remove(legacyHashRecordPath(targetRoot, fileHash));
}

async function listHashRecords(targetRoot) {
  const records = [];
  const seen = new Set();
  const roots = [];
  const currentRoot = fileIndexRoot(targetRoot);
  const legacyRoot = legacyFileIndexRoot(targetRoot);

  if (await fs.pathExists(currentRoot)) {
    roots.push(currentRoot);
  }
  if (legacyRoot !== currentRoot && await fs.pathExists(legacyRoot)) {
    roots.push(legacyRoot);
  }
  if (roots.length === 0) {
    return [];
  }

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.endsWith('.index') || entry.name.endsWith('.indx')) {
        const document = await readJsonIfExists(entryPath);
        if (!document) {
          continue;
        }

        const bucket = unpackBucketDocument(document);
        for (const record of bucket.records.values()) {
          if (!seen.has(record.fileHash)) {
            seen.add(record.fileHash);
            records.push(record);
          }
        }
        continue;
      }

      if (!entry.name.endsWith('.json')) {
        continue;
      }

      const fileHash = path.basename(entry.name, '.json');
      if (seen.has(fileHash)) {
        continue;
      }

      const record = await readLegacyHashRecord(targetRoot, fileHash);
      if (record) {
        seen.add(record.fileHash);
        records.push(record);
      }
    }
  }

  for (const root of roots) {
    await walk(root);
  }
  records.sort((left, right) => left.fileHash.localeCompare(right.fileHash));
  return records;
}

module.exports = {
  bucketKey,
  createEmptyBucket,
  deleteHashRecord,
  listHashRecords,
  loadHashBucket,
  loadHashRecord,
  readLegacyHashRecord,
  saveHashBucket,
  saveHashRecord
};
