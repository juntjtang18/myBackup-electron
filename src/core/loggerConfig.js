const fs = require('fs-extra');
const path = require('path');
const { normalizeLevel } = require('./logger');

const LOGGER_CONFIG_FILE = 'mybackup-logging.properties';

function getLoggerConfigPath(appDataRoot) {
  return path.join(path.resolve(appDataRoot), LOGGER_CONFIG_FILE);
}

function parseLoggerProperties(content, sourcePath) {
  const result = {
    level: null,
    moduleLevels: {},
    warnings: []
  };

  const lines = String(content || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index].trim();
    if (!rawLine || rawLine.startsWith('#') || rawLine.startsWith(';')) {
      continue;
    }

    const separatorIndex = rawLine.indexOf('=');
    if (separatorIndex < 0) {
      result.warnings.push(`${sourcePath}:${index + 1} ignored line without '='.`);
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    const value = rawLine.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    try {
      if (key === 'logger' || key === 'logger.level' || key === 'log.level' || key === 'app.logger') {
        result.level = normalizeLevel(value);
        continue;
      }

      if (key.endsWith('.logger')) {
        const moduleName = key.slice(0, -'.logger'.length).trim();
        if (!moduleName) {
          continue;
        }
        result.moduleLevels[moduleName] = normalizeLevel(value);
      }
    } catch (error) {
      result.warnings.push(`${sourcePath}:${index + 1} ${error.message}`);
    }
  }

  return result;
}

async function readLoggerConfigFile(filePath) {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  const content = await fs.readFile(filePath, 'utf8');
  const parsed = parseLoggerProperties(content, filePath);
  return {
    ...parsed,
    sourcePath: filePath
  };
}

function mergeLoggerConfig(target, source) {
  if (!source) {
    return target;
  }

  if (source.level) {
    target.level = source.level;
  }

  for (const [moduleName, level] of Object.entries(source.moduleLevels || {})) {
    target.moduleLevels[moduleName] = level;
  }

  target.sources.push(source.sourcePath);
  target.warnings.push(...(source.warnings || []));
  return target;
}

async function loadLoggerConfig(appDataRoot, options = {}) {
  const candidates = [
    options.appPath ? path.join(path.resolve(options.appPath), LOGGER_CONFIG_FILE) : null,
    options.cwd ? path.join(path.resolve(options.cwd), LOGGER_CONFIG_FILE) : null,
    getLoggerConfigPath(appDataRoot)
  ].filter(Boolean);

  const uniqueCandidates = Array.from(new Set(candidates));
  const result = {
    level: null,
    moduleLevels: {},
    sources: [],
    warnings: []
  };

  for (const filePath of uniqueCandidates) {
    const loaded = await readLoggerConfigFile(filePath);
    mergeLoggerConfig(result, loaded);
  }

  return result;
}

module.exports = {
  LOGGER_CONFIG_FILE,
  getLoggerConfigPath,
  loadLoggerConfig,
  parseLoggerProperties,
  readLoggerConfigFile
};
