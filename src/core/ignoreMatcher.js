const path = require('path');
const fs = require('fs-extra');
const { toPosixPath } = require('./layout');

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

async function loadIgnoreMatcher(sourceRoot) {
  const ignorePath = path.join(sourceRoot, '.mbignore');
  if (!(await fs.pathExists(ignorePath))) {
    return {
      rules: [],
      shouldIgnore: () => false
    };
  }

  const content = await fs.readFile(ignorePath, 'utf8');
  const rules = parseIgnoreFile(content);

  return {
    rules,
    shouldIgnore(relativePath, isDirectory) {
      return shouldIgnorePath(rules, relativePath, isDirectory);
    }
  };
}

module.exports = {
  loadIgnoreMatcher,
  parseIgnoreFile,
  shouldIgnorePath
};
