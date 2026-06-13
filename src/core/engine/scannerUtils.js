const fs = require('fs-extra');
const path = require('path');

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
    } else if (entry.isFile()) {
      if (relativePath === '.mbignore') {
        continue;
      }
      if (ignoreMatcher && ignoreMatcher.shouldIgnore(relativePath, false)) {
        continue;
      }
      files.push({ name: entry.name, path: fullPath, relativePath });
    }
  }

  directories.sort((left, right) => left.name.localeCompare(right.name));
  files.sort((left, right) => left.name.localeCompare(right.name));
  return { directories, files };
}

async function statFile(filePath) {
  return fs.stat(filePath);
}

module.exports = {
  isMissingPathError,
  readFolderEntries,
  statFile
};
