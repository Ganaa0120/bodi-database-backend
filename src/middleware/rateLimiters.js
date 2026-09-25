'use strict';

const rateLimit = require('express-rate-limit');

/**
 * IP-хаягаар хязгаарлана — энэ нь account lockout-ын НЭМЭЛТ давхарга.
 * Account lockout нэг user-ийг хамгаалдаг бол энэ нь нэг IP-с олон
 * өөр email оролдох (credential stuffing) хэлбэрийн халдлагаас хамгаална.
 */
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 20, // 15 минутанд нэг IP-с дээд тал нь 20 оролдлого
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Хэт олон удаа оролдлоо. Түр хүлээгээд дахин оролдоно уу.' },
});

const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Хэт олон удаа оролдлоо. Түр хүлээгээд дахин оролдоно уу.' },
});

module.exports = { loginRateLimiter, refreshRateLimiter };
