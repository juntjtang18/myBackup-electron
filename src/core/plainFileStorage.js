const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { once } = require('events');
const { getTempRoot } = require('./metadataStore');
const { resolveTargetRoot, toPosixPath } = require('./layout');
const { createPauseCancelledResult, hashFile, isPauseCancelledResult } = require('./hashService');
const { DEFAULT_MTIME_TOLERANCE_MS, shouldCopyWhenSourceNewer } = require('./keepNewer');

function resolveLogicalPath(targetRoot, logicalPath) {
  return path.join(resolveTargetRoot(targetRoot), ...toPosixPath(logicalPath).split('/'));
}

function createTempFilePath(targetRoot, jobId, logicalPath) {
  const extension = path.extname(logicalPath || '');
  return path.join(getTempRoot(targetRoot), `${jobId}${extension || '.tmp'}`);
}

function createStagingTempPath(targetRoot, tempKey, extensionSource = '') {
  const extension = path.extname(extensionSource || '');
  return path.join(getTempRoot(targetRoot), `${tempKey}${extension || '.tmp'}`);
}

async function applySourceTimes(targetPath, sourceTimes) {
  if (!sourceTimes || !sourceTimes.atime || !sourceTimes.mtime) {
    return;
  }
  await fs.utimes(targetPath, sourceTimes.atime, sourceTimes.mtime);
}

async function verifyStoredPlainFile(targetRoot, contentRef, expectedHash, expectedSize) {
  const absolutePath = resolveLogicalPath(targetRoot, contentRef.path);
  if (!(await fs.pathExists(absolutePath))) {
    return false;
  }

  const stat = await fs.stat(absolutePath);
  if (expectedSize !== undefined && stat.size !== expectedSize) {
    return false;
  }

  if (expectedHash) {
    const actualHash = await hashFile(absolutePath);
    return actualHash === expectedHash;
  }

  return true;
}

async function statStoredPlainFile(targetRoot, logicalPath) {
  const absolutePath = resolveLogicalPath(targetRoot, logicalPath);
  if (!(await fs.pathExists(absolutePath))) {
    return null;
  }
  return fs.stat(absolutePath);
}

async function writePlainFile(targetRoot, input) {
  const absoluteDestination = resolveLogicalPath(targetRoot, input.logicalPath);
  const tempPath = createTempFilePath(targetRoot, input.jobId, input.logicalPath);
  const shouldAbort = typeof input.shouldAbort === 'function' ? input.shouldAbort : () => false;

  await fs.ensureDir(path.dirname(absoluteDestination));
  await fs.ensureDir(path.dirname(tempPath));
  const sourceStat = await fs.stat(input.sourcePath);
  const expectedSize = input.expectedSize !== undefined ? input.expectedSize : sourceStat.size;

  if (shouldAbort()) {
    return createPauseCancelledResult();
  }

  if (input.expectedHash && typeof input.onProgress !== 'function') {
    await fs.copyFile(input.sourcePath, tempPath);
    if (shouldAbort()) {
      await fs.remove(tempPath);
      return createPauseCancelledResult();
    }
    const copiedBytes = (await fs.stat(tempPath)).size;
    if (copiedBytes !== expectedSize) {
      await fs.remove(tempPath);
      throw new Error(`Copied file size mismatch for ${input.logicalPath}`);
    }
    await fs.utimes(tempPath, sourceStat.atime, sourceStat.mtime);
    if (typeof input.onProgress === 'function') {
      input.onProgress({
        phase: 'copy',
        copiedBytes,
        totalBytes: expectedSize,
        logicalPath: toPosixPath(input.logicalPath)
      });
    }

    return {
      tempPath,
      finalPath: absoluteDestination,
      expectedHash: input.expectedHash,
      sourceTimes: {
        atime: sourceStat.atime,
        mtime: sourceStat.mtime
      },
      content: {
        type: 'plain',
        path: toPosixPath(input.logicalPath)
      }
    };
  }

  const hasher = crypto.createHash('sha256');
  const readStream = fs.createReadStream(input.sourcePath, {
    highWaterMark: input.chunkSize || 1024 * 1024
  });
  const writeStream = fs.createWriteStream(tempPath, {
    flags: 'w'
  });
  readStream.on('error', () => {});
  writeStream.on('error', () => {});

  let copiedBytes = 0;
  let aborted = false;
  try {
    for await (const chunk of readStream) {
      if (shouldAbort()) {
        aborted = true;
        readStream.destroy();
        break;
      }

      copiedBytes += chunk.length;
      hasher.update(chunk);
      if (!writeStream.write(chunk)) {
        await once(writeStream, 'drain');
      }
      if (typeof input.onProgress === 'function') {
        input.onProgress({
          phase: 'copy',
          copiedBytes,
          totalBytes: expectedSize,
          logicalPath: toPosixPath(input.logicalPath)
        });
      }
    }

    if (!aborted) {
      await new Promise((resolve, reject) => {
        writeStream.on('error', reject);
        writeStream.end(resolve);
      });
    }
  } catch (error) {
    await fs.remove(tempPath);
    readStream.destroy();
    writeStream.destroy();
    throw error;
  }

  if (aborted) {
    writeStream.destroy();
    await fs.remove(tempPath);
    return createPauseCancelledResult();
  }

  const actualHash = hasher.digest('hex');
  if (copiedBytes !== expectedSize) {
    await fs.remove(tempPath);
    throw new Error(`Copied file size mismatch for ${input.logicalPath}`);
  }
  if (input.expectedHash && actualHash !== input.expectedHash) {
    await fs.remove(tempPath);
    throw new Error(`Copied file hash mismatch for ${input.logicalPath}`);
  }

  await fs.utimes(tempPath, sourceStat.atime, sourceStat.mtime);

  return {
    tempPath,
    finalPath: absoluteDestination,
    expectedHash: input.expectedHash || actualHash,
    sourceTimes: {
      atime: sourceStat.atime,
      mtime: sourceStat.mtime
    },
    content: {
      type: 'plain',
      path: toPosixPath(input.logicalPath)
    }
  };
}

