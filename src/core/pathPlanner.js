const path = require('path');
const { toPosixPath } = require('./layout');
const { sanitizeSegment } = require('./ids');

function buildConflictPath(logicalPath, machineId, sourceId) {
  const extension = path.posix.extname(logicalPath);
  const basename = path.posix.basename(logicalPath, extension);
  const directory = path.posix.dirname(logicalPath);
  const suffix = sanitizeSegment(`${machineId}-${sourceId}`);
  return path.posix.join(directory, `${basename} [${suffix}]${extension}`);
}

function normalizeTargetFolder(targetFolder) {
  const raw = typeof targetFolder === 'string' ? targetFolder.trim() : '';
  if (!raw || raw === '.' || raw === path.sep || raw === path.posix.sep) {
    return '';
  }

  const normalized = toPosixPath(raw).replace(/^\/+/, '');
  if (!normalized || normalized === '.') {
    return '';
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('targetFolder must stay inside the selected backup target.');
  }

  return segments.join('/');
}

function getSourceFolderName(source) {
  if (source && typeof source.folderName === 'string' && source.folderName.trim()) {
    return source.folderName.trim();
  }
  return path.basename(path.resolve(source.sourcePath || '')) || source.sourceId;
}

function shouldIncludeSourceRoot(source) {
  if (!source || typeof source !== 'object') {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'includeSourceRoot')) {
    return Boolean(source.includeSourceRoot);
  }
  return true;
}

function getSourceTargetRoot(_machineId, source) {
  if (source && source.relativeRoot !== undefined && source.relativeRoot !== null) {
    return normalizeTargetFolder(source.relativeRoot);
  }
  const targetFolder = normalizeTargetFolder(source.targetFolder);
  if (!shouldIncludeSourceRoot(source)) {
    return targetFolder;
  }
  const sourceFolderName = getSourceFolderName(source);
  return targetFolder
    ? path.posix.join(targetFolder, sourceFolderName)
    : sourceFolderName;
}

function planLogicalTarget(input) {
  const sourceRelativePath = toPosixPath(input.sourceRelativePath || '');
  return path.posix.join(getSourceTargetRoot(input.machineId, input.source), sourceRelativePath);
}

module.exports = {
  buildConflictPath,
  getSourceFolderName,
  getSourceTargetRoot,
  normalizeTargetFolder,
  planLogicalTarget,
  shouldIncludeSourceRoot
};
