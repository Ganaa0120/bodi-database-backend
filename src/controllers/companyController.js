"use strict";

const { z } = require("zod");
const { query, withTransaction } = require("../config/db");
const auditService = require("../services/auditService");
const blobService = require("../services/blobService");
const userService = require("../services/userService");
const { hashPassword } = require("../services/authService");

const PHONE_REGEX = /^[0-9+\-\s()]{6,20}$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createCompanySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Компанийн нэр дор хаяж 2 тэмдэгттэй байх ёстой.")
    .max(200),
  phone: z
    .string()
    .trim()
    .regex(PHONE_REGEX, "Утасны дугаар буруу форматтай байна."),
  logo_url: z.string().url("Логоны URL буруу байна.").optional().nullable(),
  admin_full_name: z.string().trim().min(2, "Админы нэрийг оруулна уу."),
  admin_email: z.string().trim().email("Имэйл хаяг буруу байна."),
  admin_password: z
    .string()
    .min(10, "Нууц үг дор хаяж 10 тэмдэгттэй байх ёстой."),
});

const updateCompanySchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    phone: z
      .string()
      .trim()
      .regex(PHONE_REGEX, "Утасны дугаар буруу форматтай байна.")
      .optional(),
    logo_url: z.string().url().optional().nullable(),
    is_active: z.boolean().optional(),
    // Эдгээр 3 нь компанийн CEO/admin login-ийг ЗАСАХАД зориулагдсан —
    // company table-ийн багана биш, users table-д хамаарна (доор
    // тусад нь боловсруулагдана).
    admin_full_name: z
      .string()
      .trim()
      .min(2, "Админы нэрийг оруулна уу.")
      .optional(),
    admin_email: z.string().trim().email("Имэйл хаяг буруу байна.").optional(),
    admin_password: z
      .string()
      .min(10, "Нууц үг дор хаяж 10 тэмдэгттэй байх ёстой.")
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Шинэчлэх зүйл алга.",
  });

const logoUploadUrlSchema = z.object({
  fileName: z.string().min(1),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"], {
    errorMap: () => ({
      message: "Зөвхөн PNG, JPEG, WEBP зураг зөвшөөрөгдөнө.",
    }),
  }),
});

function assertValidId(id, res) {
  if (!UUID_REGEX.test(id)) {
    res.status(400).json({ error: "ID буруу байна." });
    return false;
  }
  return true;
}

