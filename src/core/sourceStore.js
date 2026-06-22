const fs = require('fs-extra');
const path = require('path');
const {
  createSourceDefinitionRecord,
  validateSourceDefinitionRecord
} = require('./schema');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { sourceDefinitionPath, sourcesRoot } = require('./paths');
const { createLogger } = require('./logger');

const logger = createLogger('SourceStore', 'sourceStore.js');

function sourceBackupPath(appDataRoot, sourceId) {
  return `${sourceDefinitionPath(appDataRoot, sourceId)}.bak`;
}

class SourceStore {
  constructor(appDataRoot) {
    this.appDataRoot = appDataRoot;
  }

  async list(now = new Date()) {
    const root = sourcesRoot(this.appDataRoot);
    if (!(await fs.pathExists(root))) {
      return [];
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    const sources = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const sourcePath = path.join(root, entry.name);
      try {
        const document = await readJsonIfExists(sourcePath);
        if (!document) {
          continue;
        }
        sources.push(createSourceDefinitionRecord(validateSourceDefinitionRecord(document), now));
      } catch (error) {
        const backupPath = `${sourcePath}.bak`;
        logger.error('Failed to load source definition; trying backup.', {
          sourcePath,
          message: error.message
        });
        const backupDocument = await readJsonIfExists(backupPath);
        if (!backupDocument) {
          continue;
        }
        const recovered = createSourceDefinitionRecord(validateSourceDefinitionRecord(backupDocument), now);
        sources.push(recovered);
        await writeJsonAtomic(sourcePath, recovered);
      }
    }
    sources.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    return sources;
  }

  async load(sourceId, now = new Date()) {
    const sourcePath = sourceDefinitionPath(this.appDataRoot, sourceId);
    try {
      const document = await readJsonIfExists(sourcePath);
      if (!document) {
        return null;
      }
      return createSourceDefinitionRecord(validateSourceDefinitionRecord(document), now);
    } catch (error) {
      const backupPath = sourceBackupPath(this.appDataRoot, sourceId);
      logger.error('Failed to load source definition; trying backup.', {
        sourceId,
        sourcePath,
        message: error.message
      });
      const backupDocument = await readJsonIfExists(backupPath);
      if (!backupDocument) {
        throw error;
      }
      const recovered = createSourceDefinitionRecord(validateSourceDefinitionRecord(backupDocument), now);
      await writeJsonAtomic(sourcePath, recovered);
      return recovered;
    }
  }

  async save(source, now = new Date()) {
    const normalized = createSourceDefinitionRecord({
      ...source,
      updatedAt: source.updatedAt || now.toISOString()
    }, now);
    await fs.ensureDir(sourcesRoot(this.appDataRoot));
    const filePath = sourceDefinitionPath(this.appDataRoot, normalized.sourceId);
    const backupPath = sourceBackupPath(this.appDataRoot, normalized.sourceId);
    if (await fs.pathExists(filePath)) {
      await fs.copy(filePath, backupPath, { overwrite: true });
    }
    await writeJsonAtomic(filePath, normalized);
    await writeJsonAtomic(backupPath, normalized);
    return normalized;
  }

  async remove(sourceId) {
    const sourcePath = sourceDefinitionPath(this.appDataRoot, sourceId);
    if (!(await fs.pathExists(sourcePath))) {
      return;
    }
    const deletedRoot = path.join(sourcesRoot(this.appDataRoot), '.deleted');
    await fs.ensureDir(deletedRoot);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivedPath = path.join(deletedRoot, `${sourceId}.${stamp}.json`);
    await fs.move(sourcePath, archivedPath, { overwrite: false });
  }
}

module.exports = {
  SourceStore
};
