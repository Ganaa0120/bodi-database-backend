'use strict';

const express = require('express');
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/authenticate');
const { loginRateLimiter, refreshRateLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.post('/login', loginRateLimiter, authController.login);
router.post('/refresh', refreshRateLimiter, authController.refresh);
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.me);

module.exports = router;
