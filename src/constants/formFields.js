'use strict';

const { z } = require('zod');

/**
 * Хэлтсийн формын талбар, нэгжийн дүрэм.
 *
 * АНХААР: frontend-ийн lib/units.ts-тэй ИЖИЛ байх ёстой. Нэгж нэмэх/өөрчлөхдөө
 * хоёуланг нь зэрэг засна. Unit ID-г хэзээ ч бүү өөрчил — DB-д хадгалагдсан
 * талбарууд үүгээр заана.
 */

const UNITS = Object.freeze({
  // decimals — таслалаас хойших оронгийн дээд тоо, max — үнэмлэхүй утгын
  // дээд хязгаар (бодит бус утгаас хамгаална). Frontend-тэй ИЖИЛ.
  // Мөнгө — сөрөг байж болно (алдагдал, сөрөг мөнгөн урсгал)
  mnt: { scale: 1, integer: false, allowNegative: true, max: 1e14, decimals: 0 },
  mnt_million: { scale: 1e6, integer: false, allowNegative: true, max: 1e8, decimals: 2 },
  mnt_billion: { scale: 1e9, integer: false, allowNegative: true, max: 1e5, decimals: 2 },
  // Тоо ширхэг — бүхэл, сөрөг биш
  person: { scale: 1, integer: true, allowNegative: false, max: 1e6, decimals: 0 },
  piece: { scale: 1, integer: true, allowNegative: false, max: 1e9, decimals: 0 },
  count: { scale: 1, integer: true, allowNegative: false, max: 1e9, decimals: 0 },
  project: { scale: 1, integer: true, allowNegative: false, max: 1e5, decimals: 0 },
  process: { scale: 1, integer: true, allowNegative: false, max: 1e5, decimals: 0 },
  supplier: { scale: 1, integer: true, allowNegative: false, max: 1e6, decimals: 0 },
  // Хэмжигдэхүүн — бутархай, сөрөг биш
  hour: { scale: 1, integer: false, allowNegative: false, max: 1e9, decimals: 2 },
  kwh: { scale: 1, integer: false, allowNegative: false, max: 1e13, decimals: 2 },
  ton: { scale: 1, integer: false, allowNegative: false, max: 1e10, decimals: 2 },
  // Үнэлгээ
  percent: { scale: 1, integer: false, allowNegative: false, max: 100, decimals: 2 },
  score: { scale: 1, integer: false, allowNegative: false, max: 1e6, decimals: 2 },
});

const UNIT_IDS = Object.keys(UNITS);
const FREQUENCIES = ['quarter', 'year'];

/** Талбарын код: "D-201", "HR-015". Frontend-тэй ижил дүрэм. */
const CODE_PATTERN = /^[A-Z]{1,5}-\d{3,4}$/;

const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

// ---------- Загварын form_schema шалгалт (department template PATCH) ----------

const formFieldSchema = z.object({
  code: z.string().trim().regex(CODE_PATTERN, 'Талбарын код "D-201" хэлбэртэй байх ёстой.'),
  label: z.string().trim().min(1, 'Талбарын нэрийг оруулна уу.').max(300),
  unit: z.enum(UNIT_IDS, { errorMap: () => ({ message: 'Нэгж буруу байна.' }) }),
  frequency: z.enum(FREQUENCIES, { errorMap: () => ({ message: 'Давтамж буруу байна.' }) }),
  required: z.boolean(),
  active: z.boolean(),
});

/**
 * Загварын бүх талбарын жагсаалт. Код давхардахгүй (идэвхгүй талбар ч
 * орно — хуучин тайлангууд тэр кодоор хадгалагдсан), идэвхтэй талбарын нэр
 * давхардахгүй.
 */
const formSchemaSchema = z
  .array(formFieldSchema)
  .max(300, 'Талбарын тоо хэт олон байна.')
  .superRefine((fields, ctx) => {
    const codes = new Set();
    const activeLabels = new Set();
    fields.forEach((field, index) => {
      if (codes.has(field.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'code'],
          message: `"${field.code}" код давхардсан байна.`,
        });
      }
      codes.add(field.code);

      if (field.active) {
        if (activeLabels.has(field.label)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'label'],
            message: `"${field.label}" нэртэй идэвхтэй талбар давхардсан байна.`,
          });
        }
        activeLabels.add(field.label);
      }
    });
  });

