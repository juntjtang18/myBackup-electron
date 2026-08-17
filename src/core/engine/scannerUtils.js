const fs = require('fs-extra');
const path = require('path');
const { isBackupCardRelativePath } = require('../backupCard');
const { isTargetMetadataRelativePath } = require('../paths');
const { createLogger } = require('../logger');

const logger = createLogger('ScannerUtils', 'scannerUtils.js');

function isMissingPathError(error) {
  return Boolean(error && error.code === 'ENOENT');
}

async function safeCallback(name, fn, ...args) {
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    return await fn(...args);
  } catch (error) {
    logger.warn('Scan callback failed; continuing.', {
      callback: name,
      code: error && error.code ? error.code : null,
      error: error && error.message ? error.message : String(error)
    });
    return undefined;
  }
}

async function scanFolderFiles(options) {
  const files = options.files || [];
  const extraFields = options.extraFields || {};
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false;
  const enqueueFile = typeof options.enqueueFile === 'function' ? options.enqueueFile : async () => {};
  const onFileError = options.onFileError;
  const folderTasks = [];
  let filesEnqueued = 0;
  let skippedFiles = 0;

  for (const fileEntry of files) {
    if (shouldAbort()) {
      break;
    }

    try {
      const stats = await statFile(fileEntry.path);
      folderTasks.push(
        Promise.resolve()
          .then(() => enqueueFile({
            sourceFilePath: fileEntry.path,
            sourceRelativePath: fileEntry.relativePath,
            stats,
            ...extraFields
          }))
          .catch(async (error) => {
            skippedFiles += 1;
            await safeCallback('onFileError', onFileError, fileEntry, error);
          })
      );
      filesEnqueued += 1;
    } catch (error) {
      skippedFiles += 1;
      logger.warn('Skipped file during scan; continuing.', {
        sourceRelativePath: fileEntry.relativePath,
        code: error && error.code ? error.code : null,
        error: error && error.message ? error.message : String(error)
      });
      await safeCallback('onFileError', onFileError, fileEntry, error);
    }
  }

  await Promise.allSettled(folderTasks);
  return { filesEnqueued, skippedFiles };
}

async function readFolderEntries(folderPath, relativeRoot = '.', ignoreMatcher = null) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const files = [];
  const directories = [];

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    const relativePath = relativeRoot === '.'
      ? entry.name
      : path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      if (isTargetMetadataRelativePath(relativePath)) {
        continue;
      }
      if (ignoreMatcher && ignoreMatcher.shouldIgnore(relativePath, true)) {
        continue;
      }
      directories.push({ name: entry.name, path: fullPath, relativePath });
    } else if (entry.isSymbolicLink() || entry.isFile()) {
      if (relativePath === '.mbignore' || isBackupCardRelativePath(relativePath)) {
        continue;
      }
      if (ignoreMatcher && ignoreMatcher.shouldIgnore(relativePath, false)) {
        continue;
      }
      files.push({
        name: entry.name,
        path: fullPath,
        relativePath,
        isSymbolicLink: entry.isSymbolicLink()
      });
    }
  }

  directories.sort((left, right) => left.name.localeCompare(right.name));
  files.sort((left, right) => left.name.localeCompare(right.name));
  return { directories, files };
}

async function statFile(filePath) {
  return fs.lstat(filePath);
}

function isIgnoredInventoryPath(relativePath, ignoreMatcher) {
  if (isTargetMetadataRelativePath(relativePath)) {
    return true;
  }
  if (relativePath === '.mbignore' || isBackupCardRelativePath(relativePath)) {
    return true;
  }
  if (!ignoreMatcher) {
    return false;
  }
  if (ignoreMatcher.shouldIgnore(relativePath, false)) {
    return true;
  }
  const parts = relativePath.split('/').filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    const directoryPath = parts.slice(0, index + 1).join('/');
    if (ignoreMatcher.shouldIgnore(directoryPath, true)) {
      return true;
    }
  }
  return false;
}

async function inventorySourceTree(sourcePath, ignoreMatcher = null) {
  const summary = {
    totalFiles: 0,
    totalBytes: 0,
    ignoredFiles: 0,
    ignoredBytes: 0
  };

  async function visit(dirPath, relativeRoot) {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      logger.warn('Skipped inventory directory; continuing.', {
        dirPath,
        relativeRoot,
        code: error && error.code ? error.code : null,
        error: error && error.message ? error.message : String(error)
      });
      return;
    }

    for (const entry of entries) {
      const relativePath = relativeRoot === '.'
        ? entry.name
        : path.posix.join(relativeRoot, entry.name);
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (isTargetMetadataRelativePath(relativePath)) {
          continue;
        }
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      let stat;
      try {
        stat = await fs.lstat(absolutePath);
      } catch (error) {
        logger.warn('Skipped inventory file; continuing.', {
          relativePath,
          code: error && error.code ? error.code : null,
          error: error && error.message ? error.message : String(error)
        });
        continue;
      }
      const size = Number(stat.size || 0);
      summary.totalFiles += 1;
      summary.totalBytes += size;
      if (isIgnoredInventoryPath(relativePath, ignoreMatcher)) {
        summary.ignoredFiles += 1;
        summary.ignoredBytes += size;
      }
    }
  }

  if (await fs.pathExists(sourcePath)) {
    await visit(path.resolve(sourcePath), '.');
  }
  return summary;
}

module.exports = {
  inventorySourceTree,
  isIgnoredInventoryPath,
  isMissingPathError,
  readFolderEntries,
  safeCallback,
  scanFolderFiles,
  statFile
};
