process.noAsar = true;
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, Tray } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { ensureBackupSchema, loadBackupSchema } = require('./core/backupSchema');
const {
  catalogSetToSource,
  findSet,
  loadCatalog
} = require('./core/targetCatalog');
const { addSourceToTarget, removeSource } = require('./core/sourceRegistry');
const { backupSource, clearBackupRunState } = require('./core/backupCoordinator');
const { restoreLogicalTree, restoreSource } = require('./core/restoreService');
const { chooseRestoreDestination } = require('./core/restoreDestination');
const { clearRestoreJob, loadRestoreJob } = require('./core/restoreJobStore');
const { ensureLocalConfig, loadLocalConfig, saveLocalConfig } = require('./core/localConfig');
const { addTarget, listTargets, removeTarget, requireRegisteredTarget, setTargetCollapsed } = require('./core/targetRegistry');
const { createTargetAvailabilityMonitor, normalizePlatform } = require('./core/targetAvailability');
const { createWatchService } = require('./core/watch/watchService');
const { ChangeTracker } = require('./core/changeTracking/ChangeTracker');
const { configureLogger, createLogger, getLogLevel } = require('./core/logger');
const { getSourceTargetRoot, normalizeTargetFolder } = require('./core/pathPlanner');
const { loadRuntimeFlags } = require('./core/runtimeFlags');
const {
  readSourceIgnoreFile,
  SOURCE_IGNORE_TEMPLATE,
  writeSourceIgnoreFile
} = require('./core/ignoreMatcher');

let mainWindow = null;
const logger = createLogger('MainProcess', 'index.js');
const activeBackupProgress = new Map();
const activeBackups = new Map();
const activeRestores = new Map();
let progressForwardTraceCount = 0;
const PROGRESS_FORWARD_TRACE_LIMIT = 160;
const appPlatform = normalizePlatform(process.platform);
let watchService = null;
let tray = null;
let trayMinimizeNotified = false;
let daemonStatus = {
  running: false,
  watchedSources: 0,
  watchedPaths: [],
  eventCount: 0,
  updatedAt: new Date().toISOString()
};
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

function toErrorObject(error) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function reportProcessError(kind, error) {
  const normalized = toErrorObject(error);
  logger.error(`Unhandled process error (${kind}).`, {
    message: normalized.message,
    stack: normalized.stack
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    logToRenderer('error', `Unhandled process error (${kind}).`, {
      message: normalized.message
    });
  }
}

function installProcessErrorGuards() {
  process.on('unhandledRejection', (reason) => {
    reportProcessError('unhandledRejection', reason);
  });

  process.on('uncaughtException', (error) => {
    reportProcessError('uncaughtException', error);
  });
}

installProcessErrorGuards();

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

function sendDaemonStatusToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('app:daemon-status', daemonStatus);
}

