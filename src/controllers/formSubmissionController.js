'use strict';

const { z } = require('zod');
const { query, withTransaction } = require('../config/db');
const auditService = require('../services/auditService');
const { validateSubmissionData } = require('../constants/formFields');
const { syncSubmissionValues } = require('../services/submissionValuesService');
const HttpError = require('../utils/httpError');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Бүх RETURNING-д ижил багануудыг буцаана. */
const SUBMISSION_COLUMNS = `id, company_id, department_id, submitted_by, title, data, status,
  rejection_reason, reviewed_by, reviewed_at, edit_unlocked,
  period_year, period_quarter, created_at, updated_at`;

/** Шинэ хугацаа эхэнд, хугацаагүй хуучин тайлангууд төгсгөлд. */
const ORDER_BY_PERIOD = `ORDER BY fs.period_year DESC NULLS LAST,
                                 fs.period_quarter DESC NULLS LAST,
                                 fs.created_at DESC`;

// Утгуудыг (key → string) авна. Нэгжийн дүрмээр validateSubmissionData шалгана.
const dataRecordSchema = z.record(z.string().max(50, 'Утга хэт урт байна.'));

const periodYear = z
  .number({ invalid_type_error: 'Тайлант оныг сонгоно уу.', required_error: 'Тайлант оныг сонгоно уу.' })
  .int()
  .min(1990, 'Он 1990-ээс хойш байх ёстой.')
  .max(2100, 'Он 2100-аас өмнө байх ёстой.');

const periodQuarter = z
  .number({ invalid_type_error: 'Улирлыг сонгоно уу.', required_error: 'Улирлыг сонгоно уу.' })
  .int()
  .min(1, 'Улирал 1-4 байх ёстой.')
  .max(4, 'Улирал 1-4 байх ёстой.');

const createSchema = z.object({
  title: z.string().trim().min(2, 'Тайлангийн нэрийг оруулна уу.').max(200),
  data: dataRecordSchema,
  period_year: periodYear,
  period_quarter: periodQuarter,
});

const resubmitSchema = createSchema;

// Компани засахад хугацааг заавал биш — зөвхөн хоёуланг нь хамт илгээвэл солино.
const companyEditSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    data: dataRecordSchema,
    period_year: periodYear.optional(),
    period_quarter: periodQuarter.optional(),
  })
  .refine((b) => (b.period_year === undefined) === (b.period_quarter === undefined), {
    message: 'Он болон улирлыг хамт илгээнэ үү.',
    path: ['period_quarter'],
  });

/**
 * Хэлтсийн загварын талбарууд.
 * db — `{ query }` эсвэл transaction-ий client (хоёулаа .query-тэй).
 */
async function loadDepartmentSchema(db, departmentId) {
  const result = await db.query(
    `SELECT t.form_schema
     FROM departments d
     JOIN department_templates t ON t.id = d.template_id
     WHERE d.id = $1`,
    [departmentId]
  );
  return result.rows[0] ? result.rows[0].form_schema : null;
}

function isPeriodConflict(err) {
  return err && err.code === '23505' && err.constraint === 'form_submissions_dept_period_uniq';
}

function periodConflictResponse(res, year, quarter) {
  return res.status(409).json({
    error: `${year} оны ${quarter}-р улирлын тайлан аль хэдийн илгээгдсэн байна.`,
  });
}

function assertUuid(id) {
  if (!UUID_REGEX.test(id)) throw new HttpError(400, 'ID буруу байна.');
}

/*
 * submission_values-ийн инвариант:
 * form_submissions-ийн status / data / хугацаа / deleted_at өөрчлөгдөх БҮХ
 * функц (review, resubmit, updateByCompany, deleteByCompany) өөрчлөлтөө
 * withTransaction дотор хийж, ижил transaction-д syncSubmissionValues дуудна.
 * Шинэ ийм функц нэмбэл мөн адил хийнэ.
 */

