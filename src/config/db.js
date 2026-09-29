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
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[db] Unexpected error on idle client", err);
});

const contextStorage = new AsyncLocalStorage();

const VALID_ROLES = new Set(["super_admin", "company", "department", "system"]);

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

async function acquireClient(store) {
  const client = await pool.connect();
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
 * RLS дээр 'system' role нь зөвхөн users, refresh_tokens, audit_log-д
 * хандах эрхтэй.
 */
function systemContext(req, res, next) {
  return runRequestInContext(req, res, next, { role: "system" });
}

module.exports = {
  pool,
  query,
  withTransaction,
  runRequestInContext,
  systemContext,
  DbContextError,
};
