'use strict';

const express = require('express');
const systemGuideController = require('../controllers/systemGuideController');
const { authenticate, authorize } = require('../middleware/authenticate');

const router = express.Router();

// Бүх нэвтэрсэн хэрэглэгч — controller дотор role-оор шүүнэ.
router.get('/', authenticate, systemGuideController.list);
router.get('/:id/view-url', authenticate, systemGuideController.getViewUrl);

// Зөвхөн super_admin
router.post('/upload-url', authenticate, authorize('super_admin'), systemGuideController.getUploadUrl);
router.post('/', authenticate, authorize('super_admin'), systemGuideController.create);
router.patch('/:id', authenticate, authorize('super_admin'), systemGuideController.update);
router.delete('/:id', authenticate, authorize('super_admin'), systemGuideController.remove);

module.exports = router;