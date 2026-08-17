const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

function runCommand(command, args) {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return output || null;
  } catch (_error) {
    return null;
  }
}

function normalizeComputerName(value) {
  const trimmed = String(value || '').trim().replace(/^["']|["']$/g, '').replace(/\.local$/i, '');
  return trimmed || null;
}

function readFileName(filePath) {
  try {
    return normalizeComputerName(fs.readFileSync(filePath, 'utf8').split(/\r?\n/)[0]);
  } catch (_error) {
    return null;
  }
}

function readLinuxPrettyHostname() {
  const fromCtl = normalizeComputerName(runCommand('hostnamectl', ['--pretty']));
  if (fromCtl) {
    return fromCtl;
  }
  try {
    const text = fs.readFileSync('/etc/machine-info', 'utf8');
    const match = text.match(/^PRETTY_HOSTNAME=(.*)$/m);
    return match ? normalizeComputerName(match[1]) : null;
  } catch (_error) {
    return null;
  }
}

function readDarwinComputerName() {
  return normalizeComputerName(runCommand('scutil', ['--get', 'ComputerName']))
    || normalizeComputerName(runCommand('scutil', ['--get', 'LocalHostName']))
    || normalizeComputerName(os.hostname());
}

function readWindowsComputerName() {
  return normalizeComputerName(process.env.COMPUTERNAME)
    || normalizeComputerName(runCommand('hostname', []))
    || normalizeComputerName(os.hostname());
}

function readLinuxComputerName() {
  return readLinuxPrettyHostname()
    || normalizeComputerName(runCommand('hostname', ['-s']))
    || normalizeComputerName(runCommand('hostname', []))
    || readFileName('/etc/hostname')
    || normalizeComputerName(os.hostname());
}

function readOsComputerName() {
  if (process.platform === 'darwin') {
    return readDarwinComputerName() || 'computer';
  }
  if (process.platform === 'win32') {
    return readWindowsComputerName() || 'computer';
  }
  return readLinuxComputerName() || 'computer';
}

module.exports = {
  normalizeComputerName,
  readOsComputerName
};
