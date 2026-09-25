'use strict';

const express = require('express');
const companyController = require('../controllers/companyController');
const { authenticate, authorize } = require('../middleware/authenticate');

const router = express.Router();

router.get('/', authenticate, authorize('super_admin'), companyController.list);
router.post('/', authenticate, authorize('super_admin'), companyController.create);
router.post('/logo-upload-url', authenticate, authorize('super_admin'), companyController.getLogoUploadUrl);
router.patch('/:id', authenticate, authorize('super_admin'), companyController.update);
router.delete('/:id', authenticate, authorize('super_admin'), companyController.remove);

module.exports = router;