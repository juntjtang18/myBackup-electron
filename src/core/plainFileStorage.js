const path = require('path');
const fs = require('fs-extra');
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
  await fs.copy(input.sourcePath, tempPath, { preserveTimestamps: true, overwrite: true });

  const stat = await fs.stat(tempPath);
  if (stat.size !== input.expectedSize) {
    await fs.remove(tempPath);
    throw new Error(`Copied file size mismatch for ${input.logicalPath}`);
  }

  const actualHash = await hashFile(tempPath);
  if (actualHash !== input.expectedHash) {
    await fs.remove(tempPath);
    throw new Error(`Copied file hash mismatch for ${input.logicalPath}`);
  }

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
