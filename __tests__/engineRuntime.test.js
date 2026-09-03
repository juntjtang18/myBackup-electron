const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { createIgnoreMatcher, buildIgnoreRules } = require('../src/core/ignoreMatcher');
const { scanFullSource } = require('../src/core/engine/fullScanner');
const { scanDirtyFolders } = require('../src/core/engine/dirtyFolderScanner');
const { createFileQueue } = require('../src/core/engine/fileQueue');
const { createFileWorkerPool } = require('../src/core/engine/fileWorkerPool');
const { shouldCopySourceFile } = require('../src/core/fileTaskProcessor');
const { createFolderHash, walkFoldersFromCursor } = require('../src/core/cursor');

describe('engine runtime modules', () => {
  let tempRootPath;

  beforeEach(() => {
    tempRootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mybackup-engine-'));
  });

  afterEach(() => {
    fs.removeSync(tempRootPath);
  });

  test('full scanner traverses the whole source tree and skips default OS junk paths', async () => {
    const sourcePath = path.join(tempRootPath, 'source');
    await fs.ensureDir(path.join(sourcePath, 'docs', 'nested'));
    await fs.ensureDir(path.join(sourcePath, 'node_modules', 'pkg'));
    await fs.writeFile(path.join(sourcePath, 'root.txt'), 'root');
    await fs.writeFile(path.join(sourcePath, '.DS_Store'), 'ignored');
    await fs.writeFile(path.join(sourcePath, 'docs', 'a.txt'), 'a');
    await fs.writeFile(path.join(sourcePath, 'docs', '.DS_Store'), 'ignored');
    await fs.writeFile(path.join(sourcePath, 'docs', 'nested', 'b.txt'), 'b');
    await fs.writeFile(path.join(sourcePath, 'node_modules', 'pkg', 'skip.js'), 'skip');

    const enqueued = [];
    const folders = [];
    const ignoreMatcher = createIgnoreMatcher(buildIgnoreRules(''));

    const summary = await scanFullSource({
      sourcePath,
      ignoreMatcher,
      onFolder: async (folder) => folders.push(folder.relativePath),
      enqueueFile: async (file) => enqueued.push(file.sourceRelativePath)
    });

    expect(summary).toMatchObject({
      mode: 'full',
      foldersScanned: 5,
      filesEnqueued: 4,
      skippedFolders: 0,
      skippedFiles: 0
    });
    expect(folders).toEqual(['.', 'docs', 'docs/nested', 'node_modules', 'node_modules/pkg']);
    expect(enqueued).toEqual(['root.txt', 'docs/a.txt', 'docs/nested/b.txt', 'node_modules/pkg/skip.js']);
  });

  test('dirty-folder scanner enqueues only direct child files of selected dirty folders', async () => {
    const sourcePath = path.join(tempRootPath, 'source');
    await fs.ensureDir(path.join(sourcePath, 'a', 'b', 'c', 'nested'));
    await fs.ensureDir(path.join(sourcePath, 'a', 'd'));
    await fs.writeFile(path.join(sourcePath, 'a', 'root.txt'), 'root');
    await fs.writeFile(path.join(sourcePath, 'a', 'b', 'file.txt'), 'file');
    await fs.writeFile(path.join(sourcePath, 'a', 'b', 'c', 'deep.txt'), 'deep');
    await fs.writeFile(path.join(sourcePath, 'a', 'b', 'c', 'nested', 'skip.txt'), 'skip');
    await fs.writeFile(path.join(sourcePath, 'a', 'd', 'skip.txt'), 'skip');

    const enqueued = [];
    const folders = [];
    const dirtyState = {
      version: 1,
      sourceId: 'source-a',
      lastEventSeq: 4,
      updatedAt: '2026-06-11T00:00:00.000Z',
      folders: {
        'a': { seq: 1, changedAt: '2026-06-11T00:00:01.000Z' },
        'a/b': { seq: 2, changedAt: '2026-06-11T00:00:02.000Z' },
        'a/b/c': { seq: 3, changedAt: '2026-06-11T00:00:03.000Z' },
        'a/d': { seq: 5, changedAt: '2026-06-11T00:00:05.000Z' }
      }
    };

    const summary = await scanDirtyFolders({
      sourcePath,
      dirtyState,
      scanSeq: 3,
      onFolder: async (folder) => folders.push(folder.relativePath),
      enqueueFile: async (file) => enqueued.push(file.sourceRelativePath)
    });

    expect(summary).toMatchObject({
      mode: 'incremental',
      scanSeq: 3,
      foldersScanned: 3,
      filesEnqueued: 3,
      skippedFolders: 0,
      skippedFiles: 0
    });
    expect(summary.selectedFolders).toEqual(['a', 'a/b', 'a/b/c']);
    expect(folders).toEqual(['a', 'a/b', 'a/b/c']);
    expect(enqueued).toEqual(['a/root.txt', 'a/b/file.txt', 'a/b/c/deep.txt']);
  });

  test('dirty-folder scanner can resume from a selected dirty folder', async () => {
    const sourcePath = path.join(tempRootPath, 'source');
    await fs.ensureDir(path.join(sourcePath, 'a', 'b', 'c'));
    await fs.writeFile(path.join(sourcePath, 'a', 'root.txt'), 'root');
    await fs.writeFile(path.join(sourcePath, 'a', 'b', 'file.txt'), 'file');
    await fs.writeFile(path.join(sourcePath, 'a', 'b', 'c', 'deep.txt'), 'deep');

    const enqueued = [];
    const summary = await scanDirtyFolders({
      sourcePath,
      dirtyState: {
        version: 1,
        sourceId: 'source-a',
        lastEventSeq: 3,
        updatedAt: '2026-06-11T00:00:00.000Z',
        folders: {
          'a': { seq: 1, changedAt: '2026-06-11T00:00:01.000Z' },
          'a/b': { seq: 2, changedAt: '2026-06-11T00:00:02.000Z' },
          'a/b/c': { seq: 3, changedAt: '2026-06-11T00:00:03.000Z' }
        }
      },
      scanSeq: 3,
      resumeFrom: 'a/b',
      enqueueFile: async (file) => enqueued.push(file.sourceRelativePath)
    });

    expect(summary.selectedFolders).toEqual(['a/b', 'a/b/c']);
    expect(enqueued).toEqual(['a/b/file.txt', 'a/b/c/deep.txt']);
  });

  test('full scanner continues when a folder cannot be listed', async () => {
    const sourcePath = path.join(tempRootPath, 'source');
    await fs.ensureDir(path.join(sourcePath, 'ok'));
    await fs.ensureDir(path.join(sourcePath, 'blocked'));
    await fs.writeFile(path.join(sourcePath, 'ok', 'a.txt'), 'a');
    await fs.writeFile(path.join(sourcePath, 'blocked', 'b.txt'), 'b');

    const originalReaddir = fs.readdir.bind(fs);
    const spy = jest.spyOn(fs, 'readdir');
    spy.mockImplementation(async (candidate, options) => {
      if (String(candidate) === path.join(sourcePath, 'blocked')) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalReaddir(candidate, options);
    });

    const enqueued = [];
    const missing = [];
    const summary = await scanFullSource({
      sourcePath,
      enqueueFile: async (file) => enqueued.push(file.sourceRelativePath),
      onMissingFolder: async (folder) => missing.push(folder.relativePath)
    });
    spy.mockRestore();

    expect(enqueued).toEqual(['ok/a.txt']);
    expect(missing).toEqual(['blocked']);
    expect(summary.skippedFolders).toBe(1);
    expect(summary.filesEnqueued).toBe(1);
  });

  test('full scanner continues when a file cannot be statted', async () => {
    const sourcePath = path.join(tempRootPath, 'source');
    await fs.ensureDir(path.join(sourcePath, 'docs'));
    await fs.writeFile(path.join(sourcePath, 'docs', 'good.txt'), 'good');
    await fs.writeFile(path.join(sourcePath, 'docs', 'bad.txt'), 'bad');

    const originalLstat = fs.lstat.bind(fs);
    const spy = jest.spyOn(fs, 'lstat');
    spy.mockImplementation(async (candidate) => {
      if (String(candidate) === path.join(sourcePath, 'docs', 'bad.txt')) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalLstat(candidate);
    });

    const enqueued = [];
    const missing = [];
    const summary = await scanFullSource({
      sourcePath,
      enqueueFile: async (file) => enqueued.push(file.sourceRelativePath),
      onMissingFile: async (fileEntry) => missing.push(fileEntry.relativePath)
    });
    spy.mockRestore();

    expect(enqueued).toEqual(['docs/good.txt']);
    expect(missing).toEqual(['docs/bad.txt']);
    expect(summary.skippedFiles).toBe(1);
    expect(summary.filesEnqueued).toBe(1);
  });

  test('file queue and worker pool process enqueued file tasks', async () => {
    const queue = createFileQueue({ capacity: 8 });
    const events = [];
    const completed = [];
    const pool = createFileWorkerPool({
      queue,
      size: 2,
      onEvent: (event) => events.push(event.type),
      process: async (item) => {
        completed.push(item.id);
        return { ok: true, id: item.id };
      }
    });

    pool.start();
    await queue.push({ id: 'a' });
    await queue.push({ id: 'b' });
    queue.close();
    await pool.wait();

    expect(completed.sort()).toEqual(['a', 'b']);
    expect(events).toContain('worker-started');
    expect(events).toContain('task-started');
    expect(events).toContain('task-completed');
    expect(events).toContain('worker-stopped');
  });

  test('file-to-file compare copies missing, size-mismatched, or mtime-changed files', () => {
    const source = { size: 12, mtimeMs: 1_000_000, isFile: () => true };
    const matchingTarget = { size: 12, mtimeMs: 1_001_000, isFile: () => true };
    const sizeMismatch = { size: 4, mtimeMs: 1_000_000, isFile: () => true };
    const olderTarget = { size: 12, mtimeMs: 10_000, isFile: () => true };
    const newerTarget = { size: 12, mtimeMs: 2_000_000, isFile: () => true };
    const directoryTarget = { size: 12, mtimeMs: 1_000_000, isFile: () => false };

    expect(shouldCopySourceFile(source, null, 2000)).toBe(true);
    expect(shouldCopySourceFile(source, matchingTarget, 2000)).toBe(false);
    expect(shouldCopySourceFile(source, sizeMismatch, 2000)).toBe(true);
    expect(shouldCopySourceFile(source, olderTarget, 2000)).toBe(true);
    expect(shouldCopySourceFile(source, newerTarget, 2000)).toBe(true);
    expect(shouldCopySourceFile(source, directoryTarget, 2000)).toBe(true);
  });

  test('full scanner enqueues file symlinks and regular files', async () => {
    const sourcePath = path.join(tempRootPath, 'symlink-source');
    const realFile = path.join(sourcePath, 'real.txt');
    await fs.ensureDir(path.join(sourcePath, 'docs'));
    await fs.writeFile(realFile, 'linked');
    await fs.writeFile(path.join(sourcePath, 'docs', 'nested.txt'), 'nested');
    await fs.symlink(realFile, path.join(sourcePath, 'alias.txt'));
    await fs.symlink(path.join(sourcePath, 'docs'), path.join(sourcePath, 'docs-link'));
    await fs.symlink(path.join(sourcePath, 'missing.txt'), path.join(sourcePath, 'broken.txt'));

    const enqueued = [];
    const summary = await scanFullSource({
      sourcePath,
      enqueueFile: async (file) => enqueued.push(file.sourceRelativePath)
    });

    expect(summary.filesEnqueued).toBe(5);
    expect(enqueued.sort()).toEqual([
      'alias.txt',
      'broken.txt',
      'docs-link',
      'docs/nested.txt',
      'real.txt'
    ]);
  });

  test('resume walker falls back to a full tree walk when the cursor folder is gone', async () => {
    const sourcePath = path.join(tempRootPath, 'missing-cursor-source');
    await fs.ensureDir(path.join(sourcePath, 'docs'));
    await fs.writeFile(path.join(sourcePath, 'docs', 'a.txt'), 'a');

    const folders = [];
    for await (const folder of walkFoldersFromCursor(sourcePath, {
      relativePath: 'deleted',
      folderHash: createFolderHash('deleted')
    })) {
      folders.push(folder.relativePath);
    }

    expect(folders).toEqual(['.', 'docs']);
  });
});
