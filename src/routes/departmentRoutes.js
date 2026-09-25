'use strict';

const express = require('express');
const controller = require('../controllers/departmentController');
const { authenticate, authorize } = require('../middleware/authenticate');

const router = express.Router();

router.get('/', authenticate, authorize('company'), controller.list);
router.get('/all', authenticate, authorize('super_admin'), controller.listAll);
router.get('/mine', authenticate, authorize('department'), controller.mine);
router.post('/', authenticate, authorize('company'), controller.create);
router.delete('/:id', authenticate, authorize('company'), controller.remove);

module.exports = router;