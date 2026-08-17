const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { ensureMachine } = require('../src/core/machineRegistry');
const { addTarget } = require('../src/core/targetRegistry');
const { addSourceToTarget, registerSource } = require('../src/core/sourceRegistry');
const { SOURCE_IGNORE_TEMPLATE } = require('../src/core/ignoreMatcher');
const { getSourceTargetRoot } = require('../src/core/pathPlanner');
const { backupSource } = require('../src/core/backupCoordinator');
const { restoreSource } = require('../src/core/restoreService');
const { loadCurrentMachineContext } = require('../src/core/sourceCatalog');
const { loadCatalog } = require('../src/core/targetCatalog');
const { listTargetBackupSources } = require('../src/core/backupSchema');
const { BACKUP_CARD_JSON } = require('../src/core/backupCard');

describe('AT-CAT01 target catalog', () => {
  const ctx = {};

  function at(minutes) {
    return new Date(Date.UTC(2026, 7, 16, 18, minutes, 0));
  }

  function writeFile(filePath, content, mtime) {
    fs.ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, content);
    if (mtime) {
      const date = mtime instanceof Date ? mtime : new Date(mtime);
      fs.utimesSync(filePath, date, date);
    }
  }

  async function setupComputer(name, seed) {
    const appDataRoot = path.join(ctx.tempRoot, name, 'app');
    await fs.ensureDir(appDataRoot);
    const machine = await ensureMachine(appDataRoot, {
      hostname: name,
      seed,
      now: at(1)
    });
    return { appDataRoot, machine };
  }

  beforeAll(async () => {
    ctx.tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mybackup-cat01-'));
    ctx.targetRoot = path.join(ctx.tempRoot, 'target');
    ctx.sourceA = path.join(ctx.tempRoot, 'a-source', 'gpa');
    ctx.restoreB = path.join(ctx.tempRoot, 'b-restore', 'gpa');
    ctx.restoreB2 = path.join(ctx.tempRoot, 'b-rewire', 'gpa');
    await fs.ensureDir(ctx.targetRoot);
    await fs.ensureDir(ctx.sourceA);
    writeFile(path.join(ctx.sourceA, 'keep', 'hello.txt'), 'hello-a', at(2));

    ctx.a = await setupComputer('computer-a', 'seed-a');
    ctx.b = await setupComputer('computer-b', 'seed-b');
    await addTarget(ctx.a.appDataRoot, ctx.targetRoot, at(3));
    ctx.source = await registerSource(ctx.a.appDataRoot, {
      targetRoot: ctx.targetRoot,
      machineId: ctx.a.machine.machineId,
      sourcePath: ctx.sourceA,
      targetFolder: '',
      includeSourceRoot: true
    }, at(4));
    ctx.backupSetRoot = path.join(
      ctx.targetRoot,
      getSourceTargetRoot(ctx.a.machine.machineId, ctx.source)
    );
  });

  afterAll(async () => {
    if (ctx.tempRoot) {
      await fs.remove(ctx.tempRoot);
    }
  });

  test('AT-CAT01-2 A Add Source + Full Backup writes set, locator, lastBackup', async () => {
    const { bindSourceToSet } = require('../src/core/targetCatalog');
    await bindSourceToSet(ctx.a.appDataRoot, ctx.targetRoot, ctx.source, ctx.a.machine, at(5));
    const summary = await backupSource(
      ctx.targetRoot,
      ctx.a.machine.machineId,
      ctx.source.sourceId,
      {
        appDataRoot: ctx.a.appDataRoot,
        forceNewScan: true,
        now: at(6)
      }
    );

    expect(summary.status).toBe('completed');
    const catalog = await loadCatalog(ctx.targetRoot);
    expect(catalog.sets).toHaveLength(1);
    ctx.set = catalog.sets[0];
    expect(ctx.set.relativeRoot).toBe('gpa');
    expect(ctx.set.origin.computerId).toBe(ctx.a.machine.computerId);
    expect(ctx.set.origin.locator).toBe(`${ctx.a.machine.computerId}:${path.resolve(ctx.sourceA)}`);
    expect(ctx.set.lastBackup).toMatchObject({
      kind: 'full',
      computerId: ctx.a.machine.computerId
    });
  });

  test('AT-CAT01-1 Add Target reads only catalog.json', async () => {
    const gpaRoot = ctx.backupSetRoot;
    const readdir = jest.spyOn(fs, 'readdir');
    try {
      await addTarget(ctx.b.appDataRoot, ctx.targetRoot, at(7));
      const context = await loadCurrentMachineContext(ctx.targetRoot, {
        appDataRoot: ctx.b.appDataRoot
      });
      expect(context.sources).toHaveLength(1);
      expect(context.sources[0].setId).toBe(ctx.set.setId);
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

  test('AT-CAT01-3 B Add Target only is offline with Restore on and Backup off', async () => {
    const context = await loadCurrentMachineContext(ctx.targetRoot, {
      appDataRoot: ctx.b.appDataRoot
    });
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].catalogOffline).toBe(true);
    expect(context.sources[0].watchEnabled).toBe(false);
    expect(context.sources[0].locator).toContain(ctx.a.machine.computerId);
    expect(context.sources[0].sourceId).toBe(ctx.set.setId);
  });

  test('AT-CAT01-4 B Restore copies the tree and adding the dest makes it online', async () => {
    await fs.ensureDir(ctx.restoreB);
    const summary = await restoreSource(ctx.targetRoot, {
      appDataRoot: ctx.b.appDataRoot,
      machineId: ctx.set.origin.computerId,
      sourceId: ctx.set.setId,
      destinationRoot: ctx.restoreB,
      appendFolder: false
    });

    expect(summary.status).toBe('completed');
    expect(summary.offerNewSource).toBe(true);
    expect(await fs.readFile(path.join(ctx.restoreB, 'keep', 'hello.txt'), 'utf8')).toBe('hello-a');
    expect(await listTargetBackupSources(ctx.b.appDataRoot, ctx.targetRoot)).toEqual([]);

    const catalog = await loadCatalog(ctx.targetRoot);
    const set = catalog.sets[0];
    expect(set.seenOn.some((entry) => (
      entry.computerId === ctx.b.machine.computerId
      && entry.sourcePath === path.resolve(ctx.restoreB)
    ))).toBe(true);

    const offline = await loadCurrentMachineContext(ctx.targetRoot, {
      appDataRoot: ctx.b.appDataRoot
    });
    expect(offline.sources[0].catalogOffline).toBe(true);

    ctx.bSource = await addSourceToTarget(ctx.b.appDataRoot, {
      targetRoot: ctx.targetRoot,
      machineId: ctx.b.machine.machineId,
      sourcePath: ctx.restoreB,
      targetFolder: ctx.set.targetFolder || '',
      includeSourceRoot: ctx.set.includeSourceRoot,
      relativeRoot: ctx.set.relativeRoot,
      folderName: ctx.set.folderName,
      setId: ctx.set.setId,
      rulesText: SOURCE_IGNORE_TEMPLATE
    }, ctx.b.machine);

    const context = await loadCurrentMachineContext(ctx.targetRoot, {
      appDataRoot: ctx.b.appDataRoot
    });
    expect(context.sources[0].catalogOffline).toBe(false);
    expect(context.sources[0].sourcePath).toBe(path.resolve(ctx.restoreB));
    expect(context.sources[0].setId).toBe(ctx.set.setId);
  });

  test('AT-CAT01-5 B Full Backup appends history and lastBackup is B', async () => {
    writeFile(path.join(ctx.restoreB, 'keep', 'from-b.txt'), 'from-b', at(10));
    const summary = await backupSource(
      ctx.targetRoot,
      ctx.bSource.machineId,
      ctx.bSource.sourceId,
      {
        appDataRoot: ctx.b.appDataRoot,
        forceNewScan: true,
        now: at(11)
      }
    );

    expect(summary.status).toBe('completed');
    expect(await fs.readFile(path.join(ctx.backupSetRoot, 'keep', 'from-b.txt'), 'utf8')).toBe('from-b');

    const catalog = await loadCatalog(ctx.targetRoot);
    expect(catalog.sets[0].lastBackup.computerId).toBe(ctx.b.machine.computerId);

    const card = await fs.readJson(path.join(ctx.backupSetRoot, BACKUP_CARD_JSON));
    expect(card.history.length).toBeGreaterThanOrEqual(2);
    expect(card.history[0].kind).toBe('full');
  });

  test('AT-CAT01-6 wipe app data keeps the OS computer name and Restore re-wires', async () => {
    const previousComputerId = ctx.b.machine.computerId;
    await fs.remove(ctx.b.appDataRoot);
    ctx.b = await setupComputer('computer-b', 'seed-b-wiped');
    expect(ctx.b.machine.computerId).toBe(previousComputerId);
    expect(ctx.b.machine.computerId).toBe('computer-b');

    await addTarget(ctx.b.appDataRoot, ctx.targetRoot, at(12));
    const offline = await loadCurrentMachineContext(ctx.targetRoot, {
      appDataRoot: ctx.b.appDataRoot
    });
    expect(offline.sources[0].catalogOffline).toBe(true);
    expect(offline.sources[0].locator).toContain(ctx.a.machine.computerId);

    await fs.ensureDir(ctx.restoreB2);
    const summary = await restoreSource(ctx.targetRoot, {
      appDataRoot: ctx.b.appDataRoot,
      machineId: offline.sources[0].machineId,
      sourceId: offline.sources[0].sourceId,
      destinationRoot: ctx.restoreB2,
      appendFolder: false
    });
    expect(summary.offerNewSource).toBe(true);

    await addSourceToTarget(ctx.b.appDataRoot, {
      targetRoot: ctx.targetRoot,
      machineId: ctx.b.machine.machineId,
      sourcePath: ctx.restoreB2,
      targetFolder: ctx.set.targetFolder || '',
      includeSourceRoot: ctx.set.includeSourceRoot,
      relativeRoot: ctx.set.relativeRoot,
      folderName: ctx.set.folderName,
      setId: ctx.set.setId,
      rulesText: SOURCE_IGNORE_TEMPLATE
    }, ctx.b.machine);

    const wired = await loadCurrentMachineContext(ctx.targetRoot, {
      appDataRoot: ctx.b.appDataRoot
    });
    expect(wired.sources[0].catalogOffline).toBe(false);
    expect(wired.sources[0].sourcePath).toBe(path.resolve(ctx.restoreB2));

    const catalog = await loadCatalog(ctx.targetRoot);
    expect(catalog.sets[0].seenOn.some((entry) => (
      entry.computerId === ctx.b.machine.computerId
      && entry.sourcePath === path.resolve(ctx.restoreB2)
    ))).toBe(true);

    const locals = await listTargetBackupSources(ctx.b.appDataRoot, ctx.targetRoot);
    expect(locals).toHaveLength(1);
    expect(locals[0].setId).toBe(ctx.set.setId);
  });
});
