#!/usr/bin/env node

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {
  ensureBackupSchema,
  loadBackupSchema,
  saveBackupSchema,
  loadTargetSourceCatalog,
  saveTargetSourceCatalog,
  createBackupTargetEntry
} = require('../src/core/backupSchema');
const {
  fileIndexRoot,
  legacyFileIndexRoot,
  localConfigPath,
  targetMetadataRoot,
  backupSourcesPath
} = require('../src/core/paths');
const { loadLocalConfig, saveLocalConfig } = require('../src/core/localConfig');
const { readJsonIfExists } = require('../src/core/jsonStore');

function parseArgs(argv) {
  const args = {
    appDataRoot: path.resolve(__dirname, '..', 'data'),
    legacyUiPath: path.join(os.homedir(), 'Library', 'Application Support', 'mybackup-electron', 'mybackup-ui.json'),
    targetRoots: [],
    keepLegacyHashes: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app-data-root') {
      args.appDataRoot = path.resolve(argv[++index]);
    } else if (value === '--legacy-ui-path') {
      args.legacyUiPath = path.resolve(argv[++index]);
    } else if (value === '--target') {
      args.targetRoots.push(path.resolve(argv[++index]));
    } else if (value === '--keep-legacy-hashes') {
      args.keepLegacyHashes = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

async function loadLegacyTargets(legacyUiPath) {
  const document = await readJsonIfExists(legacyUiPath);
  if (!document || !Array.isArray(document.targets)) {
    return [];
  }
  return document.targets
    .filter((target) => target && target.path)
    .map((target) => ({
      id: target.id,
      path: path.resolve(target.path),
      collapsed: Boolean(target.collapsed),
      addedAt: target.addedAt || null
    }));
}

async function mergeTargetsIntoSchema(appDataRoot, legacyTargets, now) {
  await ensureBackupSchema(appDataRoot, {}, now);
  const current = await loadBackupSchema(appDataRoot);
  const targetsByPath = new Map((current.targets || []).map((target) => [target.path, target]));

  let changed = false;
  for (const legacyTarget of legacyTargets) {
    const existing = targetsByPath.get(legacyTarget.path);
    if (existing) {
      if (existing.collapsed !== legacyTarget.collapsed || (legacyTarget.id && existing.id !== legacyTarget.id)) {
        targetsByPath.set(legacyTarget.path, createBackupTargetEntry({
          ...existing,
          ...legacyTarget,
          addedAt: existing.addedAt || legacyTarget.addedAt
        }, now));
        changed = true;
      }
      continue;
    }
    targetsByPath.set(legacyTarget.path, createBackupTargetEntry(legacyTarget, now));
    changed = true;
  }

  if (!changed) {
    return { changed: false, targets: current.targets || [] };
  }

  const updated = {
    ...current,
    targets: Array.from(targetsByPath.values()).sort((left, right) => left.path.localeCompare(right.path)),
    updatedAt: now.toISOString()
  };
  await saveBackupSchema(appDataRoot, updated, now);
  return { changed: true, targets: updated.targets };
}

async function buildSourceCatalogFromSourceFiles(targetRoot) {
  const sourcesRoot = path.join(targetMetadataRoot(targetRoot), 'sources');
  if (!(await fs.pathExists(sourcesRoot))) {
    return [];
  }

  const machineEntries = await fs.readdir(sourcesRoot, { withFileTypes: true });
  const sources = [];

  for (const machineEntry of machineEntries) {
    if (!machineEntry.isDirectory()) {
      continue;
    }
    const machineId = machineEntry.name;
    const machineRoot = path.join(sourcesRoot, machineId);
    const sourceEntries = await fs.readdir(machineRoot, { withFileTypes: true });

    for (const sourceEntry of sourceEntries) {
      if (!sourceEntry.isFile() || !sourceEntry.name.endsWith('.json')) {
        continue;
      }
      const sourceId = path.basename(sourceEntry.name, '.json');
      const sourceRecord = await readJsonIfExists(path.join(machineRoot, sourceEntry.name));
      if (!sourceRecord) {
        continue;
      }

      const scanStateRecord = await readJsonIfExists(
        path.join(targetMetadataRoot(targetRoot), 'scans', machineId, sourceId, 'current.json')
      );

      sources.push({
        ...sourceRecord,
        scanState: scanStateRecord ? {
          status: scanStateRecord.status || 'idle',
          activeGeneration: scanStateRecord.activeGeneration || null,
          startedAt: scanStateRecord.startedAt || null,
          completedAt: scanStateRecord.completedAt || null,
          updatedAt: scanStateRecord.updatedAt || nowIso(),
          resumeCursor: scanStateRecord.resumeCursor || null
        } : undefined
      });
    }
  }

  return sources.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

async function migrateTargetSourceCatalog(targetRoot, now) {
  const legacySources = await buildSourceCatalogFromSourceFiles(targetRoot);
  if (legacySources.length === 0) {
    return { changed: false, sourceCount: 0, catalogPath: backupSourcesPath(targetRoot) };
  }

  const currentCatalog = await loadTargetSourceCatalog(targetRoot);
  const currentSources = new Map(((currentCatalog && currentCatalog.sources) || []).map((source) => [
    `${source.machineId}:${source.sourceId}`,
    source
  ]));

  let changed = !(currentCatalog && await fs.pathExists(backupSourcesPath(targetRoot)));
  for (const source of legacySources) {
    const key = `${source.machineId}:${source.sourceId}`;
    const existing = currentSources.get(key);
    if (!existing || JSON.stringify(existing) !== JSON.stringify(source)) {
      currentSources.set(key, source);
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, sourceCount: currentSources.size, catalogPath: backupSourcesPath(targetRoot) };
  }

  await saveTargetSourceCatalog(targetRoot, {
    sources: Array.from(currentSources.values()).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    updatedAt: now.toISOString()
  }, now);

  return { changed: true, sourceCount: currentSources.size, catalogPath: backupSourcesPath(targetRoot) };
}

async function renameLegacyBucketFiles(indexRoot) {
  let renamedBuckets = 0;

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.indx')) {
        continue;
      }
      const nextPath = path.join(currentPath, `${path.basename(entry.name, '.indx')}.index`);
      if (entryPath !== nextPath) {
        await fs.move(entryPath, nextPath, { overwrite: true });
        renamedBuckets += 1;
      }
    }
  }

  if (await fs.pathExists(indexRoot)) {
    await walk(indexRoot);
  }

  return renamedBuckets;
}

