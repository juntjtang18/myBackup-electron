const fs = require('fs-extra');
const path = require('path');

function restoreJobsRoot(appDataRoot) {
  return path.join(appDataRoot, 'restore-jobs');
}

function restoreJobPath(appDataRoot, sourceId) {
  return path.join(restoreJobsRoot(appDataRoot), `${sourceId}.json`);
}

async function loadRestoreJob(appDataRoot, sourceId) {
  const filePath = restoreJobPath(appDataRoot, sourceId);
  if (!(await fs.pathExists(filePath))) {
    return null;
  }
  try {
    return await fs.readJson(filePath);
  } catch (_error) {
    return null;
  }
}

async function saveRestoreJob(appDataRoot, sourceId, job) {
  const filePath = restoreJobPath(appDataRoot, sourceId);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, job, { spaces: 2 });
  return job;
}

async function clearRestoreJob(appDataRoot, sourceId) {
  const filePath = restoreJobPath(appDataRoot, sourceId);
  await fs.remove(filePath);
}

module.exports = {
  clearRestoreJob,
  loadRestoreJob,
  saveRestoreJob
};
