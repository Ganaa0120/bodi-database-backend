'use strict';

const { z } = require('zod');
const { query } = require('../config/db');
const auditService = require('../services/auditService');
const { formSchemaSchema } = require('../constants/formFields');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  name: z.string().trim().min(2, 'Нэр дор хаяж 2 тэмдэгттэй байх ёстой.').max(100),
});

// Талбарын бүтэц, нэгжийн каталог, код давхардахгүй байх дүрэм —
// constants/formFields.js (frontend-ийн lib/units.ts-тэй ижил).
const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    form_schema: formSchemaSchema.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Шинэчлэх зүйл алга.' });

/**
 * Өмнө хадгалагдсан талбаруудын бүрэн бүтэн байдлыг хамгаална. Тайлангийн
 * утгууд кодоор хадгалагддаг тул:
 *   - талбарыг жагсаалтаас хасахгүй (зөвхөн active: false болгоно),
 *   - нэгжийг солихгүй (₮ → тэрбум ₮ болговол хуучин утгууд 10⁹ дахин буруу болно).
 * Нэр, давтамж, заавал эсэх, идэвхтэй эсэхийг чөлөөтэй засна.
 * Кодгүй (migration хийгдээгүй) хуучин талбаруудыг шалгахгүй.
 *
 * @returns {string | null} алдааны мессеж
 */
function checkExistingFieldsPreserved(previousSchema, nextSchema) {
  const previous = Array.isArray(previousSchema) ? previousSchema : [];
  const nextByCode = new Map(nextSchema.map((f) => [f.code, f]));

  for (const old of previous) {
    if (!old || typeof old.code !== 'string' || !old.code) continue;

    const next = nextByCode.get(old.code);
    if (!next) {
      return `"${old.label}" (${old.code}) талбарыг устгах боломжгүй — идэвхгүй болгоно уу.`;
    }
    if (old.unit && next.unit !== old.unit) {
      return `"${old.label}" (${old.code}) талбарын нэгжийг солих боломжгүй. Өөр нэгж хэрэгтэй бол шинэ кодтой талбар нэмнэ үү.`;
    }
  }
  return null;
}

async function list(req, res, next) {
  try {
    const result = await query(
      `SELECT id, name, form_schema, is_active, created_at, updated_at
       FROM department_templates WHERE deleted_at IS NULL ORDER BY name ASC`
    );
    return res.status(200).json({ templates: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const { name } = createSchema.parse(req.body);

    const existing = await query(
      `SELECT id FROM department_templates WHERE lower(name) = lower($1) AND deleted_at IS NULL`,
      [name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Ийм нэртэй хэлтэсийн загвар аль хэдийн байна.' });
    }

    const result = await query(
      `INSERT INTO department_templates (name) VALUES ($1)
       RETURNING id, name, form_schema, is_active, created_at, updated_at`,
      [name]
    );

    await auditService.logEvent({
      userId: req.auth.userId,
      action: 'DEPARTMENT_TEMPLATE_CREATED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { templateId: result.rows[0].id, name },
    });

    return res.status(201).json({ template: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

// Нэр болон/эсвэл form_schema-г шинэчлэх — "Талбар удирдах" UI энийг дуудна.
async function update(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'ID буруу байна.' });
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      // Эхний алдааг ойлгомжтой мессежээр буцаана (жишээ нь "D-201" код давхардсан).
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        error: issue ? issue.message : 'Хүсэлт буруу байна.',
        details: parsed.error.issues.map((x) => ({ path: x.path.join('.'), message: x.message })),
      });
    }
    const updates = parsed.data;

    const existing = await query(
      `SELECT id, form_schema FROM department_templates WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Загвар олдсонгүй.' });
    }

    if (updates.form_schema) {
      const integrityError = checkExistingFieldsPreserved(existing.rows[0].form_schema, updates.form_schema);
      if (integrityError) return res.status(409).json({ error: integrityError });
    }

    const setClauses = [];
    const values = [];
    let i = 1;
    if (updates.name) {
      setClauses.push(`name = $${i}`);
      values.push(updates.name);
      i++;
    }
    if (updates.form_schema) {
      setClauses.push(`form_schema = $${i}`);
      values.push(JSON.stringify(updates.form_schema));
      i++;
    }
    setClauses.push('updated_at = now()');
    values.push(id);

    const result = await query(
      `UPDATE department_templates SET ${setClauses.join(', ')} WHERE id = $${i}
       RETURNING id, name, form_schema, is_active, created_at, updated_at`,
      values
    );

    await auditService.logEvent({
      userId: req.auth.userId,
      action: 'DEPARTMENT_TEMPLATE_UPDATED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: {
        templateId: id,
        fieldCount: updates.form_schema ? updates.form_schema.length : undefined,
      },
    });

    return res.status(200).json({ template: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'ID буруу байна.' });
    }
    const existing = await query(`SELECT id, name FROM department_templates WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Загвар олдсонгүй.' });
    }
    await query('UPDATE department_templates SET deleted_at = now() WHERE id = $1', [id]);

    await auditService.logEvent({
      userId: req.auth.userId,
      action: 'DEPARTMENT_TEMPLATE_DELETED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { templateId: id, name: existing.rows[0].name },
    });

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, create, update, remove };