const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100
};

const state = {
  level: 'info',
  sink: null
};

function normalizeLevel(level) {
  const normalized = String(level || 'info').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LEVELS, normalized)) {
    throw new Error(`Unsupported log level: ${level}`);
  }
  return normalized;
}

function shouldLog(level) {
  return LEVELS[normalizeLevel(level)] >= LEVELS[state.level] && state.level !== 'off';
}

function formatLogMessage(record) {
  return `[${record.module}][${record.sourceCode}][${record.level.toUpperCase()}]: ${record.message}`;
}

function emit(record) {
  if (!shouldLog(record.level)) {
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

  return {
    level: state.level
  };
}

function getLogLevel() {
  return state.level;
}

function createLogger(moduleName, sourceCode) {
  const moduleLabel = moduleName || 'App';
  const sourceLabel = sourceCode || 'unknown';

  function log(level, message, details = null) {
    return emit({
      timestamp: new Date().toISOString(),
      module: moduleLabel,
      sourceCode: sourceLabel,
      level: normalizeLevel(level),
      message: String(message),
      details
    });
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
  normalizeLevel
};
