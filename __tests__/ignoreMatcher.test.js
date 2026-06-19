const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const {
  ensureSourceIgnoreFile,
  loadIgnoreMatcher,
  readSourceIgnoreFile
} = require('../src/core/ignoreMatcher');

describe('ignore matcher', () => {
  let tempRoot = null;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mybackup-ignore-'));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.remove(tempRoot);
    }
  });

  test('creates per-source .mbignore in app data ignore-rules', async () => {
    const appDataRoot = path.join(tempRoot, 'Library', 'Application Support', 'myBackup', 'data');
    const source = {
      machineId: 'machine-a',
      sourceId: 'source-a'
    };

    const created = await ensureSourceIgnoreFile(appDataRoot, source);
    expect(created).toContain(path.join('ignore-rules', 'machine-a--source-a.mbignore'));
    expect(await fs.pathExists(created)).toBe(true);
  });

  test('source-specific ignore file is applied', async () => {
    const appDataRoot = path.join(tempRoot, 'Library', 'Application Support', 'myBackup', 'data');
    const sourceRoot = path.join(tempRoot, 'source');
    const source = {
      machineId: 'machine-a',
      sourceId: 'source-a'
    };
    await fs.ensureDir(sourceRoot);
    const document = await readSourceIgnoreFile(appDataRoot, source);
    await fs.writeFile(document.ignorePath, 'source-only.txt\n', 'utf8');

    const matcher = await loadIgnoreMatcher(sourceRoot, { appDataRoot, source });
    expect(matcher.shouldIgnore('source-only.txt', false)).toBe(true);
  });

  test('node_modules is not ignored by default without user rules', async () => {
    const sourceRoot = path.join(tempRoot, 'source');
    await fs.ensureDir(sourceRoot);

    const matcher = await loadIgnoreMatcher(sourceRoot);
    expect(matcher.shouldIgnore('node_modules', true)).toBe(false);
    expect(matcher.shouldIgnore('node_modules/package.json', false)).toBe(false);
    expect(matcher.shouldIgnore('.DS_Store', false)).toBe(true);
  });
});
