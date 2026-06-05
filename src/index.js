process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { ensureMachine } = require('./core/machineRegistry');
const { registerSource } = require('./core/sourceRegistry');
const { backupSource } = require('./core/backupCoordinator');
const { restoreLogicalTree, restoreSource } = require('./core/restoreService');
const { loadLocalConfig, saveLocalConfig } = require('./core/localConfig');
const { addTarget, removeTarget, requireRegisteredTarget, setTargetCollapsed } = require('./core/targetRegistry');
const { createTargetAvailabilityMonitor, normalizePlatform } = require('./core/targetAvailability');
const { configureLogger, createLogger, getLogLevel } = require('./core/logger');

let mainWindow = null;
const logger = createLogger('MainProcess', 'index.js');
const activeBackupProgress = new Map();
const activeBackups = new Map();
const appPlatform = normalizePlatform(process.platform);
const targetAvailability = createTargetAvailabilityMonitor(appPlatform, {
  onChange: async () => {
    await refreshDashboardState(true);
  }
});

// The app is a form-heavy desktop tool and does not benefit from GPU acceleration.
// Disabling it avoids noisy Chromium/EGL initialization failures on some machines.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.disableHardwareAcceleration();

function logToRenderer(level, message, details = null) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('app:log', {
    timestamp: new Date().toISOString(),
    level,
    message,
    details
  });
}

function sendProgressToRenderer(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('app:backup-progress', payload);
}

function getAppDataRoot() {
  return app.getPath('userData');
}

function backupKey(targetRoot, machineId, sourceId) {
  return `${targetRoot}::${machineId}::${sourceId}`;
}

async function buildDashboardState() {
  const localConfig = await loadLocalConfig(getAppDataRoot());
  const targets = await Promise.all((localConfig.targets || []).map(async (target) => {
    const entry = await targetAvailability.buildTargetDashboardEntry(target);
    if (!entry.available) {
      logger.warn('Backup target is unavailable.', {
        targetRoot: target.path,
        reason: entry.unavailableReason
      });
    }
    return entry;
  }));

  return {
    logLevel: localConfig.logLevel || getLogLevel(),
    targets
  };
}

async function refreshDashboardState(emitUpdate = false) {
  const startedAt = Date.now();
  logger.debug('Refreshing dashboard state.', {
    emitUpdate,
    platform: appPlatform
  });
  const dashboard = await buildDashboardState();
  if (emitUpdate && mainWindow && !mainWindow.isDestroyed()) {
    logger.info('Sending dashboard update to renderer.', {
      targetCount: dashboard.targets ? dashboard.targets.length : 0
    });
    mainWindow.webContents.send('app:dashboard-updated', dashboard);
  }
  logger.info('Dashboard state refresh completed.', {
    emitUpdate,
    targetCount: dashboard.targets ? dashboard.targets.length : 0,
    durationMs: Date.now() - startedAt
  });
  return dashboard;
}

async function requireTargetRoot(input) {
  return requireRegisteredTarget(getAppDataRoot(), input && input.targetRoot);
}

