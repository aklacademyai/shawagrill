-- Video training: lessons gain a video link, quiz questions and per-employee results.
ALTER TABLE lessons ADD COLUMN video_url TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS lesson_questions (
  id INTEGER PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  correct_index INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lesson_questions_lesson_idx ON lesson_questions(lesson_id, sort_order, id);

CREATE TABLE IF NOT EXISTS lesson_results (
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  watched_at TEXT,
  score INTEGER,
  total INTEGER,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (lesson_id, employee_id)
);
