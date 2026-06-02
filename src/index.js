const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { ensureMachine } = require('./core/machineRegistry');
const { registerSource } = require('./core/sourceRegistry');
const { backupSource } = require('./core/backupCoordinator');
const { restoreLogicalTree, restoreSource } = require('./core/restoreService');
const { loadLocalConfig, saveLocalConfig } = require('./core/localConfig');
const { loadCurrentMachineContext } = require('./core/sourceCatalog');
const { configureLogger, createLogger, getLogLevel } = require('./core/logger');

let mainWindow = null;
const logger = createLogger('MainProcess', 'index.js');
const activeBackupProgress = new Map();
const activeBackups = new Map();

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

async function buildDashboardState() {
  const localConfig = await loadLocalConfig(getAppDataRoot());
  if (!localConfig.targetRoot) {
    return {
      targetRoot: null,
      logLevel: localConfig.logLevel || getLogLevel(),
      machine: null,
      sources: []
    };
  }

  const context = await loadCurrentMachineContext(localConfig.targetRoot);
  return {
    targetRoot: localConfig.targetRoot,
    logLevel: localConfig.logLevel || getLogLevel(),
    machine: context.machine,
    sources: context.sources.map((source) => ({
      machineId: source.machineId,
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      targetSubdir: source.targetSubdir,
      mergeEnabled: source.mergeEnabled,
      mergeKey: source.mergeKey,
      organizeMedia: source.organizeMedia,
      lastCompletedScan: source.lastCompletedScan,
      lastCompletedAt: source.lastCompletedAt,
      scanStatus: source.scanState ? source.scanState.status : null,
      activeGeneration: source.scanState ? source.scanState.activeGeneration : null
    }))
  };
}

async function requireTargetRoot() {
  const localConfig = await loadLocalConfig(getAppDataRoot());
  if (!localConfig.targetRoot) {
    throw new Error('Select a backup target first.');
  }

  return localConfig.targetRoot;
}

async function ensureMachineForTarget(targetRoot) {
  return ensureMachine(targetRoot, {
    hostname: app.getName(),
    displayName: app.getName()
  });
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-dashboard', async () => buildDashboardState());
  ipcMain.handle('app:set-log-level', async (_event, input) => {
    const level = input && input.level ? input.level : 'info';
    configureLogger({ level });
    await saveLocalConfig(getAppDataRoot(), { logLevel: level });
    logger.info('Log level updated.', { level });
    return buildDashboardState();
  });

  ipcMain.handle('app:select-target', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Backup Target'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return buildDashboardState();
    }

    const targetRoot = result.filePaths[0];
    await saveLocalConfig(getAppDataRoot(), { targetRoot });
    await ensureMachineForTarget(targetRoot);
    logger.info('Backup target selected.', { targetRoot });
    logToRenderer('info', 'Backup target selected.', { targetRoot });
    return buildDashboardState();
  });

  ipcMain.handle('app:add-source', async (_event, input) => {
    const targetRoot = await requireTargetRoot();
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
    const targetRoot = await requireTargetRoot();
    const backupKey = `${input.machineId}:${input.sourceId}`;
    if (activeBackups.has(backupKey)) {
      throw new Error('Backup already running for this source.');
    }

    logger.info('Backup requested.', {
      machineId: input.machineId,
      sourceId: input.sourceId,
      forceNewScan: Boolean(input.forceNewScan)
    });
    logToRenderer('info', 'Backup started.', {
      sourceId: input.sourceId
    });
    activeBackupProgress.set(backupKey, {
      machineId: input.machineId,
      sourceId: input.sourceId,
      status: 'running'
    });
    const control = {
      pauseRequested: false
    };
    activeBackups.set(backupKey, control);

    try {
      const summary = await backupSource(targetRoot, input.machineId, input.sourceId, {
        forceNewScan: Boolean(input.forceNewScan),
        shouldPause: () => control.pauseRequested,
        onProgress: ({ summary: progressSummary, progress, event }) => {
          const payload = {
            machineId: input.machineId,
            sourceId: input.sourceId,
            summary: progressSummary,
            progress,
            event
          };
          activeBackupProgress.set(backupKey, payload);
          sendProgressToRenderer(payload);
        }
      });
      activeBackupProgress.delete(backupKey);
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
      activeBackupProgress.delete(backupKey);
      throw error;
    } finally {
      activeBackups.delete(backupKey);
    }
  });

  ipcMain.handle('app:pause-backup', async (_event, input) => {
    const backupKey = `${input.machineId}:${input.sourceId}`;
    const control = activeBackups.get(backupKey);
    if (!control) {
      return { accepted: false };
    }

    control.pauseRequested = true;
    logger.info('Backup pause requested.', {
      machineId: input.machineId,
      sourceId: input.sourceId
    });
    return { accepted: true };
  });

  ipcMain.handle('app:restore-source', async (_event, input) => {
    const targetRoot = await requireTargetRoot();
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
    const targetRoot = await requireTargetRoot();
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
    logLevel: getLogLevel()
  });

  registerIpcHandlers();
  createWindow();

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
