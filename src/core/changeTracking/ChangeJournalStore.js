const { readJsonIfExists, writeJsonAtomic } = require('../jsonStore');
const { dirtyStatePath } = require('../paths');
const { ChangeJournal } = require('./ChangeJournal');

function resolveJournalDescriptor(sourceOrReference) {
  if (typeof sourceOrReference === 'string') {
    return {
      sourceId: sourceOrReference.endsWith('.json') ? null : sourceOrReference,
      dirtyRef: sourceOrReference.endsWith('.json')
        ? sourceOrReference
        : `watch/${sourceOrReference}.dirty.json`
    };
  }

  if (!sourceOrReference || typeof sourceOrReference !== 'object') {
    throw new Error('source or journal reference is required.');
  }

  const sourceId = sourceOrReference.sourceId || null;
  const dirtyRef = sourceOrReference.watchState?.dirtyRef
    || sourceOrReference.dirtyRef
    || (sourceId ? `watch/${sourceId}.dirty.json` : null);

  if (!dirtyRef) {
    throw new Error('change journal reference is required.');
  }

  return {
    sourceId,
    dirtyRef
  };
}

class ChangeJournalStore {
  constructor(appDataRoot) {
    this.appDataRoot = appDataRoot;
  }

  journalPath(sourceOrReference) {
    const descriptor = resolveJournalDescriptor(sourceOrReference);
    return dirtyStatePath(this.appDataRoot, descriptor.dirtyRef);
  }

  async load(sourceOrReference, now = new Date()) {
    const document = await readJsonIfExists(this.journalPath(sourceOrReference));
    return document ? ChangeJournal.fromDocument(document, now) : null;
  }

  async save(sourceOrReference, journal, now = new Date()) {
    const descriptor = resolveJournalDescriptor(sourceOrReference);
    const normalized = journal instanceof ChangeJournal
      ? ChangeJournal.fromDocument(journal.toJSON(), now)
      : ChangeJournal.fromDocument(journal, now);
    const json = normalized.toJSON();
    if (!json.sourceId && descriptor.sourceId) {
      json.sourceId = descriptor.sourceId;
    }
    await writeJsonAtomic(this.journalPath(sourceOrReference), json);
    return normalized;
  }

  async ensure(sourceOrReference, now = new Date()) {
    const existing = await this.load(sourceOrReference, now);
    if (existing) {
      return existing;
    }

    const descriptor = resolveJournalDescriptor(sourceOrReference);
    if (!descriptor.sourceId) {
      throw new Error('sourceId is required for change journal creation.');
    }
    const journal = ChangeJournal.createEmpty(descriptor.sourceId, now);
    await this.save(sourceOrReference, journal, now);
    return journal;
  }
}

module.exports = {
  ChangeJournalStore,
  resolveJournalDescriptor
};
