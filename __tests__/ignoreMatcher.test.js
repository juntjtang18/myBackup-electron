const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const {
  SOURCE_IGNORE_TEMPLATE,
  ensureSourceIgnoreFile,
  loadIgnoreMatcher,
  readSourceIgnoreFile
} = require('../src/core/ignoreMatcher');
const { createStagingTempPath } = require('../src/core/plainFileStorage');

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
    expect(await fs.readFile(created, 'utf8')).toBe(SOURCE_IGNORE_TEMPLATE);
    expect(await fs.readFile(created, 'utf8')).toContain('.mybackup/');
  });

  test('existing ignore files get .mybackup/ without Reset', async () => {
    const appDataRoot = path.join(tempRoot, 'Library', 'Application Support', 'myBackup', 'data');
    const source = {
      machineId: 'machine-a',
      sourceId: 'source-a'
    };
    const created = await ensureSourceIgnoreFile(appDataRoot, source);
    const legacyTemplate = [
      '# Temporary files',
      '*.tmp',
      '*.temp',
      '~$*',
      '',
      '# System files',
      '.DS_Store',
      '._*',
      'Thumbs.db',
      'Desktop.ini',
      '',
      '# OS metadata',
      '.Spotlight-V100/',
      '.Trashes/',
      '.fseventsd/',
      '',
      '# VCS metadata',
      '.git/',
      ''
    ].join('\n');
    await fs.writeFile(created, legacyTemplate, 'utf8');

    const document = await readSourceIgnoreFile(appDataRoot, source);
    expect(document.rulesText).toContain('.mybackup/');
    expect(document.rulesText).toContain('# MyBackup metadata');
    expect(document.rulesText).toContain(legacyTemplate.trim());
    expect(await fs.readFile(created, 'utf8')).toContain('.mybackup/');
  });

  test('does not duplicate .mybackup/ when the ignore file already has it', async () => {
    const appDataRoot = path.join(tempRoot, 'Library', 'Application Support', 'myBackup', 'data');
    const source = {
      machineId: 'machine-a',
      sourceId: 'source-a'
    };
    const created = await ensureSourceIgnoreFile(appDataRoot, source);
    await fs.writeFile(created, 'node_modules/\n.mybackup/\n', 'utf8');

    const document = await readSourceIgnoreFile(appDataRoot, source);
    expect(document.rulesText).toBe('node_modules/\n.mybackup/\n');
    expect(document.rulesText.match(/\.mybackup\//g)).toHaveLength(1);
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
    expect(matcher.shouldIgnore('.mybackup', true)).toBe(true);
    expect(matcher.shouldIgnore('.mybackup/tmp/stage.asar', false)).toBe(true);
    expect(matcher.shouldIgnore('photos/.mybackup', true)).toBe(true);
  });

  test('staging copies never use a .asar temp name', () => {
    const staged = createStagingTempPath(tempRoot, '96b501362ccc-stage', 'app.asar');
    expect(staged.endsWith('.tmp')).toBe(true);
    expect(staged.endsWith('.asar')).toBe(false);
  });
});
