'use strict';

// Энгийн structured logger. Хожим Azure Monitor/Application Insights
// руу дамжуулах бол энэ файлыг л сольж бичихэд хангалттай — бусад код
// logger.info/error-г л дуудна.
function log(level, message, meta) {
  const entry = {
    level,
    message,
    ...(meta ? { meta } : {}),
    timestamp: new Date().toISOString(),
  };
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
}

module.exports = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
