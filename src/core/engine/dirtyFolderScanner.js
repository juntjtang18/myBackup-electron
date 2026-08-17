const path = require('path');
const { readFolderEntries, safeCallback, scanFolderFiles } = require('./scannerUtils');

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
    const folderDescriptor = {
      folderPath,
      relativePath: folder.relativePath,
      seq: folder.seq,
      changedAt: folder.changedAt
    };

    await safeCallback('onFolder', onFolder, folderDescriptor);

    let entries;
    try {
      entries = await readFolderEntries(folderPath, folder.relativePath, ignoreMatcher);
    } catch (error) {
      summary.skippedFolders += 1;
      await safeCallback('onMissingFolder', onMissingFolder, folderDescriptor, error);
      continue;
    }

    summary.foldersScanned += 1;
    const fileSummary = await scanFolderFiles({
      files: entries.files,
      extraFields: {
        dirtyFolder: folder.relativePath,
        dirtySeq: folder.seq
      },
      shouldAbort,
      enqueueFile,
      onFileError: onMissingFile
    });
    summary.filesEnqueued += fileSummary.filesEnqueued;
    summary.skippedFiles += fileSummary.skippedFiles;
    await safeCallback('onFolderCompleted', onFolderCompleted, folderDescriptor);
  }

  return summary;
}

module.exports = {
  scanDirtyFolders,
  selectDirtyFolders
};
