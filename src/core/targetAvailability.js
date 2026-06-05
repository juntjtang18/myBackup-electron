const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fse = require('fs-extra');
const { app, powerMonitor } = require('electron');
const { loadCurrentMachineContext } = require('./sourceCatalog');
const { createLogger } = require('./logger');

const execFileAsync = promisify(execFile);
const VOLUME_ROOT = '/Volumes';
const LINUX_MOUNT_ROOTS = ['/media', '/mnt'];
const logger = createLogger('TargetAvailability', 'targetAvailability.js');

function normalizePlatform(platform) {
  const normalized = String(platform || process.platform).toLowerCase();
  if (normalized === 'darwin' || normalized === 'win32' || normalized === 'linux') {
    return normalized;
  }

  return process.platform;
}

function normalizeWindowsDriveRoot(root) {
  const parsed = path.win32.parse(String(root || ''));
  if (!parsed.root) {
    return null;
  }

  const drive = parsed.root.slice(0, 1).toUpperCase();
  return `${drive}:\\`;
}

function extractMountedVolumeName(targetPath, platform = process.platform) {
  if (normalizePlatform(platform) !== 'darwin') {
    return null;
  }

  const resolvedPath = path.resolve(targetPath);
  const relativePath = path.relative(VOLUME_ROOT, resolvedPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  const [volumeName] = relativePath.split(path.sep);
  return volumeName || null;
}

function extractMountedMountPath(targetPath, platform = process.platform) {
  const normalizedPlatform = normalizePlatform(platform);
  const resolvedPath = path.resolve(targetPath);

  if (normalizedPlatform === 'darwin') {
    const volumeName = extractMountedVolumeName(resolvedPath, normalizedPlatform);
    return volumeName ? path.join(VOLUME_ROOT, volumeName) : null;
  }

  if (normalizedPlatform === 'linux') {
    for (const mountRoot of LINUX_MOUNT_ROOTS) {
      const relativePath = path.relative(mountRoot, resolvedPath);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        continue;
      }

      const [mountName] = relativePath.split(path.sep);
      if (mountName) {
        return path.join(mountRoot, mountName);
      }
    }
    return null;
  }

  if (normalizedPlatform === 'win32') {
    return normalizeWindowsDriveRoot(resolvedPath);
  }

  return null;
}

function checkTargetAvailability(targetPath, mountedRoots = new Set(), platform = process.platform) {
  const normalizedPlatform = normalizePlatform(platform);
  const mountPath = extractMountedMountPath(targetPath, normalizedPlatform);
  if (!mountPath) {
    return {
      available: true,
      unavailableReason: null,
      mountPath: null
    };
  }

  const normalizedMountPath = normalizedPlatform === 'win32'
    ? normalizeWindowsDriveRoot(mountPath)
    : mountPath;
  const available = mountedRoots.has(normalizedMountPath);
  return {
    available,
    unavailableReason: available ? null : `Backup volume is not mounted: ${normalizedMountPath}`,
    mountPath: normalizedMountPath
  };
}

