'use strict';

const bcrypt = require('bcrypt');
const { query, withTransaction } = require('../config/db');
const { signAccessToken, generateRefreshToken, hashRefreshToken } = require('../utils/jwt');
const auditService = require('./auditService');
const env = require('../config/env');

const BCRYPT_ROUNDS = 12;

class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

function sanitizeUser(user) {
  // password_hash-ийг client рүү хэзээ ч буцаахгүй
  const { password_hash, ...safe } = user;
  return safe;
}

async function findUserByEmail(email) {
  const result = await query(
    `SELECT id, email, password_hash, full_name, role, company_id, department_id,
            is_active, failed_login_attempts, locked_until
     FROM users
     WHERE lower(email) = lower($1)
       AND deleted_at IS NULL`,
    [email]
  );
  return result.rows[0] || null;
}

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
}

/**
 * Нэвтрэх үндсэн логик.
 *
 * Аюулгүй байдлын анхаарах зүйлс:
 * - Хэрэглэгч олдоогүй ба нууц үг буруу хоёрт ЯГ ИЖИЛ generic алдаа
 *   буцаана (аль нь буруу болохыг илрүүлэх боломжгүй болгох — user
 *   enumeration халдлагаас сэргийлнэ).
 * - N удаа буруу оролдвол account-ийг түр хугацаагаар түгжинэ
 *   (account lockout) — brute-force-оос сэргийлнэ. Энэ нь IP-based
 *   rate limit-ийн нэмэлт давхарга (route дээр тохируулсан).
 * - Амжилттай/амжилтгүй оролдлого бүрийг audit_log-д бичнэ.
 */
async function login({ email, password, ipAddress, userAgent }) {
  const user = await findUserByEmail(email);

  const genericError = () => new AuthError('Имэйл эсвэл нууц үг буруу байна.', 401);

  if (!user) {
    await auditService.logEvent({
      action: 'LOGIN_FAILED',
      ipAddress,
      userAgent,
      metadata: { reason: 'user_not_found', email },
    });
    throw genericError();
  }

  if (!user.is_active) {
    await auditService.logEvent({
      userId: user.id,
      action: 'LOGIN_FAILED',
      ipAddress,
      userAgent,
      metadata: { reason: 'account_inactive' },
    });
    throw genericError();
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await auditService.logEvent({
      userId: user.id,
      action: 'LOGIN_FAILED',
      ipAddress,
      userAgent,
      metadata: { reason: 'account_locked', locked_until: user.locked_until },
    });
    throw new AuthError(
      `Данс түр хугацаагаар түгжигдсэн байна. ${new Date(user.locked_until).toLocaleString('mn-MN')} хүртэл дахин оролдож болохгүй.`,
      423
    );
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);

  if (!passwordMatches) {
    await handleFailedAttempt(user, ipAddress, userAgent);
    throw genericError();
  }

  // Амжилттай — failed_login_attempts-ийг тэглэж, last_login мэдээллийг шинэчилнэ
  await query(
    `UPDATE users
     SET failed_login_attempts = 0,
         locked_until = NULL,
         last_login_at = now(),
         last_login_ip = $2,
         updated_at = now()
     WHERE id = $1`,
    [user.id, ipAddress]
  );

  await auditService.logEvent({
    userId: user.id,
    action: 'LOGIN_SUCCESS',
    ipAddress,
    userAgent,
  });

  const accessToken = signAccessToken(user);
  const { raw: refreshTokenRaw, hash: refreshTokenHash } = generateRefreshToken();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + env.jwt.refreshTokenTtlDays);

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, refreshTokenHash, expiresAt, userAgent, ipAddress]
  );

  return {
    accessToken,
    refreshToken: refreshTokenRaw,
    refreshTokenExpiresAt: expiresAt,
    user: sanitizeUser(user),
  };
}

/**
 * Буруу нууц үг оруулах бүрийг тоолж, тогтоосон тооноос давбал
 * account-ийг lockout-ын хугацаагаар түгжинэ. Тоолол + түгжилтийг
 * нэг transaction дотор хийж, race condition-оос сэргийлнэ.
 */
