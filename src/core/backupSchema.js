const fs = require('fs-extra');
const path = require('path');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const {
  createMachineRecord,
  createSourceDefinitionRecord,
  createSourceRecord,
  createSourceStatusRecord,
  validateSourceRecord
} = require('./schema');
const {
  backupSchemaPath,
  schemaMigrationMarkerPath
} = require('./paths');
const { createTargetId } = require('./targetConfig');
const {
  TargetsStore,
  createTargetsDocument,
  validateTargetsDocument
} = require('./targetsStore');
const { SourceStore } = require('./sourceStore');
const { SourceStatusStore } = require('./sourceStatusStore');

const BACKUP_SCHEMA_VERSION = 1;
const SCHEMA_MIGRATION_VERSION = 1;

function nowIso(now = new Date()) {
  return now.toISOString();
}

function createBackupSourceEntry(input, now = new Date()) {
  return createSourceRecord(input, now);
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
  for (const target of document.targets) {
    if (!target || typeof target !== 'object') {
      throw new Error('Backup schema target must be an object.');
    }
    if (!Array.isArray(target.sources)) {
      throw new Error('Backup schema target sources must be an array.');
    }
    for (const source of target.sources) {
      validateSourceRecord(source);
    }
  }
  return document;
}

function splitMergedSource(source, targetId, now = new Date()) {
  const definition = createSourceDefinitionRecord({
    machineId: source.machineId,
    sourceId: source.sourceId,
    targetId,
    sourcePath: source.sourcePath,
    targetFolder: source.targetFolder,
    watchEnabled: source.watchEnabled,
    backupIntervalMinutes: source.backupIntervalMinutes,
    baselineAt: source.baselineAt,
    dirtyRef: source.watchState?.dirtyRef || source.dirtyRef,
    sourceSizeBytes: source.sourceSizeBytes,
    backupSizeBytes: source.backupSizeBytes,
    lastCompletedAt: source.lastCompletedAt,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt || nowIso(now)
  }, now);

  const status = createSourceStatusRecord({
    sourceId: source.sourceId,
    status: source.backupStatus?.status,
    mode: source.backupStatus?.mode,
    runId: source.backupStatus?.runId,
    copiedBytes: source.backupStatus?.copiedBytes,
    startedAt: source.backupStatus?.startedAt,
    updatedAt: source.backupStatus?.updatedAt,
    completedAt: source.backupStatus?.completedAt,
    cursor: source.backupStatus?.cursor || null,
    scanSeq: source.backupStatus?.scanSeq,
    error: source.backupStatus?.error,
    needsRescan: Boolean(source.watchState?.needsRescan),
    lastEventAt: source.watchState?.lastEventAt || null
  }, now);

  return { definition, status };
}

function mergeSource(definition, status, now = new Date()) {
  const merged = createSourceRecord({
    ...definition,
    watchState: {
      dirtyRef: definition.dirtyRef,
      needsRescan: Boolean(status?.needsRescan),
      lastEventAt: status?.lastEventAt || null
    },
    backupStatus: status?.status || {},
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt || nowIso(now)
  }, now);
  merged.targetId = definition.targetId || null;
  return merged;
}

function createStoreContext(appDataRoot) {
  return {
    targetsStore: new TargetsStore(appDataRoot),
    sourceStore: new SourceStore(appDataRoot),
    statusStore: new SourceStatusStore(appDataRoot)
  };
}

async function loadAssembledSchemaFromStores(appDataRoot, now = new Date()) {
  const { targetsStore, sourceStore, statusStore } = createStoreContext(appDataRoot);
  const targetsDocument = await targetsStore.load(now);
  if (!targetsDocument) {
    return null;
  }

  const definitions = await sourceStore.list(now);
  const grouped = new Map();
  for (const definition of definitions) {
    const status = await statusStore.ensure(definition.sourceId, now);
    const source = mergeSource(definition, status, now);
    const targetId = definition.targetId || '';
    const list = grouped.get(targetId) || [];
    list.push(source);
    grouped.set(targetId, list);
  }

  return createBackupSchema({
    machine: targetsDocument.machine,
    targets: targetsDocument.targets.map((target) => ({
      ...target,
      sources: (grouped.get(target.id) || []).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
    })),
    migration: {
      mode: 'split-layout',
      migratedAt: targetsDocument.updatedAt,
      importedTargetCount: targetsDocument.targets.length,
      importedSourceCount: definitions.length
    },
    updatedAt: targetsDocument.updatedAt
  }, now);
}

