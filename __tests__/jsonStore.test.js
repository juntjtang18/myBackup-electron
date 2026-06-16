const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { writeJsonAtomic, readJson } = require('../src/core/jsonStore');

describe('jsonStore.writeJsonAtomic', () => {
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mybackup-jsonstore-'));
  });

  afterEach(async () => {
    await fs.remove(tempRoot);
    jest.restoreAllMocks();
  });

  test('prunes stale atomic temp siblings while preserving the target file', async () => {
    const filePath = path.join(tempRoot, 'backup_target.json');
    const staleTempPath = path.join(tempRoot, 'backup_target.json.12345.deadbeef.tmp');

    await fs.writeJson(staleTempPath, { stale: true });
    const staleAt = new Date(Date.now() - (10 * 60 * 1000));
    await fs.utimes(staleTempPath, staleAt, staleAt);

    await writeJsonAtomic(filePath, { ok: true });

    expect(await fs.pathExists(staleTempPath)).toBe(false);
    await expect(readJson(filePath)).resolves.toEqual({ ok: true });
  });

  test('removes its temp file when final move fails', async () => {
    const filePath = path.join(tempRoot, 'backup_target.json');
    const moveSpy = jest.spyOn(fs, 'move').mockRejectedValueOnce(new Error('move failed'));

    await expect(writeJsonAtomic(filePath, { ok: true })).rejects.toThrow('move failed');

    const siblings = await fs.readdir(tempRoot);
    expect(siblings.filter((entry) => entry.startsWith('backup_target.json.'))).toEqual([]);
    moveSpy.mockRestore();
  });
});