// ---------- Тайлангийн утгын шалгалт ----------

/** Нэг утгыг нэгжийн дүрмээр шалгана. */
function validateValue(unitId, raw) {
  if (!NUMBER_PATTERN.test(raw)) return { ok: false, error: 'Зөвхөн тоо оруулна уу.' };

  const value = Number(raw);
  if (!Number.isFinite(value)) return { ok: false, error: 'Тоо хэт том байна.' };

  const def = UNITS[unitId];
  if (!def) return { ok: true }; // шилжүүлээгүй хуучин талбар — зөвхөн тоо эсэхийг шалгана

  if (!def.allowNegative && value < 0) return { ok: false, error: 'Сөрөг утга оруулах боломжгүй.' };
  if ((def.integer || def.decimals === 0) && !Number.isInteger(value)) {
    return { ok: false, error: 'Бүхэл тоо оруулна уу.' };
  }
  const fraction = raw.split('.')[1] || '';
  if (fraction.length > def.decimals) {
    return { ok: false, error: `Таслалаас хойш ${def.decimals}-аас олон орон оруулах боломжгүй.` };
  }
  if (Math.abs(value) > def.max) {
    if (unitId === 'percent') return { ok: false, error: '100%-иас их байж болохгүй.' };
    return { ok: false, error: `Хэт их утга байна (дээд хязгаар ${def.max.toLocaleString('en-US')}). Нэгжээ шалгана уу.` };
  }
  return { ok: true };
}

/**
 * Тухайн улирлын тайланд бөглөх талбар мөн эсэх. Жилийн ('year') үзүүлэлт
 * зөвхөн 4-р улиралд. Хугацаагүй хуучин тайланд (quarter = null) бүгд хамаарна.
 */
function fieldAppliesTo(field, quarter) {
  if (field.frequency !== 'year') return true;
  return quarter === null || quarter === undefined || quarter === 4;
}

/**
 * Тайлангийн data-г загварын талбаруудаар шалгаж цэвэрлэнэ.
 *   - Түлхүүр нь талбарын код байх ёстой (идэвхгүй талбарын код ч зөвшөөрнө —
 *     хуучин тайланг компани засах үед).
 *   - Хоосон утгыг хадгалахгүй.
 *   - Тухайн улиралд хамаарахгүй жилийн талбарын утгыг хаяна.
 *   - Идэвхтэй, заавал бөглөх, тухайн улиралд хамаарах талбар бүр бөглөгдсөн байна.
 *
 * @param {Array} formSchema  загварын form_schema
 * @param {Record<string,string>} data
 * @param {number|null} quarter
 * @param {{ enforceRequired?: boolean }} [options]
 * @returns {{ error: string } | { value: Record<string,string> }}
 */
function validateSubmissionData(formSchema, data, quarter, { enforceRequired = true } = {}) {
  const fields = Array.isArray(formSchema) ? formSchema.filter((f) => f && typeof f.code === 'string') : [];
  const byCode = new Map(fields.map((f) => [f.code, f]));
  const cleaned = {};

  for (const [key, rawValue] of Object.entries(data || {})) {
    const value = String(rawValue ?? '').trim();
    if (value === '') continue;

    const field = byCode.get(key);
    if (!field) return { error: 'Тайланд формд байхгүй талбар орсон байна. Хуудсаа шинэчлээд дахин оролдоно уу.' };
    if (!fieldAppliesTo(field, quarter)) continue;

    const check = validateValue(field.unit, value);
    if (!check.ok) return { error: `"${field.label}": ${check.error}` };
    cleaned[key] = value;
  }

  if (enforceRequired) {
    for (const field of fields) {
      if (!field.active || !field.required || !fieldAppliesTo(field, quarter)) continue;
      if (!(field.code in cleaned)) return { error: `"${field.label}" талбарыг бөглөнө үү.` };
    }
  }

  if (Object.keys(cleaned).length === 0) return { error: 'Дор хаяж нэг талбар бөглөнө үү.' };
  return { value: cleaned };
}

module.exports = {
  UNITS,
  UNIT_IDS,
  FREQUENCIES,
  CODE_PATTERN,
  formFieldSchema,
  formSchemaSchema,
  validateValue,
  validateSubmissionData,
  fieldAppliesTo,
};