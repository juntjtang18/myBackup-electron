const { loadLegacyBackupScanState, saveLegacyBackupScanState } = require('./scanStateStore');
const { createCursor, hydrateCursor, normalizeCursor } = require('../cursor/cursorState');
const { walkFoldersFromCursor } = require('../scanner/folderWalker');

async function openCursorRun(targetRoot, machineId, sourceId, sourcePath, options = {}) {
  const appDataRoot = options.appDataRoot || targetRoot;
  const backupId = options.backupId || null;
  const scanState = await loadLegacyBackupScanState(appDataRoot, targetRoot, machineId, sourceId);
  const persistedCursor = (!options.forceNew
    && scanState
    && (!backupId || scanState.activeGeneration === backupId)
    && scanState.resumeCursor)
    ? normalizeCursor(scanState.resumeCursor)
    : null;

  return {
    backupId: backupId || scanState?.activeGeneration || null,
    cursor: hydrateCursor(sourcePath, persistedCursor),
    folders: walkFoldersFromCursor(sourcePath, persistedCursor, {
      ignoreMatcher: options.ignoreMatcher || null
    }),
    resumed: Boolean(persistedCursor)
  };
}

async function saveCursor(targetRoot, machineId, sourceId, backupId, cursor, options = {}) {
  const appDataRoot = options.appDataRoot || targetRoot;
  const now = options.now || new Date();
  const scanState = await loadLegacyBackupScanState(appDataRoot, targetRoot, machineId, sourceId);
  if (!scanState) {
    throw new Error(`Scan state not found: ${machineId}/${sourceId}`);
  }
  if (backupId && scanState.activeGeneration && scanState.activeGeneration !== backupId) {
    return scanState;
  }

  const nextScanState = {
    ...scanState,
    resumeCursor: cursor
      ? createCursor({
          ...cursor,
          scanId: cursor.scanId || backupId || scanState.activeGeneration,
          updatedAt: now
        }, now)
      : null,
    updatedAt: now.toISOString()
  };
  if (options.status && scanState.status !== 'completed') {
    nextScanState.status = options.status;
  }

  await saveLegacyBackupScanState(appDataRoot, targetRoot, machineId, sourceId, nextScanState, now);
  return nextScanState;
}

async function saveCursorFolder(targetRoot, machineId, sourceId, backupId, folder, options = {}) {
  return saveCursor(targetRoot, machineId, sourceId, backupId, {
    relativePath: folder.relativePath,
    folderHash: folder.folderHash
  }, options);
}

module.exports = {
  createCursor,
  hydrateCursor,
  normalizeCursor,
  openCursorRun,
  saveCursor,
  saveCursorFolder,
  walkFoldersFromCursor
};
