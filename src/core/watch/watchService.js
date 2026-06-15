const path = require('path');
const { loadBackupSchema } = require('../backupSchema');
const { ChangeTracker } = require('../changeTracking/ChangeTracker');
const { createLogger } = require('../logger');
const { updateSourceWatchState } = require('../sourceRegistry');
const { createDarwinWatcherBackend } = require('./backends/darwin');
const { createLinuxWatcherBackend } = require('./backends/linux');
const { createWindowsWatcherBackend } = require('./backends/windows');

const logger = createLogger('WatchService', 'watchService.js');

function normalizePlatform(platform) {
  const normalized = String(platform || process.platform).toLowerCase();
  if (normalized === 'darwin' || normalized === 'linux' || normalized === 'win32') {
    return normalized;
  }
  return process.platform;
}

function createBackend(platform, options = {}) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'darwin') {
    return createDarwinWatcherBackend(options);
  }
  if (normalized === 'linux') {
    return createLinuxWatcherBackend(options);
  }
  return createWindowsWatcherBackend(options);
}

function normalizeRelativeFolder(sourcePath, eventPath) {
  const sourceRoot = path.resolve(sourcePath);
  const resolvedEventPath = path.resolve(eventPath || sourceRoot);
  const relativeToSource = path.relative(sourceRoot, resolvedEventPath);

  if (!relativeToSource || relativeToSource === '') {
    return '.';
  }

  if (relativeToSource.startsWith('..') || path.isAbsolute(relativeToSource)) {
    return '.';
  }

  const parent = path.dirname(relativeToSource);
  if (!parent || parent === '.') {
    return '.';
  }
  return parent.split(path.sep).join('/');
}

function flattenWatchedSources(schema) {
  const watchedSources = [];

  for (const target of schema.targets || []) {
    for (const source of target.sources || []) {
      if (!source.watchEnabled) {
        continue;
      }
      watchedSources.push({
        targetId: target.id,
        targetPath: target.path,
        machineId: source.machineId,
        sourceId: source.sourceId,
        sourcePath: source.sourcePath,
        dirtyRef: source.watchState?.dirtyRef || `watch/${source.sourceId}.dirty.json`,
        watchKey: `${source.machineId}:${source.sourceId}:${source.sourcePath}`
      });
    }
  }

  return watchedSources;
}

function createWatchService(platformInput, options = {}) {
  const platform = normalizePlatform(platformInput);
  const appDataRoot = options.appDataRoot;
  const backend = options.backend || createBackend(platform, options.backendOptions || {});
  const scheduleDashboardRefresh = typeof options.onStateChanged === 'function'
    ? options.onStateChanged
    : async () => {};
  const changeTracker = options.changeTracker || new ChangeTracker(appDataRoot);

  let started = false;

  async function loadWatchedSources() {
    const schema = await loadBackupSchema(appDataRoot);
    return flattenWatchedSources(schema || { targets: [] });
  }

  async function persistDirtyEvent(source, eventPath, now = new Date()) {
    await changeTracker.recordFileChanged({
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      watchState: {
        dirtyRef: source.dirtyRef
      }
    }, eventPath, now);
    await updateSourceWatchState(
      appDataRoot,
      source.machineId,
      source.sourceId,
      (watchState) => ({
        ...watchState,
        lastEventAt: now.toISOString()
      }),
      now,
      { sourcePath: source.sourcePath }
    );
    await scheduleDashboardRefresh();
  }

  async function markSourceNeedsRescan(source, error, now = new Date()) {
    logger.warn('Source watch entered rescan-required state.', {
      machineId: source.machineId,
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      message: error ? error.message : 'watcher uncertainty'
    });
    await updateSourceWatchState(
      appDataRoot,
      source.machineId,
      source.sourceId,
      (watchState) => ({
        ...watchState,
        needsRescan: true,
        lastEventAt: now.toISOString()
      }),
      now,
      { sourcePath: source.sourcePath }
    );
    await scheduleDashboardRefresh();
  }

  async function sync() {
    const sources = await loadWatchedSources();
    for (const source of sources) {
      await changeTracker.ensureJournal({
        sourceId: source.sourceId,
        sourcePath: source.sourcePath,
        watchState: {
          dirtyRef: source.dirtyRef
        }
      });
    }

    await backend.sync(sources, {
      onEvent: async (source, event) => {
        try {
          await persistDirtyEvent(source, event.eventPath, new Date());
        } catch (error) {
          logger.warn('Failed to persist watched file event.', {
            machineId: source.machineId,
            sourceId: source.sourceId,
            sourcePath: source.sourcePath,
            message: error.message
          });
        }
      },
      onError: async (source, error) => {
        try {
          await markSourceNeedsRescan(source, error, new Date());
        } catch (innerError) {
          logger.warn('Failed to persist watcher error state.', {
            machineId: source.machineId,
            sourceId: source.sourceId,
            sourcePath: source.sourcePath,
            message: innerError.message
          });
        }
      }
    });

    return sources;
  }

  async function bootstrap() {
    return sync();
  }

  async function start() {
    started = true;
    return sync();
  }

  async function refresh() {
    if (!started) {
      return sync();
    }
    return sync();
  }

  async function stop() {
    started = false;
    await backend.stop();
  }

  return {
    bootstrap,
    refresh,
    start,
    stop
  };
}

module.exports = {
  createWatchService,
  createBackend,
  flattenWatchedSources,
  normalizePlatform,
  normalizeRelativeFolder
};
