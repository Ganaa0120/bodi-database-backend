'use strict';

const express = require('express');
const controller = require('../controllers/editRequestController');
const { authenticate, authorize } = require('../middleware/authenticate');

const router = express.Router();

router.get('/', authenticate, authorize('super_admin'), controller.list);
router.patch('/:id/review', authenticate, authorize('super_admin'), controller.review);

module.exports = router;