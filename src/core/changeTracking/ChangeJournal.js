const path = require('path');
const { toPosixPath } = require('../paths');

const CHANGE_JOURNAL_VERSION = 2;

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

function normalizeFolderPath(relativePath) {
  const normalized = toPosixPath(relativePath || '.')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

function normalizeFilePath(relativePath) {
  const normalized = toPosixPath(relativePath || '')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized || normalized === '.') {
    throw new Error('relative file path is required.');
  }
  return normalized;
}

function parentFolderOf(relativeFilePath) {
  const normalized = normalizeFilePath(relativeFilePath);
  const parent = path.posix.dirname(normalized);
  return !parent || parent === '.' ? '.' : parent;
}

function parentOfFolder(relativeFolderPath) {
  const normalized = normalizeFolderPath(relativeFolderPath);
  if (normalized === '.') {
    return '.';
  }
  const parent = path.posix.dirname(normalized);
  return !parent || parent === '.' ? '.' : parent;
}

class ChangeJournal {
  constructor(document) {
    this.document = document;
  }

  static createEmpty(sourceId, now = new Date()) {
    assertNonEmptyString(sourceId, 'sourceId');
    return new ChangeJournal({
      version: CHANGE_JOURNAL_VERSION,
      sourceId,
      lastEventSeq: 0,
      updatedAt: nowIso(now),
      folders: {},
      events: []
    });
  }

  static fromDocument(document, now = new Date()) {
    if (!document || typeof document !== 'object') {
      throw new Error('change journal must be an object.');
    }

    if (document.version === 1) {
      assertNonEmptyString(document.sourceId, 'sourceId');
      assertNonNegativeInteger(document.lastEventSeq, 'lastEventSeq');
      const folders = {};
      for (const [relativePath, entry] of Object.entries(document.folders || {})) {
        const normalizedPath = normalizeFolderPath(relativePath);
        folders[normalizedPath] = {
          seq: Number(entry.seq),
          changedAt: entry.changedAt || nowIso(now),
          eventCount: Number.isInteger(entry.eventCount) && entry.eventCount >= 0 ? entry.eventCount : 0
        };
      }
      return new ChangeJournal({
        version: CHANGE_JOURNAL_VERSION,
        sourceId: document.sourceId,
        lastEventSeq: document.lastEventSeq,
        updatedAt: document.updatedAt || nowIso(now),
        folders,
        events: []
      });
    }

    if (document.version !== CHANGE_JOURNAL_VERSION) {
      throw new Error(`Unsupported change journal version: ${document.version}`);
    }

    assertNonEmptyString(document.sourceId, 'sourceId');
    assertNonNegativeInteger(document.lastEventSeq, 'lastEventSeq');
    assertNonEmptyString(document.updatedAt, 'updatedAt');
    if (!document.folders || typeof document.folders !== 'object' || Array.isArray(document.folders)) {
      throw new Error('folders must be an object.');
    }

    const folders = {};
    for (const [relativePath, entry] of Object.entries(document.folders)) {
      const normalizedPath = normalizeFolderPath(relativePath);
      if (!entry || typeof entry !== 'object') {
        throw new Error(`folders.${normalizedPath} must be an object.`);
      }
      assertNonNegativeInteger(entry.seq, `folders.${normalizedPath}.seq`);
      assertNonEmptyString(entry.changedAt, `folders.${normalizedPath}.changedAt`);
      folders[normalizedPath] = {
        seq: entry.seq,
        changedAt: entry.changedAt,
        eventCount: Number.isInteger(entry.eventCount) && entry.eventCount >= 0 ? entry.eventCount : 0
      };
    }

    const events = Array.isArray(document.events) ? document.events.map((event, index) => {
      if (!event || typeof event !== 'object') {
        throw new Error(`events.${index} must be an object.`);
      }
      assertNonNegativeInteger(event.seq, `events.${index}.seq`);
      assertNonEmptyString(event.at, `events.${index}.at`);
      assertNonEmptyString(event.relPath, `events.${index}.relPath`);
      assertNonEmptyString(event.parentRelPath, `events.${index}.parentRelPath`);
      assertNonEmptyString(event.kind, `events.${index}.kind`);
      assertNonEmptyString(event.action, `events.${index}.action`);
      return {
        seq: event.seq,
        at: event.at,
        relPath: event.kind === 'folder'
          ? normalizeFolderPath(event.relPath)
          : normalizeFilePath(event.relPath),
        parentRelPath: normalizeFolderPath(event.parentRelPath),
        kind: event.kind,
        action: event.action
      };
    }) : [];

    return new ChangeJournal({
      version: CHANGE_JOURNAL_VERSION,
      sourceId: document.sourceId,
      lastEventSeq: document.lastEventSeq,
      updatedAt: document.updatedAt,
      folders,
      events
    });
  }

