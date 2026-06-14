process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { ensureBackupSchema } = require('./core/backupSchema');
const { registerSource } = require('./core/sourceRegistry');
const { backupSource } = require('./core/backupCoordinator');
const { restoreLogicalTree, restoreSource } = require('./core/restoreService');
const { ensureLocalConfig, loadLocalConfig, saveLocalConfig } = require('./core/localConfig');
const { addTarget, listTargets, removeTarget, requireRegisteredTarget, setTargetCollapsed } = require('./core/targetRegistry');
const { createTargetAvailabilityMonitor, normalizePlatform } = require('./core/targetAvailability');
const { createWatchService } = require('./core/watch/watchService');
const { configureLogger, createLogger, getLogLevel } = require('./core/logger');
const { getSourceFolderName, normalizeTargetFolder } = require('./core/pathPlanner');
const { loadRuntimeFlags } = require('./core/runtimeFlags');

let mainWindow = null;
const logger = createLogger('MainProcess', 'index.js');
const activeBackupProgress = new Map();
const activeBackups = new Map();
let progressForwardTraceCount = 0;
const PROGRESS_FORWARD_TRACE_LIMIT = 160;
const appPlatform = normalizePlatform(process.platform);
let watchService = null;
let runtimeFlags = {
  traceProgressUi: String(process.env.MYBACKUP_TRACE_PROGRESS_UI || '1').trim() !== '0',
  showProgressQueueDetails: false
};
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

function getRuntimeFlags() {
  return { ...runtimeFlags };
}

function summarizeProgressForTrace(payload) {
  const workers = Object.values(payload.progress?.workers || {});
  const summarizeWorker = (worker) => ({
    id: worker.workerId,
    pool: worker.pool,
    state: worker.state,
    sourceRelativePath: worker.sourceRelativePath || null,
    logicalPath: worker.logicalPath || null,
    lastAction: worker.lastAction || null,
    copiedBytes: worker.copiedBytes || 0,
    totalBytes: worker.totalBytes || 0
  });
  const summarizeQueue = (queue) => ({
    depth: queue?.depth || 0,
    pending: queue?.pending || 0,
    active: queue?.active || 0,
    waitingItems: (queue?.waitingItems || []).slice(0, 8),
    activeItems: (queue?.activeItems || []).slice(0, 8)
  });
  return {
    sequence: payload.trace?.sequence || null,
    stage: 'main-forwarding',
    event: payload.event ? {
      type: payload.event.type,
      pool: payload.event.pool || null,
      workerId: payload.event.workerId || null,
      sourceRelativePath: payload.event.sourceRelativePath || null
    } : null,
    status: payload.progress?.status || null,
    fileWorkers: workers.filter((worker) => worker.pool === 'file').map(summarizeWorker),
    invalidWorkers: workers.filter((worker) => worker.pool !== 'file').map(summarizeWorker),
    fileQueue: summarizeQueue(payload.progress?.queues?.file)
  };
}

function getAppDataRoot() {
  const override = process.env.MYBACKUP_APP_DATA_ROOT;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.resolve(__dirname, '..', 'data');
}

function getDefaultMachineInput() {
  const hostname = os.hostname();
  return {
    hostname,
    displayName: app.getName(),
    platform: process.platform,
    seed: `${hostname}-${process.platform}`
  };
}

async function ensureAppSchema() {
  return ensureBackupSchema(getAppDataRoot(), getDefaultMachineInput());
}

function backupKey(targetRoot, machineId, sourceId) {
  return `${targetRoot}::${machineId}::${sourceId}`;
}

async function loadWorkerPoolsForBackup() {
  const localConfig = await loadLocalConfig(getAppDataRoot());
  return localConfig.workerPools;
}

