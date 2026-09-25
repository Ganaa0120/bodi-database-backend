'use strict';

const jwt = require('jsonwebtoken');
const { verifyAccessToken } = require('../utils/jwt');

/**
 * Authorization: Bearer <token> header-ээс access token-ийг унших,
 * шалгаад req.auth = { userId, role, companyId, departmentId } гэж
 * тавина.
 *
 * ЧУХАЛ: req.auth.companyId/departmentId нь ЗӨВХӨН энэ token-с
 * гардаг — client-с request body/query-ээр ирсэн company_id-г
 * ХЭЗЭЭ Ч итгэж ашиглахгүй. Дараагийн шатанд (RLS холбох middleware)
 * яг энэ req.auth-ийг ашиглан DB session variable тохируулна.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Нэвтрэх шаардлагатай.' });
  }

  try {
    const payload = verifyAccessToken(token);
    req.auth = {
      userId: payload.sub,
      role: payload.role,
      companyId: payload.companyId,
      departmentId: payload.departmentId,
    };
    return next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Token хугацаа дууссан.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token хүчингүй байна.' });
  }
}

/**
 * Тодорхой role(ууд)-д л зөвшөөрөгдсөн route хийхэд ашиглана.
 * Жишээ: router.get('/admin/x', authenticate, authorize('super_admin'), handler)
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
