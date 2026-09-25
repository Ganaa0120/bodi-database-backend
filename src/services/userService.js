'use strict';

const { hashPassword } = require('./authService');

/**
 * Компани/хэлтэсийн админ хэрэглэгч (login) үүсгэх нийтлэг логик.
 * "executor" нь эсвэл config/db.js-ийн `pool`, эсвэл transaction доторх
 * `client` байж болно — хоёул ижил .query(text, params) интерфэйстэй тул
 * энэ функц хэзээ transaction дотор, хэзээ дангаараа дуудагдахаас
 * үл хамааран ажиллана.
 */
async function createLinkedUser(executor, { email, password, fullName, role, companyId, departmentId = null }) {
  const existing = await executor.query(
    `SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email]
  );
  if (existing.rows.length > 0) {
    const err = new Error('Энэ имэйл хаяг өөр хэрэглэгчид бүртгэлтэй байна.');
    err.statusCode = 409;
    throw err;
  }

  const passwordHash = await hashPassword(password);

  const result = await executor.query(
    `INSERT INTO users (email, password_hash, full_name, role, company_id, department_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING id, email, full_name, role, company_id, department_id`,
    [email, passwordHash, fullName, role, companyId, departmentId]
  );

  return result.rows[0];
}

module.exports = { createLinkedUser };