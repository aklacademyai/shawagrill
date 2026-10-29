-- Finance module (PnL / DR-15 / suppliers):
--  * orders gain the sales tax actually collected, captured from the Clover
--    payload at sync time (payments.taxAmount, else line taxRates). NULL
--    means "unknown" (app orders and pre-migration imports) — the finance
--    endpoints surface the coverage honestly instead of inventing a number.
--  * suppliers become first-class cards: purchase documents link to a
--    supplier, payments are recorded against the supplier (manual marks —
--    the panel never moves money), and the balance is documents − payments.
--  * expense_entries: operating expenses below food cost, entered manually
--    per location (location_id NULL = network-wide / unallocated).

ALTER TABLE orders ADD COLUMN tax_cents INTEGER;

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_unique ON suppliers(lower(name));

CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  paid_date TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS supplier_payments_supplier_idx ON supplier_payments(supplier_id, paid_date);

ALTER TABLE purchase_documents ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS expense_entries (
  id INTEGER PRIMARY KEY,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('rent','utilities','aggregator','processing','marketing','repairs','supplies','other')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  expense_date TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS expense_entries_date_idx ON expense_entries(expense_date);

-- Backfill: one supplier card per distinct document supplier name
-- (case-insensitive) and link the documents to their card. The free-text
-- `supplier` column stays as the historical snapshot on each document.
INSERT OR IGNORE INTO suppliers(name)
SELECT TRIM(supplier) FROM purchase_documents
WHERE TRIM(supplier) <> ''
GROUP BY lower(TRIM(supplier));

UPDATE purchase_documents
SET supplier_id = (SELECT s.id FROM suppliers s WHERE lower(s.name) = lower(TRIM(purchase_documents.supplier)))
WHERE supplier_id IS NULL AND TRIM(supplier) <> '';
