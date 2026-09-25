'use strict';

const express = require('express');
const controller = require('../controllers/analyticsController');
const { authenticate, authorize } = require('../middleware/authenticate');

const router = express.Router();
router.get('/', authenticate, authorize('company', 'super_admin'), controller.analytics);

module.exports = router;