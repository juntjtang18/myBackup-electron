const fs = require('fs-extra');
const path = require('path');
const {
  createMachineRecord,
  validateMachineRecord
} = require('./schema');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { targetsPath } = require('./paths');
const { createLogger } = require('./logger');

const TARGETS_LAYOUT_VERSION = 1;
const logger = createLogger('TargetsStore', 'targetsStore.js');

function nowIso(now = new Date()) {
  return now.toISOString();
}

function createTargetsDocument(input = {}, now = new Date()) {
  return {
    version: TARGETS_LAYOUT_VERSION,
    machine: input.machine ? createMachineRecord(input.machine, now) : createMachineRecord({}, now),
    targets: Array.isArray(input.targets)
      ? input.targets.map((target) => ({
          id: target.id,
          path: target.path,
          collapsed: Boolean(target.collapsed),
          addedAt: target.addedAt || nowIso(now)
        }))
      : [],
    updatedAt: input.updatedAt || nowIso(now)
  };
}

function validateTargetsDocument(document) {
  if (!document || typeof document !== 'object') {
    throw new Error('targets document must be an object.');
  }
  if (document.version !== TARGETS_LAYOUT_VERSION) {
    throw new Error(`Unsupported targets layout version: ${document.version}`);
  }
  if (!document.machine || typeof document.machine !== 'object') {
    throw new Error('targets document machine is required.');
  }
  validateMachineRecord(document.machine);
  if (!Array.isArray(document.targets)) {
    throw new Error('targets document targets must be an array.');
  }
  for (const target of document.targets) {
    if (!target || typeof target !== 'object') {
      throw new Error('target must be an object.');
    }
    if (typeof target.id !== 'string' || target.id.trim() === '') {
      throw new Error('target.id must be a non-empty string.');
    }
    if (typeof target.path !== 'string' || target.path.trim() === '') {
      throw new Error('target.path must be a non-empty string.');
    }
    if (typeof target.collapsed !== 'boolean') {
      throw new Error('target.collapsed must be a boolean.');
    }
  }
  return document;
}

class TargetsStore {
  constructor(appDataRoot) {
    this.appDataRoot = appDataRoot;
  }

  targetsBackupPath() {
    const primary = targetsPath(this.appDataRoot);
    return path.join(path.dirname(primary), `${path.basename(primary)}.bak`);
  }

  async exists() {
    return fs.pathExists(targetsPath(this.appDataRoot));
  }

  async loadFromPath(documentPath, now = new Date()) {
    const document = await readJsonIfExists(documentPath);
    if (!document) {
      return null;
    }
    return createTargetsDocument(validateTargetsDocument(document), now);
  }

  async load(now = new Date()) {
    const primaryPath = targetsPath(this.appDataRoot);
    const backupPath = this.targetsBackupPath();
    try {
      const primary = await this.loadFromPath(primaryPath, now);
      if (primary) {
        return primary;
      }
    } catch (error) {
      logger.error('Failed to load primary targets document.', {
        path: primaryPath,
        message: error.message
      });
    }

    try {
      const backup = await this.loadFromPath(backupPath, now);
      if (!backup) {
        return null;
      }
      logger.warn('Recovered targets document from backup.', {
        backupPath
      });
      await writeJsonAtomic(primaryPath, backup);
      return backup;
    } catch (error) {
      logger.error('Failed to load targets backup document.', {
        backupPath,
        message: error.message
      });
      throw error;
    }
  }

  async save(document, now = new Date()) {
    const primaryPath = targetsPath(this.appDataRoot);
    const backupPath = this.targetsBackupPath();
    const normalized = createTargetsDocument({
      ...document,
      updatedAt: nowIso(now)
    }, now);

    if (await fs.pathExists(primaryPath)) {
      await fs.ensureDir(path.dirname(backupPath));
      await fs.copy(primaryPath, backupPath, { overwrite: true });
    }
    await writeJsonAtomic(primaryPath, normalized);
    await writeJsonAtomic(backupPath, normalized);
    return normalized;
  }
}

module.exports = {
  TARGETS_LAYOUT_VERSION,
  TargetsStore,
  createTargetsDocument,
  validateTargetsDocument
};