function createTrayIcon() {
  // Minimal monochrome dot icon generated in-memory to avoid external asset dependency.
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
      <circle cx="8" cy="8" r="5" fill="#2dd46f"/>
    </svg>
  `;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function restoreFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function ensureTray() {
  if (tray) {
    return tray;
  }
  tray = new Tray(createTrayIcon());
  tray.setToolTip('MyBackup');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open MyBackup',
      click: () => restoreFromTray()
    },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  ]));
  tray.on('click', () => restoreFromTray());
  return tray;
}

function minimizeToTrayIfNeeded() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  if (!daemonStatus.running) {
    return false;
  }
  ensureTray();
  mainWindow.hide();
  if (!trayMinimizeNotified) {
    trayMinimizeNotified = true;
    logToRenderer('info', 'MyBackup minimized to system tray while daemon is running.');
    if (Notification.isSupported()) {
      try {
        new Notification({
          title: 'MyBackup',
          body: 'Running in system tray while daemon is active.'
        }).show();
      } catch (error) {
        logger.warn('Failed to show tray minimize notification.', {
          message: error.message
        });
      }
    }
  }
  return true;
}

function setDaemonStatus(nextStatus) {
  daemonStatus = {
    running: Boolean(nextStatus?.running),
    watchedSources: Number(nextStatus?.watchedSources || 0),
    watchedPaths: Array.isArray(nextStatus?.watchedPaths)
      ? nextStatus.watchedPaths.filter((value) => typeof value === 'string' && value.trim() !== '')
      : [],
    eventCount: Number(nextStatus?.eventCount || 0),
    updatedAt: new Date().toISOString()
  };
  sendDaemonStatusToRenderer();
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
    const sources = await Promise.all((entry.sources || []).map(async (source) => {
      const restoreJob = await loadRestoreJob(getAppDataRoot(), source.sourceId);
      return {
        ...source,
        restoreJob: restoreJob && restoreJob.status === 'paused' ? restoreJob : null
      };
    }));
    return {
      ...entry,
      sources
    };
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

async function maybeOfferAddRestoredSource({ targetRoot, source, destinationRoot }) {
  if (!destinationRoot || !source || !mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const confirm = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Add Source', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Add restored folder as source?',
    message: 'Restore finished to a folder that is not a source.',
    detail: `${destinationRoot}\n\nAdd it as a new source with the same exclude rules? Existing sources stay unchanged.`
  });
  if (confirm.response !== 0) {
    return null;
  }

  const schema = await ensureAppSchema();
  const ignore = await readSourceIgnoreFile(getAppDataRoot(), source).catch(() => null);
  const locals = (schema.targets || [])
    .filter((target) => path.resolve(target.path) === path.resolve(targetRoot))
    .flatMap((target) => target.sources || []);
  const setAlreadyBound = Boolean(
    source.setId
    && locals.some((entry) => entry.setId === source.setId)
  );
  const added = await addSourceToTarget(getAppDataRoot(), {
    targetRoot,
    machineId: schema.machine.machineId,
    sourcePath: destinationRoot,
    targetFolder: source.targetFolder || '',
    includeSourceRoot: source.includeSourceRoot,
    relativeRoot: source.relativeRoot,
    folderName: source.folderName,
    setId: setAlreadyBound ? undefined : (source.setId || undefined),
    rulesText: ignore?.rulesText || SOURCE_IGNORE_TEMPLATE
  }, schema.machine);
  if (watchService) {
    await watchService.refresh();
    setDaemonStatus(await watchService.getStatus());
  }
  logger.info('Added restored folder as a new source.', {
    sourcePath: destinationRoot,
    sourceId: added.sourceId
  });
  logToRenderer('info', 'Added restored folder as a new source.', {
    sourcePath: destinationRoot,
    sourceId: added.sourceId
  });
  return added;
}

async function requireSourceById(input) {
  if (!input || !input.targetId || !input.sourceId) {
    throw new Error('Target id and source id are required.');
  }

  const schema = await loadBackupSchema(getAppDataRoot());
  const target = (schema?.targets || []).find((entry) => entry.id === input.targetId);
  if (!target) {
    throw new Error(`Unknown backup target id: ${input.targetId}`);
  }

  const sourceByExactIdentity = (target.sources || []).find((entry) => (
    entry.sourceId === input.sourceId
    && (!input.machineId || entry.machineId === input.machineId)
  ));
  const sourceByTargetAndId = sourceByExactIdentity || (target.sources || []).find((entry) => (
    entry.sourceId === input.sourceId
  ));
  const sourceByIdInAnyTarget = sourceByTargetAndId || (() => {
    const candidates = (schema?.targets || []).flatMap((entry) => (
      (entry.sources || [])
        .filter((sourceEntry) => sourceEntry.sourceId === input.sourceId)
        .map((sourceEntry) => ({ target: entry, source: sourceEntry }))
    ));
    return candidates.length === 1 ? candidates[0].source : null;
  })();
  const source = sourceByIdInAnyTarget;
  if (!source) {
    throw new Error(`Unknown source id: ${input.sourceId}`);
  }

  return { target, source };
}

function pathsEqualWithPlatform(leftPath, rightPath) {
  if (!leftPath || !rightPath) {
    return false;
  }
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function resolveSourceForBackupRun(schema, input, targetRoot) {
  const targets = schema?.targets || [];
  const exactTarget = targets.find((entry) => pathsEqualWithPlatform(entry.path, targetRoot)) || null;
  const findById = (target) => (target?.sources || []).filter((entry) => (
    entry.sourceId === input.sourceId
    && (!input.machineId || entry.machineId === input.machineId)
  ));

  const targetScopedCandidates = findById(exactTarget);
  if (targetScopedCandidates.length > 0) {
    return {
      targetPath: exactTarget.path,
      source: targetScopedCandidates[0],
      fallback: false
    };
  }

  const globalCandidates = targets.flatMap((entry) => (
    findById(entry).map((source) => ({ targetPath: entry.path, source }))
  ));
  if (globalCandidates.length === 1) {
    return {
      targetPath: globalCandidates[0].targetPath,
      source: globalCandidates[0].source,
      fallback: true
    };
  }

  if (exactTarget) {
    const looseCandidates = (exactTarget.sources || []).filter((entry) => entry.sourceId === input.sourceId);
    if (looseCandidates.length > 0) {
      return {
        targetPath: exactTarget.path,
        source: looseCandidates[0],
        fallback: false
      };
    }
  }

  return {
    targetPath: targetRoot,
    source: null,
    fallback: false
  };
}

function registerIpcHandlers() {
  const handle = (channel, handler) => {
    ipcMain.handle(channel, async (...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        const normalized = toErrorObject(error);
        logger.error('IPC handler failed.', {
          channel,
          message: normalized.message,
          stack: normalized.stack
        });
        throw normalized;
      }
    });
  };

  handle('app:get-dashboard', async () => refreshDashboardState(false));
  handle('app:copy-text', async (_event, input) => {
    const text = String(input?.text || '');
    try {
      clipboard.writeText(text);
      const readBack = clipboard.readText();
      const ok = text === '' ? true : readBack === text;
      return {
        ok,
        error: ok ? null : 'Clipboard read-back mismatch.'
      };
    } catch (error) {
      const normalized = toErrorObject(error);
      return {
        ok: false,
        error: normalized.message
      };
    }
  });
  handle('app:get-daemon-status', async () => {
    if (watchService) {
      setDaemonStatus(await watchService.getStatus());
    }
    return daemonStatus;
  });
  handle('app:get-app-version', async () => app.getVersion());
  handle('app:get-runtime-flags', async () => getRuntimeFlags());
  handle('change-tracking:get-change-list', async (_event, input) => {
    const { source } = await requireSourceById(input);

    const tracker = new ChangeTracker(getAppDataRoot());
    return tracker.getChangeList(source);
  });
  handle('app:set-log-level', async (_event, input) => {
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

  handle('app:add-target', async () => pickAndAddTarget());
  handle('app:select-target', async () => pickAndAddTarget());

  handle('app:remove-target', async (_event, input) => {
    if (!input || !input.targetId) {
      throw new Error('Target id is required.');
    }

    await removeTarget(getAppDataRoot(), input.targetId);
    logger.info('Backup target removed from app list.', { targetId: input.targetId });
    logToRenderer('info', 'Backup target removed from app list.', { targetId: input.targetId });
    return refreshDashboardState(false);
  });

  handle('app:set-target-collapsed', async (_event, input) => {
    if (!input || !input.targetId) {
      throw new Error('Target id is required.');
    }

    await setTargetCollapsed(getAppDataRoot(), input.targetId, Boolean(input.collapsed));
    return {
      targetId: input.targetId,
      collapsed: Boolean(input.collapsed)
    };
  });

  handle('app:add-source', async (_event, input) => {
    if (!input || typeof input.rulesText !== 'string') {
      throw new Error('Exclude rules must be saved before adding a source.');
    }
    const targetRoot = await requireTargetRoot(input);
    const schema = await ensureAppSchema();
    const sourcePath = path.resolve(input.sourcePath || '');
    if (!sourcePath) {
      throw new Error('Source folder is required.');
    }
    if (!(await fs.pathExists(sourcePath))) {
      throw new Error('Source folder does not exist.');
    }
    const targetFolder = normalizeTargetFolder(input.targetFolder || '');
    const includeSourceRoot = Boolean(input?.includeSourceRoot);
    const sourceTargetRoot = getSourceTargetRoot(schema.machine.machineId, {
      sourcePath,
      sourceId: '',
      targetFolder,
      includeSourceRoot
    });
    const targetSourceRoot = path.join(targetRoot, sourceTargetRoot);
    const requiresMergeConfirmation = includeSourceRoot;
    const targetSourceRootExists = requiresMergeConfirmation && await fs.pathExists(targetSourceRoot);
    if (targetSourceRootExists && !input.confirmMerge) {
      return {
        conflict: true,
        targetRoot,
        targetFolder,
        targetSourceRoot
      };
    }
    const source = await addSourceToTarget(getAppDataRoot(), {
      targetRoot,
      machineId: schema.machine.machineId,
      sourcePath,
      targetFolder,
      includeSourceRoot,
      rulesText: input.rulesText
    }, schema.machine);
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
      setDaemonStatus(await watchService.getStatus());
    }
    return {
      conflict: false,
      dashboard: await buildDashboardState()
    };
  });

  handle('app:get-source-ignore-rules', async (_event, input) => {
    const { source } = await requireSourceById(input);
    const rulesDocument = await readSourceIgnoreFile(getAppDataRoot(), source);
    return {
      ...rulesDocument,
      sourcePath: source.sourcePath
    };
  });

  handle('app:save-source-ignore-rules', async (_event, input) => {
    const { source } = await requireSourceById(input);
    if (!input || typeof input.rulesText !== 'string') {
      throw new Error('rulesText must be a string.');
    }
    const rulesDocument = await writeSourceIgnoreFile(getAppDataRoot(), source, input.rulesText);
    logger.info('Source ignore rules updated.', {
      sourceId: source.sourceId,
      machineId: source.machineId,
      ignorePath: rulesDocument.ignorePath
    });
    return {
      ...rulesDocument,
      updatedAt: new Date().toISOString()
    };
  });

  handle('app:remove-source', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    if (!input || !input.machineId || !input.sourceId) {
      throw new Error('Source identity is required.');
    }

    const removed = await removeSource(getAppDataRoot(), {
      targetRoot,
      machineId: input.machineId,
      sourceId: input.sourceId,
      setId: input.setId
    });
    logger.info('Source removed from app list.', {
      targetRoot,
      machineId: input.machineId,
      sourceId: input.sourceId,
      sourcePath: removed?.sourcePath || null
    });
    logToRenderer('info', 'Source removed from app list.', {
      targetRoot,
      machineId: input.machineId,
      sourceId: input.sourceId
    });
    if (watchService) {
      await watchService.refresh();
      setDaemonStatus(await watchService.getStatus());
    }
    return buildDashboardState();
  });

  handle('app:pick-source-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Source Folder'
    });

    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  handle('app:pick-target-folder', async (_event, input) => {
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

  handle('app:run-backup', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const schema = await loadBackupSchema(getAppDataRoot());
    const resolved = resolveSourceForBackupRun(schema, input, targetRoot);
    const resolvedMachineId = resolved.source?.machineId || input.machineId;
    const resolvedTargetRoot = resolved.targetPath || targetRoot;
    if (resolved.fallback) {
      logger.warn('Backup source resolved via global source-id fallback.', {
        requestedTargetRoot: targetRoot,
        resolvedTargetRoot,
        requestedMachineId: input.machineId,
        resolvedMachineId,
        sourceId: input.sourceId
      });
    }
    const key = backupKey(targetRoot, input.machineId, input.sourceId);
    if (activeBackups.has(key)) {
      throw new Error('Backup already running for this source.');
    }

    const workerPools = await loadWorkerPoolsForBackup();

    logger.info('Backup requested.', {
      targetRoot: resolvedTargetRoot,
      machineId: resolvedMachineId,
      sourceId: input.sourceId,
      forceNewScan: Boolean(input.forceNewScan),
      workerPools
    });
    logToRenderer('info', 'Backup started.', {
      targetRoot: resolvedTargetRoot,
      sourceId: input.sourceId
    });
    activeBackupProgress.set(key, {
      targetRoot: resolvedTargetRoot,
      machineId: input.machineId,
      sourceId: input.sourceId,
      status: 'running'
    });
    const control = {
      pauseRequested: false,
      stopRequested: false
    };
    activeBackups.set(key, control);

    try {
      const summary = await backupSource(resolvedTargetRoot, resolvedMachineId, input.sourceId, {
        appDataRoot: getAppDataRoot(),
        forceNewScan: Boolean(input.forceNewScan),
        initialHashWorkers: workerPools.hash,
        maxHashWorkers: workerPools.hash,
        initialCopyWorkers: workerPools.copy,
        maxCopyWorkers: workerPools.copy,
        shouldPause: () => control.pauseRequested,
        shouldStop: () => control.stopRequested,
        onProgress: ({ summary: progressSummary, progress, event, trace }) => {
          const payload = {
            targetRoot: resolvedTargetRoot,
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
      } else if (summary.status === 'stopped') {
        logger.info('Backup stopped.', summary);
        logToRenderer('info', 'Backup stopped.', summary);
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

  handle('app:pause-backup', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const key = backupKey(targetRoot, input.machineId, input.sourceId);
    const backupControl = activeBackups.get(key);
    if (backupControl) {
      backupControl.pauseRequested = true;
      const activeProgress = activeBackupProgress.get(key);
      const queueSnapshot = activeProgress?.progress?.queues || null;
      logger.info('Backup pause requested.', {
        machineId: input.machineId,
        sourceId: input.sourceId,
        queues: queueSnapshot
      });
      logToRenderer('info', 'Pause requested. Cancelling queued files and stopping in-flight copy work...', {
        sourceId: input.sourceId,
        queues: queueSnapshot
      });
      return { accepted: true, mode: 'backup' };
    }

    const restoreControl = activeRestores.get(key);
    if (restoreControl) {
      restoreControl.pauseRequested = true;
      logger.info('Restore pause requested.', {
        machineId: input.machineId,
        sourceId: input.sourceId
      });
      logToRenderer('info', 'Restore pause requested.', {
        sourceId: input.sourceId
      });
      return { accepted: true, mode: 'restore' };
    }

    logger.warn('Pause ignored because no active backup or restore was found.', {
      machineId: input.machineId,
      sourceId: input.sourceId
    });
    return { accepted: false };
  });

  handle('app:stop-backup', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const key = backupKey(targetRoot, input.machineId, input.sourceId);
    const control = activeBackups.get(key);
    if (control) {
      control.stopRequested = true;
      control.pauseRequested = false;
      logger.info('Backup stop requested.', {
        machineId: input.machineId,
        sourceId: input.sourceId
      });
      logToRenderer('info', 'Backup stop requested.', {
        sourceId: input.sourceId
      });
      return { accepted: true, stoppedActive: true };
    }

    await clearBackupRunState(getAppDataRoot(), targetRoot, input.machineId, input.sourceId);
    logger.info('Paused backup job cleared.', {
      machineId: input.machineId,
      sourceId: input.sourceId
    });
    logToRenderer('info', 'Paused backup discarded.', {
      sourceId: input.sourceId
    });
    return {
      accepted: true,
      stoppedActive: false,
      dashboard: await buildDashboardState()
    };
  });

  handle('app:stop-restore', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const key = backupKey(targetRoot, input.machineId, input.sourceId);
    const control = activeRestores.get(key);
    if (control) {
      control.stopRequested = true;
      control.pauseRequested = false;
      logger.info('Restore stop requested.', {
        machineId: input.machineId,
        sourceId: input.sourceId
      });
      logToRenderer('info', 'Restore stop requested.', {
        sourceId: input.sourceId
      });
      return { accepted: true, stoppedActive: true };
    }

    await clearRestoreJob(getAppDataRoot(), input.sourceId);
    logger.info('Paused restore job cleared.', {
      machineId: input.machineId,
      sourceId: input.sourceId
    });
    logToRenderer('info', 'Paused restore discarded.', {
      sourceId: input.sourceId
    });
    return {
      accepted: true,
      stoppedActive: false,
      dashboard: await buildDashboardState()
    };
  });

  handle('app:restore-source', async (_event, input) => {
    const targetRoot = await requireTargetRoot(input);
    const key = backupKey(targetRoot, input.machineId, input.sourceId);
    if (activeBackups.has(key)) {
      throw new Error('Cannot start restore while backup is running for this source.');
    }
    if (activeRestores.has(key)) {
      throw new Error('Restore already running for this source.');
    }

    const schema = await ensureAppSchema();
    const targetSources = (schema.targets || []).find((entry) => (
      path.resolve(entry.path) === path.resolve(targetRoot)
    ));
    let source = (targetSources?.sources || []).find((entry) => (
      entry.sourceId === input.sourceId
      || entry.setId === input.sourceId
      || (input.setId && entry.setId === input.setId)
    )) || null;
    if (!source) {
      const catalog = await loadCatalog(targetRoot);
      const set = findSet(catalog, input.sourceId) || findSet(catalog, input.setId);
      if (set) {
        source = catalogSetToSource(set);
      }
    }
    if (!source) {
      throw new Error(`Source not found: ${input.machineId}/${input.sourceId}`);
    }

    const pausedJob = await loadRestoreJob(getAppDataRoot(), input.sourceId);
    const choice = await chooseRestoreDestination({
      source,
      input,
      pausedJob,
      pickDirectory: async ({ title, defaultPath }) => {
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory', 'createDirectory'],
          title,
          defaultPath
        });
        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }
        return result.filePaths[0];
      },
      askAppend: async ({ destinationRoot, sourceFolderName, defaultAppend }) => {
        const appendedPath = path.join(destinationRoot, sourceFolderName);
        const confirm = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['Restore', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          title: 'Restore',
          message: `Restore into ${destinationRoot}?`,
          detail: defaultAppend
            ? `Append on: files go into ${appendedPath}.`
            : `Append off: contents of the backup folder go into the chosen folder.\nOn: ${appendedPath}`,
          checkboxLabel: 'Append source folder name',
          checkboxChecked: Boolean(defaultAppend)
        });
        if (confirm.response !== 0) {
          return null;
        }
        return Boolean(confirm.checkboxChecked);
      }
    });
    if (!choice) {
      return null;
    }
    const { destinationRoot, appendFolder } = choice;

    const workerPools = await loadWorkerPoolsForBackup();
    logger.info('Source restore requested.', {
      targetRoot,
      machineId: input.machineId,
      sourceId: input.sourceId,
      destinationRoot,
      appendFolder,
      restoreWorkers: workerPools.copy
    });
    logToRenderer('info', 'Source restore started.', {
      targetRoot,
      sourceId: input.sourceId,
      destinationRoot,
      appendFolder
    });

    const control = {
      pauseRequested: false,
      stopRequested: false
    };
    activeRestores.set(key, control);

    try {
      const summary = await restoreSource(targetRoot, {
        appDataRoot: getAppDataRoot(),
        machineId: input.machineId,
        sourceId: input.sourceId,
        destinationRoot,
        appendFolder,
        forceNewRestore: Boolean(input.forceNewRestore),
        maxWorkers: workerPools.copy,
        shouldPause: () => control.pauseRequested,
        shouldStop: () => control.stopRequested,
        onProgress: ({ summary: progressSummary, progress, event }) => {
          const payload = {
            targetRoot,
            machineId: input.machineId,
            sourceId: input.sourceId,
            summary: progressSummary,
            progress,
            event,
            trace: {
              stage: 'restore-forwarding',
              sequence: progressSummary.restoredFiles
            }
          };
          activeBackupProgress.set(key, payload);
          sendProgressToRenderer(payload);
        }
      });
      activeBackupProgress.delete(key);
      if (summary.status === 'paused') {
        logger.info('Source restore paused.', summary);
        logToRenderer('info', 'Source restore paused.', summary);
      } else if (summary.status === 'stopped') {
        logger.info('Source restore stopped.', summary);
        logToRenderer('info', 'Source restore stopped.', summary);
      } else {
        logger.info('Source restore completed.', summary);
        logToRenderer(
          summary.message ? 'warn' : 'info',
          summary.message || 'Source restore completed.',
          summary
        );
        if (summary.offerNewSource) {
          const added = await maybeOfferAddRestoredSource({
            targetRoot,
            source,
            destinationRoot: summary.destinationRoot
          });
          summary.addedRestoredSource = Boolean(added);
        }
      }
      return {
        summary,
        dashboard: await buildDashboardState()
      };
    } catch (error) {
      const lastPayload = activeBackupProgress.get(key) || null;
      sendProgressToRenderer({
        targetRoot,
        machineId: input.machineId,
        sourceId: input.sourceId,
        summary: {
          machineId: input.machineId,
          sourceId: input.sourceId,
          destinationRoot,
          restoredFiles: lastPayload?.summary?.restoredFiles || 0,
          skippedRecords: 0,
          copiedBytes: lastPayload?.summary?.copiedBytes || 0,
          totalBytes: lastPayload?.summary?.totalBytes || 0,
          error: error.message
        },
        progress: {
          mode: 'restore',
          status: 'failed',
          startedAt: lastPayload?.progress?.startedAt || new Date().toISOString(),
          destinationRoot,
          filesProcessed: lastPayload?.progress?.filesProcessed || 0,
          filesCopied: lastPayload?.progress?.filesCopied || 0,
          copiedBytes: lastPayload?.progress?.copiedBytes || 0,
          totalBytes: lastPayload?.progress?.totalBytes || 0,
          throughputBytesPerSecond: 0,
          workers: lastPayload?.progress?.workers || {},
          queues: lastPayload?.progress?.queues || { file: { depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [] } }
        },
        event: {
          type: 'restore-failed',
          pool: 'file',
          message: error.message
        },
        trace: {
          stage: 'restore-forwarding',
          sequence: -1
        }
      });
      throw error;
    } finally {
      activeBackupProgress.delete(key);
      activeRestores.delete(key);
    }
  });

  handle('app:restore-merged', async (_event, input) => {
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

  handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (minimizeToTrayIfNeeded()) {
        return;
      }
      mainWindow.minimize();
    }
  });

  handle('window:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return false;
    }
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return mainWindow.isMaximized();
  });

  handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  handle('window:is-maximized', () => {
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized());
  });
}

function getLaunchWindowBounds() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return display.workArea;
}

function createWindow() {
  const launchBounds = getLaunchWindowBounds();
  mainWindow = new BrowserWindow({
    x: launchBounds.x,
    y: launchBounds.y,
    width: launchBounds.width,
    height: launchBounds.height,
    minWidth: 1120,
    minHeight: 720,
    frame: false,
    backgroundColor: '#eef1f5',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.on('maximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', true);
    }
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', false);
    }
  });

  mainWindow.on('minimize', (event) => {
    if (!daemonStatus.running) {
      return;
    }
    event.preventDefault();
    minimizeToTrayIfNeeded();
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
  setDaemonStatus(await watchService.getStatus());
  await watchService.start();
  setDaemonStatus(await watchService.getStatus());
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
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (watchService) {
    await watchService.stop();
    setDaemonStatus(await watchService.getStatus());
  }
});
