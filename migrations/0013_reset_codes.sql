-- Self-service password reset codes (email / SMS). Only the PBKDF2 hash of
-- the 6-digit code is stored; codes live 10 minutes, max 5 attempts.
CREATE TABLE IF NOT EXISTS password_reset_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  contact TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
