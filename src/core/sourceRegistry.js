const fs = require('fs-extra');
const path = require('path');
const {
  listBackupTargets,
  loadBackupSource,
  registerBackupSource,
  removeBackupSource,
  updateBackupSource
} = require('./backupSchema');
const { createSourceRecord, validateSourceRecord } = require('./schema');
const { bindSourceToSet, findLocalSourceBySetId, removeSet } = require('./targetCatalog');
const { resolveSourceIgnorePath, writeSourceIgnoreFile } = require('./ignoreMatcher');
const { clearRestoreJob } = require('./restoreJobStore');
const { dirtyStatePath } = require('./paths');
const { createLogger } = require('./logger');

const logger = createLogger('SourceRegistry', 'sourceRegistry.js');

function sourcePathsEqual(leftPath, rightPath) {
  if (!leftPath || !rightPath) {
    return false;
  }
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

async function registerSource(appDataRoot, input, now = new Date()) {
  const targetRoot = input.targetRoot || appDataRoot;
  const candidate = createSourceRecord(input, now);
  const registered = await registerBackupSource(appDataRoot, {
    ...input,
    targetRoot,
    machineId: candidate.machineId,
    sourceId: candidate.sourceId
  }, now);

  validateSourceRecord(registered);
  return registered;
}

async function addSourceToTarget(appDataRoot, input, computer, now = new Date()) {
  if (!input || typeof input.rulesText !== 'string') {
    throw new Error('Exclude rules must be saved before adding a source.');
  }

  const source = await registerSource(appDataRoot, input, now);
  try {
    await writeSourceIgnoreFile(appDataRoot, source, input.rulesText);
    return await bindSourceToSet(appDataRoot, input.targetRoot, source, computer, now);
  } catch (error) {
    await removeSource(appDataRoot, {
      targetRoot: input.targetRoot,
      machineId: source.machineId,
      sourceId: source.sourceId,
      setId: source.setId || source.sourceId
    }).catch(() => {});
    throw error;
  }
}

async function updateSourceWatchState(appDataRoot, machineId, sourceId, updater, now = new Date(), options = {}) {
  const targets = await listBackupTargets(appDataRoot);
  const updates = [];

  for (const target of targets) {
    const matchesSource = (target.sources || []).some((source) => (
      source.machineId === machineId
      && source.sourceId === sourceId
      && (!options.sourcePath || sourcePathsEqual(source.sourcePath, options.sourcePath))
    ));
    if (!matchesSource) {
      continue;
    }

    const updated = await updateBackupSource(
      appDataRoot,
      target.path,
      machineId,
      sourceId,
      (current) => ({
        ...current,
        watchState: typeof updater === 'function'
          ? updater(current.watchState || {
            dirtyRef: `watch/${sourceId}.dirty.json`,
            needsRescan: false,
            lastEventAt: null
          }, current)
          : {
            ...(current.watchState || {
              dirtyRef: `watch/${sourceId}.dirty.json`,
              needsRescan: false,
              lastEventAt: null
            }),
            ...updater
          }
      }),
      now
    );
    updates.push(updated);
  }

  return updates;
}

async function cleanupSourceRegistrations(appDataRoot, source) {
  if (!appDataRoot || !source) {
    return;
  }

  const ignorePath = resolveSourceIgnorePath(appDataRoot, source);
  if (ignorePath) {
    await fs.remove(ignorePath).catch(() => {});
  }
  if (source.sourceId) {
    await clearRestoreJob(appDataRoot, source.sourceId).catch(() => {});
  }

  const dirtyRefs = [
    source.watchState?.dirtyRef,
    source.sourceId,
    source.setId
  ].filter(Boolean);
  for (const dirtyRef of new Set(dirtyRefs)) {
    try {
      await fs.remove(dirtyStatePath(appDataRoot, dirtyRef));
    } catch (_error) {
      // Sidecar cleanup must not block source delete.
    }
  }
}

async function removeSource(appDataRoot, input, now = new Date()) {
  const targetRoot = input.targetRoot || appDataRoot;
  let source = await loadBackupSource(appDataRoot, targetRoot, input.machineId, input.sourceId, now);
  if (!source && (input.setId || input.sourceId)) {
    source = await findLocalSourceBySetId(appDataRoot, targetRoot, input.setId || input.sourceId);
  }

  const setId = source?.setId || input.setId || input.sourceId || null;
  let removedSet = null;
  if (setId) {
    try {
      removedSet = await removeSet(targetRoot, setId, now);
    } catch (error) {
      logger.warn('Failed to remove catalog set while deleting source; continuing.', {
        targetRoot,
        setId,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  let removedSource = null;
  if (source) {
    removedSource = await removeBackupSource(
      appDataRoot,
      targetRoot,
      source.machineId,
      source.sourceId,
      now
    );
    await cleanupSourceRegistrations(appDataRoot, {
      ...source,
      setId: source.setId || setId
    });
  } else {
    await cleanupSourceRegistrations(appDataRoot, {
      machineId: input.machineId,
      sourceId: input.sourceId,
      setId
    });
  }

  if (!removedSource && !removedSet) {
    throw new Error(`Source not found: ${input.machineId}/${input.sourceId}`);
  }

  return removedSource || {
    sourceId: setId,
    setId,
    sourcePath: removedSet?.origin?.sourcePath || null,
    catalogOnly: true
  };
}

module.exports = {
  addSourceToTarget,
  cleanupSourceRegistrations,
  removeSource,
  registerSource,
  updateSourceWatchState
};
