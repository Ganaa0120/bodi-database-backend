ALTER TABLE department_templates
  ADD COLUMN IF NOT EXISTS form_schema JSONB NOT NULL DEFAULT '[]'::jsonb;

INSERT INTO _migrations (filename) VALUES ('005_department_template_form_schema.sql')
ON CONFLICT (filename) DO NOTHING;