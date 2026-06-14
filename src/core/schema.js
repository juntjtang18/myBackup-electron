const os = require('os');
const path = require('path');
const { createMachineId, createScanId, createSourceId } = require('./ids');
const { toPosixPath } = require('./layout');
const { normalizeTargetFolder } = require('./pathPlanner');

const SCHEMA_VERSION = 1;
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

function assertNullableString(value, fieldName) {
  if (value !== null && value !== undefined) {
    assertNonEmptyString(value, fieldName);
  }
}

function assertNullableNonNegativeInteger(value, fieldName) {
  if (value === null || value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer or null.`);
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
  const watchEnabled = input.watchEnabled === undefined ? true : Boolean(input.watchEnabled);
  const backupIntervalMinutes = input.backupIntervalMinutes === undefined || input.backupIntervalMinutes === null
    ? null
    : Number(input.backupIntervalMinutes);
  const targetFolder = normalizeTargetFolder(input.targetFolder);

  return {
    schemaVersion: SCHEMA_VERSION,
    machineId: input.machineId,
    sourceId,
    sourcePath: resolvedSourcePath,
    targetFolder,
    watchEnabled,
    backupIntervalMinutes,
    baselineAt: input.baselineAt || null,
    watchState: {
      dirtyRef: input.watchState?.dirtyRef || `watch/${sourceId}.dirty.json`,
      needsRescan: Boolean(input.watchState?.needsRescan),
      lastEventAt: input.watchState?.lastEventAt || null
    },
    cursor: {
      relativePath: input.cursor?.relativePath || null,
      status: input.cursor?.status || null,
      updatedAt: input.cursor?.updatedAt || null
    },
    sourceSizeBytes: input.sourceSizeBytes === undefined || input.sourceSizeBytes === null
      ? null
      : Number(input.sourceSizeBytes),
    backupSizeBytes: input.backupSizeBytes === undefined || input.backupSizeBytes === null
      ? null
      : Number(input.backupSizeBytes),
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
  const resumeCursor = input.resumeCursor
    ? {
        scanId: input.resumeCursor.scanId || activeGeneration,
        folderHash: input.resumeCursor.folderHash || null,
        relativePath: input.resumeCursor.relativePath || '.',
        folderPath: input.resumeCursor.folderPath || null,
        status: input.resumeCursor.status || 'scanning',
        updatedAt: input.resumeCursor.updatedAt || nowIso(now)
      }
    : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    machineId: input.machineId,
    sourceId: input.sourceId,
    activeGeneration,
    status: input.status || 'running',
    startedAt: input.startedAt || nowIso(now),
    completedAt: input.completedAt || null,
    updatedAt: input.updatedAt || nowIso(now),
    resumeCursor
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
  if (record.targetFolder !== '') {
    assertNonEmptyString(record.targetFolder, 'targetFolder');
  }
  assertBoolean(record.watchEnabled, 'watchEnabled');
  assertNullableNonNegativeInteger(record.backupIntervalMinutes, 'backupIntervalMinutes');
  assertNullableString(record.baselineAt, 'baselineAt');
  if (!record.watchState || typeof record.watchState !== 'object') {
    throw new Error('watchState must be an object.');
  }
  assertNonEmptyString(record.watchState.dirtyRef, 'watchState.dirtyRef');
  assertBoolean(record.watchState.needsRescan, 'watchState.needsRescan');
  assertNullableString(record.watchState.lastEventAt, 'watchState.lastEventAt');
  if (!record.cursor || typeof record.cursor !== 'object') {
    throw new Error('cursor must be an object.');
  }
  assertNullableString(record.cursor.relativePath, 'cursor.relativePath');
  assertNullableString(record.cursor.status, 'cursor.status');
  assertNullableString(record.cursor.updatedAt, 'cursor.updatedAt');
  assertNullableNonNegativeInteger(record.sourceSizeBytes, 'sourceSizeBytes');
  assertNullableNonNegativeInteger(record.backupSizeBytes, 'backupSizeBytes');
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
  if (record.resumeCursor) {
    assertNonEmptyString(record.resumeCursor.scanId, 'resumeCursor.scanId');
    assertNonEmptyString(record.resumeCursor.relativePath, 'resumeCursor.relativePath');
  }
  return record;
}

module.exports = {
  CONTENT_TYPES,
  SCHEMA_VERSION,
  createAppConfig,
  createFileContentRef,
  createHashRecord,
  createMachineRecord,
  createScanState,
  createSourceRecord,
  validateAppConfig,
  validateHashRecord,
  validateMachineRecord,
  validateScanState,
  validateSourceRecord
};
