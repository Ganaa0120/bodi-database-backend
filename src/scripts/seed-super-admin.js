'use strict';

/**
 * Анхны super_admin хэрэглэгчийг үүсгэнэ. Утгуудыг .env-с (SUPER_ADMIN_EMAIL,
 * SUPER_ADMIN_PASSWORD, SUPER_ADMIN_FULL_NAME) уншина — код дотор нууц үг
 * шууд бичихгүй.
 *
 * Ажиллуулах: npm run seed:super-admin
 *
 * Аюулгүй байдлын анхаарах зүйл: энэ script-ийг production дээр ЗӨВХӨН
 * НЭГ УДАА ажиллуулна. Ажилласны дараа .env файлаас SUPER_ADMIN_PASSWORD-г
 * устгахыг зөвлөж байна — учир нь энэ файл дотор нууц үг plaintext
 * хэлбэрээр байх шаардлагагүй болно (DB-д зөвхөн hash нь үлдэнэ).
 */

const { pool } = require('../config/db');
const { hashPassword } = require('../services/authService');
const env = require('../config/env');
const logger = require('../utils/logger');

async function seed() {
  const { superAdminEmail, superAdminPassword, superAdminFullName } = env.seed;

  if (!superAdminEmail || !superAdminPassword) {
    throw new Error(
      'SUPER_ADMIN_EMAIL болон SUPER_ADMIN_PASSWORD .env файлд заавал байх ёстой.'
    );
  }

  if (superAdminPassword.length < 12) {
    throw new Error(
      'SUPER_ADMIN_PASSWORD хэт богино байна (доод тал нь 12 тэмдэгт). Илүү урт, санамсаргүй нууц үг ашиглана уу.'
    );
  }

  const existing = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [
    superAdminEmail,
  ]);

  if (existing.rows.length > 0) {
    logger.info(`super_admin хэрэглэгч аль хэдийн байна, алгасаж байна: ${superAdminEmail}`);
    return;
  }

  const passwordHash = await hashPassword(superAdminPassword);

  await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role, company_id, department_id, is_active)
     VALUES ($1, $2, $3, 'super_admin', NULL, NULL, true)`,
    [superAdminEmail, passwordHash, superAdminFullName]
  );

  logger.info(`super_admin хэрэглэгч амжилттай үүслээ: ${superAdminEmail}`);
}

seed()
  .catch((err) => {
    logger.error('Seed script алдаатай зогслоо', { message: err.message });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
