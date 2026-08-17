const fs = require('fs-extra');
const path = require('path');
const { createSetId } = require('./ids');
const { catalogPath } = require('./paths');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const {
  getSourceFolderName,
  getSourceTargetRoot,
  shouldIncludeSourceRoot
} = require('./pathPlanner');
const {
  listTargetBackupSources,
  loadBackupMachine,
  updateBackupSource
} = require('./backupSchema');

const CATALOG_VERSION = 1;

function nowIso(now = new Date()) {
  return now.toISOString();
}

function makeLocator(computerId, sourcePath) {
  if (!computerId || !sourcePath) {
    return null;
  }
  return `${computerId}:${path.resolve(sourcePath)}`;
}

function createEmptyCatalog(now = new Date()) {
  return {
    version: CATALOG_VERSION,
    updatedAt: nowIso(now),
    sets: []
  };
}

function normalizeSeenOnEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const computerId = typeof entry.computerId === 'string' ? entry.computerId.trim() : '';
  const sourcePath = typeof entry.sourcePath === 'string' ? entry.sourcePath.trim() : '';
  if (!computerId || !sourcePath) {
    return null;
  }
  return {
    computerId,
    hostname: typeof entry.hostname === 'string' ? entry.hostname : '',
    sourcePath: path.resolve(sourcePath),
    locator: entry.locator || makeLocator(computerId, sourcePath),
    role: typeof entry.role === 'string' ? entry.role : 'bind',
    at: entry.at || null
  };
}

function normalizeLastBackup(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const computerId = typeof input.computerId === 'string' ? input.computerId.trim() : '';
  if (!computerId) {
    return null;
  }
  return {
    when: input.when || null,
    kind: input.kind === 'changes' ? 'changes' : 'full',
    computerId
  };
}

function normalizeSet(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const setId = typeof input.setId === 'string' ? input.setId.trim() : '';
  if (!setId) {
    return null;
  }
  const origin = input.origin && typeof input.origin === 'object' ? input.origin : {};
  const originComputerId = typeof origin.computerId === 'string' ? origin.computerId.trim() : '';
  const originSourcePath = typeof origin.sourcePath === 'string' ? origin.sourcePath.trim() : '';
  const relativeRoot = typeof input.relativeRoot === 'string' ? input.relativeRoot : '';
  const folderName = typeof input.folderName === 'string' && input.folderName.trim()
    ? input.folderName.trim()
    : (relativeRoot ? path.posix.basename(relativeRoot) : setId);
  return {
    setId,
    folderName,
    relativeRoot,
    includeSourceRoot: input.includeSourceRoot === undefined ? true : Boolean(input.includeSourceRoot),
    targetFolder: typeof input.targetFolder === 'string' ? input.targetFolder : '',
    origin: {
      computerId: originComputerId,
      hostname: typeof origin.hostname === 'string' ? origin.hostname : '',
      sourcePath: originSourcePath ? path.resolve(originSourcePath) : '',
      locator: origin.locator || makeLocator(originComputerId, originSourcePath)
    },
    lastBackup: normalizeLastBackup(input.lastBackup),
    seenOn: Array.isArray(input.seenOn)
      ? input.seenOn.map(normalizeSeenOnEntry).filter(Boolean)
      : []
  };
}

function normalizeCatalog(document, now = new Date()) {
  if (!document || typeof document !== 'object') {
    return createEmptyCatalog(now);
  }
  const sets = Array.isArray(document.sets)
    ? document.sets.map(normalizeSet).filter(Boolean)
    : [];
  return {
    version: CATALOG_VERSION,
    updatedAt: document.updatedAt || nowIso(now),
    sets
  };
}

async function loadCatalog(targetRoot) {
  const document = await readJsonIfExists(catalogPath(targetRoot));
  if (!document) {
    return null;
  }
  return normalizeCatalog(document);
}

async function saveCatalog(targetRoot, catalog, now = new Date()) {
  const normalized = normalizeCatalog({
    ...catalog,
    updatedAt: nowIso(now)
  }, now);
  await fs.ensureDir(path.dirname(catalogPath(targetRoot)));
  await writeJsonAtomic(catalogPath(targetRoot), normalized);
  return normalized;
}

