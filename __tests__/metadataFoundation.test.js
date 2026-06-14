const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { createFolderId, createMachineId, createScanId, createSourceId } = require('../src/core/ids');
const {
  backupSchemaPath,
  backupSourcesPath,
  dirtyStatePath,
  runStatePath,
} = require('../src/core/paths');
const {
  configPath,
  errorReportPath,
  hashPath,
  machinePath,
  machineBackupRoot,
  mergedBackupRoot,
  scanCurrentPath,
  sourcePath,
  tempRoot
} = require('../src/core/layout');
const {
  createAppConfig,
  createHashRecord,
  createMachineRecord,
  createSourceRecord: createSourceRecordBase,
  validateHashRecord,
  validateSourceRecord
} = require('../src/core/schema');
const {
  loadFileIndexRecord: loadHashRecord,
  saveFileIndexRecord: saveHashRecord
} = require('../src/core/fileIndex');
const { ensureMachine, updateMachine } = require('../src/core/machineRegistry');
const {
  BACKUP_SCHEMA_VERSION,
  ensureBackupSchema,
  loadBackupSchema,
  loadBackupSource,
  updateBackupSource
} = require('../src/core/backupSchema');
const { createTargetId } = require('../src/core/targetConfig');
const { registerSource: registerSourceBase } = require('../src/core/sourceRegistry');
const { buildConflictPath, getSourceTargetRoot, planLogicalTarget } = require('../src/core/pathPlanner');
const { resolveTargetMapping } = require('../src/core/pathMapper');
const { hashFile } = require('../src/core/hashService');
const { lookupHashRecord, registerHashRecord } = require('../src/core/hashIndex');
const { packHashRecord, unpackHashRecord } = require('../src/core/hashRecordCodec');
const { bucketPath } = require('../src/core/hashBucketLayout');
const { createHashRecordSession } = require('../src/core/hashRecordSession');
const {
  cleanupTempFiles,
  finalizePlainFile,
  restorePlainFile,
  verifyStoredPlainFile,
  writePlainFile
} = require('../src/core/plainFileStorage');
const { backupSource } = require('../src/core/backupCoordinator');
const { buildFolderTraversalStack } = require('../src/core/scanner/folderWalker');
const { parseIgnoreFile, shouldIgnorePath, buildIgnoreRules } = require('../src/core/ignoreMatcher');
const { readJsonIfExists, writeJsonAtomic } = require('../src/core/jsonStore');
const {
  createRunState,
  ensureRunState,
  loadRunState,
  saveRunState,
  validateRunState
} = require('../src/core/runStateStore');
const { createWatchService } = require('../src/core/watch/watchService');
const {
  clearDirtyFolderIfUnchanged,
  ensureDirtyState,
  loadDirtyState,
  markDirtyFolder,
  snapshotDirtyState
} = require('../src/core/watch/dirtyStore');
const { createTargetAvailabilityMonitor, checkTargetAvailability } = require('../src/core/targetAvailability');
const { loadLoggerConfig, parseLoggerProperties } = require('../src/core/loggerConfig');
const {
  createFolderHash,
  walkFoldersFromCursor
} = require('../src/core/cursor');
const {
  restoreLogicalFile,
  restoreLogicalTree,
  restoreSource
} = require('../src/core/restoreService');
const {
  ensureLocalConfig,
  getLocalConfigPath,
  loadLocalConfig,
  normalizeWorkerPools,
  saveLocalConfig
} = require('../src/core/localConfig');
const { addTarget } = require('../src/core/targetRegistry');
const { listSourcesForMachine, loadCurrentMachineContext } = require('../src/core/sourceCatalog');
const { configureLogger, createLogger, formatLogMessage, getLogLevel } = require('../src/core/logger');

