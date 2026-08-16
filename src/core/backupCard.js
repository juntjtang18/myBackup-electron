const fs = require('fs-extra');
const path = require('path');
const { readJsonIfExists, writeJsonAtomic } = require('./jsonStore');
const { toPosixPath } = require('./layout');

const BACKUP_CARD_MD = 'BACKUP.md';
const BACKUP_CARD_JSON = '.mybackup-info.json';
const HISTORY_CAP = 200;
const SCHEMA_VERSION = 1;

function isBackupCardRelativePath(relativePath) {
  const posix = toPosixPath(relativePath).replace(/^\/+/, '');
  return posix === BACKUP_CARD_MD || posix === BACKUP_CARD_JSON;
}

function backupCardJsonPath(backupSetRoot) {
  return path.join(backupSetRoot, BACKUP_CARD_JSON);
}

function backupCardMarkdownPath(backupSetRoot) {
  return path.join(backupSetRoot, BACKUP_CARD_MD);
}

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return String(iso || '');
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function escapeMd(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

function kindLabel(kind, { short = false } = {}) {
  if (kind === 'changes') {
    return short ? 'Changes' : 'Backup Changes';
  }
  return short ? 'Full' : 'Full Backup';
}

function normalizeFailure(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const filePath = String(row.path || '').trim();
  if (!filePath) {
    return null;
  }
  return {
    path: filePath,
    error: String(row.error || '')
  };
}

function buildHistoryRow(scanResult, whenIso) {
  const kind = scanResult?.kind === 'changes' ? 'changes' : 'full';
  const backedUpFileCount = kind === 'changes'
    ? Number(scanResult.filesCopied || scanResult.targetFileCount || 0)
    : Number(scanResult.sourceFileCount || 0);
  const sizeBytes = kind === 'changes'
    ? Number(scanResult.targetSizeBytes || scanResult.sourceSizeBytes || 0)
    : Number(scanResult.sourceSizeBytes || 0);
  return {
    when: whenIso,
    kind,
    backedUpFileCount,
    sizeBytes,
    ignoredFileCount: kind === 'full' ? Number(scanResult.ignoredFileCount || 0) : null,
    failedFileCount: kind === 'full'
      ? Number(scanResult.failedFileCount || 0)
      : Number(scanResult.errors || 0),
    skippedNewerFileCount: kind === 'full'
      ? Number(scanResult.skippedNewerFileCount || 0)
      : 0
  };
}

function normalizeIdentity(identity = {}) {
  return {
    from: String(identity.from || ''),
    hostname: String(identity.hostname || ''),
    machineId: String(identity.machineId || ''),
    folderName: String(identity.folderName || ''),
    includeSourceRoot: identity.includeSourceRoot !== false
  };
}

function normalizeCard(document) {
  if (!document || typeof document !== 'object') {
    return null;
  }
  const history = Array.isArray(document.history)
    ? document.history.filter((row) => row && typeof row === 'object')
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    from: String(document.from || ''),
    machine: {
      hostname: String(document.machine?.hostname || ''),
      machineId: String(document.machine?.machineId || '')
    },
    folderName: String(document.folderName || ''),
    includeSourceRoot: document.includeSourceRoot !== false,
    lastRun: document.lastRun && typeof document.lastRun === 'object' ? document.lastRun : null,
    lastFailures: Array.isArray(document.lastFailures)
      ? document.lastFailures.map(normalizeFailure).filter(Boolean)
      : [],
    history
  };
}

async function loadBackupCard(backupSetRoot) {
  const document = await readJsonIfExists(backupCardJsonPath(backupSetRoot));
  return normalizeCard(document);
}

function renderLastRunLine(lastRun) {
  if (!lastRun) {
    return 'No completed backup yet.';
  }
  const parts = [
    formatWhen(lastRun.when),
    kindLabel(lastRun.kind),
    lastRun.kind === 'changes'
      ? `${Number(lastRun.backedUpFileCount || 0)} files copied`
      : `${Number(lastRun.backedUpFileCount || 0)} files backed up`
  ];
  if (lastRun.kind === 'full') {
    parts.push(`${Number(lastRun.ignoredFileCount || 0)} ignored`);
  }
  parts.push(`${Number(lastRun.failedFileCount || 0)} failed`);
  if (Number(lastRun.skippedNewerFileCount || 0) > 0) {
    parts.push(`${Number(lastRun.skippedNewerFileCount)} skipped newer`);
  }
  return parts.join(' · ');
}

