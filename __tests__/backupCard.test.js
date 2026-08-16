const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const {
  BACKUP_CARD_JSON,
  BACKUP_CARD_MD,
  HISTORY_CAP,
  isBackupCardRelativePath,
  loadBackupCard,
  renderBackupMarkdown,
  writeBackupCard
} = require('../src/core/backupCard');

describe('backup card', () => {
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mybackup-card-'));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.remove(tempRoot);
    }
  });

  test('recognizes only card files at the backup-set root', () => {
    expect(isBackupCardRelativePath('BACKUP.md')).toBe(true);
    expect(isBackupCardRelativePath('.mybackup-info.json')).toBe(true);
    expect(isBackupCardRelativePath('docs/BACKUP.md')).toBe(false);
    expect(isBackupCardRelativePath('notes.md')).toBe(false);
  });

  test('writes markdown and json, then appends history', async () => {
    const backupSetRoot = path.join(tempRoot, 'gpa');
    const identity = {
      from: '/Users/ziyu/gpa',
      hostname: 'Juns-Mac-mini',
      machineId: 'juns-mac-mini-abcd',
      folderName: 'gpa',
      includeSourceRoot: true
    };

    const first = await writeBackupCard({
      backupSetRoot,
      identity,
      scanResult: {
        kind: 'full',
        sourceFileCount: 330,
        sourceSizeBytes: 1100,
        ignoredFileCount: 40,
        failedFileCount: 1,
        failed: [{ path: 'docs/bad.txt', error: 'EIO' }]
      },
      now: new Date('2026-08-01T18:03:00Z')
    });

    const second = await writeBackupCard({
      backupSetRoot,
      identity,
      scanResult: {
        kind: 'changes',
        filesCopied: 12,
        targetFileCount: 12,
        targetSizeBytes: 8 * 1024 * 1024,
        errors: 0
      },
      now: new Date('2026-08-10T09:12:00Z')
    });

    expect(first.history).toHaveLength(1);
    expect(second.history).toHaveLength(2);
    expect(second.history[0]).toMatchObject({
      kind: 'changes',
      backedUpFileCount: 12,
      failedFileCount: 0
    });
    expect(second.history[1]).toMatchObject({
      kind: 'full',
      backedUpFileCount: 330,
      ignoredFileCount: 40,
      failedFileCount: 1
    });
    expect(second.lastFailures).toEqual([]);

    const loaded = await loadBackupCard(backupSetRoot);
    expect(loaded.from).toBe('/Users/ziyu/gpa');
    expect(loaded.history).toHaveLength(2);

    const markdown = await fs.readFile(path.join(backupSetRoot, BACKUP_CARD_MD), 'utf8');
    expect(markdown).toContain('# Backup: gpa');
    expect(markdown).toContain('From: `/Users/ziyu/gpa`');
    expect(markdown).toContain('2026-08-10 09:12 · Backup Changes · 12 files copied · 0 failed');
    expect(markdown).toContain('| 2026-08-01 18:03 | Full | 330 |');
    expect(markdown).toContain('| 2026-08-10 09:12 | Changes | 12 |');
    expect(markdown).not.toContain('## Last failures');
    expect(await fs.pathExists(path.join(backupSetRoot, BACKUP_CARD_JSON))).toBe(true);
  });

  test('keeps failed paths for the last run only and caps history', async () => {
    const backupSetRoot = path.join(tempRoot, 'photos');
    const identity = {
      from: '/Users/ziyu/photos',
      hostname: 'host',
      machineId: 'machine-a',
      folderName: 'photos',
      includeSourceRoot: true
    };

    for (let index = 0; index < HISTORY_CAP + 3; index += 1) {
      await writeBackupCard({
        backupSetRoot,
        identity,
        scanResult: {
          kind: 'full',
          sourceFileCount: index,
          sourceSizeBytes: index,
          ignoredFileCount: 0,
          failedFileCount: 1,
          failed: [{ path: `old-${index}.txt`, error: 'EIO' }]
        },
        now: new Date(Date.UTC(2026, 0, 1, 0, index))
      });
    }

    const card = await writeBackupCard({
      backupSetRoot,
      identity,
      scanResult: {
        kind: 'full',
        sourceFileCount: 9,
        sourceSizeBytes: 99,
        ignoredFileCount: 2,
        failedFileCount: 1,
        failed: [{ path: 'docs/bad.txt', error: 'EIO' }]
      },
      now: new Date('2026-08-16T13:54:00Z')
    });

    expect(card.history).toHaveLength(HISTORY_CAP);
    expect(card.history[0].when).toBe('2026-08-16T13:54:00.000Z');
    expect(card.lastFailures).toEqual([{ path: 'docs/bad.txt', error: 'EIO' }]);
    expect(card.history.some((row) => row.when === '2026-01-01T00:00:00.000Z')).toBe(false);

    const markdown = renderBackupMarkdown(card);
    expect(markdown).toContain('## Last failures');
    expect(markdown).toContain('`docs/bad.txt` — EIO');
    expect(markdown).not.toContain('old-0.txt');
  });
});
