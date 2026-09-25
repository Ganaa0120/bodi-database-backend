'use strict';

const { Pool } = require('pg');
const env = require('./env');

// Azure Database for PostgreSQL Flexible Server нь TLS шаардлагатай.
// rejectUnauthorized: false нь Azure-ийн өгдөг сертификатын chain-ийг
// орон нутгийн CA store-той таарахгүй үед л ашиглагдана — хэрэв танай
// сервер дээр Azure-ийн эх сертификат (DigiCert Global Root G2) байгаа
// бол үүнийг true болгож, ca-г тодорхой зааж өгч болно.
const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  ssl:
    env.db.sslMode === 'disable'
      ? false
      : {
          rejectUnauthorized: false,
        },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  // Idle client дээр гарсан алдааг process-ыг унагаахгүйгээр лог хийнэ
  // eslint-disable-next-line no-console
  console.error('[db] Unexpected error on idle client', err);
});

/**
 * Энгийн query — RLS ашиглах шаардлагагүй, request-ийн хэрэглэгчийн
 * контекст шаардахгүй query-үүдэд (жишээ нь login) зориулагдсан.
 */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Transaction дотор олон query ажиллуулах шаардлагатай тохиолдолд
 * ашиглана (жишээ нь login: failed_login_attempts шинэчлэх + audit
 * бичих зэргийг нэг transaction-д багтаах).
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
