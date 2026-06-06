const { createScanId } = require('../ids');
const { readJsonIfExists, writeJsonAtomic } = require('../jsonStore');
const { resumeManifestPath } = require('./resumePaths');

const MANIFEST_VERSION = 1;

function normalizeDate(value, fallback = new Date()) {
  if (!value) {
    return fallback.toISOString();
  }
  return value.toISOString ? value.toISOString() : value;
}

function validateResumeManifest(document) {
  if (!document || document.version !== MANIFEST_VERSION) {
    throw new Error('Unsupported resume manifest version.');
  }
  if (!document.backupId || !document.machineId || !document.sourceId) {
    throw new Error('Invalid resume manifest.');
  }
  return document;
}

function createResumeManifest(input = {}, now = new Date()) {
  return {
    version: MANIFEST_VERSION,
    machineId: input.machineId,
    sourceId: input.sourceId,
    backupId: input.backupId || createScanId(now),
    startedAt: normalizeDate(input.startedAt, now),
    status: input.status || 'running',
    cursor: input.cursor || null,
    updatedAt: normalizeDate(input.updatedAt, now)
  };
}

async function loadResumeManifest(targetRoot, machineId, sourceId) {
  return readJsonIfExists(
    resumeManifestPath(targetRoot, machineId, sourceId),
    validateResumeManifest
  );
}

async function saveResumeManifest(targetRoot, manifest) {
  validateResumeManifest(manifest);
  await writeJsonAtomic(
    resumeManifestPath(targetRoot, manifest.machineId, manifest.sourceId),
    manifest
  );
  return manifest;
}

module.exports = {
  MANIFEST_VERSION,
  createResumeManifest,
  loadResumeManifest,
  saveResumeManifest,
  validateResumeManifest
};
