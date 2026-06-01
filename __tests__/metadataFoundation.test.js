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
});
