const fs = require('fs-extra');
const path = require('path');
const { buildConflictPath, classifyMedia, planLogicalTarget } = require('./pathPlanner');
const { lookupHashRecord, registerHashRecord } = require('./hashIndex');
const { hashFile } = require('./hashService');
const {
  cleanupTempFiles,
  finalizePlainFile,
  resolveLogicalPath,
  verifyStoredPlainFile,
  writePlainFile
} = require('./plainFileStorage');
const {
  ensureScanState,
  markGenerationCompleted,
  saveDiscoveredFolders,
  updateFolderStatus
} = require('./scanManager');
const { listFolderCheckpoints } = require('./scanCheckpointStore');
const { loadSource } = require('./metadataStore');
const { updateSourceScanState } = require('./sourceRegistry');
const { toPosixPath } = require('./layout');
const { shortHash } = require('./ids');

async function readFolderEntries(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const files = [];
  const directories = [];

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      directories.push({ name: entry.name, path: fullPath });
    } else if (entry.isFile()) {
      files.push({ name: entry.name, path: fullPath });
    }
  }

  directories.sort((left, right) => left.name.localeCompare(right.name));
  files.sort((left, right) => left.name.localeCompare(right.name));
  return { directories, files };
}

async function chooseLogicalPath(targetRoot, source, machineId, sourceRelativePath, fileHash, kind, timestamp) {
  const desiredPath = planLogicalTarget({
    machineId,
    source,
    sourceRelativePath,
    kind,
    timestamp
  });

  const desiredAbsolutePath = resolveLogicalPath(targetRoot, desiredPath);
  if (!(await fs.pathExists(desiredAbsolutePath))) {
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

async function processFile(targetRoot, machineId, source, sourceFilePath, sourceRelativePath, stats, now = new Date()) {
  const fileHash = await hashFile(sourceFilePath);
  const kind = classifyMedia(sourceFilePath);
  const logicalPath = await chooseLogicalPath(
    targetRoot,
    source,
    machineId,
    sourceRelativePath,
    fileHash,
    kind,
    new Date(stats.mtimeMs)
  );
  const existing = await lookupHashRecord(targetRoot, fileHash);

  if (!existing) {
    const pendingWrite = await writePlainFile(targetRoot, {
      sourcePath: sourceFilePath,
      logicalPath,
      expectedHash: fileHash,
      expectedSize: stats.size,
      jobId: shortHash(`${machineId}:${source.sourceId}:${sourceRelativePath}:${now.toISOString()}`, 12)
    });
    const content = await finalizePlainFile(targetRoot, pendingWrite);
    const registration = await registerHashRecord(targetRoot, {
      fileHash,
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

    return {
      action: 'copied',
      fileHash,
      logicalPath,
      record: registration.record
    };
  }

  const registration = await registerHashRecord(targetRoot, {
    fileHash,
    size: stats.size,
    logicalPath,
    kind,
    content: existing.content,
    origin: {
      machineId,
      sourceId: source.sourceId,
      sourceRelativePath
    }
  }, now);

  return {
    action: registration.pathStatus === 'alias-added' ? 'indexed-alias' : 'indexed-existing',
    fileHash,
    logicalPath,
    record: registration.record
  };
}

async function backupSource(targetRoot, machineId, sourceId, options = {}) {
  const source = await loadSource(targetRoot, machineId, sourceId);
  if (!source) {
    throw new Error(`Source not found: ${machineId}/${sourceId}`);
  }

  await cleanupTempFiles(targetRoot);

  const stateBundle = await ensureScanState(targetRoot, machineId, sourceId, {
    forceNew: options.forceNewScan,
    now: options.now || new Date()
  });

  const scanId = stateBundle.scanState.activeGeneration;
  const summary = {
    machineId,
    sourceId,
    scanId,
    foldersProcessed: 0,
    filesProcessed: 0,
    filesCopied: 0,
    filesIndexed: 0,
    conflicts: 0
  };

  while (true) {
    const checkpoints = await listFolderCheckpoints(targetRoot, machineId, sourceId, scanId);
    const nextCheckpoint = checkpoints.find((entry) => entry.status === 'pending' || entry.status === 'scanning');
    if (!nextCheckpoint) {
      break;
    }

    const scanningCheckpoint = await updateFolderStatus(
      targetRoot,
      machineId,
      sourceId,
      scanId,
      nextCheckpoint,
      'scanning',
      {
        filesSeen: nextCheckpoint.filesSeen,
        subfoldersSeen: nextCheckpoint.subfoldersSeen
      },
      options.now || new Date()
    );

    const { directories, files } = await readFolderEntries(scanningCheckpoint.folderPath);
    await saveDiscoveredFolders(
      targetRoot,
      machineId,
      sourceId,
      scanId,
      scanningCheckpoint.relativePath,
      directories,
      options.now || new Date()
    );

    for (const fileEntry of files) {
      const sourceRelativePath = scanningCheckpoint.relativePath === '.'
        ? fileEntry.name
        : path.posix.join(scanningCheckpoint.relativePath, fileEntry.name);
      const stats = await fs.stat(fileEntry.path);
      const result = await processFile(
        targetRoot,
        machineId,
        source,
        fileEntry.path,
        toPosixPath(sourceRelativePath),
        stats,
        options.now || new Date()
      );

      summary.filesProcessed += 1;
      if (result.action === 'copied') {
        summary.filesCopied += 1;
      } else {
        summary.filesIndexed += 1;
      }
      if (result.logicalPath.includes(' [')) {
        summary.conflicts += 1;
      }
    }

    await updateFolderStatus(
      targetRoot,
      machineId,
      sourceId,
      scanId,
      scanningCheckpoint,
      'done',
      {
        filesSeen: files.length,
        subfoldersSeen: directories.length
      },
      options.now || new Date()
    );

    summary.foldersProcessed += 1;
  }

  await markGenerationCompleted(targetRoot, machineId, sourceId, options.now || new Date());
  await updateSourceScanState(
    targetRoot,
    machineId,
    sourceId,
    {
      lastCompletedScan: scanId,
      lastCompletedAt: (options.now || new Date()).toISOString()
    },
    options.now || new Date()
  );

  return summary;
}

module.exports = {
  backupSource
};
