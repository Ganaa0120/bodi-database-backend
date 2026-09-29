'use strict';

const express = require('express');
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/authenticate');
const { loginRateLimiter, refreshRateLimiter } = require('../middleware/rateLimiters');
const { systemContext } = require('../config/db');

const router = express.Router();

// login, refresh — хэрэглэгч хараахан тодорхойгүй тул 'system' RLS context-оор
// ажиллана (зөвхөн users, refresh_tokens, audit_log-д хандана).
router.post('/login', loginRateLimiter, systemContext, authController.login);
router.post('/refresh', refreshRateLimiter, systemContext, authController.refresh);

// Нэвтэрсэн хэрэглэгчийн өөрийн context-оор
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.me);

module.exports = router;