const { ChangeTracker } = require('../changeTracking/ChangeTracker');
const {
  ChangeJournal,
  CHANGE_JOURNAL_VERSION,
  normalizeFolderPath
} = require('../changeTracking/ChangeJournal');
const { resolveJournalDescriptor } = require('../changeTracking/ChangeJournalStore');

const DIRTY_STATE_VERSION = CHANGE_JOURNAL_VERSION;

function normalizeDirtyFolderPath(relativePath) {
  return normalizeFolderPath(relativePath);
}

function createDirtyState(sourceOrReference, now = new Date(), overrides = {}) {
  const descriptor = resolveJournalDescriptor(sourceOrReference);
  if (!descriptor.sourceId && !overrides.sourceId) {
    throw new Error('sourceId is required for dirty state creation.');
  }

  const journal = ChangeJournal.fromDocument({
    version: DIRTY_STATE_VERSION,
    sourceId: overrides.sourceId || descriptor.sourceId,
    lastEventSeq: Number.isInteger(overrides.lastEventSeq) ? overrides.lastEventSeq : 0,
    updatedAt: overrides.updatedAt || now.toISOString(),
    folders: overrides.folders || {}
  }, now);
  return journal.toJSON();
}

function validateDirtyState(document) {
  return ChangeJournal.fromDocument(document).toJSON();
}

async function loadDirtyState(appDataRoot, sourceOrReference, now = new Date()) {
  const tracker = new ChangeTracker(appDataRoot);
  const journal = await tracker.store.load(sourceOrReference, now);
  return journal ? journal.toJSON() : null;
}

async function saveDirtyState(appDataRoot, sourceOrReference, state, now = new Date()) {
  const tracker = new ChangeTracker(appDataRoot);
  const journal = ChangeJournal.fromDocument(state, now);
  const saved = await tracker.store.save(sourceOrReference, journal, now);
  return saved.toJSON();
}

async function ensureDirtyState(appDataRoot, sourceOrReference, now = new Date()) {
  const tracker = new ChangeTracker(appDataRoot);
  return tracker.ensureJournal(sourceOrReference, now);
}

async function markDirtyFolder(appDataRoot, sourceOrReference, relativePath, now = new Date()) {
  const tracker = new ChangeTracker(appDataRoot);
  const journal = await tracker.store.ensure(sourceOrReference, now);
  journal.recordFolderChanged(relativePath, now);
  const saved = await tracker.store.save(sourceOrReference, journal, now);
  return saved.toJSON();
}

async function snapshotDirtyState(appDataRoot, sourceOrReference, now = new Date()) {
  const tracker = new ChangeTracker(appDataRoot);
  const changeList = await tracker.getChangeList(sourceOrReference, now);
  return {
    scanSeq: changeList.scanSeq,
    state: changeList.legacyDirtyState
  };
}

async function clearDirtyFolderIfUnchanged(appDataRoot, sourceOrReference, relativePath, scanSeq, now = new Date()) {
  const tracker = new ChangeTracker(appDataRoot);
  return tracker.clearChangeIfUnchanged(sourceOrReference, relativePath, scanSeq, now);
}

module.exports = {
  DIRTY_STATE_VERSION,
  clearDirtyFolderIfUnchanged,
  createDirtyState,
  ensureDirtyState,
  loadDirtyState,
  markDirtyFolder,
  normalizeDirtyFolderPath,
  resolveDirtyDescriptor: resolveJournalDescriptor,
  saveDirtyState,
  snapshotDirtyState,
  validateDirtyState
};