async function migrateHashIndex(targetRoot, keepLegacyHashes) {
  const legacyRoot = legacyFileIndexRoot(targetRoot);
  const currentRoot = fileIndexRoot(targetRoot);
  if (!(await fs.pathExists(legacyRoot))) {
    return {
      changed: false,
      movedLegacyRoot: false,
      renamedBuckets: 0,
      legacyRoot,
      currentRoot
    };
  }

  let movedLegacyRoot = false;
  if (!(await fs.pathExists(currentRoot))) {
    await fs.ensureDir(path.dirname(currentRoot));
    await fs.move(legacyRoot, currentRoot, { overwrite: false });
    movedLegacyRoot = true;
  }

  const renamedBuckets = await renameLegacyBucketFiles(currentRoot);

  if (!keepLegacyHashes && !movedLegacyRoot && await fs.pathExists(legacyRoot)) {
    await fs.remove(legacyRoot);
  }

  return {
    changed: true,
    movedLegacyRoot,
    renamedBuckets,
    legacyRoot,
    currentRoot
  };
}

async function migrateLocalConfig(appDataRoot, targetRoots, now) {
  const current = await loadLocalConfig(appDataRoot);
  if (current.targetRoot || targetRoots.length === 0) {
    return { changed: false, targetRoot: current.targetRoot };
  }
  const next = await saveLocalConfig(appDataRoot, { targetRoot: targetRoots[0] }, now);
  return { changed: true, targetRoot: next.targetRoot };
}

async function main() {
  const args = parseArgs(process.argv);
  const now = new Date();

  const legacyTargets = await loadLegacyTargets(args.legacyUiPath);
  const targetRoots = args.targetRoots.length > 0
    ? args.targetRoots
    : legacyTargets.map((target) => target.path);

  const schemaMigration = await mergeTargetsIntoSchema(args.appDataRoot, legacyTargets, now);
  const localConfigMigration = await migrateLocalConfig(args.appDataRoot, targetRoots, now);

  const targetReports = [];
  for (const targetRoot of targetRoots) {
    const sourceCatalog = await migrateTargetSourceCatalog(targetRoot, now);
    const hashIndex = await migrateHashIndex(targetRoot, args.keepLegacyHashes);
    targetReports.push({
      targetRoot,
      sourceCatalog,
      hashIndex
    });
  }

  const report = {
    appDataRoot: args.appDataRoot,
    legacyUiPath: args.legacyUiPath,
    schemaMigration,
    localConfigMigration,
    targets: targetReports
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
