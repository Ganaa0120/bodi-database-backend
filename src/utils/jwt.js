'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

/**
 * Access token — амьдрах хугацаа богино (default 30 минут).
 * Payload дотор company_id/department_id-г оруулснаар дараагийн
 * шатанд (RLS session variable тохируулах middleware) шууд
 * ашиглах боломжтой болно.
 */
function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      companyId: user.company_id,
      departmentId: user.department_id,
    },
    env.jwt.accessTokenSecret,
    { expiresIn: env.jwt.accessTokenTtl }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessTokenSecret);
}

/**
 * Refresh token — санамсаргүй, урт (256 бит) утга. Клиент рүү зөвхөн
 * энэ raw утгыг явуулна; DB-д зөвхөн sha256 hash-ийг нь хадгална —
 * ингэснээр DB алдагдсан ч гэсэн refresh token-уудыг шууд ашиглах
 * боломжгүй болно.
 */
function generateRefreshToken() {
  const raw = crypto.randomBytes(64).toString('hex');
  const hash = hashRefreshToken(raw);
  return { raw, hash };
}

function hashRefreshToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
};
