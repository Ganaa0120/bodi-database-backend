-- ============================================================
-- Migration 004: Department templates, departments-template
-- холбоос, form_submissions (илгээх/зөвшөөрөх урсгал)
-- ============================================================

CREATE TABLE IF NOT EXISTS department_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS department_templates_name_lower_idx
  ON department_templates (lower(name)) WHERE deleted_at IS NULL;

ALTER TABLE departments ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES department_templates(id);

CREATE TABLE IF NOT EXISTS form_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id     UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  submitted_by      UUID NOT NULL REFERENCES users(id),
  title             TEXT NOT NULL,
  data              JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  rejection_reason  TEXT,
  reviewed_by       UUID REFERENCES users(id),
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS form_submissions_company_id_idx ON form_submissions (company_id);
CREATE INDEX IF NOT EXISTS form_submissions_department_id_idx ON form_submissions (department_id);
CREATE INDEX IF NOT EXISTS form_submissions_status_idx ON form_submissions (status);

INSERT INTO _migrations (filename) VALUES ('004_departments_and_forms.sql')
ON CONFLICT (filename) DO NOTHING;