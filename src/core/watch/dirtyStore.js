const { readJsonIfExists, writeJsonAtomic } = require('../jsonStore');
const { dirtyStatePath, toPosixPath } = require('../paths');

const DIRTY_STATE_VERSION = 1;

function nowIso(now = new Date()) {
  return now.toISOString();
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
}

function assertNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
  }
}

function normalizeDirtyFolderPath(relativePath) {
  const normalized = toPosixPath(relativePath || '.').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

function resolveDirtyDescriptor(sourceOrReference) {
  if (typeof sourceOrReference === 'string') {
    return {
      sourceId: sourceOrReference.endsWith('.json') ? null : sourceOrReference,
      dirtyRef: sourceOrReference.endsWith('.json')
        ? sourceOrReference
        : `watch/${sourceOrReference}.dirty.json`
    };
  }

  if (!sourceOrReference || typeof sourceOrReference !== 'object') {
    throw new Error('source or dirty reference is required.');
  }

  const sourceId = sourceOrReference.sourceId || null;
  const dirtyRef = sourceOrReference.watchState?.dirtyRef
    || sourceOrReference.dirtyRef
    || (sourceId ? `watch/${sourceId}.dirty.json` : null);

  if (!dirtyRef) {
    throw new Error('dirty state reference is required.');
  }

  return {
    sourceId,
    dirtyRef
  };
}

function createDirtyState(sourceOrReference, now = new Date(), overrides = {}) {
  const descriptor = resolveDirtyDescriptor(sourceOrReference);
  const sourceId = overrides.sourceId || descriptor.sourceId;
  if (!sourceId) {
    throw new Error('sourceId is required for dirty state creation.');
  }

  const folders = {};
  for (const [relativePath, entry] of Object.entries(overrides.folders || {})) {
    folders[normalizeDirtyFolderPath(relativePath)] = {
      seq: Number(entry.seq),
      changedAt: entry.changedAt || nowIso(now)
    };
  }

  return {
    version: DIRTY_STATE_VERSION,
    sourceId,
    lastEventSeq: Number.isInteger(overrides.lastEventSeq) ? overrides.lastEventSeq : 0,
    updatedAt: overrides.updatedAt || nowIso(now),
    folders
  };
}

function validateDirtyState(document) {
  if (!document || typeof document !== 'object') {
    throw new Error('dirty state must be an object.');
  }
  if (document.version !== DIRTY_STATE_VERSION) {
    throw new Error(`Unsupported dirty state version: ${document.version}`);
  }
  assertNonEmptyString(document.sourceId, 'sourceId');
  assertNonNegativeInteger(document.lastEventSeq, 'lastEventSeq');
  assertNonEmptyString(document.updatedAt, 'updatedAt');
  if (!document.folders || typeof document.folders !== 'object' || Array.isArray(document.folders)) {
    throw new Error('folders must be an object.');
  }
  for (const [relativePath, entry] of Object.entries(document.folders)) {
    assertNonEmptyString(relativePath, 'folders key');
    if (!entry || typeof entry !== 'object') {
      throw new Error(`folders.${relativePath} must be an object.`);
    }
    assertNonNegativeInteger(entry.seq, `folders.${relativePath}.seq`);
    assertNonEmptyString(entry.changedAt, `folders.${relativePath}.changedAt`);
  }
  return document;
}

async function loadDirtyState(appDataRoot, sourceOrReference) {
  const descriptor = resolveDirtyDescriptor(sourceOrReference);
  return readJsonIfExists(dirtyStatePath(appDataRoot, descriptor.dirtyRef), validateDirtyState);
}

async function saveDirtyState(appDataRoot, sourceOrReference, state, now = new Date()) {
  const descriptor = resolveDirtyDescriptor(sourceOrReference);
  const normalized = createDirtyState(sourceOrReference, now, {
    ...state,
    sourceId: state.sourceId || descriptor.sourceId,
    updatedAt: nowIso(now)
  });
  await writeJsonAtomic(dirtyStatePath(appDataRoot, descriptor.dirtyRef), normalized);
  return normalized;
}

async function ensureDirtyState(appDataRoot, sourceOrReference, now = new Date()) {
  const current = await loadDirtyState(appDataRoot, sourceOrReference);
  if (current) {
    return current;
  }
  return saveDirtyState(appDataRoot, sourceOrReference, createDirtyState(sourceOrReference, now), now);
}

async function markDirtyFolder(appDataRoot, sourceOrReference, relativePath, now = new Date()) {
  const current = await ensureDirtyState(appDataRoot, sourceOrReference, now);
  const nextSeq = current.lastEventSeq + 1;
  const folderPath = normalizeDirtyFolderPath(relativePath);
  return saveDirtyState(appDataRoot, sourceOrReference, {
    ...current,
    lastEventSeq: nextSeq,
    folders: {
      ...current.folders,
      [folderPath]: {
        seq: nextSeq,
        changedAt: nowIso(now)
      }
    }
  }, now);
}

async function snapshotDirtyState(appDataRoot, sourceOrReference, now = new Date()) {
  const current = await ensureDirtyState(appDataRoot, sourceOrReference, now);
  return {
    scanSeq: current.lastEventSeq,
    state: current
  };
}

async function clearDirtyFolderIfUnchanged(appDataRoot, sourceOrReference, relativePath, scanSeq, now = new Date()) {
  const current = await ensureDirtyState(appDataRoot, sourceOrReference, now);
  const folderPath = normalizeDirtyFolderPath(relativePath);
  const entry = current.folders[folderPath];
  if (!entry || entry.seq > scanSeq) {
    return current;
  }

  const nextFolders = { ...current.folders };
  delete nextFolders[folderPath];
  return saveDirtyState(appDataRoot, sourceOrReference, {
    ...current,
    folders: nextFolders
  }, now);
}

module.exports = {
  DIRTY_STATE_VERSION,
  clearDirtyFolderIfUnchanged,
  createDirtyState,
  ensureDirtyState,
  loadDirtyState,
  markDirtyFolder,
  normalizeDirtyFolderPath,
  resolveDirtyDescriptor,
  saveDirtyState,
  snapshotDirtyState,
  validateDirtyState
};
