const path = require('path');
const fs = require('fs-extra');
const { toPosixPath } = require('./layout');
const { sanitizeSegment } = require('./ids');

const DEFAULT_IGNORE_PATTERNS = [
  '.DS_Store',
  '._*',
  'Thumbs.db',
  'Desktop.ini'
];

const SOURCE_IGNORE_TEMPLATE = [
  '# Temporary files',
  '*.tmp',
  '*.temp',
  '~$*',
  '',
  '# System files',
  '.DS_Store',
  '._*',
  'Thumbs.db',
  'Desktop.ini',
  '',
  '# OS metadata',
  '.Spotlight-V100/',
  '.Trashes/',
  '.fseventsd/',
  '',
  '# VCS metadata',
  '.git/',
  ''
].join('\n');

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(glob) {
  let pattern = '';

  for (let index = 0; index < glob.length; index += 1) {
    const current = glob[index];
    const next = glob[index + 1];

    if (current === '*') {
      if (next === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
      continue;
    }

    if (current === '?') {
      pattern += '[^/]';
      continue;
    }

    pattern += escapeRegex(current);
  }

  return pattern;
}

function normalizePattern(rawPattern) {
  const negated = rawPattern.startsWith('!');
  const candidate = negated ? rawPattern.slice(1) : rawPattern;
  const trimmed = candidate.trim();
  const directoryOnly = trimmed.endsWith('/');
  const body = directoryOnly ? trimmed.slice(0, -1) : trimmed;
  const normalized = toPosixPath(body);
  const rooted = normalized.includes('/');

  return {
    negated,
    directoryOnly,
    rooted,
    original: rawPattern,
    normalized
  };
}

function compileRule(rawPattern) {
  const normalized = normalizePattern(rawPattern);
  if (!normalized.normalized) {
    return null;
  }

  let regexSource;
  if (normalized.rooted) {
    regexSource = `^${globToRegex(normalized.normalized)}(?:/.*)?$`;
    if (!normalized.directoryOnly) {
      regexSource = `^${globToRegex(normalized.normalized)}$`;
    }
  } else if (normalized.directoryOnly) {
    regexSource = `(?:^|/)${globToRegex(normalized.normalized)}(?:/.*)?$`;
  } else {
    regexSource = `(?:^|/)${globToRegex(normalized.normalized)}$`;
  }

  return {
    ...normalized,
    regex: new RegExp(regexSource)
  };
}

function parseIgnoreFile(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(compileRule)
    .filter(Boolean);
}

function shouldIgnorePath(rules, relativePath, isDirectory) {
  const normalizedPath = toPosixPath(relativePath || '');
  let ignored = false;

  for (const rule of rules) {
    if (!rule.regex.test(normalizedPath)) {
      continue;
    }

    ignored = !rule.negated;
  }

  return ignored;
}

function buildIgnoreRules(content = '') {
  const defaultRules = parseIgnoreFile(DEFAULT_IGNORE_PATTERNS.join('\n'));
  const userRules = content ? parseIgnoreFile(content) : [];
  return [...defaultRules, ...userRules];
}

function createIgnoreMatcher(rules) {
  return {
    rules,
    shouldIgnore(relativePath, isDirectory) {
      return shouldIgnorePath(rules, relativePath, isDirectory);
    }
  };
}

function getSourceIgnoreDirectory(appDataRoot) {
  if (!appDataRoot) {
    return null;
  }
  return path.join(path.resolve(appDataRoot), 'ignore-rules');
}

function resolveSourceIgnorePath(appDataRoot, source) {
  const directory = getSourceIgnoreDirectory(appDataRoot);
  if (!directory || !source?.sourceId) {
    return null;
  }
  const machinePart = sanitizeSegment(source.machineId || 'machine');
  const sourcePart = sanitizeSegment(source.sourceId);
  return path.join(directory, `${machinePart}--${sourcePart}.mbignore`);
}

async function ensureSourceIgnoreFile(appDataRoot, source, template = SOURCE_IGNORE_TEMPLATE) {
  const ignorePath = resolveSourceIgnorePath(appDataRoot, source);
  if (!ignorePath) {
    return null;
  }
  await fs.ensureDir(path.dirname(ignorePath));
  if (!(await fs.pathExists(ignorePath))) {
    await fs.writeFile(ignorePath, template, 'utf8');
  }
  return ignorePath;
}

async function readSourceIgnoreFile(appDataRoot, source) {
  const ignorePath = await ensureSourceIgnoreFile(appDataRoot, source);
  if (!ignorePath) {
    return {
      ignorePath: null,
      rulesText: SOURCE_IGNORE_TEMPLATE,
      defaultTemplate: SOURCE_IGNORE_TEMPLATE
    };
  }

  return {
    ignorePath,
    rulesText: await fs.readFile(ignorePath, 'utf8'),
    defaultTemplate: SOURCE_IGNORE_TEMPLATE
  };
}

async function writeSourceIgnoreFile(appDataRoot, source, rulesText) {
  const ignorePath = await ensureSourceIgnoreFile(appDataRoot, source);
  if (!ignorePath) {
    throw new Error('Source ignore file path is unavailable.');
  }
  const normalized = String(rulesText || '').replace(/\r\n/g, '\n');
  await fs.writeFile(ignorePath, normalized, 'utf8');
  return {
    ignorePath,
    rulesText: normalized,
    defaultTemplate: SOURCE_IGNORE_TEMPLATE
  };
}

async function loadIgnoreMatcher(sourceRoot, options = {}) {
  const parts = [];
  const sourceSpecificIgnorePath = resolveSourceIgnorePath(options.appDataRoot, options.source);

  if (sourceSpecificIgnorePath && await fs.pathExists(sourceSpecificIgnorePath)) {
    parts.push(await fs.readFile(sourceSpecificIgnorePath, 'utf8'));
  } else {
    const legacyIgnorePath = path.join(sourceRoot, '.mbignore');
    if (await fs.pathExists(legacyIgnorePath)) {
      parts.push(await fs.readFile(legacyIgnorePath, 'utf8'));
    }
  }

  return createIgnoreMatcher(buildIgnoreRules(parts.join('\n')));
}

module.exports = {
  DEFAULT_IGNORE_PATTERNS,
  SOURCE_IGNORE_TEMPLATE,
  buildIgnoreRules,
  createIgnoreMatcher,
  ensureSourceIgnoreFile,
  loadIgnoreMatcher,
  parseIgnoreFile,
  readSourceIgnoreFile,
  resolveSourceIgnorePath,
  shouldIgnorePath,
  writeSourceIgnoreFile
};
