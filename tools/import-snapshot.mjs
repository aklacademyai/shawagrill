#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const snapshotPath = path.resolve(args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--db' && args[args.indexOf(a) - 1] !== '--sql-out') || path.join(root, '../goals/shawa-ceo/hidden_files/myteam-backup-2026-10-22-1251utc.json'));
const dbPath = path.resolve(argValue('--db', path.join(root, '.local/myteam.sqlite')));
const sqlOut = argValue('--sql-out', '');
const force = args.includes('--force');

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const data = snapshot.data || snapshot;

function splitName(employee) {
  if (employee.firstName || employee.first_name) return [employee.firstName || employee.first_name, employee.lastName || employee.last_name || ''];
  const parts = String(employee.name || '').trim().split(/\s+/).filter(Boolean);
  return [parts[0] || '', parts.slice(1).join(' ')];
}
function cents(value) { return value == null || value === '' ? null : Math.round(Number(value) * 100); }
function bool(value, fallback = 1) { return value === undefined ? fallback : value ? 1 : 0; }

const records = [];
function add(table, row) { records.push({ table, row }); }
function addRows(table, rows, map) { for (const row of rows || []) add(table, map(row)); }

add('settings', { key: 'companyName', value: data.companyName || '' });
add('settings', { key: 'weeklyBonusPoints', value: String(data.weeklyBonusPoints ?? 10) });

addRows('locations', data.locations, l => ({ id: l.id, name: l.name, address: l.address || '', sort_order: l.sort ?? l.sort_order ?? 0, active: 1 }));
addRows('employees', data.employees, e => {
  const [firstName, lastName] = splitName(e);
  return {
    id: e.id, first_name: firstName, last_name: lastName, phone: e.phone || '', email: e.email || '',
    pin_hash: e.pinHash || e.pin_hash || null, rank: e.rank || 'staff', position: e.role || e.position || null,
    location_id: e.locationId ?? e.location_id ?? null, hourly_rate_cents: cents(e.hourlyRate ?? e.hourly_rate),
    active: bool(e.active, 1), created_at: e.createdAt || e.created_at || '2026-10-22T12:51:00.000Z'
  };
});

const standardChannels = [
  { name: 'Вся команда', min_rank: 1 }, { name: 'Старшие смены', min_rank: 2 }, { name: 'Управляющие', min_rank: 3 },
  { name: 'Руководство', min_rank: 4 }, { name: 'Владелец', min_rank: 5 }
];
const snapshotChannelNames = new Set((data.channels || []).map(c => c.name));
addRows('chat_channels', data.channels, c => ({ id: c.id, name: c.name, location_id: c.locationId ?? c.location_id ?? null, min_rank: c.minRank ?? c.min_rank ?? 1 }));
for (const channel of standardChannels) {
  if (!snapshotChannelNames.has(channel.name)) add('chat_channels', { name: channel.name, location_id: null, min_rank: channel.min_rank });
}
addRows('chat_messages', data.messages, m => ({ id: m.id, channel_id: m.channelId ?? m.channel_id, employee_id: m.employeeId ?? m.employee_id, body: m.body, created_at: m.createdAt || m.created_at }));
addRows('invites', data.invites, i => ({ code: i.code, created_by: i.createdBy ?? i.created_by, rank: i.rank, position: i.position || null,
  location_id: i.locationId ?? i.location_id ?? null, used_by: i.usedBy ?? i.used_by ?? null, created_at: i.createdAt || i.created_at,
  used_at: i.usedAt || i.used_at || null, expires_at: i.expiresAt || i.expires_at || null, revoked_at: i.revokedAt || i.revoked_at || null }));

const seriesIds = [...new Set((data.shifts || []).map(s => s.seriesId ?? s.series_id).filter(Boolean))];
for (const id of seriesIds) add('shift_series', { id, created_by: (data.shifts.find(s => (s.seriesId ?? s.series_id) === id)?.createdBy || data.employees?.[0]?.id || 1), active: 1 });
addRows('shifts', data.shifts, s => ({ id: s.id, employee_id: s.employeeId ?? s.employee_id ?? null, location_id: s.locationId ?? s.location_id ?? null,
  starts_at: s.startsAt || s.starts_at, ends_at: s.endsAt || s.ends_at, series_id: s.seriesId ?? s.series_id ?? null,
  occurrence: s.occurrence ?? null, is_open: bool(s.isOpen ?? s.is_open, s.employeeId ? 0 : 1), swap_status: s.swapStatus || s.swap_status || 'none',
  note: s.note || '', created_by: s.createdBy || s.created_by || null }));
addRows('punches', data.punches, p => ({ id: p.id, employee_id: p.employeeId ?? p.employee_id, location_id: p.locationId ?? p.location_id ?? null,
  clock_in: p.clockIn || p.clock_in, clock_out: p.clockOut || p.clock_out || null, note_in: p.noteIn || p.note_in || '', note_out: p.noteOut || p.note_out || '' }));
addRows('notifications', data.notifications, n => ({ id: n.id, employee_id: n.employeeId ?? n.employee_id, type: n.type, title: n.title,
  body: n.body || '', related_shift_id: n.shiftId ?? n.related_shift_id ?? null, due_at: n.dueAt || n.due_at, read_at: n.readAt || n.read_at || null }));
