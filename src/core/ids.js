const crypto = require('crypto');
const path = require('path');

function sanitizeSegment(value) {
  return String(value || 'item')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'item';
}

function shortHash(value, length = 8) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, length);
}

function createMachineId(hostname, seed) {
  return `${sanitizeSegment(hostname || 'machine')}-${shortHash(seed || hostname || 'machine')}`;
}

function createSourceId(sourcePath) {
  const normalizedPath = path.resolve(sourcePath || '.');
  const name = path.basename(normalizedPath) || 'source';
  return `${sanitizeSegment(name)}-${shortHash(normalizedPath)}`;
}

function createScanId(date = new Date()) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function createFolderId(relativePath) {
  const stablePath = String(relativePath || '.').replace(/\\/g, '/');
  const base = stablePath === '.' ? 'root' : stablePath.split('/').filter(Boolean).pop() || 'folder';
  return `${sanitizeSegment(base)}-${shortHash(stablePath, 10)}`;
}

module.exports = {
  createFolderId,
  createMachineId,
  createScanId,
  createSourceId,
  sanitizeSegment,
  shortHash
};