function findSet(catalog, setId) {
  if (!catalog || !setId) {
    return null;
  }
  return (catalog.sets || []).find((set) => set.setId === setId) || null;
}

function mergeSeenOn(existing, incoming) {
  const next = [];
  const seen = new Set();
  for (const entry of [...(existing || []), ...(incoming || [])].map(normalizeSeenOnEntry).filter(Boolean)) {
    const key = `${entry.computerId}:${entry.sourcePath}`;
    if (seen.has(key)) {
      const index = next.findIndex((item) => `${item.computerId}:${item.sourcePath}` === key);
      next[index] = {
        ...next[index],
        ...entry,
        at: entry.at || next[index].at
      };
      continue;
    }
    seen.add(key);
    next.push(entry);
  }
  return next;
}

function setFromSource(source, computer) {
  const computerId = computer?.computerId || '';
  const sourcePath = source.sourcePath;
  return {
    setId: source.setId,
    folderName: getSourceFolderName(source),
    relativeRoot: getSourceTargetRoot(source.machineId, source),
    includeSourceRoot: shouldIncludeSourceRoot(source),
    targetFolder: source.targetFolder || '',
    origin: {
      computerId,
      hostname: computer?.hostname || '',
      sourcePath,
      locator: makeLocator(computerId, sourcePath)
    },
    lastBackup: source.lastBackup || null,
    seenOn: [{
      computerId,
      hostname: computer?.hostname || '',
      sourcePath,
      locator: makeLocator(computerId, sourcePath),
      role: 'origin',
      at: source.createdAt || null
    }]
  };
}

function catalogSetToSource(set) {
  const sourcePath = set.origin?.sourcePath || set.folderName || set.setId;
  return {
    machineId: set.origin?.computerId || 'catalog',
    sourceId: set.setId,
    setId: set.setId,
    sourcePath,
    targetFolder: set.targetFolder || '',
    includeSourceRoot: set.includeSourceRoot,
    relativeRoot: set.relativeRoot,
    folderName: set.folderName,
    watchEnabled: false,
    backupIntervalMinutes: null,
    baselineAt: null,
    watchState: {
      dirtyRef: `watch/${set.setId}.dirty.json`,
      needsRescan: false,
      lastEventAt: null
    },
    backupStatus: {
      status: null,
      mode: null,
      runId: null,
      copiedBytes: 0,
      startedAt: null,
      updatedAt: null,
      completedAt: null,
      cursor: null,
      scanSeq: null,
      error: null
    },
    backupJob: null,
    sourceSizeBytes: null,
    backupSizeBytes: null,
    scanResult: null,
    lastCompletedAt: set.lastBackup?.when || null,
    catalogOffline: true,
    locator: set.origin?.locator || null,
    lastBackup: set.lastBackup
  };
}

async function upsertSet(targetRoot, setInput, now = new Date()) {
  const catalog = await loadCatalog(targetRoot) || createEmptyCatalog(now);
  const incoming = normalizeSet({
    ...setInput,
    setId: setInput.setId || createSetId()
  });
  const existing = findSet(catalog, incoming.setId);
  const merged = existing
    ? {
        ...existing,
        ...incoming,
        origin: existing.origin?.computerId ? existing.origin : incoming.origin,
        lastBackup: incoming.lastBackup || existing.lastBackup,
        seenOn: mergeSeenOn(existing.seenOn, incoming.seenOn)
      }
    : incoming;
  catalog.sets = existing
    ? catalog.sets.map((set) => (set.setId === merged.setId ? merged : set))
    : catalog.sets.concat(merged);
  await saveCatalog(targetRoot, catalog, now);
  return merged;
}

async function clearCatalog(targetRoot) {
  const filePath = catalogPath(targetRoot);
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
  return null;
}

async function removeSet(targetRoot, setId, now = new Date()) {
  if (!setId) {
    return null;
  }
  const catalog = await loadCatalog(targetRoot);
  if (!catalog) {
    return null;
  }
  const existing = findSet(catalog, setId);
  if (!existing) {
    return null;
  }
  catalog.sets = catalog.sets.filter((set) => set.setId !== setId);
  await saveCatalog(targetRoot, catalog, now);
  return existing;
}

