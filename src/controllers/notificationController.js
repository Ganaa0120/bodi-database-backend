'use strict';

const { query, withTransaction } = require('../config/db');
const attachmentBlob = require('../services/notificationAttachmentBlobService');

const MAX_ATTACHMENTS = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SELECTED = 1000;

/**
 * Мэдэгдэл хүлээн авах эрхтэй хэрэглэгчид: идэвхтэй компанийн CEO
 * (role = 'company') болон идэвхтэй хэлтсийн админ (role = 'department').
 * "Бүгдэд" илгээхэд яг энэ жагсаалт ашиглагдана.
 */
const ELIGIBLE_USERS_SQL = `
  SELECT
    u.id,
    u.full_name,
    u.email,
    u.role,
    u.company_id,
    c.name AS company_name,
    u.department_id,
    d.name AS department_name
  FROM users u
  JOIN companies c ON c.id = u.company_id
  LEFT JOIN departments d ON d.id = u.department_id
  WHERE u.role IN ('company', 'department')
    AND c.is_active = true
    AND (u.role = 'company' OR d.is_active = true)
`;

/** Мэдэгдлийн хавсралтын тоо (жагсаалтад 📎 харуулахад). */
const ATTACHMENT_COUNT_SQL = `
  (SELECT count(*)::int FROM notification_attachments a WHERE a.notification_id = n.id)
`;

/**
 * Хүсэлтээр ирсэн хавсралтуудыг шалгана — blob бодитоор байгаа, төрөл,
 * хэмжээ, эхний байт зөв эсэх. Transaction эхлэхээс ӨМНӨ дуудна.
 * @returns {Promise<{ error: string } | { value: Array }>}
 */
async function validateAttachments(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: 'Хавсралтын формат буруу байна.' };
  if (raw.length > MAX_ATTACHMENTS) {
    return { error: `Дээд тал нь ${MAX_ATTACHMENTS} файл хавсаргана.` };
  }

  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const blobPath = item && item.blob_path;
    const contentType = item && item.content_type;
    const fileName = item && typeof item.file_name === 'string' ? item.file_name.trim().slice(0, 200) : '';

    if (!fileName || !attachmentBlob.isValidAttachmentBlobPath(blobPath, contentType) || seen.has(blobPath)) {
      return { error: 'Хавсралтын мэдээлэл буруу байна.' };
    }
    seen.add(blobPath);

    const check = await attachmentBlob.verifyAttachmentBlob(blobPath, contentType);
    if (!check.ok) return { error: `"${fileName}": ${check.error}` };

    result.push({ blobPath, contentType, fileName, size: check.size });
  }
  return { value: result };
}

// ---------- Super admin ----------

/** Хавсралт upload хийх SAS URL. */
async function getAttachmentUploadUrl(req, res, next) {
  try {
    const { contentType, fileSize } = req.body || {};
    if (!attachmentBlob.isAllowedType(contentType)) {
      return res.status(400).json({
        error: 'Зөвхөн зураг (PNG, JPG, WEBP), PDF, Word, Excel, PowerPoint файл хавсаргана.',
      });
    }
    if (typeof fileSize !== 'number' || fileSize <= 0 || fileSize > attachmentBlob.MAX_ATTACHMENT_SIZE) {
      return res.status(400).json({ error: 'Файлын хэмжээ 10MB-с бага байх ёстой.' });
    }
    return res.json(attachmentBlob.generateAttachmentUploadUrl(contentType));
  } catch (err) {
    return next(err);
  }
}