async function buildDashboardState() {
  await ensureAppSchema();
  const localConfig = await loadLocalConfig(getAppDataRoot());
  const registeredTargets = await listTargets(getAppDataRoot());
  const targets = await Promise.all(registeredTargets.map(async (target) => {
    const entry = await targetAvailability.buildTargetDashboardEntry(target, getAppDataRoot());
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

function registerIpcHandlers() {
  ipcMain.handle('app:get-dashboard', async () => refreshDashboardState(false));
  ipcMain.handle('app:get-runtime-flags', async () => getRuntimeFlags());
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
    const schema = await ensureAppSchema();
    const sourcePath = path.resolve(input.sourcePath || '');
    const targetFolder = normalizeTargetFolder(input.targetFolder || '');
    const targetSourceRoot = path.join(targetRoot, targetFolder, getSourceFolderName({ sourcePath }));
    const targetSourceRootExists = await fs.pathExists(targetSourceRoot);
    if (targetSourceRootExists && !input.confirmMerge) {
      return {
        conflict: true,
        targetRoot,
        targetFolder,
        targetSourceRoot
      };
    }
    const source = await registerSource(getAppDataRoot(), {
      targetRoot,
      machineId: schema.machine.machineId,
      sourcePath,
      targetFolder
    });
    logger.info('Source registered.', {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      targetFolder: source.targetFolder
    });
    logToRenderer('info', 'Source registered.', {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath
    });
    if (watchService) {
      await watchService.refresh();
    }
    return {
      conflict: false,
      dashboard: await buildDashboardState()
    };
  });

  ipcMain.handle('app:pick-source-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Source Folder'
    });

    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle('app:pick-target-folder', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Target Folder Inside Backup Target',
      defaultPath: targetRoot
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = path.resolve(result.filePaths[0]);
    const relativePath = path.relative(targetRoot, selectedPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Target folder must stay inside the selected backup target.');
    }

    return normalizeTargetFolder(relativePath);
  });

  ipcMain.handle('app:run-backup', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const key = backupKey(targetRoot, input.machineId, input.sourceId);
    if (activeBackups.has(key)) {
      throw new Error('Backup already running for this source.');
    }

    const workerPools = await loadWorkerPoolsForBackup();

    logger.info('Backup requested.', {
      targetRoot,
      machineId: input.machineId,
      sourceId: input.sourceId,
      forceNewScan: Boolean(input.forceNewScan),
      workerPools
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
        appDataRoot: getAppDataRoot(),
        forceNewScan: Boolean(input.forceNewScan),
        initialHashWorkers: workerPools.hash,
        maxHashWorkers: workerPools.hash,
        initialCopyWorkers: workerPools.copy,
        maxCopyWorkers: workerPools.copy,
        shouldPause: () => control.pauseRequested,
        onProgress: ({ summary: progressSummary, progress, event, trace }) => {
          const payload = {
            targetRoot,
            machineId: input.machineId,
            sourceId: input.sourceId,
            summary: progressSummary,
            progress,
            event,
            trace
          };
          activeBackupProgress.set(key, payload);
          if (getRuntimeFlags().traceProgressUi && progressForwardTraceCount < PROGRESS_FORWARD_TRACE_LIMIT) {
            progressForwardTraceCount += 1;
            logToRenderer('info', 'Progress trace: main forwarding payload.', summarizeProgressForTrace(payload));
          }
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
  const localConfig = await ensureLocalConfig(getAppDataRoot());
  await ensureAppSchema();
  runtimeFlags = await loadRuntimeFlags({
    appPath: path.resolve(__dirname, '..'),
    cwd: process.cwd(),
    appDataRoot: getAppDataRoot()
  });
  runtimeFlags.traceProgressUi = String(process.env.MYBACKUP_TRACE_PROGRESS_UI || String(runtimeFlags.traceProgressUi ? 1 : 0)).trim() !== '0';
  configureLogger({
    level: localConfig.logLevel || process.env.MYBACKUP_LOG_LEVEL || 'info',
    sink: (record) => {
      logToRenderer(record.level, record.formatted, record.details);
    }
  });
  logger.info('Application ready.', {
    logLevel: getLogLevel(),
    platform: appPlatform,
    appDataRoot: getAppDataRoot()
  });

  registerIpcHandlers();
  await targetAvailability.bootstrap();
  logger.info('Target availability monitor bootstrapped.', {
    platform: appPlatform,
    mountedRoots: Array.from(targetAvailability.getMountedRoots())
  });
  targetAvailability.start();
  watchService = createWatchService(appPlatform, {
    appDataRoot: getAppDataRoot()
  });
  await watchService.bootstrap();
  await watchService.start();
  logger.info('Source watch service bootstrapped.', {
    platform: appPlatform
  });
  createWindow();
  await refreshDashboardState(true);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  console.error('Application startup failed.', message);
  dialog.showErrorBox('MyBackup Startup Failed', message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (watchService) {
    await watchService.stop();
  }
});
