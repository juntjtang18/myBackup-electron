const path = require('path');
const { metadataRoot } = require('./layout');

const SEGMENT_LENGTH = 3;
const BUCKET_SEGMENT_COUNT = 5;
const BUCKET_PREFIX_LENGTH = SEGMENT_LENGTH * BUCKET_SEGMENT_COUNT;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function normalizeHash(fileHash) {
  const normalized = String(fileHash || '').toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new Error('Invalid file hash.');
  }

  return normalized;
}

function bucketPrefix(fileHash) {
  return normalizeHash(fileHash).slice(0, BUCKET_PREFIX_LENGTH);
}

function bucketKey(fileHash) {
  return bucketPrefix(fileHash);
}

function recordSuffix(fileHash) {
  return normalizeHash(fileHash).slice(BUCKET_PREFIX_LENGTH);
}

function rebuildHash(prefix, suffix) {
  return `${prefix}${suffix}`;
}

function bucketPath(targetRoot, fileHash) {
  const prefix = bucketPrefix(fileHash);
  const segments = [];
  for (let index = 0; index < BUCKET_SEGMENT_COUNT; index += 1) {
    segments.push(prefix.slice(index * SEGMENT_LENGTH, (index + 1) * SEGMENT_LENGTH));
  }

  return path.join(
    metadataRoot(targetRoot),
    'hashes',
    segments[0],
    segments[1],
    segments[2],
    segments[3],
    `${segments[4]}.indx`
  );
}

function sampleHashForBucket(prefix) {
  return `${prefix}${'0'.repeat(64 - prefix.length)}`;
}

module.exports = {
  BUCKET_PREFIX_LENGTH,
  BUCKET_SEGMENT_COUNT,
  SEGMENT_LENGTH,
  bucketKey,
  bucketPath,
  bucketPrefix,
  rebuildHash,
  recordSuffix,
  sampleHashForBucket
};
