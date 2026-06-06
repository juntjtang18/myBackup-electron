const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { createFolderId, createMachineId, createScanId, createSourceId } = require('../src/core/ids');
const {
  configPath,
  errorReportPath,
  hashPath,
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
  createScanState,
  createSourceRecord,
  validateHashRecord,
  validateSourceRecord
} = require('../src/core/schema');
const {
  loadAppConfig,
  loadHashRecord,
  loadMachine,
  loadScanState,
  loadSource,
  saveAppConfig,
  saveHashRecord,
  saveMachine,
  saveScanState,
  saveSource
} = require('../src/core/metadataStore');
const { ensureMachine, updateMachine } = require('../src/core/machineRegistry');
const { registerSource, updateSourceScanState } = require('../src/core/sourceRegistry');
const { buildConflictPath, classifyMedia, planLogicalTarget } = require('../src/core/pathPlanner');
const {
  ensureScanState,
  getResumeState,
  markGenerationCompleted,
  startNewGeneration
} = require('../src/core/scanManager');
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
const { createWorkScheduler } = require('../src/core/workScheduler');
const { buildFolderTraversalStack } = require('../src/core/scanner/folderWalker');
const { parseIgnoreFile, shouldIgnorePath, buildIgnoreRules } = require('../src/core/ignoreMatcher');
const { readJsonIfExists } = require('../src/core/jsonStore');
const { createSourceSnapshot, loadSourceSnapshot, saveSourceSnapshot } = require('../src/core/sourceSnapshotStore');
const { createTargetAvailabilityMonitor, checkTargetAvailability } = require('../src/core/targetAvailability');
const { loadLoggerConfig, parseLoggerProperties } = require('../src/core/loggerConfig');
const {
  createFolderHash,
  loadResumeManifest,
  resumeManifestPath,
  walkFoldersFromCursor
} = require('../src/core/resume');
const {
  listHashRecords,
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

  test('creates stable ids for machine, source, scan, and folder', () => {
    expect(createMachineId('James-MacBook', 'fixed-seed')).toBe('james-macbook-09167cea');
    expect(createSourceId('/Users/James/Documents')).toBe('documents-0cf0ec50');
    expect(createScanId(new Date('2026-06-01T10:11:12Z'))).toBe('20260601-101112');
    expect(createFolderId('taxes/2024')).toBe('2024-980428266e');
  });

  test('builds source records for separated and merged targets', () => {
    const separated = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Documents',
      organizeMedia: false,
      mergeEnabled: false
    });

    const merged = createSourceRecord({
      machineId: 'machine-b',
      sourcePath: '/Users/James/Documents',
      organizeMedia: true,
      mergeEnabled: true,
      mergeKey: 'Documents'
    });

    expect(separated.targetSubdir).toBe(`Backups/Machines/machine-a/${separated.sourceId}`);
    expect(merged.mergeKey).toBe('documents');
    expect(merged.targetSubdir).toBe('documents');
    expect(validateSourceRecord(merged)).toBe(merged);
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

  test('persists all step-1 metadata documents atomically', async () => {
    const appConfig = createAppConfig({ machineId: 'machine-a' }, new Date('2026-06-01T10:00:00Z'));
    const machine = createMachineRecord({
      machineId: 'machine-a',
      displayName: 'Machine A',
      hostname: 'machine-a'
    }, new Date('2026-06-01T10:00:00Z'));
    const source = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Documents',
      mergeEnabled: true,
      mergeKey: 'documents'
    }, new Date('2026-06-01T10:00:00Z'));
    const scanState = createScanState({
      machineId: 'machine-a',
      sourceId: source.sourceId,
      activeGeneration: '20260601-100000'
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

    await saveAppConfig(tempRootPath, appConfig);
    await saveMachine(tempRootPath, machine);
    await saveSource(tempRootPath, source);
    await saveScanState(tempRootPath, scanState);
    await saveHashRecord(tempRootPath, hashRecord);

    expect(await loadAppConfig(tempRootPath)).toEqual(appConfig);
    expect(await loadMachine(tempRootPath, machine.machineId)).toEqual(machine);
    expect(await loadSource(tempRootPath, machine.machineId, source.sourceId)).toEqual(source);
    expect(await loadScanState(tempRootPath, machine.machineId, source.sourceId)).toEqual(scanState);
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
      path.join('/target', '.mybackup', 'hashes', 'abc', 'def', 'abc', 'def', 'abc.indx')
    );
  });

  test('exposes the metadata path layout explicitly', () => {
    expect(configPath('/target')).toBe(path.join('/target', '.mybackup', 'config.json'));
    expect(sourcePath('/target', 'machine-a', 'source-a')).toBe(
      path.join('/target', '.mybackup', 'sources', 'machine-a', 'source-a.json')
    );
    expect(hashPath('/target', 'ab'.repeat(32))).toBe(
      path.join('/target', '.mybackup', 'hashes', 'ab', 'ab', `${'ab'.repeat(32)}.json`)
    );
    expect(scanCurrentPath('/target', 'machine-a', 'source-a')).toBe(
      path.join('/target', '.mybackup', 'scans', 'machine-a', 'source-a', 'current.json')
    );
    expect(machineBackupRoot('machine-a', 'source-a')).toBe('Backups/Machines/machine-a/source-a');
    expect(mergedBackupRoot('documents')).toBe('documents');
    expect(tempRoot('/target')).toBe(path.join('/target', '.mybackup', 'tmp'));
  });

  test('bootstraps and reuses the local machine identity', async () => {
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'James-MacBook',
      displayName: 'James Laptop',
      platform: 'darwin',
      seed: 'machine-seed',
      now: new Date('2026-06-02T09:00:00Z')
    });

    const loadedConfig = await loadAppConfig(tempRootPath);
    expect(loadedConfig.machineId).toBe(machine.machineId);
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

  test('registers and updates source records while preserving scan state', async () => {
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

    const scanned = await updateSourceScanState(tempRootPath, machine.machineId, first.sourceId, {
      lastCompletedScan: '20260602-100000',
      lastCompletedAt: '2026-06-02T10:00:00Z'
    }, new Date('2026-06-02T10:00:00Z'));

    const updated = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Documents',
      organizeMedia: true,
      mergeEnabled: true,
      mergeKey: 'Docs Shared'
    }, new Date('2026-06-03T09:10:00Z'));

    expect(updated.sourceId).toBe(first.sourceId);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.mergeEnabled).toBe(true);
    expect(updated.mergeKey).toBe('docs-shared');
    expect(updated.targetSubdir).toBe('docs-shared');
    expect(updated.lastCompletedScan).toBe(scanned.lastCompletedScan);
    expect(updated.lastCompletedAt).toBe(scanned.lastCompletedAt);
  });

  test('plans machine-separated, merged, and media logical target paths', async () => {
    const separatedSource = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false,
      organizeMedia: false
    });

    const mergedSource = createSourceRecord({
      machineId: 'machine-b',
      sourcePath: '/Users/James/Documents',
      mergeEnabled: true,
      mergeKey: 'documents',
      organizeMedia: false
    });

    const mediaSeparatedSource = createSourceRecord({
      machineId: 'machine-a',
      sourcePath: '/Users/James/Pictures',
      mergeEnabled: false,
      organizeMedia: true
    });

    const mediaMergedSource = createSourceRecord({
      machineId: 'machine-b',
      sourcePath: '/Users/James/Pictures',
      mergeEnabled: true,
      mergeKey: 'photos',
      organizeMedia: true
    });

    expect(classifyMedia('IMG_0001.HEIC')).toBe('image');
    expect(classifyMedia('clip.MOV')).toBe('video');
    expect(classifyMedia('todo.txt')).toBe('file');

    expect(planLogicalTarget({
      machineId: 'machine-a',
      source: separatedSource,
      sourceRelativePath: 'taxes/2024.pdf',
      kind: 'file'
    })).toBe(`Backups/Machines/machine-a/${separatedSource.sourceId}/taxes/2024.pdf`);

    expect(planLogicalTarget({
      machineId: 'machine-b',
      source: mergedSource,
      sourceRelativePath: 'taxes/2024.pdf',
      kind: 'file'
    })).toBe('documents/taxes/2024.pdf');

    expect(planLogicalTarget({
      machineId: 'machine-a',
      source: mediaSeparatedSource,
      sourceRelativePath: 'albums/IMG_001.HEIC',
      kind: 'image',
      timestamp: new Date('2026-05-18T12:00:00Z')
    })).toBe(`Images/2026/2026-05-18/machine-a/${mediaSeparatedSource.sourceId}/IMG_001.HEIC`);

    expect(planLogicalTarget({
      machineId: 'machine-b',
      source: mediaMergedSource,
      sourceRelativePath: 'albums/IMG_001.HEIC',
      kind: 'image',
      timestamp: new Date('2026-05-18T12:00:00Z')
    })).toBe('Images/2026/2026-05-18/photos/IMG_001.HEIC');

    expect(buildConflictPath('documents/taxes/2024.pdf', 'machine-b', 'documents-abc12345'))
      .toBe('documents/taxes/2024 [machine-b-documents-abc12345].pdf');
  });

  test('starts a new scan generation with scan state only', async () => {
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'scan-host',
      seed: 'scan-seed',
      now: new Date('2026-06-05T08:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-05T08:05:00Z'));

    const scanState = await startNewGeneration(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      { now: new Date('2026-06-05T08:10:00Z'), scanId: '20260605-081000' }
    );

    expect(scanState.activeGeneration).toBe('20260605-081000');
    expect(scanState.status).toBe('running');
  });

  test('resumes incomplete scan state and resets with a forced new generation', async () => {
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'resume-host',
      seed: 'resume-seed',
      now: new Date('2026-06-05T09:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-05T09:05:00Z'));

    const first = await ensureScanState(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-05T09:10:00Z'),
      scanId: '20260605-091000'
    });

    const resumed = await ensureScanState(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-05T09:20:00Z')
    });

    expect(resumed.scanState.activeGeneration).toBe(first.scanState.activeGeneration);

    const forced = await ensureScanState(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-05T09:30:00Z'),
      scanId: '20260605-093000',
      forceNew: true
    });

    expect(forced.scanState.activeGeneration).toBe('20260605-093000');
    expect(forced.scanState.activeGeneration).not.toBe(first.scanState.activeGeneration);
  });

  test('marks a generation completed and stops resume selection', async () => {
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'complete-host',
      seed: 'complete-seed',
      now: new Date('2026-06-05T11:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-05T11:05:00Z'));

    await startNewGeneration(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-05T11:10:00Z'),
      scanId: '20260605-111000'
    });

    const resumeBefore = await getResumeState(tempRootPath, machine.machineId, source.sourceId);
    expect(resumeBefore.scanState.activeGeneration).toBe('20260605-111000');

    const completed = await markGenerationCompleted(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      new Date('2026-06-05T11:20:00Z')
    );

    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBe('2026-06-05T11:20:00.000Z');
    expect(await getResumeState(tempRootPath, machine.machineId, source.sourceId)).toBeNull();
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

  test('persists source snapshot state for incremental backup decisions', async () => {
    const snapshot = createSourceSnapshot('machine-a', 'source-a', null, new Date('2026-06-09T10:00:00Z'));
    snapshot.files['docs/a.txt'] = {
      size: 12,
      mtimeMs: 1234,
      fileHash: 'd'.repeat(64),
      logicalPath: 'Backups/Machines/machine-a/source-a/docs/a.txt',
      updatedAt: '2026-06-09T10:00:00Z'
    };

    await saveSourceSnapshot(tempRootPath, snapshot);
    await expect(loadSourceSnapshot(tempRootPath, 'machine-a', 'source-a')).resolves.toEqual(snapshot);
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
            lastCompletedScan: '20260605-090000',
            lastCompletedAt: '2026-06-05T09:05:00.000Z',
            scanState: {
              status: 'paused',
              activeGeneration: '20260605-090000'
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
      sourcePath: '/Users/James/Documents',
      scanStatus: 'paused',
      activeGeneration: '20260605-090000'
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

    const targetFile = path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'docs',
      'a.txt'
    );
    expect(await fs.readFile(targetFile, 'utf8')).toBe('alpha');

    const scanState = await loadScanState(tempRootPath, machine.machineId, source.sourceId);
    expect(scanState.status).toBe('completed');
    expect(scanState.activeGeneration).toBe(summary.scanId);

    const updatedSource = await loadSource(tempRootPath, machine.machineId, source.sourceId);
    expect(updatedSource.lastCompletedScan).toBe(summary.scanId);
    expect(updatedSource.lastCompletedAt).toBe('2026-06-07T08:10:00.000Z');
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
    expect(context.sources[0].scanState.status).toBe('paused');
    expect(context.sources[0].scanState.resumeCursor).toMatchObject({
      scanId: summary.scanId,
      relativePath: '.'
    });
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

    events.length = 0;

    const resumed = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T08:50:00Z')
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.filesCopied).toBe(2);
    expect(resumed.filesProcessed).toBeGreaterThanOrEqual(2);
    expect(events.some((entry) => entry.module === 'ScanManager' && entry.message === 'Loaded resumable scan state.')).toBe(true);
    expect(events.some((entry) => entry.module === 'FolderWalker' && entry.message === 'Built resume traversal stack from cursor.')).toBe(true);
    expect(events.some((entry) => entry.module === 'BackupCoordinator' && entry.message === 'Processing folder from traversal stack.')).toBe(true);
    expect(events.some((entry) => entry.module === 'BackupCoordinator' && entry.message === 'First copy task started.')).toBe(true);
  });

  test('walks source folders from a saved resume cursor without checkpoint lookup', async () => {
    const sourceRoot = path.join(tempRootPath, 'cursor-source');
    writeFixture(path.join(sourceRoot, 'a', 'a1', 'file.txt'), 'a1');
    writeFixture(path.join(sourceRoot, 'b', 'file.txt'), 'b');

    const cursor = {
      folderHash: createFolderHash('a'),
      relativePath: 'a',
      folderPath: path.join(sourceRoot, 'a'),
      status: 'done'
    };

    const folders = [];
    for await (const folder of walkFoldersFromCursor(sourceRoot, cursor)) {
      folders.push(folder.relativePath);
    }

    expect(folders).toEqual(['a/a1', 'b']);
  });

  test('resumes paused backup using the new source cursor manifest', async () => {
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
    const pausedManifest = await loadResumeManifest(tempRootPath, machine.machineId, source.sourceId);
    expect(pausedManifest.status).toBe('paused');
    expect(pausedManifest.cursor.relativePath).toBe('.');
    expect(pausedManifest.cursor.status).toBe('done');
    expect(await fs.pathExists(resumeManifestPath(tempRootPath, machine.machineId, source.sourceId))).toBe(true);

    const completed = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T08:20:00Z')
    });

    expect(completed.status).toBe('completed');
    expect(completed.scanId).toBe(paused.scanId);
    expect(completed.filesCopied).toBe(2);

    const completedManifest = await loadResumeManifest(tempRootPath, machine.machineId, source.sourceId);
    expect(completedManifest.status).toBe('completed');
    expect(completedManifest.cursor.relativePath).toBe('b');

    expect(
      await fs.readFile(
        path.join(tempRootPath, 'Backups', 'Machines', machine.machineId, source.sourceId, 'a', 'one.txt'),
        'utf8'
      )
    ).toBe('one');
    expect(
      await fs.readFile(
        path.join(tempRootPath, 'Backups', 'Machines', machine.machineId, source.sourceId, 'b', 'two.txt'),
        'utf8'
      )
    ).toBe('two');
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
    expect(summary.filesIndexed).toBe(1);
    expect(
      await fs.readFile(
        path.join(tempRootPath, 'Backups', 'Machines', machine.machineId, source.sourceId, 'docs', 'b.txt'),
        'utf8'
      )
    ).toBe('beta-v2');
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
    expect(await fs.pathExists(path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'docs',
      'a.txt'
    ))).toBe(true);
    expect(await fs.pathExists(path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'node_modules'
    ))).toBe(false);
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
    expect(await fs.pathExists(path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'docs',
      'a.txt'
    ))).toBe(true);
    expect(await fs.pathExists(path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'docs',
      'keep.log'
    ))).toBe(true);
    expect(await fs.pathExists(path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'docs',
      'drop.log'
    ))).toBe(false);
    expect(await fs.pathExists(path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'node_modules'
    ))).toBe(false);
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
    expect(await fs.pathExists(path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'keep',
      'a.txt'
    ))).toBe(true);
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
    expect(await fs.pathExists(path.join(
      tempRootPath,
      'Backups',
      'Machines',
      machine.machineId,
      source.sourceId,
      'docs',
      'good.txt'
    ))).toBe(true);

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

  test('hash progress workers never expose copy target logical paths', async () => {
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

    const hashWorkerSnapshots = [];
    await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-07T10:10:00Z'),
      forceNewScan: true,
      progressEmitIntervalMs: 0,
      onProgress: (payload) => {
        for (const worker of Object.values(payload.progress.workers || {})) {
          if (worker.pool === 'hash') {
            hashWorkerSnapshots.push(worker);
          }
        }
      }
    });

    expect(hashWorkerSnapshots.length).toBeGreaterThan(0);
    expect(hashWorkerSnapshots.every((worker) => worker.logicalPath === null)).toBe(true);
    expect(hashWorkerSnapshots.some((worker) => String(worker.logicalPath || '').startsWith('documents/'))).toBe(false);
  });

  test('reuses same-content files and resolves merged-path conflicts end-to-end', async () => {
    const sourceRootA = path.join(tempRootPath, 'merge-a');
    const sourceRootB = path.join(tempRootPath, 'merge-b');

    writeFixture(path.join(sourceRootA, 'shared.txt'), 'same-content');
    writeFixture(path.join(sourceRootA, 'conflict.txt'), 'content-a');
    writeFixture(path.join(sourceRootB, 'shared.txt'), 'same-content');
    writeFixture(path.join(sourceRootB, 'conflict.txt'), 'content-b');

    const machineA = await ensureMachine(tempRootPath, {
      hostname: 'merge-a-host',
      seed: 'merge-a-seed',
      now: new Date('2026-06-07T09:00:00Z')
    });
    const sourceA = await registerSource(tempRootPath, {
      machineId: machineA.machineId,
      sourcePath: sourceRootA,
      mergeEnabled: true,
      mergeKey: 'shared-docs',
      organizeMedia: false
    }, new Date('2026-06-07T09:05:00Z'));

    await backupSource(tempRootPath, machineA.machineId, sourceA.sourceId, {
      now: new Date('2026-06-07T09:10:00Z'),
      forceNewScan: true
    });

    const machineB = await ensureMachine(tempRootPath, {
      machineId: 'machine-b',
      hostname: 'merge-b-host',
      seed: 'merge-b-seed',
      now: new Date('2026-06-07T09:20:00Z')
    });
    const sourceB = await registerSource(tempRootPath, {
      machineId: machineB.machineId,
      sourcePath: sourceRootB,
      mergeEnabled: true,
      mergeKey: 'shared-docs',
      organizeMedia: false
    }, new Date('2026-06-07T09:25:00Z'));

    const summaryB = await backupSource(tempRootPath, machineB.machineId, sourceB.sourceId, {
      now: new Date('2026-06-07T09:30:00Z'),
      forceNewScan: true
    });

    expect(summaryB.filesProcessed).toBe(2);
    expect(summaryB.filesCopied).toBe(1);
    expect(summaryB.filesIndexed).toBe(1);
    expect(summaryB.conflicts).toBe(1);

    const sharedLogicalPath = 'shared-docs/shared.txt';
    const sharedHash = await hashFile(path.join(sourceRootA, 'shared.txt'));
    const sharedRecord = await lookupHashRecord(tempRootPath, sharedHash);
    expect(sharedRecord.logicalPath).toBe(sharedLogicalPath);
    expect(sharedRecord.origins).toHaveLength(2);

    const baseConflictPath = path.join(tempRootPath, 'shared-docs', 'conflict.txt');
    const suffixedConflictPath = path.join(
      tempRootPath,
      'shared-docs',
      `conflict [${machineB.machineId}-${sourceB.sourceId}].txt`
    );

    expect(await fs.readFile(baseConflictPath, 'utf8')).toBe('content-a');
    expect(await fs.readFile(suffixedConflictPath, 'utf8')).toBe('content-b');
  });

  test('materializes merged same-hash files at different logical paths', async () => {
    const sourceRootA = path.join(tempRootPath, 'merge-folders-a');
    const sourceRootB = path.join(tempRootPath, 'merge-folders-b');

    writeFixture(path.join(sourceRootA, 'alpha', 'shared.txt'), 'same-content');
    writeFixture(path.join(sourceRootB, 'beta', 'shared.txt'), 'same-content');

    const machineA = await ensureMachine(tempRootPath, {
      hostname: 'merge-folders-a-host',
      seed: 'merge-folders-a-seed',
      now: new Date('2026-06-07T10:00:00Z')
    });
    const sourceA = await registerSource(tempRootPath, {
      machineId: machineA.machineId,
      sourcePath: sourceRootA,
      mergeEnabled: true,
      mergeKey: 'shared-docs',
      organizeMedia: false
    }, new Date('2026-06-07T10:05:00Z'));

    await backupSource(tempRootPath, machineA.machineId, sourceA.sourceId, {
      now: new Date('2026-06-07T10:10:00Z'),
      forceNewScan: true
    });

    const machineB = await ensureMachine(tempRootPath, {
      machineId: 'machine-c',
      hostname: 'merge-folders-b-host',
      seed: 'merge-folders-b-seed',
      now: new Date('2026-06-07T10:20:00Z')
    });
    const sourceB = await registerSource(tempRootPath, {
      machineId: machineB.machineId,
      sourcePath: sourceRootB,
      mergeEnabled: true,
      mergeKey: 'shared-docs',
      organizeMedia: false
    }, new Date('2026-06-07T10:25:00Z'));

    const summaryB = await backupSource(tempRootPath, machineB.machineId, sourceB.sourceId, {
      now: new Date('2026-06-07T10:30:00Z'),
      forceNewScan: true
    });

    expect(summaryB.filesProcessed).toBe(1);
    expect(summaryB.filesCopied).toBe(1);
    expect(summaryB.filesIndexed).toBe(0);

    const alphaPath = path.join(tempRootPath, 'shared-docs', 'alpha', 'shared.txt');
    const betaPath = path.join(tempRootPath, 'shared-docs', 'beta', 'shared.txt');
    expect(await fs.readFile(alphaPath, 'utf8')).toBe('same-content');
    expect(await fs.readFile(betaPath, 'utf8')).toBe('same-content');

    const sharedHash = await hashFile(path.join(sourceRootA, 'alpha', 'shared.txt'));
    const sharedRecord = await lookupHashRecord(tempRootPath, sharedHash);
    expect(sharedRecord.logicalPath).toBe('shared-docs/alpha/shared.txt');
    expect(sharedRecord.aliases).toContain('shared-docs/beta/shared.txt');
    expect(sharedRecord.origins).toHaveLength(2);
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

  test('backupSource handles many same-hash files in one run without hash-record races', async () => {
    const sourceRoot = path.join(tempRootPath, 'same-hash-source');
    const fileNames = [
      'EmoticonHappy.gif',
      'EmoticonHappy00.gif',
      'EmoticonHappy000.gif',
      'EmoticonHappy0000.gif',
      'EmoticonHappy00000.gif',
      'EmoticonHappy000000.gif'
    ];

    for (const fileName of fileNames) {
      writeFixture(path.join(sourceRoot, 'sametime', fileName), 'same-gif-content');
    }

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'same-hash-host',
      seed: 'same-hash-seed',
      now: new Date('2026-06-08T10:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: true,
      mergeKey: 'documents',
      organizeMedia: false
    }, new Date('2026-06-08T10:05:00Z'));

    const summary = await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-08T10:10:00Z'),
      forceNewScan: true,
      initialHashWorkers: 4,
      initialCopyWorkers: 4
    });

    expect(summary.filesProcessed).toBe(fileNames.length);
    expect(summary.filesCopied).toBe(fileNames.length);
    expect(summary.filesIndexed).toBe(0);

    const sharedHash = await hashFile(path.join(sourceRoot, 'sametime', fileNames[0]));
    const record = await lookupHashRecord(tempRootPath, sharedHash);
    expect(record.origins).toHaveLength(fileNames.length);
    expect(record.aliases).toHaveLength(fileNames.length - 1);

    for (const fileName of fileNames) {
      expect(await fs.readFile(path.join(tempRootPath, 'documents', 'sametime', fileName), 'utf8')).toBe('same-gif-content');
    }
  });

  test('materializes merged media files at different day paths and keeps alias metadata', async () => {
    const sourceRootA = path.join(tempRootPath, 'merge-media-a');
    const sourceRootB = path.join(tempRootPath, 'merge-media-b');
    const sharedBytes = 'same-image-content';

    writeFixture(path.join(sourceRootA, 'albums', 'IMG_001.JPG'), sharedBytes);
    writeFixture(path.join(sourceRootB, 'imports', 'IMG_002.JPG'), sharedBytes);
    fs.utimesSync(
      path.join(sourceRootA, 'albums', 'IMG_001.JPG'),
      new Date('2026-06-01T12:00:00Z'),
      new Date('2026-06-01T12:00:00Z')
    );
    fs.utimesSync(
      path.join(sourceRootB, 'imports', 'IMG_002.JPG'),
      new Date('2026-06-01T12:00:00Z'),
      new Date('2026-06-01T12:00:00Z')
    );

    const machineA = await ensureMachine(tempRootPath, {
      hostname: 'merge-media-a-host',
      seed: 'merge-media-a-seed',
      now: new Date('2026-06-07T11:00:00Z')
    });
    const sourceA = await registerSource(tempRootPath, {
      machineId: machineA.machineId,
      sourcePath: sourceRootA,
      mergeEnabled: true,
      mergeKey: 'photos',
      organizeMedia: true
    }, new Date('2026-06-07T11:05:00Z'));

    await backupSource(tempRootPath, machineA.machineId, sourceA.sourceId, {
      now: new Date('2026-06-07T11:10:00Z'),
      forceNewScan: true
    });

    const machineB = await ensureMachine(tempRootPath, {
      machineId: 'machine-d',
      hostname: 'merge-media-b-host',
      seed: 'merge-media-b-seed',
      now: new Date('2026-06-07T11:20:00Z')
    });
    const sourceB = await registerSource(tempRootPath, {
      machineId: machineB.machineId,
      sourcePath: sourceRootB,
      mergeEnabled: true,
      mergeKey: 'photos',
      organizeMedia: true
    }, new Date('2026-06-07T11:25:00Z'));

    const summaryB = await backupSource(tempRootPath, machineB.machineId, sourceB.sourceId, {
      now: new Date('2026-06-07T11:30:00Z'),
      forceNewScan: true
    });

    expect(summaryB.filesProcessed).toBe(1);
    expect(summaryB.filesCopied).toBe(1);
    expect(summaryB.filesIndexed).toBe(0);

    const firstLogicalPath = path.join(tempRootPath, 'Images', '2026', '2026-06-01', 'photos', 'IMG_001.JPG');
    const secondLogicalPath = path.join(tempRootPath, 'Images', '2026', '2026-06-01', 'photos', 'IMG_002.JPG');
    expect(await fs.readFile(firstLogicalPath, 'utf8')).toBe(sharedBytes);
    expect(await fs.readFile(secondLogicalPath, 'utf8')).toBe(sharedBytes);

    const sharedHash = await hashFile(path.join(sourceRootA, 'albums', 'IMG_001.JPG'));
    const sharedRecord = await lookupHashRecord(tempRootPath, sharedHash);
    expect(sharedRecord.logicalPath).toBe('Images/2026/2026-06-01/photos/IMG_001.JPG');
    expect(sharedRecord.aliases).toContain('Images/2026/2026-06-01/photos/IMG_002.JPG');
    expect(sharedRecord.origins).toHaveLength(2);
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

  test('restores a merged logical tree including aliases and conflict files', async () => {
    const sourceRootA = path.join(tempRootPath, 'restore-merge-a');
    const sourceRootB = path.join(tempRootPath, 'restore-merge-b');

    writeFixture(path.join(sourceRootA, 'alpha', 'shared.txt'), 'same-content');
    writeFixture(path.join(sourceRootA, 'conflict.txt'), 'content-a');
    writeFixture(path.join(sourceRootB, 'beta', 'shared.txt'), 'same-content');
    writeFixture(path.join(sourceRootB, 'conflict.txt'), 'content-b');

    const machineA = await ensureMachine(tempRootPath, {
      hostname: 'restore-merge-a-host',
      seed: 'restore-merge-a-seed',
      now: new Date('2026-06-08T09:00:00Z')
    });
    const sourceA = await registerSource(tempRootPath, {
      machineId: machineA.machineId,
      sourcePath: sourceRootA,
      mergeEnabled: true,
      mergeKey: 'shared-docs',
      organizeMedia: false
    }, new Date('2026-06-08T09:05:00Z'));
    await backupSource(tempRootPath, machineA.machineId, sourceA.sourceId, {
      now: new Date('2026-06-08T09:10:00Z'),
      forceNewScan: true
    });

    const machineB = await ensureMachine(tempRootPath, {
      machineId: 'machine-restore-b',
      hostname: 'restore-merge-b-host',
      seed: 'restore-merge-b-seed',
      now: new Date('2026-06-08T09:20:00Z')
    });
    const sourceB = await registerSource(tempRootPath, {
      machineId: machineB.machineId,
      sourcePath: sourceRootB,
      mergeEnabled: true,
      mergeKey: 'shared-docs',
      organizeMedia: false
    }, new Date('2026-06-08T09:25:00Z'));
    await backupSource(tempRootPath, machineB.machineId, sourceB.sourceId, {
      now: new Date('2026-06-08T09:30:00Z'),
      forceNewScan: true
    });

    const restoreRoot = path.join(tempRootPath, 'restored-merged-tree');
    const summary = await restoreLogicalTree(tempRootPath, {
      logicalRoot: 'shared-docs',
      destinationRoot: restoreRoot
    });

    expect(summary.restoredFiles).toBe(4);
    expect(await fs.readFile(path.join(restoreRoot, 'alpha', 'shared.txt'), 'utf8')).toBe('same-content');
    expect(await fs.readFile(path.join(restoreRoot, 'beta', 'shared.txt'), 'utf8')).toBe('same-content');
    expect(await fs.readFile(path.join(restoreRoot, 'conflict.txt'), 'utf8')).toBe('content-a');
    const conflictRestoreName = path.posix.basename(
      buildConflictPath('shared-docs/conflict.txt', machineB.machineId, sourceB.sourceId)
    );
    expect(
      await fs.readFile(
        path.join(restoreRoot, conflictRestoreName),
        'utf8'
      )
    ).toBe('content-b');
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
    const logicalPath = `Backups/Machines/${machine.machineId}/${source.sourceId}/docs/one.txt`;
    const result = await restoreLogicalFile(tempRootPath, {
      logicalPath,
      destinationPath
    });

    expect(result.restored).toBe(true);
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('single-file');
  });

  test('lists hash records from metadata storage', async () => {
    const sourceRoot = path.join(tempRootPath, 'restore-list');
    writeFixture(path.join(sourceRoot, 'a.txt'), 'alpha');
    writeFixture(path.join(sourceRoot, 'b.txt'), 'beta');

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'restore-list-host',
      seed: 'restore-list-seed',
      now: new Date('2026-06-08T11:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: sourceRoot,
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-08T11:05:00Z'));

    await backupSource(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-08T11:10:00Z'),
      forceNewScan: true
    });

    const records = await listHashRecords(tempRootPath);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.content.type === 'plain')).toBe(true);
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

    await startNewGeneration(tempRootPath, machine.machineId, sourceB.sourceId, {
      now: new Date('2026-06-08T13:10:00Z'),
      scanId: '20260608-131000'
    });

    const listed = await listSourcesForMachine(tempRootPath, machine.machineId);
    expect(listed.map((entry) => entry.sourceId)).toEqual([sourceA.sourceId, sourceB.sourceId]);
    expect(listed[1].scanState.activeGeneration).toBe('20260608-131000');

    const context = await loadCurrentMachineContext(tempRootPath);
    expect(context.appConfig.machineId).toBe(machine.machineId);
    expect(context.machine.machineId).toBe(machine.machineId);
    expect(context.sources).toHaveLength(2);
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

  test('logs resumable scan reuse when ensureScanState resumes an active generation', async () => {
    const events = [];
    configureLogger({
      level: 'info',
      sink: (record) => events.push(record),
      moduleLevels: {}
    });

    const machine = await ensureMachine(tempRootPath, {
      hostname: 'resume-log-host',
      seed: 'resume-log-seed',
      now: new Date('2026-06-10T09:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-10T09:05:00Z'));

    await ensureScanState(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-10T09:10:00Z'),
      scanId: '20260610-091000'
    });

    events.length = 0;

    const resumed = await ensureScanState(tempRootPath, machine.machineId, source.sourceId, {
      now: new Date('2026-06-10T09:20:00Z')
    });

    expect(resumed.scanState.activeGeneration).toBe('20260610-091000');
    expect(events.some((entry) => entry.module === 'ScanManager' && entry.message === 'Loaded resumable scan state.')).toBe(true);
    expect(events.some((entry) => entry.module === 'ScanManager' && entry.message === 'Reusing resumable scan state.')).toBe(true);
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

    expect(stack.map((entry) => entry.relativePath)).toEqual(['alpha', 'beta']);
    expect(events.some((entry) => entry.module === 'FolderWalker' && entry.message === 'Built resume traversal stack from cursor.')).toBe(true);
  });

  test('keeps a trial worker when throughput improves enough', async () => {
    const scheduler = createWorkScheduler({
      processTask: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
        return { bytesProcessed: payload.bytes };
      },
      initialWorkers: 1,
      maxWorkers: 2,
      backlogFactor: 1,
      trialWindowMs: 60,
      throughputImprovementThreshold: 1.15,
      idleWaitMs: 2
    });

    const tasks = Array.from({ length: 12 }, () => (
      scheduler.push({ bytes: 100, delayMs: 25 })
    ));

    await Promise.all(tasks);
    await scheduler.closeAndDrain();

    const snapshot = scheduler.snapshot();
    expect(snapshot.acceptedWorkers).toBe(2);
    expect(snapshot.scalingLocked).toBe(false);
    expect(snapshot.completedTasks).toBe(12);
  });

  test('rolls back a trial worker and locks scaling when throughput does not improve enough', async () => {
    let concurrentTasks = 0;
    const scheduler = createWorkScheduler({
      processTask: async (payload) => {
        concurrentTasks += 1;
        const delayMs = concurrentTasks > 1 ? payload.contendedDelayMs : payload.baseDelayMs;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        concurrentTasks -= 1;
        return { bytesProcessed: payload.bytes };
      },
      initialWorkers: 1,
      maxWorkers: 2,
      backlogFactor: 1,
      trialWindowMs: 80,
      throughputImprovementThreshold: 1.15,
      idleWaitMs: 2
    });

    const tasks = Array.from({ length: 12 }, () => (
      scheduler.push({ bytes: 100, baseDelayMs: 20, contendedDelayMs: 60 })
    ));

    await Promise.all(tasks);
    await scheduler.closeAndDrain();

    const snapshot = scheduler.snapshot();
    expect(snapshot.acceptedWorkers).toBe(1);
    expect(snapshot.scalingLocked).toBe(true);
    expect(snapshot.completedTasks).toBe(12);
  });

  test('exposes queued item previews through snapshot', async () => {
    let releaseFirstTask;
    const firstTaskGate = new Promise((resolve) => {
      releaseFirstTask = resolve;
    });
    const scheduler = createWorkScheduler({
      processTask: async (payload) => {
        if (payload.id === 1) {
          await firstTaskGate;
        }
        return { bytesProcessed: payload.bytes };
      },
      initialWorkers: 1,
      maxWorkers: 1,
      summarizePayload: (payload) => ({
        id: payload.id,
        totalBytes: payload.bytes
      })
    });

    const tasks = [
      scheduler.push({ id: 1, bytes: 100 }),
      scheduler.push({ id: 2, bytes: 200 }),
      scheduler.push({ id: 3, bytes: 300 })
    ];

    await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = scheduler.snapshot();
    expect(snapshot.queueDepth).toBe(2);
    expect(snapshot.pendingTasks).toBe(3);
    expect(snapshot.queuedItems).toEqual([
      { id: 2, totalBytes: 200 },
      { id: 3, totalBytes: 300 }
    ]);

    releaseFirstTask();
    await Promise.all(tasks);
    await scheduler.closeAndDrain();
  });
});