  toJSON() {
    return {
      version: CHANGE_JOURNAL_VERSION,
      sourceId: this.document.sourceId,
      lastEventSeq: this.document.lastEventSeq,
      updatedAt: this.document.updatedAt,
      folders: { ...this.document.folders },
      events: Array.isArray(this.document.events) ? this.document.events.slice() : []
    };
  }

  touchFolder(relativeFolderPath, now = new Date()) {
    const normalizedPath = normalizeFolderPath(relativeFolderPath);
    const nextSeq = this.document.lastEventSeq + 1;
    const current = this.document.folders[normalizedPath];
    this.document.lastEventSeq = nextSeq;
    this.document.updatedAt = nowIso(now);
    this.document.folders[normalizedPath] = {
      seq: nextSeq,
      changedAt: nowIso(now),
      eventCount: (current?.eventCount || 0) + 1
    };
    return nextSeq;
  }

  recordFileChanged(relativeFilePath, now = new Date()) {
    const normalizedFilePath = normalizeFilePath(relativeFilePath);
    const parentRelPath = parentFolderOf(normalizedFilePath);
    const seq = this.touchFolder(parentRelPath, now);
    this.document.events.push({
      seq,
      at: nowIso(now),
      relPath: normalizedFilePath,
      parentRelPath,
      kind: 'file',
      action: 'changed'
    });
    return this.toJSON();
  }

  recordFolderChanged(relativeFolderPath, now = new Date()) {
    const normalizedFolderPath = normalizeFolderPath(relativeFolderPath);
    const seq = this.touchFolder(normalizedFolderPath, now);
    this.document.events.push({
      seq,
      at: nowIso(now),
      relPath: normalizedFolderPath,
      parentRelPath: parentOfFolder(normalizedFolderPath),
      kind: 'folder',
      action: 'changed'
    });
    return this.toJSON();
  }

  clearFolderIfUnchanged(relativeFolderPath, scanSeq, now = new Date()) {
    assertNonNegativeInteger(scanSeq, 'scanSeq');
    const normalizedPath = normalizeFolderPath(relativeFolderPath);
    const current = this.document.folders[normalizedPath];
    if (!current || current.seq > scanSeq) {
      return this.toJSON();
    }
    delete this.document.folders[normalizedPath];
    this.document.updatedAt = nowIso(now);
    return this.toJSON();
  }

  clearAfterFullBackup(now = new Date()) {
    this.document.folders = {};
    this.document.events = [];
    this.document.updatedAt = nowIso(now);
    return this.toJSON();
  }

  getChangeList(source, now = new Date()) {
    const items = Object.entries(this.document.folders || {})
      .map(([relativePath, entry]) => ({
        relativePath,
        kind: 'folder',
        seq: entry.seq,
        changedAt: entry.changedAt,
        eventCount: entry.eventCount || 0
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    return {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath || source.localPath || source.path || null,
      scanSeq: this.document.lastEventSeq,
      generatedAt: nowIso(now),
      listType: 'changed-folders',
      items,
      legacyDirtyState: {
        version: 1,
        sourceId: this.document.sourceId,
        lastEventSeq: this.document.lastEventSeq,
        updatedAt: this.document.updatedAt,
        folders: items.reduce((accumulator, item) => {
          accumulator[item.relativePath] = {
            seq: item.seq,
            changedAt: item.changedAt
          };
          return accumulator;
        }, {})
      }
    };
  }

  getRecentEvents(limit = 100) {
    const max = Math.max(0, Number(limit || 0));
    return this.document.events
      .slice()
      .sort((left, right) => right.seq - left.seq)
      .slice(0, max);
  }
}

module.exports = {
  CHANGE_JOURNAL_VERSION,
  ChangeJournal,
  normalizeFilePath,
  normalizeFolderPath,
  nowIso,
  parentFolderOf
};
