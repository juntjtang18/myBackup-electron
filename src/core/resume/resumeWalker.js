const fs = require('fs-extra');
const path = require('path');
const { createFolderHash, cursorMatchesFolder, normalizeRelativePath } = require('./resumeCursor');
const { createLogger } = require('../logger');

const logger = createLogger('FolderWalker', 'folderWalker.js');

function createFolderDescriptor(sourceRoot, relativePath) {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  return {
    folderHash: createFolderHash(normalizedRelativePath),
    relativePath: normalizedRelativePath,
    folderPath: normalizedRelativePath === '.'
      ? path.resolve(sourceRoot)
      : path.join(path.resolve(sourceRoot), ...normalizedRelativePath.split('/'))
  };
}

async function listChildDirectories(folder, ignoreMatcher = null) {
  const entries = await fs.readdir(folder.folderPath, { withFileTypes: true });
  const directories = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const relativePath = folder.relativePath === '.'
      ? entry.name
      : path.posix.join(folder.relativePath, entry.name);
    if (ignoreMatcher && ignoreMatcher.shouldIgnore(relativePath, true)) {
      continue;
    }
    directories.push({
      name: entry.name,
      relativePath,
      folderPath: path.join(folder.folderPath, entry.name)
    });
  }

  directories.sort((left, right) => left.name.localeCompare(right.name));
  return directories;
}

async function* walkFoldersFromCursor(sourceRoot, cursor = null, options = {}) {
  const startedAt = Date.now();
  const ignoreMatcher = options.ignoreMatcher || null;
  const includeCursor = cursor && cursor.status !== 'done';
  let cursorFound = !cursor;
  if (cursor) {
    logger.info('Built resume traversal stack from cursor.', {
      sourcePath: path.resolve(sourceRoot),
      cursorRelativePath: normalizeRelativePath(cursor.relativePath),
      cursorFolderHash: cursor.folderHash || null,
      cursorStatus: cursor.status || null,
      durationMs: Date.now() - startedAt
    });
  }

  async function* visit(folder) {
    const current = {
      folderHash: createFolderHash(folder.relativePath),
      relativePath: normalizeRelativePath(folder.relativePath),
      folderPath: folder.folderPath
    };
    let children = [];

    try {
      children = await listChildDirectories(current, ignoreMatcher);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }

    if (!cursorFound && cursorMatchesFolder(cursor, current)) {
      cursorFound = true;
      if (includeCursor) {
        yield current;
      }
    } else if (cursorFound) {
      yield current;
    }

    for (const child of children) {
      yield* visit({
        relativePath: child.relativePath,
        folderPath: child.folderPath
      });
    }
  }

  yield* visit(createFolderDescriptor(sourceRoot, '.'));
}

module.exports = {
  createFolderDescriptor,
  listChildDirectories,
  walkFoldersFromCursor
};
