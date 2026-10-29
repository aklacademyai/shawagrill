PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','opening','closed')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  pin_hash TEXT,
  password_hash TEXT,
  rank TEXT NOT NULL DEFAULT 'staff' CHECK (rank IN ('staff','manager','director','owner')),
  position TEXT,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  hourly_rate_cents INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_phone_unique ON employees(phone) WHERE phone <> '';
CREATE UNIQUE INDEX IF NOT EXISTS employees_email_unique ON employees(lower(email)) WHERE email <> '';

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rank TEXT NOT NULL CHECK (rank IN ('staff','manager','director','owner')),
  position TEXT,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  contact TEXT,
  used_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pending_registrations (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS punches (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  note_in TEXT NOT NULL DEFAULT '',
  note_out TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS punches_employee_time_idx ON punches(employee_id, clock_in);

CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'г',
  stock REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  cost_per_unit_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  stopped INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recipes (
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  PRIMARY KEY (menu_item_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS writeoffs (
  id INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stocktakes (
  id INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  expected_qty REAL NOT NULL,
  actual_qty REAL NOT NULL,
  diff REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'dinein' CHECK (kind IN ('dinein','takeaway','delivery')),
  table_no INTEGER,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','cooking','ready','served','cancelled')),
  total_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  served_at TEXT
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO settings(key, value) VALUES ('companyName', 'SHAWA GRILL & MANGAL');

INSERT OR IGNORE INTO locations(id, name, address, status, sort_order) VALUES
  (1, 'Sunny Isles', '17066 Collins Ave, Sunny Isles Beach, FL 33160', 'active', 1),
  (2, 'Miami Downtown', '2929 Biscayne Blvd, Miami, FL 33137', 'active', 2),
  (3, 'Fort Lauderdale', '2630 W Broward Blvd, Ste 105, Fort Lauderdale, FL 33312', 'active', 3),
  (4, 'Hallandale', '410 NE 1st Ave, Suite 8, Hallandale Beach, FL', 'opening', 4);

-- Menu seed: the real 26 items with prices from the SHAWA GRILL order app
-- (~/workspace/your_files/shawa-grill-site/, extracted 2026-10-22).
INSERT OR IGNORE INTO menu_items(code, name, name_en, category, price_cents, sort_order) VALUES
  ('ch-classic', 'Шаурма куриная классическая', 'Classic chicken shawarma', 'Шаурма', 1199, 1),
  ('beef-doner', 'Шаурма говяжья «Донер»', 'Beef shawarma "Doner"', 'Шаурма', 1499, 2),
  ('spicy-glaze', 'Шаурма острая SHAWA', 'Spicy SHAWA shawarma', 'Шаурма', 1299, 3),
  ('mix', 'Шаурма микс курица + говядина', 'Mix shawarma chicken + beef', 'Шаурма', 1399, 4),
  ('falafel', 'Шаурма фалафель', 'Falafel shawarma', 'Шаурма', 1099, 5),
  ('fries-shawarma', 'Картофель фри', 'French fries', 'Шаурма', 450, 6),
  ('bowl-ch', 'SHAWA-боул куриный', 'SHAWA chicken bowl', 'Тарелки и боулы', 1399, 7),
  ('plate-doner', 'Донер-тарелка', 'Doner plate', 'Тарелки и боулы', 1699, 8),
  ('plate-mix', 'Тарелка микс на двоих', 'Mix plate for two', 'Тарелки и боулы', 2499, 9),
  ('fries', 'Картофель фри', 'French fries', 'Закуски и гарниры', 499, 10),
  ('fries-garlic', 'Фри с чесночным соусом тум', 'Fries with toum garlic sauce', 'Закуски и гарниры', 599, 11),
  ('hummus', 'Хумус с питой', 'Hummus with pita', 'Закуски и гарниры', 699, 12),
  ('tabbouleh', 'Салат табуле', 'Tabbouleh salad', 'Закуски и гарниры', 599, 13),
  ('pickles', 'Соленья ассорти', 'Assorted pickles', 'Закуски и гарниры', 299, 14),
  ('sauce-toum', 'Соус тум (чесночный)', 'Toum sauce (garlic)', 'Соусы', 99, 15),
  ('sauce-white', 'Белый соус фирменный', 'Signature white sauce', 'Соусы', 99, 16),
  ('sauce-hot', 'Острый соус', 'Hot sauce', 'Соусы', 99, 17),
  ('sauce-glaze', 'Красная глазурь SHAWA', 'SHAWA red glaze', 'Соусы', 149, 18),
  ('sauce-narsharab', 'Гранатовый наршараб', 'Pomegranate narsharab', 'Соусы', 149, 19),
  ('lemonade', 'Домашний лимонад', 'House lemonade', 'Напитки', 399, 20),
  ('ayran', 'Айран', 'Ayran', 'Напитки', 349, 21),
  ('tea', 'Чай горячий / холодный', 'Tea, hot / iced', 'Напитки', 299, 22),
  ('soda', 'Coca-Cola / Sprite / Fanta', 'Coca-Cola / Sprite / Fanta', 'Напитки', 249, 23),
  ('water', 'Вода', 'Water', 'Напитки', 199, 24),
  ('baklava', 'Пахлава', 'Baklava', 'Десерты', 499, 25),
  ('kunafa', 'Кунафа', 'Kunafa', 'Десерты', 699, 26);
