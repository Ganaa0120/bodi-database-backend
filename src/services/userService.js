'use strict';

const { hashPassword } = require('./authService');

/**
 * Имэйл системд (аль ч компанид) бүртгэлтэй эсэх.
 *
 * RLS-ийн улмаас CEO зөвхөн өөрийн компанийн хэрэглэгчдийг хардаг тул
 * энгийн SELECT-ээр өөр компанид бүртгэлтэй имэйлийг илрүүлж чадахгүй.
 * app.email_in_use() нь SECURITY DEFINER функц — зөвхөн true/false
 * буцаадаг тул өөр компанийн мэдээлэл задрахгүй.
 */
async function isEmailInUse(executor, email, excludeUserId = null) {
  const result = await executor.query('SELECT app.email_in_use($1, $2) AS in_use', [
    email,
    excludeUserId,
  ]);
  return result.rows[0].in_use === true;
}

/**
 * Компани/хэлтсийн админ хэрэглэгч (login) үүсгэх нийтлэг логик.
 * "executor" нь config/db.js-ийн query-тэй адил .query(text, params)
 * интерфейстэй аль ч объект (жишээ нь withTransaction доторх client).
 */
async function createLinkedUser(
  executor,
  { email, password, fullName, role, companyId, departmentId = null }
) {
  if (await isEmailInUse(executor, email)) {
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

module.exports = { createLinkedUser, isEmailInUse };