const fs = require('fs-extra');
const path = require('path');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const {
  createMachineRecord,
  createSourceRecord,
  validateAppConfig,
  validateMachineRecord,
  validateScanState,
  validateSourceRecord
} = require('./schema');
const { normalizeCursor } = require('./cursor/cursorState');
const {
  backupSchemaPath,
  configPath,
  legacyLocalConfigPath,
  machinePath,
  scanCurrentPath,
  schemaMigrationMarkerPath,
  sourcePath
} = require('./paths');
const { createTargetId, normalizeTargets } = require('./targetConfig');

const BACKUP_SCHEMA_VERSION = 1;
const SCHEMA_MIGRATION_VERSION = 1;

function nowIso(now = new Date()) {
  return now.toISOString();
}

function createBackupScanState(input = {}, now = new Date()) {
  return {
    status: input.status || 'idle',
    activeGeneration: input.activeGeneration || null,
    startedAt: input.startedAt || null,
    completedAt: input.completedAt || null,
    updatedAt: input.updatedAt || nowIso(now),
    resumeCursor: input.resumeCursor ? normalizeCursor(input.resumeCursor) : null
  };
}

function createBackupSourceEntry(input, now = new Date()) {
  const source = createSourceRecord(input, now);
  return {
    ...source,
    scanState: createBackupScanState(input.scanState || {}, now)
  };
}

function createBackupTargetEntry(input, now = new Date()) {
  const resolvedPath = path.resolve(input.path || input.rootPath || '.');
  return {
    id: input.id || createTargetId(resolvedPath),
    path: resolvedPath,
    collapsed: Boolean(input.collapsed),
    addedAt: input.addedAt || nowIso(now),
    sources: Array.isArray(input.sources)
      ? input.sources.map((source) => createBackupSourceEntry(source, now))
      : []
  };
}

function createBackupSchema(input = {}, now = new Date()) {
  const machine = input.machine
    ? createMachineRecord(input.machine, now)
    : createMachineRecord({}, now);
  return {
    version: BACKUP_SCHEMA_VERSION,
    machine,
    targets: Array.isArray(input.targets)
      ? input.targets.map((target) => createBackupTargetEntry(target, now))
      : [],
    migration: input.migration ? {
      version: SCHEMA_MIGRATION_VERSION,
      migratedAt: input.migration.migratedAt || nowIso(now),
      mode: input.migration.mode || 'fresh',
      importedTargetCount: Number(input.migration.importedTargetCount || 0),
      importedSourceCount: Number(input.migration.importedSourceCount || 0)
    } : undefined,
    createdAt: input.createdAt || nowIso(now),
    updatedAt: input.updatedAt || nowIso(now)
  };
}

