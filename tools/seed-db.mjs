#!/usr/bin/env node
// Builds a local SQLite DB by applying every migration in order.
// Used by tests and the local server; production uses the D1 API / wrangler.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const dbPath = path.resolve(argValue('--db', path.join(root, '.local/shawa-ceo.sqlite')));
const force = args.includes('--force');

if (fs.existsSync(dbPath) && !force) {
  console.log(`DB exists, leaving as is: ${dbPath}`);
  process.exit(0);
}
if (force && fs.existsSync(dbPath)) fs.rmSync(dbPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
for (const file of fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
  db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
}
db.close();
console.log(`Seeded local DB from migrations: ${dbPath}`);
