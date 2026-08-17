const os = require('os');
const path = require('path');
const { createComputerId, createMachineId, createScanId, createSourceId, isUuidComputerId, readOsComputerName } = require('./ids');
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

function normalizeScanReportRow(row, kind) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  if (kind === 'failed') {
    return {
      path: String(row.path || ''),
      error: String(row.error || ''),
      sourceBytes: Number(row.sourceBytes || 0)
    };
  }
  return {
    path: String(row.path || ''),
    sourceBytes: Number(row.sourceBytes || 0),
    targetBytes: Number(row.targetBytes || 0)
  };
}

function createScanResult(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  return {
    kind: input.kind === 'changes' ? 'changes' : 'full',
    sourceFileCount: Number(input.sourceFileCount || 0),
    sourceSizeBytes: Number(input.sourceSizeBytes || 0),
    targetFileCount: Number(input.targetFileCount || 0),
    targetSizeBytes: Number(input.targetSizeBytes || 0),
    missingCount: Number(input.missingCount || 0),
    backedUp: Boolean(input.backedUp),
    filesCopied: Number(input.filesCopied || 0),
    errors: Number(input.errors || 0),
    totalFileCount: Number(input.totalFileCount || 0),
    totalSizeBytes: Number(input.totalSizeBytes || 0),
    ignoredFileCount: Number(input.ignoredFileCount || 0),
    ignoredSizeBytes: Number(input.ignoredSizeBytes || 0),
    failedFileCount: Number(input.failedFileCount || 0),
    failedSizeBytes: Number(input.failedSizeBytes || 0),
    skippedNewerFileCount: Number(input.skippedNewerFileCount || 0),
    skippedNewerSourceSizeBytes: Number(input.skippedNewerSourceSizeBytes || 0),
    skippedNewerTargetSizeBytes: Number(input.skippedNewerTargetSizeBytes || 0),
    failed: Array.isArray(input.failed)
      ? input.failed.map((row) => normalizeScanReportRow(row, 'failed')).filter(Boolean)
      : [],
    skippedNewer: Array.isArray(input.skippedNewer)
      ? input.skippedNewer.map((row) => normalizeScanReportRow(row, 'skipped-newer')).filter(Boolean)
      : []
  };
}

