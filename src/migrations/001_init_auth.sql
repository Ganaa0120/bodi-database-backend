-- ============================================================
-- Migration 001: Auth суурь table-ууд
-- Зорилго: super_admin/company/department login хийх боломжтой
-- болгох. companies, departments нь энэ шатанд зөвхөн FK
-- бүрэн бүтэн байдлыг хангах stub — дараагийн migration-д
-- бүрэн талбаруудаар (form_schema гэх мэт) өргөтгөнө.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- companies (stub) ----------
CREATE TABLE IF NOT EXISTS companies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- departments (stub) ----------
-- Дараагийн шатанд department_templates (super_admin-ийн үүсгэсэн
-- загвар: HR, Finance, IT...) болон энэ departments (company доtorx
-- бодит instance) хоёрыг холбож, form_schema нэмнэ.
CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  TEXT NOT NULL,
  password_hash          TEXT NOT NULL,
  full_name              TEXT NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('super_admin', 'company', 'department')),
  company_id             UUID REFERENCES companies(id) ON DELETE SET NULL,
  department_id          UUID REFERENCES departments(id) ON DELETE SET NULL,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  failed_login_attempts  INT NOT NULL DEFAULT 0,
  locked_until           TIMESTAMPTZ,
  last_login_at          TIMESTAMPTZ,
  last_login_ip          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- role-той нийцэж байгаа эсэхийг DB түвшинд баталгаажуулах:
  -- super_admin ямар ч company/department-тэй холбогдохгүй,
  -- company role заавал company_id-тэй, department заавал хоёуланг нь шаардана.
  CONSTRAINT users_role_scope_chk CHECK (
    (role = 'super_admin' AND company_id IS NULL AND department_id IS NULL)
    OR (role = 'company' AND company_id IS NOT NULL AND department_id IS NULL)
    OR (role = 'department' AND company_id IS NOT NULL AND department_id IS NOT NULL)
  )
);

-- Имэйлийг üсгийн том/жижигээс үл хамааран unique байлгах
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_company_id_idx ON users (company_id);
CREATE INDEX IF NOT EXISTS users_department_id_idx ON users (department_id);

-- ---------- refresh_tokens ----------
-- Refresh token-ийг plaintext-ээр биш, hash (sha256) хэлбэрээр хадгална.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  user_agent   TEXT,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- ---------- audit_log ----------
-- Immutable audit trail: application-ийн DB user-д UPDATE/DELETE
-- эрх өгөхгүй (доор тайлбарласан, production дээр tохируулна).
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,        -- LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT, TOKEN_REFRESH, ACCOUNT_LOCKED
  ip_address    TEXT,
  user_agent    TEXT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_user_id_idx ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at);

-- ============================================================
-- PRODUCTION-Д ЗААВАЛ ХИЙХ ЗҮЙЛ (Azure дээр deploy хийхийн өмнө):
-- Application-ийн холбогдож буй DB user-ээс audit_log дээрх
-- UPDATE/DELETE эрхийг бүрмөсөн авах:
--
--   REVOKE UPDATE, DELETE ON audit_log FROM <app_db_user>;
--
-- Ингэснээр application code compromise болсон ч audit trail-ийг
-- устгах/өөрчлөх боломжгүй болно. Энэ migration дотор оруулаагүй
-- шалтгаан: <app_db_user> нэр орчин бүрт өөр байдаг тул deploy
-- хийх үедээ гараар (эсвэл deploy script-д) ажиллуулна.
-- ============================================================