describe('metadata foundation', () => {
  let tempRootPath;

  beforeEach(() => {
    tempRootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mybackup-metadata-'));
  });

  afterEach(() => {
    fs.removeSync(tempRootPath);
  });

  function writeFixture(filePath, content) {
    fs.ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, content);
  }

  function withDefaultTargetFolder(input = {}) {
    return {
      ...input,
      targetFolder: input.targetFolder !== undefined
        ? input.targetFolder
        : (input.mergeKey || 'backup')
    };
  }

  function createSourceRecord(input, now) {
    return createSourceRecordBase(withDefaultTargetFolder(input), now);
  }

  async function registerSource(appDataRoot, input, now) {
    return registerSourceBase(appDataRoot, withDefaultTargetFolder(input), now);
  }

  function targetFilePath(targetRoot, source, ...relativeSegments) {
    const relativePath = path.posix.join(...relativeSegments.map((segment) => String(segment)));
    return path.join(targetRoot, getSourceTargetRoot(source.machineId, source), relativePath);
  }

  async function saveLegacyAppConfig(targetRoot, document) {
    await writeJsonAtomic(configPath(targetRoot), document);
  }

  async function loadLegacyAppConfig(targetRoot) {
    return readJsonIfExists(configPath(targetRoot));
  }

  async function saveLegacyMachine(targetRoot, document) {
    await writeJsonAtomic(machinePath(targetRoot, document.machineId), document);
  }

  async function loadLegacyMachine(targetRoot, machineId) {
    return readJsonIfExists(machinePath(targetRoot, machineId));
  }

  async function saveLegacySource(targetRoot, document) {
    await writeJsonAtomic(sourcePath(targetRoot, document.machineId, document.sourceId), document);
  }

  async function loadLegacySource(targetRoot, machineId, sourceId) {
    return readJsonIfExists(sourcePath(targetRoot, machineId, sourceId));
  }

  test('creates stable ids for machine, source, scan, and folder', () => {
    expect(createMachineId('James-MacBook', 'fixed-seed')).toBe('james-macbook-09167cea');
    expect(createSourceId('/Users/James/Documents')).toBe('documents-0cf0ec50');
    expect(createScanId(new Date('2026-06-01T10:11:12Z'))).toBe('20260601-101112');
    expect(createFolderId('taxes/2024')).toBe('2024-980428266e');
  });

  test('builds source records with targetFolder-backed mapping state', () => {
    const separated = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Documents',
      targetFolder: 'work'
    });

    const shared = createSourceRecord({
      machineId: 'machine-b',
      sourcePath: '/Users/James/Documents',
      targetFolder: 'shared'
    });

    expect(separated.targetFolder).toBe('work');
    expect(separated.watchEnabled).toBe(true);
    expect(separated.backupIntervalMinutes).toBeNull();
    expect(separated.baselineAt).toBeNull();
    expect(separated.watchState).toEqual({
      dirtyRef: `watch/${separated.sourceId}.dirty.json`,
      needsRescan: false,
      lastEventAt: null
    });
    expect(shared.cursor).toEqual({
      relativePath: null,
      status: null,
      updatedAt: null
    });
    expect(validateSourceRecord(shared)).toBe(shared);
  });

  test('builds hash records with a future-proof content field', () => {
    const plainRecord = createHashRecord({
      fileHash: 'a'.repeat(64),
      size: 42,
      logicalPath: 'documents/a.txt',
      content: {
        type: 'plain',
        path: 'documents/a.txt'
      },
      origins: [
        {
          machineId: 'machine-a',
          sourceId: 'documents-a82f91c4',
          sourceRelativePath: 'a.txt'
        }
      ]
    });

    const blockRecord = createHashRecord({
      fileHash: 'b'.repeat(64),
      size: 128,
      logicalPath: 'documents/b.txt',
      content: {
        type: 'blocks',
        manifest: '.mybackup/dedupe/files/bb/bb/manifest.json'
      },
      origins: []
    });

    expect(validateHashRecord(plainRecord).content.type).toBe('plain');
    expect(validateHashRecord(blockRecord).content.type).toBe('blocks');
  });

  test('persists all current metadata documents atomically', async () => {
    const appConfig = createAppConfig({ machineId: 'machine-a' }, new Date('2026-06-01T10:00:00Z'));
    const machine = createMachineRecord({
      machineId: 'machine-a',
      displayName: 'Machine A',
      hostname: 'machine-a'
    }, new Date('2026-06-01T10:00:00Z'));
    const source = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Documents',
      targetFolder: 'documents'
    }, new Date('2026-06-01T10:00:00Z'));
    const hashRecord = createHashRecord({
      fileHash: 'c'.repeat(64),
      size: 11,
      logicalPath: 'documents/readme.txt',
      content: {
        type: 'plain',
        path: 'documents/readme.txt'
      },
      origins: []
    }, new Date('2026-06-01T10:00:00Z'));

    await saveLegacyAppConfig(tempRootPath, appConfig);
    await saveLegacyMachine(tempRootPath, machine);
    await saveLegacySource(tempRootPath, source);
    await saveHashRecord(tempRootPath, hashRecord);

    expect(await loadLegacyAppConfig(tempRootPath)).toEqual(appConfig);
    expect(await loadLegacyMachine(tempRootPath, machine.machineId)).toEqual(machine);
    expect(await loadLegacySource(tempRootPath, machine.machineId, source.sourceId)).toEqual(source);
    expect(await loadHashRecord(tempRootPath, hashRecord.fileHash)).toEqual(hashRecord);
  });

  test('writes concurrent hash records in the same shard without temp-file collisions', async () => {
    const records = [
      createHashRecord({
        fileHash: `7e6dd7f0c545d6990b63ae814034786cc575ca36f9077305b094fc35330b3574`,
        size: 11,
        logicalPath: 'documents/a.txt',
        content: {
          type: 'plain',
          path: 'documents/a.txt'
        },
        origins: []
      }, new Date('2026-06-01T10:00:00Z')),
      createHashRecord({
        fileHash: `7e1dd7f0c545d6990b63ae814034786cc575ca36f9077305b094fc35330b3575`,
        size: 22,
        logicalPath: 'documents/b.txt',
        content: {
          type: 'plain',
          path: 'documents/b.txt'
        },
        origins: []
      }, new Date('2026-06-01T10:00:00Z'))
    ];

    await Promise.all(records.map((record) => saveHashRecord(tempRootPath, record)));

    expect(await loadHashRecord(tempRootPath, records[0].fileHash)).toEqual(records[0]);
    expect(await loadHashRecord(tempRootPath, records[1].fileHash)).toEqual(records[1]);
  });

  test('stores hash records in bucket index files with compact rows and legacy read support', async () => {
    const fileHash = `f${'a'.repeat(63)}`;
    const record = createHashRecord({
      fileHash,
      size: 99,
      logicalPath: 'documents/compact.txt',
      content: {
        type: 'plain',
        path: 'documents/compact.txt'
      },
      origins: [{
        machineId: 'machine-a',
        sourceId: 'source-a',
        sourceRelativePath: 'compact.txt',
        discoveredAt: '2026-06-10T10:00:00.000Z'
      }]
    }, new Date('2026-06-10T10:00:00.000Z'));

    await saveHashRecord(tempRootPath, record);
    const bucketFile = bucketPath(tempRootPath, fileHash);
    const raw = await fs.readJson(bucketFile);
    expect(raw.p).toBe(fileHash.slice(0, 15));
    expect(raw.r[0][0]).toBe(fileHash.slice(15));
    expect(await loadHashRecord(tempRootPath, fileHash)).toEqual(record);
    expect(unpackHashRecord(record)).toEqual(record);
    expect(packHashRecord(record).c).toEqual(['p', 'documents/compact.txt']);
  });

  test('buffers hash record updates in bucket memory and flushes one index file', async () => {
    const session = createHashRecordSession(tempRootPath);
    const fileHash = 'e'.repeat(64);
    const now = new Date('2026-06-10T11:00:00.000Z');

    await session.register({
      fileHash,
      size: 10,
      logicalPath: 'documents/a.txt',
      kind: 'file',
      content: {
        type: 'plain',
        path: 'documents/a.txt'
      },
      origin: {
        machineId: 'machine-a',
        sourceId: 'source-a',
        sourceRelativePath: 'a.txt'
      }
    }, now);

    expect(await loadHashRecord(tempRootPath, fileHash)).toBeNull();
    expect(session.snapshot().dirtyBuckets).toBe(1);

    const flushed = await session.flush();
    expect(flushed.writes).toBe(1);
    expect(await fs.pathExists(bucketPath(tempRootPath, fileHash))).toBe(true);
    expect(await lookupHashRecord(tempRootPath, fileHash)).toMatchObject({
      fileHash,
      logicalPath: 'documents/a.txt'
    });
  });

  test('resolves hash bucket paths using three-character tree segments', () => {
    const fileHash = 'abcdefabcdefabc'.padEnd(64, '0');
    expect(bucketPath('/target', fileHash)).toBe(
      path.join('/target', '.mybackup', 'index', 'abc', 'def', 'abc', 'def', 'abc.index')
    );
  });

  test('exposes the metadata path layout explicitly', () => {
    expect(configPath('/target')).toBe(path.join('/target', '.mybackup', 'config.json'));
    expect(backupSourcesPath('/target')).toBe(path.join('/target', '.mybackup', 'backup_source.json'));
    expect(sourcePath('/target', 'machine-a', 'source-a')).toBe(
      path.join('/target', '.mybackup', 'sources', 'machine-a', 'source-a.json')
    );
    expect(hashPath('/target', 'ab'.repeat(32))).toBe(
      path.join('/target', '.mybackup', 'index', 'ab', 'ab', `${'ab'.repeat(32)}.json`)
    );
    expect(scanCurrentPath('/target', 'machine-a', 'source-a')).toBe(
      path.join('/target', '.mybackup', 'scans', 'machine-a', 'source-a', 'current.json')
    );
    expect(machineBackupRoot('machine-a', 'source-a')).toBe('Backups/Machines/machine-a/source-a');
    expect(mergedBackupRoot('documents')).toBe('documents');
    expect(tempRoot('/target')).toBe(path.join('/target', '.mybackup', 'tmp'));
  });

  test('resolves dirty-state paths under local app data', () => {
    expect(dirtyStatePath('/app', 'source-a')).toBe(path.join('/app', 'watch', 'source-a.dirty.json'));
    expect(dirtyStatePath('/app', 'watch/source-a.dirty.json')).toBe(
      path.join('/app', 'watch', 'source-a.dirty.json')
    );
  });

  test('resolves per-target run-state paths under local app data', () => {
    expect(runStatePath('/app', 'target-a', 'source-a')).toBe(
      path.join('/app', 'run', 'target-a', 'source-a.run.json')
    );
  });

  test('creates and persists a per-source dirty state file', async () => {
    const source = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false
    }, new Date('2026-06-10T10:00:00Z'));

    const state = await ensureDirtyState(tempRootPath, source, new Date('2026-06-10T10:00:00Z'));
    expect(state).toEqual({
      version: 1,
      sourceId: source.sourceId,
      lastEventSeq: 0,
      updatedAt: '2026-06-10T10:00:00.000Z',
      folders: {}
    });

    expect(await loadDirtyState(tempRootPath, source)).toEqual(state);
  });

  test('marks dirty folders with monotonic event sequences', async () => {
    const source = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false
    }, new Date('2026-06-10T10:00:00Z'));

    await ensureDirtyState(tempRootPath, source, new Date('2026-06-10T10:00:00Z'));
    await markDirtyFolder(tempRootPath, source, 'IBM/SametimeTranscripts', new Date('2026-06-10T10:01:00Z'));
    const second = await markDirtyFolder(
      tempRootPath,
      source,
      'IBM/SametimeTranscripts/child/',
      new Date('2026-06-10T10:02:00Z')
    );

    expect(second.lastEventSeq).toBe(2);
    expect(second.folders).toEqual({
      'IBM/SametimeTranscripts': {
        seq: 1,
        changedAt: '2026-06-10T10:01:00.000Z'
      },
      'IBM/SametimeTranscripts/child': {
        seq: 2,
        changedAt: '2026-06-10T10:02:00.000Z'
      }
    });
  });

  test('clears a dirty folder only when unchanged since the scan snapshot', async () => {
    const source = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false
    }, new Date('2026-06-10T10:00:00Z'));

    await markDirtyFolder(tempRootPath, source, 'a/b', new Date('2026-06-10T10:01:00Z'));
    await markDirtyFolder(tempRootPath, source, 'a/c', new Date('2026-06-10T10:02:00Z'));

    const snapshot = await snapshotDirtyState(tempRootPath, source, new Date('2026-06-10T10:03:00Z'));
    expect(snapshot.scanSeq).toBe(2);

    const cleared = await clearDirtyFolderIfUnchanged(
      tempRootPath,
      source,
      'a/b',
      snapshot.scanSeq,
      new Date('2026-06-10T10:04:00Z')
    );
    expect(cleared.folders).toEqual({
      'a/c': {
        seq: 2,
        changedAt: '2026-06-10T10:02:00.000Z'
      }
    });

    await markDirtyFolder(tempRootPath, source, 'a/c', new Date('2026-06-10T10:05:00Z'));
    const preserved = await clearDirtyFolderIfUnchanged(
      tempRootPath,
      source,
      'a/c',
      snapshot.scanSeq,
      new Date('2026-06-10T10:06:00Z')
    );
    expect(preserved.folders['a/c']).toEqual({
      seq: 3,
      changedAt: '2026-06-10T10:05:00.000Z'
    });
  });

  test('creates and persists local run state per target and source', async () => {
    const initial = await ensureRunState(
      tempRootPath,
      'target-a',
      'source-a',
      new Date('2026-06-10T11:00:00Z')
    );

    expect(initial).toEqual({
      version: 1,
      targetId: 'target-a',
      sourceId: 'source-a',
      runId: '20260610-110000',
      mode: 'full',
      status: 'idle',
      scanSeq: null,
      copiedBytes: 0,
      pendingFolders: [],
      cursor: null,
      startedAt: null,
      updatedAt: '2026-06-10T11:00:00.000Z',
      completedAt: null
    });

    expect(await loadRunState(tempRootPath, 'target-a', 'source-a')).toEqual(initial);
  });

  test('persists run state with pending folders and cursor', async () => {
    const saved = await saveRunState(
      tempRootPath,
      'target-a',
      'source-a',
      createRunState('target-a', 'source-a', {
        runId: '20260610-111500',
        mode: 'incremental',
        status: 'running',
        scanSeq: 42,
        copiedBytes: 1234,
        pendingFolders: ['a', 'a/b'],
        cursor: {
          backupId: '20260610-111500',
          relativePath: 'a/b'
        },
        startedAt: '2026-06-10T11:15:00.000Z'
      }, new Date('2026-06-10T11:15:00Z')),
      new Date('2026-06-10T11:16:00Z')
    );

    expect(validateRunState(saved)).toBe(saved);
    expect(saved).toMatchObject({
      targetId: 'target-a',
      sourceId: 'source-a',
      runId: '20260610-111500',
      mode: 'incremental',
      status: 'running',
      scanSeq: 42,
      copiedBytes: 1234,
      pendingFolders: ['a', 'a/b'],
      startedAt: '2026-06-10T11:15:00.000Z',
      updatedAt: '2026-06-10T11:16:00.000Z'
    });
    expect(saved.cursor).toMatchObject({
      scanId: '20260610-111500',
      relativePath: 'a/b'
    });
  });

  test('watch service bootstraps enabled sources and marks dirty folders on file events', async () => {
    const targetRoot = path.join(tempRootPath, 'target');
    await addTarget(tempRootPath, targetRoot);
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'watch-host',
      displayName: 'Watch Host',
      platform: 'darwin',
      seed: 'watch-seed',
      now: new Date('2026-06-10T12:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      targetRoot,
      machineId: machine.machineId,
      sourcePath: path.join(tempRootPath, 'watched-source'),
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-10T12:01:00Z'));

    await fs.ensureDir(path.join(source.sourcePath, 'docs'));

    const backendState = {
      sources: [],
      handlers: null,
      stopped: false
    };
    const backend = {
      async sync(sources, handlers) {
        backendState.sources = sources;
        backendState.handlers = handlers;
      },
      async stop() {
        backendState.stopped = true;
      }
    };

    const service = createWatchService('darwin', {
      appDataRoot: tempRootPath,
      backend
    });

    await service.bootstrap();

    expect(backendState.sources).toHaveLength(1);
    expect(backendState.sources[0]).toMatchObject({
      machineId: machine.machineId,
      sourceId: source.sourceId,
      sourcePath: source.sourcePath
    });
    expect(await loadDirtyState(tempRootPath, source)).toMatchObject({
      sourceId: source.sourceId,
      lastEventSeq: 0
    });

    await backendState.handlers.onEvent(backendState.sources[0], {
      eventPath: path.join(source.sourcePath, 'docs', 'a.txt')
    });

    const dirtyState = await loadDirtyState(tempRootPath, source);
    expect(dirtyState.lastEventSeq).toBe(1);
    expect(dirtyState.folders.docs.seq).toBe(1);
    expect(dirtyState.folders.docs.changedAt).toBeTruthy();

    const updatedSource = await loadBackupSource(tempRootPath, targetRoot, machine.machineId, source.sourceId);
    expect(updatedSource.watchState.lastEventAt).not.toBeNull();

    await service.stop();
    expect(backendState.stopped).toBe(true);
  });

  test('watch service marks matching sources as needsRescan on watcher error', async () => {
    const targetRoot = path.join(tempRootPath, 'target');
    await addTarget(tempRootPath, targetRoot);
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'watch-error-host',
      displayName: 'Watch Error Host',
      platform: 'darwin',
      seed: 'watch-error-seed',
      now: new Date('2026-06-10T13:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      targetRoot,
      machineId: machine.machineId,
      sourcePath: path.join(tempRootPath, 'error-source'),
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-10T13:01:00Z'));

    await fs.ensureDir(source.sourcePath);

    const backendState = {
      sources: [],
      handlers: null
    };
    const backend = {
      async sync(sources, handlers) {
        backendState.sources = sources;
        backendState.handlers = handlers;
      },
      async stop() {}
    };

    const service = createWatchService('darwin', {
      appDataRoot: tempRootPath,
      backend
    });

    await service.bootstrap();
    await backendState.handlers.onError(backendState.sources[0], new Error('watch overflow'));

    const updatedSource = await loadBackupSource(tempRootPath, targetRoot, machine.machineId, source.sourceId);
    expect(updatedSource.watchState).toMatchObject({
      needsRescan: true
    });
    expect(updatedSource.watchState.lastEventAt).not.toBeNull();
  });

  test('bootstraps and reuses the local machine identity', async () => {
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'James-MacBook',
      displayName: 'James Laptop',
      platform: 'darwin',
      seed: 'machine-seed',
      now: new Date('2026-06-02T09:00:00Z')
    });

    const schema = await loadBackupSchema(tempRootPath);
    expect(schema.machine.machineId).toBe(machine.machineId);
    expect(machine.machineId).toBe('james-macbook-ffc2a3ac');

    const reused = await ensureMachine(tempRootPath, {
      hostname: 'Different-Hostname',
      displayName: 'Should Not Replace',
      now: new Date('2026-06-03T09:00:00Z')
    });

    expect(reused).toEqual(machine);

    const updated = await updateMachine(tempRootPath, {
      machineId: machine.machineId,
      displayName: 'James Main Laptop'
    }, new Date('2026-06-04T09:00:00Z'));

    expect(updated.displayName).toBe('James Main Laptop');
    expect(updated.hostname).toBe('James-MacBook');
  });

  test('registers and updates source records while preserving completion state', async () => {
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'backup-host',
      displayName: 'Backup Host',
      platform: 'darwin',
      seed: 'seed-a',
      now: new Date('2026-06-02T09:00:00Z')
    });

    const first = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Documents',
      organizeMedia: false,
      mergeEnabled: false
    }, new Date('2026-06-02T09:10:00Z'));

    const scanned = await updateBackupSource(
      tempRootPath,
      tempRootPath,
      machine.machineId,
      first.sourceId,
      (current) => ({
        ...current,
        lastCompletedAt: '2026-06-02T10:00:00Z'
      }),
      new Date('2026-06-02T10:00:00Z')
    );

    const updated = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Documents',
      targetFolder: 'docs-shared'
    }, new Date('2026-06-03T09:10:00Z'));

    expect(updated.sourceId).toBe(first.sourceId);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.targetFolder).toBe('docs-shared');
    expect(updated.watchState.dirtyRef).toBe(`watch/${updated.sourceId}.dirty.json`);
    expect(updated.lastCompletedAt).toBe(scanned.lastCompletedAt);
  });

  test('plans logical target paths under targetFolder and source folder name', async () => {
    const source = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Documents',
      targetFolder: 'work'
    });

    expect(getSourceTargetRoot('machine-a', source)).toBe('work/Documents');

    expect(planLogicalTarget({
      machineId: 'machine-a',
      source,
      sourceRelativePath: 'taxes/2024.pdf'
    })).toBe('work/Documents/taxes/2024.pdf');

    expect(buildConflictPath('work/Documents/taxes/2024.pdf', 'machine-b', 'documents-abc12345'))
      .toBe('work/Documents/taxes/2024 [machine-b-documents-abc12345].pdf');

    expect(resolveTargetMapping({
      machineId: 'machine-a',
      source,
      sourceRelativePath: 'taxes/2024.pdf'
    })).toMatchObject({
      logicalPath: 'work/Documents/taxes/2024.pdf',
      sourceTargetRoot: 'work/Documents',
      mappingMode: 'direct',
      decided: true
    });
  });

  test('hashes a file and creates the first hash index record', async () => {
    const sourceFile = path.join(tempRootPath, 'fixtures', 'note.txt');
    writeFixture(sourceFile, 'personal backup note');

    const fileHash = await hashFile(sourceFile);
    expect(fileHash).toBe('efda538a0f26b10a4903d6de78e755c2b324826b133f3200f2ef61c054035b7e');

    const created = await registerHashRecord(tempRootPath, {
      fileHash,
      size: 20,
      logicalPath: 'Backups/Machines/machine-a/documents-a82f91c4/note.txt',
      kind: 'file',
      content: {
        type: 'plain',
        path: 'Backups/Machines/machine-a/documents-a82f91c4/note.txt'
      },
      origin: {
        machineId: 'machine-a',
        sourceId: 'documents-a82f91c4',
        sourceRelativePath: 'note.txt'
      }
    }, new Date('2026-06-06T08:00:00Z'));

    expect(created.status).toBe('created');
    expect(created.record.logicalPath).toBe('Backups/Machines/machine-a/documents-a82f91c4/note.txt');
    expect(created.record.aliases).toEqual([]);
    expect(created.record.origins).toHaveLength(1);

    const loaded = await lookupHashRecord(tempRootPath, fileHash);
    expect(loaded).toEqual(created.record);
  });

  test('updates hash records by adding origins and logical-path aliases without duplicates', async () => {
    const fileHash = 'd'.repeat(64);

    await registerHashRecord(tempRootPath, {
      fileHash,
      size: 42,
      logicalPath: 'documents/report.txt',
      kind: 'file',
      content: {
        type: 'plain',
        path: 'documents/report.txt'
      },
      origin: {
        machineId: 'machine-a',
        sourceId: 'documents-a82f91c4',
        sourceRelativePath: 'report.txt'
      }
    }, new Date('2026-06-06T09:00:00Z'));

    const secondOrigin = await registerHashRecord(tempRootPath, {
      fileHash,
      size: 42,
      logicalPath: 'documents/report.txt',
      kind: 'file',
      content: {
        type: 'plain',
        path: 'documents/report.txt'
      },
      origin: {
        machineId: 'machine-b',
        sourceId: 'documents-b91d20ff',
        sourceRelativePath: 'report.txt'
      }
    }, new Date('2026-06-06T09:05:00Z'));

    expect(secondOrigin.status).toBe('updated');
    expect(secondOrigin.originStatus).toBe('origin-added');
    expect(secondOrigin.pathStatus).toBe('existing-path');
    expect(secondOrigin.record.origins).toHaveLength(2);

    const alias = await registerHashRecord(tempRootPath, {
      fileHash,
      size: 42,
      logicalPath: 'Backups/Machines/machine-b/documents-b91d20ff/report.txt',
      kind: 'file',
      content: {
        type: 'plain',
        path: 'documents/report.txt'
      },
      origin: {
        machineId: 'machine-b',
        sourceId: 'documents-b91d20ff',
        sourceRelativePath: 'report.txt'
      }
    }, new Date('2026-06-06T09:10:00Z'));

    expect(alias.status).toBe('updated');
    expect(alias.pathStatus).toBe('alias-added');
    expect(alias.originStatus).toBe('existing-origin');
    expect(alias.record.aliases).toEqual(['Backups/Machines/machine-b/documents-b91d20ff/report.txt']);

    const unchanged = await registerHashRecord(tempRootPath, {
      fileHash,
      size: 42,
      logicalPath: 'Backups/Machines/machine-b/documents-b91d20ff/report.txt',
      kind: 'file',
      content: {
        type: 'plain',
        path: 'documents/report.txt'
      },
      origin: {
        machineId: 'machine-b',
        sourceId: 'documents-b91d20ff',
        sourceRelativePath: 'report.txt'
      }
    }, new Date('2026-06-06T09:15:00Z'));

    expect(unchanged.status).toBe('unchanged');
    expect(unchanged.record.origins).toHaveLength(2);
    expect(unchanged.record.aliases).toHaveLength(1);
  });

  test('writes a plain file through temp storage, verifies it, and finalizes it', async () => {
    const sourceFile = path.join(tempRootPath, 'fixtures', 'report.txt');
    const sourceContent = 'backup content for v1 plain writer';
    writeFixture(sourceFile, sourceContent);
    const expectedHash = await hashFile(sourceFile);

    const pendingWrite = await writePlainFile(tempRootPath, {
      sourcePath: sourceFile,
      logicalPath: 'Backups/Machines/machine-a/source-a/report.txt',
      expectedHash,
      expectedSize: Buffer.byteLength(sourceContent),
      jobId: 'job-1'
    });

    expect(await fs.pathExists(pendingWrite.tempPath)).toBe(true);
    expect(await fs.pathExists(pendingWrite.finalPath)).toBe(false);

    const contentRef = await finalizePlainFile(tempRootPath, pendingWrite);
    expect(contentRef).toEqual({
      type: 'plain',
      path: 'Backups/Machines/machine-a/source-a/report.txt'
    });
    expect(await fs.pathExists(pendingWrite.tempPath)).toBe(false);
    expect(await fs.pathExists(pendingWrite.finalPath)).toBe(true);
    expect(await fs.readFile(pendingWrite.finalPath, 'utf8')).toBe(sourceContent);
    expect(await verifyStoredPlainFile(tempRootPath, contentRef, expectedHash, Buffer.byteLength(sourceContent))).toBe(true);
  });

  test('reports chunked copy progress while writing a plain file', async () => {
    const sourceFile = path.join(tempRootPath, 'fixtures', 'large.bin');
    const sourceContent = Buffer.alloc(64 * 1024, 7);
    fs.ensureDirSync(path.dirname(sourceFile));
    fs.writeFileSync(sourceFile, sourceContent);
    const expectedHash = await hashFile(sourceFile);
    const progressEvents = [];

    const pendingWrite = await writePlainFile(tempRootPath, {
      sourcePath: sourceFile,
      logicalPath: 'Backups/Machines/machine-a/source-a/large.bin',
      expectedHash,
      expectedSize: sourceContent.length,
      jobId: 'job-progress',
      chunkSize: 8 * 1024,
      onProgress: (entry) => progressEvents.push(entry)
    });

    expect(progressEvents.length).toBeGreaterThan(1);
    expect(progressEvents[progressEvents.length - 1].copiedBytes).toBe(sourceContent.length);

    await finalizePlainFile(tempRootPath, pendingWrite);
  });

  test('preserves source mtime on finalized plain files', async () => {
    const sourceFile = path.join(tempRootPath, 'fixtures', 'mtime.txt');
    writeFixture(sourceFile, 'mtime content');
    const sourceMtime = new Date('2026-06-13T03:04:05.000Z');
    fs.utimesSync(sourceFile, sourceMtime, sourceMtime);
    const expectedHash = await hashFile(sourceFile);

    const pendingWrite = await writePlainFile(tempRootPath, {
      sourcePath: sourceFile,
      logicalPath: 'Backups/Machines/machine-a/source-a/mtime.txt',
      expectedHash,
      expectedSize: Buffer.byteLength('mtime content'),
      jobId: 'job-mtime'
    });

    const contentRef = await finalizePlainFile(tempRootPath, pendingWrite);
    const targetStat = await fs.stat(path.join(tempRootPath, contentRef.path));

    expect(Math.abs(targetStat.mtimeMs - sourceMtime.getTime())).toBeLessThanOrEqual(2);
  });

  test('finalizePlainFile treats an identical existing destination as success', async () => {
    const sourceFile = path.join(tempRootPath, 'fixtures', 'dup.txt');
    writeFixture(sourceFile, 'duplicate content');
    const expectedHash = await hashFile(sourceFile);

    const firstWrite = await writePlainFile(tempRootPath, {
      sourcePath: sourceFile,
      logicalPath: 'Backups/Machines/machine-a/source-a/dup.txt',
      expectedHash,
      expectedSize: Buffer.byteLength('duplicate content'),
      jobId: 'job-dup-1'
    });
    await finalizePlainFile(tempRootPath, firstWrite);

    const secondWrite = await writePlainFile(tempRootPath, {
      sourcePath: sourceFile,
      logicalPath: 'Backups/Machines/machine-a/source-a/dup.txt',
      expectedHash,
      expectedSize: Buffer.byteLength('duplicate content'),
      jobId: 'job-dup-2'
    });

    expect(await finalizePlainFile(tempRootPath, secondWrite)).toEqual({
      type: 'plain',
      path: 'Backups/Machines/machine-a/source-a/dup.txt'
    });
  });

  test('readJsonIfExists tolerates ENOENT after existence check', async () => {
    const filePath = path.join(tempRootPath, 'volatile.json');
    const pathExistsSpy = jest.spyOn(fs, 'pathExists').mockResolvedValue(true);
    const readJsonSpy = jest.spyOn(fs, 'readJson').mockRejectedValue(Object.assign(new Error('missing'), {
      code: 'ENOENT'
    }));

    await expect(readJsonIfExists(filePath)).resolves.toBeNull();

    pathExistsSpy.mockRestore();
    readJsonSpy.mockRestore();
  });

  test('detects unavailable backup targets on startup', async () => {
    const mountedVolumes = new Set(['/Volumes/BackupDrive']);

    expect(checkTargetAvailability('/Volumes/BackupDrive/Archive', mountedVolumes, 'darwin')).toEqual({
      available: true,
      unavailableReason: null,
      mountPath: '/Volumes/BackupDrive'
    });

    expect(checkTargetAvailability('/Volumes/MissingDrive/Archive', mountedVolumes, 'darwin')).toMatchObject({
      available: false,
      mountPath: '/Volumes/MissingDrive'
    });

    const monitor = createTargetAvailabilityMonitor('darwin');
    await expect(monitor.buildTargetDashboardEntry({
      id: 'target-1',
      path: '/Volumes/MissingDrive/Archive',
      collapsed: false,
      addedAt: '2026-06-09T10:00:00Z'
    })).resolves.toMatchObject({
      available: false,
      machine: null,
      sources: []
    });
  });

  test('reloads backup sources when a revived target becomes available', async () => {
    jest.resetModules();

    const loadCurrentMachineContext = jest.fn()
      .mockResolvedValueOnce({
        machine: { machineId: 'machine-a' },
        sources: []
      })
      .mockResolvedValueOnce({
        machine: { machineId: 'machine-a' },
        sources: [
          {
            machineId: 'machine-a',
            sourceId: 'documents-0cf0ec50',
            sourcePath: '/Users/James/Documents',
            targetSubdir: 'Backups/Machines/machine-a/documents-0cf0ec50',
            mergeEnabled: false,
            mergeKey: null,
            organizeMedia: false,
            lastCompletedAt: '2026-06-05T09:05:00.000Z',
            cursor: {
              relativePath: 'docs',
              status: 'paused',
              updatedAt: '2026-06-05T09:05:00.000Z'
            }
          }
        ]
      });

    jest.doMock('electron', () => ({
      app: {
        on: jest.fn(),
        removeListener: jest.fn(),
        getPath: jest.fn(() => tempRootPath),
        getName: jest.fn(() => 'mybackup-electron')
      },
      powerMonitor: {
        on: jest.fn(),
        removeListener: jest.fn()
      }
    }));

    jest.doMock('../src/core/sourceCatalog', () => ({
      loadCurrentMachineContext
    }));

    jest.doMock('../src/core/logger', () => ({
      createLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      })
    }));

    const { buildTargetDashboardEntry: buildRevivedTargetDashboardEntry } = require('../src/core/targetAvailability');
    const entry = await buildRevivedTargetDashboardEntry(
      {
        id: 'target-1',
        path: '/Volumes/5T/Backup',
        collapsed: false,
        addedAt: '2026-06-05T09:00:00.000Z'
      },
      'darwin',
      new Set(['/Volumes/5T'])
    );

    expect(loadCurrentMachineContext).toHaveBeenCalledTimes(2);
    expect(entry.available).toBe(true);
    expect(entry.machine).toEqual({ machineId: 'machine-a' });
    expect(entry.sources).toHaveLength(1);
    expect(entry.sources[0]).toMatchObject({
      machineId: 'machine-a',
      sourceId: 'documents-0cf0ec50',
      sourcePath: '/Users/James/Documents'
    });
  });

  test('restores a stored plain file and cleans temp files', async () => {
    const sourceFile = path.join(tempRootPath, 'fixtures', 'photo.txt');
    writeFixture(sourceFile, 'restorable content');
    const expectedHash = await hashFile(sourceFile);

    const pendingWrite = await writePlainFile(tempRootPath, {
      sourcePath: sourceFile,
      logicalPath: 'Backups/Machines/machine-a/source-a/photo.txt',
      expectedHash,
      expectedSize: Buffer.byteLength('restorable content'),
      jobId: 'job-2'
    });
    const contentRef = await finalizePlainFile(tempRootPath, pendingWrite);

    const restorePath = path.join(tempRootPath, 'restore', 'photo.txt');
    await restorePlainFile(tempRootPath, contentRef, restorePath);
    expect(await fs.readFile(restorePath, 'utf8')).toBe('restorable content');

    const danglingWrite = await writePlainFile(tempRootPath, {
      sourcePath: sourceFile,
      logicalPath: 'Backups/Machines/machine-a/source-a/temp-only.txt',
      expectedHash,
      expectedSize: Buffer.byteLength('restorable content'),
      jobId: 'job-3'
    });

    expect(await fs.pathExists(danglingWrite.tempPath)).toBe(true);
    expect(await cleanupTempFiles(tempRootPath)).toBe(1);
    expect(await fs.pathExists(danglingWrite.tempPath)).toBe(false);
  });

  test('backs up one source end-to-end and completes its scan generation', async () => {
    const sourceRoot = path.join(tempRootPath, 'source-a');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'docs', 'b.txt'), 'beta');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'coord-host',
      seed: 'coord-seed',
      now: new Date('2026-06-07T08:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-07T08:05:00Z'));

    const summary = await backupSource(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      { now: new Date('2026-06-07T08:10:00Z'), forceNewScan: true }
    );

    expect(summary.foldersProcessed).toBe(2);
    expect(summary.filesProcessed).toBe(2);
    expect(summary.filesCopied).toBe(2);
    expect(summary.filesIndexed).toBe(0);

    const targetFile = targetFilePath(tempRootPath, source, 'docs', 'a.txt');
    expect(await fs.readFile(targetFile, 'utf8')).toBe('alpha');

    const runState = await loadRunState(tempRootPath, createTargetId(tempRootPath), source.sourceId);
    expect(runState.status).toBe('completed');
    expect(runState.runId).toBe(summary.scanId);
    expect(runState.copiedBytes).toBe(9);

    const updatedSource = await loadBackupSource(tempRootPath, tempRootPath, machine.machineId, source.sourceId);
    expect(updatedSource.lastCompletedAt).toBe('2026-06-07T08:10:00.000Z');
    expect(updatedSource.sourceSizeBytes).toBe(9);
    expect(updatedSource.backupSizeBytes).toBe(9);
  });

  test('pauses a backup run at a folder boundary and preserves resumable scan state', async () => {
    const sourceRoot = path.join(tempRootPath, 'pause-source');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'docs', 'b.txt'), 'beta');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'pause-host',
      seed: 'pause-seed',
      now: new Date('2026-06-07T08:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-07T08:05:00Z'));

    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T08:10:00Z'),
      forceNewScan: true,
      shouldPause: (() => {
        let seen = false;
        return () => {
          if (seen) {
            return true;
          }
          seen = true;
          return false;
        };
      })()
    });

    expect(summary.status).toBe('paused');
    const context = await loadCurrentMachineContext(tempRootPath);
    expect(context.sources[0].cursor).toMatchObject({
      relativePath: '.',
      status: 'paused'
    });
    const runState = await loadRunState(tempRootPath, createTargetId(tempRootPath), source.sourceId);
    expect(runState.status).toBe('paused');
    expect(runState.cursor).toMatchObject({
      relativePath: '.'
    });
    expect(runState.copiedBytes).toBe(0);
  });

  test('pauses an in-flight copy as soon as possible and cleans up temp files', async () => {
    const sourceRoot = path.join(tempRootPath, 'pause-active-copy-source');
    const largeBuffer = Buffer.alloc(8 * 1024 * 1024, 'a');
    writeFixture(path.join(sourceRoot, 'docs', 'big.bin'), largeBuffer);

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'pause-active-copy-host',
      seed: 'pause-active-copy-seed',
      now: new Date('2026-06-09T09:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-09T09:05:00Z'));

    let pauseRequested = false;
    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-09T09:10:00Z'),
      forceNewScan: true,
      stageChunkSize: 64 * 1024,
      shouldPause: () => pauseRequested,
      onProgress: (payload) => {
        if (payload.event?.type === 'file-progress' && payload.progress?.status === 'running') {
          pauseRequested = true;
        }
      }
    });

    expect(summary.status).toBe('paused');
    expect(summary.filesCopied).toBe(0);
    expect(await cleanupTempFiles(tempRootPath)).toBe(0);
    expect(await fs.pathExists(path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'docs',
      'big.bin'
    ))).toBe(false);
  });

  test('backup start removes stale temp debris from previous crash', async () => {
    const sourceRoot = path.join(tempRootPath, 'cleanup-stale-source');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');
    fs.ensureDirSync(tempRoot(tempRootPath));
    fs.writeFileSync(path.join(tempRoot(tempRootPath), 'stale-copy.tmp'), 'stale');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'cleanup-stale-host',
      seed: 'cleanup-stale-seed',
      now: new Date('2026-06-09T10:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-09T10:05:00Z'));

    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-09T10:10:00Z'),
      forceNewScan: true
    });

    expect(summary.status).toBe('completed');
    expect(summary.recoveredTempFiles).toBe(1);
    expect(await cleanupTempFiles(tempRootPath)).toBe(0);
  });

  test('resumes a paused backup run and continues into copy work', async () => {
    const events = [];
    configureLogger({
      level: 'info',
      sink: (record) => events.push(record),
      moduleLevels: {}
    });

    const sourceRoot = path.join(tempRootPath, 'resume-source');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'docs', 'b.txt'), 'beta');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'resume-copy-host',
      seed: 'resume-copy-seed',
      now: new Date('2026-06-07T08:30:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-07T08:35:00Z'));

    const paused = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T08:40:00Z'),
      forceNewScan: true,
      shouldPause: (() => {
        let seenRootBoundary = false;
        return () => {
          if (seenRootBoundary) {
            return true;
          }
          seenRootBoundary = true;
          return false;
        };
      })()
    });

    expect(paused.status).toBe('paused');
    expect(paused.filesCopied).toBe(0);
    const pausedRunState = await loadRunState(tempRootPath, createTargetId(tempRootPath), source.sourceId);
    expect(pausedRunState.status).toBe('paused');
    expect(pausedRunState.copiedBytes).toBe(0);

    events.length = 0;

    const resumed = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T08:50:00Z')
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.filesCopied).toBe(2);
    expect(resumed.filesProcessed).toBeGreaterThanOrEqual(2);
    expect(events.some((entry) => entry.module === 'FolderWalker' && entry.message === 'Built resume traversal stack from cursor.')).toBe(true);
    expect(events.some((entry) => entry.module === 'BackupCoordinator' && entry.message === 'Processing folder from traversal stack.')).toBe(true);
    expect(events.some((entry) => entry.module === 'BackupCoordinator' && entry.message === 'First file task started.')).toBe(true);
  });

  test('walks source folders from a saved resume cursor without checkpoint lookup', async () => {
    const sourceRoot = path.join(tempRootPath, 'cursor-source');
    writeFixture(path.join(sourceRoot, 'a', 'a1', 'file.txt'), 'a1');
    writeFixture(path.join(sourceRoot, 'b', 'file.txt'), 'b');

    const cursor = {
      folderHash: createFolderHash('a'),
      relativePath: 'a'
    };

    const folders = [];
    for await (const folder of walkFoldersFromCursor(sourceRoot, cursor)) {
      folders.push(folder.relativePath);
    }

    expect(folders).toEqual(['a', 'a/a1', 'b']);
  });

  test('resumes paused backup using the schema-backed source cursor', async () => {
    const sourceRoot = path.join(tempRootPath, 'resume-cursor-source');
    writeFixture(path.join(sourceRoot, 'a', 'one.txt'), 'one');
    writeFixture(path.join(sourceRoot, 'b', 'two.txt'), 'two');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'resume-cursor-host',
      seed: 'resume-cursor-seed',
      now: new Date('2026-06-07T08:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-07T08:05:00Z'));

    const paused = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T08:10:00Z'),
      forceNewScan: true,
      shouldPause: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls > 1;
        };
      })()
    });

    expect(paused.status).toBe('paused');
    const pausedSource = await loadBackupSource(tempRootPath, tempRootPath, machine.machineId, source.sourceId);
    expect(pausedSource.cursor.relativePath).toBe('.');
    expect(pausedSource.cursor.status).toBe('paused');
    const pausedRunState = await loadRunState(tempRootPath, createTargetId(tempRootPath), source.sourceId);
    expect(pausedRunState.status).toBe('paused');
    expect(pausedRunState.cursor.relativePath).toBe('.');
    expect(pausedRunState.cursor.folderHash).toBe(createFolderHash('.'));

    const completed = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T08:20:00Z')
    });

    expect(completed.status).toBe('completed');
    expect(completed.scanId).toBe(paused.scanId);
    expect(completed.filesCopied).toBe(2);
    const completedRunState = await loadRunState(tempRootPath, createTargetId(tempRootPath), source.sourceId);
    expect(completedRunState.status).toBe('completed');
    expect(completedRunState.copiedBytes).toBe(6);

    const completedSource = await loadBackupSource(tempRootPath, tempRootPath, machine.machineId, source.sourceId);
    expect(completedSource.cursor).toEqual({
      relativePath: null,
      status: null,
      updatedAt: null
    });
    const completedRunStateAfterCleanup = await loadRunState(tempRootPath, createTargetId(tempRootPath), source.sourceId);
    expect(completedRunStateAfterCleanup.status).toBe('completed');
    expect(completedRunStateAfterCleanup.cursor).toBeNull();

    expect(await fs.readFile(targetFilePath(tempRootPath, source, 'a', 'one.txt'), 'utf8')).toBe('one');
    expect(await fs.readFile(targetFilePath(tempRootPath, source, 'b', 'two.txt'), 'utf8')).toBe('two');
  });

  test('second backup skips unchanged files and overwrites changed files for separated sources', async () => {
    const sourceRoot = path.join(tempRootPath, 'incremental-source');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'docs', 'b.txt'), 'beta-v1');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'incremental-host',
      seed: 'incremental-seed',
      now: new Date('2026-06-07T09:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-07T09:05:00Z'));

    await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T09:10:00Z'),
      forceNewScan: true
    });

    writeFixture(path.join(sourceRoot, 'docs', 'b.txt'), 'beta-v2');
    fs.utimesSync(
      path.join(sourceRoot, 'docs', 'b.txt'),
      new Date('2026-06-07T09:20:00Z'),
      new Date('2026-06-07T09:20:00Z')
    );

    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T09:30:00Z'),
      forceNewScan: true
    });

    expect(summary.filesCopied).toBe(1);
    expect(summary.filesIndexed).toBe(0);
    expect(await fs.readFile(targetFilePath(tempRootPath, source, 'docs', 'b.txt'), 'utf8')).toBe('beta-v2');
  });

  test('legacy source without total size forces a full backup even when baseline exists', async () => {
    const sourceRoot = path.join(tempRootPath, 'legacy-size-source');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'legacy-size-host',
      seed: 'legacy-size-seed',
      now: new Date('2026-06-11T09:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-11T09:05:00Z'));

    await updateBackupSource(
      tempRootPath,
      tempRootPath,
      machine.machineId,
      source.sourceId,
      (current) => ({
        ...current,
        baselineAt: '2026-06-10T08:00:00.000Z',
        sourceSizeBytes: null,
        backupSizeBytes: null,
        watchState: {
          ...(current.watchState || {}),
          needsRescan: false
        }
      }),
      new Date('2026-06-11T09:06:00Z')
    );

    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-11T09:10:00Z'),
      forceNewScan: false
    });

    expect(summary.filesCopied).toBe(1);
    const runState = await loadRunState(tempRootPath, createTargetId(tempRootPath), source.sourceId);
    expect(runState.mode).toBe('full');
    const updatedSource = await loadBackupSource(tempRootPath, tempRootPath, machine.machineId, source.sourceId);
    expect(updatedSource.sourceSizeBytes).toBe(5);
    expect(updatedSource.backupSizeBytes).toBe(5);
  });

  test('parses .mbignore rules for directory, glob, and negation matching', () => {
    const rules = parseIgnoreFile(`
# dev caches
node_modules/
dist/**
*.log
!keep.log
    `);

    expect(shouldIgnorePath(rules, 'node_modules', true)).toBe(true);
    expect(shouldIgnorePath(rules, 'packages/app/node_modules', true)).toBe(true);
    expect(shouldIgnorePath(rules, 'dist/app.js', false)).toBe(true);
    expect(shouldIgnorePath(rules, 'logs/build.log', false)).toBe(true);
    expect(shouldIgnorePath(rules, 'keep.log', false)).toBe(false);
  });

  test('applies default library ignore patterns without a .mbignore file', () => {
    const rules = buildIgnoreRules('');

    expect(shouldIgnorePath(rules, 'node_modules', true)).toBe(true);
    expect(shouldIgnorePath(rules, 'packages/app/node_modules', true)).toBe(true);
    expect(shouldIgnorePath(rules, 'vendor', true)).toBe(true);
    expect(shouldIgnorePath(rules, 'project/.git', true)).toBe(true);
    expect(shouldIgnorePath(rules, '.DS_Store', false)).toBe(true);
    expect(shouldIgnorePath(rules, 'folder/.DS_Store', false)).toBe(true);
    expect(shouldIgnorePath(rules, '._metadata', false)).toBe(true);
    expect(shouldIgnorePath(rules, 'Thumbs.db', false)).toBe(true);
    expect(shouldIgnorePath(rules, 'Desktop.ini', false)).toBe(true);
    expect(shouldIgnorePath(rules, 'docs/readme.txt', false)).toBe(false);
  });

  test('backupSource skips node_modules by default even without .mbignore', async () => {
    const sourceRoot = path.join(tempRootPath, 'default-ignore-source');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'node_modules', 'pkg', 'index.js'), 'ignored');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'default-ignore-host',
      seed: 'default-ignore-seed',
      now: new Date('2026-06-09T12:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-09T12:05:00Z'));

    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-09T12:10:00Z'),
      forceNewScan: true
    });

    expect(summary.filesProcessed).toBe(1);
    expect(await fs.pathExists(targetFilePath(tempRootPath, source, 'docs', 'a.txt'))).toBe(true);
    expect(await fs.pathExists(path.join(tempRootPath, getSourceTargetRoot(source.machineId, source), 'node_modules'))).toBe(false);
  });

  test('backupSource skips files and folders matched by .mbignore', async () => {
    const sourceRoot = path.join(tempRootPath, 'ignore-source');
    writeFixture(path.join(sourceRoot, '.mbignore'), 'node_modules/\n*.log\n!keep.log\n');
    writeFixture(path.join(sourceRoot, 'docs', 'keep.log'), 'keep this');
    writeFixture(path.join(sourceRoot, 'docs', 'drop.log'), 'drop this');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'node_modules', 'pkg', 'index.js'), 'ignored');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'ignore-host',
      seed: 'ignore-seed',
      now: new Date('2026-06-09T11:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-09T11:05:00Z'));

    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-09T11:10:00Z'),
      forceNewScan: true
    });

    expect(summary.filesProcessed).toBe(2);
    expect(await fs.pathExists(targetFilePath(tempRootPath, source, 'docs', 'a.txt'))).toBe(true);
    expect(await fs.pathExists(targetFilePath(tempRootPath, source, 'docs', 'keep.log'))).toBe(true);
    expect(await fs.pathExists(targetFilePath(tempRootPath, source, 'docs', 'drop.log'))).toBe(false);
    expect(await fs.pathExists(path.join(tempRootPath, getSourceTargetRoot(source.machineId, source), 'node_modules'))).toBe(false);
  });

  test('backupSource continues when a discovered folder disappears before scandir', async () => {
    const sourceRoot = path.join(tempRootPath, 'volatile-folder-source');
    writeFixture(path.join(sourceRoot, 'keep', 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'vanish', 'b.txt'), 'beta');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'volatile-folder-host',
      seed: 'volatile-folder-seed',
      now: new Date('2026-06-09T12:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-09T12:05:00Z'));

    let removed = false;
    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-09T12:10:00Z'),
      forceNewScan: true,
      onProgress: (payload) => {
        if (!removed && payload.event.type === 'folder-completed' && payload.event.relativePath === '.') {
          removed = true;
          fs.removeSync(path.join(sourceRoot, 'vanish'));
        }
      }
    });

    expect(summary.skippedFolders).toBe(1);
    expect(await fs.pathExists(targetFilePath(tempRootPath, source, 'keep', 'a.txt'))).toBe(true);
  });

  test('backupSource writes an error report and continues after a file failure', async () => {
    const sourceRoot = path.join(tempRootPath, 'error-report-source');
    const goodFile = path.join(sourceRoot, 'docs', 'good.txt');
    const badFile = path.join(sourceRoot, 'docs', 'bad.txt');
    writeFixture(goodFile, 'alpha');
    writeFixture(badFile, 'beta');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'error-report-host',
      seed: 'error-report-seed',
      now: new Date('2026-06-09T13:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-09T13:05:00Z'));

    const originalStat = fs.stat;
    const statSpy = jest.spyOn(fs, 'stat');
    statSpy.mockImplementation(async (candidatePath, ...rest) => {
      if (String(candidatePath) === badFile) {
        const error = new Error('mock failure');
        error.code = 'EACCES';
        throw error;
      }
      return originalStat.call(fs, candidatePath, ...rest);
    });

    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-09T13:10:00Z'),
      forceNewScan: true
    });

    statSpy.mockRestore();

    expect(summary.errors).toBe(1);
    expect(summary.reportPath).toBe(errorReportPath(tempRootPath, machine.machineId, source.sourceId, summary.scanId));
    expect(await fs.pathExists(targetFilePath(tempRootPath, source, 'docs', 'good.txt'))).toBe(true);

    const reportContent = await fs.readFile(summary.reportPath, 'utf8');
    expect(reportContent).toContain('"type":"file-stat-error"');
    expect(reportContent).toContain('"relativePath":"docs/bad.txt"');
  });

  test('live progress reports copied counts and throughput before backup completes', async () => {
    const sourceRoot = path.join(tempRootPath, 'live-progress-source');
    for (let index = 0; index < 8; index += 1) {
      writeFixture(path.join(sourceRoot, 'docs', `f${index}.txt`), 'x'.repeat(1024 * 64));
    }

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'live-progress-host',
      seed: 'live-progress-seed',
      now: new Date('2026-06-07T10:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-07T10:05:00Z'));

    const seen = [];
    await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T10:10:00Z'),
      forceNewScan: true,
      initialHashWorkers: 2,
      initialCopyWorkers: 2,
      onProgress: (payload) => {
        seen.push({
          eventType: payload.event.type,
          filesCopied: payload.progress.filesCopied,
          filesProcessed: payload.progress.filesProcessed,
          throughput: payload.progress.copyThroughputBytesPerSecond || payload.progress.hashThroughputBytesPerSecond || 0
        });
      }
    });

    expect(seen.some((entry) => entry.filesCopied > 0)).toBe(true);
    expect(seen.some((entry) => entry.filesProcessed > 0)).toBe(true);
    expect(seen.some((entry) => entry.throughput > 0)).toBe(true);
  });

  test('single-queue progress workers stay source-oriented during active processing', async () => {
    const sourceRoot = path.join(tempRootPath, 'hash-progress-source');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'docs', 'b.txt'), 'beta');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'hash-progress-host',
      seed: 'hash-progress-seed',
      now: new Date('2026-06-07T10:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: true,
      mergeKey: 'documents',
      organizeMedia: false
    }, new Date('2026-06-07T10:05:00Z'));

    const fileWorkerSnapshots = [];
    await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T10:10:00Z'),
      forceNewScan: true,
      progressEmitIntervalMs: 0,
      onProgress: (payload) => {
        for (const worker of Object.values(payload.progress.workers || {})) {
          if (worker.pool === 'file') {
            fileWorkerSnapshots.push(worker);
          }
        }
      }
    });

    const activeSnapshots = fileWorkerSnapshots.filter((worker) => worker.state !== 'idle');
    expect(activeSnapshots.length).toBeGreaterThan(0);
    expect(activeSnapshots.every((worker) => worker.sourceRelativePath)).toBe(true);
    expect(activeSnapshots.some((worker) => String(worker.logicalPath || '').startsWith('documents/'))).toBe(false);
  });

  test('registerHashRecord preserves aliases and origins under concurrent same-hash updates', async () => {
    const fileHash = 'c'.repeat(64);
    const logicalPaths = ['documents/a.txt', 'documents/b.txt', 'documents/c.txt', 'documents/d.txt'];

    await Promise.all(logicalPaths.map((logicalPath, index) => registerHashRecord(tempRootPath, {
      fileHash,
      size: 11,
      logicalPath,
      kind: 'file',
      content: {
        type: 'plain',
        path: logicalPath
      },
      origin: {
        machineId: 'machine-a',
        sourceId: 'source-a',
        sourceRelativePath: `relative-${index}.txt`
      }
    }, new Date('2026-06-07T10:35:00Z'))));

    const record = await lookupHashRecord(tempRootPath, fileHash);
    expect(record.logicalPath).toBe('documents/a.txt');
    expect(record.aliases).toEqual([
      'documents/b.txt',
      'documents/c.txt',
      'documents/d.txt'
    ]);
    expect(record.origins).toHaveLength(4);
  });

  test('restores a source by origin-relative paths', async () => {
    const sourceRoot = path.join(tempRootPath, 'restore-source');
    writeFixture(path.join(sourceRoot, 'docs', 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'docs', 'nested', 'b.txt'), 'beta');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'restore-source-host',
      seed: 'restore-source-seed',
      now: new Date('2026-06-08T08:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-08T08:05:00Z'));

    await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-08T08:10:00Z'),
      forceNewScan: true
    });

    const restoreRoot = path.join(tempRootPath, 'restored-source-output');
    const summary = await restoreSource(tempRootPath, {
      machineId: machine.machineId,
      sourceId: source.sourceId,
      destinationRoot: restoreRoot
    });

    expect(summary.restoredFiles).toBe(2);
    expect(await fs.readFile(path.join(restoreRoot, 'docs', 'a.txt'), 'utf8')).toBe('alpha');
    expect(await fs.readFile(path.join(restoreRoot, 'docs', 'nested', 'b.txt'), 'utf8')).toBe('beta');
  });

  test('restores a single logical file by logical path', async () => {
    const sourceRoot = path.join(tempRootPath, 'restore-single');
    writeFixture(path.join(sourceRoot, 'docs', 'one.txt'), 'single-file');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'restore-single-host',
      seed: 'restore-single-seed',
      now: new Date('2026-06-08T10:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-08T10:05:00Z'));

    await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-08T10:10:00Z'),
      forceNewScan: true
    });

    const destinationPath = path.join(tempRootPath, 'restore-single-output', 'copied.txt');
    const logicalPath = `${getSourceTargetRoot(machine.machineId, source)}/docs/one.txt`;
    const result = await restoreLogicalFile(tempRootPath, {
      logicalPath,
      destinationPath
    });

    expect(result.restored).toBe(true);
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('single-file');
  });

  test('persists local UI target selection state', async () => {
    const initial = await loadLocalConfig(tempRootPath);
    expect(initial.targetRoot).toBeNull();
    expect(initial.logLevel).toBe('info');

    const saved = await saveLocalConfig(tempRootPath, {
      targetRoot: '/Volumes/BackupDrive',
      logLevel: 'debug'
    }, new Date('2026-06-08T12:00:00Z'));

    expect(saved.targetRoot).toBe('/Volumes/BackupDrive');
    expect(saved.logLevel).toBe('debug');
    expect(saved.updatedAt).toBe('2026-06-08T12:00:00.000Z');

    const loaded = await loadLocalConfig(tempRootPath);
    expect(loaded).toEqual(saved);
  });

  test('loads configurable worker pool defaults and persists overrides', async () => {
    const initial = await loadLocalConfig(tempRootPath);
    expect(initial.workerPools).toEqual({ hash: 6, copy: 6 });

    const saved = await saveLocalConfig(tempRootPath, {
      workerPools: { hash: 4, copy: 8 }
    }, new Date('2026-06-08T12:30:00Z'));

    expect(saved.workerPools).toEqual({ hash: 4, copy: 8 });

    const loaded = await loadLocalConfig(tempRootPath);
    expect(loaded.workerPools).toEqual({ hash: 4, copy: 8 });
  });

  test('creates local config file with default worker pools when missing', async () => {
    const configPath = getLocalConfigPath(tempRootPath);
    expect(await fs.pathExists(configPath)).toBe(false);

    const config = await ensureLocalConfig(tempRootPath, new Date('2026-06-08T12:20:00Z'));

    expect(config.workerPools).toEqual({ hash: 6, copy: 6 });
    expect(await fs.pathExists(configPath)).toBe(true);
    const raw = await fs.readJson(configPath);
    expect(raw.workerPools).toEqual({ hash: 6, copy: 6 });
  });

  test('normalizes invalid worker pool config values', () => {
    expect(normalizeWorkerPools({ hash: 0, copy: 'bad' })).toEqual({ hash: 6, copy: 6 });
    expect(normalizeWorkerPools({ hash: 2, copy: 128 })).toEqual({ hash: 2, copy: 64 });
  });

  test('lists registered sources for the current machine context', async () => {
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'catalog-host',
      seed: 'catalog-seed',
      now: new Date('2026-06-08T13:00:00Z')
    });

    const sourceA = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-08T13:05:00Z'));

    const sourceB = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Pictures',
      mergeEnabled: true,
      mergeKey: 'photos',
      organizeMedia: true
    }, new Date('2026-06-08T13:06:00Z'));

    const listed = await listSourcesForMachine(tempRootPath, machine.machineId);
    expect(listed.map((entry) => entry.sourceId)).toEqual([sourceA.sourceId, sourceB.sourceId]);

    const context = await loadCurrentMachineContext(tempRootPath);
    expect(context.appConfig.machineId).toBe(machine.machineId);
    expect(context.machine.machineId).toBe(machine.machineId);
    expect(context.sources).toHaveLength(2);
  });

  test('rejects unsupported backup schema versions', async () => {
    await fs.ensureDir(path.dirname(backupSchemaPath(tempRootPath)));
    await fs.writeJson(backupSchemaPath(tempRootPath), {
      version: BACKUP_SCHEMA_VERSION + 1,
      machine: {
        machineId: 'machine-a'
      },
      targets: []
    });

    await expect(loadBackupSchema(tempRootPath)).rejects.toThrow(
      `Unsupported backup schema version: ${BACKUP_SCHEMA_VERSION + 1}`
    );
  });

  test('formats logger output and respects configured log level', () => {
    const events = [];
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    configureLogger({
      level: 'warn',
      sink: (record) => events.push(record)
    });

    const logger = createLogger('BackupCoordinator', 'backupCoordinator.js');
    expect(getLogLevel()).toBe('warn');

    expect(formatLogMessage({
      module: 'BackupCoordinator',
      sourceCode: 'backupCoordinator.js',
      level: 'info',
      timestamp: '2026-06-08T14:00:00.000Z',
      message: 'started'
    })).toBe('[2026-06-08T14:00:00.000Z][BackupCoordinator][backupCoordinator.js][INFO]: started');

    logger.info('This should be filtered.');
    logger.error('This should pass.', { fileHash: 'abc' });

    expect(events).toHaveLength(1);
    expect(events[0].formatted).toMatch(/^\[[^\]]+\]\[BackupCoordinator\]\[backupCoordinator\.js\]\[ERROR\]: This should pass\.$/);
    expect(events[0].details).toEqual({ fileHash: 'abc' });

    errorSpy.mockRestore();
    configureLogger({
      level: 'info',
      sink: null
    });
  });

  test('supports per-module logger levels without changing the global threshold', () => {
    const events = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    configureLogger({
      level: 'warn',
      sink: (record) => events.push(record)
    });

    const targetAvailabilityLogger = createLogger('TargetAvailability', 'targetAvailability.js', {
      level: 'debug'
    });
    const backupCoordinatorLogger = createLogger('BackupCoordinator', 'backupCoordinator.js');

    targetAvailabilityLogger.debug('Mount watcher fired.');
    backupCoordinatorLogger.debug('This should still be filtered.');

    expect(events).toHaveLength(1);
    expect(events[0].module).toBe('TargetAvailability');
    expect(events[0].level).toBe('debug');

    logSpy.mockRestore();
    warnSpy.mockRestore();
    configureLogger({
      level: 'info',
      sink: null,
      moduleLevels: {}
    });
  });

  test('parses logger properties for global and module-specific levels', () => {
    const parsed = parseLoggerProperties(`
      # defaults
      logger.level=warn
      TargetAvailability.logger=debug
      BackupCoordinator.logger=info
      invalid-line-without-equals
      Broken.logger=not-a-level
    `, '/tmp/mybackup-logging.properties');

    expect(parsed.level).toBe('warn');
    expect(parsed.moduleLevels).toEqual({
      TargetAvailability: 'debug',
      BackupCoordinator: 'info'
    });
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  test('loads logger config from the startup properties file', async () => {
    const configPath = path.join(tempRootPath, 'mybackup-logging.properties');
    fs.writeFileSync(configPath, `
      logger.level=error
      TargetAvailability.logger=debug
      MainProcess.logger=warn
    `.trim());

    const config = await loadLoggerConfig(tempRootPath, {
      appPath: path.join(tempRootPath, 'app'),
      cwd: path.join(tempRootPath, 'cwd')
    });

    expect(config.level).toBe('error');
    expect(config.moduleLevels.TargetAvailability).toBe('debug');
    expect(config.moduleLevels.MainProcess).toBe('warn');
    expect(config.sources.some((entry) => entry.endsWith('mybackup-logging.properties'))).toBe(true);
  });

  test('builds a resume traversal stack from the source root cursor', async () => {
    const events = [];
    configureLogger({
      level: 'info',
      sink: (record) => events.push(record),
      moduleLevels: {}
    });

    const sourceRoot = path.join(tempRootPath, 'resume-stack-source');
    writeFixture(path.join(sourceRoot, 'alpha', 'one.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'beta', 'two.txt'), 'beta');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'resume-checkpoint-host',
      seed: 'resume-checkpoint-seed',
      now: new Date('2026-06-10T10:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-10T10:05:00Z'));

    events.length = 0;
    const stack = await buildFolderTraversalStack(
      sourceRoot,
      null,
      {
        scanId: '20260610-101000',
        relativePath: '.',
        folderHash: createFolderId('.')
      }
    );

    expect(stack.map((entry) => entry.relativePath)).toEqual(['.', 'alpha', 'beta']);
    expect(events.some((entry) => entry.module === 'FolderWalker' && entry.message === 'Built resume traversal stack from cursor.')).toBe(true);
  });

});
