'use strict';

const { z } = require('zod');
const { query, withTransaction } = require('../config/db');
const auditService = require('../services/auditService');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function list(req, res, next) {
  try {
    const result = await query(
      `SELECT er.id, er.submission_id, er.reason, er.status, er.reviewed_by, er.reviewed_at, er.created_at,
              fs.title AS submission_title, fs.data AS submission_data, fs.status AS submission_status,
              fs.created_at AS submission_created_at,
              c.name AS company_name, d.name AS department_name,
              u.full_name AS requested_by_name
       FROM submission_edit_requests er
       JOIN form_submissions fs ON fs.id = er.submission_id
       JOIN companies c ON c.id = fs.company_id
       JOIN departments d ON d.id = fs.department_id
       JOIN users u ON u.id = er.requested_by
       ORDER BY er.created_at DESC`
    );
    return res.status(200).json({ requests: result.rows });
  } catch (err) {
    return next(err);
  }
}

const reviewSchema = z.object({ action: z.enum(['approve', 'deny']) });

async function review(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'ID буруу байна.' });
    }

    const { action } = reviewSchema.parse(req.body);

    const existing = await query(
      `SELECT id, submission_id, status FROM submission_edit_requests WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Хүсэлт олдсонгүй.' });
    }
    if (existing.rows[0].status !== 'pending') {
      return res.status(409).json({ error: 'Энэ хүсэлт аль хэдийн шийдвэрлэгдсэн байна.' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'denied';

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE submission_edit_requests SET status = $1, reviewed_by = $2, reviewed_at = now(), updated_at = now() WHERE id = $3`,
        [newStatus, req.auth.userId, id]
      );
      if (action === 'approve') {
        await client.query(`UPDATE form_submissions SET edit_unlocked = true WHERE id = $1`, [
          existing.rows[0].submission_id,
        ]);
      }
    });

    await auditService.logEvent({
      userId: req.auth.userId,
      action: action === 'approve' ? 'EDIT_REQUEST_APPROVED' : 'EDIT_REQUEST_DENIED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { requestId: id, submissionId: existing.rows[0].submission_id },
    });

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, review };