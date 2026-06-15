const path = require('path');
const { ChangeJournal, normalizeFolderPath, normalizeFilePath } = require('./ChangeJournal');
const { ChangeJournalStore } = require('./ChangeJournalStore');

function resolveSourceRoot(source) {
  const sourceRoot = source?.sourcePath || source?.localPath || source?.path;
  if (!sourceRoot || typeof sourceRoot !== 'string') {
    throw new Error('source path is required.');
  }
  return path.resolve(sourceRoot);
}

function relativeToSource(source, absPath) {
  const sourceRoot = resolveSourceRoot(source);
  const resolvedPath = path.resolve(absPath || sourceRoot);
  const relativePath = path.relative(sourceRoot, resolvedPath);

  if (!relativePath || relativePath === '') {
    return '.';
  }

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return '.';
  }

  return relativePath.split(path.sep).join('/');
}

class ChangeTracker {
  constructor(appDataRoot) {
    this.store = new ChangeJournalStore(appDataRoot);
  }

  async ensureJournal(source, now = new Date()) {
    const journal = await this.store.ensure(source, now);
    return journal.toJSON();
  }

  async recordFileChanged(source, absPath, now = new Date()) {
    const journal = await this.store.ensure(source, now);
    const relativePath = relativeToSource(source, absPath);
    if (relativePath === '.') {
      journal.recordFolderChanged('.', now);
    } else {
      journal.recordFileChanged(normalizeFilePath(relativePath), now);
    }
    const saved = await this.store.save(source, journal, now);
    return saved.toJSON();
  }

  async recordFolderChanged(source, absPath, now = new Date()) {
    const journal = await this.store.ensure(source, now);
    const relativeFolderPath = normalizeFolderPath(relativeToSource(source, absPath));
    journal.recordFolderChanged(relativeFolderPath, now);
    const saved = await this.store.save(source, journal, now);
    return saved.toJSON();
  }

  async getChangeList(source, now = new Date()) {
    const journal = await this.store.ensure(source, now);
    return journal.getChangeList(source, now);
  }

  async clearChangeIfUnchanged(source, relativePath, scanSeq, now = new Date()) {
    const journal = await this.store.ensure(source, now);
    journal.clearFolderIfUnchanged(relativePath, scanSeq, now);
    const saved = await this.store.save(source, journal, now);
    return saved.toJSON();
  }

  async getRecentEvents(source, limit = 100) {
    const journal = await this.store.ensure(source);
    return journal.getRecentEvents(limit);
  }

  async clearAfterFullBackup(source, now = new Date()) {
    const journal = await this.store.ensure(source, now);
    journal.clearAfterFullBackup(now);
    const saved = await this.store.save(source, journal, now);
    return saved.toJSON();
  }
}

module.exports = {
  ChangeTracker,
  relativeToSource,
  resolveSourceRoot
};
