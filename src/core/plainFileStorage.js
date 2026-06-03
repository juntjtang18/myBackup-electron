const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { getTempRoot } = require('./metadataStore');
const { resolveTargetRoot, toPosixPath } = require('./layout');
const { hashFile } = require('./hashService');

function resolveLogicalPath(targetRoot, logicalPath) {
  return path.join(resolveTargetRoot(targetRoot), ...toPosixPath(logicalPath).split('/'));
}

function createTempFilePath(targetRoot, jobId, logicalPath) {
  const extension = path.extname(logicalPath || '');
  return path.join(getTempRoot(targetRoot), `${jobId}${extension || '.tmp'}`);
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

async function writePlainFile(targetRoot, input) {
  const absoluteDestination = resolveLogicalPath(targetRoot, input.logicalPath);
  const tempPath = createTempFilePath(targetRoot, input.jobId, input.logicalPath);

  await fs.ensureDir(path.dirname(absoluteDestination));
  await fs.ensureDir(path.dirname(tempPath));
  const sourceStat = await fs.stat(input.sourcePath);
  const expectedSize = input.expectedSize !== undefined ? input.expectedSize : sourceStat.size;

  if (input.expectedHash) {
    await fs.copyFile(input.sourcePath, tempPath);
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

  let copiedBytes = 0;

  await new Promise((resolve, reject) => {
    function fail(error) {
      readStream.destroy();
      writeStream.destroy();
      reject(error);
    }

    readStream.on('data', (chunk) => {
      copiedBytes += chunk.length;
      hasher.update(chunk);
      if (typeof input.onProgress === 'function') {
        input.onProgress({
          phase: 'copy',
          copiedBytes,
          totalBytes: expectedSize,
          logicalPath: toPosixPath(input.logicalPath)
        });
      }
    });
    readStream.on('error', fail);
    writeStream.on('error', fail);
    writeStream.on('close', resolve);
    readStream.pipe(writeStream);
  });

  const actualHash = hasher.digest('hex');
  if (copiedBytes !== expectedSize) {
    await fs.remove(tempPath);
    throw new Error(`Copied file size mismatch for ${input.logicalPath}`);
  }

  await fs.utimes(tempPath, sourceStat.atime, sourceStat.mtime);

  return {
    tempPath,
    finalPath: absoluteDestination,
    content: {
      type: 'plain',
      path: toPosixPath(input.logicalPath)
    }
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
  return {
    type: 'plain',
    path: pendingWrite.content.path
  };
}

async function restorePlainFile(targetRoot, contentRef, restorePath) {
  const absoluteSource = resolveLogicalPath(targetRoot, contentRef.path);
  await fs.ensureDir(path.dirname(restorePath));
  await fs.copy(absoluteSource, restorePath, { preserveTimestamps: true, overwrite: true });
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
  finalizePlainFile,
  resolveLogicalPath,
  restorePlainFile,
  verifyStoredPlainFile,
  writePlainFile
};
