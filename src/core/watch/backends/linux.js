const fs = require('fs');
const path = require('path');

function normalizeEventPath(sourcePath, watchedDir, fileName) {
  if (!fileName) {
    return watchedDir || sourcePath;
  }
  return path.resolve(watchedDir || sourcePath, String(fileName));
}

function createLinuxWatcherBackend(options = {}) {
  const persistent = Boolean(options.persistent);
  const watchers = new Map();

  function closeUnused(nextDirs) {
    for (const [watchKey, watcherEntry] of watchers.entries()) {
      if (nextDirs.has(watchKey)) {
        continue;
      }
      watcherEntry.watcher.close();
      watchers.delete(watchKey);
    }
  }

  function ensureWatcher(source, dirPath, handlers) {
    const watchKey = `${source.watchKey}::${dirPath}`;
    if (watchers.has(watchKey)) {
      return;
    }

    try {
      const watcher = fs.watch(dirPath, { persistent }, (_eventType, fileName) => {
        handlers.onEvent(source, {
          kind: 'fs',
          eventPath: normalizeEventPath(source.sourcePath, dirPath, fileName)
        });
      });
      watcher.on('error', (error) => handlers.onError(source, error));
      watchers.set(watchKey, {
        watcher,
        sourcePath: source.sourcePath
      });
    } catch (error) {
      handlers.onError(source, error);
    }
  }

  async function collectDirs(rootPath) {
    const dirs = [path.resolve(rootPath)];
    const queue = [path.resolve(rootPath)];
    while (queue.length > 0) {
      const current = queue.shift();
      let entries;
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const child = path.join(current, entry.name);
        dirs.push(child);
        queue.push(child);
      }
    }
    return dirs;
  }

  async function sync(sources, handlers) {
    const nextWatchKeys = new Set();

    for (const source of sources) {
      const dirs = await collectDirs(source.sourcePath);
      for (const dirPath of dirs) {
        const watchKey = `${source.watchKey}::${dirPath}`;
        nextWatchKeys.add(watchKey);
        ensureWatcher(source, dirPath, handlers);
      }
    }

    closeUnused(nextWatchKeys);
  }

  async function stop() {
    for (const watcherEntry of watchers.values()) {
      watcherEntry.watcher.close();
    }
    watchers.clear();
  }

  return {
    sync,
    stop
  };
}

module.exports = {
  createLinuxWatcherBackend
};
