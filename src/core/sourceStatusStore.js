const fs = require('fs-extra');
const {
  createSourceStatusRecord,
  validateSourceStatusRecord
} = require('./schema');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { sourceStatusPath, statusRoot } = require('./paths');

class SourceStatusStore {
  constructor(appDataRoot) {
    this.appDataRoot = appDataRoot;
  }

  async load(sourceId, now = new Date()) {
    const document = await readJsonIfExists(sourceStatusPath(this.appDataRoot, sourceId));
    if (!document) {
      return null;
    }
    return createSourceStatusRecord(validateSourceStatusRecord(document), now);
  }

  async ensure(sourceId, now = new Date()) {
    const existing = await this.load(sourceId, now);
    if (existing) {
      return existing;
    }
    const created = createSourceStatusRecord({ sourceId }, now);
    await this.save(created, now);
    return created;
  }

  async save(statusRecord, now = new Date()) {
    const normalized = createSourceStatusRecord({
      ...statusRecord,
      updatedAt: statusRecord.updatedAt || now.toISOString()
    }, now);
    await fs.ensureDir(statusRoot(this.appDataRoot));
    await writeJsonAtomic(sourceStatusPath(this.appDataRoot, normalized.sourceId), normalized);
    return normalized;
  }

  async remove(sourceId) {
    await fs.remove(sourceStatusPath(this.appDataRoot, sourceId));
  }
}

module.exports = {
  SourceStatusStore
};
