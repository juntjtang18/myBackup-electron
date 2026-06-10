const crypto = require('crypto');
const fs = require('fs-extra');

const SMALL_FILE_HASH_BYTES = 256 * 1024;
const PAUSE_CANCELLED_RESULT = Object.freeze({ cancelled: true, code: 'PAUSE_CANCELLED' });

function createPauseCancelledError() {
  const error = new Error('Hash cancelled.');
  error.code = 'PAUSE_CANCELLED';
  return error;
}

function createPauseCancelledResult() {
  return PAUSE_CANCELLED_RESULT;
}

function isPauseCancelledResult(value) {
  return value === PAUSE_CANCELLED_RESULT
    || Boolean(value && value.cancelled === true && value.code === 'PAUSE_CANCELLED');
}

function shouldAbortHash(options) {
  return Boolean(options && typeof options.shouldAbort === 'function' && options.shouldAbort());
}

async function hashFile(filePath, fileSize, options = {}) {
  let size = fileSize;
  if (size === undefined) {
    const stat = await fs.stat(filePath);
    size = stat.size;
  }

  if (shouldAbortHash(options)) {
    return createPauseCancelledResult();
  }

  if (size <= SMALL_FILE_HASH_BYTES) {
    const buffer = await fs.readFile(filePath);
    if (shouldAbortHash(options)) {
      return createPauseCancelledResult();
    }
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    let settled = false;
    let aborted = false;

    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      stream.destroy();
      reject(error);
    }

    stream.on('data', (chunk) => {
      if (shouldAbortHash(options)) {
        aborted = true;
        stream.destroy();
        return;
      }
      hash.update(chunk);
    });
    stream.on('error', (error) => {
      if (aborted) {
        return;
      }
      fail(error);
    });
    stream.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(hash.digest('hex'));
    });
    stream.on('close', () => {
      if (!aborted || settled) {
        return;
      }
      settled = true;
      resolve(createPauseCancelledResult());
    });
  });
}

module.exports = {
  createPauseCancelledResult,
  createPauseCancelledError,
  isPauseCancelledResult,
  SMALL_FILE_HASH_BYTES,
  hashFile
};
