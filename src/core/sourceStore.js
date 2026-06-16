const fs = require('fs-extra');
const path = require('path');
const {
  createSourceDefinitionRecord,
  validateSourceDefinitionRecord
} = require('./schema');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { sourceDefinitionPath, sourcesRoot } = require('./paths');

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
      const document = await readJsonIfExists(path.join(root, entry.name));
      if (!document) {
        continue;
      }
      sources.push(createSourceDefinitionRecord(validateSourceDefinitionRecord(document), now));
    }
    sources.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    return sources;
  }

  async load(sourceId, now = new Date()) {
    const document = await readJsonIfExists(sourceDefinitionPath(this.appDataRoot, sourceId));
    if (!document) {
      return null;
    }
    return createSourceDefinitionRecord(validateSourceDefinitionRecord(document), now);
  }

  async save(source, now = new Date()) {
    const normalized = createSourceDefinitionRecord({
      ...source,
      updatedAt: source.updatedAt || now.toISOString()
    }, now);
    await fs.ensureDir(sourcesRoot(this.appDataRoot));
    await writeJsonAtomic(sourceDefinitionPath(this.appDataRoot, normalized.sourceId), normalized);
    return normalized;
  }

  async remove(sourceId) {
    await fs.remove(sourceDefinitionPath(this.appDataRoot, sourceId));
  }
}

module.exports = {
  SourceStore
};
