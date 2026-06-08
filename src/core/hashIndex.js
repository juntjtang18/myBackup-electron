const { deleteFileIndexRecord, loadFileIndexRecord, saveFileIndexRecord } = require('./fileIndex');
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

function normalizeRegistrationInput(input, now = new Date()) {
  return {
    fileHash: input.fileHash,
    size: input.size,
    logicalPath: toPosixPath(input.logicalPath || ''),
    kind: input.kind || 'file',
    content: input.content,
    origin: {
      machineId: input.origin.machineId,
      sourceId: input.origin.sourceId,
      sourceRelativePath: toPosixPath(input.origin.sourceRelativePath || ''),
      discoveredAt: input.origin.discoveredAt || now.toISOString()
    }
  };
}

function applyHashRecordRegistration(existing, input, now = new Date()) {
  const normalized = normalizeRegistrationInput(input, now);

  if (!existing) {
    const created = createHashRecord({
      fileHash: normalized.fileHash,
      size: normalized.size,
      logicalPath: normalized.logicalPath,
      aliases: [],
      kind: normalized.kind,
      content: normalized.content,
      origins: [normalized.origin]
    }, now);

    return {
      record: created,
      status: 'created',
      pathStatus: 'created',
      originStatus: 'created'
    };
  }

  const aliases = [...existing.aliases];
  const origins = [...existing.origins];
  let changed = false;
  let pathStatus = 'existing-path';
  let originStatus = 'existing-origin';

  if (normalized.logicalPath && !hasLogicalPath(existing, normalized.logicalPath)) {
    aliases.push(normalized.logicalPath);
    aliases.sort();
    changed = true;
    pathStatus = 'alias-added';
  }

  if (!hasOrigin(existing, normalized.origin)) {
    origins.push(normalized.origin);
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

  return {
    record: updated,
    status: 'updated',
    pathStatus,
    originStatus
  };
}

function applyHashRecordUnregister(existing, input, now = new Date()) {
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

  return {
    record: updated,
    status: 'updated'
  };
}

async function registerHashRecord(targetRoot, input, now = new Date()) {
  return withRecordLock(input.fileHash, async () => {
    const existing = await loadFileIndexRecord(targetRoot, input.fileHash);
    const result = applyHashRecordRegistration(existing, input, now);

    if (result.status === 'deleted') {
      await deleteFileIndexRecord(targetRoot, input.fileHash);
      return result;
    }

    if (result.status === 'unchanged') {
      logger.debug('Hash record unchanged.', {
        fileHash: input.fileHash,
        logicalPath: toPosixPath(input.logicalPath || '')
      });
      return result;
    }

    await saveFileIndexRecord(targetRoot, result.record);
    logger.debug(result.status === 'created' ? 'Created hash record.' : 'Updated hash record.', {
      fileHash: input.fileHash,
      logicalPath: toPosixPath(input.logicalPath || ''),
      pathStatus: result.pathStatus,
      originStatus: result.originStatus
    });
    return result;
  });
}

async function lookupHashRecord(targetRoot, fileHash) {
  return loadFileIndexRecord(targetRoot, fileHash);
}

async function unregisterHashRecord(targetRoot, input, now = new Date()) {
  return withRecordLock(input.fileHash, async () => {
    const existing = await loadFileIndexRecord(targetRoot, input.fileHash);
    const result = applyHashRecordUnregister(existing, input, now);

    if (result.status === 'deleted') {
      await deleteFileIndexRecord(targetRoot, input.fileHash);
      return result;
    }

    if (result.status === 'unchanged') {
      return result;
    }

    await saveFileIndexRecord(targetRoot, result.record);
    return result;
  });
}

module.exports = {
  applyHashRecordRegistration,
  applyHashRecordUnregister,
  lookupHashRecord,
  registerHashRecord,
  unregisterHashRecord,
  withRecordLock
};
