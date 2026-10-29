-- Email-code verification (2026-10-22): when mail sending is configured
-- (RESEND_API_KEY), an email registration starts here — payload + hashed
-- 6-digit code, 10-minute expiry, attempt counter — and completes only
-- after the code is verified.
CREATE TABLE IF NOT EXISTS pending_registrations (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
