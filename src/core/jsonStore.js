const path = require('path');
const fs = require('fs-extra');

async function readJson(filePath, validator) {
  const document = await fs.readJson(filePath);
  return validator ? validator(document) : document;
}

async function readJsonIfExists(filePath, validator) {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }
  return readJson(filePath, validator);
}

async function writeJsonAtomic(filePath, document) {
  const parentDir = path.dirname(filePath);
  const tempPath = path.join(parentDir, `${path.basename(filePath)}.tmp`);

  await fs.ensureDir(parentDir);
  await fs.writeJson(tempPath, document, { spaces: 2 });
  await fs.move(tempPath, filePath, { overwrite: true });
}

module.exports = {
  readJson,
  readJsonIfExists,
  writeJsonAtomic
};