function mapSourceDashboardEntry(source) {
  return {
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
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCurrentMachineContextWithReviveRetry(targetPath, platformLabel, availability) {
  const maxAttempts = 5;
  let context = await loadCurrentMachineContext(targetPath);
  for (let attempt = 1; attempt < maxAttempts && (context.sources || []).length === 0 && availability.mountPath; attempt += 1) {
    logger.info(`${platformLabel} target revived; retrying source context load.`, {
      targetRoot: targetPath,
      mountPath: availability.mountPath,
      attempt,
      maxAttempts
    });
    await sleep(150 * attempt);
    const retryContext = await loadCurrentMachineContext(targetPath);
    if ((retryContext.sources || []).length > 0 || (!context.machine && retryContext.machine)) {
      context = retryContext;
    }
  }

  if ((context.sources || []).length === 0 && availability.mountPath) {
    logger.warn(`${platformLabel} target revived but no sources were loaded.`, {
      targetRoot: targetPath,
      mountPath: availability.mountPath,
      loadedMachine: Boolean(context.machine)
    });
  }
  logger.info(`${platformLabel} target context loaded.`, {
    targetRoot: targetPath,
    sourceCount: (context.sources || []).length
  });
  return context;
}

async function createAvailableTargetDashboardEntry(target, platform, mountedRoots, platformLabel) {
  const availability = checkTargetAvailability(target.path, mountedRoots, platform);
  if (!availability.available) {
    return {
      id: target.id,
      path: target.path,
      collapsed: target.collapsed,
      addedAt: target.addedAt,
      available: false,
      unavailableReason: availability.unavailableReason,
      machine: null,
      sources: []
    };
  }

  try {
    const context = await loadCurrentMachineContextWithReviveRetry(target.path, platformLabel, availability);
    return {
      id: target.id,
      path: target.path,
      collapsed: target.collapsed,
      addedAt: target.addedAt,
      available: true,
      unavailableReason: null,
      machine: context.machine,
      sources: (context.sources || []).map(mapSourceDashboardEntry)
    };
  } catch (error) {
    return {
      id: target.id,
      path: target.path,
      collapsed: target.collapsed,
      addedAt: target.addedAt,
      available: true,
      unavailableReason: null,
      machine: null,
      sources: [],
      contextError: error.message
    };
  }
}

async function readMountedRootsDarwin() {
  try {
    const entries = await fse.readdir(VOLUME_ROOT, { withFileTypes: true });
    const roots = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(VOLUME_ROOT, entry.name)));
    logger.debug('Read mounted roots on macOS.', {
      volumeRoot: VOLUME_ROOT,
      mountedRoots: Array.from(roots)
    });
    return roots;
  } catch (error) {
    logger.warn('Failed to read mounted roots on macOS.', {
      volumeRoot: VOLUME_ROOT,
      message: error.message
    });
    return new Set();
  }
}

async function readMountedRootsLinux() {
  const mountedRoots = new Set();
  for (const mountRoot of LINUX_MOUNT_ROOTS) {
    try {
      const entries = await fse.readdir(mountRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          mountedRoots.add(path.join(mountRoot, entry.name));
        }
      }
    } catch (error) {
      // Ignore mount roots that are not present.
    }
  }
  logger.debug('Read mounted roots on Linux.', {
    mountRoots: LINUX_MOUNT_ROOTS,
    mountedRoots: Array.from(mountedRoots)
  });
  return mountedRoots;
}

async function readMountedRootsWindows() {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-Volume | Where-Object DriveLetter | ForEach-Object { "$($_.DriveLetter):\\" }'
      ],
      { windowsHide: true }
    );

    return new Set(
      String(stdout || '')
        .split(/\r?\n/)
        .map((entry) => normalizeWindowsDriveRoot(entry.trim()))
        .filter(Boolean)
    );
  } catch (error) {
    logger.warn('Failed to read mounted roots on Windows.', {
      message: error.message
    });
    return new Set();
  }
}

function createDarwinTargetAvailabilityMonitor(options = {}) {
  const mountedRoots = new Set();
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  let watcher = null;
  let refreshTimer = null;
  let bootstrapped = false;

  async function refreshMountedRoots() {
    const nextMountedRoots = await readMountedRootsDarwin();
    const changed = bootstrapped
      ? nextMountedRoots.size !== mountedRoots.size
        || Array.from(nextMountedRoots).some((root) => !mountedRoots.has(root))
      : true;

    logger.info('Refreshing macOS mounted roots.', {
      bootstrapped,
      changed,
      previousMountedRoots: Array.from(mountedRoots),
      nextMountedRoots: Array.from(nextMountedRoots)
    });

    mountedRoots.clear();
    for (const root of nextMountedRoots) {
      mountedRoots.add(root);
    }
    bootstrapped = true;
    return changed;
  }

  async function refreshAndNotify() {
    const changed = await refreshMountedRoots();
    if (changed && onChange) {
      logger.info('macOS mount set changed; refreshing dashboard.');
      await onChange();
      logger.info('macOS mount set change processed.');
    } else {
      logger.debug('macOS mount refresh completed without change.');
    }
    return changed;
  }

  function scheduleRefresh() {
    if (refreshTimer) {
      return;
    }

    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      try {
        logger.info('macOS mount watcher fired; scheduling refresh.');
        await refreshAndNotify();
      } catch (error) {
        logger.warn('macOS mount watcher refresh failed.', {
          message: error.message
        });
      }
    }, 150);
  }

  function start() {
    if (watcher) {
      return;
    }

    try {
      logger.info('Starting macOS mount watcher.', {
        volumeRoot: VOLUME_ROOT
      });
      watcher = fs.watch(VOLUME_ROOT, { persistent: false }, scheduleRefresh);
      watcher.on('error', (error) => {
        logger.warn('macOS mount watcher error.', {
          message: error.message
        });
      });
    } catch (error) {
      logger.warn('Failed to start macOS mount watcher.', {
        volumeRoot: VOLUME_ROOT,
        message: error.message
      });
      watcher = null;
    }
  }

  function stop() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    if (watcher) {
      watcher.close();
      watcher = null;
    }
  }

  async function bootstrap() {
    await refreshMountedRoots();
  }

  async function buildTargetDashboardEntry(target) {
    return createAvailableTargetDashboardEntry(target, 'darwin', mountedRoots, 'macOS');
  }

  return {
    bootstrap,
    buildTargetDashboardEntry,
    checkTargetAvailability: (targetPath) => checkTargetAvailability(targetPath, mountedRoots, 'darwin'),
    getMountedRoots: () => new Set(mountedRoots),
    platform: 'darwin',
    refreshAndNotify,
    start,
    stop
  };
}

