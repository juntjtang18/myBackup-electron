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
    expect(targetsContainer.innerHTML).toMatch(/run-backup-button"[^>]*disabled/);
    expect(targetsContainer.innerHTML).toContain('Restoring...');
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

    expect(targetsContainer.innerHTML).toContain('>Pause<');
    expect(targetsContainer.innerHTML).not.toMatch(/run-backup-button"[^>]*disabled/);

    await testApi.runBackup('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(testApi.state.pauseRequests[key]).toBe(true);
    expect(global.window.myBackup.pauseBackup).toHaveBeenCalledWith({
      targetRoot: '/Volumes/ST/Backup',
      machineId: 'machine-a',
      sourceId: 'source-a'
    });
    expect(global.window.myBackup.runBackup).not.toHaveBeenCalled();
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
