const path = require('path');
const fs = require('fs-extra');
const { metadataRoot, toPosixPath } = require('./layout');
const { restorePlainFile } = require('./plainFileStorage');
const { loadHashRecord } = require('./metadataStore');

function getAllLogicalPaths(record) {
  const paths = [];
  if (record.logicalPath) {
    paths.push(toPosixPath(record.logicalPath));
  }

  for (const alias of record.aliases || []) {
    const normalized = toPosixPath(alias);
    if (!paths.includes(normalized)) {
      paths.push(normalized);
    }
  }

  return paths;
}

async function listHashRecords(targetRoot) {
  const hashesRoot = path.join(metadataRoot(targetRoot), 'hashes');
  if (!(await fs.pathExists(hashesRoot))) {
    return [];
  }

  const records = [];

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const fileHash = path.basename(entry.name, '.json');
      const record = await loadHashRecord(targetRoot, fileHash);
      if (record) {
        records.push(record);
      }
    }
  }

  await walk(hashesRoot);
  records.sort((left, right) => left.fileHash.localeCompare(right.fileHash));
  return records;
}

function isPathInsideRoot(logicalPath, logicalRoot) {
  const normalizedPath = toPosixPath(logicalPath);
  const normalizedRoot = toPosixPath(logicalRoot).replace(/\/+$/, '');
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

async function restoreSource(targetRoot, input) {
  const destinationRoot = path.resolve(input.destinationRoot);
  const records = await listHashRecords(targetRoot);
  const summary = {
    machineId: input.machineId,
    sourceId: input.sourceId,
    restoredFiles: 0,
    skippedRecords: 0
  };

  for (const record of records) {
    const origin = (record.origins || []).find((entry) => (
      entry.machineId === input.machineId &&
      entry.sourceId === input.sourceId
    ));

    if (!origin) {
      summary.skippedRecords += 1;
      continue;
    }

    const restorePath = path.join(destinationRoot, ...toPosixPath(origin.sourceRelativePath).split('/'));
    if (record.content.type !== 'plain') {
      throw new Error(`Unsupported content type for restore: ${record.content.type}`);
    }

    await restorePlainFile(targetRoot, record.content, restorePath);
    summary.restoredFiles += 1;
  }

  return summary;
}

async function restoreLogicalTree(targetRoot, input) {
  const logicalRoot = toPosixPath(input.logicalRoot).replace(/\/+$/, '');
  const destinationRoot = path.resolve(input.destinationRoot);
  const records = await listHashRecords(targetRoot);
  const restoredPaths = new Set();
  const summary = {
    logicalRoot,
    restoredFiles: 0
  };

  for (const record of records) {
    if (record.content.type !== 'plain') {
      throw new Error(`Unsupported content type for restore: ${record.content.type}`);
    }

    for (const logicalPath of getAllLogicalPaths(record)) {
      if (!isPathInsideRoot(logicalPath, logicalRoot)) {
        continue;
      }

      const relativePath = logicalPath === logicalRoot
        ? path.posix.basename(logicalPath)
        : logicalPath.slice(logicalRoot.length + 1);
      if (restoredPaths.has(logicalPath)) {
        continue;
      }

      const restorePath = path.join(destinationRoot, ...toPosixPath(relativePath).split('/'));
      await restorePlainFile(targetRoot, { type: 'plain', path: logicalPath }, restorePath);
      restoredPaths.add(logicalPath);
      summary.restoredFiles += 1;
    }
  }

  return summary;
}

async function restoreLogicalFile(targetRoot, input) {
  const logicalPath = toPosixPath(input.logicalPath);
  const destinationPath = path.resolve(input.destinationPath);
  const records = await listHashRecords(targetRoot);

  for (const record of records) {
    for (const candidatePath of getAllLogicalPaths(record)) {
      if (candidatePath !== logicalPath) {
        continue;
      }

      await restorePlainFile(targetRoot, { type: 'plain', path: candidatePath }, destinationPath);
      return {
        logicalPath,
        restored: true
      };
    }
  }

  throw new Error(`Logical path not found: ${logicalPath}`);
}

module.exports = {
  getAllLogicalPaths,
  listHashRecords,
  restoreLogicalFile,
  restoreLogicalTree,
  restoreSource
};
