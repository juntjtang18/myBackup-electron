const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { createMachineRecord } = require('../src/core/schema');
const { catalogPath } = require('../src/core/paths');
const {
  createEmptyCatalog,
  ensureCatalog,
  loadCatalog,
  makeLocator,
  mergeDashboardSources,
  removeSet,
  saveCatalog,
  updateLastBackup,
  upsertSet,
  wireBindingAfterRestore
} = require('../src/core/targetCatalog');
const { ensureMachine } = require('../src/core/machineRegistry');
const { addTarget, removeTarget } = require('../src/core/targetRegistry');
const { addSourceToTarget, registerSource, removeSource } = require('../src/core/sourceRegistry');
const { listTargetBackupSources } = require('../src/core/backupSchema');
const { resolveSourceIgnorePath, ensureSourceIgnoreFile } = require('../src/core/ignoreMatcher');

describe('target catalog', () => {
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mybackup-catalog-'));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.remove(tempRoot);
    }
  });

  test('createMachineRecord uses the OS computer name, not a uuid', () => {
    const first = createMachineRecord({
      machineId: 'machine-a',
      hostname: 'Juns-Mac-mini.local'
    });
    expect(first.computerId).toBe('juns-mac-mini');
    const second = createMachineRecord(first);
    expect(second.computerId).toBe('juns-mac-mini');
    const migrated = createMachineRecord({
      machineId: 'machine-a',
      hostname: 'Juns-Mac-mini.local',
      computerId: '23494adf-10f2-4aaa-8bbb-cccccccccccc'
    });
    expect(migrated.computerId).toBe('juns-mac-mini');
  });

  test('catalog json round-trips through load and save', async () => {
    const targetRoot = path.join(tempRoot, 'target');
    await fs.ensureDir(targetRoot);
    const saved = await saveCatalog(targetRoot, {
      ...createEmptyCatalog(),
      sets: [{
        setId: 'set-gpa',
        folderName: 'gpa',
        relativeRoot: 'gpa',
        includeSourceRoot: true,
        targetFolder: '',
        origin: {
          computerId: 'comp-a',
          hostname: 'host-a',
          sourcePath: '/Users/ziyu/gpa'
        }
      }]
    });

    expect(await fs.pathExists(catalogPath(targetRoot))).toBe(true);
    const loaded = await loadCatalog(targetRoot);
    expect(loaded.sets).toHaveLength(1);
    expect(loaded.sets[0]).toMatchObject({
      setId: 'set-gpa',
      folderName: 'gpa',
      relativeRoot: 'gpa',
      origin: {
        computerId: 'comp-a',
        locator: makeLocator('comp-a', '/Users/ziyu/gpa')
      }
    });
    expect(loaded.version).toBe(saved.version);
  });

  test('upsertSet and updateLastBackup keep one set', async () => {
    const targetRoot = path.join(tempRoot, 'target');
    await upsertSet(targetRoot, {
      setId: 'set-gpa',
      folderName: 'gpa',
      relativeRoot: 'gpa',
      origin: {
        computerId: 'comp-a',
        hostname: 'host-a',
        sourcePath: '/Users/ziyu/gpa'
      }
    });
    await updateLastBackup(targetRoot, 'set-gpa', {
      when: '2026-08-16T20:00:00.000Z',
      kind: 'full',
      computerId: 'comp-a'
    });

    const catalog = await loadCatalog(targetRoot);
    expect(catalog.sets).toHaveLength(1);
    expect(catalog.sets[0].lastBackup).toEqual({
      when: '2026-08-16T20:00:00.000Z',
      kind: 'full',
      computerId: 'comp-a'
    });
  });

  test('upsertSet from a second computer keeps the original origin', async () => {
    const targetRoot = path.join(tempRoot, 'target');
    await upsertSet(targetRoot, {
      setId: 'set-gpa',
      folderName: 'gpa',
      relativeRoot: 'gpa',
      origin: {
        computerId: 'comp-a',
        hostname: 'host-a',
        sourcePath: '/Users/ziyu/gpa'
      }
    });
    await upsertSet(targetRoot, {
      setId: 'set-gpa',
      folderName: 'gpa',
      relativeRoot: 'gpa',
      origin: {
        computerId: 'comp-b',
        hostname: 'host-b',
        sourcePath: '/Users/bob/gpa'
      },
      lastBackup: {
        when: '2026-08-16T21:00:00.000Z',
        kind: 'full',
        computerId: 'comp-b'
      },
      seenOn: [{
        computerId: 'comp-b',
        hostname: 'host-b',
        sourcePath: '/Users/bob/gpa',
        role: 'restore'
      }]
    });

    const catalog = await loadCatalog(targetRoot);
    expect(catalog.sets[0].origin.computerId).toBe('comp-a');
    expect(catalog.sets[0].lastBackup.computerId).toBe('comp-b');
    expect(catalog.sets[0].seenOn.some((entry) => entry.computerId === 'comp-b')).toBe(true);
  });

  test('mergeDashboardSources marks other-computer sets offline', async () => {
    const rows = await mergeDashboardSources({
      computerId: 'comp-b',
      localSources: [],
      catalog: {
        sets: [{
          setId: 'set-gpa',
          folderName: 'gpa',
          relativeRoot: 'gpa',
          includeSourceRoot: true,
          targetFolder: '',
          origin: {
            computerId: 'comp-a',
            hostname: 'host-a',
            sourcePath: '/Users/ziyu/gpa',
            locator: 'comp-a:/Users/ziyu/gpa'
          },
          lastBackup: {
            when: '2026-08-16T20:00:00.000Z',
            kind: 'full',
            computerId: 'comp-a'
          },
          seenOn: []
        }]
      }
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].catalogOffline).toBe(true);
    expect(rows[0].sourceId).toBe('set-gpa');
    expect(rows[0].locator).toBe('comp-a:/Users/ziyu/gpa');
    expect(rows[0].watchEnabled).toBe(false);
  });

  test('ensureCatalog reads catalog.json and does not walk set folders', async () => {
    const targetRoot = path.join(tempRoot, 'target');
    const gpaRoot = path.join(targetRoot, 'gpa');
    await fs.ensureDir(gpaRoot);
    await fs.writeFile(path.join(gpaRoot, 'secret.txt'), 'leave-me');
    await saveCatalog(targetRoot, {
      sets: [{
        setId: 'set-gpa',
        folderName: 'gpa',
        relativeRoot: 'gpa',
        origin: {
          computerId: 'comp-a',
          sourcePath: '/Users/ziyu/gpa'
        }
      }]
    });

    const readdir = jest.spyOn(fs, 'readdir');
    try {
      const catalog = await ensureCatalog(targetRoot, { sources: [] });
      expect(catalog.sets[0].setId).toBe('set-gpa');
      const walkedGpa = readdir.mock.calls.some(([entry]) => {
        const resolved = path.resolve(String(entry));
        return resolved === path.resolve(gpaRoot)
          || resolved.startsWith(`${path.resolve(gpaRoot)}${path.sep}`);
      });
      expect(walkedGpa).toBe(false);
    } finally {
      readdir.mockRestore();
    }
  });

  test('removeSet drops the catalog definition and leaves other sets', async () => {
    const targetRoot = path.join(tempRoot, 'target');
    await upsertSet(targetRoot, {
      setId: 'set-gpa',
      folderName: 'gpa',
      relativeRoot: 'gpa',
      origin: {
        computerId: 'comp-a',
        sourcePath: '/Users/ziyu/gpa'
      }
    });
    await upsertSet(targetRoot, {
      setId: 'set-photos',
      folderName: 'photos',
      relativeRoot: 'photos',
      origin: {
        computerId: 'comp-a',
        sourcePath: '/Users/ziyu/photos'
      }
    });

    const removed = await removeSet(targetRoot, 'set-gpa');
    expect(removed.setId).toBe('set-gpa');
    const catalog = await loadCatalog(targetRoot);
    expect(catalog.sets.map((set) => set.setId)).toEqual(['set-photos']);
  });

  test('addSourceToTarget writes source, ignore rules, and catalog set together', async () => {
    const appDataRoot = path.join(tempRoot, 'app');
    const targetRoot = path.join(tempRoot, 'target');
    const sourcePath = path.join(tempRoot, 'gpa');
    await fs.ensureDir(sourcePath);
    await fs.writeFile(path.join(sourcePath, 'notes.txt'), 'notes');

    const machine = await ensureMachine(appDataRoot, {
      hostname: 'host-a',
      seed: 'add-source-atomic-seed'
    });
    await addTarget(appDataRoot, targetRoot);
    const source = await addSourceToTarget(appDataRoot, {
      targetRoot,
      machineId: machine.machineId,
      sourcePath,
      includeSourceRoot: true,
      rulesText: 'node_modules/\n'
    }, machine);

    expect(source.sourceId).toBeTruthy();
    expect(source.setId).toBeTruthy();
    expect(await fs.readFile(resolveSourceIgnorePath(appDataRoot, source), 'utf8')).toBe('node_modules/\n');
    const catalog = await loadCatalog(targetRoot);
    expect(catalog.sets).toHaveLength(1);
    expect(catalog.sets[0]).toMatchObject({
      setId: source.setId,
      relativeRoot: 'gpa',
      origin: {
        sourcePath: path.resolve(sourcePath)
      }
    });
    expect(await listTargetBackupSources(appDataRoot, targetRoot)).toHaveLength(1);
  });

  test('restore to a new folder does not replace the existing source', async () => {
    const appDataRoot = path.join(tempRoot, 'app');
    const targetRoot = path.join(tempRoot, 'target');
    const sourcePath = path.join(tempRoot, 'gpa');
    const restorePath = path.join(tempRoot, 'gpa-copy');
    await fs.ensureDir(sourcePath);
    await fs.ensureDir(restorePath);
    await fs.writeFile(path.join(sourcePath, 'notes.txt'), 'notes');

    const machine = await ensureMachine(appDataRoot, {
      hostname: 'host-a',
      seed: 'restore-keep-source-seed'
    });
    await addTarget(appDataRoot, targetRoot);
    const source = await addSourceToTarget(appDataRoot, {
      targetRoot,
      machineId: machine.machineId,
      sourcePath,
      includeSourceRoot: true,
      rulesText: 'node_modules/\n'
    }, machine);

    const wired = await wireBindingAfterRestore({
      appDataRoot,
      targetRoot,
      source,
      destinationRoot: restorePath
    });

    expect(wired.offerNewSource).toBe(true);
    expect(wired.source).toBeNull();

    const locals = await listTargetBackupSources(appDataRoot, targetRoot);
    expect(locals).toHaveLength(1);
    expect(locals[0].sourceId).toBe(source.sourceId);
    expect(locals[0].sourcePath).toBe(path.resolve(sourcePath));
  });

  test('first-time restore on a computer without a local source still offers add', async () => {
    const appDataRoot = path.join(tempRoot, 'app-b');
    const targetRoot = path.join(tempRoot, 'target-b');
    const restorePath = path.join(tempRoot, 'restored-gpa');
    await fs.ensureDir(targetRoot);
    await fs.ensureDir(restorePath);

    const machine = await ensureMachine(appDataRoot, {
      hostname: 'host-b',
      seed: 'restore-first-time-seed'
    });
    await addTarget(appDataRoot, targetRoot);
    await upsertSet(targetRoot, {
      setId: 'set-gpa',
      folderName: 'gpa',
      relativeRoot: 'gpa',
      origin: {
        computerId: 'comp-a',
        sourcePath: '/Users/ziyu/gpa'
      }
    });

    const wired = await wireBindingAfterRestore({
      appDataRoot,
      targetRoot,
      source: {
        sourceId: 'set-gpa',
        setId: 'set-gpa',
        sourcePath: '/Users/ziyu/gpa'
      },
      destinationRoot: restorePath
    });

    expect(wired.offerNewSource).toBe(true);
    expect(wired.source).toBeNull();
    expect(await listTargetBackupSources(appDataRoot, targetRoot)).toEqual([]);
  });

  test('restore into the current source does not offer a new source', async () => {
    const appDataRoot = path.join(tempRoot, 'app');
    const targetRoot = path.join(tempRoot, 'target');
    const sourcePath = path.join(tempRoot, 'gpa');
    await fs.ensureDir(sourcePath);

    const machine = await ensureMachine(appDataRoot, {
      hostname: 'host-a',
      seed: 'restore-same-source-seed'
    });
    await addTarget(appDataRoot, targetRoot);
    const source = await addSourceToTarget(appDataRoot, {
      targetRoot,
      machineId: machine.machineId,
      sourcePath,
      includeSourceRoot: true,
      rulesText: '*.tmp\n'
    }, machine);

    const wired = await wireBindingAfterRestore({
      appDataRoot,
      targetRoot,
      source,
      destinationRoot: sourcePath
    });

    expect(wired.offerNewSource).toBe(false);
    expect(wired.source.sourcePath).toBe(path.resolve(sourcePath));
    expect(await listTargetBackupSources(appDataRoot, targetRoot)).toHaveLength(1);
  });

  test('removeSource deletes catalog set and local registration, not backup files', async () => {
    const appDataRoot = path.join(tempRoot, 'app');
    const targetRoot = path.join(tempRoot, 'target');
    const sourcePath = path.join(tempRoot, 'gpa');
    const backupFile = path.join(targetRoot, 'gpa', 'keep.txt');
    await fs.ensureDir(sourcePath);
    await fs.ensureDir(path.dirname(backupFile));
    await fs.writeFile(backupFile, 'keep-me');

    const machine = await ensureMachine(appDataRoot, {
      hostname: 'host-a',
      seed: 'delete-source-seed'
    });
    await addTarget(appDataRoot, targetRoot);
    const source = await registerSource(appDataRoot, {
      targetRoot,
      machineId: machine.machineId,
      sourcePath,
      includeSourceRoot: true
    });
    await upsertSet(targetRoot, {
      setId: source.setId || source.sourceId,
      folderName: 'gpa',
      relativeRoot: 'gpa',
      origin: {
        computerId: machine.computerId,
        sourcePath
      }
    });
    await ensureSourceIgnoreFile(appDataRoot, source);

    const removed = await removeSource(appDataRoot, {
      targetRoot,
      machineId: machine.machineId,
      sourceId: source.sourceId,
      setId: source.setId || source.sourceId
    });

    expect(removed.sourceId).toBe(source.sourceId);
    expect(await loadCatalog(targetRoot)).toMatchObject({ sets: [] });
    expect(await listTargetBackupSources(appDataRoot, targetRoot)).toEqual([]);
    expect(await fs.pathExists(backupFile)).toBe(true);
    expect(await fs.pathExists(resolveSourceIgnorePath(appDataRoot, source))).toBe(false);

    const rows = await mergeDashboardSources({
      computerId: machine.computerId,
      localSources: await listTargetBackupSources(appDataRoot, targetRoot),
      catalog: await loadCatalog(targetRoot)
    });
    expect(rows).toEqual([]);
  });

  test('removeSource deletes a catalog-only offline row', async () => {
    const appDataRoot = path.join(tempRoot, 'app');
    const targetRoot = path.join(tempRoot, 'target');
    await fs.ensureDir(appDataRoot);
    await addTarget(appDataRoot, targetRoot);
    await upsertSet(targetRoot, {
      setId: 'set-gpa',
      folderName: 'gpa',
      relativeRoot: 'gpa',
      origin: {
        computerId: 'comp-a',
        sourcePath: '/Users/ziyu/gpa'
      }
    });

    const removed = await removeSource(appDataRoot, {
      targetRoot,
      machineId: 'comp-a',
      sourceId: 'set-gpa',
      setId: 'set-gpa'
    });

    expect(removed.setId).toBe('set-gpa');
    expect(await loadCatalog(targetRoot)).toMatchObject({ sets: [] });
  });

  test('removeTarget deletes catalog and local registrations, not backup files', async () => {
    const appDataRoot = path.join(tempRoot, 'app-target');
    const targetRoot = path.join(tempRoot, 'target-disk');
    const sourcePath = path.join(tempRoot, 'photos');
    const backupFile = path.join(targetRoot, 'photos', 'keep.txt');
    await fs.ensureDir(sourcePath);
    await fs.ensureDir(path.dirname(backupFile));
    await fs.writeFile(backupFile, 'keep-me');

    const machine = await ensureMachine(appDataRoot, {
      hostname: 'host-a',
      seed: 'delete-target-seed'
    });
    const target = await addTarget(appDataRoot, targetRoot);
    const source = await registerSource(appDataRoot, {
      targetRoot,
      machineId: machine.machineId,
      sourcePath,
      includeSourceRoot: true
    });
    await upsertSet(targetRoot, {
      setId: source.setId || source.sourceId,
      folderName: 'photos',
      relativeRoot: 'photos',
      origin: {
        computerId: machine.computerId,
        sourcePath
      }
    });
    await upsertSet(targetRoot, {
      setId: 'set-offline',
      folderName: 'docs',
      relativeRoot: 'docs',
      origin: {
        computerId: 'comp-other',
        sourcePath: '/Users/other/docs'
      }
    });
    await ensureSourceIgnoreFile(appDataRoot, source);

    await removeTarget(appDataRoot, target.id);

    expect(await loadCatalog(targetRoot)).toBeNull();
    expect(await fs.pathExists(catalogPath(targetRoot))).toBe(false);
    expect(await listTargetBackupSources(appDataRoot, targetRoot).catch(() => [])).toEqual([]);
    expect(await fs.pathExists(backupFile)).toBe(true);
    expect(await fs.pathExists(resolveSourceIgnorePath(appDataRoot, source))).toBe(false);
  });
});
