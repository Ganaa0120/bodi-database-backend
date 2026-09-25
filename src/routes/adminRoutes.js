'use strict';

const express = require('express');
const { authenticate, authorize } = require('../middleware/authenticate');

const router = express.Router();

// Зөвхөн super_admin эрхтэй хэрэглэгч нэвтэрч чадах эсэхийг шалгах
// зориулалттай энгийн endpoint. Дараагийн шатанд компани/department
// удирдах бодит endpoint-ууд энэ router дотор нэмэгдэнэ.
router.get('/ping', authenticate, authorize('super_admin'), (req, res) => {
  res.json({ ok: true, message: 'super_admin эрхээр амжилттай хандлаа.', auth: req.auth });
});

module.exports = router;
