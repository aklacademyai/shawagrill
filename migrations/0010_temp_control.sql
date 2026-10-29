-- Temperature control (SANEKS feature): equipment per location with
-- Fahrenheit norms, and readings entered from the panel, the bot or the
-- API. created_at uses the SQLite DEFAULT CURRENT_TIMESTAMP (UTC) on
-- purpose — inserts must NOT set it explicitly, in the panel or the bot,
-- so both writers share one clock format.
CREATE TABLE IF NOT EXISTS temp_equipment (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('fridge','freezer','walkin','storage')),
  norm_min_f REAL,
  norm_max_f REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS temp_equipment_location_active_idx ON temp_equipment(location_id, active);

CREATE TABLE IF NOT EXISTS temp_readings (
  id INTEGER PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES temp_equipment(id) ON DELETE CASCADE,
  value_f REAL NOT NULL,
  humidity_pct REAL,
  source TEXT NOT NULL DEFAULT 'panel' CHECK (source IN ('panel','bot','api')),
  entered_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS temp_readings_equipment_created_idx ON temp_readings(equipment_id, created_at);
