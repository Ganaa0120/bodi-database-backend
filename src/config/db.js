"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const { Pool } = require("pg");
const env = require("./env");

/**
 * Database холболт + Row-Level Security (RLS) context.
 *
 * Хүсэлт бүр (request) өөрийн гэсэн context-тэй:
 *   { role, userId, companyId, departmentId }  — ЗӨВХӨН JWT-ээс.
 *
 * query() / withTransaction() дуудагдахад тухайн хүсэлтийн context-ийг
 * Postgres-ийн session хувьсагч (app.role, app.company_id ...) болгон
 * тохируулсан connection ашиглана. RLS policy-ууд эдгээр хувьсагчаар
 * мөр шүүнэ — controller WHERE нөхцөлөө мартсан ч өөр компанийн өгөгдөл
 * гарахгүй.
 *
 * Аюулгүй байдлын зарчмууд:
 * - Context-гүй query хийх оролдлого алдаа өгнө (fail closed).
 * - Connection pool руу буцаахаасаа ӨМНӨ хувьсагчуудыг заавал цэвэрлэнэ;
 *   цэвэрлэж чадахгүй бол connection-ийг устгана (дараагийн хүсэлт
 *   өмнөх хэрэглэгчийн эрхийг өвлөхгүй).
 * - Connection-ийг хүсэлтийн анхны query хийгдэх үед л авна (lazy) —
 *   DB ашиглахгүй хүсэлт pool-ийг эзлэхгүй.
 *
 * Холболт тасрах үеийн тогтвортой байдал:
 * - pg-pool зөвхөн pool дотор idle байгаа client-д error handler тавьдаг.
 *   Хүсэлт авч ашиглаж байгаа (checked-out) client-ийн холболт гэнэт
 *   тасарвал listener-гүй 'error' event бүх process-ийг унагана. Тиймээс
 *   client бүрт өөрийн error listener тавьж, тасарсан client-ийг pool руу
 *   буцаахгүй устгана.
 * - keepAlive: router / NAT idle холболтыг чимээгүй тасалдаг асуудлаас
 *   хамгаална.
 */

const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  ssl: env.db.sslMode === "disable" ? false : { rejectUnauthorized: false },
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[db] Idle холболт тасарлаа:", err.message);
});

const contextStorage = new AsyncLocalStorage();

const VALID_ROLES = new Set(["super_admin", "company", "department", "system"]);

/** Client дээр тэмдэглэгээ хадгалах түлхүүрүүд (pg-ийн property-тэй давхцахгүй). */
const ERROR_HANDLER_ATTACHED = Symbol("bodiErrorHandlerAttached");
const CLIENT_BROKEN = Symbol("bodiClientBroken");

class DbContextError extends Error {
  constructor(message) {
    super(message);
    this.name = "DbContextError";
    this.statusCode = 500;
  }
}

function createContext({
  role,
  userId = null,
  companyId = null,
  departmentId = null,
}) {
  if (!VALID_ROLES.has(role)) {
    throw new DbContextError(`DB context-ийн role буруу байна: ${role}`);
  }
  return {
    auth: { role, userId, companyId, departmentId },
    clientPromise: null,
    pending: 0, // гүйцэтгэгдэж буй query-ийн тоо
    ended: false, // response дууссан эсэх
    released: false,
  };
}

/**
 * Checked-out client-д error listener тавина. pg-pool client-уудыг дахин
 * ашигладаг тул нэг client-д нэг л удаа тавина (listener хуримтлагдахгүй).
 */
function attachErrorHandler(client) {
  // Шинээр pool-оос авсан бүрт "эвдэрсэн" тэмдэглэгээг цэвэрлэнэ.
  client[CLIENT_BROKEN] = false;
  if (client[ERROR_HANDLER_ATTACHED]) return;
  client[ERROR_HANDLER_ATTACHED] = true;

  client.on("error", (err) => {
    client[CLIENT_BROKEN] = true;
    // eslint-disable-next-line no-console
    console.error("[db] Идэвхтэй холболт тасарлаа:", err.message);
  });
}

async function acquireClient(store) {
  const client = await pool.connect();
  attachErrorHandler(client);

  const { role, userId, companyId, departmentId } = store.auth;
  try {
    await client.query(
      `SELECT set_config('app.role', $1, false),
              set_config('app.user_id', $2, false),
              set_config('app.company_id', $3, false),
              set_config('app.department_id', $4, false)`,
      [role, userId || "", companyId || "", departmentId || ""],
    );
  } catch (err) {
    client.release(err); // алдаатай connection-ийг pool-оос хасна
    throw err;
  }
  return client;
}

