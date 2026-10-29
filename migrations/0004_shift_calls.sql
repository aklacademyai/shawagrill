-- Shift calls ("Вызвать на смену") for the 3D location view.
-- A call is an interface mark with a timestamp: it records who was called to
-- a location and when. No message is sent to the employee. The row stays as
-- history; cancelling sets cancelled_at. employee_key is either
-- 'emp:<employee id>' for a real employee of the location or
-- 'demo:<location id>:<n>' for a demo-roster person (locations that have no
-- real staff yet show the demo roster in the 3D view).
CREATE TABLE IF NOT EXISTS shift_calls (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  employee_key TEXT NOT NULL,
  employee_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  called_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  called_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS shift_calls_location_idx ON shift_calls(location_id, cancelled_at, called_at);
