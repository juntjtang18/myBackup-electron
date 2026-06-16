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
});