async function create(req, res, next) {
  let body;
  try {
    body = createSchema.parse(req.body);
    const { companyId, departmentId, userId } = req.auth;

    if (!departmentId) {
      return res.status(400).json({ error: 'Танай хэрэглэгч хэлтэст хамаарахгүй байна.' });
    }

    const formSchema = await loadDepartmentSchema({ query }, departmentId);
    if (!formSchema) return res.status(404).json({ error: 'Хэлтсийн форм олдсонгүй.' });

    const checked = validateSubmissionData(formSchema, body.data, body.period_quarter);
    if (checked.error) return res.status(400).json({ error: checked.error });

    // Шинэ тайлан үргэлж pending — submission_values-д нөлөөлөхгүй.
    const result = await query(
      `INSERT INTO form_submissions
         (company_id, department_id, submitted_by, title, data, status, period_year, period_quarter)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING ${SUBMISSION_COLUMNS}`,
      [
        companyId,
        departmentId,
        userId,
        body.title,
        JSON.stringify(checked.value),
        body.period_year,
        body.period_quarter,
      ]
    );

    await auditService.logEvent({
      userId,
      action: 'FORM_SUBMITTED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: {
        submissionId: result.rows[0].id,
        departmentId,
        period: `${body.period_year}-Q${body.period_quarter}`,
      },
    });

    return res.status(201).json({ submission: result.rows[0] });
  } catch (err) {
    if (isPeriodConflict(err)) return periodConflictResponse(res, body.period_year, body.period_quarter);
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

    // form_schema — тайлангийн утгуудыг (код → утга) нэр, нэгжтэй нь харуулахад.
    // Компани олон хэлтсийн (өөр өөр загвартай) тайланг харах тул мөр бүрт хавсаргана.
    const baseSelect = `
      SELECT fs.*, d.name AS department_name, c.name AS company_name, u.full_name AS submitted_by_name,
             t.form_schema AS form_schema
      FROM form_submissions fs
      JOIN departments d ON d.id = fs.department_id
      JOIN companies c ON c.id = fs.company_id
      JOIN users u ON u.id = fs.submitted_by
      LEFT JOIN department_templates t ON t.id = d.template_id`;

    let result;
    if (role === 'super_admin') {
      result = await query(`${baseSelect} WHERE fs.deleted_at IS NULL ${ORDER_BY_PERIOD}`);
    } else if (role === 'company') {
      result = await query(
        `${baseSelect} WHERE fs.company_id = $1 AND fs.deleted_at IS NULL ${ORDER_BY_PERIOD}`,
        [companyId]
      );
    } else {
      result = await query(
        `${baseSelect} WHERE fs.department_id = $1 AND fs.deleted_at IS NULL ${ORDER_BY_PERIOD}`,
        [departmentId]
      );
    }

    return res.status(200).json({ submissions: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function resubmit(req, res, next) {
  let body;
  try {
    const { id } = req.params;
    assertUuid(id);
    body = resubmitSchema.parse(req.body);
    const { departmentId, userId } = req.auth;

    const submission = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, status FROM form_submissions
         WHERE id = $1 AND department_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [id, departmentId]
      );
      if (existing.rows.length === 0) throw new HttpError(404, 'Тайлан олдсонгүй.');
      if (existing.rows[0].status !== 'rejected') {
        throw new HttpError(409, 'Зөвхөн татгалзсан тайланг л засаж болно.');
      }

      const formSchema = await loadDepartmentSchema(client, departmentId);
      if (!formSchema) throw new HttpError(404, 'Хэлтсийн форм олдсонгүй.');

      const checked = validateSubmissionData(formSchema, body.data, body.period_quarter);
      if (checked.error) throw new HttpError(400, checked.error);

      const result = await client.query(
        `UPDATE form_submissions
         SET title = $1, data = $2, status = 'pending',
             period_year = $3, period_quarter = $4,
             rejection_reason = NULL, reviewed_by = NULL, reviewed_at = NULL,
             updated_at = now()
         WHERE id = $5
         RETURNING ${SUBMISSION_COLUMNS}`,
        [body.title, JSON.stringify(checked.value), body.period_year, body.period_quarter, id]
      );

      // pending болсон тул утга 0 мөр байх ёстой — инвариантыг баталгаажуулна.
      await syncSubmissionValues(client, id);
      return result.rows[0];
    });

    await auditService.logEvent({
      userId,
      action: 'FORM_RESUBMITTED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { submissionId: id, period: `${body.period_year}-Q${body.period_quarter}` },
    });

    return res.status(200).json({ submission });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
    if (isPeriodConflict(err)) return periodConflictResponse(res, body.period_year, body.period_quarter);
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
    assertUuid(id);
    const { action, rejection_reason } = reviewSchema.parse(req.body);
    const { companyId, userId } = req.auth;
    const newStatus = action === 'accept' ? 'accepted' : 'rejected';

    // Төлөв солих + KPI утгуудыг бүртгэх нь НЭГ transaction. Утга бүртгэж
    // чадахгүй бол (код давхардсан, утга буруу) тайлан accepted болохгүй.
    const { submission, valuesCount } = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, status FROM form_submissions
         WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [id, companyId]
      );
      if (existing.rows.length === 0) throw new HttpError(404, 'Тайлан олдсонгүй.');
      if (existing.rows[0].status !== 'pending') {
        throw new HttpError(409, 'Энэ тайлан аль хэдийн шийдвэрлэгдсэн байна.');
      }

      const result = await client.query(
        `UPDATE form_submissions
         SET status = $1, rejection_reason = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
         WHERE id = $4
         RETURNING ${SUBMISSION_COLUMNS}`,
        [newStatus, action === 'reject' ? rejection_reason || null : null, userId, id]
      );

      const synced = await syncSubmissionValues(client, id);
      return { submission: result.rows[0], valuesCount: synced.count };
    });

    await auditService.logEvent({
      userId,
      action: action === 'accept' ? 'FORM_ACCEPTED' : 'FORM_REJECTED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { submissionId: id, reason: rejection_reason || null, valuesCount },
    });

    return res.status(200).json({ submission });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
    return next(err);
  }
}