function createBackupJob(input = {}, now = new Date()) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const status = input.status || null;
  if (!status && !input.id) {
    return null;
  }
  return {
    id: input.id || input.runId || createScanId(now),
    sourcePath: input.sourcePath || null,
    destinationPath: input.destinationPath || null,
    type: input.type || (input.mode === 'full' ? 'full' : input.mode === 'incremental' ? 'changes' : null),
    status,
    cursor: input.cursor || null,
    progress: {
      totalFiles: input.progress?.totalFiles === undefined || input.progress?.totalFiles === null ? null : Number(input.progress.totalFiles),
      completedFiles: input.progress?.completedFiles === undefined || input.progress?.completedFiles === null ? 0 : Number(input.progress.completedFiles),
      totalBytes: input.progress?.totalBytes === undefined || input.progress?.totalBytes === null ? null : Number(input.progress.totalBytes),
      completedBytes: input.progress?.completedBytes === undefined || input.progress?.completedBytes === null
        ? Number(input.copiedBytes || 0)
        : Number(input.progress.completedBytes)
    },
    createdAt: input.createdAt || input.startedAt || nowIso(now),
    startedAt: input.startedAt || null,
    pausedAt: input.pausedAt || null,
    resumedAt: input.resumedAt || null,
    completedAt: input.completedAt || null,
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
    backupJob: createBackupJob(input.backupJob || input.job || null, now),
    scanResult: createScanResult(input.scanResult),
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
  const hostname = input.hostname || readOsComputerName();
  const machineId = input.machineId || createMachineId(hostname, input.seed || `${hostname}-${os.platform()}`);
  const computerId = input.computerId && !isUuidComputerId(input.computerId)
    ? createComputerId(input.computerId)
    : createComputerId(hostname);

  return {
    schemaVersion: SCHEMA_VERSION,
    machineId,
    computerId,
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
  const includeSourceRoot = input.includeSourceRoot === undefined
    ? true
    : Boolean(input.includeSourceRoot);
  const relativeRoot = input.relativeRoot === undefined || input.relativeRoot === null
    ? null
    : normalizeTargetFolder(input.relativeRoot);
  const folderName = typeof input.folderName === 'string' && input.folderName.trim()
    ? input.folderName.trim()
    : null;
  const setId = typeof input.setId === 'string' && input.setId.trim()
    ? input.setId.trim()
    : null;

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
    setId,
    sourcePath: resolvedSourcePath,
    targetFolder,
    includeSourceRoot,
    relativeRoot,
    folderName,
    watchEnabled,
    backupIntervalMinutes,
    baselineAt: input.baselineAt || null,
    watchState: {
      dirtyRef: input.watchState?.dirtyRef || `watch/${sourceId}.dirty.json`,
      needsRescan: Boolean(input.watchState?.needsRescan),
      lastEventAt: input.watchState?.lastEventAt || null
    },
    backupStatus: createBackupStatus(backupStatusInput, now),
    backupJob: createBackupJob(input.backupJob || null, now),
    sourceSizeBytes: input.sourceSizeBytes === undefined || input.sourceSizeBytes === null
      ? null
      : Number(input.sourceSizeBytes),
    backupSizeBytes: input.backupSizeBytes === undefined || input.backupSizeBytes === null
      ? null
      : Number(input.backupSizeBytes),
    scanResult: createScanResult(input.scanResult),
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
  const includeSourceRoot = input.includeSourceRoot === undefined
    ? true
    : Boolean(input.includeSourceRoot);
  const relativeRoot = input.relativeRoot === undefined || input.relativeRoot === null
    ? null
    : normalizeTargetFolder(input.relativeRoot);
  const folderName = typeof input.folderName === 'string' && input.folderName.trim()
    ? input.folderName.trim()
    : null;
  const setId = typeof input.setId === 'string' && input.setId.trim()
    ? input.setId.trim()
    : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    machineId: input.machineId,
    sourceId,
    setId,
    targetId: input.targetId || null,
    sourcePath: resolvedSourcePath,
    targetFolder,
    includeSourceRoot,
    relativeRoot,
    folderName,
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
  if (record.computerId !== undefined && record.computerId !== null) {
    assertNonEmptyString(record.computerId, 'computerId');
  }
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
  assertNullableString(record.setId, 'setId');
  assertNonEmptyString(record.sourcePath, 'sourcePath');
  if (record.targetFolder !== '') {
    assertNonEmptyString(record.targetFolder, 'targetFolder');
  }
  if (record.includeSourceRoot !== undefined) {
    assertBoolean(record.includeSourceRoot, 'includeSourceRoot');
  }
  if (record.relativeRoot !== undefined && record.relativeRoot !== null && record.relativeRoot !== '') {
    assertNonEmptyString(record.relativeRoot, 'relativeRoot');
  }
  assertNullableString(record.folderName, 'folderName');
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
  validateBackupJob(record.backupJob, 'backupJob');
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
  assertNullableString(record.setId, 'setId');
  assertNonEmptyString(record.sourcePath, 'sourcePath');
  if (record.targetId !== null && record.targetId !== undefined) {
    assertNonEmptyString(record.targetId, 'targetId');
  }
  if (record.targetFolder !== '') {
    assertNonEmptyString(record.targetFolder, 'targetFolder');
  }
  if (record.includeSourceRoot !== undefined) {
    assertBoolean(record.includeSourceRoot, 'includeSourceRoot');
  }
  if (record.relativeRoot !== undefined && record.relativeRoot !== null && record.relativeRoot !== '') {
    assertNonEmptyString(record.relativeRoot, 'relativeRoot');
  }
  assertNullableString(record.folderName, 'folderName');
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
  validateBackupJob(record.backupJob, 'backupJob');
  assertBoolean(record.needsRescan, 'needsRescan');
  assertNullableString(record.lastEventAt, 'lastEventAt');
  assertNullableString(record.updatedAt, 'updatedAt');
  return record;
}

function validateBackupJob(job, fieldName = 'backupJob') {
  if (job === null || job === undefined) {
    return;
  }
  if (typeof job !== 'object' || Array.isArray(job)) {
    throw new Error(`${fieldName} must be an object or null.`);
  }
  assertNonEmptyString(job.id, `${fieldName}.id`);
  assertNullableString(job.sourcePath, `${fieldName}.sourcePath`);
  assertNullableString(job.destinationPath, `${fieldName}.destinationPath`);
  assertNullableString(job.type, `${fieldName}.type`);
  assertNullableString(job.status, `${fieldName}.status`);
  if (job.cursor !== null && job.cursor !== undefined && typeof job.cursor !== 'object') {
    throw new Error(`${fieldName}.cursor must be an object or null.`);
  }
  if (!job.progress || typeof job.progress !== 'object') {
    throw new Error(`${fieldName}.progress must be an object.`);
  }
  assertNullableNonNegativeInteger(job.progress.totalFiles, `${fieldName}.progress.totalFiles`);
  assertNullableNonNegativeInteger(job.progress.completedFiles, `${fieldName}.progress.completedFiles`);
  assertNullableNonNegativeInteger(job.progress.totalBytes, `${fieldName}.progress.totalBytes`);
  assertNullableNonNegativeInteger(job.progress.completedBytes, `${fieldName}.progress.completedBytes`);
  assertNullableString(job.createdAt, `${fieldName}.createdAt`);
  assertNullableString(job.startedAt, `${fieldName}.startedAt`);
  assertNullableString(job.pausedAt, `${fieldName}.pausedAt`);
  assertNullableString(job.resumedAt, `${fieldName}.resumedAt`);
  assertNullableString(job.completedAt, `${fieldName}.completedAt`);
  assertNullableString(job.error, `${fieldName}.error`);
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
  createBackupJob,
  createBackupStatus,
  createScanResult,
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
