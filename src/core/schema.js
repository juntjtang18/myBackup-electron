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

function createBackupStatus(input = {}, now = new Date()) {
  return {
    status: input.status || null,
    mode: input.mode || null,
    runId: input.runId || null,
    copiedBytes: input.copiedBytes === undefined || input.copiedBytes === null
      ? 0
      : Number(input.copiedBytes),
    startedAt: input.startedAt || null,
    updatedAt: input.updatedAt || null,
    completedAt: input.completedAt || null,
    cursor: input.cursor || null,
    scanSeq: input.scanSeq === undefined || input.scanSeq === null
      ? null
      : Number(input.scanSeq),
    error: input.error || null
  };
}

function createSourceStatusRecord(input = {}, now = new Date()) {
  assertNonEmptyString(input.sourceId, 'sourceId');
  const statusInput = input.status && typeof input.status === 'object' && !Array.isArray(input.status)
    ? input.status
    : input;
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceId: input.sourceId,
    status: createBackupStatus(statusInput, now),
    needsRescan: Boolean(input.needsRescan),
    lastEventAt: input.lastEventAt || null,
    updatedAt: input.updatedAt || nowIso(now)
  };
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

  const backupStatusInput = {
    ...(input.backupStatus || {})
  };
  if (!backupStatusInput.cursor && input.cursor?.relativePath) {
    backupStatusInput.cursor = {
      relativePath: input.cursor.relativePath,
      status: input.cursor.status || null,
      updatedAt: input.cursor.updatedAt || null
    };
  }

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
    backupStatus: createBackupStatus(backupStatusInput, now),
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

function createSourceDefinitionRecord(input, now = new Date()) {
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
    targetId: input.targetId || null,
    sourcePath: resolvedSourcePath,
    targetFolder,
    watchEnabled,
    backupIntervalMinutes,
    baselineAt: input.baselineAt || null,
    dirtyRef: input.dirtyRef || input.watchState?.dirtyRef || `watch/${sourceId}.dirty.json`,
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
  if (!record.backupStatus || typeof record.backupStatus !== 'object') {
    throw new Error('backupStatus must be an object.');
  }
  assertNullableString(record.backupStatus.status, 'backupStatus.status');
  assertNullableString(record.backupStatus.mode, 'backupStatus.mode');
  assertNullableString(record.backupStatus.runId, 'backupStatus.runId');
  assertNullableNonNegativeInteger(record.backupStatus.copiedBytes, 'backupStatus.copiedBytes');
  assertNullableString(record.backupStatus.startedAt, 'backupStatus.startedAt');
  assertNullableString(record.backupStatus.updatedAt, 'backupStatus.updatedAt');
  assertNullableString(record.backupStatus.completedAt, 'backupStatus.completedAt');
  if (record.backupStatus.cursor !== null && record.backupStatus.cursor !== undefined) {
    if (typeof record.backupStatus.cursor !== 'object') {
      throw new Error('backupStatus.cursor must be an object or null.');
    }
    assertNullableString(record.backupStatus.cursor.relativePath, 'backupStatus.cursor.relativePath');
    assertNullableString(record.backupStatus.cursor.status, 'backupStatus.cursor.status');
    assertNullableString(record.backupStatus.cursor.updatedAt, 'backupStatus.cursor.updatedAt');
  }
  assertNullableNonNegativeInteger(record.backupStatus.scanSeq, 'backupStatus.scanSeq');
  assertNullableString(record.backupStatus.error, 'backupStatus.error');
  assertNullableNonNegativeInteger(record.sourceSizeBytes, 'sourceSizeBytes');
  assertNullableNonNegativeInteger(record.backupSizeBytes, 'backupSizeBytes');
  return record;
}

function validateSourceDefinitionRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('source definition record must be an object.');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported source definition schema version: ${record.schemaVersion}`);
  }
  assertNonEmptyString(record.machineId, 'machineId');
  assertNonEmptyString(record.sourceId, 'sourceId');
  assertNonEmptyString(record.sourcePath, 'sourcePath');
  if (record.targetId !== null && record.targetId !== undefined) {
    assertNonEmptyString(record.targetId, 'targetId');
  }
  if (record.targetFolder !== '') {
    assertNonEmptyString(record.targetFolder, 'targetFolder');
  }
  assertBoolean(record.watchEnabled, 'watchEnabled');
  assertNullableNonNegativeInteger(record.backupIntervalMinutes, 'backupIntervalMinutes');
  assertNullableString(record.baselineAt, 'baselineAt');
  assertNonEmptyString(record.dirtyRef, 'dirtyRef');
  assertNullableNonNegativeInteger(record.sourceSizeBytes, 'sourceSizeBytes');
  assertNullableNonNegativeInteger(record.backupSizeBytes, 'backupSizeBytes');
  assertNullableString(record.lastCompletedAt, 'lastCompletedAt');
  return record;
}

function validateSourceStatusRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('source status record must be an object.');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported source status schema version: ${record.schemaVersion}`);
  }
  assertNonEmptyString(record.sourceId, 'sourceId');
  if (!record.status || typeof record.status !== 'object') {
    throw new Error('status must be an object.');
  }
  assertNullableString(record.status.status, 'status.status');
  assertNullableString(record.status.mode, 'status.mode');
  assertNullableString(record.status.runId, 'status.runId');
  assertNullableNonNegativeInteger(record.status.copiedBytes, 'status.copiedBytes');
  assertNullableString(record.status.startedAt, 'status.startedAt');
  assertNullableString(record.status.updatedAt, 'status.updatedAt');
  assertNullableString(record.status.completedAt, 'status.completedAt');
  if (record.status.cursor !== null && record.status.cursor !== undefined) {
    if (typeof record.status.cursor !== 'object') {
      throw new Error('status.cursor must be an object or null.');
    }
    assertNullableString(record.status.cursor.relativePath, 'status.cursor.relativePath');
    assertNullableString(record.status.cursor.status, 'status.cursor.status');
    assertNullableString(record.status.cursor.updatedAt, 'status.cursor.updatedAt');
  }
  assertNullableNonNegativeInteger(record.status.scanSeq, 'status.scanSeq');
  assertNullableString(record.status.error, 'status.error');
  assertBoolean(record.needsRescan, 'needsRescan');
  assertNullableString(record.lastEventAt, 'lastEventAt');
  assertNullableString(record.updatedAt, 'updatedAt');
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
  createBackupStatus,
  createFileContentRef,
  createHashRecord,
  createMachineRecord,
  createScanState,
  createSourceRecord,
  createSourceDefinitionRecord,
  createSourceStatusRecord,
  validateAppConfig,
  validateHashRecord,
  validateMachineRecord,
  validateScanState,
  validateSourceDefinitionRecord,
  validateSourceRecord,
  validateSourceStatusRecord
};