async function updateLastBackup(targetRoot, setId, lastBackup, now = new Date()) {
  const catalog = await loadCatalog(targetRoot);
  const set = findSet(catalog, setId);
  if (!set) {
    return null;
  }
  return upsertSet(targetRoot, {
    ...set,
    lastBackup: normalizeLastBackup(lastBackup)
  }, now);
}

async function recordSeenOn(targetRoot, setId, entry, now = new Date()) {
  const catalog = await loadCatalog(targetRoot);
  const set = findSet(catalog, setId);
  if (!set) {
    return null;
  }
  return upsertSet(targetRoot, {
    ...set,
    seenOn: mergeSeenOn(set.seenOn, [entry])
  }, now);
}

async function findLocalSourceBySetId(appDataRoot, targetRoot, setId) {
  if (!setId) {
    return null;
  }
  const sources = await listTargetBackupSources(appDataRoot, targetRoot).catch(() => []);
  return sources.find((source) => source.setId === setId) || null;
}

async function bindSourceToSet(appDataRoot, targetRoot, source, computer, now = new Date()) {
  const setId = source.setId || createSetId();
  const relativeRoot = source.relativeRoot !== undefined && source.relativeRoot !== null
    ? source.relativeRoot
    : getSourceTargetRoot(source.machineId, source);
  const folderName = source.folderName || getSourceFolderName(source);
  let bound = source;
  if (source.setId !== setId || source.relativeRoot !== relativeRoot || source.folderName !== folderName) {
    bound = await updateBackupSource(appDataRoot, targetRoot, source.machineId, source.sourceId, (current) => ({
      ...current,
      setId,
      relativeRoot,
      folderName
    }), now);
  }
  await upsertSet(targetRoot, setFromSource({
    ...bound,
    setId,
    relativeRoot,
    folderName
  }, computer), now);
  return bound;
}

async function seedCatalogFromSources(targetRoot, { sources, computer, appDataRoot, now = new Date() } = {}) {
  let catalog = createEmptyCatalog(now);
  for (const source of sources || []) {
    if (appDataRoot) {
      await bindSourceToSet(appDataRoot, targetRoot, source, computer, now);
    } else {
      const setId = source.setId || createSetId();
      await upsertSet(targetRoot, setFromSource({
        ...source,
        setId,
        relativeRoot: source.relativeRoot !== undefined && source.relativeRoot !== null
          ? source.relativeRoot
          : getSourceTargetRoot(source.machineId, source)
      }, computer), now);
    }
  }
  catalog = await loadCatalog(targetRoot);
  if (!catalog) {
    catalog = await saveCatalog(targetRoot, createEmptyCatalog(now), now);
  }
  return catalog;
}

async function ensureCatalog(targetRoot, { sources, computer, appDataRoot, now = new Date() } = {}) {
  const existing = await loadCatalog(targetRoot);
  if (existing) {
    return existing;
  }
  if ((sources || []).length > 0) {
    return seedCatalogFromSources(targetRoot, {
      sources,
      computer,
      appDataRoot,
      now
    });
  }
  return saveCatalog(targetRoot, createEmptyCatalog(now), now);
}

function createOfflineDashboardSource(set, local) {
  const synthetic = catalogSetToSource(set);
  if (!local) {
    return synthetic;
  }
  return {
    ...local,
    setId: set.setId,
    relativeRoot: set.relativeRoot,
    folderName: set.folderName,
    includeSourceRoot: set.includeSourceRoot,
    targetFolder: set.targetFolder,
    catalogOffline: true,
    locator: set.origin?.locator || local.locator || null,
    lastBackup: set.lastBackup,
    watchEnabled: false
  };
}

