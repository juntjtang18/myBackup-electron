const path = require('path');
const { readFolderEntries, isMissingPathError, statFile } = require('./scannerUtils');

function selectDirtyFolders(dirtyState, scanSeq, resumeFrom = null) {
  const selected = Object.entries((dirtyState && dirtyState.folders) || {})
    .filter(([, entry]) => entry.seq <= scanSeq)
    .map(([relativePath, entry]) => ({
      relativePath,
      seq: entry.seq,
      changedAt: entry.changedAt
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  if (!resumeFrom) {
    return selected;
  }

  const startIndex = selected.findIndex((entry) => entry.relativePath === resumeFrom);
  return startIndex >= 0 ? selected.slice(startIndex) : selected;
}

async function scanDirtyFolders(options) {
  const sourcePath = options.sourcePath;
  const dirtyState = options.dirtyState || { folders: {} };
  const scanSeq = options.scanSeq;
  const resumeFrom = options.resumeFrom || null;
  const ignoreMatcher = options.ignoreMatcher || null;
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false;
  const enqueueFile = typeof options.enqueueFile === 'function' ? options.enqueueFile : async () => {};
  const onFolder = typeof options.onFolder === 'function' ? options.onFolder : async () => {};
  const onFolderCompleted = typeof options.onFolderCompleted === 'function' ? options.onFolderCompleted : async () => {};
  const onMissingFolder = typeof options.onMissingFolder === 'function' ? options.onMissingFolder : async () => {};
  const onMissingFile = typeof options.onMissingFile === 'function' ? options.onMissingFile : async () => {};

  if (!Number.isInteger(scanSeq) || scanSeq < 0) {
    throw new Error('scanSeq must be a non-negative integer.');
  }

  const selectedFolders = selectDirtyFolders(dirtyState, scanSeq, resumeFrom);
  const summary = {
    mode: 'incremental',
    scanSeq,
    selectedFolders: selectedFolders.map((entry) => entry.relativePath),
    foldersScanned: 0,
    filesEnqueued: 0,
    skippedFolders: 0,
    skippedFiles: 0
  };

  for (const folder of selectedFolders) {
    if (shouldAbort()) {
      break;
    }

    const folderPath = folder.relativePath === '.'
      ? path.resolve(sourcePath)
      : path.join(path.resolve(sourcePath), ...folder.relativePath.split('/'));

    await onFolder({
      folderPath,
      relativePath: folder.relativePath,
      seq: folder.seq,
      changedAt: folder.changedAt
    });

    let entries;
    try {
      entries = await readFolderEntries(folderPath, folder.relativePath, ignoreMatcher);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      summary.skippedFolders += 1;
      await onMissingFolder({
        folderPath,
        relativePath: folder.relativePath,
        seq: folder.seq,
        changedAt: folder.changedAt
      }, error);
      continue;
    }

    summary.foldersScanned += 1;
    const folderTasks = [];

    for (const fileEntry of entries.files) {
      if (shouldAbort()) {
        break;
      }

      let stats;
      try {
        stats = await statFile(fileEntry.path);
      } catch (error) {
        summary.skippedFiles += 1;
        await onMissingFile(fileEntry, error);
        continue;
      }

      folderTasks.push(await enqueueFile({
        sourceFilePath: fileEntry.path,
        sourceRelativePath: fileEntry.relativePath,
        stats,
        dirtyFolder: folder.relativePath,
        dirtySeq: folder.seq
      }));
      summary.filesEnqueued += 1;
    }

    await Promise.allSettled(folderTasks);
    await onFolderCompleted({
      folderPath,
      relativePath: folder.relativePath,
      seq: folder.seq,
      changedAt: folder.changedAt
    });
  }

  return summary;
}

module.exports = {
  scanDirtyFolders,
  selectDirtyFolders
};