async function ensureMachineForTarget(targetRoot) {
  return ensureMachine(targetRoot, {
    hostname: app.getName(),
    displayName: app.getName()
  });
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-dashboard', async () => refreshDashboardState(false));
  ipcMain.handle('app:set-log-level', async (_event, input) => {
    const level = input && input.level ? input.level : 'info';
    configureLogger({ level });
    await saveLocalConfig(getAppDataRoot(), { logLevel: level });
    logger.info('Log level updated.', { level });
    return refreshDashboardState(false);
  });

  async function pickAndAddTarget() {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Backup Target Folder'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return refreshDashboardState(false);
    }

    const targetRoot = result.filePaths[0];
    await addTarget(getAppDataRoot(), targetRoot);
    await ensureMachineForTarget(targetRoot);
    logger.info('Backup target added.', { targetRoot });
    logToRenderer('info', 'Backup target added.', { targetRoot });
    return refreshDashboardState(false);
  }

  ipcMain.handle('app:add-target', async () => pickAndAddTarget());
  ipcMain.handle('app:select-target', async () => pickAndAddTarget());

  ipcMain.handle('app:remove-target', async (_event, input) => {
    if (!input || !input.targetId) {
      throw new Error('Target id is required.');
    }

    await removeTarget(getAppDataRoot(), input.targetId);
    logger.info('Backup target removed from app list.', { targetId: input.targetId });
    logToRenderer('info', 'Backup target removed from app list.', { targetId: input.targetId });
    return refreshDashboardState(false);
  });

  ipcMain.handle('app:set-target-collapsed', async (_event, input) => {
    if (!input || !input.targetId) {
      throw new Error('Target id is required.');
    }

    await setTargetCollapsed(getAppDataRoot(), input.targetId, Boolean(input.collapsed));
    return buildDashboardState();
  });

  ipcMain.handle('app:add-source', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const machine = await ensureMachineForTarget(targetRoot);
    const source = await registerSource(targetRoot, {
      machineId: machine.machineId,
      sourcePath: input.sourcePath,
      organizeMedia: Boolean(input.organizeMedia),
      mergeEnabled: Boolean(input.mergeEnabled),
      mergeKey: input.mergeKey || null
    });
    logger.info('Source registered.', {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      mergeEnabled: source.mergeEnabled,
      organizeMedia: source.organizeMedia
    });
    logToRenderer('info', 'Source registered.', {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath
    });
    return buildDashboardState();
  });

  ipcMain.handle('app:pick-source-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Source Folder'
    });

    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle('app:run-backup', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const key = backupKey(targetRoot, input.machineId, input.sourceId);
    if (activeBackups.has(key)) {
      throw new Error('Backup already running for this source.');
    }

    logger.info('Backup requested.', {
      targetRoot,
      machineId: input.machineId,
      sourceId: input.sourceId,
      forceNewScan: Boolean(input.forceNewScan)
    });
    logToRenderer('info', 'Backup started.', {
      targetRoot,
      sourceId: input.sourceId
    });
    activeBackupProgress.set(key, {
      targetRoot,
      machineId: input.machineId,
      sourceId: input.sourceId,
      status: 'running'
    });
    const control = {
      pauseRequested: false
    };
    activeBackups.set(key, control);

    try {
      const summary = await backupSource(targetRoot, input.machineId, input.sourceId, {
        forceNewScan: Boolean(input.forceNewScan),
        shouldPause: () => control.pauseRequested,
        onProgress: ({ summary: progressSummary, progress, event }) => {
          const payload = {
            targetRoot,
            machineId: input.machineId,
            sourceId: input.sourceId,
            summary: progressSummary,
            progress,
            event
          };
          activeBackupProgress.set(key, payload);
          sendProgressToRenderer(payload);
        }
      });
      activeBackupProgress.delete(key);
      if (summary.status === 'paused') {
        logger.info('Backup paused.', summary);
        logToRenderer('info', 'Backup paused.', summary);
      } else {
        logger.info('Backup completed.', summary);
        logToRenderer('info', 'Backup completed.', summary);
      }
      return {
        summary,
        dashboard: await buildDashboardState()
      };
    } catch (error) {
      activeBackupProgress.delete(key);
      throw error;
    } finally {
      activeBackups.delete(key);
    }
  });

  ipcMain.handle('app:pause-backup', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const key = backupKey(targetRoot, input.machineId, input.sourceId);
    const control = activeBackups.get(key);
    if (!control) {
      logger.warn('Backup pause ignored because no active backup was found.', {
        machineId: input.machineId,
        sourceId: input.sourceId
      });
      return { accepted: false };
    }

    control.pauseRequested = true;
    const activeProgress = activeBackupProgress.get(key);
    const queueSnapshot = activeProgress?.progress?.queues || null;
    logger.info('Backup pause requested.', {
      machineId: input.machineId,
      sourceId: input.sourceId,
      queues: queueSnapshot
    });
    logToRenderer('info', 'Pause requested. Finishing in-flight work and cancelling queued files...', {
      sourceId: input.sourceId,
      queues: queueSnapshot
    });
    return { accepted: true };
  });

  ipcMain.handle('app:restore-source', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Restore Destination'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const summary = await restoreSource(targetRoot, {
      machineId: input.machineId,
      sourceId: input.sourceId,
      destinationRoot: result.filePaths[0]
    });
    logger.info('Source restore completed.', summary);
    logToRenderer('info', 'Source restore completed.', summary);
    return summary;
  });

  ipcMain.handle('app:restore-merged', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Restore Destination'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const summary = await restoreLogicalTree(targetRoot, {
      logicalRoot: input.logicalRoot,
      destinationRoot: result.filePaths[0]
    });
    logger.info('Merged restore completed.', summary);
    logToRenderer('info', 'Merged restore completed.', summary);
    return summary;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1120,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
  const localConfig = await loadLocalConfig(getAppDataRoot());
  configureLogger({
    level: localConfig.logLevel || process.env.MYBACKUP_LOG_LEVEL || 'info',
    sink: (record) => {
      logToRenderer(record.level, record.formatted, record.details);
    }
  });
  logger.info('Application ready.', {
    logLevel: getLogLevel(),
    platform: appPlatform
  });

  registerIpcHandlers();
  await targetAvailability.bootstrap();
  logger.info('Target availability monitor bootstrapped.', {
    platform: appPlatform,
    mountedRoots: Array.from(targetAvailability.getMountedRoots())
  });
  targetAvailability.start();
  createWindow();
  await refreshDashboardState(true);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
