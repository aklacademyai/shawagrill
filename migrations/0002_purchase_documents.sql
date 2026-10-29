-- Purchases become documents: a header (supplier, date, note, invoice photo)
-- plus any number of lines. Backward compatibility:
--  * the legacy `purchases` table stays as the line ledger (gains document_id)
--    and keeps receiving one row per posted line, so stock reports and the
--    dashboard built on it do not change;
--  * every pre-existing purchase is backfilled into a single-line document.
CREATE TABLE IF NOT EXISTS purchase_documents (
  id INTEGER PRIMARY KEY,
  supplier TEXT NOT NULL DEFAULT '',
  doc_date TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  photo_jpeg TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','scan')),
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES purchase_documents(id) ON DELETE CASCADE,
  ingredient_id INTEGER REFERENCES ingredients(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS purchase_lines_document_idx ON purchase_lines(document_id);

ALTER TABLE purchases ADD COLUMN document_id INTEGER REFERENCES purchase_documents(id) ON DELETE SET NULL;

-- Backfill: one document per legacy purchase, in purchase id order. The new
-- table starts empty, so its ids are 1..N in insertion order and the k-th
-- purchase (by id) maps to document k.
INSERT INTO purchase_documents(supplier, doc_date, note, total_cents, source, created_by, created_at)
SELECT '', substr(p.created_at, 1, 10), p.note, p.total_cost_cents, 'manual', p.created_by, p.created_at
FROM purchases p
ORDER BY p.id;

INSERT INTO purchase_lines(document_id, ingredient_id, name, unit, qty, total_cost_cents, note)
SELECT (SELECT COUNT(*) FROM purchases p2 WHERE p2.id <= p.id),
       p.ingredient_id, i.name, i.unit, p.qty, p.total_cost_cents, p.note
FROM purchases p
JOIN ingredients i ON i.id = p.ingredient_id;

UPDATE purchases
SET document_id = (SELECT COUNT(*) FROM purchases p2 WHERE p2.id <= purchases.id)
WHERE document_id IS NULL;