/** Хүлээн авагч сонгох жагсаалт — компаниар эрэмбэлсэн. */
async function listRecipientOptions(req, res, next) {
  try {
    const result = await query(
      `SELECT * FROM (${ELIGIBLE_USERS_SQL}) e
       ORDER BY e.company_name,
                CASE e.role WHEN 'company' THEN 0 ELSE 1 END,
                e.department_name NULLS FIRST,
                e.full_name`
    );
    return res.json({ recipients: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  const body = req.body || {};

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const target = body.target;

  if (title.length < 2 || title.length > 200) {
    return res.status(400).json({ error: 'Гарчиг 2-200 тэмдэгттэй байх ёстой.' });
  }
  if (text.length < 1 || text.length > 5000) {
    return res.status(400).json({ error: 'Агуулга 1-5000 тэмдэгттэй байх ёстой.' });
  }
  if (target !== 'all' && target !== 'selected') {
    return res.status(400).json({ error: 'Хүлээн авагчийн төрөл буруу байна.' });
  }

  let userIds = [];
  if (target === 'selected') {
    if (!Array.isArray(body.user_ids) || body.user_ids.length === 0) {
      return res.status(400).json({ error: 'Дор хаяж нэг хүлээн авагч сонгоно уу.' });
    }
    userIds = [...new Set(body.user_ids)];
    if (userIds.length > MAX_SELECTED || !userIds.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) {
      return res.status(400).json({ error: 'Хүлээн авагчийн жагсаалт буруу байна.' });
    }
  }

  let attachments;
  try {
    const checked = await validateAttachments(body.attachments);
    if (checked.error) return res.status(400).json({ error: checked.error });
    attachments = checked.value;
  } catch (err) {
    return next(err);
  }

  try {
    const notification = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO notifications (title, body, target_type, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, body, target_type, created_at`,
        [title, text, target, req.auth.userId]
      );
      const row = inserted.rows[0];

      // Сонгосон ID-ууд ч гэсэн ELIGIBLE жагсаалтаар шүүгдэнэ — идэвхгүй
      // компани, super_admin, эсвэл байхгүй хэрэглэгч рүү илгээгдэхгүй.
      const recipients =
        target === 'all'
          ? await client.query(
              `INSERT INTO notification_recipients (notification_id, user_id)
               SELECT $1, e.id FROM (${ELIGIBLE_USERS_SQL}) e`,
              [row.id]
            )
          : await client.query(
              `INSERT INTO notification_recipients (notification_id, user_id)
               SELECT $1, e.id FROM (${ELIGIBLE_USERS_SQL}) e
               WHERE e.id = ANY($2)`,
              [row.id, userIds]
            );

      if (recipients.rowCount === 0) {
        const err = new Error('Идэвхтэй хүлээн авагч олдсонгүй.');
        err.statusCode = 400;
        throw err; // withTransaction ROLLBACK хийнэ
      }

      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        await client.query(
          `INSERT INTO notification_attachments
             (notification_id, blob_path, file_name, content_type, file_size_bytes, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.id, a.blobPath, a.fileName, a.contentType, a.size, i]
        );
      }

      return { ...row, recipient_count: recipients.rowCount };
    });

    return res.status(201).json({
      notification: {
        ...notification,
        read_count: 0,
        attachment_count: attachments.length,
      },
    });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    return next(err);
  }
}

/** Илгээсэн мэдэгдлүүд + хэдэн хүн уншсан статистик. */
async function listSent(req, res, next) {
  try {
    const result = await query(
      `SELECT
         n.id, n.title, n.body, n.target_type, n.created_at,
         count(r.user_id)::int AS recipient_count,
         count(r.read_at)::int AS read_count,
         ${ATTACHMENT_COUNT_SQL} AS attachment_count
       FROM notifications n
       LEFT JOIN notification_recipients r ON r.notification_id = n.id
       WHERE n.deleted_at IS NULL
       GROUP BY n.id
       ORDER BY n.created_at DESC
       LIMIT 200`
    );
    return res.json({ notifications: result.rows });
  } catch (err) {
    return next(err);
  }
}

