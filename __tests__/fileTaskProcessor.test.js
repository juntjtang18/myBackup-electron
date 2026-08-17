const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const {
  isTransientSourceFileError,
  processFileTask
} = require('../src/core/fileTaskProcessor');

describe('processFileTask live source files', () => {
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mybackup-filetask-'));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.remove(tempRoot);
    }
  });

  function sourceRecord() {
    return {
      sourceId: 'source-a',
      sourcePath: path.join(tempRoot, 'source'),
      targetFolder: '',
      includeSourceRoot: true,
      folderName: 'source',
      relativeRoot: 'source'
    };
  }

  test('isTransientSourceFileError covers vanish and rewrite codes', () => {
    expect(isTransientSourceFileError({ code: 'ENOENT' })).toBe(true);
    expect(isTransientSourceFileError({ code: 'ENOTDIR' })).toBe(true);
    expect(isTransientSourceFileError({ code: 'SOURCE_CHANGED' })).toBe(true);
    expect(isTransientSourceFileError({ code: 'EACCES' })).toBe(false);
    expect(isTransientSourceFileError(new Error('boom'))).toBe(false);
  });

  test('skips a file that disappears before copy without throwing', async () => {
    const targetRoot = path.join(tempRoot, 'target');
    await fs.ensureDir(targetRoot);

    const result = await processFileTask({
      targetRoot,
      machineId: 'machine-a',
      source: sourceRecord(),
      sourceFilePath: path.join(tempRoot, 'source', 'status.json'),
      sourceRelativePath: 'status.json',
      stats: { size: 12 }
    });

    expect(result).toEqual(expect.objectContaining({
      action: 'skipped-missing',
      sourceRelativePath: 'status.json',
      bytesProcessed: 0
    }));
  });

  test('returns failed for permission errors without throwing', async () => {
    const sourceDir = path.join(tempRoot, 'source');
    const targetRoot = path.join(tempRoot, 'target');
    const sourceFilePath = path.join(sourceDir, 'locked.txt');
    await fs.ensureDir(sourceDir);
    await fs.ensureDir(targetRoot);
    await fs.writeFile(sourceFilePath, 'secret');

    const originalLstat = fs.lstat.bind(fs);
    const spy = jest.spyOn(fs, 'lstat');
    spy.mockImplementation(async (candidate) => {
      if (String(candidate) === sourceFilePath) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalLstat(candidate);
    });

    await expect(processFileTask({
      targetRoot,
      machineId: 'machine-a',
      source: sourceRecord(),
      sourceFilePath,
      sourceRelativePath: 'locked.txt',
      stats: { size: 6 }
    })).resolves.toEqual(expect.objectContaining({
      action: 'failed',
      sourceRelativePath: 'locked.txt',
      errorCode: 'EACCES'
    }));
    spy.mockRestore();
  });

  test('copies a stable file', async () => {
    const sourceDir = path.join(tempRoot, 'source');
    const targetRoot = path.join(tempRoot, 'target');
    const sourceFilePath = path.join(sourceDir, 'notes.txt');
    await fs.ensureDir(sourceDir);
    await fs.ensureDir(targetRoot);
    await fs.writeFile(sourceFilePath, 'hello backup');
    const stats = await fs.lstat(sourceFilePath);

    const result = await processFileTask({
      targetRoot,
      machineId: 'machine-a',
      source: sourceRecord(),
      sourceFilePath,
      sourceRelativePath: 'notes.txt',
      stats
    });

    expect(result.action).toBe('copied');
    expect(await fs.readFile(path.join(targetRoot, 'source', 'notes.txt'), 'utf8')).toBe('hello backup');
  });
});
