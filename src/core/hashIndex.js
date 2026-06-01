const { loadHashRecord, saveHashRecord } = require('./metadataStore');
const { createHashRecord } = require('./schema');
const { toPosixPath } = require('./layout');

function hasOrigin(record, origin) {
  return record.origins.some((entry) => (
    entry.machineId === origin.machineId &&
    entry.sourceId === origin.sourceId &&
    entry.sourceRelativePath === toPosixPath(origin.sourceRelativePath || '')
  ));
}

function hasLogicalPath(record, logicalPath) {
  const normalizedPath = toPosixPath(logicalPath || '');
  return record.logicalPath === normalizedPath || record.aliases.includes(normalizedPath);
}

async function registerHashRecord(targetRoot, input, now = new Date()) {
  const normalizedOrigin = {
    machineId: input.origin.machineId,
    sourceId: input.origin.sourceId,
    sourceRelativePath: toPosixPath(input.origin.sourceRelativePath || ''),
    discoveredAt: input.origin.discoveredAt || now.toISOString()
  };
  const normalizedLogicalPath = toPosixPath(input.logicalPath || '');
  const existing = await loadHashRecord(targetRoot, input.fileHash);

  if (!existing) {
    const created = createHashRecord({
      fileHash: input.fileHash,
      size: input.size,
      logicalPath: normalizedLogicalPath,
      aliases: [],
      kind: input.kind || 'file',
      content: input.content,
      origins: [normalizedOrigin]
    }, now);

    await saveHashRecord(targetRoot, created);
    return {
      record: created,
      status: 'created'
    };
  }

  const aliases = [...existing.aliases];
  const origins = [...existing.origins];
  let changed = false;
  let pathStatus = 'existing-path';
  let originStatus = 'existing-origin';

  if (normalizedLogicalPath && !hasLogicalPath(existing, normalizedLogicalPath)) {
    aliases.push(normalizedLogicalPath);
    aliases.sort();
    changed = true;
    pathStatus = 'alias-added';
  }

  if (!hasOrigin(existing, normalizedOrigin)) {
    origins.push(normalizedOrigin);
    changed = true;
    originStatus = 'origin-added';
  }

  if (!changed) {
    return {
      record: existing,
      status: 'unchanged',
      pathStatus,
      originStatus
    };
  }

  const updated = createHashRecord({
    ...existing,
    aliases,
    origins,
    updatedAt: now.toISOString()
  }, now);

  await saveHashRecord(targetRoot, updated);
  return {
    record: updated,
    status: 'updated',
    pathStatus,
    originStatus
  };
}

async function lookupHashRecord(targetRoot, fileHash) {
  return loadHashRecord(targetRoot, fileHash);
}

module.exports = {
  lookupHashRecord,
  registerHashRecord
};