function validateBackupSchema(document) {
  if (!document || typeof document !== 'object') {
    throw new Error('Backup schema must be an object.');
  }
  if (document.version !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported backup schema version: ${document.version}`);
  }
  if (!document.machine || typeof document.machine !== 'object') {
    throw new Error('Backup schema machine is required.');
  }
  if (!Array.isArray(document.targets)) {
    throw new Error('Backup schema targets must be an array.');
  }
  return document;
}

async function loadBackupSchema(appDataRoot) {
  return readJsonIfExists(backupSchemaPath(appDataRoot), validateBackupSchema);
}

async function saveBackupSchema(appDataRoot, schema, now = new Date()) {
  const normalized = createBackupSchema({
    ...schema,
    updatedAt: nowIso(now)
  }, now);
  await writeJsonAtomic(backupSchemaPath(appDataRoot), normalized);
  return normalized;
}

async function saveSchemaMigrationMarker(appDataRoot, marker, now = new Date()) {
  const normalized = {
    version: SCHEMA_MIGRATION_VERSION,
    migratedAt: marker.migratedAt || nowIso(now),
    mode: marker.mode || 'fresh',
    importedTargetCount: Number(marker.importedTargetCount || 0),
    importedSourceCount: Number(marker.importedSourceCount || 0)
  };
  await writeJsonAtomic(schemaMigrationMarkerPath(appDataRoot), normalized);
  return normalized;
}

async function loadLegacyAppConfig(targetRoot) {
  return readJsonIfExists(configPath(targetRoot), validateAppConfig);
}

async function loadLegacyMachine(targetRoot, machineId) {
  return readJsonIfExists(machinePath(targetRoot, machineId), validateMachineRecord);
}

async function loadLegacySource(targetRoot, machineId, sourceId) {
  return readJsonIfExists(sourcePath(targetRoot, machineId, sourceId), validateSourceRecord);
}

async function loadLegacyScanState(targetRoot, machineId, sourceId) {
  return readJsonIfExists(scanCurrentPath(targetRoot, machineId, sourceId), validateScanState);
}

async function loadLegacyTargets(appDataRoot) {
  const legacyConfig = await readJsonIfExists(legacyLocalConfigPath(appDataRoot));
  return normalizeTargets(legacyConfig || {});
}

async function loadLegacyTargetSources(targetRoot, now = new Date()) {
  const appConfig = await loadLegacyAppConfig(targetRoot);
  if (!appConfig) {
    return {
      machine: null,
      sources: []
    };
  }

  const machine = await loadLegacyMachine(targetRoot, appConfig.machineId);
  const sourcesDir = path.join(targetRoot, '.mybackup', 'sources', appConfig.machineId);
  if (!(await fs.pathExists(sourcesDir))) {
    return {
      machine,
      sources: []
    };
  }

  const entries = await fs.readdir(sourcesDir, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const sourceId = path.basename(entry.name, '.json');
    const source = await loadLegacySource(targetRoot, appConfig.machineId, sourceId);
    if (!source) {
      continue;
    }
    const scanState = await loadLegacyScanState(targetRoot, appConfig.machineId, sourceId);
    sources.push(createBackupSourceEntry({
      ...source,
      scanState: scanState || createBackupScanState({}, now)
    }, now));
  }

  sources.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  return {
    machine,
    sources
  };
}

async function ensureBackupSchema(appDataRoot, machineInput = {}, now = new Date()) {
  const existing = await loadBackupSchema(appDataRoot);
  if (existing) {
    return existing;
  }

  const legacyTargets = await loadLegacyTargets(appDataRoot);
  let migratedMachine = null;
  const migratedTargets = [];
  let importedSourceCount = 0;

  for (const target of legacyTargets) {
    const legacy = await loadLegacyTargetSources(target.path, now);
    if (!migratedMachine && legacy.machine) {
      migratedMachine = legacy.machine;
    }
    migratedTargets.push(createBackupTargetEntry({
      ...target,
      sources: legacy.sources
    }, now));
    importedSourceCount += legacy.sources.length;
  }

  if (migratedTargets.length === 0) {
    const legacySelf = await loadLegacyTargetSources(appDataRoot, now);
    if (legacySelf.machine || (legacySelf.sources || []).length > 0) {
      migratedMachine = migratedMachine || legacySelf.machine;
      migratedTargets.push(createBackupTargetEntry({
        path: appDataRoot,
        sources: legacySelf.sources
      }, now));
      importedSourceCount += legacySelf.sources.length;
    }
  }

  const migration = {
    mode: migratedTargets.length > 0 ? 'legacy-imported' : 'fresh',
    migratedAt: nowIso(now),
    importedTargetCount: migratedTargets.length,
    importedSourceCount
  };
  const schema = createBackupSchema({
    machine: migratedMachine || machineInput,
    targets: migratedTargets,
    migration
  }, now);
  await saveBackupSchema(appDataRoot, schema, now);
  await saveSchemaMigrationMarker(appDataRoot, migration, now);
  return schema;
}

function findTarget(schema, targetRoot) {
  const resolvedPath = path.resolve(targetRoot);
  return (schema.targets || []).find((target) => target.path === resolvedPath) || null;
}

function findSource(target, machineId, sourceId) {
  return (target?.sources || []).find((source) => (
    source.machineId === machineId && source.sourceId === sourceId
  )) || null;
}

async function mutateBackupSchema(appDataRoot, mutator, now = new Date()) {
  const current = await ensureBackupSchema(appDataRoot, {}, now);
  const draft = createBackupSchema(current, now);
  const next = await mutator(draft);
  return saveBackupSchema(appDataRoot, next || draft, now);
}

async function listBackupTargets(appDataRoot) {
  const schema = await ensureBackupSchema(appDataRoot);
  return schema.targets || [];
}

async function loadBackupMachine(appDataRoot) {
  const schema = await ensureBackupSchema(appDataRoot);
  return schema.machine || null;
}

async function saveBackupMachine(appDataRoot, machineInput, now = new Date()) {
  const current = await loadBackupMachine(appDataRoot);
  const machine = createMachineRecord({
    ...current,
    ...machineInput,
    createdAt: current ? current.createdAt : undefined,
    updatedAt: nowIso(now)
  }, now);

  await mutateBackupSchema(appDataRoot, (schema) => {
    schema.machine = machine;
    return schema;
  }, now);

  return machine;
}

async function addBackupTarget(appDataRoot, targetPath, now = new Date()) {
  const resolvedPath = path.resolve(targetPath);
  let added = null;
  await mutateBackupSchema(appDataRoot, (schema) => {
    const existing = findTarget(schema, resolvedPath);
    if (existing) {
      added = existing;
      return schema;
    }
    added = createBackupTargetEntry({ path: resolvedPath }, now);
    schema.targets.push(added);
    return schema;
  }, now);
  return added;
}

async function removeBackupTarget(appDataRoot, targetId, now = new Date()) {
  await mutateBackupSchema(appDataRoot, (schema) => {
    schema.targets = schema.targets.filter((target) => target.id !== targetId);
    return schema;
  }, now);
}

async function setBackupTargetCollapsed(appDataRoot, targetId, collapsed, now = new Date()) {
  await mutateBackupSchema(appDataRoot, (schema) => {
    schema.targets = schema.targets.map((target) => (
      target.id === targetId
        ? createBackupTargetEntry({ ...target, collapsed: Boolean(collapsed) }, now)
        : target
    ));
    return schema;
  }, now);
}

async function requireBackupTarget(appDataRoot, targetRoot) {
  const schema = await ensureBackupSchema(appDataRoot);
  const target = findTarget(schema, targetRoot);
  if (!target) {
    throw new Error(`Unknown backup target: ${path.resolve(targetRoot || '')}`);
  }
  return target.path;
}

async function loadBackupSource(appDataRoot, targetRoot, machineId, sourceId) {
  const schema = await ensureBackupSchema(appDataRoot);
  const target = findTarget(schema, targetRoot);
  if (!target) {
    return null;
  }
  return findSource(target, machineId, sourceId);
}

async function registerBackupSource(appDataRoot, input, now = new Date()) {
  const targetRoot = path.resolve(input.targetRoot || appDataRoot);
  let registered = null;
  await mutateBackupSchema(appDataRoot, (schema) => {
    let target = findTarget(schema, targetRoot);
    if (!target) {
      target = createBackupTargetEntry({ path: targetRoot }, now);
      schema.targets.push(target);
    }

    const candidate = createBackupSourceEntry(input, now);
    const existing = findSource(target, candidate.machineId, candidate.sourceId);
    const scanState = existing ? existing.scanState : createBackupScanState({}, now);
    registered = createBackupSourceEntry({
      ...existing,
      ...candidate,
      machineId: candidate.machineId,
      sourceId: candidate.sourceId,
      createdAt: existing ? existing.createdAt : candidate.createdAt,
      lastCompletedScan: existing ? existing.lastCompletedScan : candidate.lastCompletedScan,
      lastCompletedAt: existing ? existing.lastCompletedAt : candidate.lastCompletedAt,
      scanState
    }, now);

    target.sources = (target.sources || []).filter((source) => !(
      source.machineId === candidate.machineId && source.sourceId === candidate.sourceId
    ));
    target.sources.push(registered);
    target.sources.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    return schema;
  }, now);
  return registered;
}

async function updateBackupSource(appDataRoot, targetRoot, machineId, sourceId, updater, now = new Date()) {
  let updated = null;
  await mutateBackupSchema(appDataRoot, (schema) => {
    const target = findTarget(schema, targetRoot);
    if (!target) {
      throw new Error(`Unknown backup target: ${path.resolve(targetRoot)}`);
    }
    const existing = findSource(target, machineId, sourceId);
    if (!existing) {
      throw new Error(`Source not found: ${machineId}/${sourceId}`);
    }

    const next = typeof updater === 'function' ? updater(existing) : { ...existing, ...updater };
    updated = createBackupSourceEntry({
      ...existing,
      ...next,
      machineId,
      sourceId,
      createdAt: existing.createdAt,
      updatedAt: nowIso(now),
      scanState: next.scanState || existing.scanState
    }, now);

    target.sources = target.sources.map((source) => (
      source.machineId === machineId && source.sourceId === sourceId
        ? updated
        : source
    ));
    return schema;
  }, now);
  return updated;
}

async function loadBackupScanState(appDataRoot, targetRoot, machineId, sourceId) {
  const source = await loadBackupSource(appDataRoot, targetRoot, machineId, sourceId);
  return source ? source.scanState || null : null;
}

async function saveBackupScanState(appDataRoot, targetRoot, machineId, sourceId, scanState, now = new Date()) {
  const nextScanState = createBackupScanState(scanState, now);
  const updated = await updateBackupSource(
    appDataRoot,
    targetRoot,
    machineId,
    sourceId,
    (source) => ({
      ...source,
      scanState: nextScanState
    }),
    now
  );
  return updated.scanState;
}

module.exports = {
  BACKUP_SCHEMA_VERSION,
  addBackupTarget,
  createBackupScanState,
  createBackupSchema,
  createBackupSourceEntry,
  createBackupTargetEntry,
  ensureBackupSchema,
  listBackupTargets,
  loadBackupMachine,
  loadBackupScanState,
  loadBackupSchema,
  loadBackupSource,
  registerBackupSource,
  removeBackupTarget,
  requireBackupTarget,
  saveSchemaMigrationMarker,
  saveBackupMachine,
  saveBackupScanState,
  saveBackupSchema,
  setBackupTargetCollapsed,
  updateBackupSource,
  validateBackupSchema
};
