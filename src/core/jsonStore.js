const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const TMP_PRUNE_AGE_MS = 5 * 60 * 1000;
const writeChains = new Map();

async function readJson(filePath, validator) {
  const document = await fs.readJson(filePath);
  return validator ? validator(document) : document;
}

async function readJsonIfExists(filePath, validator) {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }
  try {
    return await readJson(filePath, validator);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!(await fs.pathExists(filePath))) {
        return null;
      }
      try {
        return await readJson(filePath, validator);
      } catch (retryError) {
        if (retryError && retryError.code === 'ENOENT') {
          return null;
        }
        throw retryError;
      }
    }
    throw error;
  }
}

function atomicTempPrefix(filePath) {
  return `${path.basename(filePath)}.`;
}

function isAtomicTempName(filePath, entryName) {
  return entryName.startsWith(atomicTempPrefix(filePath)) && entryName.endsWith('.tmp');
}

async function pruneStaleAtomicTemps(filePath, now = Date.now()) {
  const parentDir = path.dirname(filePath);
  let entries = [];
  try {
    entries = await fs.readdir(parentDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  await Promise.all(entries.map(async (entryName) => {
    if (!isAtomicTempName(filePath, entryName)) {
      return;
    }
    const entryPath = path.join(parentDir, entryName);
    try {
      const stats = await fs.stat(entryPath);
      if ((now - stats.mtimeMs) < TMP_PRUNE_AGE_MS) {
        return;
      }
      await fs.remove(entryPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }));
}

async function removeAtomicTemps(filePath) {
  const parentDir = path.dirname(filePath);
  let entries = [];
  try {
    entries = await fs.readdir(parentDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  await Promise.all(entries.map(async (entryName) => {
    if (!isAtomicTempName(filePath, entryName)) {
      return;
    }
    const entryPath = path.join(parentDir, entryName);
    try {
      await fs.remove(entryPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }));
}

function enqueueWrite(filePath, writer) {
  const key = path.resolve(filePath);
  const previous = writeChains.get(key) || Promise.resolve();
  const chained = previous
    .catch(() => {})
    .then(writer);
  const tracked = chained.finally(() => {
    if (writeChains.get(key) === tracked) {
      writeChains.delete(key);
    }
  });
  writeChains.set(key, tracked);
  return tracked;
}

async function writeJsonAtomic(filePath, document, options = {}) {
  return enqueueWrite(filePath, async () => {
  const parentDir = path.dirname(filePath);
  const tempPath = path.join(
    parentDir,
    `${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  await fs.ensureDir(parentDir);
  await pruneStaleAtomicTemps(filePath);

  try {
    await fs.writeJson(tempPath, document, {
      spaces: options.compact ? 0 : 2
    });
    await fs.move(tempPath, filePath, { overwrite: true });
    await removeAtomicTemps(filePath);
  } catch (error) {
    try {
      await fs.remove(tempPath);
    } catch (cleanupError) {
      if (!cleanupError || cleanupError.code !== 'ENOENT') {
        throw cleanupError;
      }
    }
    throw error;
  }
  });
}

module.exports = {
  readJson,
  readJsonIfExists,
  writeJsonAtomic
};
