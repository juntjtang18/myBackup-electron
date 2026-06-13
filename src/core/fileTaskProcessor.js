const fs = require('fs-extra');
const { buildConflictPath } = require('./pathPlanner');
const { resolveTargetMapping } = require('./pathMapper');
const { shortHash } = require('./ids');
const { hashFile } = require('./hashService');
const {
  discardStagedFile,
  finalizeStagedFile,
  resolveLogicalPath,
  stageFileWhileHashing,
  statStoredPlainFile,
  verifyStoredPlainFile
} = require('./plainFileStorage');
const { createLogger } = require('./logger');

const logger = createLogger('FileTaskProcessor', 'fileTaskProcessor.js');

function createInFlightHashCoordinator() {
  const entries = new Map();

  return {
    claim(fileHash) {
      const existing = entries.get(fileHash);
      if (existing) {
        return {
          leader: false,
          promise: existing.promise
        };
      }

      let resolveEntry;
      let rejectEntry;
      const promise = new Promise((resolve, reject) => {
        resolveEntry = resolve;
        rejectEntry = reject;
      });
      entries.set(fileHash, {
        promise,
        resolve: resolveEntry,
        reject: rejectEntry
      });
      return {
        leader: true,
        promise
      };
    },
    resolve(fileHash, result) {
      const entry = entries.get(fileHash);
      if (!entry) {
        return;
      }
      entries.delete(fileHash);
      entry.resolve(result);
    },
    reject(fileHash, error) {
      const entry = entries.get(fileHash);
      if (!entry) {
        return;
      }
      entries.delete(fileHash);
      entry.reject(error);
    }
  };
}

function isMtimeWithinTolerance(sourceMtimeMs, targetMtimeMs, toleranceMs) {
  return Math.abs(Number(sourceMtimeMs || 0) - Number(targetMtimeMs || 0)) <= toleranceMs;
}

async function chooseLogicalPath(
  targetRoot,
  source,
  machineId,
  sourceRelativePath,
  fileHash,
  kind,
  timestamp,
  options = {}
) {
  const desiredPath = resolveTargetMapping({
    machineId,
    source,
    sourceRelativePath,
    kind,
    timestamp
  }).logicalPath;

  const desiredAbsolutePath = resolveLogicalPath(targetRoot, desiredPath);
  if (!(await fs.pathExists(desiredAbsolutePath))) {
    return desiredPath;
  }

  if (options.allowOverwriteExisting) {
    return desiredPath;
  }

  const sameContent = await verifyStoredPlainFile(
    targetRoot,
    { type: 'plain', path: desiredPath },
    fileHash
  );

  if (sameContent) {
    return desiredPath;
  }

  return buildConflictPath(desiredPath, machineId, source.sourceId);
}

async function registerExistingContent(hashSession, input, now) {
  const registration = await hashSession.register({
    fileHash: input.fileHash,
    size: input.stats.size,
    logicalPath: input.logicalPath,
    kind: input.kind,
    content: input.content,
    origin: {
      machineId: input.machineId,
      sourceId: input.source.sourceId,
      sourceRelativePath: input.sourceRelativePath
    }
  }, now);

  return {
    action: registration.pathStatus === 'alias-added' ? 'indexed-alias' : 'indexed-existing',
    fileHash: input.fileHash,
    logicalPath: input.logicalPath,
    sourceRelativePath: input.sourceRelativePath,
    bytesProcessed: input.stats.size,
    record: registration.record
  };
}

