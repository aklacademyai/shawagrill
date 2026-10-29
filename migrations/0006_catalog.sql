-- Master catalog for the public website (mymangal.com sync):
--  * menu_items gain the website master-card fields: EN description, photo
--    (external URL or one uploaded JPEG stored like invoice photos), tags,
--    nutrition (kcal / protein), the "published to website" flag and a
--    catalog edit timestamp;
--  * Clover item ids become PER-LOCATION bindings (menu_item_clover_bindings)
--    because each of the 3 merchants has its own catalog. The legacy global
--    menu_items.clover_item_id stays as a fallback and is NOT touched.
--  * Prices are deliberately NOT part of this migration: the panel never
--    edits website prices — Clover is the only price source.
--  * settings gain catalogVersion / catalogPublishedAt (written by
--    POST /api/catalog/publish).

ALTER TABLE menu_items ADD COLUMN description_en TEXT NOT NULL DEFAULT '';
ALTER TABLE menu_items ADD COLUMN photo_url TEXT NOT NULL DEFAULT '';
ALTER TABLE menu_items ADD COLUMN photo_jpeg TEXT;
ALTER TABLE menu_items ADD COLUMN tags TEXT NOT NULL DEFAULT '';
ALTER TABLE menu_items ADD COLUMN calories INTEGER;
ALTER TABLE menu_items ADD COLUMN protein_g REAL;
ALTER TABLE menu_items ADD COLUMN catalog_published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE menu_items ADD COLUMN catalog_updated_at TEXT;

CREATE TABLE IF NOT EXISTS menu_item_clover_bindings (
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  clover_item_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (menu_item_id, location_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS menu_item_clover_bindings_loc_item_idx
  ON menu_item_clover_bindings(location_id, clover_item_id);

-- Prefill: the 37 real Mangal dishes (mg-*, not the mgc-* name aliases)
-- become the initial published website catalog. Content (descriptions,
-- photos) and per-location Clover bindings are filled by the stage-0
-- prefill script from the live site/Clover data — gaps stay empty by
-- design and are listed in the reconciliation report.
UPDATE menu_items SET catalog_published = 1 WHERE code LIKE 'mg-%';
