'use strict';

const { UNITS } = require('../constants/formFields');
const HttpError = require('../utils/httpError');

/**
 * submission_values — KPI тооцооллын оролт.
 *
 * form_submissions.data (JSONB) бол ЭХ СУРВАЛЖ. Энэ хүснэгт нь түүнээс гаргаж
 * авсан, KPI тооцоолоход бэлэн хэлбэр:
 *   нэг мөр = нэг компани × нэг улирал × нэг код, value_base нь суурь нэгжээр (₮).
 *
 * ИНВАРИАНТ (систем энэ дүрмийг үргэлж барина):
 *   Тайлан accepted, устгагдаагүй, хугацаатай байвал — формын кодтой, хоосон
 *   биш утга бүр яг нэг мөртэй. Бусад бүх тохиолдолд тухайн тайлангийн мөр 0.
 *
 * Үүнийг барихын тулд form_submissions-ийн status / data / хугацаа / deleted_at
 * өөрчлөгдөх БҮХ газарт syncSubmissionValues-ийг ИЖИЛ transaction дотор дуудна.
 * Тэгвэл тайлан болон түүний утгууд хэзээ ч зөрөхгүй — аль нэг нь алдаа
 * өгвөл хоёулаа rollback болно.
 *
 * Нарийвчлал: value_base-ийг JS-д биш, Postgres NUMERIC-ээр бодно
 * (value::numeric * scale::numeric) — float огт оролцохгүй, яг тоо.
 * DB дээрх CHECK constraint нь value_base зөв эсэхийг давхар шалгана.
 */

if (!UNITS || typeof UNITS !== 'object') {
  throw new Error(
    '[submissionValuesService] src/constants/formFields.js нь UNITS-ийг export хийхгүй байна. ' +
      'module.exports-д UNITS нэмнэ үү.'
  );
}

const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const COMPANY_PERIOD_CODE_UNIQ = 'submission_values_company_period_code_uniq';

/** 1e9 → "1000000000". Бүхэл, эерэг биш scale-ийг зөвшөөрөхгүй. */
function scaleToString(unit, scale) {
  if (!Number.isSafeInteger(scale) || scale < 1) {
    throw new Error(`[submissionValuesService] "${unit}" нэгжийн scale буруу байна: ${scale}`);
  }
  return BigInt(scale).toString();
}

/**
 * Формын талбарын дарааллаар (код, нэгж, утга, scale) мөрүүдийг гаргана.
 * Загварт байхгүй түлхүүр (кодгүй хуучин утга) тооцоололд орохгүй.
 */
function buildValueRows(formSchema, data) {
  const rows = [];
  const invalid = [];

  for (const field of formSchema) {
    const code = field && typeof field.code === 'string' ? field.code : '';
    if (!code) continue;

    const raw = data[code];
    if (raw === undefined || raw === null) continue;
    const text = String(raw).trim();
    if (text === '') continue;

    const def = UNITS[field.unit];
    if (!def) {
      invalid.push(`${code} (нэгж "${field.unit}" каталогт байхгүй)`);
      continue;
    }
    if (!NUMBER_PATTERN.test(text)) {
      invalid.push(`${code} ("${text}" тоо биш)`);
      continue;
    }

    rows.push({ code, unit: field.unit, value: text, scale: scaleToString(field.unit, def.scale) });
  }

  return { rows, invalid };
}

/**
 * Нэг тайлангийн submission_values мөрүүдийг тайлангийн ОДООГИЙН төлөвтэй
 * тааруулна. Заавал withTransaction-ий client-ээр дуудна.
 *
 * @returns {Promise<{ count: number }>} бичигдсэн мөрийн тоо
 * @throws {HttpError} 409 — өөр хэлтэс энэ улиралд ижил кодыг оруулсан
 * @throws {HttpError} 422 — утга тооцоололд орох боломжгүй (тоо биш, нэгж буруу)
 */
async function syncSubmissionValues(client, submissionId) {
  await client.query('DELETE FROM submission_values WHERE submission_id = $1', [submissionId]);

  const result = await client.query(
    `SELECT fs.id, fs.company_id, fs.department_id, fs.period_year, fs.period_quarter,
            fs.status, fs.deleted_at, fs.data, t.form_schema
     FROM form_submissions fs
     JOIN departments d ON d.id = fs.department_id
     LEFT JOIN department_templates t ON t.id = d.template_id
     WHERE fs.id = $1`,
    [submissionId]
  );
  const sub = result.rows[0];

  const counts =
    sub &&
    sub.status === 'accepted' &&
    !sub.deleted_at &&
    sub.period_year !== null &&
    sub.period_quarter !== null;
  if (!counts) return { count: 0 };

  if (!Array.isArray(sub.form_schema)) {
    throw new HttpError(409, 'Хэлтэст форм загвар холбогдоогүй тул тайлангийн утгуудыг бүртгэх боломжгүй.');
  }

  const { rows, invalid } = buildValueRows(sub.form_schema, sub.data || {});
  if (invalid.length > 0) {
    throw new HttpError(
      422,
      `Дараах талбарын утга тооцоололд орох боломжгүй: ${invalid.join(', ')}. Тайланг засуулна уу.`
    );
  }
  if (rows.length === 0) return { count: 0 };

  const codes = rows.map((r) => r.code);

  // Нэг код нэг компанид нэг улиралд ЗӨВХӨН нэг хэлтсээс ирнэ.
  // Unique index нь сүүлчийн хамгаалалт; энд урьдчилан шалгаж ойлгомжтой мессеж өгнө.
  const clash = await client.query(
    `SELECT sv.code, d.name AS department_name
     FROM submission_values sv
     JOIN departments d ON d.id = sv.department_id
     WHERE sv.company_id = $1 AND sv.period_year = $2 AND sv.period_quarter = $3
       AND sv.code = ANY($4::text[]) AND sv.submission_id <> $5
     ORDER BY sv.code`,
    [sub.company_id, sub.period_year, sub.period_quarter, codes, sub.id]
  );
  if (clash.rows.length > 0) {
    const list = clash.rows.map((r) => `${r.code} (${r.department_name})`).join(', ');
    throw new HttpError(
      409,
      `${sub.period_year} оны ${sub.period_quarter}-р улиралд дараах кодын утгыг өөр хэлтэс аль хэдийн ` +
        `оруулсан байна: ${list}. Нэг код нэг компанид зөвхөн нэг хэлтсээс ирэх ёстой — ` +
        `хэлтсүүдийн формын тохиргоог шалгана уу.`
    );
  }

  try {
    await client.query(
      `INSERT INTO submission_values
         (submission_id, company_id, department_id, period_year, period_quarter,
          code, unit, value, value_base)
       SELECT $1, $2, $3, $4, $5,
              v.code, v.unit, v.value, v.value::numeric * v.scale::numeric
       FROM unnest($6::text[], $7::text[], $8::text[], $9::text[]) AS v(code, unit, value, scale)`,
      [
        sub.id,
        sub.company_id,
        sub.department_id,
        sub.period_year,
        sub.period_quarter,
        codes,
        rows.map((r) => r.unit),
        rows.map((r) => r.value),
        rows.map((r) => r.scale),
      ]
    );
  } catch (err) {
    if (err && err.code === '23505' && err.constraint === COMPANY_PERIOD_CODE_UNIQ) {
      throw new HttpError(
        409,
        'Энэ улиралд ижил кодын утгыг өөр хэлтэс яг одоо бүртгэж байна. Хуудсаа шинэчлээд дахин оролдоно уу.'
      );
    }
    throw err;
  }

  return { count: rows.length };
}

module.exports = { syncSubmissionValues, buildValueRows };