function getClient(store) {
  if (!store.clientPromise) {
    store.clientPromise = acquireClient(store);
  }
  return store.clientPromise;
}

async function releaseClient(store) {
  if (store.released) return;
  store.released = true;
  if (!store.clientPromise) return;

  let client;
  try {
    client = await store.clientPromise;
  } catch {
    return; // connection авч чадаагүй — буцаах зүйлгүй
  }

  // Холболт аль хэдийн тасарсан бол цэвэрлэх query ажиллахгүй — шууд устгана.
  if (client[CLIENT_BROKEN]) {
    client.release(new Error("Холболт тасарсан"));
    return;
  }

  try {
    await client.query(
      `SELECT set_config('app.role', '', false),
              set_config('app.user_id', '', false),
              set_config('app.company_id', '', false),
              set_config('app.department_id', '', false)`,
    );
    client.release();
  } catch (err) {
    client.release(err); // цэвэрлэж чадаагүй бол connection-ийг устгана
  }
}

function markEnded(store) {
  store.ended = true;
  if (store.pending === 0) releaseClient(store).catch(() => {});
}

async function track(store, fn) {
  store.pending += 1;
  try {
    return await fn();
  } finally {
    store.pending -= 1;
    if (store.ended && store.pending === 0)
      releaseClient(store).catch(() => {});
  }
}

function currentStore() {
  const store = contextStorage.getStore();
  if (!store) {
    throw new DbContextError(
      "DB context тохируулагдаагүй байна. Route дээр authenticate эсвэл systemContext middleware байгаа эсэхийг шалгана уу.",
    );
  }
  if (store.ended || store.released) {
    // Response илгээгдсэний дараа эхэлсэн query — connection аль хэдийн
    // цэвэрлэгдэж байж болох тул зөвшөөрөхгүй.
    throw new DbContextError(
      "Response дууссаны дараа DB query хийх оролдлого илэрлээ.",
    );
  }
  return store;
}

/** Хүсэлтийн context-тэй query. */
function query(text, params) {
  const store = currentStore();
  return track(store, async () => {
    const client = await getClient(store);
    return client.query(text, params);
  });
}

/** Хүсэлтийн context-тэй transaction. fn(client) доторх бүх query нэг transaction-д. */
function withTransaction(fn) {
  const store = currentStore();
  return track(store, async () => {
    const client = await getClient(store);
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  });
}

/**
 * Express middleware-ээс дуудагдана: next()-ийг context дотор ажиллуулж,
 * response дуусахад connection-ийг цэвэрлээд pool руу буцаана.
 */
function runRequestInContext(req, res, next, auth) {
  let store;
  try {
    store = createContext(auth);
  } catch (err) {
    return next(err);
  }

  const finish = () => markEnded(store);
  res.once("finish", finish);
  res.once("close", finish);

  return contextStorage.run(store, () => next());
}

/**
 * Нэвтрэхээс өмнөх endpoint-уудад (login, refresh) зориулсан context.
 * RLS дээр 'system' role нь зөвхөн p_system_* policy-той хүснэгтүүдэд
 * (users, refresh_tokens, audit_log, мэдэгдлийн хүснэгтүүд) хандана.
 *
 * АНХААР: энэ context RLS-ийн хэрэглэгчийн шүүлтийг тойрно. Зөвхөн
 * хэрэглэгчийн input-оор context сонгогддоггүй route-д ашиглана.
 */
function systemContext(req, res, next) {
  return runRequestInContext(req, res, next, { role: "system" });
}

/**
 * HTTP хүсэлтгүй background ажил (email worker гэх мэт)-д зориулсан
 * system context. fn дууссаны дараа connection-ийг цэвэрлээд pool руу буцаана.
 */
function runInSystemContext(fn) {
  const store = createContext({ role: "system" });
  return contextStorage.run(store, async () => {
    try {
      return await fn();
    } finally {
      markEnded(store);
    }
  });
}

module.exports = {
  pool,
  query,
  withTransaction,
  runRequestInContext,
  systemContext,
  runInSystemContext,
  DbContextError,
};