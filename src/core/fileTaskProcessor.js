const { resolveTargetMapping } = require('./pathMapper');
const { shortHash } = require('./ids');
const {
  finalizePlainFileCopy,
  resolveLogicalPath,
  stageFileForCopy,
  statStoredPlainFile,
} = require('./plainFileStorage');
const { createLogger } = require('./logger');

const logger = createLogger('FileTaskProcessor', 'fileTaskProcessor.js');

function isMtimeWithinTolerance(sourceMtimeMs, targetMtimeMs, toleranceMs) {
  return Math.abs(Number(sourceMtimeMs || 0) - Number(targetMtimeMs || 0)) <= toleranceMs;
}

function shouldCopyWhenSourceNewer(stats, targetStat, toleranceMs) {
  if (!targetStat) {
    return true;
  }

  const sourceMtimeMs = Number(stats?.mtimeMs || 0);
  const targetMtimeMs = Number(targetStat?.mtimeMs || 0);
  return sourceMtimeMs > (targetMtimeMs + Number(toleranceMs || 0));
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
    shouldAbort,
    onProgress,
    chunkSize,
    mtimeToleranceMs = 2000,
    compareBySourceNewerOnly = false
  } = input;

  const mapping = resolveTargetMapping({
    machineId,
    source,
    sourceRelativePath,
    filePath: sourceFilePath
  });
  const targetStat = await statStoredPlainFile(targetRoot, mapping.logicalPath);
  if (compareBySourceNewerOnly) {
    if (!shouldCopyWhenSourceNewer(stats, targetStat, mtimeToleranceMs)) {
      logger.debug('Skipped full-scan file because target is present and not older.', {
        sourceRelativePath,
        logicalPath: mapping.logicalPath,
        targetSize: targetStat?.size || 0,
        targetMtimeMs: targetStat?.mtimeMs || 0,
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
  } else if (targetStat
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
  const staged = await stageFileForCopy(targetRoot, {
    sourcePath: sourceFilePath,
    tempKey: stageJobId,
    logicalPath: mapping.logicalPath,
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

  const logicalPath = mapping.logicalPath;

  const content = await finalizePlainFileCopy(targetRoot, {
    ...staged,
    content: {
      type: 'plain',
      path: logicalPath
    }
  });
  return {
    action: 'copied',
    fileHash: null,
    logicalPath,
    sourceRelativePath,
    bytesProcessed: stats.size,
    record: {
      type: 'plain',
      path: content.path
    }
  };
}

module.exports = {
  processFileTask
};
