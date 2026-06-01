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

describe('metadata foundation', () => {
  let tempRootPath;

  beforeEach(() => {
    tempRootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mybackup-metadata-'));
  });

  afterEach(() => {
    fs.removeSync(tempRootPath);
  });

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
});
