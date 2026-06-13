const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { createIgnoreMatcher, buildIgnoreRules } = require('../src/core/ignoreMatcher');
const { scanFullSource } = require('../src/core/engine/fullScanner');
const { scanDirtyFolders } = require('../src/core/engine/dirtyFolderScanner');
const { createFileQueue } = require('../src/core/engine/fileQueue');
const { createFileWorkerPool } = require('../src/core/engine/fileWorkerPool');

describe('engine runtime modules', () => {
  let tempRootPath;

  beforeEach(() => {
    tempRootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mybackup-engine-'));
  });

  afterEach(() => {
    fs.removeSync(tempRootPath);
  });

  test('full scanner traverses the whole source tree and skips ignored paths', async () => {
    const sourcePath = path.join(tempRootPath, 'source');
    await fs.ensureDir(path.join(sourcePath, 'docs', 'nested'));
    await fs.ensureDir(path.join(sourcePath, 'node_modules', 'pkg'));
    await fs.writeFile(path.join(sourcePath, 'root.txt'), 'root');
    await fs.writeFile(path.join(sourcePath, 'docs', 'a.txt'), 'a');
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
      foldersScanned: 3,
      filesEnqueued: 3,
      skippedFolders: 0,
      skippedFiles: 0
    });
    expect(folders).toEqual(['.', 'docs', 'docs/nested']);
    expect(enqueued).toEqual(['root.txt', 'docs/a.txt', 'docs/nested/b.txt']);
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
});
