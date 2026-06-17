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
        runBackup: jest.fn(async () => ({ dashboard: { targets: [] }, summary: { status: 'completed' } })),
        pauseBackup: jest.fn(async () => ({ accepted: true })),
        setTargetCollapsed: jest.fn(() => Promise.resolve())
      }
    };
    global.document = {
      addEventListener: () => {},
      getElementById: (id) => (id === 'targetsContainer' ? targetsContainer : null)
    };
    return require('../src/renderer').__test__;
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

  test('active backup progress panel only opens from progress circle', () => {
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

    testApi.openSourceProgressPanel('/Volumes/ST/Backup', 'machine-a', 'source-a');

    expect(testApi.state.progressPanelExpanded[key]).toBe(true);
    expect(targetsContainer.innerHTML).toContain('source-progress-panel');
    expect(global.window.myBackupProgressPanel.renderBackupProgressPanel).toHaveBeenCalled();
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
});
