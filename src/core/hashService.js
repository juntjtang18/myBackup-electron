const crypto = require('crypto');
const fs = require('fs-extra');

const SMALL_FILE_HASH_BYTES = 256 * 1024;

async function hashFile(filePath, fileSize) {
  let size = fileSize;
  if (size === undefined) {
    const stat = await fs.stat(filePath);
    size = stat.size;
  }

  if (size <= SMALL_FILE_HASH_BYTES) {
    const buffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = {
  SMALL_FILE_HASH_BYTES,
  hashFile
};
