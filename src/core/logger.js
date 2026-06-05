const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100
};

const state = {
  level: 'info',
  sink: null,
  moduleLevels: new Map()
};

function normalizeLevel(level) {
  const normalized = String(level || 'info').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LEVELS, normalized)) {
    throw new Error(`Unsupported log level: ${level}`);
  }
  return normalized;
}

function resolveModuleLevel(moduleName, moduleLevel) {
  if (moduleLevel !== undefined && moduleLevel !== null) {
    return normalizeLevel(moduleLevel);
  }

  if (state.moduleLevels.has(moduleName)) {
    return state.moduleLevels.get(moduleName);
  }

  return state.level;
}

function shouldLog(level, thresholdLevel) {
  const normalizedThreshold = normalizeLevel(thresholdLevel);
  return LEVELS[normalizeLevel(level)] >= LEVELS[normalizedThreshold] && normalizedThreshold !== 'off';
}

function formatLogMessage(record) {
  const timestamp = record.timestamp || new Date().toISOString();
  return `[${timestamp}][${record.module}][${record.sourceCode}][${record.level.toUpperCase()}]: ${record.message}`;
}

function emit(record, thresholdLevel = state.level) {
  if (!shouldLog(record.level, thresholdLevel)) {
    return null;
  }

  const formatted = formatLogMessage(record);
  const outputRecord = {
    ...record,
    formatted
  };

  if (record.level === 'error') {
    console.error(formatted, record.details || '');
  } else if (record.level === 'warn') {
    console.warn(formatted, record.details || '');
  } else {
    console.log(formatted, record.details || '');
  }

  if (typeof state.sink === 'function') {
    state.sink(outputRecord);
  }

  return outputRecord;
}

function configureLogger(input = {}) {
  if (input.level !== undefined) {
    state.level = normalizeLevel(input.level);
  }

  if (input.sink !== undefined) {
    state.sink = input.sink;
  }

  if (input.moduleLevels !== undefined) {
    state.moduleLevels.clear();
    for (const [moduleName, level] of Object.entries(input.moduleLevels || {})) {
      state.moduleLevels.set(moduleName, normalizeLevel(level));
    }
  }

  return {
    level: state.level,
    moduleLevels: Object.fromEntries(state.moduleLevels.entries())
  };
}

function getLogLevel() {
  return state.level;
}

function setModuleLogLevel(moduleName, level) {
  state.moduleLevels.set(String(moduleName || 'App'), normalizeLevel(level));
  return state.moduleLevels.get(String(moduleName || 'App'));
}

function getModuleLogLevel(moduleName) {
  return state.moduleLevels.get(String(moduleName || 'App')) || null;
}

function createLogger(moduleName, sourceCode, options = {}) {
  const moduleLabel = moduleName || 'App';
  const sourceLabel = sourceCode || 'unknown';
  const moduleLevel = options.level !== undefined ? normalizeLevel(options.level) : null;

  function log(level, message, details = null) {
    const thresholdLevel = resolveModuleLevel(moduleLabel, moduleLevel);
    if (!shouldLog(level, thresholdLevel)) {
      return null;
    }

    return emit({
      timestamp: new Date().toISOString(),
      module: moduleLabel,
      sourceCode: sourceLabel,
      level: normalizeLevel(level),
      message: String(message),
      details
    }, moduleLevel || resolveModuleLevel(moduleLabel));
  }

  return {
    debug: (message, details) => log('debug', message, details),
    info: (message, details) => log('info', message, details),
    warn: (message, details) => log('warn', message, details),
    error: (message, details) => log('error', message, details)
  };
}

module.exports = {
  LEVELS,
  configureLogger,
  createLogger,
  formatLogMessage,
  getLogLevel,
  getModuleLogLevel,
  normalizeLevel,
  setModuleLogLevel
};
