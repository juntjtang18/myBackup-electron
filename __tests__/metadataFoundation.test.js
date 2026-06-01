const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { createFolderId, createMachineId, createScanId, createSourceId } = require('../src/core/ids');
const {
  configPath,
  folderCheckpointPath,
  hashPath,
  machineBackupRoot,
  mergedBackupRoot,
  scanCurrentPath,
  sourcePath,
  tempRoot
} = require('../src/core/layout');
const {
  createAppConfig,
  createFolderCheckpoint,
  createHashRecord,
  createMachineRecord,
  createScanState,
  createSourceRecord,
  validateHashRecord,
  validateSourceRecord
} = require('../src/core/schema');
const {
  loadAppConfig,
  loadFolderCheckpoint,
  loadHashRecord,
  loadMachine,
  loadScanState,
  loadSource,
  saveAppConfig,
  saveFolderCheckpoint,
  saveHashRecord,
  saveMachine,
  saveScanState,
  saveSource
} = require('../src/core/metadataStore');
const { ensureMachine, updateMachine } = require('../src/core/machineRegistry');
const { registerSource, updateSourceScanState } = require('../src/core/sourceRegistry');
const { buildConflictPath, classifyMedia, planLogicalTarget } = require('../src/core/pathPlanner');
const { findCheckpointByRelativePath, listFolderCheckpoints } = require('../src/core/scanCheckpointStore');
const {
  ensureScanState,
  getResumeState,
  markGenerationCompleted,
  saveDiscoveredFolders,
  startNewGeneration,
  updateFolderStatus
} = require('../src/core/scanManager');
const { hashFile } = require('../src/core/hashService');
const { lookupHashRecord, registerHashRecord } = require('../src/core/hashIndex');
const {
  cleanupTempFiles,
  finalizePlainFile,
  restorePlainFile,
  verifyStoredPlainFile,
  writePlainFile
} = require('../src/core/plainFileStorage');

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
    expect(merged.targetSubdir).toBe('Backups/Merged/documents');
    expect(validateSourceRecord(merged)).toBe(merged);
  });

  test('builds hash records with a future-proof content field', () => {
    const plainRecord = createHashRecord({
      fileHash: 'a'.repeat(64),
      size: 42,
      logicalPath: 'Backups/Merged/documents/a.txt',
      content: {
        type: 'plain',
        path: 'Backups/Merged/documents/a.txt'
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
      logicalPath: 'Backups/Merged/documents/b.txt',
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
    const folder = createFolderCheckpoint({
      folderPath: '/Users/James/Documents',
      relativePath: '.',
      status: 'scanning'
    }, new Date('2026-06-01T10:00:00Z'));
    const hashRecord = createHashRecord({
      fileHash: 'c'.repeat(64),
      size: 11,
      logicalPath: 'Backups/Merged/documents/readme.txt',
      content: {
        type: 'plain',
        path: 'Backups/Merged/documents/readme.txt'
      },
      origins: []
    }, new Date('2026-06-01T10:00:00Z'));

    await saveAppConfig(tempRootPath, appConfig);
    await saveMachine(tempRootPath, machine);
    await saveSource(tempRootPath, source);
    await saveScanState(tempRootPath, scanState);
    await saveFolderCheckpoint(tempRootPath, machine.machineId, source.sourceId, scanState.activeGeneration, folder);
    await saveHashRecord(tempRootPath, hashRecord);

    expect(await loadAppConfig(tempRootPath)).toEqual(appConfig);
    expect(await loadMachine(tempRootPath, machine.machineId)).toEqual(machine);
    expect(await loadSource(tempRootPath, machine.machineId, source.sourceId)).toEqual(source);
    expect(await loadScanState(tempRootPath, machine.machineId, source.sourceId)).toEqual(scanState);
    expect(
      await loadFolderCheckpoint(tempRootPath, machine.machineId, source.sourceId, scanState.activeGeneration, folder.folderId)
    ).toEqual(folder);
    expect(await loadHashRecord(tempRootPath, hashRecord.fileHash)).toEqual(hashRecord);
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
    expect(folderCheckpointPath('/target', 'machine-a', 'source-a', 'scan-1', 'folder-1')).toBe(
      path.join('/target', '.mybackup', 'scans', 'machine-a', 'source-a', 'generations', 'scan-1', 'folders', 'folder-1.json')
    );
    expect(machineBackupRoot('machine-a', 'source-a')).toBe('Backups/Machines/machine-a/source-a');
    expect(mergedBackupRoot('documents')).toBe('Backups/Merged/documents');
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
    expect(updated.targetSubdir).toBe('Backups/Merged/docs-shared');
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
    })).toBe('Backups/Merged/documents/taxes/2024.pdf');

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

    expect(buildConflictPath('Backups/Merged/documents/taxes/2024.pdf', 'machine-b', 'documents-abc12345'))
      .toBe('Backups/Merged/documents/taxes/2024 [machine-b-documents-abc12345].pdf');
  });

  test('starts a new scan generation with a root folder checkpoint', async () => {
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

    const checkpoints = await listFolderCheckpoints(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      scanState.activeGeneration
    );

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].relativePath).toBe('.');
    expect(checkpoints[0].status).toBe('pending');
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

  test('tracks discovered child folders and folder status transitions', async () => {
    const machine = await ensureMachine(tempRootPath, {
      hostname: 'folder-host',
      seed: 'folder-seed',
      now: new Date('2026-06-05T10:00:00Z')
    });
    const source = await registerSource(tempRootPath, {
      machineId: machine.machineId,
      sourcePath: '/Users/James/Documents',
      mergeEnabled: false,
      organizeMedia: false
    }, new Date('2026-06-05T10:05:00Z'));

    const scan = await startNewGeneration(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      { now: new Date('2026-06-05T10:10:00Z'), scanId: '20260605-101000' }
    );

    const root = await findCheckpointByRelativePath(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      scan.activeGeneration,
      '.'
    );

    const scanningRoot = await updateFolderStatus(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      scan.activeGeneration,
      root,
      'scanning',
      { filesSeen: 2, subfoldersSeen: 2 },
      new Date('2026-06-05T10:11:00Z')
    );

    expect(scanningRoot.status).toBe('scanning');
    expect(scanningRoot.filesSeen).toBe(2);

    const children = await saveDiscoveredFolders(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      scan.activeGeneration,
      '.',
      [
        { name: 'taxes', path: '/Users/James/Documents/taxes' },
        { name: 'notes', path: '/Users/James/Documents/notes' }
      ],
      new Date('2026-06-05T10:12:00Z')
    );

    expect(children.map((entry) => entry.relativePath)).toEqual(['taxes', 'notes']);

    const allCheckpoints = await listFolderCheckpoints(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      scan.activeGeneration
    );

    expect(allCheckpoints).toHaveLength(3);

    const doneRoot = await updateFolderStatus(
      tempRootPath,
      machine.machineId,
      source.sourceId,
      scan.activeGeneration,
      scanningRoot,
      'done',
      { filesSeen: 2, subfoldersSeen: 2 },
      new Date('2026-06-05T10:13:00Z')
    );

    expect(doneRoot.status).toBe('done');
    expect(doneRoot.completedAt).toBe('2026-06-05T10:13:00.000Z');
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
      logicalPath: 'Backups/Merged/documents/report.txt',
      kind: 'file',
      content: {
        type: 'plain',
        path: 'Backups/Merged/documents/report.txt'
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
      logicalPath: 'Backups/Merged/documents/report.txt',
      kind: 'file',
      content: {
        type: 'plain',
        path: 'Backups/Merged/documents/report.txt'
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
        path: 'Backups/Merged/documents/report.txt'
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
        path: 'Backups/Merged/documents/report.txt'
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
});
