'use strict';

const { z } = require('zod');
const { query } = require('../config/db');
const auditService = require('../services/auditService');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const formFieldSchema = z.object({
  label: z.string().trim().min(1, 'Талбарын нэрийг оруулна уу.'),
  unit: z.string().trim().optional().default(''),
  frequency: z.enum(['Сар', 'Улирал', 'Жил']),
  type: z.enum(['number', 'text']),
  required: z.boolean().default(true),
  active: z.boolean().default(true),
});

const createSchema = z.object({
  name: z.string().trim().min(2, 'Нэр дор хаяж 2 тэмдэгттэй байх ёстой.').max(100),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    form_schema: z.array(formFieldSchema).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Шинэчлэх зүйл алга.' });

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

    const updates = updateSchema.parse(req.body);

    const existing = await query(
      `SELECT id FROM department_templates WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Загвар олдсонгүй.' });
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
      metadata: { templateId: id },
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