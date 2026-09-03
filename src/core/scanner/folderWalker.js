const fs = require('fs-extra');
const path = require('path');
const { createFolderHash, cursorMatchesFolder, normalizeRelativePath } = require('../cursor/cursorState');
const { isTargetMetadataRelativePath } = require('../paths');
const { createLogger } = require('../logger');

const logger = createLogger('FolderWalker', 'folderWalker.js');

function createFolderDescriptor(sourceRoot, relativePath) {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  return {
    folderHash: createFolderHash(normalizedRelativePath),
    folderId: createFolderHash(normalizedRelativePath),
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
    if (isTargetMetadataRelativePath(relativePath)) {
      continue;
    }
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
  let cursorFound = !cursor;

  if (cursor) {
    logger.info('Built resume traversal stack from cursor.', {
      sourcePath: path.resolve(sourceRoot),
      cursorRelativePath: normalizeRelativePath(cursor.relativePath),
      cursorFolderHash: cursor.folderHash || null,
      durationMs: Date.now() - startedAt
    });
  }

  async function* visit(folder) {
    const current = {
      folderHash: createFolderHash(folder.relativePath),
      folderId: createFolderHash(folder.relativePath),
      relativePath: normalizeRelativePath(folder.relativePath),
      folderPath: folder.folderPath
    };

    let children = [];
    try {
      children = await listChildDirectories(current, ignoreMatcher);
    } catch (error) {
      logger.warn('Skipped folder listing; continuing traversal.', {
        folderPath: current.folderPath,
        relativePath: current.relativePath,
        code: error && error.code ? error.code : null,
        error: error && error.message ? error.message : String(error)
      });
    }

    if (!cursorFound && cursorMatchesFolder(cursor, current)) {
      cursorFound = true;
      yield current;
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

  if (cursor && !cursorFound) {
    logger.warn('Resume cursor was not found; scanning the full source tree.', {
      sourcePath: path.resolve(sourceRoot),
      cursorRelativePath: normalizeRelativePath(cursor.relativePath),
      cursorFolderHash: cursor.folderHash || null
    });
    cursorFound = true;
    yield* visit(createFolderDescriptor(sourceRoot, '.'));
  }
}

async function buildFolderTraversalStack(sourcePath, ignoreMatcher = null, cursor = null) {
  const stack = [];
  for await (const folder of walkFoldersFromCursor(sourcePath, cursor, { ignoreMatcher })) {
    stack.push(folder);
  }
  if (!cursor) {
    logger.info('Built folder traversal stack.', {
      sourcePath: path.resolve(sourcePath),
      folderCount: stack.length,
      cursorRelativePath: null
    });
  }
  return stack;
}

module.exports = {
  buildFolderTraversalStack,
  createFolderDescriptor,
  listChildDirectories,
  walkFoldersFromCursor
};
