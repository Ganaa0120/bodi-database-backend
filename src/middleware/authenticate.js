'use strict';

const jwt = require('jsonwebtoken');
const { verifyAccessToken } = require('../utils/jwt');
const { runRequestInContext } = require('../config/db');

/**
 * Authorization: Bearer <token> header-ээс access token-ийг уншиж,
 * шалгаад req.auth = { userId, role, companyId, departmentId } гэж тавина.
 *
 * Мөн энэ хүсэлтийн бүх DB query-г тухайн хэрэглэгчийн RLS context-тэй
 * ажиллуулна (config/db.js → runRequestInContext).
 *
 * ЧУХАЛ: companyId/departmentId нь ЗӨВХӨН token-оос гарна — client-ээс
 * body/query-ээр ирсэн company_id-д ХЭЗЭЭ Ч итгэхгүй.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Нэвтрэх шаардлагатай.' });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Token хугацаа дууссан.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token хүчингүй байна.' });
  }

  req.auth = {
    userId: payload.sub,
    role: payload.role,
    companyId: payload.companyId || null,
    departmentId: payload.departmentId || null,
  };

  return runRequestInContext(req, res, next, req.auth);
}

/**
 * Тодорхой role(ууд)-д л зөвшөөрөгдсөн route.
 * Жишээ: router.get('/x', authenticate, authorize('super_admin'), handler)
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Нэвтрэх шаардлагатай.' });
    }
    if (!allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Энэ үйлдэлд таны эрх хүрэлцэхгүй байна.' });
    }
    return next();
  };
}

module.exports = { authenticate, authorize };