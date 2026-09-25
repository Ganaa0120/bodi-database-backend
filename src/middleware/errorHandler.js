'use strict';

const logger = require('../utils/logger');
const { AuthError } = require('../services/authService');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AuthError) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'Оруулсан дата буруу байна.',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  return res.status(500).json({ error: 'Серверийн дотоод алдаа гарлаа.' });
}

module.exports = errorHandler;
