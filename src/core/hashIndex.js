const { deleteHashRecord, loadHashRecord, saveHashRecord } = require('./metadataStore');
const { createHashRecord } = require('./schema');
const { toPosixPath } = require('./layout');
const { createLogger } = require('./logger');

const logger = createLogger('HashIndex', 'hashIndex.js');
const recordLocks = new Map();

async function withRecordLock(fileHash, operation) {
  const previous = recordLocks.get(fileHash) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  recordLocks.set(fileHash, tail);

  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (recordLocks.get(fileHash) === tail) {
      recordLocks.delete(fileHash);
    }
  }
}

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
  return withRecordLock(input.fileHash, async () => {
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
      logger.debug('Created hash record.', {
        fileHash: input.fileHash,
        logicalPath: normalizedLogicalPath
      });
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
      logger.debug('Hash record unchanged.', {
        fileHash: input.fileHash,
        logicalPath: normalizedLogicalPath
      });
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
    logger.debug('Updated hash record.', {
      fileHash: input.fileHash,
      logicalPath: normalizedLogicalPath,
      pathStatus,
      originStatus
    });
    return {
      record: updated,
      status: 'updated',
      pathStatus,
      originStatus
    };
  });
}

async function lookupHashRecord(targetRoot, fileHash) {
  return loadHashRecord(targetRoot, fileHash);
}

async function unregisterHashRecord(targetRoot, input, now = new Date()) {
  return withRecordLock(input.fileHash, async () => {
    const existing = await loadHashRecord(targetRoot, input.fileHash);
    if (!existing) {
      return {
        record: null,
        status: 'missing'
      };
    }

    const normalizedLogicalPath = toPosixPath(input.logicalPath || '');
    const aliases = [...existing.aliases];
    const origins = existing.origins.filter((entry) => !(
      entry.machineId === input.origin.machineId &&
      entry.sourceId === input.origin.sourceId &&
      entry.sourceRelativePath === toPosixPath(input.origin.sourceRelativePath || '')
    ));

    let logicalPath = existing.logicalPath;
    if (normalizedLogicalPath && existing.logicalPath === normalizedLogicalPath) {
      if (aliases.length > 0) {
        logicalPath = aliases.shift();
      } else {
        logicalPath = '';
      }
    } else if (normalizedLogicalPath) {
      const aliasIndex = aliases.indexOf(normalizedLogicalPath);
      if (aliasIndex >= 0) {
        aliases.splice(aliasIndex, 1);
      }
    }

    if (!logicalPath && origins.length === 0 && aliases.length === 0) {
      await deleteHashRecord(targetRoot, input.fileHash);
      return {
        record: null,
        status: 'deleted'
      };
    }

    if (!logicalPath) {
      return {
        record: existing,
        status: 'unchanged'
      };
    }

    const updated = createHashRecord({
      ...existing,
      logicalPath,
      aliases,
      origins,
      content: existing.content.type === 'plain'
        ? { ...existing.content, path: logicalPath }
        : existing.content,
      updatedAt: now.toISOString()
    }, now);
    await saveHashRecord(targetRoot, updated);
    return {
      record: updated,
      status: 'updated'
    };
  });
}

module.exports = {
  lookupHashRecord,
  registerHashRecord,
  unregisterHashRecord
};
