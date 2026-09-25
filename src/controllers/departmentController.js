'use strict';

const { z } = require('zod');
const { query, withTransaction } = require('../config/db');
const auditService = require('../services/auditService');
const userService = require('../services/userService');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  template_id: z.string().uuid('Хэлтэсийн загвар сонгоно уу.'),
  admin_full_name: z.string().trim().min(2, 'Админы нэрийг оруулна уу.'),
  admin_email: z.string().trim().email('Имэйл хаяг буруу байна.'),
  admin_password: z.string().min(10, 'Нууц үг дор хаяж 10 тэмдэгттэй байх ёстой.'),
});

async function list(req, res, next) {
  try {
    const result = await query(
      `SELECT d.id, d.name, d.is_active, d.created_at, d.updated_at, d.template_id,
              u.id AS admin_id, u.email AS admin_email, u.full_name AS admin_full_name
       FROM departments d
       LEFT JOIN users u ON u.department_id = d.id AND u.role = 'department' AND u.deleted_at IS NULL
       WHERE d.company_id = $1 AND d.deleted_at IS NULL
       ORDER BY d.created_at DESC`,
      [req.auth.companyId]
    );
    return res.status(200).json({ departments: result.rows });
  } catch (err) {
    return next(err);
  }
}

// Super_admin — БҮХ компанийн БҮХ хэлтэс (компанийн нэртэй хамт).
async function listAll(req, res, next) {
  try {
    const result = await query(
      `SELECT d.id, d.name, d.is_active, d.created_at, d.updated_at, d.template_id,
              c.id AS company_id, c.name AS company_name,
              u.id AS admin_id, u.email AS admin_email, u.full_name AS admin_full_name
       FROM departments d
       JOIN companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.department_id = d.id AND u.role = 'department' AND u.deleted_at IS NULL
       WHERE d.deleted_at IS NULL
       ORDER BY c.name ASC, d.name ASC`
    );
    return res.status(200).json({ departments: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function mine(req, res, next) {
  try {
    const result = await query(
      `SELECT d.id, d.name, d.template_id, dt.form_schema
       FROM departments d
       JOIN department_templates dt ON dt.id = d.template_id
       WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [req.auth.departmentId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Хэлтэс олдсонгүй.' });
    }
    return res.status(200).json({ department: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const { template_id, admin_full_name, admin_email, admin_password } = createSchema.parse(req.body);
    const companyId = req.auth.companyId;

    const template = await query(
      `SELECT id, name FROM department_templates WHERE id = $1 AND deleted_at IS NULL`,
      [template_id]
    );
    if (template.rows.length === 0) {
      return res.status(404).json({ error: 'Хэлтэсийн загвар олдсонгүй.' });
    }

    const existingDept = await query(
      `SELECT id FROM departments WHERE company_id = $1 AND template_id = $2 AND deleted_at IS NULL`,
      [companyId, template_id]
    );
    if (existingDept.rows.length > 0) {
      return res.status(409).json({ error: 'Энэ хэлтэс аль хэдийн үүссэн байна.' });
    }

    const { department, adminUser } = await withTransaction(async (client) => {
      const deptResult = await client.query(
        `INSERT INTO departments (company_id, template_id, name)
         VALUES ($1, $2, $3)
         RETURNING id, company_id, template_id, name, is_active, created_at, updated_at`,
        [companyId, template_id, template.rows[0].name]
      );
      const deptRow = deptResult.rows[0];

      const adminUserRow = await userService.createLinkedUser(client, {
        email: admin_email,
        password: admin_password,
        fullName: admin_full_name,
        role: 'department',
        companyId,
        departmentId: deptRow.id,
      });

      return { department: deptRow, adminUser: adminUserRow };
    });

    await auditService.logEvent({
      userId: req.auth.userId,
      action: 'DEPARTMENT_CREATED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { departmentId: department.id, companyId, adminUserId: adminUser.id },
    });

    return res.status(201).json({
      department: {
        ...department,
        admin_id: adminUser.id,
        admin_email: adminUser.email,
        admin_full_name: adminUser.full_name,
      },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'ID буруу байна.' });
    }

    const existing = await query(
      `SELECT id FROM departments WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, req.auth.companyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Хэлтэс олдсонгүй.' });
    }

    await query('UPDATE departments SET deleted_at = now() WHERE id = $1', [id]);
    await query('UPDATE users SET deleted_at = now() WHERE department_id = $1 AND deleted_at IS NULL', [id]);

    await auditService.logEvent({
      userId: req.auth.userId,
      action: 'DEPARTMENT_DELETED',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      metadata: { departmentId: id, companyId: req.auth.companyId },
    });

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, listAll, mine, create, remove };