addRows('tasks', data.tasks, t => ({ id: t.id, title: t.title, description: t.description || '', assignee_id: t.assigneeId ?? t.assignee_id ?? null,
  location_id: t.locationId ?? t.location_id ?? null, due_at: t.dueAt || t.due_at || null, status: t.status || 'open',
  checklist: JSON.stringify(t.checklist || []), created_by: t.createdBy || t.created_by || null, completed_at: t.completedAt || t.completed_at || null }));
addRows('announcements', data.announcements, a => ({ id: a.id, title: a.title, body: a.body || '', created_by: a.createdBy || a.created_by || null, created_at: a.createdAt || a.created_at }));
addRows('checklist_templates', data.templates, t => ({ id: t.id, name: t.name, items: JSON.stringify(t.items || []), location_id: t.locationId ?? t.location_id ?? null, created_by: t.createdBy || t.created_by || null }));
addRows('checklist_runs', data.runs, r => ({ id: r.id, template_id: r.templateId ?? r.template_id, employee_id: r.employeeId ?? r.employee_id,
  location_id: r.locationId ?? r.location_id ?? null, items: JSON.stringify(r.items || []), note: r.note || '', created_at: r.createdAt || r.created_at }));
addRows('courses', data.courses, c => ({ id: c.id, title: c.title, description: c.description || '', created_by: c.createdBy || c.created_by || null }));
for (const course of data.courses || []) {
  for (const lesson of course.lessons || []) add('lessons', { id: lesson.id, course_id: course.id, title: lesson.title, content: lesson.content || '', sort_order: lesson.sort ?? lesson.sort_order ?? 0 });
}
addRows('lessons', data.lessons, l => ({ id: l.id, course_id: l.courseId ?? l.course_id, title: l.title, content: l.content || '', sort_order: l.sort ?? l.sort_order ?? 0 }));
addRows('documents', data.documents, d => ({ id: d.id, title: d.title, body: d.body || '', url: d.url || '', created_by: d.createdBy || d.created_by || null }));
addRows('kb_articles', data.kb, a => ({ id: a.id, title: a.title, body: a.body || '', created_by: a.createdBy || a.created_by || null }));
addRows('timeoff_requests', data.timeoff, t => ({ id: t.id, employee_id: t.employeeId ?? t.employee_id, type: t.type || 'timeoff',
  starts_on: t.startsOn || t.starts_on, ends_on: t.endsOn || t.ends_on, reason: t.reason || '', status: t.status || 'pending', decided_by: t.decidedBy || t.decided_by || null }));
addRows('violations', data.violations, v => ({ id: v.id, employee_id: v.employeeId ?? v.employee_id, occurred_on: v.occurredOn || v.occurred_on, reason: v.reason, created_by: v.createdBy || v.created_by || null }));
addRows('point_events', data.pointEvents, p => ({ id: p.id, employee_id: p.employeeId ?? p.employee_id, points: p.points, reason: p.reason,
  type: p.type || 'manual', actor_id: p.actorId ?? p.actor_id ?? null, week_key: p.weekKey || p.week_key || null, created_at: p.createdAt || p.created_at }));
for (const poll of data.polls || []) {
  add('polls', { id: poll.id, question: poll.question, created_by: poll.createdBy || poll.created_by || null, closed: bool(poll.closed, 0) });
  for (const option of poll.options || []) {
    if (typeof option === 'string') add('poll_options', { poll_id: poll.id, text: option });
    else add('poll_options', { id: option.id, poll_id: poll.id, text: option.text });
  }
}
if (data.publishedRatings) {
  const p = data.publishedRatings;
  add('rating_snapshots', { week_key: p.weekKey, week_start: p.weekStart, week_end: p.weekEnd, payload: JSON.stringify(p), published_at: p.publishedAt || '2026-10-22T12:51:00.000Z' });
}

function sqlValue(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}
function insertSql(record) {
  const columns = Object.keys(record.row);
  return `INSERT OR REPLACE INTO ${record.table} (${columns.join(', ')}) VALUES (${columns.map(c => sqlValue(record.row[c])).join(', ')});`;
}

if (sqlOut) {
  const lines = ['-- Generated by tools/import-snapshot.mjs. Run migrations first.', 'PRAGMA foreign_keys = ON;', 'BEGIN TRANSACTION;', ...records.map(insertSql), 'COMMIT;'];
  fs.mkdirSync(path.dirname(path.resolve(sqlOut)), { recursive: true });
  fs.writeFileSync(path.resolve(sqlOut), `${lines.join('\n')}\n`);
  console.log(`Wrote ${records.length} records to ${path.resolve(sqlOut)}`);
  process.exit(0);
}

if (fs.existsSync(dbPath) && !force) {
  const existing = new DatabaseSync(dbPath, { open: true });
  let count = 0;
  try { count = existing.prepare('SELECT COUNT(*) AS c FROM employees').get()?.c || 0; } catch { count = 0; }
  existing.close();
  if (count > 0) throw new Error(`Local DB already contains employees: ${dbPath}. Use --force to recreate it.`);
}
if (force && fs.existsSync(dbPath)) fs.rmSync(dbPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
for (const file of fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
  db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
}
db.exec('BEGIN');
try {
  for (const record of records) {
    const columns = Object.keys(record.row);
    const stmt = db.prepare(`INSERT OR REPLACE INTO ${record.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    stmt.run(...columns.map(c => record.row[c] === undefined ? null : record.row[c]));
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
const counts = records.reduce((acc, r) => { acc[r.table] = (acc[r.table] || 0) + 1; return acc; }, {});
console.log(`Imported snapshot into ${dbPath}`);
console.log(JSON.stringify(counts, null, 2));
