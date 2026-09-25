'use strict';

/**
 * Энгийн migration runner. Одоохондоо migration цөөхөн байгаа тул
 * зорилго нь "ямар ч сан дээр migration файлуудыг дарааллаар
 * ажиллуулах" гэсэн хамгийн эгэн зарчим — том болоход
 * node-pg-migrate эсвэл Prisma Migrate руу шилжиж болно.
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query('SELECT filename FROM _migrations');
  return new Set(rows.map((r) => r.filename));
}

async function run() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        logger.info(`Skip (аль хэдийн ажилласан): ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.info(`Ажиллуулж байна: ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`Амжилттай: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} бүтэлгүйтлээ: ${err.message}`);
      }
    }

    logger.info('Бүх migration шинэчлэгдлээ.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  logger.error('Migration runner алдаатай зогслоо', { message: err.message });
  process.exit(1);
});
