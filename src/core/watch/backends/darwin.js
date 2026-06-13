const fs = require('fs');
const path = require('path');

function toEventPath(rootPath, fileName) {
  if (!fileName) {
    return rootPath;
  }
  return path.resolve(rootPath, String(fileName));
}

function createDarwinWatcherBackend(options = {}) {
  const watchers = new Map();
  const persistent = Boolean(options.persistent);

  async function sync(sources, handlers) {
    const nextKeys = new Set(sources.map((source) => source.watchKey));

    for (const [watchKey, watcher] of watchers.entries()) {
      if (!nextKeys.has(watchKey)) {
        watcher.close();
        watchers.delete(watchKey);
      }
    }

    for (const source of sources) {
      if (watchers.has(source.watchKey)) {
        continue;
      }

      try {
        const watcher = fs.watch(source.sourcePath, { recursive: true, persistent }, (_eventType, fileName) => {
          handlers.onEvent(source, {
            kind: 'fs',
            eventPath: toEventPath(source.sourcePath, fileName)
          });
        });
        watcher.on('error', (error) => handlers.onError(source, error));
        watchers.set(source.watchKey, watcher);
      } catch (error) {
        handlers.onError(source, error);
      }
    }
  }

  async function stop() {
    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
  }

  return {
    sync,
    stop
  };
}

module.exports = {
  createDarwinWatcherBackend
};
