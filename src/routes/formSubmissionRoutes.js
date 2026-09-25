'use strict';

const express = require('express');
const controller = require('../controllers/formSubmissionController');
const { authenticate, authorize } = require('../middleware/authenticate');

const router = express.Router();

router.get('/', authenticate, authorize('company', 'department', 'super_admin'), controller.list);
router.get('/stats', authenticate, authorize('company', 'super_admin'), controller.stats);
router.get('/pending-count', authenticate, authorize('company', 'department'), controller.pendingCount);
router.post('/', authenticate, authorize('department'), controller.create);
router.patch('/:id', authenticate, authorize('department'), controller.resubmit);
router.patch('/:id/review', authenticate, authorize('company'), controller.review);
router.patch('/:id/edit', authenticate, authorize('company'), controller.updateByCompany);
router.delete('/:id', authenticate, authorize('company'), controller.deleteByCompany);
router.post('/:id/request-edit', authenticate, authorize('company'), controller.requestEdit);

module.exports = router;