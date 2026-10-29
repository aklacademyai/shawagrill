-- Lesson assignments: a lesson can be assigned to a location or to a specific
-- employee, with an optional due date (YYYY-MM-DD). A lesson that has at least
-- one assignment is targeted: staff see it only when it is assigned to them
-- (directly or through their location). Lessons without assignments stay
-- visible to everyone, as before.
CREATE TABLE IF NOT EXISTS lesson_assignments (
  id INTEGER PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  due_date TEXT,
  assigned_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (location_id IS NOT NULL OR employee_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS lesson_assignments_lesson_idx ON lesson_assignments(lesson_id);
CREATE INDEX IF NOT EXISTS lesson_assignments_location_idx ON lesson_assignments(location_id);
CREATE INDEX IF NOT EXISTS lesson_assignments_employee_idx ON lesson_assignments(employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS lesson_assignments_loc_unique ON lesson_assignments(lesson_id, location_id) WHERE location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lesson_assignments_emp_unique ON lesson_assignments(lesson_id, employee_id) WHERE employee_id IS NOT NULL;
