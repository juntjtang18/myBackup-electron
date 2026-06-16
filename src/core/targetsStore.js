const fs = require('fs-extra');
const {
  createMachineRecord,
  validateMachineRecord
} = require('./schema');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { targetsPath } = require('./paths');

const TARGETS_LAYOUT_VERSION = 1;

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

  async exists() {
    return fs.pathExists(targetsPath(this.appDataRoot));
  }

  async load(now = new Date()) {
    const document = await readJsonIfExists(targetsPath(this.appDataRoot));
    if (!document) {
      return null;
    }
    return createTargetsDocument(validateTargetsDocument(document), now);
  }

  async save(document, now = new Date()) {
    const normalized = createTargetsDocument({
      ...document,
      updatedAt: nowIso(now)
    }, now);
    await writeJsonAtomic(targetsPath(this.appDataRoot), normalized);
    return normalized;
  }
}

module.exports = {
  TARGETS_LAYOUT_VERSION,
  TargetsStore,
  createTargetsDocument,
  validateTargetsDocument
};