async function stageFileWhileHashing(targetRoot, input) {
  const tempPath = createStagingTempPath(targetRoot, input.tempKey, input.extension || input.sourcePath);
  const shouldAbort = typeof input.shouldAbort === 'function' ? input.shouldAbort : () => false;
  const sourceStat = await fs.stat(input.sourcePath);
  const expectedSize = input.expectedSize !== undefined ? input.expectedSize : sourceStat.size;
  await fs.ensureDir(path.dirname(tempPath));
  const hasher = crypto.createHash('sha256');
  const readStream = fs.createReadStream(input.sourcePath, {
    highWaterMark: input.chunkSize || 1024 * 1024
  });
  const writeStream = fs.createWriteStream(tempPath, {
    flags: 'w'
  });

  if (shouldAbort()) {
    return createPauseCancelledResult();
  }

  let copiedBytes = 0;
  let aborted = false;
  try {
    for await (const chunk of readStream) {
      if (shouldAbort()) {
        aborted = true;
        readStream.destroy();
        break;
      }

      copiedBytes += chunk.length;
      hasher.update(chunk);
      if (!writeStream.write(chunk)) {
        await once(writeStream, 'drain');
      }
      if (typeof input.onProgress === 'function') {
        input.onProgress({
          phase: 'stage',
          copiedBytes,
          totalBytes: expectedSize
        });
        if (shouldAbort()) {
          aborted = true;
          readStream.destroy();
          break;
        }
      }
    }

    if (!aborted) {
      await new Promise((resolve, reject) => {
        writeStream.on('error', reject);
        writeStream.end(resolve);
      });
    }
  } catch (error) {
    await fs.remove(tempPath);
    readStream.destroy();
    writeStream.destroy();
    throw error;
  }

  if (aborted) {
    writeStream.destroy();
    await fs.remove(tempPath);
    return createPauseCancelledResult();
  }

  if (copiedBytes !== expectedSize) {
    await fs.remove(tempPath);
    throw new Error(`Copied file size mismatch for staging ${input.sourcePath}`);
  }

  await fs.utimes(tempPath, sourceStat.atime, sourceStat.mtime);

  return {
    tempPath,
    fileHash: hasher.digest('hex'),
    size: copiedBytes,
    mtimeMs: sourceStat.mtimeMs,
    sourceTimes: {
      atime: sourceStat.atime,
      mtime: sourceStat.mtime
    }
  };
}

async function stageFileForCopy(targetRoot, input) {
  const tempPath = createStagingTempPath(targetRoot, input.tempKey, input.extension || input.sourcePath);
  const shouldAbort = typeof input.shouldAbort === 'function' ? input.shouldAbort : () => false;
  const sourceStat = await fs.stat(input.sourcePath);
  const expectedSize = input.expectedSize !== undefined ? input.expectedSize : sourceStat.size;
  await fs.ensureDir(path.dirname(tempPath));
  const readStream = fs.createReadStream(input.sourcePath, {
    highWaterMark: input.chunkSize || 1024 * 1024
  });
  const writeStream = fs.createWriteStream(tempPath, {
    flags: 'w'
  });

  if (shouldAbort()) {
    return createPauseCancelledResult();
  }

  let copiedBytes = 0;
  let aborted = false;
  try {
    for await (const chunk of readStream) {
      if (shouldAbort()) {
        aborted = true;
        readStream.destroy();
        break;
      }

      copiedBytes += chunk.length;
      if (!writeStream.write(chunk)) {
        await once(writeStream, 'drain');
      }
      if (typeof input.onProgress === 'function') {
        input.onProgress({
          phase: 'copy',
          copiedBytes,
          totalBytes: expectedSize,
          logicalPath: toPosixPath(input.logicalPath || '')
        });
      }
    }

    if (!aborted) {
      await new Promise((resolve, reject) => {
        writeStream.on('error', reject);
        writeStream.end(resolve);
      });
    }
  } catch (error) {
    await fs.remove(tempPath);
    readStream.destroy();
    writeStream.destroy();
    throw error;
  }

  if (aborted) {
    writeStream.destroy();
    await fs.remove(tempPath);
    return createPauseCancelledResult();
  }

  if (copiedBytes !== expectedSize) {
    await fs.remove(tempPath);
    throw new Error(`Copied file size mismatch for staging ${input.sourcePath}`);
  }

  await fs.utimes(tempPath, sourceStat.atime, sourceStat.mtime);

  return {
    tempPath,
    finalPath: resolveLogicalPath(targetRoot, input.logicalPath || ''),
    sourceTimes: {
      atime: sourceStat.atime,
      mtime: sourceStat.mtime
    },
    content: {
      type: 'plain',
      path: toPosixPath(input.logicalPath || '')
    }
  };
}