async function processFileTask(input) {
  const {
    targetRoot,
    machineId,
    source,
    sourceFilePath,
    sourceRelativePath,
    stats,
    now = new Date(),
    hashSession,
    inFlightHashes,
    shouldAbort,
    onProgress,
    chunkSize,
    mtimeToleranceMs = 2000
  } = input;

  const mapping = resolveTargetMapping({
    machineId,
    source,
    sourceRelativePath,
    filePath: sourceFilePath,
    timestamp: new Date(stats.mtimeMs)
  });
  const kind = mapping.kind;
  const targetStat = await statStoredPlainFile(targetRoot, mapping.logicalPath);
  const canSkipByTargetStat = !source.mergeEnabled;

  if (canSkipByTargetStat
    && targetStat
    && targetStat.size === stats.size
    && isMtimeWithinTolerance(stats.mtimeMs, targetStat.mtimeMs, mtimeToleranceMs)) {
    logger.debug('Skipped unchanged file from mapped target stat.', {
      sourceRelativePath,
      logicalPath: mapping.logicalPath,
      targetSize: targetStat.size,
      targetMtimeMs: targetStat.mtimeMs,
      sourceMtimeMs: stats.mtimeMs,
      mtimeToleranceMs
    });
    return {
      action: 'skipped-target-stat',
      fileHash: null,
      logicalPath: mapping.logicalPath,
      sourceRelativePath,
      bytesProcessed: 0
    };
  }

  const stageJobId = `${shortHash(`${machineId}:${source.sourceId}:${sourceRelativePath}:${now.toISOString()}`, 12)}-stage`;
  const staged = await stageFileWhileHashing(targetRoot, {
    sourcePath: sourceFilePath,
    tempKey: stageJobId,
    extension: sourceFilePath,
    expectedSize: stats.size,
    chunkSize,
    shouldAbort,
    onProgress: (progress) => onProgress && onProgress({
      ...progress,
      sourceRelativePath
    })
  });

  if (staged.cancelled) {
    return null;
  }

  const allowOverwriteExisting = !source.mergeEnabled;

  const logicalPath = await chooseLogicalPath(
      targetRoot,
      source,
      machineId,
      sourceRelativePath,
      staged.fileHash,
      kind,
      new Date(stats.mtimeMs),
      { allowOverwriteExisting }
    );

  while (true) {
    const existing = await hashSession.lookup(staged.fileHash);
    if (existing) {
      await discardStagedFile(staged);
      return registerExistingContent(hashSession, {
        fileHash: staged.fileHash,
        stats,
        logicalPath,
        kind,
        content: existing.content,
        machineId,
        source,
        sourceRelativePath
      }, now);
    }

    const claim = inFlightHashes.claim(staged.fileHash);
    if (!claim.leader) {
      try {
        await claim.promise;
      } catch (error) {
        logger.warn('In-flight hash registration failed; retrying staged file lookup.', {
          fileHash: staged.fileHash,
          sourceRelativePath,
          error: error.message
        });
        continue;
      }

      const committed = await hashSession.lookup(staged.fileHash);
      if (committed) {
        await discardStagedFile(staged);
        return registerExistingContent(hashSession, {
          fileHash: staged.fileHash,
          stats,
          logicalPath,
          kind,
          content: committed.content,
          machineId,
          source,
          sourceRelativePath
        }, now);
      }
      continue;
    }

    try {
      if (allowOverwriteExisting && targetStat) {
        const existingHash = await hashFile(resolveLogicalPath(targetRoot, logicalPath));
        if (existingHash) {
          await hashSession.unregister({
            fileHash: existingHash,
            logicalPath,
            origin: {
              machineId,
              sourceId: source.sourceId,
              sourceRelativePath
            }
          }, now);
        }
        await fs.remove(resolveLogicalPath(targetRoot, logicalPath));
      }

      const content = await finalizeStagedFile(targetRoot, staged, logicalPath);
      const registration = await hashSession.register({
        fileHash: staged.fileHash,
        size: stats.size,
        logicalPath,
        kind,
        content,
        origin: {
          machineId,
          sourceId: source.sourceId,
          sourceRelativePath
        }
      }, now);
      inFlightHashes.resolve(staged.fileHash, registration.record);
      return {
        action: 'copied',
        fileHash: staged.fileHash,
        logicalPath,
        sourceRelativePath,
        bytesProcessed: stats.size,
        record: registration.record
      };
    } catch (error) {
      inFlightHashes.reject(staged.fileHash, error);
      throw error;
    }
  }
}

module.exports = {
  createInFlightHashCoordinator,
  processFileTask
};