function createLinuxTargetAvailabilityMonitor(options = {}) {
  const mountedRoots = new Set();
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const watchers = [];
  let refreshTimer = null;
  let bootstrapped = false;

  async function refreshMountedRoots() {
    const nextMountedRoots = await readMountedRootsLinux();
    const changed = bootstrapped
      ? nextMountedRoots.size !== mountedRoots.size
        || Array.from(nextMountedRoots).some((root) => !mountedRoots.has(root))
      : true;

    logger.info('Refreshing Linux mounted roots.', {
      bootstrapped,
      changed,
      previousMountedRoots: Array.from(mountedRoots),
      nextMountedRoots: Array.from(nextMountedRoots)
    });

    mountedRoots.clear();
    for (const root of nextMountedRoots) {
      mountedRoots.add(root);
    }
    bootstrapped = true;
    return changed;
  }

  async function refreshAndNotify() {
    const changed = await refreshMountedRoots();
    if (changed && onChange) {
      logger.info('Linux mount set changed; refreshing dashboard.');
      await onChange();
      logger.info('Linux mount set change processed.');
    } else {
      logger.debug('Linux mount refresh completed without change.');
    }
    return changed;
  }

  function scheduleRefresh() {
    if (refreshTimer) {
      return;
    }

    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      try {
        logger.info('Linux mount watcher fired; scheduling refresh.');
        await refreshAndNotify();
      } catch (error) {
        logger.warn('Linux mount watcher refresh failed.', {
          message: error.message
        });
      }
    }, 150);
  }

  function start() {
    if (watchers.length > 0) {
      return;
    }

    for (const watchRoot of LINUX_MOUNT_ROOTS) {
      try {
        logger.info('Starting Linux mount watcher.', {
          watchRoot
        });
        const watcher = fs.watch(watchRoot, { persistent: false }, scheduleRefresh);
        watcher.on('error', (error) => {
          logger.warn('Linux mount watcher error.', {
            watchRoot,
            message: error.message
          });
        });
        watchers.push(watcher);
      } catch (error) {
        logger.warn('Failed to start Linux mount watcher.', {
          watchRoot,
          message: error.message
        });
        // Ignore roots that are not watchable on this machine.
      }
    }
  }

  function stop() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    for (const watcher of watchers) {
      watcher.close();
    }
    watchers.length = 0;
  }

  async function bootstrap() {
    await refreshMountedRoots();
  }

  async function buildTargetDashboardEntry(target) {
    return createAvailableTargetDashboardEntry(target, 'linux', mountedRoots, 'Linux');
  }

  return {
    bootstrap,
    buildTargetDashboardEntry,
    checkTargetAvailability: (targetPath) => checkTargetAvailability(targetPath, mountedRoots, 'linux'),
    getMountedRoots: () => new Set(mountedRoots),
    platform: 'linux',
    refreshAndNotify,
    start,
    stop
  };
}

