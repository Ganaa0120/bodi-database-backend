-- ============================================================
-- Migration 002: companies table-д phone, logo_url нэмэх
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS logo_url TEXT;