async function list(req, res, next) {
  try {
    const result = await query(
      `SELECT c.id, c.name, c.phone, c.logo_url, c.is_active, c.created_at, c.updated_at,
              u.id AS admin_id, u.full_name AS admin_full_name, u.email AS admin_email
       FROM companies c
       LEFT JOIN users u ON u.company_id = c.id AND u.role = 'company' AND u.deleted_at IS NULL
       WHERE c.deleted_at IS NULL
       ORDER BY c.created_at DESC`,
    );
    return res.status(200).json({ companies: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const {
      name,
      phone,
      logo_url,
      admin_full_name,
      admin_email,
      admin_password,
    } = createCompanySchema.parse(req.body);

    const existingCompany = await query(
      `SELECT id FROM companies WHERE lower(name) = lower($1) AND deleted_at IS NULL`,
      [name],
    );
    if (existingCompany.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "Ийм нэртэй компани аль хэдийн бүртгэлтэй байна." });
    }

    const { company, adminUser } = await withTransaction(async (client) => {
      const companyResult = await client.query(
        `INSERT INTO companies (name, phone, logo_url)
         VALUES ($1, $2, $3)
         RETURNING id, name, phone, logo_url, is_active, created_at, updated_at`,
        [name, phone, logo_url || null],
      );
      const companyRow = companyResult.rows[0];

      const adminUserRow = await userService.createLinkedUser(client, {
        email: admin_email,
        password: admin_password,
        fullName: admin_full_name,
        role: "company",
        companyId: companyRow.id,
      });

      return { company: companyRow, adminUser: adminUserRow };
    });

    await auditService.logEvent({
      userId: req.auth.userId,
      action: "COMPANY_CREATED",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"] || null,
      metadata: {
        companyId: company.id,
        name: company.name,
        adminUserId: adminUser.id,
      },
    });

    return res.status(201).json({
      company: {
        ...company,
        admin_id: adminUser.id,
        admin_full_name: adminUser.full_name,
        admin_email: adminUser.email,
      },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    if (!assertValidId(id, res)) return;

    const raw = updateCompanySchema.parse(req.body);
    const { admin_full_name, admin_email, admin_password, ...companyUpdates } =
      raw;

    const existing = await query(
      `SELECT id FROM companies WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Компани олдсонгүй." });
    }

    if (companyUpdates.name) {
      const dup = await query(
        `SELECT id FROM companies WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id != $2`,
        [companyUpdates.name, id],
      );
      if (dup.rows.length > 0) {
        return res
          .status(409)
          .json({ error: "Ийм нэртэй компани аль хэдийн бүртгэлтэй байна." });
      }
    }

    let updatedCompany;
    let updatedAdmin = null;

    await withTransaction(async (client) => {
      // ---- Компанийн талбарууд (name/phone/logo_url/is_active) ----
      if (Object.keys(companyUpdates).length > 0) {
        const setClauses = [];
        const values = [];
        let i = 1;
        for (const [key, value] of Object.entries(companyUpdates)) {
          setClauses.push(`${key} = $${i}`);
          values.push(value);
          i++;
        }
        setClauses.push("updated_at = now()");
        values.push(id);

        const result = await client.query(
          `UPDATE companies SET ${setClauses.join(", ")} WHERE id = $${i}
           RETURNING id, name, phone, logo_url, is_active, created_at, updated_at`,
          values,
        );
        updatedCompany = result.rows[0];
      } else {
        const result = await client.query(
          `SELECT id, name, phone, logo_url, is_active, created_at, updated_at FROM companies WHERE id = $1`,
          [id],
        );
        updatedCompany = result.rows[0];
      }

      // ---- CEO/Admin-ийн нэвтрэх мэдээлэл (users table) ----
      if (admin_full_name || admin_email || admin_password) {
        const adminRow = await client.query(
          `SELECT id FROM users WHERE company_id = $1 AND role = 'company' AND deleted_at IS NULL LIMIT 1`,
          [id],
        );
        if (adminRow.rows.length === 0) {
          const err = new Error("Компанийн админ хэрэглэгч олдсонгүй.");
          err.statusCode = 404;
          throw err;
        }
        const adminId = adminRow.rows[0].id;

        if (admin_email) {
          const dupUser = await client.query(
            `SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL AND id != $2`,
            [admin_email, adminId],
          );
          if (dupUser.rows.length > 0) {
            const err = new Error(
              "Энэ имэйл хаяг өөр хэрэглэгчид бүртгэлтэй байна.",
            );
            err.statusCode = 409;
            throw err;
          }
        }

        const adminSetClauses = [];
        const adminValues = [];
        let j = 1;

        if (admin_full_name) {
          adminSetClauses.push(`full_name = $${j}`);
          adminValues.push(admin_full_name);
          j++;
        }
        if (admin_email) {
          adminSetClauses.push(`email = $${j}`);
          adminValues.push(admin_email);
          j++;
        }
        if (admin_password) {
          const passwordHash = await hashPassword(admin_password);
          adminSetClauses.push(`password_hash = $${j}`);
          adminValues.push(passwordHash);
          j++;
        }
        adminSetClauses.push("updated_at = now()");
        adminValues.push(adminId);

        const adminResult = await client.query(
          `UPDATE users SET ${adminSetClauses.join(", ")} WHERE id = $${j}
           RETURNING id, email, full_name`,
          adminValues,
        );
        updatedAdmin = adminResult.rows[0];
      } else {
        // Admin талбар өөрчлөгдөөгүй ч, response дотор одоо байгаа
        // admin мэдээллийг л буцаана (frontend дахин ачаалахгүйгээр
        // жагсаалтаа шинэчилж чадах).
        const adminRow = await client.query(
          `SELECT id, email, full_name FROM users WHERE company_id = $1 AND role = 'company' AND deleted_at IS NULL LIMIT 1`,
          [id],
        );
        updatedAdmin = adminRow.rows[0] || null;
      }
    });

    await auditService.logEvent({
      userId: req.auth.userId,
      action: "COMPANY_UPDATED",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"] || null,
      metadata: {
        companyId: id,
        companyUpdates,
        adminChanged: !!(admin_full_name || admin_email || admin_password),
      },
    });

    return res.status(200).json({
      company: {
        ...updatedCompany,
        admin_id: updatedAdmin ? updatedAdmin.id : null,
        admin_full_name: updatedAdmin ? updatedAdmin.full_name : null,
        admin_email: updatedAdmin ? updatedAdmin.email : null,
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
    if (!assertValidId(id, res)) return;

    const existing = await query(
      `SELECT id, name FROM companies WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Компани олдсонгүй." });
    }

    await query("UPDATE companies SET deleted_at = now() WHERE id = $1", [id]);
    await query(
      "UPDATE departments SET deleted_at = now() WHERE company_id = $1 AND deleted_at IS NULL",
      [id],
    );
    await query(
      "UPDATE users SET deleted_at = now() WHERE company_id = $1 AND deleted_at IS NULL",
      [id],
    );

    await auditService.logEvent({
      userId: req.auth.userId,
      action: "COMPANY_DELETED",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"] || null,
      metadata: { companyId: id, name: existing.rows[0].name },
    });

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

async function getLogoUploadUrl(req, res, next) {
  try {
    const { fileName, contentType } = logoUploadUrlSchema.parse(req.body);
    const result = blobService.generateUploadUrl(fileName, contentType);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof blobService.BlobConfigError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return next(err);
  }
}

module.exports = { list, create, update, remove, getLogoUploadUrl };
