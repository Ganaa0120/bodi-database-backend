'use strict';

const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const { pool } = require('./config/db');

const server = app.listen(env.port, () => {
  logger.info(`Server ажиллаж эхэллээ`, { port: env.port, env: env.nodeEnv });
});

// Graceful shutdown — Azure App Service restart/deploy хийхэд
// идэвхтэй DB connection-уудыг зөв хаана.
async function shutdown(signal) {
  logger.info(`${signal} хүлээн авлаа, серверийг зогсоож байна...`);
  server.close(async () => {
    await pool.end();
    logger.info('Сервер зогслоо.');
    process.exit(0);
  });

  // Хэт удвал хүчээр зогсооно
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || reason });
});
