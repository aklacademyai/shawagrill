import { DatabaseSync } from 'node:sqlite';

function normalize(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

class LocalStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) { this.params = params.map(normalize); return this; }
  async run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    const last = this.db.prepare('SELECT last_insert_rowid() AS id').get();
    return { success: true, meta: { last_row_id: Number(last?.id || 0), changes: Number(info?.changes || 0) } };
  }
  async all() {
    const stmt = this.db.prepare(this.sql);
    return { results: stmt.all(...this.params), success: true };
  }
  async first() {
    const stmt = this.db.prepare(this.sql);
    return stmt.get(...this.params) || null;
  }
}

export class LocalD1 {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  }
  prepare(sql) { return new LocalStatement(this.db, sql); }
  async exec(sql) { this.db.exec(sql); return { success: true }; }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}
