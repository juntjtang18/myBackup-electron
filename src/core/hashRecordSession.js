const fs = require('fs-extra');
const { hashPath, legacyHashRecordPath } = require('./layout');
const {
  bucketKey,
  loadHashBucket,
  readLegacyHashRecord,
  saveHashBucket
} = require('./hashBucketStore');
const { recordSuffix } = require('./hashBucketLayout');
const { applyHashRecordRegistration, applyHashRecordUnregister, withRecordLock } = require('./hashIndex');
const { createLogger } = require('./logger');

const logger = createLogger('HashRecordSession', 'hashRecordSession.js');

function createHashRecordSession(targetRoot) {
  const bucketCache = new Map();
  let flushCount = 0;

  async function ensureBucket(fileHash) {
    const key = bucketKey(fileHash);
    const cached = bucketCache.get(key);
    if (cached) {
      return cached;
    }

    const loaded = await loadHashBucket(targetRoot, fileHash);
    const bucket = {
      prefix: loaded.prefix,
      records: loaded.records,
      dirty: false,
      legacyDeletes: new Set()
    };
    bucketCache.set(key, bucket);
    return bucket;
  }

  async function lookup(fileHash) {
    const bucket = await ensureBucket(fileHash);
    const suffix = recordSuffix(fileHash);
    const cached = bucket.records.get(suffix);
    if (cached) {
      return cached;
    }

    const legacy = await readLegacyHashRecord(targetRoot, fileHash);
    if (!legacy) {
      return null;
    }

    bucket.records.set(suffix, legacy);
    bucket.dirty = true;
    bucket.legacyDeletes.add(fileHash);
    return legacy;
  }

  async function register(input, now = new Date()) {
    return withRecordLock(input.fileHash, async () => {
      const bucket = await ensureBucket(input.fileHash);
      const suffix = recordSuffix(input.fileHash);
      const existing = bucket.records.get(suffix) || null;
      const result = applyHashRecordRegistration(existing, input, now);

      if (result.status === 'deleted') {
        bucket.records.delete(suffix);
        bucket.dirty = true;
        bucket.legacyDeletes.add(input.fileHash);
        return result;
      }

      bucket.records.set(suffix, result.record);
      if (result.status !== 'unchanged') {
        bucket.dirty = true;
      }

      return result;
    });
  }

  async function unregister(input, now = new Date()) {
    return withRecordLock(input.fileHash, async () => {
      const bucket = await ensureBucket(input.fileHash);
      const suffix = recordSuffix(input.fileHash);
      const existing = bucket.records.get(suffix) || null;
      const result = applyHashRecordUnregister(existing, input, now);

      if (result.status === 'deleted') {
        bucket.records.delete(suffix);
        bucket.dirty = true;
        bucket.legacyDeletes.add(input.fileHash);
        return result;
      }

      if (result.record) {
        bucket.records.set(suffix, result.record);
        bucket.dirty = true;
      }

      return result;
    });
  }

  async function flush() {
    let writes = 0;
    let deletes = 0;

    for (const bucket of bucketCache.values()) {
      if (bucket.dirty) {
        await saveHashBucket(targetRoot, bucket);
        bucket.dirty = false;
        writes += 1;
      }

      if (bucket.legacyDeletes.size > 0) {
        await Promise.all(Array.from(bucket.legacyDeletes).map((fileHash) => (
          Promise.allSettled([
            fs.remove(hashPath(targetRoot, fileHash)),
            fs.remove(legacyHashRecordPath(targetRoot, fileHash))
          ]).then(() => {
            deletes += 1;
          })
        )));
        bucket.legacyDeletes.clear();
      }
    }

    if (writes > 0 || deletes > 0) {
      flushCount += 1;
      logger.debug('Flushed hash bucket session.', {
        bucketsWritten: writes,
        legacyDeletes: deletes,
        bucketsCached: bucketCache.size
      });
    }

    return {
      writes,
      deletes
    };
  }

  function snapshot() {
    let recordCount = 0;
    let dirtyBuckets = 0;
    for (const bucket of bucketCache.values()) {
      recordCount += bucket.records.size;
      if (bucket.dirty) {
        dirtyBuckets += 1;
      }
    }

    return {
      bucketCount: bucketCache.size,
      recordCount,
      dirtyBuckets,
      flushCount
    };
  }

  return {
    lookup,
    register,
    unregister,
    flush,
    snapshot
  };
}

module.exports = {
  createHashRecordSession
};
