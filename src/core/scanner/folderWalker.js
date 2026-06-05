const fs = require('fs-extra');
const path = require('path');
const { createFolderId } = require('../ids');
const { createLogger } = require('../logger');

const logger = createLogger('FolderWalker', 'folderWalker.js');

async function readChildFolders(folderPath, relativePath, ignoreMatcher = null) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const childFolders = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childRelativePath = relativePath === '.'
      ? entry.name
      : path.posix.join(relativePath, entry.name);
    if (ignoreMatcher && ignoreMatcher.shouldIgnore(childRelativePath, true)) {
      continue;
    }

    childFolders.push({
      name: entry.name,
      path: path.join(folderPath, entry.name),
      relativePath: childRelativePath
    });
  }

  childFolders.sort((left, right) => left.name.localeCompare(right.name));
  return childFolders;
}

async function collectTraversal(folderPath, relativePath, ignoreMatcher, stack) {
  stack.push({
    folderId: createFolderId(relativePath),
    folderPath,
    relativePath
  });

  const childFolders = await readChildFolders(folderPath, relativePath, ignoreMatcher);
  for (const childFolder of childFolders) {
    await collectTraversal(childFolder.path, childFolder.relativePath, ignoreMatcher, stack);
  }
}

async function buildFolderTraversalStack(sourcePath, ignoreMatcher = null, cursor = null) {
  const startedAt = Date.now();
  const allFolders = [];
  await collectTraversal(sourcePath, '.', ignoreMatcher, allFolders);

  if (!cursor) {
    logger.info('Built folder traversal stack.', {
      sourcePath,
      folderCount: allFolders.length,
      cursorRelativePath: null,
      durationMs: Date.now() - startedAt
    });
    return allFolders;
  }

  const cursorIndex = allFolders.findIndex((entry) => entry.relativePath === cursor.relativePath
    && (!cursor.folderHash || entry.folderId === cursor.folderHash));

  if (cursorIndex < 0) {
    logger.warn('Resume cursor not found while rebuilding folder traversal stack.', {
      sourcePath,
      cursorRelativePath: cursor.relativePath,
      cursorFolderHash: cursor.folderHash,
      folderCount: allFolders.length,
      durationMs: Date.now() - startedAt
    });
    return allFolders;
  }

  const stack = allFolders.slice(cursorIndex + 1);
  logger.info('Built resume traversal stack from cursor.', {
    sourcePath,
    folderCount: allFolders.length,
    cursorRelativePath: cursor.relativePath,
    cursorFolderHash: cursor.folderHash,
    resumeFolderCount: stack.length,
    durationMs: Date.now() - startedAt
  });
  return stack;
}

module.exports = {
  buildFolderTraversalStack
};
