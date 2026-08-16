const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { ensureMachine } = require('../src/core/machineRegistry');
const { addTarget } = require('../src/core/targetRegistry');
const { registerSource } = require('../src/core/sourceRegistry');
const { writeSourceIgnoreFile } = require('../src/core/ignoreMatcher');
const { getSourceTargetRoot } = require('../src/core/pathPlanner');
const { backupSource } = require('../src/core/backupCoordinator');
const { restoreSource } = require('../src/core/restoreService');
const { ChangeTracker } = require('../src/core/changeTracking/ChangeTracker');
const { BACKUP_CARD_JSON, BACKUP_CARD_MD, isBackupCardRelativePath } = require('../src/core/backupCard');

describe('E2E copy path', () => {
  const ctx = {};

  function at(minutes) {
    return new Date(Date.UTC(2026, 7, 16, 16, minutes, 0));
  }

  function writeFile(filePath, content, mtime) {
    fs.ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, content);
    if (mtime) {
      const date = mtime instanceof Date ? mtime : new Date(mtime);
      fs.utimesSync(filePath, date, date);
    }
  }

  function sourceFile(...segments) {
    return path.join(ctx.sourceRoot, ...segments);
  }

  function targetFile(...segments) {
    return path.join(ctx.backupSetRoot, ...segments);
  }

  function expectIgnoredAbsent(root = ctx.backupSetRoot) {
    expect(fs.pathExistsSync(path.join(root, 'skip', 'ignored.tmp'))).toBe(false);
    expect(fs.pathExistsSync(path.join(root, 'skip', 'junk'))).toBe(false);
  }

  function expectNoNumberedCopy(dir) {
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(names.some((name) => /hello\s*\(\s*2\s*\)\.txt$/i.test(name))).toBe(false);
  }

  async function readCard() {
    return fs.readJson(path.join(ctx.backupSetRoot, BACKUP_CARD_JSON));
  }

  async function runBackup({ forceNewScan, now }) {
    return backupSource(ctx.targetRoot, ctx.machine.machineId, ctx.source.sourceId, {
      appDataRoot: ctx.appDataRoot,
      forceNewScan,
      now
    });
  }

  async function runRestore({ destinationRoot, appendFolder }) {
    return restoreSource(ctx.targetRoot, {
      appDataRoot: ctx.appDataRoot,
      machineId: ctx.machine.machineId,
      sourceId: ctx.source.sourceId,
      destinationRoot,
      appendFolder
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
    ctx.tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mybackup-e2e-'));
    ctx.appDataRoot = path.join(ctx.tempRoot, 'app');
    ctx.targetRoot = path.join(ctx.tempRoot, 'target');
    ctx.sourceRoot = path.join(ctx.tempRoot, 'source', 'a');
    ctx.newsource = path.join(ctx.tempRoot, 'newsource');
    ctx.newsourceAppend = path.join(ctx.tempRoot, 'newsource-append');

    await fs.ensureDir(ctx.appDataRoot);
    await fs.ensureDir(ctx.targetRoot);
    await addTarget(ctx.appDataRoot, ctx.targetRoot, at(0));
    ctx.machine = await ensureMachine(ctx.appDataRoot, {
      hostname: 'e2e-host',
      seed: 'e2e-seed',
      now: at(1)
    });
    ctx.source = await registerSource(ctx.appDataRoot, {
      targetRoot: ctx.targetRoot,
      machineId: ctx.machine.machineId,
      sourcePath: ctx.sourceRoot,
      targetFolder: '',
      includeSourceRoot: true
    }, at(2));
    ctx.backupSetRoot = path.join(
      ctx.targetRoot,
      getSourceTargetRoot(ctx.machine.machineId, ctx.source)
    );
    expect(path.basename(ctx.backupSetRoot)).toBe('a');

    await writeSourceIgnoreFile(ctx.appDataRoot, ctx.source, '*.tmp\nskip/junk/\n');
    writeFile(sourceFile('keep', 'hello.txt'), 'hello-v1', at(3));
    writeFile(sourceFile('keep', 'nested', 'note.txt'), 'note', at(3));
    writeFile(sourceFile('skip', 'ignored.tmp'), 'tmp-ignore', at(3));
    writeFile(sourceFile('skip', 'junk', 'inside.txt'), 'junk', at(3));
    ctx.tracker = new ChangeTracker(ctx.appDataRoot);
  });

  afterAll(async () => {
    if (ctx.tempRoot) {
      await fs.remove(ctx.tempRoot);
    }
  });

  test('E2E-01 Full Backup copies kept files, ignores junk, writes the card', async () => {
    const summary = await runBackup({ forceNewScan: true, now: at(5) });

    expect(summary.status).toBe('completed');
    expect(await fs.readFile(targetFile('keep', 'hello.txt'), 'utf8')).toBe('hello-v1');
    expect(await fs.readFile(targetFile('keep', 'nested', 'note.txt'), 'utf8')).toBe('note');

    const sourceHello = await fs.stat(sourceFile('keep', 'hello.txt'));
    const targetHello = await fs.stat(targetFile('keep', 'hello.txt'));
    expect(Math.abs(targetHello.mtimeMs - sourceHello.mtimeMs)).toBeLessThanOrEqual(2000);

    expectIgnoredAbsent();
    expect(summary.scanResult).toMatchObject({
      kind: 'full',
      sourceFileCount: 2,
      targetFileCount: 2
    });
    expect(summary.scanResult.sourceFileCount).toBe(summary.scanResult.targetFileCount);
    expect(summary.scanResult.ignoredFileCount).toBeGreaterThanOrEqual(2);
    expect(summary.scanResult.totalFileCount).toBe(
      summary.scanResult.sourceFileCount + summary.scanResult.ignoredFileCount
    );

    const card = await readCard();
    expect(await fs.pathExists(path.join(ctx.backupSetRoot, BACKUP_CARD_MD))).toBe(true);
    expect(card.history).toHaveLength(1);
    expect(card.lastRun.kind).toBe('full');
  });

  test('E2E-02 second Full Backup leaves ignored paths out and recopies nothing', async () => {
    const summary = await runBackup({ forceNewScan: true, now: at(10) });

    expect(summary.status).toBe('completed');
    expect(summary.filesCopied).toBe(0);
    expectIgnoredAbsent();
    const card = await readCard();
    expect(card.history).toHaveLength(2);
  });

  test('E2E-03 file edits are captured in the dirty journal', async () => {
    const helloMtime = new Date(at(3).getTime() + 60_000);
    writeFile(sourceFile('keep', 'hello.txt'), 'hello-v2', helloMtime);
    writeFile(sourceFile('keep', 'new.txt'), 'new', at(14));
    writeFile(sourceFile('keep', 'added', 'dir.txt'), 'dir', at(14));

    await ctx.tracker.recordFileChanged(ctx.source, sourceFile('keep', 'hello.txt'), at(15));
    await ctx.tracker.recordFileChanged(ctx.source, sourceFile('keep', 'new.txt'), at(15));
    await ctx.tracker.recordFileChanged(ctx.source, sourceFile('keep', 'added', 'dir.txt'), at(15));

    const changeList = await ctx.tracker.getChangeList(ctx.source, at(16));
    const folders = changeList.items.map((item) => item.relativePath);
    expect(folders).toEqual(expect.arrayContaining(['keep', 'keep/added']));
  });

  test('E2E-04 Backup Changes copies the dirty set only', async () => {
    const summary = await runBackup({ forceNewScan: false, now: at(20) });

    expect(summary.status).toBe('completed');
    expect(summary.scanResult.kind).toBe('changes');
    expect(summary.filesCopied).toBeGreaterThanOrEqual(3);
    expect(await fs.readFile(targetFile('keep', 'hello.txt'), 'utf8')).toBe('hello-v2');
    expect(await fs.readFile(targetFile('keep', 'new.txt'), 'utf8')).toBe('new');
    expect(await fs.readFile(targetFile('keep', 'added', 'dir.txt'), 'utf8')).toBe('dir');
    expectIgnoredAbsent();

    const card = await readCard();
    expect(card.history[0].kind).toBe('changes');
  });

  test('E2E-05 empty Backup Changes completes with nothing copied', async () => {
    const summary = await runBackup({ forceNewScan: false, now: at(25) });

    expect(summary.status).toBe('completed');
    expect(summary.filesCopied).toBe(0);
  });

  test('E2E-06 keep-newer on backup: source newer writes, target newer and same age skip', async () => {
    writeFile(sourceFile('keep', 'hello.txt'), 'hello-v3', new Date(at(3).getTime() + 120_000));
    await ctx.tracker.recordFileChanged(ctx.source, sourceFile('keep', 'hello.txt'), at(30));
    const sourceNewer = await runBackup({ forceNewScan: false, now: at(30) });
    expect(sourceNewer.status).toBe('completed');
    expect(await fs.readFile(targetFile('keep', 'hello.txt'), 'utf8')).toBe('hello-v3');
    expectNoNumberedCopy(path.join(ctx.backupSetRoot, 'keep'));

    writeFile(targetFile('keep', 'hello.txt'), 'target-wins', new Date(at(3).getTime() + 180_000));
    const targetNewer = await runBackup({ forceNewScan: true, now: at(35) });
    expect(targetNewer.scanResult.skippedNewerFileCount).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(targetFile('keep', 'hello.txt'), 'utf8')).toBe('target-wins');
    expectNoNumberedCopy(path.join(ctx.backupSetRoot, 'keep'));

    const sameAge = at(40);
    writeFile(sourceFile('keep', 'hello.txt'), 'source-same-age', sameAge);
    writeFile(targetFile('keep', 'hello.txt'), 'target-wins', sameAge);
    const sameAgeRun = await runBackup({ forceNewScan: true, now: at(40) });
    expect(await fs.readFile(targetFile('keep', 'hello.txt'), 'utf8')).toBe('target-wins');
    expect(sameAgeRun.filesCopied).toBe(0);
    expectNoNumberedCopy(path.join(ctx.backupSetRoot, 'keep'));

    const targetStat = await fs.stat(targetFile('keep', 'hello.txt'));
    writeFile(sourceFile('keep', 'hello.txt'), 'target-wins', new Date(targetStat.mtimeMs));
    ctx.helloBackupContent = 'target-wins';
  });

  test('E2E-07 deleting a source file does not delete the target copy', async () => {
    await fs.remove(sourceFile('keep', 'new.txt'));
    await ctx.tracker.recordFileChanged(ctx.source, sourceFile('keep', 'new.txt'), at(45));
    const summary = await runBackup({ forceNewScan: false, now: at(45) });

    expect(summary.status).toBe('completed');
    expect(await fs.pathExists(targetFile('keep', 'new.txt'))).toBe(true);
    expect(await fs.readFile(targetFile('keep', 'new.txt'), 'utf8')).toBe('new');
  });

  test('E2E-08 restore into empty newsource copies user files and skips the card', async () => {
    await fs.ensureDir(ctx.newsource);
    const userFiles = await countUserFiles(ctx.backupSetRoot);
    const summary = await runRestore({
      destinationRoot: ctx.newsource,
      appendFolder: false
    });

    expect(summary.restoredFiles).toBe(userFiles);
    expect(await fs.readFile(path.join(ctx.newsource, 'keep', 'hello.txt'), 'utf8')).toBe(ctx.helloBackupContent);
    expect(await fs.readFile(path.join(ctx.newsource, 'keep', 'nested', 'note.txt'), 'utf8')).toBe('note');
    expect(await fs.readFile(path.join(ctx.newsource, 'keep', 'added', 'dir.txt'), 'utf8')).toBe('dir');
    expect(await fs.pathExists(path.join(ctx.newsource, 'keep', 'new.txt'))).toBe(true);
    expectIgnoredAbsent(ctx.newsource);
    expect(await fs.pathExists(path.join(ctx.newsource, BACKUP_CARD_MD))).toBe(false);
    expect(await fs.pathExists(path.join(ctx.newsource, BACKUP_CARD_JSON))).toBe(false);
  });

  test('E2E-09 restore skips a newer destination file', async () => {
    const destHello = path.join(ctx.newsource, 'keep', 'hello.txt');
    const backupStat = await fs.stat(targetFile('keep', 'hello.txt'));
    writeFile(destHello, 'dest-newer', new Date(backupStat.mtimeMs + 60_000));

    const summary = await runRestore({
      destinationRoot: ctx.newsource,
      appendFolder: false
    });

    expect(await fs.readFile(destHello, 'utf8')).toBe('dest-newer');
    expect(summary.skippedRecords).toBeGreaterThanOrEqual(1);
  });

  test('E2E-10 restore overwrites an older destination file', async () => {
    const destHello = path.join(ctx.newsource, 'keep', 'hello.txt');
    const backupStat = await fs.stat(targetFile('keep', 'hello.txt'));
    writeFile(destHello, 'dest-older', new Date(backupStat.mtimeMs - 60_000));

    const summary = await runRestore({
      destinationRoot: ctx.newsource,
      appendFolder: false
    });

    expect(await fs.readFile(destHello, 'utf8')).toBe(ctx.helloBackupContent);
    expect(summary.restoredFiles).toBeGreaterThanOrEqual(1);
  });

  test('E2E-11 restore append on nests files under a/', async () => {
    await fs.ensureDir(ctx.newsourceAppend);
    const summary = await runRestore({
      destinationRoot: ctx.newsourceAppend,
      appendFolder: true
    });

    expect(summary.destinationRoot).toBe(path.join(ctx.newsourceAppend, 'a'));
    expect(await fs.pathExists(path.join(ctx.newsourceAppend, 'a', 'keep', 'hello.txt'))).toBe(true);
    expect(await fs.pathExists(path.join(ctx.newsourceAppend, 'keep', 'hello.txt'))).toBe(false);
    expect(await fs.pathExists(path.join(ctx.newsourceAppend, 'a', BACKUP_CARD_MD))).toBe(false);
  });
});
