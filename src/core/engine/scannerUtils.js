const fs = require('fs-extra');
const path = require('path');
const { isBackupCardRelativePath } = require('../backupCard');

function isMissingPathError(error) {
  return Boolean(error && error.code === 'ENOENT');
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
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const relativePath = relativeRoot === '.'
        ? entry.name
        : path.posix.join(relativeRoot, entry.name);
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      const stat = await fs.lstat(absolutePath);
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
  statFile
};
