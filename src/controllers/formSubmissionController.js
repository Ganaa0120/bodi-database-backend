'use strict';

const { z } = require('zod');
const { query } = require('../config/db');
const auditService = require('../services/auditService');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dataFieldsSchema = z
  .record(z.string())
  .refine((d) => Object.keys(d).length > 0, { message: 'Дор хаяж нэг талбар бөглөнө үү.' });

const createSchema = z.object({
  title: z.string().trim().min(2, 'Тайлангийн нэрийг оруулна уу.').max(200),
  data: dataFieldsSchema,
});

async function create(req, res, next) {
  try {
    const { title, data } = createSchema.parse(req.body);
    const { companyId, departmentId, userId } = req.auth;

    if (!departmentId) {
      return res.status(400).json({ error: 'Танай хэрэглэгч хэлтэст хамаарахгүй байна.' });
    }

    const result = await query(
      `INSERT INTO form_submissions (company_id, department_id, submitted_by, title, data, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id, company_id, department_id, submitted_by, title, data, status,
                 rejection_reason, reviewed_by, reviewed_at, edit_unlocked, created_at, updated_at`,
      [companyId, departmentId, userId, title, JSON.stringify(data)]
    );

    await auditService.logEvent({
      userId,
      action: 'FORM_SUBMITTED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { submissionId: result.rows[0].id, departmentId },
    });

    return res.status(201).json({ submission: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

// list: role бүрт өөр өгөгдлийн хэмжээ —
// - super_admin: БҮХ компанийн БҮХ тайлан
// - company: зөвхөн өөрийн компанийн тайлангууд
// - department: зөвхөн өөрийн хэлтэсийн илгээсэн тайлангууд
async function list(req, res, next) {
  try {
    const { role, companyId, departmentId } = req.auth;

    let result;
    if (role === 'super_admin') {
      result = await query(
        `SELECT fs.*, d.name AS department_name, c.name AS company_name, u.full_name AS submitted_by_name
         FROM form_submissions fs
         JOIN departments d ON d.id = fs.department_id
         JOIN companies c ON c.id = fs.company_id
         JOIN users u ON u.id = fs.submitted_by
         WHERE fs.deleted_at IS NULL
         ORDER BY fs.created_at DESC`
      );
    } else if (role === 'company') {
      result = await query(
        `SELECT fs.*, d.name AS department_name, c.name AS company_name, u.full_name AS submitted_by_name
         FROM form_submissions fs
         JOIN departments d ON d.id = fs.department_id
         JOIN companies c ON c.id = fs.company_id
         JOIN users u ON u.id = fs.submitted_by
         WHERE fs.company_id = $1 AND fs.deleted_at IS NULL
         ORDER BY fs.created_at DESC`,
        [companyId]
      );
    } else {
      result = await query(
        `SELECT fs.*, d.name AS department_name, c.name AS company_name, u.full_name AS submitted_by_name
         FROM form_submissions fs
         JOIN departments d ON d.id = fs.department_id
         JOIN companies c ON c.id = fs.company_id
         JOIN users u ON u.id = fs.submitted_by
         WHERE fs.department_id = $1 AND fs.deleted_at IS NULL
         ORDER BY fs.created_at DESC`,
        [departmentId]
      );
    }

    return res.status(200).json({ submissions: result.rows });
  } catch (err) {
    return next(err);
  }
}

const resubmitSchema = z.object({
  title: z.string().trim().min(2).max(200),
  data: dataFieldsSchema,
});

async function resubmit(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'ID буруу байна.' });
    }

    const { title, data } = resubmitSchema.parse(req.body);

    const existing = await query(
      `SELECT id, status FROM form_submissions WHERE id = $1 AND department_id = $2 AND deleted_at IS NULL`,
      [id, req.auth.departmentId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Тайлан олдсонгүй.' });
    }
    if (existing.rows[0].status !== 'rejected') {
      return res.status(409).json({ error: 'Зөвхөн татгалзсан тайланг л засаж болно.' });
    }

    const result = await query(
      `UPDATE form_submissions
       SET title = $1, data = $2, status = 'pending',
           rejection_reason = NULL, reviewed_by = NULL, reviewed_at = NULL,
           updated_at = now()
       WHERE id = $3
       RETURNING id, company_id, department_id, submitted_by, title, data, status,
                 rejection_reason, reviewed_by, reviewed_at, edit_unlocked, created_at, updated_at`,
      [title, JSON.stringify(data), id]
    );

    await auditService.logEvent({
      userId: req.auth.userId,
      action: 'FORM_RESUBMITTED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { submissionId: id },
    });

    return res.status(200).json({ submission: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

const reviewSchema = z.object({
  action: z.enum(['accept', 'reject']),
  rejection_reason: z.string().trim().max(1000).optional(),
});

async function review(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'ID буруу байна.' });
    }

    const { action, rejection_reason } = reviewSchema.parse(req.body);

    const existing = await query(
      `SELECT id, status FROM form_submissions WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, req.auth.companyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Тайлан олдсонгүй.' });
    }
    if (existing.rows[0].status !== 'pending') {
      return res.status(409).json({ error: 'Энэ тайлан аль хэдийн шийдвэрлэгдсэн байна.' });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'rejected';

    const result = await query(
      `UPDATE form_submissions
       SET status = $1, rejection_reason = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
       WHERE id = $4
       RETURNING id, company_id, department_id, submitted_by, title, data, status,
                 rejection_reason, reviewed_by, reviewed_at, edit_unlocked, created_at, updated_at`,
      [newStatus, action === 'reject' ? rejection_reason || null : null, req.auth.userId, id]
    );

    await auditService.logEvent({
      userId: req.auth.userId,
      action: action === 'accept' ? 'FORM_ACCEPTED' : 'FORM_REJECTED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { submissionId: id, reason: rejection_reason || null },
    });

    return res.status(200).json({ submission: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

const companyEditSchema = z.object({
  title: z.string().trim().min(2).max(200),
  data: dataFieldsSchema,
});

async function updateByCompany(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'ID буруу байна.' });
    }

    const { title, data } = companyEditSchema.parse(req.body);

    const existing = await query(
      `SELECT id, status, edit_unlocked FROM form_submissions WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, req.auth.companyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Тайлан олдсонгүй.' });
    }

    const row = existing.rows[0];
    const canEdit = row.status !== 'accepted' || row.edit_unlocked;
    if (!canEdit) {
      return res.status(403).json({
        error: 'Зөвшөөрсөн тайланг засахын тулд Super Admin-с зөвшөөрөл авах шаардлагатай.',
      });
    }

    const result = await query(
      `UPDATE form_submissions
       SET title = $1, data = $2, edit_unlocked = false, updated_at = now()
       WHERE id = $3
       RETURNING id, company_id, department_id, submitted_by, title, data, status,
                 rejection_reason, reviewed_by, reviewed_at, edit_unlocked, created_at, updated_at`,
      [title, JSON.stringify(data), id]
    );

    await auditService.logEvent({
      userId: req.auth.userId,
      action: 'FORM_EDITED_BY_COMPANY',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { submissionId: id },
    });

    return res.status(200).json({ submission: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function deleteByCompany(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'ID буруу байна.' });
    }

    const existing = await query(
      `SELECT id, status, edit_unlocked FROM form_submissions WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, req.auth.companyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Тайлан олдсонгүй.' });
    }

    const row = existing.rows[0];
    const canDelete = row.status !== 'accepted' || row.edit_unlocked;
    if (!canDelete) {
      return res.status(403).json({
        error: 'Зөвшөөрсөн тайланг устгахын тулд Super Admin-с зөвшөөрөл авах шаардлагатай.',
      });
    }

    await query('UPDATE form_submissions SET deleted_at = now() WHERE id = $1', [id]);

    await auditService.logEvent({
      userId: req.auth.userId,
      action: 'FORM_DELETED_BY_COMPANY',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { submissionId: id },
    });

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

const requestEditSchema = z.object({
  reason: z.string().trim().min(2, 'Шалтгаанаа бичнэ үү.').max(1000),
});

async function requestEdit(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'ID буруу байна.' });
    }

    const { reason } = requestEditSchema.parse(req.body);

    const existing = await query(
      `SELECT id, status FROM form_submissions WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, req.auth.companyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Тайлан олдсонгүй.' });
    }
    if (existing.rows[0].status !== 'accepted') {
      return res.status(409).json({ error: 'Зөвхөн зөвшөөрсөн тайланд л энэ хүсэлт хэрэгтэй.' });
    }

    const dup = await query(
      `SELECT id FROM submission_edit_requests WHERE submission_id = $1 AND status = 'pending'`,
      [id]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'Энэ тайлангийн хүсэлт аль хэдийн илгээгдсэн, хариу хүлээгдэж байна.' });
    }

    const result = await query(
      `INSERT INTO submission_edit_requests (submission_id, requested_by, reason)
       VALUES ($1, $2, $3)
       RETURNING id, submission_id, reason, status, created_at`,
      [id, req.auth.userId, reason]
    );

    await auditService.logEvent({
      userId: req.auth.userId,
      action: 'EDIT_REQUEST_CREATED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { submissionId: id, requestId: result.rows[0].id },
    });

    return res.status(201).json({ request: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function stats(req, res, next) {
  try {
    const { role, companyId } = req.auth;

    let result;
    if (role === 'super_admin') {
      result = await query(
        `SELECT c.id AS group_id, c.name AS group_name, COUNT(*)::int AS count
         FROM form_submissions fs
         JOIN companies c ON c.id = fs.company_id
         WHERE fs.status = 'accepted' AND fs.deleted_at IS NULL
         GROUP BY c.id, c.name
         ORDER BY c.name`
      );
    } else {
      result = await query(
        `SELECT d.id AS group_id, d.name AS group_name, COUNT(*)::int AS count
         FROM form_submissions fs
         JOIN departments d ON d.id = fs.department_id
         WHERE fs.company_id = $1 AND fs.status = 'accepted' AND fs.deleted_at IS NULL
         GROUP BY d.id, d.name
         ORDER BY d.name`,
        [companyId]
      );
    }

    return res.status(200).json({ stats: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function pendingCount(req, res, next) {
  try {
    const { role, companyId, departmentId } = req.auth;

    let result;
    if (role === 'company') {
      result = await query(
        `SELECT COUNT(*)::int AS count FROM form_submissions WHERE company_id = $1 AND status = 'pending' AND deleted_at IS NULL`,
        [companyId]
      );
    } else if (role === 'department') {
      result = await query(
        `SELECT COUNT(*)::int AS count FROM form_submissions WHERE department_id = $1 AND status = 'rejected' AND deleted_at IS NULL`,
        [departmentId]
      );
    } else {
      return res.status(200).json({ count: 0 });
    }

    return res.status(200).json({ count: result.rows[0].count });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  create,
  list,
  resubmit,
  review,
  updateByCompany,
  deleteByCompany,
  requestEdit,
  stats,
  pendingCount,
};