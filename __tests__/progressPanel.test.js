const {
  createProgressViewModel,
  normalizeProgress,
  renderBackupProgressPanel,
  shouldRenderImmediatelyForProgress
} = require('../src/progressPanel');

describe('progress panel renderer', () => {
  test('renders only active file workers and no queue sections by default', () => {
    const entry = {
      progress: {
        status: 'running',
        filesProcessed: 3,
        filesCopied: 1,
        workers: {
          'file:w1': {
            workerId: 'w1',
            pool: 'file',
            state: 'processing',
            sourceRelativePath: 'docs/a.txt',
            copiedBytes: 10,
            totalBytes: 100
          },
          'file:w2': {
            workerId: 'w2',
            pool: 'file',
            state: 'processing',
            sourceRelativePath: 'docs/b.txt',
            logicalPath: 'target/docs/b.txt',
            copiedBytes: 20,
            totalBytes: 200
          }
        },
        queues: {
          file: {
            depth: 1,
            pending: 1,
            active: 1,
            waitingItems: [{ sourceRelativePath: 'should-not-render.txt', totalBytes: 30 }],
            activeItems: [{ sourceRelativePath: 'should-not-render-2.txt', totalBytes: 40 }]
          }
        }
      }
    };
    const html = renderBackupProgressPanel({
      targetRoot: '/backup-target',
      source: { machineId: 'machine-a', sourceId: 'source-a' },
      entry,
      progressKey: '/backup-target::machine-a::source-a'
    });

    const filePanelStart = html.indexOf('data-progress-pool="file"');
    expect(filePanelStart).toBeGreaterThan(-1);
    expect(html).not.toContain('data-progress-pool="hash"');
    expect(html).not.toContain('data-progress-pool="copy"');

    const filePanelHtml = html.slice(filePanelStart);
    expect(filePanelHtml).toContain('docs/a.txt');
    expect(filePanelHtml).toContain('docs/b.txt');
    expect(filePanelHtml).not.toContain('should-not-render.txt');
    expect(filePanelHtml).not.toContain('queue-block');
  });

  test('renders queue sections when enabled by runtime flag', () => {
    const entry = {
      progress: {
        status: 'running',
        workers: {
          'file:w1': {
            workerId: 'w1',
            pool: 'file',
            state: 'processing',
            sourceRelativePath: 'docs/a.txt',
            copiedBytes: 10,
            totalBytes: 100
          }
        },
        queues: {
          file: {
            depth: 2,
            pending: 3,
            active: 1,
            waitingItems: [{ sourceRelativePath: 'queued.txt', totalBytes: 30 }],
            activeItems: [{ sourceRelativePath: 'active.txt', totalBytes: 40 }]
          }
        }
      }
    };

    const html = renderBackupProgressPanel({
      targetRoot: '/backup-target',
      source: { machineId: 'machine-a', sourceId: 'source-a' },
      entry,
      progressKey: '/backup-target::machine-a::source-a',
      showProgressQueueDetails: true
    });

    expect(html).toContain('queue-block');
    expect(html).toContain('Queue');
    expect(html).toContain('queued.txt');
    expect(html).toContain('active.txt');
  });

  test('normalizes missing or invalid pool data without sharing queues', () => {
    const normalized = normalizeProgress({
      progress: {
        workers: {
          invalid: { workerId: 'x1', state: 'copying', sourceRelativePath: 'invalid.txt' }
        },
        queues: {
          hash: { handoffItems: [{ sourceRelativePath: 'bad-handoff.txt' }] },
          copy: { feedItems: [{ sourceRelativePath: 'bad-feed.txt' }] }
        }
      }
    });

    expect(normalized.hashProgress.workers).toEqual([]);
    expect(normalized.copyProgress.workers).toEqual([]);
    expect(normalized.hashProgress.queue.handoffItems).toEqual([]);
    expect(normalized.copyProgress.queue.feedItems).toEqual([]);
  });

  test('does not render any copy worker content in the hash-only panel', () => {
    const entry = {
      progress: {
        workers: {
          'file:w1': {
            workerId: 'w1',
            pool: 'file',
            state: 'idle',
            sourceRelativePath: null,
            logicalPath: null,
            lastAction: 'copied',
            copiedBytes: 128,
            totalBytes: 128
          }
        },
        queues: {}
      }
    };

    const html = renderBackupProgressPanel({
      targetRoot: '/backup-target',
      source: { machineId: 'machine-a', sourceId: 'source-a' },
      entry,
      progressKey: '/backup-target::machine-a::source-a'
    });
    const hashPanelStart = html.indexOf('data-progress-pool="file"');
    const hashPanelHtml = html.slice(hashPanelStart);

    expect(hashPanelHtml).not.toContain('documents/target-looking-copy-path.txt');
    expect(hashPanelHtml).toContain('idle');
    expect(html).not.toContain('data-progress-pool="copy"');
  });

  test('pause state keeps the single panel file-only', () => {
    const entry = {
      progress: {
        status: 'paused',
        filesProcessed: 34,
        filesCopied: 0,
        filesIndexed: 34,
        workers: {
          'file:w1': {
            workerId: 'w1',
            pool: 'file',
            state: 'idle',
            sourceRelativePath: null,
            logicalPath: null,
            lastAction: null,
            copiedBytes: 0,
            totalBytes: 0
          }
        },
        queues: {
          file: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [] }
        }
      }
    };

    const html = renderBackupProgressPanel({
      targetRoot: '/backup-target',
      source: { machineId: 'machine-a', sourceId: 'source-a' },
      entry,
      progressKey: '/backup-target::machine-a::source-a'
    });
    const hashPanelStart = html.indexOf('data-progress-pool="file"');
    const hashPanelHtml = html.slice(hashPanelStart);

    expect(hashPanelHtml).toContain('idle');
    expect(hashPanelHtml).not.toContain('Copy Workers');
    expect(hashPanelHtml).not.toContain('Copy Queue');
    expect(html).not.toContain('data-progress-pool="copy"');
  });

  test('completed last run shows source and target inventory instead of workers', () => {
    const html = renderBackupProgressPanel({
      targetRoot: '/backup-target',
      source: { machineId: 'machine-a', sourceId: 'source-a' },
      entry: {
        progress: { status: 'completed', filesProcessed: 3, filesCopied: 3, copiedBytes: 12, workers: {} },
        summary: {
          status: 'completed',
          scanResult: {
            kind: 'changes',
            sourceFileCount: 3,
            sourceSizeBytes: 12,
            targetFileCount: 2,
            targetSizeBytes: 8
          }
        }
      },
      progressKey: '/backup-target::machine-a::source-a'
    });

    expect(html).toContain('progress-last-run');
    expect(html).toContain('Backup Changes');
    expect(html).toContain('data-scan-side="source"');
    expect(html).toContain('3 files');
    expect(html).toContain('12 B');
    expect(html).toContain('data-scan-side="target"');
    expect(html).toContain('2 files');
    expect(html).toContain('8 B');
    expect(html).not.toContain('data-progress-pool="file"');
  });

  test('AT-SCAN02 last-run report shows Source backed up, Failed, Ignored, and Total', () => {
    const html = renderBackupProgressPanel({
      targetRoot: '/backup-target',
      source: { machineId: 'machine-a', sourceId: 'source-a' },
      entry: {
        progress: { status: 'completed', filesProcessed: 3, filesCopied: 2, copiedBytes: 9, workers: {} },
        summary: {
          status: 'completed',
          scanResult: {
            kind: 'full',
            sourceFileCount: 2,
            sourceSizeBytes: 9,
            targetFileCount: 2,
            targetSizeBytes: 9,
            failedFileCount: 1,
            failedSizeBytes: 4,
            failed: [{ path: 'docs/bad.txt', error: 'EIO', sourceBytes: 4 }],
            ignoredFileCount: 1,
            ignoredSizeBytes: 8,
            totalFileCount: 4,
            totalSizeBytes: 21
          }
        }
      },
      progressKey: '/backup-target::machine-a::source-a'
    });

    expect(html).toContain('Source backed up');
    expect(html).toContain('Failed');
    expect(html).toContain('docs/bad.txt');
    expect(html).toContain('Ignored');
    expect(html).toContain('Total');
    expect(html).toContain('4 files · 21 B');
  });

  test('completed restore shows last-run report instead of workers', () => {
    const html = renderBackupProgressPanel({
      targetRoot: '/backup-target',
      source: { machineId: 'machine-a', sourceId: 'source-a' },
      entry: {
        progress: {
          mode: 'restore',
          status: 'completed',
          destinationRoot: '/tmp/newsource',
          filesProcessed: 4,
          filesCopied: 4,
          copiedBytes: 20,
          workers: {}
        },
        summary: {
          status: 'completed',
          restoredFiles: 4,
          copiedBytes: 20,
          destinationRoot: '/tmp/newsource'
        },
        event: { type: 'restore-completed' }
      },
      progressKey: '/backup-target::machine-a::source-a'
    });

    expect(html).toContain('progress-last-run');
    expect(html).toContain('data-scan-kind="restore"');
    expect(html).toContain('Restored');
    expect(html).toContain('4 files');
    expect(html).toContain('/tmp/newsource');
    expect(html).not.toContain('data-progress-pool="file"');
  });

  test('forces immediate rendering for short-lived copy events', () => {
    expect(shouldRenderImmediatelyForProgress({ event: { type: 'copy-progress' } })).toBe(true);
    expect(shouldRenderImmediatelyForProgress({ event: { type: 'task-started', pool: 'copy' } })).toBe(true);
    expect(shouldRenderImmediatelyForProgress({ event: { type: 'task-completed', pool: 'copy' } })).toBe(true);
    expect(shouldRenderImmediatelyForProgress({ event: { type: 'task-started', pool: 'hash' } })).toBe(false);
  });

  test('view model is stateless and orders fixed backend worker ids directly', () => {
    const view = createProgressViewModel({
      progress: {
        workers: {
          'hash:H2': { workerId: 'H2', pool: 'hash', state: 'idle' },
          'hash:H1': { workerId: 'H1', pool: 'hash', state: 'idle' },
          'copy:C2': { workerId: 'C2', pool: 'copy', state: 'idle' },
          'copy:C1': { workerId: 'C1', pool: 'copy', state: 'idle' }
        },
        queues: {}
      }
    });

    expect(view.pools.hash.workers.map((worker) => worker.workerId)).toEqual(['H1', 'H2']);
    expect(view.pools.copy.workers.map((worker) => worker.workerId)).toEqual(['C1', 'C2']);
  });
});
