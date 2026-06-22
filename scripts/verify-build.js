#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`OK: ${message}`);
}

function parseLatestYml(text) {
  const lines = text.split(/\r?\n/);
  const parsed = {};
  for (const line of lines) {
    const pathMatch = line.match(/^path:\s*(.+)$/);
    if (pathMatch) {
      parsed.path = pathMatch[1].trim();
      continue;
    }
    const shaMatch = line.match(/^sha512:\s*(.+)$/);
    if (shaMatch && !parsed.sha512) {
      parsed.sha512 = shaMatch[1].trim();
      continue;
    }
    const sizeMatch = line.match(/^\s*size:\s*(\d+)\s*$/);
    if (sizeMatch && !parsed.size) {
      parsed.size = Number(sizeMatch[1]);
    }
  }
  return parsed;
}

function sha512Base64(filePath) {
  const hasher = crypto.createHash('sha512');
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hasher.digest('base64')));
  });
}

function sha256Hex(filePath) {
  const hasher = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hasher.digest('hex')));
  });
}

function parseSha256Sums(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+(.+)$/);
    if (!match) {
      continue;
    }
    const hash = match[1].toLowerCase();
    const filePath = match[2].trim();
    map.set(path.basename(filePath), hash);
  }
  return map;
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const distDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(rootDir, 'dist');

  if (!fs.existsSync(distDir)) {
    fail(`dist directory not found: ${distDir}`);
  }
  info(`dist directory exists: ${distDir}`);

  const latestYmlPath = path.join(distDir, 'latest.yml');
  if (!fs.existsSync(latestYmlPath)) {
    fail(`latest.yml not found in ${distDir}`);
  }
  const latest = parseLatestYml(fs.readFileSync(latestYmlPath, 'utf8'));
  if (!latest.path || !latest.sha512 || !Number.isFinite(latest.size)) {
    fail('latest.yml missing required fields (path, sha512, size)');
  }
  info('latest.yml contains path, sha512, and size');

  const installerPath = path.join(distDir, latest.path);
  if (!fs.existsSync(installerPath)) {
    fail(`installer not found: ${installerPath}`);
  }
  const installerStat = fs.statSync(installerPath);
  if (installerStat.size !== latest.size) {
    fail(`installer size mismatch: expected ${latest.size}, actual ${installerStat.size}`);
  }
  info(`installer size matches latest.yml (${latest.size})`);

  const computedSha512 = await sha512Base64(installerPath);
  if (computedSha512 !== latest.sha512) {
    fail('installer sha512 mismatch against latest.yml');
  }
  info('installer sha512 matches latest.yml');

  const blockMapPath = `${installerPath}.blockmap`;
  if (!fs.existsSync(blockMapPath)) {
    fail(`blockmap missing: ${blockMapPath}`);
  }
  try {
    zlib.gunzipSync(fs.readFileSync(blockMapPath));
  } catch (error) {
    fail(`blockmap gzip validation failed: ${error.message}`);
  }
  info('blockmap is valid gzip payload');

  const sumsPath = path.join(distDir, 'SHA256SUMS.txt');
  if (!fs.existsSync(sumsPath)) {
    fail(`SHA256SUMS.txt missing: ${sumsPath}`);
  }
  const checksums = parseSha256Sums(fs.readFileSync(sumsPath, 'utf8'));
  const installerBase = path.basename(installerPath);
  const blockMapBase = path.basename(blockMapPath);
  if (!checksums.has(installerBase)) {
    fail(`SHA256SUMS missing installer entry for ${installerBase}`);
  }
  if (!checksums.has(blockMapBase)) {
    fail(`SHA256SUMS missing blockmap entry for ${blockMapBase}`);
  }
  const installerSha256 = await sha256Hex(installerPath);
  if (installerSha256 !== checksums.get(installerBase)) {
    fail('installer sha256 mismatch against SHA256SUMS.txt');
  }
  const blockMapSha256 = await sha256Hex(blockMapPath);
  if (blockMapSha256 !== checksums.get(blockMapBase)) {
    fail('blockmap sha256 mismatch against SHA256SUMS.txt');
  }
  info('SHA256SUMS entries match installer and blockmap');

  console.log('PASS: build artifact integrity checks completed');
}

main().catch((error) => {
  fail(error && error.message ? error.message : String(error));
});