function createWindowsTargetAvailabilityMonitor(options = {}) {
  const mountedRoots = new Set();
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const windowFocusHandlers = new Map();
  let browserWindowCreatedHandler = null;
  let resumeHandler = null;
  let unlockScreenHandler = null;
  let refreshTimer = null;
  let bootstrapped = false;

  async function refreshMountedRoots() {
    const nextMountedRoots = await readMountedRootsWindows();
    const changed = bootstrapped
      ? nextMountedRoots.size !== mountedRoots.size
        || Array.from(nextMountedRoots).some((root) => !mountedRoots.has(root))
      : true;

    logger.debug('Refreshing Windows mounted roots.', {
      bootstrapped,
      changed,
      previousMountedRoots: Array.from(mountedRoots),
      nextMountedRoots: Array.from(nextMountedRoots)
    });

    mountedRoots.clear();
    for (const root of nextMountedRoots) {
      mountedRoots.add(root);
    }
    bootstrapped = true;
    return changed;
  }

  async function refreshAndNotify() {
    const changed = await refreshMountedRoots();
    if (changed && onChange) {
      logger.info('Windows mount set changed; refreshing dashboard.');
      await onChange();
    } else {
      logger.debug('Windows mount refresh completed without change.');
    }
    return changed;
  }

  function scheduleRefresh() {
    if (refreshTimer) {
      return;
    }

    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      try {
        logger.info('Windows activation event fired; scheduling refresh.');
        await refreshAndNotify();
      } catch (error) {
        // Ignore transient mount watcher errors.
      }
    }, 150);
  }

  function start() {
    if (browserWindowCreatedHandler || resumeHandler || unlockScreenHandler) {
      return;
    }

    logger.info('Starting Windows mount monitor.');
    browserWindowCreatedHandler = (_event, window) => {
      const focusHandler = () => scheduleRefresh();
      window.on('focus', focusHandler);
      windowFocusHandlers.set(window, focusHandler);
    };
    resumeHandler = () => scheduleRefresh();
    unlockScreenHandler = () => scheduleRefresh();

    app.on('browser-window-created', browserWindowCreatedHandler);
    powerMonitor.on('resume', resumeHandler);
    powerMonitor.on('unlock-screen', unlockScreenHandler);
  }

  function stop() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    for (const [window, focusHandler] of windowFocusHandlers.entries()) {
      try {
        window.removeListener('focus', focusHandler);
      } catch (error) {
        // Ignore stale windows.
      }
    }
    windowFocusHandlers.clear();

    if (browserWindowCreatedHandler) {
      app.removeListener('browser-window-created', browserWindowCreatedHandler);
      browserWindowCreatedHandler = null;
    }
    if (resumeHandler) {
      powerMonitor.removeListener('resume', resumeHandler);
      resumeHandler = null;
    }
    if (unlockScreenHandler) {
      powerMonitor.removeListener('unlock-screen', unlockScreenHandler);
      unlockScreenHandler = null;
    }
  }

    async function bootstrap() {
    await refreshMountedRoots();
  }

  async function buildTargetDashboardEntry(target) {
    return createAvailableTargetDashboardEntry(target, 'win32', mountedRoots, 'Windows');
  }

  return {
    bootstrap,
    buildTargetDashboardEntry,
    checkTargetAvailability: (targetPath) => checkTargetAvailability(targetPath, mountedRoots, 'win32'),
    getMountedRoots: () => new Set(mountedRoots),
    platform: 'win32',
    refreshAndNotify,
    start,
    stop
  };
}

function createTargetAvailabilityMonitor(platformInput, options = {}) {
  const platform = normalizePlatform(platformInput);
  if (platform === 'darwin') {
    return createDarwinTargetAvailabilityMonitor(options);
  }
  if (platform === 'linux') {
    return createLinuxTargetAvailabilityMonitor(options);
  }
  if (platform === 'win32') {
    return createWindowsTargetAvailabilityMonitor(options);
  }

  return createDarwinTargetAvailabilityMonitor(options);
}

async function buildTargetDashboardEntry(target, platform = process.platform, mountedRoots = new Set()) {
  const platformLabel = normalizePlatform(platform) === 'darwin'
    ? 'macOS'
    : (normalizePlatform(platform) === 'linux' ? 'Linux' : 'Windows');
  return createAvailableTargetDashboardEntry(target, platform, mountedRoots, platformLabel);
}

module.exports = {
  VOLUME_ROOT,
  checkTargetAvailability,
  createDarwinTargetAvailabilityMonitor,
  createLinuxTargetAvailabilityMonitor,
  createTargetAvailabilityMonitor,
  createWindowsTargetAvailabilityMonitor,
  extractMountedMountPath,
  extractMountedVolumeName,
  normalizePlatform,
  normalizeWindowsDriveRoot,
  readMountedRootsDarwin,
  readMountedRootsLinux,
  readMountedRootsWindows,
  buildTargetDashboardEntry
};
