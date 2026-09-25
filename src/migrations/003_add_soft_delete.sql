-- ============================================================
-- Migration 003: Soft delete — companies, departments, users
-- Зорилго: компани устгахад department/user өгөгдөл дагаж бодитоор
-- устахаас сэргийлэх. audit_log эхнээсээ immutable тул өөрчлөгдөхгүй;
-- refresh_tokens аль хэдийн revoked_at-аар адил зарчимтай.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- users-ийн имэйл unique index-г зөвхөн устгаагүй мөрүүдийн дунд unique
-- болгож өөрчилнө — устгасан хэрэглэгчийн имэйлийг дахин ашиглах боломжтой.
DROP INDEX IF EXISTS users_email_lower_idx;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON users (lower(email))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS companies_deleted_at_idx ON companies (deleted_at);
CREATE INDEX IF NOT EXISTS departments_deleted_at_idx ON departments (deleted_at);
CREATE INDEX IF NOT EXISTS users_deleted_at_idx ON users (deleted_at);