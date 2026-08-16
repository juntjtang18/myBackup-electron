describe('renderer target offline behavior', () => {
  let targetsContainer = null;

  function loadRendererTestApi() {
    jest.resetModules();
    targetsContainer = {
      innerHTML: '',
      querySelectorAll: () => []
    };
    global.window = {
      requestAnimationFrame: (callback) => callback(),
      setTimeout: jest.fn(() => 1),
      clearTimeout: jest.fn(),
      myBackupProgressPanel: null,
      myBackup: {
        getDashboard: jest.fn(async () => ({ targets: [] })),
        getChangeList: jest.fn(async () => ({ generatedAt: '2026-06-17T00:00:00.000Z', items: [] })),
        runBackup: jest.fn(async () => ({ dashboard: { targets: [] }, summary: { status: 'completed' } })),
        pauseBackup: jest.fn(async () => ({ accepted: true })),
        stopBackup: jest.fn(async () => ({ accepted: true, stoppedActive: true })),
        stopRestore: jest.fn(async () => ({ accepted: true, dashboard: { targets: [] } })),
        restoreSource: jest.fn(async () => ({ dashboard: { targets: [] }, summary: { status: 'completed' } })),
        setTargetCollapsed: jest.fn(() => Promise.resolve())
      }
    };
    global.document = {
      addEventListener: () => {},
      getElementById: (id) => (id === 'targetsContainer' ? targetsContainer : null),
      querySelector: () => null
    };
    const testApi = require('../src/renderer').__test__;
    global.window.myBackup.getDashboard.mockImplementation(async () => testApi.state.dashboard);
    return testApi;
  }

  function createSource(overrides = {}) {
    return {
      machineId: 'machine-a',
      sourceId: 'source-a',
      sourcePath: '/Users/James/Documents',
      targetSubdir: 'documents/Documents',
      targetFolder: 'documents',
      baselineAt: '2026-06-13T04:01:03.000Z',
      lastCompletedAt: '2026-06-13T04:01:03.000Z',
      watchState: {
        needsRescan: false
      },
      backupStatus: {
        status: null,
        copiedBytes: 0
      },
      sourceSizeBytes: 1024,
      backupSizeBytes: 1024,
      ...overrides
    };
  }

  function createTarget(overrides = {}) {
    return {
      id: 'target-a',
      path: '/Volumes/ST/Backup',
      available: true,
      unavailableReason: null,
      sources: [createSource()],
      ...overrides
    };
  }

  function flushAsyncWork() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  test('offline target still renders source cards and disables backup buttons', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget({
      available: false,
      unavailableReason: 'Backup volume is not mounted: /Volumes/ST'
    })];

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toMatch(/class="target-panel\s+[^"]*unavailable/);
    expect(targetsContainer.innerHTML).toContain('target-unavailable-banner');
    expect(targetsContainer.innerHTML).toContain('/Users/James/Documents');
    expect(targetsContainer.innerHTML).toContain('documents/Documents');
    expect(targetsContainer.innerHTML).toMatch(/run-backup-button/);
    expect(targetsContainer.innerHTML).toMatch(/run-backup-button"[^>]*data-target-root="\/Volumes\/ST\/Backup"[^>]*data-machine-id="machine-a"[^>]*data-source-id="source-a"[^>]*disabled/);
  });

  test('offline target keeps non-backup buttons visible', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget({
      available: false,
      unavailableReason: 'Backup volume is not mounted: /Volumes/ST'
    })];

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('toggle-changes-button');
    expect(targetsContainer.innerHTML).toContain('restore-source-button');
    expect(targetsContainer.innerHTML).toContain('add-source-button');
    expect(targetsContainer.innerHTML).toContain('remove-target-button');
  });

  test('online target behavior keeps backup buttons enabled', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget()];

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).not.toContain('target-unavailable-banner');
    expect(targetsContainer.innerHTML).toContain('/Users/James/Documents');
    expect(targetsContainer.innerHTML).toMatch(/run-backup-button/);
    expect(targetsContainer.innerHTML).not.toMatch(/run-backup-button"[^>]*data-target-root="\/Volumes\/ST\/Backup"[^>]*data-machine-id="machine-a"[^>]*data-source-id="source-a"[^>]*disabled/);
  });

  test('AT-UI03-1 idle source shows four peer icon buttons and no dropdown', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget()];
    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('toggle-changes-button');
    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).toContain('Backup Changes');
    expect(targetsContainer.innerHTML).toContain('run-full-scan-button');
    expect(targetsContainer.innerHTML).toContain('Full Backup');
    expect(targetsContainer.innerHTML).toContain('restore-source-button');
    expect(targetsContainer.innerHTML).not.toContain('backup-action-toggle');
    expect(targetsContainer.innerHTML).not.toContain('backup-action-dropdown');
    expect(targetsContainer.innerHTML).not.toContain('backup-action-menu');
  });

  test('AT-UI03-1 needs-rescan still shows Backup Changes disabled and Full Backup visible', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget({
      sources: [createSource({ baselineAt: null })]
    })];
    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).toMatch(/run-backup-button"[^>]*disabled/);
    expect(targetsContainer.innerHTML).toContain('run-full-scan-button');
    expect(targetsContainer.innerHTML).toContain('Full Backup');
    expect(targetsContainer.innerHTML).not.toContain('backup-action-dropdown');
  });

  test('AT-UI03-2 click Backup Changes, Full Backup, or Restore shows only Pause and Stop', () => {
    const testApi = loadRendererTestApi();
    const key = '/Volumes/ST/Backup::machine-a::source-a';
    testApi.state.dashboard.targets = [createTarget()];

    testApi.state.backupProgress[key] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: { status: 'running', mode: 'incremental', workers: {} },
      event: { type: 'backup-started' }
    };
    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).toContain('stop-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('run-full-scan-button');
    expect(targetsContainer.innerHTML).not.toContain('restore-source-button');
    expect(targetsContainer.innerHTML).not.toContain('toggle-changes-button');

    testApi.state.backupProgress[key] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: { status: 'running', mode: 'full', workers: {} },
      event: { type: 'backup-started' }
    };
    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).toContain('stop-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('run-full-scan-button');

    testApi.state.backupProgress[key] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: { status: 'running', mode: 'restore', workers: {} },
      event: { type: 'restore-started' }
    };
    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('pause-restore-button');
    expect(targetsContainer.innerHTML).toContain('stop-restore-button');
    expect(targetsContainer.innerHTML).not.toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('run-full-scan-button');
  });

  test('AT-UI03-3 run ended restores the idle four buttons', () => {
    const testApi = loadRendererTestApi();
    const key = '/Volumes/ST/Backup::machine-a::source-a';
    testApi.state.dashboard.targets = [createTarget()];
    testApi.state.backupProgress[key] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: { status: 'running', mode: 'incremental', workers: {} },
      event: { type: 'backup-started' }
    };
    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('pause-backup-button');

    testApi.handleBackupProgressPayload({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      summary: { status: 'completed', mode: 'incremental' },
      progress: { status: 'completed', mode: 'incremental', workers: {} },
      event: { type: 'backup-completed' }
    });
    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('toggle-changes-button');
    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).toContain('run-full-scan-button');
    expect(targetsContainer.innerHTML).toContain('restore-source-button');
    expect(targetsContainer.innerHTML).not.toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('stop-backup-button');
  });

  test('starting backup collapses the open source changes panel first', async () => {
    const testApi = loadRendererTestApi();
    const target = createTarget();
    const changeKey = `${target.id}::source-a`;
    testApi.state.dashboard.targets = [target];
    testApi.state.sourceChangeExpanded[changeKey] = true;
    testApi.state.sourceChanges[changeKey] = {
      data: {
        generatedAt: '2026-06-16T07:00:00.000Z',
        items: [
          {
            relativePath: 'docs',
            changedAt: '2026-06-16T07:00:00.000Z',
            eventCount: 2
          }
        ]
      }
    };

    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('source-changes-panel');

    await testApi.runBackup('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(testApi.state.sourceChangeExpanded[changeKey]).toBeUndefined();
    expect(global.window.myBackup.runBackup).toHaveBeenCalledWith({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      forceNewScan: false
    });
  });

  test('completed backup refreshes source changes cache for the source', async () => {
    const testApi = loadRendererTestApi();
    const target = createTarget();
    const changeKey = `${target.id}::source-a`;
    testApi.state.dashboard.targets = [target];
    testApi.state.sourceChanges[changeKey] = {
      loading: false,
      error: null,
      data: {
        generatedAt: '2026-06-16T07:00:00.000Z',
        items: [
          { relativePath: 'docs', changedAt: '2026-06-16T07:00:00.000Z', eventCount: 2 }
        ]
      }
    };
    global.window.myBackup.runBackup.mockResolvedValue({
      dashboard: { targets: [target] },
      summary: { status: 'completed' }
    });
    global.window.myBackup.getChangeList.mockResolvedValue({
      generatedAt: '2026-06-17T07:00:00.000Z',
      items: []
    });

    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('Changes (1)');

    await testApi.runBackup('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(global.window.myBackup.getChangeList).toHaveBeenCalledWith({
      targetId: target.id,
      sourceId: 'source-a'
    });
    expect(testApi.state.sourceChanges[changeKey]?.data?.items || []).toHaveLength(0);
    expect(targetsContainer.innerHTML).not.toContain('Changes (1)');
  });

  test('paused backup does not refresh source changes cache', async () => {
    const testApi = loadRendererTestApi();
    const target = createTarget();
    testApi.state.dashboard.targets = [target];
    global.window.myBackup.runBackup.mockResolvedValue({
      dashboard: { targets: [target] },
      summary: { status: 'paused' }
    });

    await testApi.runBackup('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(global.window.myBackup.getChangeList).not.toHaveBeenCalled();
  });

  test('full scan action forces a new full scan backup run', async () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget()];

    await testApi.runBackup('/Volumes/ST/Backup', 'machine-a', 'source-a', null, true);

    expect(global.window.myBackup.runBackup).toHaveBeenCalledWith({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      forceNewScan: true
    });
  });

  test('active backup renders the source card arrow in copying state', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget()];
    testApi.state.backupProgress['/Volumes/ST/Backup::machine-a::source-a'] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: {
        startedAt: '2026-06-16T07:00:00.000Z',
        status: 'running',
        filesProcessed: 1,
        filesCopied: 1,
        copiedBytes: 128,
        workers: {}
      },
      event: null
    };

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('source-card is-copying');
    expect(targetsContainer.innerHTML).toContain('source-card-arrow is-copying');
    expect(targetsContainer.innerHTML).toContain('source-progress-node is-live');
    expect(targetsContainer.innerHTML).toContain('source-progress-node-size">128 B');
    expect(targetsContainer.innerHTML).toContain('--arrow-phase:');
    expect(targetsContainer.innerHTML).toContain('source-card-arrow-dot-1');
    expect(targetsContainer.innerHTML).toContain('source-card-arrow-dot-2');
    expect(targetsContainer.innerHTML).toContain('source-card-arrow-dot-3');
  });

  test('active restore renders destination path, reverse arrow class, and remaining size in progress node', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget({
      sources: [createSource({
        backupSizeBytes: 1024
      })]
    })];
    testApi.state.backupProgress['/Volumes/ST/Backup::machine-a::source-a'] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: {
        mode: 'restore',
        destinationRoot: '/Users/James/RestoreOut',
        startedAt: '2026-06-16T07:00:00.000Z',
        status: 'running',
        filesProcessed: 1,
        filesCopied: 1,
        copiedBytes: 256,
        totalBytes: 1024,
        workers: {},
        queues: { file: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [] } }
      },
      event: { type: 'restore-started', pool: 'file' }
    };

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('source-card-arrow is-copying is-restore');
    expect(targetsContainer.innerHTML).toContain('Destination');
    expect(targetsContainer.innerHTML).toContain('/Users/James/RestoreOut');
    expect(targetsContainer.innerHTML).toContain('source-progress-node-size">768 B');
    expect(targetsContainer.innerHTML).toContain('pause-restore-button');
    expect(targetsContainer.innerHTML).toContain('stop-restore-button');
    expect(targetsContainer.innerHTML).not.toContain('restore-source-button');
    expect(targetsContainer.innerHTML).not.toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('toggle-changes-button');
  });

  test('AT-UI01-1 restore running shows only Pause and Stop', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget()];
    testApi.state.backupProgress['/Volumes/ST/Backup::machine-a::source-a'] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: {
        mode: 'restore',
        status: 'running',
        destinationRoot: '/Users/James/Documents',
        startedAt: '2026-06-16T07:00:00.000Z',
        filesProcessed: 0,
        filesCopied: 0,
        copiedBytes: 0,
        totalBytes: 1024,
        workers: {}
      },
      event: { type: 'restore-started', pool: 'file' }
    };

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('pause-restore-button');
    expect(targetsContainer.innerHTML).toContain('stop-restore-button');
    expect(targetsContainer.innerHTML).not.toContain('resume-restore-button');
    expect(targetsContainer.innerHTML).not.toContain('restore-source-button');
    expect(targetsContainer.innerHTML).not.toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('toggle-changes-button');
  });

  test('AT-UI01-2 restore paused shows Resume and Stop', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget({
      sources: [createSource({
        restoreJob: {
          status: 'paused',
          destinationRoot: '/Users/James/Documents',
          nextTaskIndex: 1
        }
      })]
    })];

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('resume-restore-button');
    expect(targetsContainer.innerHTML).toContain('stop-restore-button');
    expect(targetsContainer.innerHTML).not.toContain('pause-restore-button');
    expect(targetsContainer.innerHTML).not.toContain('restore-source-button');
    expect(targetsContainer.innerHTML).not.toContain('run-backup-button');
  });

  test('AT-UI01-3 restore completed restores idle buttons', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget()];
    const key = '/Volumes/ST/Backup::machine-a::source-a';
    testApi.state.backupProgress[key] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: {
        mode: 'restore',
        status: 'running',
        destinationRoot: '/Users/James/Documents',
        startedAt: '2026-06-16T07:00:00.000Z',
        filesProcessed: 1,
        filesCopied: 1,
        copiedBytes: 256,
        totalBytes: 1024,
        workers: {}
      },
      event: { type: 'restore-started', pool: 'file' }
    };

    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('pause-restore-button');

    testApi.handleBackupProgressPayload({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      summary: { status: 'completed', restoredFiles: 2 },
      progress: {
        mode: 'restore',
        status: 'completed',
        destinationRoot: '/Users/James/Documents',
        filesProcessed: 2,
        filesCopied: 2,
        copiedBytes: 1024,
        totalBytes: 1024,
        workers: {}
      },
      event: { type: 'restore-completed', pool: 'file' }
    });
    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('restore-source-button');
    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).toContain('toggle-changes-button');
    expect(targetsContainer.innerHTML).not.toContain('pause-restore-button');
    expect(targetsContainer.innerHTML).not.toContain('stop-restore-button');
  });

  test('restore completion switches right side back to configured source path', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget({
      sources: [createSource({
        sourcePath: '/Users/James/Documents'
      })]
    })];
    const key = '/Volumes/ST/Backup::machine-a::source-a';
    testApi.state.backupProgress[key] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: {
        mode: 'restore',
        destinationRoot: '/Users/James/RestoreOut',
        startedAt: '2026-06-16T07:00:00.000Z',
        status: 'running',
        filesProcessed: 1,
        filesCopied: 1,
        copiedBytes: 256,
        totalBytes: 1024,
        workers: {},
        queues: { file: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [] } }
      },
      event: { type: 'restore-started', pool: 'file' }
    };

    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('Destination');
    expect(targetsContainer.innerHTML).toContain('/Users/James/RestoreOut');

    testApi.handleBackupProgressPayload({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      summary: {
        machineId: 'machine-a',
        sourceId: 'source-a',
        destinationRoot: '/Users/James/RestoreOut',
        restoredFiles: 2,
        copiedBytes: 1024,
        totalBytes: 1024
      },
      progress: {
        mode: 'restore',
        status: 'completed',
        destinationRoot: '/Users/James/RestoreOut',
        filesProcessed: 2,
        filesCopied: 2,
        copiedBytes: 1024,
        totalBytes: 1024,
        workers: {},
        queues: { file: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [] } }
      },
      event: { type: 'restore-completed', pool: 'file' }
    });

    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('Source');
    expect(targetsContainer.innerHTML).toContain('/Users/James/Documents');
    expect(targetsContainer.innerHTML).not.toContain('/Users/James/RestoreOut');
  });

  test('active backup progress panel toggles from progress circle', () => {
    const testApi = loadRendererTestApi();
    global.window.myBackupProgressPanel = {
      renderBackupProgressPanel: jest.fn(() => '<div class="source-progress-panel">progress details</div>'),
      normalizeProgress: jest.fn(() => ({
        summary: { status: 'running' },
        fileProgress: { workers: [], queue: { waitingItems: [], activeItems: [] } }
      })),
      shouldRenderImmediatelyForProgress: jest.fn(() => true)
    };
    const key = '/Volumes/ST/Backup::machine-a::source-a';
    testApi.state.dashboard.targets = [createTarget()];
    testApi.state.backupProgress[key] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: {
        startedAt: '2026-06-16T07:00:00.000Z',
        status: 'running',
        filesProcessed: 1,
        filesCopied: 1,
        copiedBytes: 128,
        workers: {}
      },
      event: null
    };

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('source-progress-node is-live');
    expect(targetsContainer.innerHTML).not.toContain('source-progress-panel');
    expect(global.window.myBackupProgressPanel.renderBackupProgressPanel).not.toHaveBeenCalled();

    testApi.toggleSourceProgressPanel('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(testApi.state.progressPanelExpanded[key]).toBe(true);
    expect(targetsContainer.innerHTML).toContain('source-progress-panel');
    expect(global.window.myBackupProgressPanel.renderBackupProgressPanel).toHaveBeenCalled();

    testApi.toggleSourceProgressPanel('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(testApi.state.progressPanelExpanded[key]).toBe(false);
    expect(targetsContainer.innerHTML).not.toContain('source-progress-panel');
  });

  test('active backup keeps pause button enabled and sends pause request', async () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget()];
    const key = '/Volumes/ST/Backup::machine-a::source-a';
    testApi.state.backupProgress[key] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: {
        startedAt: '2026-06-16T07:00:00.000Z',
        status: 'running',
        filesProcessed: 1,
        filesCopied: 1,
        copiedBytes: 128,
        workers: {}
      },
      event: null
    };

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).toContain('>Pause<');
    expect(targetsContainer.innerHTML).not.toMatch(/pause-backup-button"[^>]*disabled/);

    await testApi.pauseBackupSource('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(testApi.state.pauseRequests[key]).toBe(true);
    expect(global.window.myBackup.pauseBackup).toHaveBeenCalledWith({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a'
    });
    expect(global.window.myBackup.runBackup).not.toHaveBeenCalled();
  });

  test('AT-UI02-1 backup running shows only Pause and Stop', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget()];
    testApi.state.backupProgress['/Volumes/ST/Backup::machine-a::source-a'] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: {
        status: 'running',
        startedAt: '2026-06-16T07:00:00.000Z',
        filesProcessed: 1,
        filesCopied: 1,
        copiedBytes: 128,
        workers: {}
      },
      event: { type: 'backup-started' }
    };

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).toContain('stop-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('resume-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('restore-source-button');
    expect(targetsContainer.innerHTML).not.toContain('toggle-changes-button');
  });

  test('AT-UI02-2 backup paused shows Resume and Stop', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget({
      sources: [createSource({
        backupJob: {
          status: 'paused',
          type: 'full'
        },
        backupStatus: {
          status: 'paused',
          copiedBytes: 128
        }
      })]
    })];

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('resume-backup-button');
    expect(targetsContainer.innerHTML).toContain('stop-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('restore-source-button');
    expect(targetsContainer.innerHTML).not.toContain('toggle-changes-button');
  });

  test('AT-UI02-3 backup completed restores idle buttons', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget()];
    const key = '/Volumes/ST/Backup::machine-a::source-a';
    testApi.state.backupProgress[key] = {
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      progress: {
        status: 'running',
        startedAt: '2026-06-16T07:00:00.000Z',
        filesProcessed: 1,
        filesCopied: 1,
        copiedBytes: 128,
        workers: {}
      },
      event: { type: 'backup-started' }
    };

    testApi.renderTargets();
    expect(targetsContainer.innerHTML).toContain('pause-backup-button');

    testApi.handleBackupProgressPayload({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      summary: { status: 'completed', filesCopied: 2 },
      progress: {
        status: 'completed',
        filesProcessed: 2,
        filesCopied: 2,
        copiedBytes: 1024,
        workers: {}
      },
      event: { type: 'backup-completed' }
    });
    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).toContain('restore-source-button');
    expect(targetsContainer.innerHTML).toContain('toggle-changes-button');
    expect(targetsContainer.innerHTML).not.toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('stop-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('resume-backup-button');
  });

  test('AT-BUG01-1 Backup Changes with pending changes returns idle buttons', async () => {
    const testApi = loadRendererTestApi();
    const target = createTarget();
    testApi.state.dashboard.targets = [target];
    global.window.myBackup.runBackup.mockResolvedValue({
      dashboard: { targets: [target] },
      summary: {
        status: 'completed',
        mode: 'incremental',
        filesCopied: 2,
        scanResult: { kind: 'changes', sourceFileCount: 2, sourceSizeBytes: 10 }
      }
    });

    await testApi.runBackup('/Volumes/ST/Backup', 'machine-a', 'source-a');
    testApi.renderTargets();

    expect(testApi.state.backupProgress['/Volumes/ST/Backup::machine-a::source-a'].progress.status).toBe('completed');
    expect(testApi.isLiveProgressStatus(testApi.state.backupProgress['/Volumes/ST/Backup::machine-a::source-a'].progress.status)).toBe(false);
    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).toContain('restore-source-button');
    expect(targetsContainer.innerHTML).toContain('toggle-changes-button');
    expect(targetsContainer.innerHTML).not.toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('stop-backup-button');
  });

  test('AT-BUG01-2 Backup Changes with no pending changes completes and returns idle', async () => {
    const testApi = loadRendererTestApi();
    const target = createTarget();
    testApi.state.dashboard.targets = [target];
    global.window.myBackup.runBackup.mockResolvedValue({
      dashboard: { targets: [target] },
      summary: {
        status: 'completed',
        mode: 'incremental',
        filesCopied: 0,
        scanResult: {
          kind: 'changes',
          sourceFileCount: 0,
          sourceSizeBytes: 0,
          targetFileCount: 0,
          targetSizeBytes: 0
        }
      }
    });

    await testApi.runBackup('/Volumes/ST/Backup', 'machine-a', 'source-a');
    testApi.renderTargets();

    expect(testApi.state.backupProgress['/Volumes/ST/Backup::machine-a::source-a'].progress.status).toBe('completed');
    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('is-copying');
  });

  test('AT-BUG01-3 size circle after Backup Changes opens last progress and stays idle', async () => {
    const testApi = loadRendererTestApi();
    global.window.myBackupProgressPanel = {
      renderBackupProgressPanel: jest.fn(() => '<div class="source-progress-panel">last run</div>'),
      normalizeProgress: jest.fn(() => ({ summary: { status: 'completed' } })),
      shouldRenderImmediatelyForProgress: jest.fn(() => true)
    };
    const target = createTarget({
      sources: [createSource({
        scanResult: {
          kind: 'changes',
          sourceFileCount: 0,
          sourceSizeBytes: 0,
          targetFileCount: 0,
          targetSizeBytes: 0
        }
      })]
    });
    testApi.state.dashboard.targets = [target];
    global.window.myBackup.runBackup.mockResolvedValue({
      dashboard: { targets: [target] },
      summary: {
        status: 'completed',
        mode: 'incremental',
        scanResult: target.sources[0].scanResult
      }
    });

    await testApi.runBackup('/Volumes/ST/Backup', 'machine-a', 'source-a');
    testApi.toggleSourceProgressPanel('/Volumes/ST/Backup', 'machine-a', 'source-a');

    const key = '/Volumes/ST/Backup::machine-a::source-a';
    expect(testApi.state.progressPanelExpanded[key]).toBe(true);
    expect(targetsContainer.innerHTML).toContain('source-progress-panel');
    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('pause-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('is-copying');
  });

  test('completed backup keeps last progress and opens it from the size circle', () => {
    const testApi = loadRendererTestApi();
    global.window.myBackupProgressPanel = {
      renderBackupProgressPanel: jest.fn(() => '<div class="source-progress-panel">last run</div>'),
      normalizeProgress: jest.fn(() => ({ summary: { status: 'completed' } })),
      shouldRenderImmediatelyForProgress: jest.fn(() => true)
    };
    const key = '/Volumes/ST/Backup::machine-a::source-a';
    testApi.state.dashboard.targets = [createTarget({
      sources: [createSource({
        scanResult: {
          kind: 'full',
          sourceFileCount: 3,
          sourceSizeBytes: 12,
          targetFileCount: 3,
          targetSizeBytes: 12,
          missingCount: 0,
          backedUp: true
        }
      })]
    })];

    testApi.handleBackupProgressPayload({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      summary: {
        status: 'completed',
        mode: 'full',
        scanResult: {
          kind: 'full',
          sourceFileCount: 3,
          sourceSizeBytes: 12,
          targetFileCount: 3,
          targetSizeBytes: 12
        }
      },
      progress: {
        status: 'completed',
        mode: 'full',
        filesProcessed: 3,
        filesCopied: 3,
        copiedBytes: 12,
        workers: {}
      },
      event: { type: 'backup-completed' }
    });

    expect(testApi.state.backupProgress[key].progress.status).toBe('completed');
    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('source-progress-panel');

    testApi.toggleSourceProgressPanel('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(testApi.state.progressPanelExpanded[key]).toBe(true);
    expect(targetsContainer.innerHTML).toContain('source-progress-panel');
    expect(global.window.myBackupProgressPanel.renderBackupProgressPanel).toHaveBeenCalled();
  });

  test('size circle hydrates last progress from persisted scanResult', () => {
    const testApi = loadRendererTestApi();
    global.window.myBackupProgressPanel = {
      renderBackupProgressPanel: jest.fn(() => '<div class="source-progress-panel">last run</div>'),
      normalizeProgress: jest.fn(() => ({ summary: { status: 'completed' } })),
      shouldRenderImmediatelyForProgress: jest.fn(() => true)
    };
    const key = '/Volumes/ST/Backup::machine-a::source-a';
    testApi.state.dashboard.targets = [createTarget({
      sources: [createSource({
        scanResult: {
          kind: 'changes',
          sourceFileCount: 2,
          sourceSizeBytes: 10,
          targetFileCount: 1,
          targetSizeBytes: 6
        }
      })]
    })];

    testApi.renderTargets();
    testApi.toggleSourceProgressPanel('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(testApi.state.backupProgress[key].summary.scanResult.kind).toBe('changes');
    expect(testApi.state.progressPanelExpanded[key]).toBe(true);
    expect(targetsContainer.innerHTML).toContain('source-progress-panel');
  });

  test('AT-SCAN01-1 Full Scan result appears in the source and target status panel', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget({
      sources: [createSource({
        scanResult: {
          sourceFileCount: 3,
          sourceSizeBytes: 12,
          targetFileCount: 2,
          targetSizeBytes: 8,
          missingCount: 1,
          backedUp: false,
          filesCopied: 2,
          errors: 0
        }
      })]
    })];

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('data-scan-side="source"');
    expect(targetsContainer.innerHTML).toContain('3 files · 12 B');
    expect(targetsContainer.innerHTML).toContain('data-scan-side="target"');
    expect(targetsContainer.innerHTML).toContain('2 files · 8 B');
    expect(targetsContainer.innerHTML).toContain('Missing 1');
    expect(targetsContainer.innerHTML).not.toContain('Backed up');
  });

  test('AT-SCAN01-2 scan result stays on the source row without a modal', () => {
    const testApi = loadRendererTestApi();
    testApi.state.dashboard.targets = [createTarget({
      sources: [createSource({
        scanResult: {
          sourceFileCount: 2,
          sourceSizeBytes: 10,
          targetFileCount: 2,
          targetSizeBytes: 10,
          missingCount: 0,
          backedUp: true,
          filesCopied: 2,
          errors: 0
        }
      })]
    })];

    testApi.renderTargets();

    expect(targetsContainer.innerHTML).toContain('source-card-scan-stats');
    expect(targetsContainer.innerHTML).toContain('source-card-scan-cross');
    expect(targetsContainer.innerHTML).toContain('Backed up');
    expect(targetsContainer.innerHTML).toContain('run-backup-button');
    expect(targetsContainer.innerHTML).not.toContain('modal');
    expect(targetsContainer.innerHTML).not.toContain('scan-result-popup');
  });

  test('resume progress initializes copied bytes from coordinator payload', async () => {
    const testApi = loadRendererTestApi();
    let resolveRunBackup;
    global.window.myBackup.runBackup = jest.fn(() => new Promise((resolve) => {
      resolveRunBackup = resolve;
    }));
    const target = createTarget({
      sources: [createSource({
        backupStatus: {
          status: null,
          mode: 'full',
          runId: null,
          copiedBytes: 0
        }
      })]
    });
    testApi.state.dashboard.targets = [target];

    testApi.applyTerminalProgressToDashboardSource({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      summary: {
        scanId: '20260616-070000',
        copiedBytes: 4096
      },
      progress: {
        scanId: '20260616-070000',
        mode: 'full',
        status: 'paused',
        copiedBytes: 4096
      }
    });

    expect(target.sources[0].backupStatus).toMatchObject({
      status: 'paused',
      runId: '20260616-070000',
      copiedBytes: 4096
    });
    global.window.myBackup.getDashboard.mockResolvedValue({
      targets: [target]
    });

    const runPromise = testApi.runBackup('/Volumes/ST/Backup', 'machine-a', 'source-a');
    await flushAsyncWork();

    expect(testApi.state.backupProgress['/Volumes/ST/Backup::machine-a::source-a'].progress.copiedBytes).toBe(0);
    testApi.handleBackupProgressPayload({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      summary: {
        scanId: '20260616-070000',
        copiedBytes: 4096
      },
      progress: {
        scanId: '20260616-070000',
        status: 'running',
        mode: 'full',
        resumed: true,
        copiedBytes: 4096,
        workers: {},
        queues: { file: { depth: 0, pending: 0, active: 0 } }
      },
      event: { type: 'backup-started' }
    });

    expect(testApi.state.backupProgress['/Volumes/ST/Backup::machine-a::source-a'].progress.copiedBytes).toBe(4096);
    expect(global.window.myBackup.runBackup).toHaveBeenCalledWith({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a',
      forceNewScan: false
    });

    resolveRunBackup({ dashboard: { targets: [] }, summary: { status: 'completed' } });
    await runPromise;
  });

  test('setBusy keeps icon markup for icon buttons', () => {
    const testApi = loadRendererTestApi();
    const labelNode = { textContent: 'Restore' };
    const button = {
      disabled: false,
      dataset: {},
      innerHTML: '<span class="btn-icon">icon</span><span class="btn-label">Restore</span>',
      textContent: 'Restore',
      querySelector: jest.fn((selector) => (selector === '.btn-label' ? labelNode : null))
    };

    testApi.setBusy(button, true, 'Restoring...');
    expect(button.disabled).toBe(true);
    expect(labelNode.textContent).toBe('Restoring...');
    expect(button.innerHTML).toContain('btn-icon');

    testApi.setBusy(button, false);
    expect(button.disabled).toBe(false);
    expect(button.innerHTML).toBe('<span class="btn-icon">icon</span><span class="btn-label">Restore</span>');
  });
});
