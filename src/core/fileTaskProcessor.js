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
const { isMtimeWithinTolerance, shouldCopyWhenSourceNewer } = require('./keepNewer');
const { createLogger } = require('./logger');

const logger = createLogger('FileTaskProcessor', 'fileTaskProcessor.js');

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
  if (compareBySourceNewerOnly) {
    if (targetStat && !shouldCopyWhenSourceNewer(sourceLstat, targetStat, mtimeToleranceMs)) {
      const sourceMtimeMs = Number(sourceLstat.mtimeMs || 0);
      const targetMtimeMs = Number(targetStat.mtimeMs || 0);
      const skippedNewer = targetMtimeMs > (sourceMtimeMs + Number(mtimeToleranceMs || 0));
      logger.debug('Skipped full-scan file because target is present and not older.', {
        sourceRelativePath,
        logicalPath: mapping.logicalPath,
        targetSize: targetStat.size || 0,
        targetMtimeMs,
        sourceMtimeMs,
        mtimeToleranceMs,
        skippedNewer
      });
      return {
        action: skippedNewer ? 'skipped-newer' : 'unchanged',
        fileHash: null,
        logicalPath: mapping.logicalPath,
        sourceRelativePath,
        sourceBytes: Number(sourceLstat.size || 0),
        targetBytes: Number(targetStat.size || 0),
        bytesProcessed: 0
      };
    }
  } else if (targetStat
      && targetStat.size === sourceLstat.size
      && isMtimeWithinTolerance(sourceLstat.mtimeMs, targetStat.mtimeMs, mtimeToleranceMs)) {
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
  processFileTask
};
