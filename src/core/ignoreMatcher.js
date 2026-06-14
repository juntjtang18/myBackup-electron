const path = require('path');
const fs = require('fs-extra');
const { toPosixPath } = require('./layout');

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/',
  'bower_components/',
  'jspm_packages/',
  'vendor/',
  '.DS_Store',
  '._*',
  'Thumbs.db',
  'Desktop.ini',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.tox/',
  '.venv/',
  'venv/',
  'Pods/',
  '.git/',
  '.svn/',
  '.hg/'
];

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
    if (rule.directoryOnly && !isDirectory && normalizedPath !== rule.normalized) {
      continue;
    }

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

async function loadIgnoreMatcher(sourceRoot) {
  const ignorePath = path.join(sourceRoot, '.mbignore');
  let userContent = '';
  if (await fs.pathExists(ignorePath)) {
    userContent = await fs.readFile(ignorePath, 'utf8');
  }

  return createIgnoreMatcher(buildIgnoreRules(userContent));
}

module.exports = {
  DEFAULT_IGNORE_PATTERNS,
  buildIgnoreRules,
  createIgnoreMatcher,
  loadIgnoreMatcher,
  parseIgnoreFile,
  shouldIgnorePath
};