async function mergeDashboardSources({ localSources, catalog, computerId } = {}) {
  const locals = localSources || [];
  const sets = catalog?.sets || [];
  const bySetId = new Map();
  for (const local of locals) {
    if (local.setId) {
      bySetId.set(local.setId, local);
    }
  }

  const rows = [];
  const usedLocals = new Set();

  for (const set of sets) {
    const local = bySetId.get(set.setId) || locals.find((source) => (
      !source.setId && getSourceTargetRoot(source.machineId, source) === set.relativeRoot
    )) || null;
    const folderExists = local ? await fs.pathExists(local.sourcePath) : false;
    if (local && folderExists) {
      usedLocals.add(local.sourceId);
      rows.push({
        ...local,
        setId: set.setId,
        relativeRoot: set.relativeRoot,
        folderName: set.folderName,
        locator: makeLocator(computerId, local.sourcePath),
        catalogOffline: false,
        lastBackup: set.lastBackup
      });
      continue;
    }
    if (local) {
      usedLocals.add(local.sourceId);
    }
    rows.push(createOfflineDashboardSource(set, local));
  }

  for (const local of locals) {
    if (usedLocals.has(local.sourceId)) {
      continue;
    }
    const folderExists = await fs.pathExists(local.sourcePath);
    rows.push({
      ...local,
      locator: computerId && local.sourcePath ? makeLocator(computerId, local.sourcePath) : null,
      catalogOffline: !folderExists,
      lastBackup: local.lastBackup || null
    });
  }

  return rows;
}

async function recordCatalogBackup({
  appDataRoot,
  targetRoot,
  source,
  computer,
  kind,
  now = new Date()
}) {
  let bound = source;
  if (appDataRoot) {
    bound = await bindSourceToSet(appDataRoot, targetRoot, source, computer, now);
  } else {
    const setId = source.setId || createSetId();
    await upsertSet(targetRoot, setFromSource({
      ...source,
      setId,
      relativeRoot: source.relativeRoot !== undefined && source.relativeRoot !== null
        ? source.relativeRoot
        : getSourceTargetRoot(source.machineId, source)
    }, computer), now);
    bound = {
      ...source,
      setId
    };
  }
  return updateLastBackup(targetRoot, bound.setId, {
    when: nowIso(now),
    kind: kind === 'incremental' || kind === 'changes' ? 'changes' : 'full',
    computerId: computer?.computerId
  }, now);
}

function sourcePathsEqual(leftPath, rightPath) {
  if (!leftPath || !rightPath) {
    return false;
  }
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

async function wireBindingAfterRestore({
  appDataRoot,
  targetRoot,
  source,
  destinationRoot,
  now = new Date()
}) {
  const machine = await loadBackupMachine(appDataRoot);
  if (!machine) {
    return null;
  }

  let catalog = await loadCatalog(targetRoot);
  let set = findSet(catalog, source.setId) || findSet(catalog, source.sourceId);
  if (!set) {
    const bound = await bindSourceToSet(appDataRoot, targetRoot, source, machine, now);
    catalog = await loadCatalog(targetRoot);
    set = findSet(catalog, bound.setId);
  }
  if (!set) {
    return null;
  }

  const locals = await listTargetBackupSources(appDataRoot, targetRoot).catch(() => []);
  const destMatch = locals.find((entry) => sourcePathsEqual(entry.sourcePath, destinationRoot)) || null;

  await recordSeenOn(targetRoot, set.setId, {
    computerId: machine.computerId,
    hostname: machine.hostname,
    sourcePath: destinationRoot,
    locator: makeLocator(machine.computerId, destinationRoot),
    role: 'restore',
    at: nowIso(now)
  }, now);

  return {
    source: destMatch,
    offerNewSource: !destMatch
  };
}

module.exports = {
  CATALOG_VERSION,
  bindSourceToSet,
  clearCatalog,
  catalogSetToSource,
  createEmptyCatalog,
  ensureCatalog,
  findLocalSourceBySetId,
  findSet,
  loadCatalog,
  makeLocator,
  mergeDashboardSources,
  normalizeCatalog,
  recordCatalogBackup,
  recordSeenOn,
  removeSet,
  saveCatalog,
  seedCatalogFromSources,
  setFromSource,
  updateLastBackup,
  upsertSet,
  wireBindingAfterRestore
};
