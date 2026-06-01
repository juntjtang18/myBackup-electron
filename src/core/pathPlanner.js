const path = require('path');
const { IMAGES_ROOT, VIDEOS_ROOT, toPosixPath } = require('./layout');
const { sanitizeSegment } = require('./ids');

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.webp', '.tif', '.tiff',
  '.bmp', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.rw2', '.dng'
]);

const VIDEO_EXTENSIONS = new Set([
  '.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv', '.flv', '.mpeg', '.mpg',
  '.webm', '.3gp', '.mts', '.m2ts', '.vob', '.ogv'
]);

function classifyMedia(filePath) {
  const extension = path.extname(filePath || '').toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }
  return 'file';
}

function getDayParts(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return {
    year,
    day: `${year}-${month}-${day}`
  };
}

function buildConflictPath(logicalPath, machineId, sourceId) {
  const extension = path.posix.extname(logicalPath);
  const basename = path.posix.basename(logicalPath, extension);
  const directory = path.posix.dirname(logicalPath);
  const suffix = sanitizeSegment(`${machineId}-${sourceId}`);
  return path.posix.join(directory, `${basename} [${suffix}]${extension}`);
}

function planLogicalTarget(input) {
  const machineId = input.machineId;
  const source = input.source;
  const sourceRelativePath = toPosixPath(input.sourceRelativePath || '');
  const fileName = path.posix.basename(sourceRelativePath);
  const kind = input.kind || classifyMedia(sourceRelativePath);

  if (source.organizeMedia && (kind === 'image' || kind === 'video')) {
    const dayParts = getDayParts(input.timestamp || new Date());
    if (source.mergeEnabled) {
      const mergeRoot = kind === 'video' ? VIDEOS_ROOT : IMAGES_ROOT;
      return path.posix.join(mergeRoot, dayParts.year, dayParts.day, source.mergeKey, fileName);
    }

    const mediaRoot = kind === 'video' ? VIDEOS_ROOT : IMAGES_ROOT;
    return path.posix.join(mediaRoot, dayParts.year, dayParts.day, machineId, source.sourceId, fileName);
  }

  if (source.mergeEnabled) {
    return path.posix.join(source.targetSubdir, sourceRelativePath);
  }

  return path.posix.join(source.targetSubdir, sourceRelativePath);
}

module.exports = {
  buildConflictPath,
  classifyMedia,
  getDayParts,
  planLogicalTarget
};