async function saveSplitLayoutFromSchema(appDataRoot, schema, now = new Date()) {
  const { targetsStore, sourceStore, statusStore } = createStoreContext(appDataRoot);
  const normalized = createBackupSchema({
    ...schema,
    updatedAt: nowIso(now)
  }, now);

  await targetsStore.save(createTargetsDocument({
    machine: normalized.machine,
    targets: normalized.targets.map((target) => ({
      id: target.id,
      path: target.path,
      collapsed: target.collapsed,
      addedAt: target.addedAt
    })),
    updatedAt: nowIso(now)
  }, now), now);

  const expectedSourceIds = new Set();
  for (const target of normalized.targets) {
    for (const source of target.sources || []) {
      const { definition, status } = splitMergedSource(source, target.id, now);
      expectedSourceIds.add(definition.sourceId);
      await sourceStore.save(definition, now);
      await statusStore.save(status, now);
    }
  }

  const existingDefinitions = await sourceStore.list(now);
  for (const definition of existingDefinitions) {
    if (!expectedSourceIds.has(definition.sourceId)) {
      await sourceStore.remove(definition.sourceId);
      await statusStore.remove(definition.sourceId);
    }
  }

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

async function migrateLegacySchemaIfNeeded(appDataRoot, machineInput = {}, now = new Date()) {
  const { targetsStore } = createStoreContext(appDataRoot);
  if (await targetsStore.exists()) {
    return loadAssembledSchemaFromStores(appDataRoot, now);
  }

  const legacyDocument = await readJsonIfExists(backupSchemaPath(appDataRoot));
  if (legacyDocument) {
    if (legacyDocument.version !== BACKUP_SCHEMA_VERSION) {
      throw new Error(`Unsupported backup schema version: ${legacyDocument.version}`);
    }
    const normalized = createBackupSchema(legacyDocument, now);
    await saveSplitLayoutFromSchema(appDataRoot, normalized, now);
    await saveSchemaMigrationMarker(appDataRoot, {
      mode: 'backup-target-imported',
      migratedAt: nowIso(now),
      importedTargetCount: normalized.targets.length,
      importedSourceCount: normalized.targets.reduce((count, target) => count + (target.sources || []).length, 0)
    }, now);
    return loadAssembledSchemaFromStores(appDataRoot, now);
  }

  const fresh = createBackupSchema({
    machine: machineInput,
    targets: [],
    migration: {
      mode: 'fresh',
      migratedAt: nowIso(now),
      importedTargetCount: 0,
      importedSourceCount: 0
    }
  }, now);
  await saveSplitLayoutFromSchema(appDataRoot, fresh, now);
  await saveSchemaMigrationMarker(appDataRoot, fresh.migration, now);
  return loadAssembledSchemaFromStores(appDataRoot, now);
}

async function loadBackupSchema(appDataRoot, now = new Date()) {
  const { targetsStore } = createStoreContext(appDataRoot);
  if (await targetsStore.exists()) {
    return loadAssembledSchemaFromStores(appDataRoot, now);
  }

  const legacyDocument = await readJsonIfExists(backupSchemaPath(appDataRoot));
  if (!legacyDocument) {
    return null;
  }
  if (legacyDocument.version !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported backup schema version: ${legacyDocument.version}`);
  }
  await migrateLegacySchemaIfNeeded(appDataRoot, {}, now);
  return loadAssembledSchemaFromStores(appDataRoot, now);
}

async function ensureBackupSchema(appDataRoot, machineInput = {}, now = new Date()) {
  const schema = await loadBackupSchema(appDataRoot, now);
  if (schema) {
    return schema;
  }
  return migrateLegacySchemaIfNeeded(appDataRoot, machineInput, now);
}

async function saveBackupSchema(appDataRoot, schema, now = new Date()) {
  return saveSplitLayoutFromSchema(appDataRoot, schema, now);
}

function findTarget(schema, targetRoot) {
  const resolvedPath = path.resolve(targetRoot);
  return (schema.targets || []).find((target) => target.path === resolvedPath) || null;
}

function findSource(sources, machineId, sourceId) {
  return (sources || []).find((source) => (
    source.machineId === machineId && source.sourceId === sourceId
  )) || null;
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
  const { targetsStore } = createStoreContext(appDataRoot);
  const targetsDocument = await targetsStore.load(now) || createTargetsDocument({}, now);
  targetsDocument.machine = createMachineRecord({
    ...targetsDocument.machine,
    ...machineInput,
    createdAt: targetsDocument.machine?.createdAt
  }, now);
  await targetsStore.save(targetsDocument, now);
  return targetsDocument.machine;
}

async function addBackupTarget(appDataRoot, targetPath, now = new Date()) {
  const { targetsStore } = createStoreContext(appDataRoot);
  const resolvedPath = path.resolve(targetPath);
  const document = await targetsStore.load(now) || createTargetsDocument({}, now);
  const existing = (document.targets || []).find((target) => target.path === resolvedPath);
  if (existing) {
    return existing;
  }
  const added = createBackupTargetEntry({ path: resolvedPath }, now);
  document.targets.push({
    id: added.id,
    path: added.path,
    collapsed: added.collapsed,
    addedAt: added.addedAt
  });
  await targetsStore.save(document, now);
  return added;
}

async function removeBackupTarget(appDataRoot, targetId, now = new Date()) {
  const { targetsStore, sourceStore, statusStore } = createStoreContext(appDataRoot);
  const document = await targetsStore.load(now) || createTargetsDocument({}, now);
  const target = (document.targets || []).find((entry) => entry.id === targetId);
  document.targets = (document.targets || []).filter((entry) => entry.id !== targetId);
  await targetsStore.save(document, now);

  if (target) {
    const definitions = await sourceStore.list(now);
    for (const definition of definitions.filter((entry) => entry.targetId === target.id)) {
      await sourceStore.remove(definition.sourceId);
      await statusStore.remove(definition.sourceId);
    }
  }
}

async function setBackupTargetCollapsed(appDataRoot, targetId, collapsed, now = new Date()) {
  const { targetsStore } = createStoreContext(appDataRoot);
  const document = await targetsStore.load(now) || createTargetsDocument({}, now);
  document.targets = (document.targets || []).map((target) => (
    target.id === targetId
      ? {
          ...target,
          collapsed: Boolean(collapsed)
        }
      : target
  ));
  await targetsStore.save(document, now);
}

async function requireBackupTarget(appDataRoot, targetRoot) {
  const schema = await ensureBackupSchema(appDataRoot);
  const target = findTarget(schema, targetRoot);
  if (!target) {
    throw new Error(`Unknown backup target: ${path.resolve(targetRoot || '')}`);
  }
  return target.path;
}

async function loadBackupSource(appDataRoot, targetRoot, machineId, sourceId, now = new Date()) {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const { sourceStore, statusStore } = createStoreContext(appDataRoot);
  const schema = await ensureBackupSchema(appDataRoot, {}, now);
  const target = findTarget(schema, resolvedTargetRoot);
  if (!target) {
    return null;
  }
  const definition = await sourceStore.load(sourceId, now);
  if (!definition || definition.targetId !== target.id || definition.machineId !== machineId) {
    return null;
  }
  const status = await statusStore.ensure(sourceId, now);
  return mergeSource(definition, status, now);
}

async function registerBackupSource(appDataRoot, input, now = new Date()) {
  const { sourceStore, statusStore, targetsStore } = createStoreContext(appDataRoot);
  const targetRoot = path.resolve(input.targetRoot || appDataRoot);
  const targetsDocument = await targetsStore.load(now) || createTargetsDocument({}, now);
  let target = (targetsDocument.targets || []).find((entry) => entry.path === targetRoot);
  if (!target) {
    target = createBackupTargetEntry({ path: targetRoot }, now);
    targetsDocument.targets.push({
      id: target.id,
      path: target.path,
      collapsed: target.collapsed,
      addedAt: target.addedAt
    });
    await targetsStore.save(targetsDocument, now);
  }

  const candidate = createBackupSourceEntry(input, now);
  const existingDefinitions = await sourceStore.list(now);
  const existingDefinition = existingDefinitions.find((entry) => (
    entry.machineId === candidate.machineId
    && entry.sourceId === candidate.sourceId
    && entry.targetId === target.id
  )) || null;
  const existingStatus = existingDefinition
    ? await statusStore.ensure(existingDefinition.sourceId, now)
    : createSourceStatusRecord({ sourceId: candidate.sourceId }, now);
  const existingMerged = existingDefinition
    ? mergeSource(existingDefinition, existingStatus, now)
    : null;

  const registered = createBackupSourceEntry({
    ...existingMerged,
    ...candidate,
    machineId: candidate.machineId,
    sourceId: candidate.sourceId,
    createdAt: existingMerged ? existingMerged.createdAt : candidate.createdAt,
    lastCompletedAt: existingMerged ? existingMerged.lastCompletedAt : candidate.lastCompletedAt
  }, now);
  const { definition, status } = splitMergedSource(registered, target.id, now);
  await sourceStore.save(definition, now);
  await statusStore.save(status, now);
  return mergeSource(definition, status, now);
}

async function updateBackupSource(appDataRoot, targetRoot, machineId, sourceId, updater, now = new Date()) {
  const source = await loadBackupSource(appDataRoot, targetRoot, machineId, sourceId, now);
  if (!source) {
    throw new Error(`Source not found: ${machineId}/${sourceId}`);
  }
  const next = typeof updater === 'function' ? updater(source) : { ...source, ...updater };
  const merged = createBackupSourceEntry({
    ...source,
    ...next,
    machineId,
    sourceId,
    createdAt: source.createdAt,
    updatedAt: nowIso(now)
  }, now);

  const { sourceStore, statusStore } = createStoreContext(appDataRoot);
  const { definition, status } = splitMergedSource(merged, source.targetId, now);
  await sourceStore.save(definition, now);
  await statusStore.save(status, now);
  return mergeSource(definition, status, now);
}

async function removeBackupSource(appDataRoot, targetRoot, machineId, sourceId, now = new Date()) {
  const source = await loadBackupSource(appDataRoot, targetRoot, machineId, sourceId, now);
  if (!source) {
    throw new Error(`Source not found: ${machineId}/${sourceId}`);
  }
  const { sourceStore, statusStore } = createStoreContext(appDataRoot);
  await sourceStore.remove(sourceId);
  await statusStore.remove(sourceId);
  return source;
}

async function listTargetBackupSources(appDataRoot, targetRoot, now = new Date()) {
  const resolvedTargetRoot = await requireBackupTarget(appDataRoot, targetRoot);
  const schema = await ensureBackupSchema(appDataRoot, {}, now);
  const target = findTarget(schema, resolvedTargetRoot);
  return target ? (target.sources || []).slice().sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)) : [];
}

module.exports = {
  BACKUP_SCHEMA_VERSION,
  addBackupTarget,
  createBackupSchema,
  createBackupSourceEntry,
  createBackupTargetEntry,
  ensureBackupSchema,
  listBackupTargets,
  listTargetBackupSources,
  loadBackupMachine,
  loadBackupSchema,
  loadBackupSource,
  registerBackupSource,
  removeBackupSource,
  removeBackupTarget,
  requireBackupTarget,
  saveBackupMachine,
  saveBackupSchema,
  saveSchemaMigrationMarker,
  setBackupTargetCollapsed,
  updateBackupSource,
  validateBackupSchema
};