async function handleFailedAttempt(user, ipAddress, userAgent) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE users
       SET failed_login_attempts = failed_login_attempts + 1,
           updated_at = now()
       WHERE id = $1
       RETURNING failed_login_attempts`,
      [user.id]
    );

    const attempts = rows[0].failed_login_attempts;
    const shouldLock = attempts >= env.security.maxFailedLoginAttempts;

    if (shouldLock) {
      const lockedUntil = new Date();
      lockedUntil.setMinutes(lockedUntil.getMinutes() + env.security.lockoutMinutes);

      await client.query(`UPDATE users SET locked_until = $2 WHERE id = $1`, [user.id, lockedUntil]);

      await client.query(
        `INSERT INTO audit_log (user_id, action, ip_address, user_agent, metadata)
         VALUES ($1, 'ACCOUNT_LOCKED', $2, $3, $4)`,
        [user.id, ipAddress, userAgent, JSON.stringify({ attempts, locked_until: lockedUntil })]
      );
    } else {
      await client.query(
        `INSERT INTO audit_log (user_id, action, ip_address, user_agent, metadata)
         VALUES ($1, 'LOGIN_FAILED', $2, $3, $4)`,
        [user.id, ipAddress, userAgent, JSON.stringify({ reason: 'wrong_password', attempts })]
      );
    }
  });
}

/**
 * Refresh token ашиглан шинэ access token авах. Refresh token
 * ашиглагдах бүрд ЭРГЭЭД шинэ refresh token-оор солино (rotation) —
 * хуучин token дахин ашиглагдвал (магадгүй хулгайлагдсан гэсэн үг)
 * шууд илрүүлэх боломжтой болгоно.
 */
async function refreshAccessToken({ refreshToken, ipAddress, userAgent }) {
  if (!refreshToken) {
    throw new AuthError('Refresh token дутуу байна.', 401);
  }

  const tokenHash = hashRefreshToken(refreshToken);

  const result = await query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
            u.id AS uid, u.email, u.full_name, u.role, u.company_id, u.department_id, u.is_active
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1`,
    [tokenHash]
  );

  const record = result.rows[0];

  if (!record || record.revoked_at || new Date(record.expires_at) < new Date() || !record.is_active) {
    await auditService.logEvent({
      userId: record ? record.user_id : null,
      action: 'LOGIN_FAILED',
      ipAddress,
      userAgent,
      metadata: { reason: 'invalid_refresh_token' },
    });
    throw new AuthError('Refresh token хүчингүй байна. Дахин нэвтэрнэ үү.', 401);
  }

  // Rotation: хуучныг цуцалж, шинийг үүсгэнэ
  const { raw: newRaw, hash: newHash } = generateRefreshToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + env.jwt.refreshTokenTtlDays);

  await withTransaction(async (client) => {
    await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [record.id]);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [record.user_id, newHash, expiresAt, userAgent, ipAddress]
    );
  });

  const user = {
    id: record.uid,
    email: record.email,
    full_name: record.full_name,
    role: record.role,
    company_id: record.company_id,
    department_id: record.department_id,
  };

  await auditService.logEvent({ userId: user.id, action: 'TOKEN_REFRESH', ipAddress, userAgent });

  return {
    accessToken: signAccessToken(user),
    refreshToken: newRaw,
    refreshTokenExpiresAt: expiresAt,
    user,
  };
}

async function logout({ refreshToken, userId, ipAddress, userAgent }) {
  if (refreshToken) {
    const tokenHash = hashRefreshToken(refreshToken);
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
      tokenHash,
    ]);
  }
  await auditService.logEvent({ userId, action: 'LOGOUT', ipAddress, userAgent });
}

module.exports = {
  AuthError,
  login,
  refreshAccessToken,
  logout,
  hashPassword,
  findUserByEmail,
  sanitizeUser,
};