/** Нэг мэдэгдлийн хүлээн авагч бүрийн уншсан эсэх. */
async function listRecipientStatus(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй.' });

    const exists = await query(
      `SELECT 1 FROM notifications WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (exists.rowCount === 0) return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй.' });

    const result = await query(
      `SELECT
         r.user_id, r.read_at,
         u.full_name, u.email, u.role,
         c.name AS company_name,
         d.name AS department_name
       FROM notification_recipients r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN companies c ON c.id = u.company_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE r.notification_id = $1
       ORDER BY c.name,
                CASE u.role WHEN 'company' THEN 0 ELSE 1 END,
                d.name NULLS FIRST,
                u.full_name`,
      [id]
    );
    return res.json({ recipients: result.rows });
  } catch (err) {
    return next(err);
  }
}

/** Soft delete — хүлээн авагчдын inbox-оос алга болно. */
async function remove(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй.' });

    const result = await query(
      `UPDATE notifications SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй.' });
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
}

// ---------- CEO / department admin ----------

async function listMine(req, res, next) {
  try {
    const result = await query(
      `SELECT n.id, n.title, n.body, n.created_at, r.read_at,
              ${ATTACHMENT_COUNT_SQL} AS attachment_count
       FROM notification_recipients r
       JOIN notifications n ON n.id = r.notification_id
       WHERE r.user_id = $1 AND n.deleted_at IS NULL
       ORDER BY n.created_at DESC
       LIMIT 100`,
      [req.auth.userId]
    );
    return res.json({ notifications: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function unreadCount(req, res, next) {
  try {
    const result = await query(
      `SELECT count(*)::int AS count
       FROM notification_recipients r
       JOIN notifications n ON n.id = r.notification_id
       WHERE r.user_id = $1 AND r.read_at IS NULL AND n.deleted_at IS NULL`,
      [req.auth.userId]
    );
    return res.json({ count: result.rows[0].count });
  } catch (err) {
    return next(err);
  }
}

async function markRead(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй.' });

    // Аль хэдийн уншсан бол read_at-ийг өөрчлөхгүй (анх уншсан цаг хадгалагдана).
    const result = await query(
      `UPDATE notification_recipients r
       SET read_at = COALESCE(r.read_at, now())
       FROM notifications n
       WHERE r.notification_id = $1
         AND r.user_id = $2
         AND n.id = r.notification_id
         AND n.deleted_at IS NULL
       RETURNING r.read_at`,
      [id, req.auth.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй.' });
    return res.json({ read_at: result.rows[0].read_at });
  } catch (err) {
    return next(err);
  }
}

async function markAllRead(req, res, next) {
  try {
    const result = await query(
      `UPDATE notification_recipients r
       SET read_at = now()
       FROM notifications n
       WHERE r.user_id = $1
         AND r.read_at IS NULL
         AND n.id = r.notification_id
         AND n.deleted_at IS NULL`,
      [req.auth.userId]
    );
    return res.json({ updated: result.rowCount });
  } catch (err) {
    return next(err);
  }
}

// ---------- Хавсралт (бүх role) ----------

/**
 * Мэдэгдлийн хавсралтууд + 15 минутын read link.
 * super_admin — бүх мэдэгдэл; бусад — зөвхөн өөрт ирсэн мэдэгдэл.
 */
async function listAttachments(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй.' });

    const { role, userId } = req.auth;
    const access =
      role === 'super_admin'
        ? await query(`SELECT 1 FROM notifications WHERE id = $1 AND deleted_at IS NULL`, [id])
        : await query(
            `SELECT 1 FROM notification_recipients r
             JOIN notifications n ON n.id = r.notification_id
             WHERE r.notification_id = $1 AND r.user_id = $2 AND n.deleted_at IS NULL`,
            [id, userId]
          );
    if (access.rowCount === 0) return res.status(404).json({ error: 'Мэдэгдэл олдсонгүй.' });

    const result = await query(
      `SELECT id, blob_path, file_name, content_type, file_size_bytes
       FROM notification_attachments
       WHERE notification_id = $1
       ORDER BY sort_order, created_at`,
      [id]
    );

    const attachments = result.rows.map((a) => ({
      id: a.id,
      file_name: a.file_name,
      content_type: a.content_type,
      file_size_bytes: a.file_size_bytes,
      url: attachmentBlob.generateAttachmentReadUrl(a.blob_path, a.file_name, a.content_type),
    }));

    return res.json({ attachments });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getAttachmentUploadUrl,
  listAttachments,
  listRecipientOptions,
  create,
  listSent,
  listRecipientStatus,
  remove,
  listMine,
  unreadCount,
  markRead,
  markAllRead,
};