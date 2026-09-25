ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edit_unlocked BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS submission_edit_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  UUID NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  requested_by   UUID NOT NULL REFERENCES users(id),
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  reviewed_by    UUID REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submission_edit_requests_submission_id_idx ON submission_edit_requests (submission_id);
CREATE INDEX IF NOT EXISTS submission_edit_requests_status_idx ON submission_edit_requests (status);

INSERT INTO _migrations (filename) VALUES ('006_submission_lock_and_edit_requests.sql')
ON CONFLICT (filename) DO NOTHING;