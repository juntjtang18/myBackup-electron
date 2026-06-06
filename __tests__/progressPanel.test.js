const {
  createProgressViewModel,
  normalizeProgress,
  renderBackupProgressPanel,
  shouldRenderImmediatelyForProgress
} = require('../src/progressPanel');

describe('progress panel renderer', () => {
  test('renders hash and copy workers into explicit separate panels', () => {
    const entry = {
      progress: {
        status: 'running',
        filesProcessed: 3,
        filesCopied: 1,
        workers: {
          'hash:h1': {
            workerId: 'h1',
            pool: 'hash',
            state: 'hashing',
            sourceRelativePath: 'hash-only.txt',
            copiedBytes: 10,
            totalBytes: 100
          },
          'copy:c1': {
            workerId: 'c1',
            pool: 'copy',
            state: 'copying',
            sourceRelativePath: 'copy-only.txt',
            logicalPath: 'target/copy-only.txt',
            copiedBytes: 20,
            totalBytes: 200
          }
        },
        queues: {
          hash: {
            depth: 1,
            pending: 1,
            active: 1,
            waitingItems: [{ sourceRelativePath: 'hash-waiting.txt', totalBytes: 10 }],
            activeItems: [{ sourceRelativePath: 'hash-active.txt', totalBytes: 20 }],
            feedItems: [{ sourceRelativePath: 'hash-feed.txt', totalBytes: 30 }],
            handoffItems: [{ sourceRelativePath: 'should-not-render-in-hash.txt', totalBytes: 40 }]
          },
          copy: {
            depth: 1,
            pending: 1,
            active: 1,
            waitingItems: [{ sourceRelativePath: 'copy-waiting.txt', totalBytes: 50 }],
            activeItems: [{ sourceRelativePath: 'copy-active.txt', totalBytes: 60 }],
            handoffItems: [{ sourceRelativePath: 'copy-handoff.txt', totalBytes: 70 }],
            feedItems: [{ sourceRelativePath: 'should-not-render-in-copy.txt', totalBytes: 80 }]
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

    const hashPanelStart = html.indexOf('data-progress-pool="hash"');
    const copyPanelStart = html.indexOf('data-progress-pool="copy"');
    expect(hashPanelStart).toBeGreaterThan(-1);
    expect(copyPanelStart).toBeGreaterThan(hashPanelStart);

    const hashPanelHtml = html.slice(hashPanelStart, copyPanelStart);
    const copyPanelHtml = html.slice(copyPanelStart);
    expect(hashPanelHtml).toContain('hash-only.txt');
    expect(hashPanelHtml).toContain('hash-feed.txt');
    expect(hashPanelHtml).not.toContain('copy-only.txt');
    expect(hashPanelHtml).not.toContain('copy-handoff.txt');
    expect(hashPanelHtml).not.toContain('should-not-render-in-hash.txt');

    expect(copyPanelHtml).toContain('copy-only.txt');
    expect(copyPanelHtml).toContain('copy-handoff.txt');
    expect(copyPanelHtml).not.toContain('hash-only.txt');
    expect(copyPanelHtml).not.toContain('hash-feed.txt');
    expect(copyPanelHtml).not.toContain('should-not-render-in-copy.txt');
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

  test('does not render hash worker target logicalPath in the hash panel', () => {
    const entry = {
      progress: {
        workers: {
          'hash:h1': {
            workerId: 'h1',
            pool: 'hash',
            state: 'idle',
            sourceRelativePath: null,
            logicalPath: 'documents/target-looking-copy-path.txt',
            lastAction: 'copied',
            copiedBytes: 128,
            totalBytes: 128
          },
          'copy:c1': {
            workerId: 'c1',
            pool: 'copy',
            state: 'idle',
            sourceRelativePath: null,
            logicalPath: 'documents/copy-panel-path.txt',
            copiedBytes: 256,
            totalBytes: 256
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
    const hashPanelStart = html.indexOf('data-progress-pool="hash"');
    const copyPanelStart = html.indexOf('data-progress-pool="copy"');
    const hashPanelHtml = html.slice(hashPanelStart, copyPanelStart);
    const copyPanelHtml = html.slice(copyPanelStart);

    expect(hashPanelHtml).not.toContain('documents/target-looking-copy-path.txt');
    expect(hashPanelHtml).not.toContain('copied');
    expect(hashPanelHtml).toContain('idle');
    expect(copyPanelHtml).toContain('documents/copy-panel-path.txt');
  });

  test('pause state with indexed hash workers does not move copy workers into hash panel', () => {
    const entry = {
      progress: {
        status: 'paused',
        filesProcessed: 34,
        filesCopied: 0,
        filesIndexed: 34,
        workers: {
          'hash:h1': {
            workerId: 'h1',
            pool: 'hash',
            state: 'idle',
            sourceRelativePath: null,
            logicalPath: null,
            lastAction: 'indexed-existing',
            copiedBytes: 5403,
            totalBytes: 5403
          },
          'hash:h2': {
            workerId: 'h2',
            pool: 'hash',
            state: 'idle',
            sourceRelativePath: null,
            logicalPath: null,
            lastAction: 'indexed-existing',
            copiedBytes: 11667,
            totalBytes: 11667
          },
          'copy:c1': {
            workerId: 'c1',
            pool: 'copy',
            state: 'idle',
            sourceRelativePath: null,
            logicalPath: null,
            lastAction: null,
            copiedBytes: 0,
            totalBytes: 0
          }
        },
        queues: {
          hash: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [], feedItems: [] },
          copy: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [], handoffItems: [] }
        }
      }
    };

    const html = renderBackupProgressPanel({
      targetRoot: '/backup-target',
      source: { machineId: 'machine-a', sourceId: 'source-a' },
      entry,
      progressKey: '/backup-target::machine-a::source-a'
    });
    const hashPanelStart = html.indexOf('data-progress-pool="hash"');
    const copyPanelStart = html.indexOf('data-progress-pool="copy"');
    const hashPanelHtml = html.slice(hashPanelStart, copyPanelStart);
    const copyPanelHtml = html.slice(copyPanelStart);

    expect(hashPanelHtml).toContain('indexed existing');
    expect(hashPanelHtml).toContain('indexed 5.3 KB / 5.3 KB');
    expect(hashPanelHtml).not.toContain('C1');
    expect(hashPanelHtml).not.toContain('Copy Workers');
    expect(hashPanelHtml).not.toContain('Copy Queue');
    expect(copyPanelHtml).toContain('C1');
    expect(copyPanelHtml).toContain('No copy backlog right now.');
    expect(copyPanelHtml).not.toContain('indexed existing');
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
