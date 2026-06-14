const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { runStatePath } = require('./paths');
const { normalizeCursor } = require('./cursor/cursorState');
const { createScanId } = require('./ids');

const RUN_STATE_VERSION = 1;
const RUN_MODES = new Set(['full', 'incremental']);
const RUN_STATUSES = new Set(['idle', 'running', 'pausing', 'paused', 'completed', 'error']);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
}

function assertNullableString(value, fieldName) {
  if (value !== null && value !== undefined) {
    assertNonEmptyString(value, fieldName);
  }
}

function assertNullableNonNegativeInteger(value, fieldName) {
  if (value === null || value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer or null.`);
  }
}

function assertPendingFolders(value) {
  if (!Array.isArray(value)) {
    throw new Error('pendingFolders must be an array.');
  }
  for (const item of value) {
    assertNonEmptyString(item, 'pendingFolders[]');
  }
}

function normalizePendingFolders(value) {
  return Array.from(new Set((value || []).map((item) => String(item).trim()).filter(Boolean)));
}

function createRunState(targetId, sourceId, input = {}, now = new Date()) {
  assertNonEmptyString(targetId, 'targetId');
  assertNonEmptyString(sourceId, 'sourceId');

  const mode = input.mode || 'full';
  if (!RUN_MODES.has(mode)) {
    throw new Error(`Unsupported run mode: ${mode}`);
  }

  const status = input.status || 'idle';
  if (!RUN_STATUSES.has(status)) {
    throw new Error(`Unsupported run status: ${status}`);
  }

  return {
    version: RUN_STATE_VERSION,
    targetId,
    sourceId,
    runId: input.runId || createScanId(now),
    mode,
    status,
    scanSeq: Number.isInteger(input.scanSeq) ? input.scanSeq : null,
    copiedBytes: Number.isInteger(input.copiedBytes) && input.copiedBytes >= 0
      ? input.copiedBytes
      : 0,
    pendingFolders: normalizePendingFolders(input.pendingFolders),
    cursor: input.cursor ? normalizeCursor(input.cursor) : null,
    startedAt: input.startedAt || null,
    updatedAt: input.updatedAt || nowIso(now),
    completedAt: input.completedAt || null
  };
}

function validateRunState(document) {
  if (!document || typeof document !== 'object') {
    throw new Error('run state must be an object.');
  }
  if (document.version !== RUN_STATE_VERSION) {
    throw new Error(`Unsupported run state version: ${document.version}`);
  }
  assertNonEmptyString(document.targetId, 'targetId');
  assertNonEmptyString(document.sourceId, 'sourceId');
  assertNonEmptyString(document.runId, 'runId');
  if (!RUN_MODES.has(document.mode)) {
    throw new Error(`Unsupported run mode: ${document.mode}`);
  }
  if (!RUN_STATUSES.has(document.status)) {
    throw new Error(`Unsupported run status: ${document.status}`);
  }
  assertNullableNonNegativeInteger(document.scanSeq, 'scanSeq');
  assertNullableNonNegativeInteger(document.copiedBytes, 'copiedBytes');
  assertPendingFolders(document.pendingFolders);
  if (document.cursor !== null) {
    normalizeCursor(document.cursor);
  }
  assertNullableString(document.startedAt, 'startedAt');
  assertNonEmptyString(document.updatedAt, 'updatedAt');
  assertNullableString(document.completedAt, 'completedAt');
  return document;
}

async function loadRunState(appDataRoot, targetId, sourceId) {
  return readJsonIfExists(runStatePath(appDataRoot, targetId, sourceId), validateRunState);
}

async function saveRunState(appDataRoot, targetId, sourceId, state, now = new Date()) {
  const normalized = createRunState(targetId, sourceId, {
    ...state,
    targetId,
    sourceId,
    updatedAt: nowIso(now)
  }, now);
  await writeJsonAtomic(runStatePath(appDataRoot, targetId, sourceId), normalized);
  return normalized;
}

async function ensureRunState(appDataRoot, targetId, sourceId, now = new Date()) {
  const current = await loadRunState(appDataRoot, targetId, sourceId);
  if (current) {
    return current;
  }
  return saveRunState(appDataRoot, targetId, sourceId, createRunState(targetId, sourceId, {}, now), now);
}

module.exports = {
  RUN_MODES,
  RUN_STATE_VERSION,
  RUN_STATUSES,
  createRunState,
  ensureRunState,
  loadRunState,
  saveRunState,
  validateRunState
};
