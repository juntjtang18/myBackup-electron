const fs = require('fs-extra');
const path = require('path');
const {
  createSourceStatusRecord,
  validateSourceStatusRecord
} = require('./schema');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { sourceStatusPath, statusRoot } = require('./paths');
const { createLogger } = require('./logger');

const logger = createLogger('SourceStatusStore', 'sourceStatusStore.js');

function statusBackupPath(appDataRoot, sourceId) {
  return `${sourceStatusPath(appDataRoot, sourceId)}.bak`;
}

class SourceStatusStore {
  constructor(appDataRoot) {
    this.appDataRoot = appDataRoot;
  }

  async load(sourceId, now = new Date()) {
    const filePath = sourceStatusPath(this.appDataRoot, sourceId);
    try {
      const document = await readJsonIfExists(filePath);
      if (!document) {
        return null;
      }
      return createSourceStatusRecord(validateSourceStatusRecord(document), now);
    } catch (error) {
      const backupPath = statusBackupPath(this.appDataRoot, sourceId);
      logger.error('Failed to load source status; trying backup.', {
        sourceId,
        filePath,
        message: error.message
      });
      const backupDocument = await readJsonIfExists(backupPath);
      if (!backupDocument) {
        throw error;
      }
      const recovered = createSourceStatusRecord(validateSourceStatusRecord(backupDocument), now);
      await writeJsonAtomic(filePath, recovered);
      return recovered;
    }
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
    const filePath = sourceStatusPath(this.appDataRoot, normalized.sourceId);
    const backupPath = statusBackupPath(this.appDataRoot, normalized.sourceId);
    if (await fs.pathExists(filePath)) {
      await fs.copy(filePath, backupPath, { overwrite: true });
    }
    await writeJsonAtomic(filePath, normalized);
    await writeJsonAtomic(backupPath, normalized);
    return normalized;
  }

  async remove(sourceId) {
    const statusPath = sourceStatusPath(this.appDataRoot, sourceId);
    if (!(await fs.pathExists(statusPath))) {
      return;
    }
    const deletedRoot = path.join(statusRoot(this.appDataRoot), '.deleted');
    await fs.ensureDir(deletedRoot);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivedPath = path.join(deletedRoot, `${sourceId}.${stamp}.json`);
    await fs.move(statusPath, archivedPath, { overwrite: false });
  }
}

module.exports = {
  SourceStatusStore
};
