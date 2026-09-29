'use strict';

const { query } = require('../config/db');
const guideBlob = require('../services/guideBlobService');

const AUDIENCES = ['company', 'department'];
const MAX_GUIDE_SIZE = 20 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// blob_path-ийг client руу хэзээ ч буцаахгүй — зөвхөн view-url-аар дамжина.
const PUBLIC_COLUMNS = `
  id, title, description, file_size_bytes, audience, is_active,
  sort_order, version, created_at, updated_at
`;

// ---------- validation helpers ----------

function validateTitle(value) {
  if (typeof value !== 'string') return 'Гарчиг шаардлагатай.';
  const t = value.trim();
  if (t.length < 2 || t.length > 200) return 'Гарчиг 2-200 тэмдэгттэй байх ёстой.';
  return null;
}

function normalizeDescription(value) {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string') return { error: 'Тайлбарын формат буруу байна.' };
  const d = value.trim();
  if (d.length > 1000) return { error: 'Тайлбар 1000 тэмдэгтээс хэтрэхгүй байх ёстой.' };
  return { value: d.length > 0 ? d : null };
}

function normalizeAudience(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'Хэнд харагдахыг дор хаяж нэгийг сонгоно уу.' };
  }
  const unique = [...new Set(value)];
  if (!unique.every((a) => AUDIENCES.includes(a))) {
    return { error: 'Хэнд харагдах утга буруу байна.' };
  }
  return { value: unique };
}

/** Upload хийгдсэн blob бодитоор байгаа, PDF, хэмжээ зөв эсэхийг шалгана. */
async function verifyUploadedBlob(blobPath) {
  if (!guideBlob.isValidGuideBlobPath(blobPath)) {
    return { error: 'Файлын зам буруу байна.' };
  }
  const info = await guideBlob.inspectGuideBlob(blobPath);
  if (!info.exists) {
    return { error: 'Файл байршуулагдаагүй байна. Дахин оролдоно уу.' };
  }
  if (!info.isPdf || info.size > MAX_GUIDE_SIZE || info.size === 0) {
    await guideBlob.deleteGuideBlob(blobPath);
    return {
      error: info.isPdf
        ? 'Файлын хэмжээ 20MB-с хэтэрсэн байна.'
        : 'Файл PDF биш байна.',
    };
  }
  return { size: info.size };
}

// ---------- handlers ----------

