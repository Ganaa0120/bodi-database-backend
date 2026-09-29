'use strict';

const express = require('express');
const notificationController = require('../controllers/notificationController');
const { authenticate, authorize } = require('../middleware/authenticate');

const router = express.Router();

const admin = [authenticate, authorize('super_admin')];
const receiver = [authenticate, authorize('company', 'department')];
const anyRole = [authenticate, authorize('super_admin', 'company', 'department')];

// АНХААР: тогтмол замууд (/unread-count, /sent ...) заавал /:id-ээс ӨМНӨ байна.

// CEO / department admin — өөрийн inbox
router.get('/', ...receiver, notificationController.listMine);
router.get('/unread-count', ...receiver, notificationController.unreadCount);
router.post('/read-all', ...receiver, notificationController.markAllRead);
router.post('/:id/read', ...receiver, notificationController.markRead);

// Super admin — илгээх, хянах
router.post('/attachments/upload-url', ...admin, notificationController.getAttachmentUploadUrl);
router.get('/recipients', ...admin, notificationController.listRecipientOptions);
router.get('/sent', ...admin, notificationController.listSent);
router.post('/', ...admin, notificationController.create);
router.get('/:id/recipients', ...admin, notificationController.listRecipientStatus);
router.delete('/:id', ...admin, notificationController.remove);
router.post('/:id/retry-email', ...admin, notificationController.retryEmail);

// Хавсралт — controller дотор эрх (хүлээн авагч эсэх) шалгана
router.get('/:id/attachments', ...anyRole, notificationController.listAttachments);

module.exports = router;