'use strict';

const express = require('express');
const controller = require('../controllers/departmentTemplateController');
const { authenticate, authorize } = require('../middleware/authenticate');

const router = express.Router();

router.get('/', authenticate, authorize('super_admin', 'company', 'department'), controller.list);
router.post('/', authenticate, authorize('super_admin'), controller.create);
router.patch('/:id', authenticate, authorize('super_admin'), controller.update);
router.delete('/:id', authenticate, authorize('super_admin'), controller.remove);

module.exports = router;