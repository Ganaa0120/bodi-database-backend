'use strict';

const { query } = require('../config/db');

/**
 * Audit event бичих цорын ганц цэг. Login амжилттай/амжилтгүй, logout,
 * token refresh, account lock зэрэг authentication-тэй холбоотой бүх
 * үйлдэл ЭНЭ функцээр дамжина — ингэснээр audit trail-д цоорхой
 * гарахгүй.
 *
 * @param {object} params
 * @param {string|null} params.userId
 * @param {string} params.action
 * @param {string|null} params.ipAddress
 * @param {string|null} params.userAgent
 * @param {object} [params.metadata]
 */
async function logEvent({ userId = null, action, ipAddress = null, userAgent = null, metadata = {} }) {
  await query(
    `INSERT INTO audit_log (user_id, action, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, action, ipAddress, userAgent, JSON.stringify(metadata)]
  );
}

module.exports = { logEvent };
