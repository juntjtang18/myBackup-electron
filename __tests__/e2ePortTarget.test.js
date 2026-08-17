const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { ensureMachine } = require('../src/core/machineRegistry');
const { addTarget } = require('../src/core/targetRegistry');
const { addSourceToTarget, registerSource } = require('../src/core/sourceRegistry');
const { SOURCE_IGNORE_TEMPLATE } = require('../src/core/ignoreMatcher');
const { bindSourceToSet, loadCatalog } = require('../src/core/targetCatalog');
const { getSourceTargetRoot } = require('../src/core/pathPlanner');
const { backupSource } = require('../src/core/backupCoordinator');
const { restoreSource } = require('../src/core/restoreService');
const { loadCurrentMachineContext } = require('../src/core/sourceCatalog');
const { listTargetBackupSources } = require('../src/core/backupSchema');
const { BACKUP_CARD_JSON, BACKUP_CARD_MD, isBackupCardRelativePath } = require('../src/core/backupCard');

describe('E2E port target to a new computer', () => {
  const ctx = {};

  function at(minutes) {
    return new Date(Date.UTC(2026, 7, 16, 20, minutes, 0));
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

  async function dashboard(computer) {
    return loadCurrentMachineContext(ctx.targetRoot, {
      appDataRoot: computer.appDataRoot
    });
  }

  async function countUserFiles(root) {
    let count = 0;
    async function visit(dirPath, relativeRoot) {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = relativeRoot === '.'
          ? entry.name
          : path.posix.join(relativeRoot, entry.name);
        const absolutePath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath);
          continue;
        }
        if (entry.isFile() && !isBackupCardRelativePath(relativePath)) {
          count += 1;
        }
      }
    }
    if (await fs.pathExists(root)) {
      await visit(root, '.');
    }
    return count;
  }

  beforeAll(async () => {
    ctx.tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mybackup-e2e-port-'));
    ctx.targetRoot = path.join(ctx.tempRoot, 'target');
    ctx.sourceA = path.join(ctx.tempRoot, 'computer-a', 'gpa');
    ctx.restoreB = path.join(ctx.tempRoot, 'computer-b', 'Documents');
    ctx.restoreB2 = path.join(ctx.tempRoot, 'computer-b-wiped', 'Photos');

    await fs.ensureDir(ctx.targetRoot);
    await fs.ensureDir(ctx.sourceA);
    writeFile(path.join(ctx.sourceA, 'keep', 'hello.txt'), 'hello-from-a', at(2));
    writeFile(path.join(ctx.sourceA, 'keep', 'nested', 'note.txt'), 'note-from-a', at(2));

    ctx.a = await setupComputer('computer-a', 'e2e-port-a');
    ctx.b = await setupComputer('computer-b', 'e2e-port-b');
    await addTarget(ctx.a.appDataRoot, ctx.targetRoot, at(3));
    ctx.source = await registerSource(ctx.a.appDataRoot, {
      targetRoot: ctx.targetRoot,
      machineId: ctx.a.machine.machineId,
      sourcePath: ctx.sourceA,
      targetFolder: '',
      includeSourceRoot: true
    }, at(4));
    ctx.source = await bindSourceToSet(ctx.a.appDataRoot, ctx.targetRoot, ctx.source, ctx.a.machine, at(4));
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

  test('E2E-PORT-01 A Full Backup writes the catalog set and locator', async () => {
    const summary = await backupSource(
      ctx.targetRoot,
      ctx.a.machine.machineId,
      ctx.source.sourceId,
      {
        appDataRoot: ctx.a.appDataRoot,
        forceNewScan: true,
        now: at(5)
      }
    );

    expect(summary.status).toBe('completed');
    expect(await fs.readFile(path.join(ctx.backupSetRoot, 'keep', 'hello.txt'), 'utf8')).toBe('hello-from-a');
    expect(await fs.pathExists(path.join(ctx.backupSetRoot, BACKUP_CARD_MD))).toBe(true);

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

  test('E2E-PORT-02 B Add Target recognizes the set offline without walking gpa/', async () => {
    const readdir = jest.spyOn(fs, 'readdir');
    try {
      await addTarget(ctx.b.appDataRoot, ctx.targetRoot, at(6));
      const context = await dashboard(ctx.b);
      expect(context.sources).toHaveLength(1);
      expect(context.sources[0].catalogOffline).toBe(true);
      expect(context.sources[0].setId).toBe(ctx.set.setId);
      expect(context.sources[0].locator).toBe(ctx.set.origin.locator);
      expect(context.sources[0].watchEnabled).toBe(false);

      const walkedGpa = readdir.mock.calls.some(([entry]) => {
        const resolved = path.resolve(String(entry));
        return resolved === path.resolve(ctx.backupSetRoot)
          || resolved.startsWith(`${path.resolve(ctx.backupSetRoot)}${path.sep}`);
      });
      expect(walkedGpa).toBe(false);
    } finally {
      readdir.mockRestore();
    }

    const locals = await listTargetBackupSources(ctx.b.appDataRoot, ctx.targetRoot);
    expect(locals).toHaveLength(0);
  });

  test('E2E-PORT-03 B Restore copies the tree, skips the card, and wires a local source', async () => {
    await fs.ensureDir(ctx.restoreB);
    const userFiles = await countUserFiles(ctx.backupSetRoot);
    const summary = await restoreSource(ctx.targetRoot, {
      appDataRoot: ctx.b.appDataRoot,
      machineId: ctx.set.origin.computerId,
      sourceId: ctx.set.setId,
      destinationRoot: ctx.restoreB,
      appendFolder: false
    });

    expect(summary.status).toBe('completed');
    expect(summary.offerNewSource).toBe(true);
    expect(summary.restoredFiles).toBe(userFiles);
    expect(await fs.readFile(path.join(ctx.restoreB, 'keep', 'hello.txt'), 'utf8')).toBe('hello-from-a');
    expect(await fs.readFile(path.join(ctx.restoreB, 'keep', 'nested', 'note.txt'), 'utf8')).toBe('note-from-a');
    expect(await fs.pathExists(path.join(ctx.restoreB, BACKUP_CARD_MD))).toBe(false);
    expect(await fs.pathExists(path.join(ctx.restoreB, BACKUP_CARD_JSON))).toBe(false);
    expect(await listTargetBackupSources(ctx.b.appDataRoot, ctx.targetRoot)).toEqual([]);

    const catalog = await loadCatalog(ctx.targetRoot);
    expect(catalog.sets[0].origin.computerId).toBe(ctx.a.machine.computerId);
    expect(catalog.sets[0].seenOn.some((entry) => (
      entry.computerId === ctx.b.machine.computerId
      && entry.sourcePath === path.resolve(ctx.restoreB)
    ))).toBe(true);

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

    const context = await dashboard(ctx.b);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].catalogOffline).toBe(false);
    expect(context.sources[0].sourcePath).toBe(path.resolve(ctx.restoreB));
    expect(context.sources[0].setId).toBe(ctx.set.setId);
    expect(context.sources[0].relativeRoot).toBe('gpa');
  });

  test('E2E-PORT-04 B Full Backup writes the same gpa tree and lastBackup is B', async () => {
    writeFile(path.join(ctx.restoreB, 'keep', 'from-b.txt'), 'hello-from-b', at(8));
    const summary = await backupSource(
      ctx.targetRoot,
      ctx.bSource.machineId,
      ctx.bSource.sourceId,
      {
        appDataRoot: ctx.b.appDataRoot,
        forceNewScan: true,
        now: at(9)
      }
    );

    expect(summary.status).toBe('completed');
    expect(path.basename(ctx.restoreB)).toBe('Documents');
    expect(await fs.pathExists(path.join(ctx.targetRoot, 'Documents'))).toBe(false);
    expect(await fs.readFile(path.join(ctx.backupSetRoot, 'keep', 'from-b.txt'), 'utf8')).toBe('hello-from-b');
    expect(await fs.readFile(path.join(ctx.backupSetRoot, 'keep', 'hello.txt'), 'utf8')).toBe('hello-from-a');

    const catalog = await loadCatalog(ctx.targetRoot);
    expect(catalog.sets).toHaveLength(1);
    expect(catalog.sets[0].setId).toBe(ctx.set.setId);
    expect(catalog.sets[0].lastBackup.computerId).toBe(ctx.b.machine.computerId);
    expect(catalog.sets[0].origin.computerId).toBe(ctx.a.machine.computerId);

    const card = await fs.readJson(path.join(ctx.backupSetRoot, BACKUP_CARD_JSON));
    expect(card.history.length).toBeGreaterThanOrEqual(2);
    expect(card.history[0].kind).toBe('full');
  });

  test('E2E-PORT-05 wipe B app data keeps the OS computer name; Restore re-wires', async () => {
    const previousComputerId = ctx.b.machine.computerId;
    await fs.remove(ctx.b.appDataRoot);
    ctx.b = await setupComputer('computer-b', 'e2e-port-b-wiped');
    expect(ctx.b.machine.computerId).toBe(previousComputerId);
    expect(ctx.b.machine.computerId).toBe('computer-b');

    await addTarget(ctx.b.appDataRoot, ctx.targetRoot, at(10));
    const offline = await dashboard(ctx.b);
    expect(offline.sources).toHaveLength(1);
    expect(offline.sources[0].catalogOffline).toBe(true);
    expect(offline.sources[0].locator).toContain(ctx.a.machine.computerId);
    expect(offline.sources[0].setId).toBe(ctx.set.setId);

    await fs.ensureDir(ctx.restoreB2);
    const summary = await restoreSource(ctx.targetRoot, {
      appDataRoot: ctx.b.appDataRoot,
      machineId: offline.sources[0].machineId,
      sourceId: offline.sources[0].sourceId,
      destinationRoot: ctx.restoreB2,
      appendFolder: false
    });

    expect(summary.status).toBe('completed');
    expect(summary.offerNewSource).toBe(true);
    expect(await fs.readFile(path.join(ctx.restoreB2, 'keep', 'from-b.txt'), 'utf8')).toBe('hello-from-b');

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

    const wired = await dashboard(ctx.b);
    expect(wired.sources[0].catalogOffline).toBe(false);
    expect(wired.sources[0].sourcePath).toBe(path.resolve(ctx.restoreB2));
    expect(wired.sources[0].setId).toBe(ctx.set.setId);
    expect(wired.sources[0].relativeRoot).toBe('gpa');

    const locals = await listTargetBackupSources(ctx.b.appDataRoot, ctx.targetRoot);
    expect(locals).toHaveLength(1);
    expect(locals[0].setId).toBe(ctx.set.setId);
    expect(locals[0].sourcePath).toBe(path.resolve(ctx.restoreB2));

    const catalog = await loadCatalog(ctx.targetRoot);
    expect(catalog.sets[0].seenOn.some((entry) => (
      entry.computerId === ctx.b.machine.computerId
      && entry.sourcePath === path.resolve(ctx.restoreB2)
    ))).toBe(true);
  });
});