async function list(req, res, next) {
  try {
    const { role } = req.auth;

    let result;
    if (role === 'super_admin') {
      result = await query(
        `SELECT ${PUBLIC_COLUMNS} FROM system_guides
         WHERE deleted_at IS NULL
         ORDER BY sort_order, created_at`
      );
    } else if (AUDIENCES.includes(role)) {
      result = await query(
        `SELECT ${PUBLIC_COLUMNS} FROM system_guides
         WHERE deleted_at IS NULL AND is_active = true AND $1 = ANY(audience)
         ORDER BY sort_order, created_at`,
        [role]
      );
    } else {
      return res.status(403).json({ error: 'Хандах эрхгүй.' });
    }

    return res.json({ guides: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function getUploadUrl(req, res, next) {
  try {
    const { fileName, fileSize } = req.body || {};
    if (typeof fileName !== 'string' || fileName.length === 0) {
      return res.status(400).json({ error: 'Файлын нэр шаардлагатай.' });
    }
    if (typeof fileSize !== 'number' || fileSize <= 0 || fileSize > MAX_GUIDE_SIZE) {
      return res.status(400).json({ error: 'Файлын хэмжээ 20MB-с бага байх ёстой.' });
    }
    return res.json(guideBlob.generateGuideUploadUrl(fileName));
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const body = req.body || {};

    const titleError = validateTitle(body.title);
    if (titleError) return res.status(400).json({ error: titleError });

    const description = normalizeDescription(body.description);
    if (description.error) return res.status(400).json({ error: description.error });

    const audience = normalizeAudience(body.audience);
    if (audience.error) return res.status(400).json({ error: audience.error });

    const sortOrder =
      Number.isInteger(body.sort_order) && body.sort_order >= 0 ? body.sort_order : 0;

    const blob = await verifyUploadedBlob(body.blob_path);
    if (blob.error) return res.status(400).json({ error: blob.error });

    const result = await query(
      `INSERT INTO system_guides
         (title, description, blob_path, file_size_bytes, audience, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        body.title.trim(),
        description.value,
        body.blob_path,
        blob.size,
        audience.value,
        sortOrder,
        req.auth.userId,
      ]
    );

    return res.status(201).json({ guide: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: 'Заавар олдсонгүй.' });

    const existing = await query(
      `SELECT id, blob_path FROM system_guides WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Заавар олдсонгүй.' });
    const oldBlobPath = existing.rows[0].blob_path;

    const body = req.body || {};
    const sets = [];
    const values = [];
    let contentChanged = false; // updated_at-ийг зөвхөн агуулга өөрчлөгдөхөд шинэчилнэ
    let newBlobPath = null;

    function addSet(column, value) {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }

    if (body.title !== undefined) {
      const titleError = validateTitle(body.title);
      if (titleError) return res.status(400).json({ error: titleError });
      addSet('title', body.title.trim());
      contentChanged = true;
    }

    if (body.description !== undefined) {
      const description = normalizeDescription(body.description);
      if (description.error) return res.status(400).json({ error: description.error });
      addSet('description', description.value);
      contentChanged = true;
    }

    if (body.audience !== undefined) {
      const audience = normalizeAudience(body.audience);
      if (audience.error) return res.status(400).json({ error: audience.error });
      addSet('audience', audience.value);
    }

    if (body.is_active !== undefined) {
      if (typeof body.is_active !== 'boolean') {
        return res.status(400).json({ error: 'Төлөвийн формат буруу байна.' });
      }
      addSet('is_active', body.is_active);
    }

    if (body.sort_order !== undefined) {
      if (!Number.isInteger(body.sort_order) || body.sort_order < 0) {
        return res.status(400).json({ error: 'Дарааллын утга буруу байна.' });
      }
      addSet('sort_order', body.sort_order);
    }

    if (body.blob_path !== undefined && body.blob_path !== oldBlobPath) {
      const blob = await verifyUploadedBlob(body.blob_path);
      if (blob.error) return res.status(400).json({ error: blob.error });
      addSet('blob_path', body.blob_path);
      addSet('file_size_bytes', blob.size);
      sets.push('version = version + 1');
      newBlobPath = body.blob_path;
      contentChanged = true;
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'Өөрчлөх талбар алга.' });
    }
    if (contentChanged) sets.push('updated_at = now()');

    values.push(id);
    const result = await query(
      `UPDATE system_guides SET ${sets.join(', ')}
       WHERE id = $${values.length} AND deleted_at IS NULL
       RETURNING ${PUBLIC_COLUMNS}`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Заавар олдсонгүй.' });

    // Файл солигдсон бол хуучин blob-ийг цэвэрлэнэ (storage-д өнчин файл үлдээхгүй).
    if (newBlobPath) {
      await guideBlob.deleteGuideBlob(oldBlobPath);
    }

    return res.json({ guide: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: 'Заавар олдсонгүй.' });

    // Soft delete — blob-ийг үлдээнэ, шаардлагатай бол DB-ээс сэргээж болно.
    const result = await query(
      `UPDATE system_guides SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Заавар олдсонгүй.' });

    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
}

async function getViewUrl(req, res, next) {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: 'Заавар олдсонгүй.' });

    const result = await query(
      `SELECT title, blob_path, audience, is_active FROM system_guides
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Заавар олдсонгүй.' });

    const guide = result.rows[0];
    const { role } = req.auth;

    // Эрхгүй бол байгаа эсэхийг ч илчлэхгүйн тулд 404 буцаана.
    if (role !== 'super_admin') {
      if (!AUDIENCES.includes(role) || !guide.is_active || !guide.audience.includes(role)) {
        return res.status(404).json({ error: 'Заавар олдсонгүй.' });
      }
    }

    return res.json({ url: guideBlob.generateGuideReadUrl(guide.blob_path, guide.title) });
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, getUploadUrl, create, update, remove, getViewUrl };