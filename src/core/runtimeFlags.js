const fs = require('fs-extra');
const path = require('path');

const RUNTIME_FLAGS_FILE = 'myBackup.ini';

function parseBoolean(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseRuntimeFlags(content) {
  const flags = {};
  const lines = String(content || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if (key === 'traceProgressUi' || key === 'trace.progress.ui') {
      flags.traceProgressUi = parseBoolean(value, flags.traceProgressUi);
    }

    if (
      key === 'showProgressQueueDetails'
      || key === 'progress.showQueueDetails'
      || key === 'progress.queueDetails'
    ) {
      flags.showProgressQueueDetails = parseBoolean(value, flags.showProgressQueueDetails);
    }
  }

  return flags;
}

async function loadRuntimeFlags(options = {}) {
  const defaults = {
    traceProgressUi: true,
    showProgressQueueDetails: false
  };

  const candidates = [
    options.appPath ? path.join(path.resolve(options.appPath), RUNTIME_FLAGS_FILE) : null,
    options.cwd ? path.join(path.resolve(options.cwd), RUNTIME_FLAGS_FILE) : null,
    options.appDataRoot ? path.join(path.resolve(options.appDataRoot), RUNTIME_FLAGS_FILE) : null
  ].filter(Boolean);

  const flags = { ...defaults };
  for (const filePath of Array.from(new Set(candidates))) {
    if (!(await fs.pathExists(filePath))) {
      continue;
    }
    const parsed = parseRuntimeFlags(await fs.readFile(filePath, 'utf8'));
    Object.assign(flags, parsed);
  }

  return flags;
}

module.exports = {
  RUNTIME_FLAGS_FILE,
  loadRuntimeFlags,
  parseRuntimeFlags
};