function renderHistoryRow(row) {
  const ignored = row.kind === 'full' ? String(Number(row.ignoredFileCount || 0)) : '—';
  return `| ${formatWhen(row.when)} | ${kindLabel(row.kind, { short: true })} | ${Number(row.backedUpFileCount || 0)} | ${formatBytes(row.sizeBytes)} | ${ignored} | ${Number(row.failedFileCount || 0)} |`;
}

function renderBackupMarkdown(card) {
  const folderName = card.folderName || 'backup';
  const machine = card.machine?.hostname
    ? `${card.machine.hostname} (\`${escapeMd(card.machine.machineId)}\`)`
    : `\`${escapeMd(card.machine?.machineId || '')}\``;
  const layout = card.includeSourceRoot
    ? `append on → this folder is \`${escapeMd(folderName)}/\``
    : 'append off → files are in the target root';
  const lines = [
    `# Backup: ${escapeMd(folderName)}`,
    '',
    `- From: \`${escapeMd(card.from)}\``,
    `- Machine: ${machine}`,
    `- Layout: ${layout}`,
    '',
    '## Last run',
    '',
    renderLastRunLine(card.lastRun),
    '',
    '## History',
    '',
    '| When | Kind | Backed up | Size | Ignored | Failed |',
    '|---|---|---:|---:|---:|---:|'
  ];
  const history = Array.isArray(card.history) ? card.history : [];
  if (history.length === 0) {
    lines.push('| — | — | — | — | — | — |');
  } else {
    history.forEach((row) => {
      lines.push(renderHistoryRow(row));
    });
  }
  if (Array.isArray(card.lastFailures) && card.lastFailures.length > 0) {
    lines.push('', '## Last failures', '');
    card.lastFailures.forEach((row) => {
      const error = row.error ? ` — ${escapeMd(row.error)}` : '';
      lines.push(`- \`${escapeMd(row.path)}\`${error}`);
    });
  }
  lines.push('');
  return lines.join('\n');
}

function buildCardDocument({ existing, identity, scanResult, whenIso }) {
  const nextIdentity = normalizeIdentity(identity);
  const lastRun = buildHistoryRow(scanResult, whenIso);
  const lastFailures = Array.isArray(scanResult?.failed)
    ? scanResult.failed.map(normalizeFailure).filter(Boolean)
    : [];
  const history = [lastRun, ...(existing?.history || [])].slice(0, HISTORY_CAP);
  return {
    schemaVersion: SCHEMA_VERSION,
    from: nextIdentity.from,
    machine: {
      hostname: nextIdentity.hostname,
      machineId: nextIdentity.machineId
    },
    folderName: nextIdentity.folderName,
    includeSourceRoot: nextIdentity.includeSourceRoot,
    lastRun,
    lastFailures,
    history
  };
}

async function writeBackupCard({
  backupSetRoot,
  identity,
  scanResult,
  now = new Date()
}) {
  if (!backupSetRoot) {
    throw new Error('backupSetRoot is required.');
  }
  await fs.ensureDir(backupSetRoot);
  const existing = await loadBackupCard(backupSetRoot);
  const card = buildCardDocument({
    existing,
    identity,
    scanResult,
    whenIso: nowIso(now)
  });
  await writeJsonAtomic(backupCardJsonPath(backupSetRoot), card);
  await fs.writeFile(backupCardMarkdownPath(backupSetRoot), renderBackupMarkdown(card), 'utf8');
  return card;
}

module.exports = {
  BACKUP_CARD_JSON,
  BACKUP_CARD_MD,
  HISTORY_CAP,
  backupCardJsonPath,
  backupCardMarkdownPath,
  buildHistoryRow,
  isBackupCardRelativePath,
  loadBackupCard,
  renderBackupMarkdown,
  writeBackupCard
};