async function discardStagedFile(staged) {
  if (!staged || !staged.tempPath) {
    return;
  }
  await fs.remove(staged.tempPath);
}

async function finalizeStagedFile(targetRoot, staged, logicalPath) {
  const destination = resolveLogicalPath(targetRoot, logicalPath);
  await fs.ensureDir(path.dirname(destination));
  if (await fs.pathExists(destination)) {
    const existingHash = await hashFile(destination);
    if (existingHash === staged.fileHash) {
      await fs.remove(staged.tempPath);
      return {
        type: 'plain',
        path: toPosixPath(logicalPath)
      };
    }

    await fs.remove(staged.tempPath);
    throw new Error(`Destination already exists with different content for ${logicalPath}`);
  }

  await fs.move(staged.tempPath, destination, { overwrite: false });
  await applySourceTimes(destination, staged.sourceTimes);
  return {
    type: 'plain',
    path: toPosixPath(logicalPath)
  };
}

async function finalizePlainFile(targetRoot, pendingWrite) {
  const destination = pendingWrite.finalPath || resolveLogicalPath(targetRoot, pendingWrite.content.path);
  await fs.ensureDir(path.dirname(destination));
  if (await fs.pathExists(destination)) {
    const existingHash = await hashFile(destination);
    const tempHash = pendingWrite.expectedHash || await hashFile(pendingWrite.tempPath);
    if (existingHash === tempHash) {
      await fs.remove(pendingWrite.tempPath);
      return {
        type: 'plain',
        path: pendingWrite.content.path
      };
    }

    await fs.remove(pendingWrite.tempPath);
    throw new Error(`Destination already exists with different content for ${pendingWrite.content.path}`);
  }

  await fs.move(pendingWrite.tempPath, destination, { overwrite: false });
  await applySourceTimes(destination, pendingWrite.sourceTimes);
  return {
    type: 'plain',
    path: pendingWrite.content.path
  };
}

async function finalizePlainFileCopy(targetRoot, pendingWrite) {
  const destination = pendingWrite.finalPath || resolveLogicalPath(targetRoot, pendingWrite.content.path);
  await fs.ensureDir(path.dirname(destination));
  if (await fs.pathExists(destination)) {
    await fs.remove(destination);
  }

  await fs.move(pendingWrite.tempPath, destination, { overwrite: true });
  await applySourceTimes(destination, pendingWrite.sourceTimes);
  return {
    type: 'plain',
    path: pendingWrite.content.path
  };
}

async function restorePlainFile(targetRoot, contentRef, restorePath, options = {}) {
  const absoluteSource = resolveLogicalPath(targetRoot, contentRef.path);
  const toleranceMs = options.mtimeToleranceMs === undefined
    ? DEFAULT_MTIME_TOLERANCE_MS
    : Number(options.mtimeToleranceMs);
  if (await fs.pathExists(restorePath)) {
    const sourceStat = await fs.lstat(absoluteSource);
    const destStat = await fs.lstat(restorePath);
    if (!shouldCopyWhenSourceNewer(sourceStat, destStat, toleranceMs)) {
      return {
        restored: false,
        action: destStat.mtimeMs > (sourceStat.mtimeMs + toleranceMs) ? 'skipped-newer' : 'unchanged'
      };
    }
  }
  await fs.ensureDir(path.dirname(restorePath));
  await fs.copy(absoluteSource, restorePath, { preserveTimestamps: true, overwrite: true });
  return {
    restored: true,
    action: 'copied'
  };
}

async function cleanupTempFiles(targetRoot) {
  const tempDir = getTempRoot(targetRoot);
  if (!(await fs.pathExists(tempDir))) {
    return 0;
  }

  const entries = await fs.readdir(tempDir);
  let removed = 0;

  for (const entry of entries) {
    await fs.remove(path.join(tempDir, entry));
    removed += 1;
  }

  return removed;
}

module.exports = {
  cleanupTempFiles,
  createTempFilePath,
  createStagingTempPath,
  discardStagedFile,
  finalizePlainFile,
  finalizePlainFileCopy,
  finalizeStagedFile,
  isPauseCancelledResult,
  resolveLogicalPath,
  restorePlainFile,
  stageFileForCopy,
  stageFileWhileHashing,
  statStoredPlainFile,
  verifyStoredPlainFile,
  writePlainFile
};
