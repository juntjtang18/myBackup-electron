const fs = require('fs-extra');
const path = require('path');
const { resolveTargetMapping } = require('./pathMapper');
const { shortHash } = require('./ids');
const {
  finalizePlainFileCopy,
  resolveLogicalPath,
  stageFileForCopy,
  statStoredPlainFile,
} = require('./plainFileStorage');
const { isMtimeWithinTolerance } = require('./keepNewer');
const { createLogger } = require('./logger');

const logger = createLogger('FileTaskProcessor', 'fileTaskProcessor.js');

function isTransientSourceFileError(error) {
  const code = error && error.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'SOURCE_CHANGED';
}

function skippedMissingResult(sourceRelativePath, logicalPath) {
  return {
    action: 'skipped-missing',
    fileHash: null,
    logicalPath: logicalPath || null,
    sourceRelativePath,
    sourceBytes: 0,
    bytesProcessed: 0
  };
}

function isTargetAValidBackup(stats, targetStat, toleranceMs) {
  if (!targetStat || (typeof targetStat.isFile === 'function' && !targetStat.isFile())) {
    return false;
  }

  if (Number(targetStat.size) !== Number(stats?.size)) {
    return false;
  }

  return isMtimeWithinTolerance(stats?.mtimeMs, targetStat.mtimeMs, toleranceMs);
}

function shouldCopySourceFile(stats, targetStat, toleranceMs) {
  return !isTargetAValidBackup(stats, targetStat, toleranceMs);
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
    mtimeToleranceMs = 2000
  } = input;

  const mapping = resolveTargetMapping({
    machineId,
    source,
    sourceRelativePath,
    filePath: sourceFilePath
  });

  try {
    return await copySourceFile({
      targetRoot,
      machineId,
      source,
      sourceFilePath,
      sourceRelativePath,
      stats,
      now,
      shouldAbort,
      onProgress,
      chunkSize,
      mtimeToleranceMs,
      mapping
    });
  } catch (error) {
    if (error && error.code === 'PAUSE_CANCELLED') {
      throw error;
    }
    if (isTransientSourceFileError(error)) {
      logger.warn('Skipped file that disappeared or changed during backup.', {
        sourceRelativePath,
        logicalPath: mapping.logicalPath,
        code: error.code || null,
        error: error.message
      });
      return skippedMissingResult(sourceRelativePath, mapping.logicalPath);
    }
    logger.warn('File copy failed; continuing with next file.', {
      sourceRelativePath,
      logicalPath: mapping.logicalPath,
      code: error && error.code ? error.code : null,
      error: error && error.message ? error.message : String(error)
    });
    return {
      action: 'failed',
      fileHash: null,
      logicalPath: mapping.logicalPath,
      sourceRelativePath,
      sourceBytes: 0,
      bytesProcessed: 0,
      error: error && error.message ? error.message : String(error),
      errorCode: error && error.code ? error.code : null
    };
  }
}

async function copySourceFile({
  targetRoot,
  machineId,
  source,
  sourceFilePath,
  sourceRelativePath,
  stats,
  now,
  shouldAbort,
  onProgress,
  chunkSize,
  mtimeToleranceMs,
  mapping
}) {
  const sourceLstat = stats?.isSymbolicLink?.()
    ? stats
    : await fs.lstat(sourceFilePath);
  const targetStat = sourceLstat.isSymbolicLink()
    ? await (async () => {
      const absolutePath = resolveLogicalPath(targetRoot, mapping.logicalPath);
      if (!(await fs.pathExists(absolutePath))) {
        return null;
      }
      return fs.lstat(absolutePath);
    })()
    : await statStoredPlainFile(targetRoot, mapping.logicalPath);

  if (!shouldCopySourceFile(sourceLstat, targetStat, mtimeToleranceMs)) {
    logger.debug('Skipped unchanged file from mapped target stat.', {
      sourceRelativePath,
      logicalPath: mapping.logicalPath,
      targetSize: targetStat.size,
      targetMtimeMs: targetStat.mtimeMs,
      sourceMtimeMs: sourceLstat.mtimeMs,
      mtimeToleranceMs
    });
    return {
      action: 'unchanged',
      fileHash: null,
      logicalPath: mapping.logicalPath,
      sourceRelativePath,
      sourceBytes: Number(sourceLstat.size || 0),
      targetBytes: Number(targetStat.size || 0),
      bytesProcessed: 0
    };
  }

  if (sourceLstat.isSymbolicLink()) {
    const destination = resolveLogicalPath(targetRoot, mapping.logicalPath);
    const linkTarget = await fs.readlink(sourceFilePath);
    await fs.ensureDir(path.dirname(destination));
    if (await fs.pathExists(destination)) {
      await fs.remove(destination);
    }
    await fs.symlink(linkTarget, destination);
    return {
      action: 'copied',
      fileHash: null,
      logicalPath: mapping.logicalPath,
      sourceRelativePath,
      sourceBytes: Number(sourceLstat.size || 0),
      bytesProcessed: Number(sourceLstat.size || 0),
      record: {
        type: 'symlink',
        path: mapping.logicalPath,
        target: linkTarget
      }
    };
  }

  const stageJobId = `${shortHash(`${machineId}:${source.sourceId}:${sourceRelativePath}:${now.toISOString()}`, 12)}-stage`;
  const staged = await stageFileForCopy(targetRoot, {
    sourcePath: sourceFilePath,
    tempKey: stageJobId,
    logicalPath: mapping.logicalPath,
    extension: sourceFilePath,
    expectedSize: sourceLstat.size,
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
    sourceBytes: Number(sourceLstat.size || stats.size || 0),
    bytesProcessed: stats.size,
    record: {
      type: 'plain',
      path: content.path
    }
  };
}

module.exports = {
  isMtimeWithinTolerance,
  isTargetAValidBackup,
  isTransientSourceFileError,
  processFileTask,
  shouldCopySourceFile
};