async function updateByCompany(req, res, next) {
  let targetYear;
  let targetQuarter;
  try {
    const { id } = req.params;
    assertUuid(id);
    const body = companyEditSchema.parse(req.body);
    const { companyId, userId } = req.auth;

    const { submission, valuesCount } = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, department_id, status, edit_unlocked, period_year, period_quarter
         FROM form_submissions
         WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [id, companyId]
      );
      if (existing.rows.length === 0) throw new HttpError(404, 'Тайлан олдсонгүй.');

      const row = existing.rows[0];
      const canEdit = row.status !== 'accepted' || row.edit_unlocked;
      if (!canEdit) {
        throw new HttpError(403, 'Зөвшөөрсөн тайланг засахын тулд Super Admin-с зөвшөөрөл авах шаардлагатай.');
      }

      targetYear = body.period_year ?? row.period_year;
      targetQuarter = body.period_quarter ?? row.period_quarter;

      const formSchema = await loadDepartmentSchema(client, row.department_id);
      if (!formSchema) throw new HttpError(404, 'Хэлтсийн форм олдсонгүй.');

      // Компани хуучин тайланг засахад дараа нь нэмэгдсэн "заавал" талбарыг
      // шаардахгүй — зөвхөн оруулсан утгуудыг нэгжийн дүрмээр шалгана.
      const checked = validateSubmissionData(formSchema, body.data, targetQuarter, {
        enforceRequired: false,
      });
      if (checked.error) throw new HttpError(400, checked.error);

      const result = await client.query(
        `UPDATE form_submissions
         SET title = $1, data = $2, period_year = $3, period_quarter = $4,
             edit_unlocked = false, updated_at = now()
         WHERE id = $5
         RETURNING ${SUBMISSION_COLUMNS}`,
        [body.title, JSON.stringify(checked.value), targetYear, targetQuarter, id]
      );

      // Accepted тайланг (edit_unlocked) засвал KPI утгууд шинэ утгаар солигдоно.
      const synced = await syncSubmissionValues(client, id);
      return { submission: result.rows[0], valuesCount: synced.count };
    });

    await auditService.logEvent({
      userId,
      action: 'FORM_EDITED_BY_COMPANY',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: {
        submissionId: id,
        period: `${targetYear}-Q${targetQuarter}`,
        status: submission.status,
        valuesCount,
      },
    });

    return res.status(200).json({ submission });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
    if (isPeriodConflict(err)) return periodConflictResponse(res, targetYear, targetQuarter);
    return next(err);
  }
}

async function deleteByCompany(req, res, next) {
  try {
    const { id } = req.params;
    assertUuid(id);
    const { companyId, userId } = req.auth;

    await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, status, edit_unlocked FROM form_submissions
         WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [id, companyId]
      );
      if (existing.rows.length === 0) throw new HttpError(404, 'Тайлан олдсонгүй.');

      const row = existing.rows[0];
      const canDelete = row.status !== 'accepted' || row.edit_unlocked;
      if (!canDelete) {
        throw new HttpError(403, 'Зөвшөөрсөн тайланг устгахын тулд Super Admin-с зөвшөөрөл авах шаардлагатай.');
      }

      await client.query('UPDATE form_submissions SET deleted_at = now() WHERE id = $1', [id]);

      // Устгасан тайлангийн утгууд KPI-аас хасагдана.
      await syncSubmissionValues(client, id);
    });

    await auditService.logEvent({
      userId,
      action: 'FORM_DELETED_BY_COMPANY',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { submissionId: id },
    });

    return res.status(204).send();
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
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