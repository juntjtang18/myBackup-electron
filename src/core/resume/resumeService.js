const { createResumeCursor } = require('./resumeCursor');
const { createFolderProgress, saveFolderProgress } = require('./folderProgress');
const { createResumeManifest, loadResumeManifest, saveResumeManifest } = require('./resumeManifest');
const { walkFoldersFromCursor } = require('./resumeWalker');

async function startResumeRun(targetRoot, machineId, sourceId, sourcePath, options = {}) {
  const now = options.now || new Date();
  let manifest = options.forceNew ? null : await loadResumeManifest(targetRoot, machineId, sourceId);

  if (!manifest || manifest.status === 'completed') {
    manifest = createResumeManifest({
      machineId,
      sourceId,
      backupId: options.backupId,
      status: 'running',
      cursor: null
    }, now);
  } else {
    manifest = createResumeManifest({
      ...manifest,
      status: 'running',
      updatedAt: now
    }, now);
  }

  await saveResumeManifest(targetRoot, manifest);

  return {
    backupId: manifest.backupId,
    cursor: manifest.cursor,
    manifest,
    folders: walkFoldersFromCursor(sourcePath, manifest.cursor, {
      ignoreMatcher: options.ignoreMatcher || null
    }),
    resumed: Boolean(manifest.cursor)
  };
}

async function saveResumeCursor(targetRoot, machineId, sourceId, backupId, cursor, options = {}) {
  const now = options.now || new Date();
  const existing = await loadResumeManifest(targetRoot, machineId, sourceId);
  const manifest = createResumeManifest({
    ...(existing || { machineId, sourceId, backupId }),
    machineId,
    sourceId,
    backupId,
    status: options.status || existing?.status || 'running',
    cursor: cursor ? createResumeCursor({ ...cursor, updatedAt: now }) : null,
    updatedAt: now
  }, now);

  await saveResumeManifest(targetRoot, manifest);
  return manifest;
}

async function markResumeFolder(targetRoot, machineId, sourceId, backupId, folder, status, metrics = {}, now = new Date()) {
  const progress = createFolderProgress({
    backupId,
    folderHash: folder.folderHash,
    parentHash: folder.parentHash || null,
    relativePath: folder.relativePath,
    folderPath: folder.folderPath,
    status,
    filesSeen: metrics.filesSeen || 0,
    filesDone: metrics.filesDone || 0,
    childrenSeen: metrics.childrenSeen || 0,
    childrenDone: metrics.childrenDone || 0,
    updatedAt: now
  }, now);
  await saveFolderProgress(targetRoot, machineId, sourceId, progress);
  return progress;
}

async function pauseResumeRun(targetRoot, machineId, sourceId, backupId, cursor, now = new Date()) {
  return saveResumeCursor(targetRoot, machineId, sourceId, backupId, cursor, {
    status: 'paused',
    now
  });
}

async function completeResumeRun(targetRoot, machineId, sourceId, backupId, cursor, now = new Date()) {
  return saveResumeCursor(targetRoot, machineId, sourceId, backupId, cursor, {
    status: 'completed',
    now
  });
}

module.exports = {
  completeResumeRun,
  markResumeFolder,
  pauseResumeRun,
  saveResumeCursor,
  startResumeRun,
  walkFoldersFromCursor
};
