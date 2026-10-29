-- Inbound supplier invoices (email channel): every message that lands on
-- invoices@shawa.work (Email Worker) or POST /api/invoice-inbound (webhook)
-- becomes a DRAFT here first. Nothing is posted to stock automatically —
-- a manager reviews the parsed lines in the panel («Входящие инвойсы») and
-- confirms, which converts the draft into a normal purchase_documents row
-- (linked via document_id) through the same posting code as manual/scan.
CREATE TABLE IF NOT EXISTS invoice_drafts (
  id INTEGER PRIMARY KEY,
  sender TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  supplier TEXT NOT NULL DEFAULT '',
  doc_date TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  photo_jpeg TEXT,
  attachment_name TEXT NOT NULL DEFAULT '',
  attachment_kind TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL DEFAULT '',
  lines_json TEXT NOT NULL DEFAULT '[]',
  total_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  document_id INTEGER REFERENCES purchase_documents(id) ON DELETE SET NULL,
  resolved_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS invoice_drafts_status_idx ON invoice_drafts(status, id);
