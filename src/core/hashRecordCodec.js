const { SCHEMA_VERSION, validateHashRecord } = require('./schema');
const { toPosixPath } = require('./layout');

function packContent(content) {
  if (!content || content.type === 'plain') {
    return ['p', toPosixPath(content?.path || '')];
  }

  return ['b', toPosixPath(content.manifest || '')];
}

function unpackContent(compact) {
  if (!Array.isArray(compact) || compact.length < 2) {
    throw new Error('Invalid compact hash record content.');
  }

  if (compact[0] === 'p') {
    return {
      type: 'plain',
      path: toPosixPath(compact[1])
    };
  }

  if (compact[0] === 'b') {
    return {
      type: 'blocks',
      manifest: toPosixPath(compact[1])
    };
  }

  throw new Error(`Unsupported compact content type: ${compact[0]}`);
}

function packOrigin(origin) {
  return [
    origin.machineId,
    origin.sourceId,
    toPosixPath(origin.sourceRelativePath || ''),
    origin.discoveredAt
  ];
}

function unpackOrigin(entry) {
  if (Array.isArray(entry)) {
    return {
      machineId: entry[0],
      sourceId: entry[1],
      sourceRelativePath: toPosixPath(entry[2] || ''),
      discoveredAt: entry[3]
    };
  }

  return {
    machineId: entry.machineId,
    sourceId: entry.sourceId,
    sourceRelativePath: toPosixPath(entry.sourceRelativePath || ''),
    discoveredAt: entry.discoveredAt
  };
}

function isCompactRecord(document) {
  return Boolean(document && typeof document === 'object' && typeof document.h === 'string');
}

function isLegacyRecord(document) {
  return Boolean(document && typeof document === 'object' && typeof document.fileHash === 'string');
}

function packHashRecord(record) {
  validateHashRecord(record);

  return {
    v: SCHEMA_VERSION,
    h: record.fileHash,
    s: record.size,
    p: toPosixPath(record.logicalPath || ''),
    a: record.aliases.map((entry) => toPosixPath(entry)),
    k: record.kind || 'file',
    c: packContent(record.content),
    o: record.origins.map(packOrigin),
    ca: record.createdAt,
    ua: record.updatedAt
  };
}

function unpackHashRecord(document) {
  if (!document || typeof document !== 'object') {
    throw new Error('hash record must be an object.');
  }

  if (isLegacyRecord(document)) {
    return validateHashRecord(document);
  }

  if (!isCompactRecord(document)) {
    throw new Error('Unsupported hash record format.');
  }

  if (document.v !== SCHEMA_VERSION) {
    throw new Error(`Unsupported hash schema version: ${document.v}`);
  }

  const record = {
    schemaVersion: document.v,
    fileHash: document.h,
    size: document.s,
    logicalPath: toPosixPath(document.p || ''),
    aliases: Array.isArray(document.a) ? document.a.map((entry) => toPosixPath(entry)) : [],
    kind: document.k || 'file',
    content: unpackContent(document.c),
    origins: Array.isArray(document.o) ? document.o.map(unpackOrigin) : [],
    createdAt: document.ca,
    updatedAt: document.ua
  };

  return validateHashRecord(record);
}

module.exports = {
  isCompactRecord,
  isLegacyRecord,
  packContent,
  packHashRecord,
  packOrigin,
  unpackContent,
  unpackHashRecord,
  unpackOrigin
};
