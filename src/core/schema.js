const os = require('os');
const path = require('path');
const { createFolderId, createMachineId, createScanId, createSourceId, sanitizeSegment } = require('./ids');
const { machineBackupRoot, mergedBackupRoot, toPosixPath } = require('./layout');

const SCHEMA_VERSION = 1;
const FOLDER_STATUSES = new Set(['pending', 'scanning', 'done', 'failed']);
const CONTENT_TYPES = new Set(['plain', 'blocks']);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
}

function assertBoolean(value, fieldName) {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean.`);
  }
}

function assertArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }
}

function createAppConfig(overrides = {}, now = new Date()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    machineId: overrides.machineId || createMachineId(os.hostname(), `${os.hostname()}-${os.platform()}`),
    createdAt: overrides.createdAt || nowIso(now),
    updatedAt: overrides.updatedAt || nowIso(now)
  };
}

function createMachineRecord(input = {}, now = new Date()) {
  const hostname = input.hostname || os.hostname();
  const machineId = input.machineId || createMachineId(hostname, input.seed || `${hostname}-${os.platform()}`);

  return {
    schemaVersion: SCHEMA_VERSION,
    machineId,
    displayName: input.displayName || hostname,
    hostname,
    platform: input.platform || os.platform(),
    createdAt: input.createdAt || nowIso(now),
    updatedAt: input.updatedAt || nowIso(now)
  };
}

function createSourceRecord(input, now = new Date()) {
  assertNonEmptyString(input.machineId, 'machineId');
  assertNonEmptyString(input.sourcePath, 'sourcePath');

  const resolvedSourcePath = path.resolve(input.sourcePath);
  const sourceId = input.sourceId || createSourceId(resolvedSourcePath);
  const mergeEnabled = Boolean(input.mergeEnabled);
  const mergeKey = mergeEnabled ? sanitizeSegment(input.mergeKey || path.basename(resolvedSourcePath) || sourceId) : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    machineId: input.machineId,
    sourceId,
    sourcePath: resolvedSourcePath,
    organizeMedia: Boolean(input.organizeMedia),
    mergeEnabled,
    mergeKey,
    targetSubdir: mergeEnabled ? mergedBackupRoot(mergeKey) : machineBackupRoot(input.machineId, sourceId),
    lastCompletedScan: input.lastCompletedScan || null,
    lastCompletedAt: input.lastCompletedAt || null,
    createdAt: input.createdAt || nowIso(now),
    updatedAt: input.updatedAt || nowIso(now)
  };
}

function createFileContentRef(input) {
  assertNonEmptyString(input.type, 'content.type');
  if (!CONTENT_TYPES.has(input.type)) {
    throw new Error(`Unsupported content.type: ${input.type}`);
  }

  if (input.type === 'plain') {
    assertNonEmptyString(input.path, 'content.path');
    return {
      type: 'plain',
      path: toPosixPath(input.path)
    };
  }

  assertNonEmptyString(input.manifest, 'content.manifest');
  return {
    type: 'blocks',
    manifest: toPosixPath(input.manifest)
  };
}

function createHashRecord(input, now = new Date()) {
  assertNonEmptyString(input.fileHash, 'fileHash');
  if (typeof input.size !== 'number' || input.size < 0) {
    throw new Error('size must be a non-negative number.');
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    fileHash: input.fileHash,
    size: input.size,
    logicalPath: toPosixPath(input.logicalPath || ''),
    aliases: Array.from(new Set((input.aliases || []).map((entry) => toPosixPath(entry)).filter(Boolean))).sort(),
    kind: input.kind || 'file',
    content: createFileContentRef(input.content),
    origins: (input.origins || []).map((origin) => ({
      machineId: origin.machineId,
      sourceId: origin.sourceId,
      sourceRelativePath: toPosixPath(origin.sourceRelativePath || ''),
      discoveredAt: origin.discoveredAt || nowIso(now)
    })),
    createdAt: input.createdAt || nowIso(now),
    updatedAt: input.updatedAt || nowIso(now)
  };
}

function createScanState(input, now = new Date()) {
  assertNonEmptyString(input.machineId, 'machineId');
  assertNonEmptyString(input.sourceId, 'sourceId');
  const activeGeneration = input.activeGeneration || createScanId(now);

  return {
    schemaVersion: SCHEMA_VERSION,
    machineId: input.machineId,
    sourceId: input.sourceId,
    activeGeneration,
    status: input.status || 'running',
    resumeCursor: input.resumeCursor || null,
    startedAt: input.startedAt || nowIso(now),
    completedAt: input.completedAt || null,
    updatedAt: input.updatedAt || nowIso(now)
  };
}

function createFolderCheckpoint(input, now = new Date()) {
  assertNonEmptyString(input.folderPath, 'folderPath');
  const relativePath = toPosixPath(input.relativePath || '.');
  const status = input.status || 'pending';
  if (!FOLDER_STATUSES.has(status)) {
    throw new Error(`Unsupported folder status: ${status}`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    folderId: input.folderId || createFolderId(relativePath),
    folderPath: path.resolve(input.folderPath),
    relativePath,
    status,
    filesSeen: input.filesSeen || 0,
    subfoldersSeen: input.subfoldersSeen || 0,
    nextChildIndex: input.nextChildIndex || 0,
    startedAt: input.startedAt || nowIso(now),
    updatedAt: input.updatedAt || nowIso(now),
    completedAt: input.completedAt || null
  };
}

function validateAppConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('config must be an object.');
  }
  if (config.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported config schema version: ${config.schemaVersion}`);
  }
  assertNonEmptyString(config.machineId, 'machineId');
  assertNonEmptyString(config.createdAt, 'createdAt');
  assertNonEmptyString(config.updatedAt, 'updatedAt');
  return config;
}

function validateMachineRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('machine record must be an object.');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported machine schema version: ${record.schemaVersion}`);
  }
  assertNonEmptyString(record.machineId, 'machineId');
  assertNonEmptyString(record.displayName, 'displayName');
  assertNonEmptyString(record.hostname, 'hostname');
  assertNonEmptyString(record.platform, 'platform');
  return record;
}

function validateSourceRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('source record must be an object.');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported source schema version: ${record.schemaVersion}`);
  }
  assertNonEmptyString(record.machineId, 'machineId');
  assertNonEmptyString(record.sourceId, 'sourceId');
  assertNonEmptyString(record.sourcePath, 'sourcePath');
  assertBoolean(record.organizeMedia, 'organizeMedia');
  assertBoolean(record.mergeEnabled, 'mergeEnabled');
  if (record.mergeEnabled) {
    assertNonEmptyString(record.mergeKey, 'mergeKey');
  }
  assertNonEmptyString(record.targetSubdir, 'targetSubdir');
  return record;
}

function validateHashRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('hash record must be an object.');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported hash schema version: ${record.schemaVersion}`);
  }
  assertNonEmptyString(record.fileHash, 'fileHash');
  if (typeof record.size !== 'number' || record.size < 0) {
    throw new Error('size must be a non-negative number.');
  }
  if (record.logicalPath !== '') {
    assertNonEmptyString(record.logicalPath, 'logicalPath');
  }
  assertArray(record.aliases, 'aliases');
  assertArray(record.origins, 'origins');
  createFileContentRef(record.content);
  return record;
}

function validateScanState(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('scan state must be an object.');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported scan state schema version: ${record.schemaVersion}`);
  }
  assertNonEmptyString(record.machineId, 'machineId');
  assertNonEmptyString(record.sourceId, 'sourceId');
  assertNonEmptyString(record.activeGeneration, 'activeGeneration');
  assertNonEmptyString(record.status, 'status');
  if (record.resumeCursor !== undefined && record.resumeCursor !== null) {
    if (typeof record.resumeCursor !== 'object') {
      throw new Error('resumeCursor must be an object or null.');
    }
    if (record.resumeCursor.scanId !== undefined && record.resumeCursor.scanId !== null) {
      assertNonEmptyString(record.resumeCursor.scanId, 'resumeCursor.scanId');
    }
    if (record.resumeCursor.relativePath !== undefined && record.resumeCursor.relativePath !== null) {
      assertNonEmptyString(record.resumeCursor.relativePath, 'resumeCursor.relativePath');
    }
    if (record.resumeCursor.folderHash !== undefined && record.resumeCursor.folderHash !== null) {
      assertNonEmptyString(record.resumeCursor.folderHash, 'resumeCursor.folderHash');
    }
  }
  return record;
}

function validateFolderCheckpoint(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('folder checkpoint must be an object.');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported folder checkpoint schema version: ${record.schemaVersion}`);
  }
  assertNonEmptyString(record.folderId, 'folderId');
  assertNonEmptyString(record.folderPath, 'folderPath');
  assertNonEmptyString(record.relativePath, 'relativePath');
  if (!FOLDER_STATUSES.has(record.status)) {
    throw new Error(`Unsupported folder status: ${record.status}`);
  }
  if (record.nextChildIndex !== undefined && record.nextChildIndex !== null && (typeof record.nextChildIndex !== 'number' || record.nextChildIndex < 0)) {
    throw new Error('nextChildIndex must be a non-negative number.');
  }
  return record;
}

module.exports = {
  CONTENT_TYPES,
  FOLDER_STATUSES,
  SCHEMA_VERSION,
  createAppConfig,
  createFileContentRef,
  createFolderCheckpoint,
  createHashRecord,
  createMachineRecord,
  createScanState,
  createSourceRecord,
  validateAppConfig,
  validateFolderCheckpoint,
  validateHashRecord,
  validateMachineRecord,
  validateScanState,
  validateSourceRecord
};
