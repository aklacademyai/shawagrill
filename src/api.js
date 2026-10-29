import { TIME_ZONE, nyDateKey, nyParts, startOfNyDay, addUtcDays, weekStartNy, zonedTimeToUtc } from './time.js';
import { storeInboundInvoice, normalizeWebhookPayload } from './invoice-inbound.js';

export const RANK_LEVEL = { staff: 1, manager: 2, director: 3, owner: 4 };
export const RANK_LABEL = {
  staff: 'Сотрудник',
  manager: 'Управляющий',
  director: 'Директор',
  owner: 'Владелец'
};
export const STANDARD_ROLES = ['Директор', 'Менеджер', 'Шеф-повар', 'Повар', 'Официант', 'Кассир'];

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const fail = (status, message) => json({ ok: false, error: message }, status);

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function all(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...params).all();
  return result.results || [];
}
async function one(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).first();
}
async function run(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

async function getSetting(env, key, fallback = '') {
  const row = await one(env, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
async function setSetting(env, key, value) {
  await run(env, 'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

/* ---------------- Ops alerts (failed-order notifications) ----------------
   One inbox for "an order did not go through" style alerts. External
   systems (mangal-ops / mangal-web) POST to /api/ops/alert with a shared
   secret; the panel's own Clover sync records its failures here too.
   @ShawaTeambot polls status='pending' rows, publishes them into the
   central group's location threads and stamps sent_at — the panel itself
   never talks to Telegram. */
export const OPS_LOCATION_KEYS = ['sunny_isles', 'miami_downtown', 'fort_lauderdale', 'hallandale', 'network'];
const OPS_LOCATION_KEY_BY_ID = { 1: 'sunny_isles', 2: 'miami_downtown', 3: 'fort_lauderdale', 4: 'hallandale' };

function locationKeyFor(location) {
  if (!location) return 'network';
  if (OPS_LOCATION_KEY_BY_ID[location.id]) return OPS_LOCATION_KEY_BY_ID[location.id];
  const name = String(location.name || '').toLowerCase();
  if (name.includes('sunny')) return 'sunny_isles';
  if (name.includes('downtown') || name.includes('edgewater') || name.includes('miami')) return 'miami_downtown';
  if (name.includes('lauderdale')) return 'fort_lauderdale';
  if (name.includes('hallandale')) return 'hallandale';
  return 'network';
}

// The shared secret for POST /api/ops/alert: the Worker env wins, then the
// settings row; when neither exists a durable random value is generated
// and stored — so the channel works with zero manual setup. The value is
// only ever compared by hash; it is never returned by any endpoint.
async function opsAlertSecret(env) {
  const fromEnv = String(env.OPS_ALERT_SECRET || '');
  if (fromEnv) return fromEnv;
  let secret = await getSetting(env, 'opsAlertSecret');
  if (!secret) {
    secret = `${crypto.randomUUID()}.${bytesToHex(crypto.getRandomValues(new Uint8Array(24)))}`;
    await setSetting(env, 'opsAlertSecret', secret);
  }
  return secret;
}

// Internal alert writer (Clover sync failures). Deduped: at most one row
// per (location_key, kind, text) per hour — the sync ticks every 15 min
// and a dead token must not flood the owner's bot; a different failure
// (different text, e.g. another HTTP status) still gets through. Never
// throws: alerting must not break the sync run it reports on.
async function recordOpsAlert(env, { locationKey = 'network', kind, text, source }) {
  try {
    const sinceIso = new Date(Date.now() - 3600000).toISOString();
    const recent = await one(env,
      'SELECT id FROM ops_alerts WHERE location_key = ? AND kind = ? AND text = ? AND created_at >= ? ORDER BY id DESC LIMIT 1',
      locationKey, kind, text, sinceIso);
    if (recent) return { id: recent.id, deduped: true };
    const result = await run(env,
      'INSERT INTO ops_alerts(location_key, kind, text, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      locationKey, kind, text, source, 'pending', nowIso());
    return { id: result.meta?.last_row_id, deduped: false };
  } catch { return { id: null, deduped: false }; }
}

// One sync failure -> one ops alert: point, stage, HTTP status (when the
// failure carries one) and the panel's plain-language error message.
async function recordSyncErrorAlert(env, location, error) {
  const statusPart = error?.status ? ` · HTTP ${error.status}` : '';
  const text = `${location.name} · Clover orders sync failed${statusPart} · ${error?.message || 'unknown error'}`;
  return recordOpsAlert(env, {
    locationKey: locationKeyFor(location),
    kind: 'sync_error',
    text: text.slice(0, 2000),
    source: 'shawa-ceo-sync'
  });
}

/* ---------------- Temperature control (SANEKS) ----------------
   Equipment per location with Fahrenheit norms; readings come from the
   panel (source='panel'), @ShawaTeambot ('bot') or integrations ('api').
   Inserts into temp_readings / temp_equipment must NOT set created_at —
   the column DEFAULT CURRENT_TIMESTAMP (SQLite UTC) is the shared clock
   for the panel and the bot. Deviation / critical rules and the alert
   contract (kind, source, text) are fixed — the bot relies on them. */
const TEMP_TYPES = ['fridge', 'freezer', 'walkin', 'storage'];
const TEMP_STALE_MS = 6 * 3600000;

function parseTempDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const iso = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
function fmtTempNum(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? '');
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100);
}
function tempIsDeviation(equipment, value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return false;
  if (equipment.norm_min_f != null && num < Number(equipment.norm_min_f)) return true;
  if (equipment.norm_max_f != null && num > Number(equipment.norm_max_f)) return true;
  return false;
}
function tempIsCritical(equipment, value) {
  if (!tempIsDeviation(equipment, value)) return false;
  const num = Number(value);
  if ((equipment.type === 'fridge' || equipment.type === 'walkin') && num > 45) return true;
  if (equipment.type === 'freezer' && num > 10) return true;
  return false;
}
function tempNormText(equipment) {
  const hasMin = equipment.norm_min_f != null;
  const hasMax = equipment.norm_max_f != null;
  if (hasMin && hasMax) return `${fmtTempNum(equipment.norm_min_f)}–${fmtTempNum(equipment.norm_max_f)}°F`;
  if (!hasMin && hasMax) return `≤${fmtTempNum(equipment.norm_max_f)}°F`;
  if (hasMin && !hasMax) return `≥${fmtTempNum(equipment.norm_min_f)}°F`;
  return '';
}
function tempDeviationText(location, equipment, value) {
  return `🌡 ${location.name} · ${equipment.name} · ${fmtTempNum(value)}°F — outside the norm (${tempNormText(equipment)})`;
}
function tempEquipmentView(row) {
  if (!row) return null;
  return {
    id: row.id,
    location_id: row.location_id, locationId: row.location_id,
    name: row.name, type: row.type,
    norm_min_f: row.norm_min_f, norm_max_f: row.norm_max_f,
    normMinF: row.norm_min_f, normMaxF: row.norm_max_f,
    active: Boolean(row.active),
    created_at: row.created_at, createdAt: row.created_at
  };
}
function tempReadingView(row) {
  if (!row) return null;
  return {
    id: row.id,
    equipment_id: row.equipment_id, equipmentId: row.equipment_id,
    value_f: row.value_f, valueF: row.value_f,
    humidity_pct: row.humidity_pct, humidityPct: row.humidity_pct,
    source: row.source, entered_by: row.entered_by, enteredBy: row.entered_by,
    created_at: row.created_at, createdAt: row.created_at
  };
}
function tempStatusFor(equipment, lastReading, now = new Date()) {
  if (!lastReading) return 'none';
  const at = parseTempDate(lastReading.created_at);
  if (!at || now.getTime() - at.getTime() > TEMP_STALE_MS) return 'stale';
  if (tempIsDeviation(equipment, lastReading.value_f)) return 'deviation';
  return 'ok';
}
async function lastTempReading(env, equipmentId) {
  return one(env, 'SELECT * FROM temp_readings WHERE equipment_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', Number(equipmentId));
}
async function buildTemperatures(env) {
  const locationRows = await all(env, 'SELECT * FROM locations ORDER BY sort_order, id');
  const equipmentRows = await all(env, 'SELECT * FROM temp_equipment ORDER BY location_id, name, id');
  const now = new Date();
  const byLocation = new Map(locationRows.map(loc => [loc.id, { location: locationView(loc), location_id: loc.id, locationId: loc.id, name: loc.name, equipment: [] }]));
  const flat = [];
  for (const row of equipmentRows) {
    const last = await lastTempReading(env, row.id);
    const status = tempStatusFor(row, last, now);
    const lastView = last ? tempReadingView(last) : null;
    const entry = {
      ...tempEquipmentView(row),
      status,
      lastReading: lastView, last_reading: lastView, last: lastView,
      // Flat aliases of the last reading for simple consumers.
      last_value_f: last ? last.value_f : null,
      last_humidity_pct: last ? last.humidity_pct : null,
      last_created_at: last ? last.created_at : null,
      last_entered_by: last ? last.entered_by : null,
      last_source: last ? last.source : null
    };
    flat.push(entry);
    if (!byLocation.has(row.location_id)) {
      byLocation.set(row.location_id, { location: { id: row.location_id, name: '' }, location_id: row.location_id, locationId: row.location_id, name: '', equipment: [] });
    }
    byLocation.get(row.location_id).equipment.push(entry);
  }
  return { ok: true, locations: [...byLocation.values()], equipment: flat };
}
async function checkMissingTemperatures(env) {
  try {
    const parts = nyParts(new Date());
    if (!(parts.hour >= 8 && parts.hour < 23)) return { checked: 0, alerted: 0 };
    const rows = await all(env, `SELECT e.*, l.name AS location_name FROM temp_equipment e
      JOIN locations l ON l.id = e.location_id WHERE e.active = 1 ORDER BY e.location_id, e.id`);
    const now = new Date();
    let alerted = 0;
    for (const equipment of rows) {
      const last = await lastTempReading(env, equipment.id);
      const at = last ? parseTempDate(last.created_at) : null;
      const missing = !last || !at || (now.getTime() - at.getTime() > TEMP_STALE_MS);
      if (!missing) continue;
      const location = { id: equipment.location_id, name: equipment.location_name };
      const text = `🌡 ${location.name} · ${equipment.name} · No temperature reading for over 6 hours`;
      const locationKey = locationKeyFor(location);
      // Anti-spam: at most one temp_missing per unit per 6 hours. The
      // explicit 6h check is needed because recordOpsAlert dedupes only 1h.
      const sinceIso = new Date(Date.now() - TEMP_STALE_MS).toISOString();
      let recent = null;
      try {
        recent = await one(env,
          'SELECT id FROM ops_alerts WHERE location_key = ? AND kind = ? AND text = ? AND created_at >= ? ORDER BY id DESC LIMIT 1',
          locationKey, 'temp_missing', text, sinceIso);
      } catch { recent = null; }
      if (recent) continue;
      await recordOpsAlert(env, { locationKey, kind: 'temp_missing', text, source: 'shawa-ceo-temp' });
      alerted += 1;
    }
    return { checked: rows.length, alerted };
  } catch { return { checked: 0, alerted: 0 }; }
}

function nowIso() { return new Date().toISOString(); }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function normalizeContact(raw) {
  const value = String(raw || '').trim();
  if (isEmail(value)) return { email: value.toLowerCase(), phone: '' };
  const phone = value.replace(/[\s()-]/g, '');
  return { email: '', phone };
}
function contactLookup(contact) {
  return contact.email ? { sql: 'lower(email) = ?', value: contact.email } : { sql: 'phone = ?', value: contact.phone };
}
function employeeName(row) { return `${row.first_name} ${row.last_name}`.trim(); }

function bytesToHex(bytes) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(digest);
}
async function hashSecret(secret) {
  if (!secret) return null;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$100000$${bytesToHex(salt)}$${bytesToHex(bits)}`;
}
async function verifySecret(secret, stored) {
  if (!stored) return !secret;
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = hexToBytes(parts[2]);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return bytesToHex(bits) === parts[3];
}

export function rankForPosition(position) {
  const value = String(position || '').trim().toLowerCase();
  if (value === 'директор') return 'director';
  if (value === 'менеджер' || value === 'управляющий') return 'manager';
  return 'staff';
}

export function publicEmployee(row, actor) {
  if (!row) return null;
  const result = {
    id: row.id,
    name: employeeName(row),
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone || '',
    email: row.email || '',
    rank: row.rank,
    rankLevel: RANK_LEVEL[row.rank],
    rankLabel: RANK_LABEL[row.rank],
    position: row.position || '',
    locationId: row.location_id,
    active: Boolean(row.active),
    hasPin: Boolean(row.pin_hash),
    hasPassword: Boolean(row.password_hash),
    createdAt: row.created_at
  };
  // Hourly rate and pay totals are owner-only: absent from the payload for everyone else.
  if (actor?.rank === 'owner') {
    result.hourlyRate = row.hourly_rate_cents == null ? null : row.hourly_rate_cents / 100;
  }
  return result;
}

async function createSession(env, employeeId) {
  const token = `${crypto.randomUUID()}.${bytesToHex(crypto.getRandomValues(new Uint8Array(24)))}`;
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();
  await run(env, 'INSERT INTO sessions(token_hash, employee_id, expires_at) VALUES (?, ?, ?)', tokenHash, employeeId, expires);
  return token;
}

async function authenticate(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await one(env, `SELECT e.* FROM sessions s JOIN employees e ON e.id = s.employee_id
    WHERE s.token_hash = ? AND s.expires_at > ?`, tokenHash, nowIso());
  return row?.active ? row : null;
}
function requireRank(actor, rank) {
  return actor && RANK_LEVEL[actor.rank] >= RANK_LEVEL[rank];
}

async function employeeById(env, id) { return one(env, 'SELECT * FROM employees WHERE id = ?', Number(id)); }

function locationView(row) {
  return { id: row.id, name: row.name, address: row.address, status: row.status, sort: row.sort_order, active: Boolean(row.active) };
}
async function locations(env, includeInactive = false) {
  const rows = await all(env, `SELECT * FROM locations ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`);
  return rows.map(locationView);
}

/* ---------------- Auth: registration (first = owner, then invites only) ---------------- */

function mailConfigured(env) { return Boolean(env.RESEND_API_KEY); }

function randomEmailCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
}

async function sendEmailCode(env, to, code) {
  const companyName = await getSetting(env, 'companyName');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'SHAWA CEO <onboarding@resend.dev>',
      to: [to],
      subject: `Код подтверждения SHAWA CEO: ${code}`,
      text: `Ваш код подтверждения для регистрации в SHAWA CEO${companyName ? ` (${companyName})` : ''}: ${code}\n\nКод действует 10 минут. Если вы не регистрировались, просто проигнорируйте это письмо.`
    })
  });
  if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
}

async function resolveRegistration(env, data) {
  const firstName = String(data.firstName || '').trim();
  const lastName = String(data.lastName || '').trim();
  if (!firstName || !lastName) return { error: fail(400, 'Укажите имя и фамилию') };
  const contact = normalizeContact(data.contact || data.phone || data.email);
  if (!contact.phone && !contact.email) return { error: fail(400, 'Укажите телефон или email') };
  if (contact.phone && !/^\+?\d{7,15}$/.test(contact.phone)) return { error: fail(400, 'Проверьте номер телефона') };
  const countRow = await one(env, 'SELECT COUNT(*) AS count FROM employees');
  const isFirst = Number(countRow?.count || 0) === 0;
  const duplicateLookup = contactLookup(contact);
  const duplicate = await one(env, `SELECT id FROM employees WHERE ${duplicateLookup.sql}`, duplicateLookup.value);
  if (duplicate) return { error: fail(409, 'Такой телефон или email уже зарегистрирован — войдите') };
  let rank = 'staff';
  let position = null;
  let locationId = null;
  let invite = null;
  if (isFirst) {
    rank = 'owner';
    position = 'Владелец';
  } else if (data.inviteCode) {
    invite = await one(env, 'SELECT * FROM invites WHERE code = ?', String(data.inviteCode).trim().toUpperCase());
    if (!invite || invite.used_at || invite.revoked_at || (invite.expires_at && invite.expires_at <= nowIso())) {
      return { error: fail(400, 'Код приглашения недействителен или уже использован') };
    }
    if (invite.contact && invite.contact !== contact.phone && invite.contact !== contact.email) {
      return { error: fail(400, 'Код приглашения выдан на другой номер телефона или email') };
    }
    rank = invite.rank;
    position = invite.position;
    locationId = invite.location_id;
  }
  if (!isFirst && !invite) return { error: fail(403, 'Регистрация — только по коду приглашения. Попросите код у вашего руководителя') };
  return { firstName, lastName, contact, isFirst, rank, position, locationId, invite };
}

async function registerStart(request, env) {
  const data = await body(request);
  const resolved = await resolveRegistration(env, data);
  if (resolved.error) return resolved.error;
  const { contact } = resolved;
  const verificationRequired = Boolean(contact.email) && mailConfigured(env);
  if (!verificationRequired) return json({ ok: true, verificationRequired: false });
  const code = randomEmailCode();
  const id = crypto.randomUUID();
  const payload = {
    firstName: resolved.firstName, lastName: resolved.lastName,
    phone: contact.phone, email: contact.email,
    rank: resolved.rank, position: resolved.position, locationId: resolved.locationId,
    inviteCode: resolved.invite ? resolved.invite.code : null
  };
  await run(env, 'INSERT INTO pending_registrations(id, payload, code_hash, expires_at) VALUES (?, ?, ?, ?)',
    id, JSON.stringify(payload), await hashSecret(code), new Date(Date.now() + 10 * 60 * 1000).toISOString());
  try {
    await sendEmailCode(env, contact.email, code);
  } catch {
    await run(env, 'DELETE FROM pending_registrations WHERE id = ?', id);
    return fail(502, 'Не удалось отправить письмо с кодом — попробуйте позже');
  }
  return json({ ok: true, verificationRequired: true, pendingId: id, email: contact.email });
}

async function registerVerify(request, env) {
  const data = await body(request);
  const pending = await one(env, 'SELECT * FROM pending_registrations WHERE id = ?', String(data.pendingId || ''));
  if (!pending) return fail(400, 'Сессия регистрации не найдена — начните сначала');
  if (pending.expires_at <= nowIso()) {
    await run(env, 'DELETE FROM pending_registrations WHERE id = ?', pending.id);
    return fail(400, 'Код истёк — начните регистрацию сначала');
  }
  if (Number(pending.attempts || 0) >= 5) return fail(429, 'Слишком много неверных попыток — начните сначала');
  if (!(await verifySecret(String(data.code || '').trim(), pending.code_hash))) {
    await run(env, 'UPDATE pending_registrations SET attempts = attempts + 1 WHERE id = ?', pending.id);
    return fail(401, 'Неверный код');
  }
  await run(env, 'UPDATE pending_registrations SET verified_at = ? WHERE id = ?', nowIso(), pending.id);
  return json({ ok: true });
}

async function registerResend(request, env) {
  const data = await body(request);
  const pending = await one(env, 'SELECT * FROM pending_registrations WHERE id = ?', String(data.pendingId || ''));
  if (!pending) return fail(400, 'Сессия регистрации не найдена — начните сначала');
  if (pending.verified_at) return json({ ok: true, alreadyVerified: true });
  const payload = JSON.parse(pending.payload);
  if (!payload.email) return fail(400, 'В этой сессии нет email для отправки кода');
  const code = randomEmailCode();
  await run(env, 'UPDATE pending_registrations SET code_hash = ?, expires_at = ?, attempts = 0 WHERE id = ?',
    await hashSecret(code), new Date(Date.now() + 10 * 60 * 1000).toISOString(), pending.id);
  try {
    await sendEmailCode(env, payload.email, code);
  } catch {
    return fail(502, 'Не удалось отправить письмо с кодом — попробуйте позже');
  }
  return json({ ok: true });
}

async function completePendingRegistration(env, data) {
  const pending = await one(env, 'SELECT * FROM pending_registrations WHERE id = ?', String(data.pendingId || ''));
  if (!pending) return fail(400, 'Сессия регистрации не найдена — начните сначала');
  if (!pending.verified_at) return fail(400, 'Сначала подтвердите код из письма');
  if (pending.expires_at <= nowIso()) {
    await run(env, 'DELETE FROM pending_registrations WHERE id = ?', pending.id);
    return fail(400, 'Код истёк — начните регистрацию сначала');
  }
  const password = String(data.password || '');
  if (password.length < 6) return fail(400, 'Придумайте пароль — минимум 6 символов');
  const payload = JSON.parse(pending.payload);
  const contact = { phone: payload.phone || '', email: payload.email || '' };
  const duplicateLookup = contactLookup(contact);
  const duplicate = await one(env, `SELECT id FROM employees WHERE ${duplicateLookup.sql}`, duplicateLookup.value);
  if (duplicate) return fail(409, 'Такой телефон или email уже зарегистрирован — войдите');
  let invite = null;
  if (payload.inviteCode) {
    invite = await one(env, 'SELECT * FROM invites WHERE code = ?', payload.inviteCode);
    if (!invite || invite.used_at || invite.revoked_at) return fail(400, 'Код приглашения недействителен или уже использован');
  }
  const passwordHash = await hashSecret(password);
  let result;
  try {
    result = await run(env, `INSERT INTO employees(first_name, last_name, phone, email, pin_hash, password_hash, rank, position, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, payload.firstName, payload.lastName, contact.phone, contact.email, null, passwordHash, payload.rank, payload.position, payload.locationId);
  } catch {
    return fail(409, 'Такой телефон или email уже зарегистрирован — войдите');
  }
  const employeeId = result.meta?.last_row_id;
  if (invite) await run(env, 'UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?', employeeId, nowIso(), invite.code);
  await run(env, 'DELETE FROM pending_registrations WHERE id = ?', pending.id);
  const employee = await employeeById(env, employeeId);
  const token = await createSession(env, employeeId);
  return json({ ok: true, token, employee: publicEmployee(employee, employee), companyName: await getSetting(env, 'companyName') }, 201);
}

async function register(request, env) {
  const data = await body(request);
  if (data.pendingId) return completePendingRegistration(env, data);
  const resolved = await resolveRegistration(env, data);
  if (resolved.error) return resolved.error;
  const { firstName, lastName, contact, rank, position, locationId, invite } = resolved;
  if (contact.email && mailConfigured(env)) {
    return fail(400, 'Для регистрации по email сначала подтвердите адрес кодом из письма');
  }
  const password = String(data.password || '');
  if (password.length < 6) return fail(400, 'Придумайте пароль — минимум 6 символов');
  const passwordHash = await hashSecret(password);
  const pinHash = await hashSecret(data.pin || '');
  let result;
  try {
    result = await run(env, `INSERT INTO employees(first_name, last_name, phone, email, pin_hash, password_hash, rank, position, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, firstName, lastName, contact.phone, contact.email, pinHash, passwordHash, rank, position, locationId);
  } catch {
    return fail(409, 'Такой телефон или email уже зарегистрирован — войдите');
  }
  const employeeId = result.meta?.last_row_id;
  if (invite) await run(env, 'UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?', employeeId, nowIso(), invite.code);
  const employee = await employeeById(env, employeeId);
  const token = await createSession(env, employeeId);
  return json({ ok: true, token, employee: publicEmployee(employee, employee), companyName: await getSetting(env, 'companyName') }, 201);
}

async function login(request, env) {
  const data = await body(request);
  const contact = normalizeContact(data.contact || data.phone || data.email);
  const lookup = contactLookup(contact);
  const employee = await one(env, `SELECT * FROM employees WHERE ${lookup.sql}`, lookup.value);
  if (!employee || !employee.active) return fail(401, 'Профиль не найден');
  if (employee.password_hash) {
    if (!data.password) return json({ ok: false, needsPassword: true, error: 'Введите пароль' }, 401);
    if (!(await verifySecret(data.password, employee.password_hash))) return fail(401, 'Неверный пароль');
  } else if (employee.pin_hash) {
    const provided = data.pin || data.password;
    if (!provided) return json({ ok: false, needsPin: true, error: 'Введите PIN' }, 401);
    if (!(await verifySecret(provided, employee.pin_hash))) return fail(401, 'Неверный PIN');
  }
  const token = await createSession(env, employee.id);
  return json({ ok: true, token, employee: publicEmployee(employee, employee), companyName: await getSetting(env, 'companyName') });
}

/* One-time password reset: the raw token is only ever in the link handed to
   the account owner; D1 stores its SHA-256 hash. On success the password is
   replaced, the token is burned and all previous sessions are revoked. */
async function resetPassword(request, env) {
  const data = await body(request);
  const rawToken = String(data.token || '').trim();
  const newPassword = String(data.password || '');
  if (!rawToken) return fail(400, 'Нет токена сброса');
  if (newPassword.length < 6) return fail(400, 'Пароль — минимум 6 символов');
  const tokenHash = await sha256Hex(rawToken);
  const row = await one(env, 'SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', tokenHash, nowIso());
  if (!row) return fail(400, 'Ссылка недействительна или истекла');
  const employee = await employeeById(env, row.employee_id);
  if (!employee || !employee.active) return fail(404, 'Профиль не найден');
  await run(env, 'UPDATE employees SET password_hash = ? WHERE id = ?', await hashSecret(newPassword), employee.id);
  await run(env, 'UPDATE password_resets SET used_at = ? WHERE id = ?', nowIso(), row.id);
  await run(env, 'DELETE FROM sessions WHERE employee_id = ?', employee.id);
  const token = await createSession(env, employee.id);
  return json({ ok: true, token, employee: publicEmployee(employee, employee), companyName: await getSetting(env, 'companyName') });
}

/* Self-service password reset by 6-digit code: the user enters the email or
   phone from their profile on the login screen, receives a code (email via
   Resend, SMS via Twilio — whichever channel is configured on the server)
   and sets a new password. Codes live 10 minutes, max 5 attempts, one
   active code per employee. */
function smsConfigured(env) { return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER); }

async function sendResetEmailCode(env, to, code) {
  const companyName = await getSetting(env, 'companyName');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'SHAWA CEO <onboarding@resend.dev>',
      to: [to],
      subject: `Сброс пароля SHAWA CEO: ${code}`,
      text: `Код для сброса пароля в SHAWA CEO${companyName ? ` (${companyName})` : ''}: ${code}\n\nКод действует 10 минут. Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо — пароль останется прежним.`
    })
  });
  if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
}

async function sendSmsCode(env, to, code) {
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: `SHAWA CEO: код сброса пароля ${code}. Действует 10 минут.` });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  if (!response.ok) throw new Error(`Twilio HTTP ${response.status}`);
}

function maskContact(channel, value) {
  if (channel === 'email') {
    const [name, domain] = String(value).split('@');
    return `${(name || '').slice(0, 2)}***@${domain || ''}`;
  }
  const digits = String(value).replace(/\D/g, '');
  return `•••${digits.slice(-4)}`;
}

async function resetRequest(request, env) {
  const data = await body(request);
  const contact = normalizeContact(data.contact || data.phone || data.email);
  if (!contact.phone && !contact.email) return fail(400, 'Укажите телефон или email из вашего профиля');
  const lookup = contactLookup(contact);
  const employee = await one(env, `SELECT * FROM employees WHERE ${lookup.sql}`, lookup.value);
  if (!employee || !employee.active) return fail(404, 'Профиль не найден');
  const channel = contact.email ? 'email' : 'phone';
  const target = channel === 'email' ? employee.email : employee.phone;
  if (!target) return fail(400, channel === 'email' ? 'У профиля нет email — сброс по email недоступен' : 'У профиля нет телефона — сброс по телефону недоступен, используйте email');
  if (channel === 'email' && !mailConfigured(env)) return fail(503, 'Отправка кодов по email пока не настроена на сервере — обратитесь к владельцу');
  if (channel === 'phone' && !smsConfigured(env)) return fail(503, 'Отправка SMS пока не настроена на сервере — используйте сброс по email или обратитесь к владельцу');
  const code = randomEmailCode();
  await run(env, 'UPDATE password_reset_codes SET used_at = ? WHERE employee_id = ? AND used_at IS NULL', nowIso(), employee.id);
  const result = await run(env, 'INSERT INTO password_reset_codes(employee_id, channel, contact, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    employee.id, channel, target, await hashSecret(code), new Date(Date.now() + 10 * 60 * 1000).toISOString(), nowIso());
  try {
    if (channel === 'email') await sendResetEmailCode(env, target, code); else await sendSmsCode(env, target, code);
  } catch {
    await run(env, 'DELETE FROM password_reset_codes WHERE id = ?', result.meta?.last_row_id);
    return fail(502, 'Не удалось отправить код — попробуйте позже');
  }
  return json({ ok: true, channel, sentTo: maskContact(channel, target) });
}

async function resetConfirm(request, env) {
  const data = await body(request);
  const contact = normalizeContact(data.contact || data.phone || data.email);
  const newPassword = String(data.password || '');
  if (newPassword.length < 6) return fail(400, 'Пароль — минимум 6 символов');
  const lookup = contactLookup(contact);
  const employee = await one(env, `SELECT * FROM employees WHERE ${lookup.sql}`, lookup.value);
  if (!employee || !employee.active) return fail(404, 'Профиль не найден');
  const row = await one(env, 'SELECT * FROM password_reset_codes WHERE employee_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1', employee.id);
  if (!row) return fail(400, 'Сначала запросите код сброса');
  if (row.expires_at <= nowIso()) {
    await run(env, 'UPDATE password_reset_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
    return fail(400, 'Код истёк — запросите новый');
  }
  if (Number(row.attempts || 0) >= 5) {
    await run(env, 'UPDATE password_reset_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
    return fail(400, 'Слишком много попыток — запросите новый код');
  }
  if (!(await verifySecret(String(data.code || '').trim(), row.code_hash))) {
    await run(env, 'UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return fail(401, 'Неверный код');
  }
  await run(env, 'UPDATE employees SET password_hash = ? WHERE id = ?', await hashSecret(newPassword), employee.id);
  await run(env, 'UPDATE password_reset_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
  await run(env, 'DELETE FROM sessions WHERE employee_id = ?', employee.id);
  const token = await createSession(env, employee.id);
  return json({ ok: true, token, employee: publicEmployee(employee, employee), companyName: await getSetting(env, 'companyName') });
}

/* ---------------- Team: employees & invites ---------------- */

async function visibleEmployees(env, actor) {
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) {
    const rows = await all(env, 'SELECT * FROM employees ORDER BY active DESC, last_name, first_name, id');
    return rows.map(r => publicEmployee(r, actor));
  }
  return [publicEmployee(actor, actor)];
}

async function updateEmployee(request, env, actor, id) {
  const target = await employeeById(env, id);
  if (!target) return fail(404, 'Сотрудник не найден');
  const data = await body(request);
  if (Object.prototype.hasOwnProperty.call(data, 'hourlyRate') && actor.rank !== 'owner') {
    return fail(403, 'Часовую ставку меняет только владелец');
  }
  const isSelf = actor.id === target.id;
  if (!isSelf && !requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
  if (!isSelf && RANK_LEVEL[target.rank] >= RANK_LEVEL[actor.rank] && actor.rank !== 'owner') {
    return fail(403, 'Нельзя изменять профиль равного или старшего ранга');
  }
  const updates = [];
  const params = [];
  const assign = (column, value) => { updates.push(`${column} = ?`); params.push(value); };
  if (isSelf || requireRank(actor, 'manager')) {
    if (data.firstName !== undefined) assign('first_name', String(data.firstName).trim());
    if (data.lastName !== undefined) assign('last_name', String(data.lastName).trim());
    if (data.phone !== undefined) assign('phone', normalizeContact(data.phone).phone || '');
    if (data.email !== undefined) assign('email', normalizeContact(data.email).email || '');
    if (data.pin !== undefined) assign('pin_hash', await hashSecret(data.pin));
    if (data.password !== undefined) {
      const newPassword = String(data.password || '');
      if (newPassword.length < 6) return fail(400, 'Пароль — минимум 6 символов');
      assign('password_hash', await hashSecret(newPassword));
    }
  }
  if (!isSelf && requireRank(actor, 'manager')) {
    if (data.position !== undefined) assign('position', data.position || null);
    if (data.locationId !== undefined) assign('location_id', data.locationId || null);
    if (data.active !== undefined) assign('active', data.active ? 1 : 0);
    if (data.rank !== undefined) {
      if (!RANK_LEVEL[data.rank]) return fail(400, 'Неизвестный ранг');
      if (RANK_LEVEL[data.rank] > RANK_LEVEL[actor.rank]) return fail(403, 'Нельзя назначить ранг выше своего');
      assign('rank', data.rank);
    }
  }
  if (actor.rank === 'owner' && data.hourlyRate !== undefined) {
    assign('hourly_rate_cents', data.hourlyRate == null || data.hourlyRate === '' ? null : Math.round(Number(data.hourlyRate) * 100));
  }
  if (!updates.length) return fail(400, 'Нет изменений');
  params.push(id);
  await run(env, `UPDATE employees SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`, ...params.slice(0, -1), nowIso(), id);
  const updated = await employeeById(env, id);
  return json({ ok: true, employee: publicEmployee(updated, actor) });
}

function inviteView(row, locationRows) {
  const location = locationRows.find(l => l.id === row.location_id);
  return {
    code: row.code,
    rank: row.rank,
    rankLabel: RANK_LABEL[row.rank],
    position: row.position || '',
    locationId: row.location_id,
    locationName: location?.name || null,
    contact: row.contact || '',
    createdBy: row.created_by,
    usedBy: row.used_by,
    usedAt: row.used_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    active: !row.used_at && !row.revoked_at
  };
}

async function createInvite(request, env, actor) {
  if (!requireRank(actor, 'manager')) return fail(403, 'Приглашения создаёт управляющий и выше');
  const data = await body(request);
  const position = data.position ? String(data.position).trim() : null;
  const rank = data.rank || rankForPosition(position);
  if (!RANK_LEVEL[rank]) return fail(400, 'Неизвестный ранг');
  if (RANK_LEVEL[rank] > RANK_LEVEL[actor.rank]) return fail(403, 'Нельзя пригласить рангом выше своего');
  const locationId = data.locationId ? Number(data.locationId) : null;
  const inviteContact = normalizeContact(data.contact || '');
  const boundContact = inviteContact.phone || inviteContact.email || null;
  if (locationId && !(await one(env, 'SELECT id FROM locations WHERE id = ?', locationId))) {
    return fail(400, 'Точка не найдена');
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => alphabet[b % alphabet.length]).join('');
  const code = `SC-${pick(4)}-${pick(4)}`;
  await run(env, 'INSERT INTO invites(code, created_by, rank, position, location_id, contact, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    code, actor.id, rank, position, locationId, boundContact, data.expiresAt || null);
  const row = await one(env, 'SELECT * FROM invites WHERE code = ?', code);
  return json({ ok: true, invite: inviteView(row, await locations(env)) }, 201);
}

/* ---------------- Time: punches & timesheet ---------------- */

async function punchView(env, row, actor) {
  const employee = await employeeById(env, row.employee_id);
  const end = row.clock_out ? new Date(row.clock_out) : new Date();
  const hours = Math.max(0, (end - new Date(row.clock_in)) / 3600000);
  const result = {
    id: row.id, employeeId: row.employee_id, employeeName: employee ? employeeName(employee) : '',
    locationId: row.location_id, clockIn: row.clock_in, clockOut: row.clock_out,
    noteIn: row.note_in || '', noteOut: row.note_out || '', hours: Math.round(hours * 100) / 100
  };
  if (actor.rank === 'owner') result.cost = employee?.hourly_rate_cents == null ? 0 : Math.round(hours * employee.hourly_rate_cents) / 100;
  return result;
}

async function visiblePunches(env, actor) {
  let rows;
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) rows = await all(env, 'SELECT * FROM punches ORDER BY clock_in DESC LIMIT 500');
  else rows = await all(env, 'SELECT * FROM punches WHERE employee_id = ? ORDER BY clock_in DESC LIMIT 500', actor.id);
  return Promise.all(rows.map(r => punchView(env, r, actor)));
}

async function clockAction(env, employee, data, actorForView) {
  const at = data.at ? new Date(data.at) : new Date();
  if (Number.isNaN(at)) return fail(400, 'Неверное время');
  const open = await one(env, 'SELECT * FROM punches WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC', employee.id);
  if (data.action === 'in') {
    if (open) return fail(409, 'Смена уже начата');
    const result = await run(env, 'INSERT INTO punches(employee_id, location_id, clock_in, note_in) VALUES (?, ?, ?, ?)', employee.id, data.locationId || employee.location_id, at.toISOString(), data.note || '');
    const row = await one(env, 'SELECT * FROM punches WHERE id = ?', result.meta?.last_row_id);
    return json({ ok: true, punch: await punchView(env, row, actorForView) }, 201);
  }
  if (data.action === 'out') {
    if (!open) return fail(409, 'Нет открытой смены');
    await run(env, 'UPDATE punches SET clock_out = ?, note_out = ? WHERE id = ?', at.toISOString(), data.note || '', open.id);
    const row = await one(env, 'SELECT * FROM punches WHERE id = ?', open.id);
    return json({ ok: true, punch: await punchView(env, row, actorForView) });
  }
  return fail(400, 'Нужно действие in или out');
}

async function timesheet(env, actor, searchParams) {
  const punches = await visiblePunches(env, actor);
  const from = searchParams.get('from') ? new Date(searchParams.get('from')) : null;
  const to = searchParams.get('to') ? new Date(searchParams.get('to')) : null;
  const grouped = new Map();
  for (const punch of punches) {
    const t = new Date(punch.clockIn);
    if (from && t < from) continue;
    if (to && t > to) continue;
    if (!grouped.has(punch.employeeId)) {
      grouped.set(punch.employeeId, { employeeId: punch.employeeId, employeeName: punch.employeeName, hours: 0, punches: 0 });
    }
    const row = grouped.get(punch.employeeId);
    row.hours = Math.round((row.hours + punch.hours) * 100) / 100;
    row.punches += 1;
    if (actor.rank === 'owner') row.cost = Math.round(((row.cost || 0) + (punch.cost || 0)) * 100) / 100;
  }
  return [...grouped.values()];
}

/* ---------------- 3D location view: scene staff, demo roster, shift calls ---------------- */

// Roles of the 3D scene (ported from the verified «SHAWA — точки в 3D»
// prototype). color = THREE body color of the avatar, shirt = CSS color.
const SCENE_ROLES = {
  chef:     { title: 'Шеф-повар',      titleEn: 'Chef',          color: 0x2B2B2B, shirt: '#2B2B2B' },
  manager:  { title: 'Менеджер смены', titleEn: 'Shift manager', color: 0x2E4057, shirt: '#2E4057' },
  cashier:  { title: 'Кассир',         titleEn: 'Cashier',       color: 0xC05A2E, shirt: '#C05A2E' },
  grill:    { title: 'Повар гриля',    titleEn: 'Grill cook',    color: 0x4A4A48, shirt: '#4A4A48' },
  shawarma: { title: 'Повар шаурмы',   titleEn: 'Shawarma cook', color: 0x5D4037, shirt: '#5D4037' },
  helper:   { title: 'Помощник кухни', titleEn: 'Kitchen helper', color: 0x8A6D1F, shirt: '#B98A1D' },
  waiter:   { title: 'Официант',       titleEn: 'Waiter',        color: 0x1F1F1F, shirt: '#1F1F1F' },
  cleaner:  { title: 'Уборщица',       titleEn: 'Cleaner',       color: 0x33666B, shirt: '#33666B' }
};

// Maps a real employee (free-text position + rank) to a 3D scene role.
function sceneRoleFor(position, rank) {
  if (rank === 'owner' || rank === 'director') return 'manager';
  const p = String(position || '').toLowerCase();
  if (p.includes('шеф')) return 'chef';
  if (p.includes('менеджер') || p.includes('управляющ')) return 'manager';
  if (p.includes('кассир')) return 'cashier';
  if (p.includes('шаурм') || p.includes('шаверм') || p.includes('донер')) return 'shawarma';
  if (p.includes('гриль') || p.includes('мангал')) return 'grill';
  if (p.includes('официант')) return 'waiter';
  if (p.includes('убор')) return 'cleaner';
  if (p.includes('помощник') || p.includes('кухн') || p.includes('заготов')) return 'helper';
  if (p.includes('повар')) return 'grill';
  return 'helper';
}

// Demo roster per location (ported from the verified prototype). Shown ONLY
// when a location has no real employees yet, always flagged demo:true so the
// UI labels it «демо-данные». Rating mirrors the points model of the
// prototype: base 40 + 10 per clean week + 25 per manual award.
// Tuple: [name, role, rate $/h, hours today, hours week, clean weeks, awards, on shift]
const DEMO_ROSTERS = {
  'Miami Downtown': [
    ['Тимур', 'chef', 32, 7.5, 41, 9, 3, 1], ['Анна', 'cashier', 19, 8, 40, 7, 1, 1],
    ['Руслан', 'grill', 24, 7, 38, 5, 2, 1], ['Омар', 'shawarma', 23, 7.5, 39, 6, 1, 1],
    ['Дина', 'helper', 17, 6.5, 33, 4, 0, 1], ['София', 'waiter', 16, 7, 36, 8, 2, 1],
    ['Елена', 'cleaner', 15, 5, 26, 10, 1, 1], ['Марко', 'manager', 27, 0, 32, 6, 2, 0],
    ['Игорь', 'helper', 17, 4, 29, 3, 0, 0]
  ],
  'Sunny Isles': [
    ['Камиль', 'chef', 31, 8, 42, 11, 2, 1], ['Мила', 'cashier', 19, 7.5, 37, 6, 1, 1],
    ['Денис', 'grill', 24, 7, 35, 4, 1, 1], ['Фарид', 'shawarma', 23, 6, 34, 5, 0, 1],
    ['Ольга', 'helper', 17, 6, 30, 7, 1, 1], ['Никита', 'waiter', 16, 0, 31, 5, 1, 0],
    ['Роза', 'cleaner', 15, 4.5, 24, 9, 2, 1], ['Алан', 'manager', 27, 8, 40, 8, 3, 1],
    ['Вера', 'helper', 17, 0, 22, 2, 0, 0]
  ],
  'Fort Lauderdale': [
    ['Самир', 'chef', 30, 6.5, 36, 7, 2, 1], ['Юлия', 'cashier', 18, 7, 38, 9, 2, 1],
    ['Павел', 'grill', 23, 7.5, 39, 3, 0, 1], ['Лейла', 'shawarma', 22, 0, 28, 4, 1, 0],
    ['Гриша', 'helper', 16, 5.5, 27, 2, 0, 1], ['Артём', 'waiter', 16, 6, 33, 6, 1, 1],
    ['Нина', 'cleaner', 15, 0, 20, 8, 0, 0], ['Оксана', 'manager', 26, 7, 37, 5, 1, 1]
  ],
  'Hallandale': [
    ['Рашид', 'chef', 30, 5, 18, 6, 1, 1], ['Света', 'cashier', 18, 5.5, 16, 3, 0, 1],
    ['Тимур', 'grill', 23, 0, 12, 2, 0, 0], ['Мадина', 'helper', 16, 4, 14, 1, 0, 1],
    ['Женя', 'waiter', 16, 0, 9, 2, 0, 0], ['Алла', 'cleaner', 15, 3, 11, 4, 0, 1]
  ]
};
function demoRosterFor(location) { return DEMO_ROSTERS[location.name] || DEMO_ROSTERS['Miami Downtown']; }
const demoRatingPoints = (d) => 40 + d[5] * 10 + d[6] * 25;

// Builds the staff payload for the 3D view of one location. Real employees of
// the location come first (hours from this week's punches at the location,
// pay owner-only like everywhere else); only a location with no real staff at
// all falls back to the demo roster. Today's active shift calls overlay the
// base status. Staff-rank actors see colleagues without their hours — the
// same "own card only" rule as the timesheet.
async function buildLocationScene(env, actor, location) {
  const ownerView = actor.rank === 'owner';
  const managerView = RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager;
  const now = new Date();
  const todayIso = startOfNyDay(now).toISOString();
  const weekIso = weekStartNy(now).toISOString();
  const callRows = await all(env, `SELECT * FROM shift_calls WHERE location_id = ? AND cancelled_at IS NULL AND called_at >= ? ORDER BY called_at`, location.id, todayIso);
  const callByKey = new Map(callRows.map(c => [c.employee_key, c]));

  const employeeRows = await all(env, 'SELECT * FROM employees WHERE location_id = ? AND active = 1 ORDER BY last_name, first_name, id', location.id);
  let staff = [];
  let demo = false;
  if (employeeRows.length) {
    const ids = employeeRows.map(e => e.id);
    const marks = ids.map(() => '?').join(',');
    const punchRows = await all(env, `SELECT * FROM punches WHERE employee_id IN (${marks}) AND clock_in >= ? AND (location_id = ? OR location_id IS NULL) ORDER BY clock_in`, ...ids, weekIso, location.id);
    const byEmployee = new Map(ids.map(id => [id, { hoursToday: 0, hoursWeek: 0, onShift: false }]));
    for (const punch of punchRows) {
      const agg = byEmployee.get(punch.employee_id);
      if (!agg) continue;
      const end = punch.clock_out ? new Date(punch.clock_out) : now;
      const hours = Math.max(0, (end - new Date(punch.clock_in)) / 3600000);
      agg.hoursWeek += hours;
      if (punch.clock_in >= todayIso) agg.hoursToday += hours;
      if (!punch.clock_out) agg.onShift = true;
    }
    staff = employeeRows.map(e => {
      const agg = byEmployee.get(e.id) || { hoursToday: 0, hoursWeek: 0, onShift: false };
      const role = sceneRoleFor(e.position, e.rank);
      const entry = {
        key: `emp:${e.id}`, employeeId: e.id, name: employeeName(e),
        position: e.position || '', rank: e.rank,
        role, roleTitle: SCENE_ROLES[role].title, roleTitleEn: SCENE_ROLES[role].titleEn,
        status: agg.onShift ? 'on' : 'off', calledAt: null,
        hoursToday: Math.round(agg.hoursToday * 100) / 100,
        hoursWeek: Math.round(agg.hoursWeek * 100) / 100
      };
      if (ownerView) {
        const rate = e.hourly_rate_cents == null ? null : e.hourly_rate_cents / 100;
        entry.rate = rate;
        entry.payToday = rate == null ? 0 : Math.round(agg.hoursToday * rate * 100) / 100;
        entry.payWeek = rate == null ? 0 : Math.round(agg.hoursWeek * rate * 100) / 100;
      }
      return entry;
    });
  } else {
    demo = true;
    staff = demoRosterFor(location).map((d, i) => {
      const role = d[1];
      const entry = {
        key: `demo:${location.id}:${i + 1}`, demo: true, name: d[0],
        position: SCENE_ROLES[role].title,
        role, roleTitle: SCENE_ROLES[role].title, roleTitleEn: SCENE_ROLES[role].titleEn,
        status: d[7] ? 'on' : 'off', calledAt: null,
        hoursToday: d[3], hoursWeek: d[4],
        rating: { points: demoRatingPoints(d), cleanWeeks: d[5], awards: d[6] }
      };
      if (ownerView) {
        entry.rate = d[2];
        entry.payToday = Math.round(d[3] * d[2] * 100) / 100;
        entry.payWeek = Math.round(d[4] * d[2] * 100) / 100;
      }
      return entry;
    });
  }
  for (const entry of staff) {
    const call = callByKey.get(entry.key);
    if (!call) continue;
    entry.callId = call.id;
    if (entry.status !== 'on') { entry.status = 'called'; entry.calledAt = call.called_at; }
  }
  if (!managerView) {
    for (const entry of staff) {
      if (entry.employeeId !== actor.id) { entry.hoursToday = null; entry.hoursWeek = null; }
    }
  }
  const summary = {
    on: staff.filter(s => s.status === 'on').length,
    called: staff.filter(s => s.status === 'called').length,
    total: staff.length,
    hoursToday: managerView ? Math.round(staff.reduce((sum, s) => sum + (s.hoursToday || 0), 0) * 100) / 100 : null
  };
  if (ownerView) summary.payToday = Math.round(staff.reduce((sum, s) => sum + (s.payToday || 0), 0) * 100) / 100;
  return { location: locationView(location), demo, canCall: managerView, staff, summary };
}

// "Вызвать на смену": an interface mark stored in shift_calls with the call
// time. No message is sent to the employee.
async function callToShift(env, actor, location, key) {
  const scene = await buildLocationScene(env, actor, location);
  const entry = scene.staff.find(s => s.key === key);
  if (!entry) return { error: fail(404, 'Сотрудник не найден в этой точке') };
  if (entry.status === 'on') return { error: fail(409, 'Сотрудник уже на смене') };
  if (entry.status === 'called') return { error: fail(409, 'Сотрудник уже вызван') };
  await run(env, 'INSERT INTO shift_calls(location_id, employee_key, employee_name, role, called_by, called_at) VALUES (?, ?, ?, ?, ?, ?)',
    location.id, entry.key, entry.name, entry.role, actor.id, nowIso());
  return { scene: await buildLocationScene(env, actor, location) };
}

async function cancelShiftCall(env, actor, location, key) {
  const row = await one(env, `SELECT * FROM shift_calls WHERE location_id = ? AND employee_key = ? AND cancelled_at IS NULL ORDER BY called_at DESC`, location.id, key);
  if (!row) return { error: fail(404, 'Активный вызов не найден') };
  await run(env, 'UPDATE shift_calls SET cancelled_at = ? WHERE id = ?', nowIso(), row.id);
  return { scene: await buildLocationScene(env, actor, location) };
}

/* ---------------- Menu, recipes, stock ---------------- */

function parseTags(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
  const seen = new Set();
  const tags = [];
  for (const part of raw) {
    const tag = String(part || '').trim().slice(0, 40);
    if (tag && !seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); tags.push(tag); }
    if (tags.length >= 12) break;
  }
  return tags;
}
function tagsToStore(value) { return parseTags(value).join(', '); }

// Effective public photo URL for a catalog card: an uploaded JPEG is served
// by the panel itself; otherwise the stored external URL (e.g. Cloudinary).
function catalogPhotoPath(row, origin = '') {
  if (row.photo_jpeg && (row.code || row.id)) return `${origin}/api/public/catalog/photos/${encodeURIComponent(row.code || row.id)}`;
  return row.photo_url || '';
}

// List reads of menu_items never need the uploaded-photo blob itself —
// only whether one exists (catalogPhotoPath / hasUploadedPhoto). Pulling
// photo_jpeg (base64, up to ~1 MB per dish) into every menu / catalog /
// state response wasted worker memory and bandwidth; the flag keeps the
// view semantics identical. Single-row reads (edit form, photo endpoint)
// still SELECT * and get the real blob.
const MENU_ITEM_LIST_COLUMNS = `id, code, name, name_en, category, price_cents, stopped, active, sort_order,
  clover_item_id, description_en, photo_url, (photo_jpeg IS NOT NULL) AS photo_jpeg, tags, calories, protein_g,
  catalog_published, catalog_updated_at, created_at`;

function menuItemView(row, recipeRows, bindingRows) {
  const view = {
    id: row.id, code: row.code || '', name: row.name, nameEn: row.name_en || '',
    category: row.category || '', price: row.price_cents / 100, priceCents: row.price_cents,
    stopped: Boolean(row.stopped), active: Boolean(row.active), sort: row.sort_order,
    cloverItemId: row.clover_item_id || null,
    // Website master-card fields (migration 0006). Prices stay Clover-side:
    // nothing here reads or writes a website price.
    descriptionEn: row.description_en || '',
    photoUrl: catalogPhotoPath(row),
    photoSourceUrl: row.photo_url || '',
    hasUploadedPhoto: Boolean(row.photo_jpeg),
    tags: parseTags(row.tags),
    calories: row.calories ?? null,
    proteinG: row.protein_g ?? null,
    catalogPublished: Boolean(row.catalog_published),
    catalogUpdatedAt: row.catalog_updated_at || null
  };
  if (bindingRows) {
    view.cloverBindings = bindingRows.filter(b => b.menu_item_id === row.id)
      .map(b => ({ locationId: b.location_id, cloverItemId: b.clover_item_id }));
  }
  if (recipeRows) {
    const lines = recipeRows.filter(r => r.menu_item_id === row.id);
    view.recipe = lines.map(r => ({ ingredientId: r.ingredient_id, qty: r.qty }));
    view.costCents = lines.reduce((sum, r) => sum + r.qty * (r.cost_per_unit_cents || 0), 0);
    view.cost = Math.round(view.costCents) / 100;
    view.foodCostPct = row.price_cents > 0 ? Math.round(view.costCents / row.price_cents * 1000) / 10 : null;
  }
  return view;
}

async function menuWithRecipes(env) {
  const items = await all(env, `SELECT ${MENU_ITEM_LIST_COLUMNS} FROM menu_items WHERE active = 1 ORDER BY sort_order, id`);
  const recipes = await all(env, `SELECT r.*, i.cost_per_unit_cents FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id`);
  const bindings = await all(env, 'SELECT * FROM menu_item_clover_bindings');
  return items.map(item => menuItemView(item, recipes, bindings));
}

async function saveCloverBindings(env, menuItemId, bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return;
  for (const [locationIdRaw, rawId] of Object.entries(bindings)) {
    const locationId = Number(locationIdRaw);
    if (!Number.isInteger(locationId) || locationId <= 0) continue;
    const loc = await one(env, 'SELECT id FROM locations WHERE id = ?', locationId);
    if (!loc) continue;
    const cloverItemId = String(rawId || '').trim().slice(0, 64);
    try {
      if (!cloverItemId) {
        await run(env, 'DELETE FROM menu_item_clover_bindings WHERE menu_item_id = ? AND location_id = ?', menuItemId, locationId);
      } else {
        await run(env, `INSERT INTO menu_item_clover_bindings(menu_item_id, location_id, clover_item_id, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(menu_item_id, location_id) DO UPDATE SET clover_item_id = excluded.clover_item_id, updated_at = excluded.updated_at`,
          menuItemId, locationId, cloverItemId, nowIso());
      }
    } catch { /* a duplicate (location, clover item) pair is ignored, not fatal */ }
  }
}

async function catalogSettings(env) {
  const version = Number(await getSetting(env, 'catalogVersion', '1')) || 1;
  return { version, publishedAt: await getSetting(env, 'catalogPublishedAt', '') };
}

// Public website catalog: only items flagged catalog_published. Photo and
// description come from the panel master card; the Clover item id is the
// per-location binding (legacy global mapping as fallback). NO prices —
// the consumer reads prices and live availability from Clover itself.
async function buildPublicCatalog(env, origin = '') {
  const settings = await catalogSettings(env);
  const locRows = await all(env, `SELECT * FROM locations WHERE active = 1 AND status = 'active' ORDER BY sort_order, id`);
  const items = await all(env, `SELECT ${MENU_ITEM_LIST_COLUMNS} FROM menu_items WHERE active = 1 AND catalog_published = 1 ORDER BY sort_order, id`);
  const bindings = await all(env, 'SELECT * FROM menu_item_clover_bindings');
  const byItemLoc = new Map(bindings.map(b => [`${b.menu_item_id}:${b.location_id}`, b.clover_item_id]));
  const siteSlug = { 1: 'sunny-isles', 2: 'edgewater', 3: 'fort-lauderdale' };
  return {
    ok: true,
    catalog: 'mangal-menu',
    version: settings.version,
    publishedAt: settings.publishedAt || null,
    generatedAt: nowIso(),
    locations: locRows.map(loc => ({
      id: loc.id,
      slug: siteSlug[loc.id] || `location-${loc.id}`,
      name: loc.name,
      address: loc.address,
      items: items.map(item => ({
        code: item.code || `item-${item.id}`,
        name: item.name_en || item.name,
        nameRu: item.name,
        description: item.description_en || '',
        category: item.category || '',
        tags: parseTags(item.tags),
        calories: item.calories ?? null,
        proteinG: item.protein_g ?? null,
        photoUrl: catalogPhotoPath(item, origin) || null,
        cloverItemId: byItemLoc.get(`${item.id}:${loc.id}`) || item.clover_item_id || null,
        available: !item.stopped
      }))
    }))
  };
}

// Edge cache (Cache API) for the public catalog, keyed by catalog
// version: POST /api/catalog/publish bumps the version, so a freshly
// published catalog is never served stale, while steady-state polls from
// the consumer site cost zero D1 reads (the uncached build re-read the
// whole published menu, bindings and locations on every hit). Looking the
// version up costs two settings rows — the backstop TTL only bounds how
// long an orphaned version entry can linger. Outside Workers (the local
// test server) `caches` is undefined and the cache is skipped entirely.
async function publicCatalog(env, url) {
  let cache = null;
  let cacheKey = null;
  try {
    const { version } = await catalogSettings(env);
    cache = caches.default;
    cacheKey = new Request(`${url.origin}/api/public/catalog?v=${version}`, { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch { cache = null; cacheKey = null; /* the cache is best-effort */ }
  const response = json(await buildPublicCatalog(env, url.origin), 200, { 'cache-control': 'public, max-age=300' });
  if (cache && cacheKey) {
    try { await cache.put(cacheKey, response.clone()); } catch { /* ignore */ }
  }
  return response;
}

/* ---------------- Purchases (documents + lines) ---------------- */

// Stored invoice photos are capped so a single D1 value stays comfortably
// below the parameter size limit; the client downscales to max 1600 px,
// JPEG q~0.72, which lands far under this cap for real invoices.
function normalizePhotoJpeg(value) {
  let text = String(value || '').trim();
  const prefix = /^data:image\/jpe?g;base64,/i.exec(text);
  if (prefix) text = text.slice(prefix[0].length);
  text = text.replace(/\s+/g, '');
  if (!text || text.length > 950000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  return text;
}

function validDocDate(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : nyDateKey(new Date());
}

// Posts one purchase line: ledger row in `purchases` (kept for reports),
// document line with a name/unit snapshot, stock increase, unit-cost refresh.
async function applyPurchaseLine(env, actor, documentId, line) {
  const { ingredient, qty, totalCostCents } = line;
  const result = await run(env, 'INSERT INTO purchases(ingredient_id, qty, total_cost_cents, note, created_by, document_id) VALUES (?, ?, ?, ?, ?, ?)',
    ingredient.id, qty, totalCostCents, line.note || '', actor.id, documentId);
  await run(env, 'INSERT INTO purchase_lines(document_id, ingredient_id, name, unit, qty, total_cost_cents, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    documentId, ingredient.id, ingredient.name, ingredient.unit, qty, totalCostCents, line.note || '');
  await run(env, 'UPDATE ingredients SET stock = stock + ? WHERE id = ?', qty, ingredient.id);
  if (totalCostCents > 0) {
    await run(env, 'UPDATE ingredients SET cost_per_unit_cents = ? WHERE id = ?', Math.round(totalCostCents / qty), ingredient.id);
  }
  return result.meta?.last_row_id;
}

async function createPurchaseDocument(env, actor, { supplier = '', supplierId = null, docDate, note = '', source = 'manual', photoJpeg = null, lines }) {
  const totalCents = lines.reduce((sum, line) => sum + line.totalCostCents, 0);
  // Link the document to a supplier card: an explicit id wins; otherwise a
  // case-insensitive name match. The free-text name stays on the document
  // as the historical snapshot either way.
  let linkedSupplierId = null;
  let supplierName = String(supplier || '').trim();
  if (supplierId) {
    const card = await one(env, 'SELECT * FROM suppliers WHERE id = ?', Number(supplierId));
    if (card) { linkedSupplierId = card.id; if (!supplierName) supplierName = card.name; }
  }
  if (!linkedSupplierId && supplierName) {
    const card = await findSupplierByName(env, supplierName);
    if (card) linkedSupplierId = card.id;
  }
  const result = await run(env, 'INSERT INTO purchase_documents(supplier, doc_date, note, photo_jpeg, total_cents, source, created_by, supplier_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    supplierName, validDocDate(docDate), note, photoJpeg, totalCents, source, actor.id, linkedSupplierId);
  const documentId = result.meta?.last_row_id;
  const lineIds = [];
  for (const line of lines) lineIds.push(await applyPurchaseLine(env, actor, documentId, line));
  return { documentId, totalCents, lineIds };
}

// Shared by POST /api/purchase-documents and the inbound-invoice draft
// confirm: validates amounts, resolves existing ingredients, then creates
// the ingredients the lines asked for inline. Returns { lines } or
// { error } where error is a ready fail() response.
async function preparePurchaseLines(env, rawLines) {
  const prepared = [];
  for (const line of rawLines) {
    const qty = Number(line.qty);
    if (!(qty > 0)) return { error: fail(400, 'В каждой строке укажите количество больше нуля') };
    const totalCostCents = Math.round(Number(line.totalCost || 0) * 100);
    if (!(totalCostCents >= 0)) return { error: fail(400, 'Проверьте суммы строк') };
    let ingredient = null;
    if (line.ingredientId) {
      ingredient = await one(env, 'SELECT * FROM ingredients WHERE id = ?', Number(line.ingredientId));
      if (!ingredient) return { error: fail(404, 'Ингредиент не найден') };
    } else if (!String(line.newIngredient?.name || '').trim()) {
      return { error: fail(400, 'В каждой строке выберите или создайте ингредиент') };
    }
    prepared.push({ ingredient, newIngredient: line.newIngredient, qty, totalCostCents, note: String(line.note || '') });
  }
  for (const line of prepared) {
    if (line.ingredient) continue;
    const created = await run(env, 'INSERT INTO ingredients(name, unit, stock, min_stock, cost_per_unit_cents) VALUES (?, ?, 0, ?, 0)',
      String(line.newIngredient.name).trim(), String(line.newIngredient.unit || 'г'), Number(line.newIngredient.minStock || 0));
    line.ingredient = await one(env, 'SELECT * FROM ingredients WHERE id = ?', created.meta?.last_row_id);
  }
  return { lines: prepared };
}

function invoiceDraftView(row, { withText = false } = {}) {
  let lines = [];
  try { lines = JSON.parse(row.lines_json || '[]'); } catch { lines = []; }
  const view = {
    id: row.id, sender: row.sender || '', subject: row.subject || '',
    supplier: row.supplier || '', docDate: row.doc_date || '', note: row.note || '',
    hasPhoto: Boolean(row.photo_jpeg), attachmentName: row.attachment_name || '',
    attachmentKind: row.attachment_kind || '',
    lines: Array.isArray(lines) ? lines : [],
    total: row.total_cents / 100, totalCents: row.total_cents,
    status: row.status, documentId: row.document_id || null,
    createdAt: row.created_at, resolvedAt: row.resolved_at || null,
    resolvedByName: `${row.r_first_name || ''} ${row.r_last_name || ''}`.trim()
  };
  if (withText) view.rawText = row.raw_text || '';
  return view;
}

function ingredientView(row) {
  return {
    id: row.id, name: row.name, unit: row.unit, stock: row.stock, minStock: row.min_stock,
    costPerUnit: row.cost_per_unit_cents / 100, costPerUnitCents: row.cost_per_unit_cents,
    belowMin: Number(row.stock) <= Number(row.min_stock), active: Boolean(row.active)
  };
}

async function recipeCostCents(env, menuItemId) {
  const rows = await all(env, `SELECT r.qty, i.cost_per_unit_cents FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.menu_item_id = ?`, menuItemId);
  return rows.reduce((sum, r) => sum + r.qty * r.cost_per_unit_cents, 0);
}

/* ---------------- Orders ---------------- */

const ORDER_STATUSES = ['new', 'cooking', 'ready', 'served', 'cancelled'];
const ORDER_NEXT = { new: 'cooking', cooking: 'ready', ready: 'served' };

function orderViewFrom(row, items) {
  return {
    id: row.id, locationId: row.location_id, kind: row.kind, tableNo: row.table_no,
    status: row.status, total: row.total_cents / 100, totalCents: row.total_cents,
    note: row.note || '', createdBy: row.created_by, createdAt: row.created_at, servedAt: row.served_at,
    source: row.source || 'app', cloverOrderId: row.clover_order_id || null,
    tax: row.tax_cents == null ? null : row.tax_cents / 100,
    items: items.map(i => ({ id: i.id, menuItemId: i.menu_item_id, name: i.name, price: i.price_cents / 100, qty: i.qty }))
  };
}

async function orderView(env, row) {
  const items = await all(env, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY id', row.id);
  return orderViewFrom(row, items);
}

// Batch variant for list screens (/api/state, /api/orders): ONE items
// query for the whole page instead of one query per order. The per-order
// queries were the panel's biggest D1 read consumer — up to 100 queries
// per screen load, each scanning order_items until the
// order_items_order_idx index (migration 0011) lands.
async function orderViews(env, rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const items = await all(env, `SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id`, ...ids);
  const byOrder = new Map();
  for (const item of items) {
    if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
    byOrder.get(item.order_id).push(item);
  }
  return rows.map(row => orderViewFrom(row, byOrder.get(row.id) || []));
}

async function createOrder(request, env, actor) {
  const data = await body(request);
  const kind = ['dinein', 'takeaway', 'delivery'].includes(data.kind) ? data.kind : 'dinein';
  const tableNo = kind === 'dinein' ? (Number(data.tableNo) || null) : null;
  if (kind === 'dinein' && (!tableNo || tableNo < 1 || tableNo > 10)) return fail(400, 'Для зала укажите стол 1–10');
  const locationId = data.locationId ? Number(data.locationId) : actor.location_id;
  const lines = Array.isArray(data.items) ? data.items : [];
  if (!lines.length) return fail(400, 'Добавьте хотя бы одну позицию');
  let totalCents = 0;
  const prepared = [];
  for (const line of lines) {
    const item = await one(env, 'SELECT * FROM menu_items WHERE id = ? AND active = 1', Number(line.menuItemId));
    if (!item) return fail(400, 'Позиция меню не найдена');
    if (item.stopped) return fail(400, `«${item.name}» сейчас в стоп-листе`);
    const qty = Math.max(1, Math.min(99, Math.trunc(Number(line.qty) || 1)));
    totalCents += item.price_cents * qty;
    prepared.push({ item, qty });
  }
  const result = await run(env, `INSERT INTO orders(location_id, kind, table_no, total_cents, note, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    locationId, kind, tableNo, totalCents, String(data.note || ''), actor.id);
  const orderId = result.meta?.last_row_id;
  for (const { item, qty } of prepared) {
    await run(env, 'INSERT INTO order_items(order_id, menu_item_id, name, price_cents, qty) VALUES (?, ?, ?, ?, ?)', orderId, item.id, item.name, item.price_cents, qty);
  }
  const order = await one(env, 'SELECT * FROM orders WHERE id = ?', orderId);
  return json({ ok: true, order: await orderView(env, order) }, 201);
}

// Deducts recipe ingredients for every sold line of an order, exactly once:
// the stock_deducted flag makes the write-off idempotent for app orders and
// for Clover imports that get re-synced.
async function deductOrderStock(env, order) {
  if (order.stock_deducted) return false;
  const lines = await all(env, 'SELECT * FROM order_items WHERE order_id = ?', order.id);
  for (const line of lines) {
    if (!line.menu_item_id) continue;
    const recipe = await all(env, 'SELECT * FROM recipes WHERE menu_item_id = ?', line.menu_item_id);
    for (const r of recipe) {
      await run(env, 'UPDATE ingredients SET stock = stock - ? WHERE id = ?', r.qty * line.qty, r.ingredient_id);
    }
  }
  await run(env, 'UPDATE orders SET stock_deducted = 1 WHERE id = ?', order.id);
  return true;
}

async function setOrderStatus(request, env, actor, id) {
  const order = await one(env, 'SELECT * FROM orders WHERE id = ?', id);
  if (!order) return fail(404, 'Заказ не найден');
  const data = await body(request);
  const status = String(data.status || '');
  if (!ORDER_STATUSES.includes(status)) return fail(400, 'Неизвестный статус');
  if (order.status === 'served' || order.status === 'cancelled') return fail(409, 'Заказ уже закрыт');
  if (status !== 'cancelled' && ORDER_NEXT[order.status] !== status) {
    return fail(400, `Из статуса «${order.status}» можно перейти только в «${ORDER_NEXT[order.status]}» или отменить`);
  }
  if (status === 'served') {
    // Issue: deduct recipe ingredients per sold line and stamp served_at —
    // the order total already counts toward revenue via the dashboard query.
    await deductOrderStock(env, order);
    await run(env, 'UPDATE orders SET status = ?, served_at = ? WHERE id = ?', status, nowIso(), order.id);
  } else {
    await run(env, 'UPDATE orders SET status = ? WHERE id = ?', status, order.id);
  }
  const updated = await one(env, 'SELECT * FROM orders WHERE id = ?', order.id);
  return json({ ok: true, order: await orderView(env, updated) });
}

/* ---------------- Clover integration (per location) ---------------- */

function cloverBase(env) {
  return String(env.CLOVER_API_BASE || 'https://api.clover.com').replace(/\/$/, '');
}

function cloverErrorMessage(status, data) {
  const detail = data?.error?.message || data?.message || '';
  if (status === 401) return 'Clover отклонил токен (401) — проверьте API-токен точки: он мог быть отозван или перевыпущен';
  if (status === 403) return 'Clover: у токена не хватает прав (403) — перевыпустите токен с доступом к заказам и инвентарю';
  if (status === 404) return 'Clover: мерчант не найден (404) — проверьте Merchant ID точки';
  if (status === 429) return 'Clover: слишком много запросов (429) — подождите минуту и попробуйте снова';
  return `Clover вернул ошибку ${status}${detail ? `: ${detail}` : ''}`;
}

async function cloverFetch(env, merchantId, token, path, { method = 'GET', payload } = {}) {
  let response;
  try {
    response = await fetch(`${cloverBase(env)}/v3/merchants/${encodeURIComponent(merchantId)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new Error('Clover не отвечает — проверьте соединение и попробуйте позже');
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(cloverErrorMessage(response.status, data));
    error.status = response.status;
    throw error;
  }
  return data;
}

// Effective credentials for a location: its own Merchant ID + token win;
// the legacy global settings act as a fallback so nothing already stored
// by the owner is lost.
async function cloverCredsFor(env, location) {
  const mid = String(location.clover_merchant_id || '').trim();
  const token = String(location.clover_token || '').trim();
  if (mid && token) return { merchantId: mid, token, own: true };
  const globalMid = String(await getSetting(env, 'cloverMerchantId')).trim();
  const globalToken = String(await getSetting(env, 'cloverToken')).trim();
  if (globalMid && globalToken) return { merchantId: globalMid, token: globalToken, own: false };
  return null;
}

// Owner-facing connection state. NEVER includes the token value.
async function cloverLocationStatus(env, location) {
  const creds = await cloverCredsFor(env, location);
  return {
    locationId: location.id,
    name: location.name,
    merchantId: location.clover_merchant_id || '',
    hasToken: Boolean(location.clover_token),
    hasCreds: Boolean(creds),
    usingGlobal: Boolean(creds && !creds.own),
    merchantName: location.clover_merchant_name || '',
    connected: Boolean(creds && location.clover_merchant_name),
    lastSyncAt: location.clover_last_sync_at || null,
    lastError: location.clover_last_error || ''
  };
}

function cloverOrderPaid(co) {
  if (co.paymentState === 'PAID') return true;
  const payments = co.payments?.elements || [];
  return payments.some(p => !p.result || String(p.result).toUpperCase() === 'SUCCESS');
}

function cloverOrderKind(co) {
  const label = String(co.orderType?.label || co.orderType?.name || '').toLowerCase();
  if (label.includes('deliver')) return 'delivery';
  if (label.includes('pickup') || label.includes('take') || label.includes('to go')) return 'takeaway';
  return 'dinein';
}

// Sales tax actually collected on a Clover order, in cents — or null when
// the payload carries no tax figure ("unknown", never invented). Primary
// source: payments (the sync expands them); a payment's taxAmount is the
// tax settled on that payment. Fallback: per-line tax rates.
function cloverOrderTaxCents(co) {
  const payments = co.payments?.elements || [];
  let sum = 0;
  let seen = false;
  for (const p of payments) {
    if (p.taxAmount != null && Number.isFinite(Number(p.taxAmount))) { sum += Number(p.taxAmount); seen = true; }
  }
  if (seen) return Math.max(0, Math.round(sum));
  let lineSum = 0;
  let lineSeen = false;
  for (const li of co.lineItems?.elements || []) {
    const rates = li.taxRates?.elements || [];
    for (const tr of rates) {
      if (tr.taxAmount != null && Number.isFinite(Number(tr.taxAmount))) { lineSum += Number(tr.taxAmount); lineSeen = true; }
    }
  }
  if (lineSeen) return Math.max(0, Math.round(lineSum));
  return null;
}

function cloverLineQty(li) {
  if (li.quantity != null) return Math.max(1, Math.round(Number(li.quantity) || 1));
  if (li.unitQty != null) return Math.max(1, Math.round(Number(li.unitQty) / 1000) || 1);
  return 1;
}

// Menu lookup index for one sync run: built once per location so line
// mapping costs zero extra D1 queries (the per-line SELECTs were what
// blew the per-invocation subrequest limit during backfill).
async function buildMenuIndex(env) {
  const items = await all(env, 'SELECT id, name, name_en, clover_item_id FROM menu_items WHERE active = 1');
  const byCloverId = new Map();
  const byName = new Map();
  for (const m of items) {
    if (m.clover_item_id) byCloverId.set(String(m.clover_item_id), m);
    // Name matching runs in JS on purpose: SQLite lower() folds only ASCII,
    // so a SQL-side compare would silently miss Cyrillic dish names.
    for (const key of [m.name, m.name_en]) {
      const k = String(key || '').trim().toLowerCase();
      if (k && !byName.has(k)) byName.set(k, m);
    }
  }
  return { byCloverId, byName };
}

function mapCloverLineItem(menuIndex, li) {
  const cloverItemId = li.item?.id || null;
  if (cloverItemId && menuIndex.byCloverId.has(String(cloverItemId))) {
    return menuIndex.byCloverId.get(String(cloverItemId));
  }
  const name = String(li.name || '').trim().toLowerCase();
  if (name && menuIndex.byName.has(name)) return menuIndex.byName.get(name);
  return null;
}

// Upserts one paid Clover order. Revenue always lands (total from Clover);
// stock is deducted only for lines mapped to a dish, via the same
// idempotent write-off app orders use — re-syncs never double-deduct.
async function importCloverOrder(env, location, co, menuIndex) {
  if (!co.id || !cloverOrderPaid(co)) return 'skipped';
  const totalCents = Math.max(0, Math.round(Number(co.total || 0)));
  const createdIso = co.createdTime ? new Date(Number(co.createdTime)).toISOString() : nowIso();
  const existing = await one(env, 'SELECT * FROM orders WHERE clover_order_id = ?', co.id);
  let orderId;
  let created = false;
  const taxCents = cloverOrderTaxCents(co);
  if (!existing) {
    const note = co.title ? `Clover: ${String(co.title).slice(0, 120)}` : 'Clover';
    const result = await run(env, `INSERT INTO orders(location_id, kind, table_no, status, total_cents, note, source, clover_order_id, created_at, served_at, tax_cents)
      VALUES (?, ?, ?, 'served', ?, ?, 'clover', ?, ?, ?, ?)`,
      location.id, cloverOrderKind(co), null, totalCents, note, co.id, createdIso, createdIso, taxCents);
    orderId = result.meta?.last_row_id;
    created = true;
  } else {
    orderId = existing.id;
    // A re-sync refreshes the total and fills the tax when this payload
    // carries it; a payload without a tax figure never erases a known one.
    await run(env, 'UPDATE orders SET total_cents = ?, tax_cents = COALESCE(?, tax_cents) WHERE id = ?', totalCents, taxCents, orderId);
  }
  const alreadyDeducted = existing ? Boolean(existing.stock_deducted) : false;
  if (!alreadyDeducted) {
    // Lines and the stock write-off go through D1 batch(): one subrequest
    // per batch instead of one query per line / per recipe row — the old
    // per-row chatter exceeded the per-invocation subrequest limit and
    // killed cron runs mid-location (tail 2026-10-26: "Too many API
    // requests by single Worker invocation").
    const lines = (co.lineItems?.elements || []).map(li => {
      const mapped = mapCloverLineItem(menuIndex, li);
      return {
        menuItemId: mapped?.id || null,
        name: String(li.name || mapped?.name || 'Позиция Clover'),
        priceCents: Math.max(0, Math.round(Number(li.price || 0))),
        qty: cloverLineQty(li),
        cloverLineId: li.id || null
      };
    });
    const statements = [env.DB.prepare('DELETE FROM order_items WHERE order_id = ?').bind(orderId)];
    for (const line of lines) {
      statements.push(env.DB.prepare('INSERT INTO order_items(order_id, menu_item_id, name, price_cents, qty, clover_line_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(orderId, line.menuItemId, line.name, line.priceCents, line.qty, line.cloverLineId));
    }
    await env.DB.batch(statements);
    // Same write-off semantics as deductOrderStock (idempotent via the
    // stock_deducted flag), batched: one recipe lookup for all mapped
    // lines, one batch for every ingredient update + the flag.
    const mappedIds = [...new Set(lines.filter(l => l.menuItemId).map(l => l.menuItemId))];
    const deductStatements = [];
    if (mappedIds.length) {
      const placeholders = mappedIds.map(() => '?').join(',');
      const recipes = await all(env, `SELECT * FROM recipes WHERE menu_item_id IN (${placeholders})`, ...mappedIds);
      const recipeByItem = new Map();
      for (const r of recipes) {
        if (!recipeByItem.has(r.menu_item_id)) recipeByItem.set(r.menu_item_id, []);
        recipeByItem.get(r.menu_item_id).push(r);
      }
      for (const line of lines) {
        if (!line.menuItemId) continue;
        for (const r of recipeByItem.get(line.menuItemId) || []) {
          deductStatements.push(env.DB.prepare('UPDATE ingredients SET stock = stock - ? WHERE id = ?')
            .bind(r.qty * line.qty, r.ingredient_id));
        }
      }
    }
    deductStatements.push(env.DB.prepare('UPDATE orders SET stock_deducted = 1 WHERE id = ?').bind(orderId));
    await env.DB.batch(deductStatements);
  }
  return created ? 'created' : 'updated';
}

async function syncCloverLocation(env, location, creds, budget = null, menuIndex = null) {
  // The menu index does not depend on the location: runScheduled builds it
  // once per tick and shares it across locations instead of re-reading the
  // whole menu per location (manual single-location syncs build their own).
  if (!menuIndex) menuIndex = await buildMenuIndex(env);
  const watermark = Number(location.clover_sync_watermark || 0);
  const since = watermark > 0 ? watermark : Date.now() - 7 * 86400000;
  let offset = 0;
  const limit = 50;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let maxModified = since;
  let minModified = Infinity;
  // Cap pages per run and persist progress after every page: the initial
  // 7-day backfill is hundreds of orders per location, and a cron run that
  // dies mid-backfill must resume instead of restarting the window (which
  // starved later locations — Fort Lauderdale never got reached). The
  // shared `budget` (orders per invocation, set by runScheduled) keeps the
  // whole run under the Workers subrequest limit; every location still
  // gets at least one page per tick.
  const MAX_PAGES = 2;
  let page = 0;
  for (;;) {
    const filter = encodeURIComponent(`modifiedTime>=${since}`);
    const data = await cloverFetch(env, creds.merchantId, creds.token,
      `/orders?filter=${filter}&expand=lineItems,payments&limit=${limit}&offset=${offset}`);
    const elements = Array.isArray(data.elements) ? data.elements : [];
    for (const co of elements) {
      const outcome = await importCloverOrder(env, location, co, menuIndex);
      if (outcome === 'created') imported += 1;
      else if (outcome === 'updated') updated += 1;
      else skipped += 1;
      if (budget) budget.remaining -= 1;
      const modified = Number(co.modifiedTime || co.createdTime || 0);
      if (modified > maxModified) maxModified = modified;
      if (modified > 0 && modified < minModified) minModified = modified;
    }
    page += 1;
    const done = elements.length < limit;
    // Completed pass -> jump to the newest seen; partial pass -> resume
    // from the oldest seen (re-import is idempotent, so overlap is safe
    // under either Clover page ordering).
    const resumeWm = minModified === Infinity ? since : minModified;
    await run(env, 'UPDATE locations SET clover_sync_watermark = ?, clover_last_sync_at = ?, clover_last_error = ? WHERE id = ?',
      String(done ? maxModified : resumeWm), nowIso(), '', location.id);
    if (done || page >= MAX_PAGES) break;
    if (budget && budget.remaining <= 0) break;
    offset += limit;
  }
  return { imported, updated, skipped };
}

async function syncCloverLocationGuarded(env, location, budget = null, menuIndex = null) {
  const creds = await cloverCredsFor(env, location);
  if (!creds) return { locationId: location.id, skipped: true, reason: 'not-connected' };
  try {
    return { locationId: location.id, ...(await syncCloverLocation(env, location, creds, budget, menuIndex)) };
  } catch (error) {
    // The error write itself must never throw: when the original failure
    // IS the subrequest limit, this UPDATE is exactly what used to kill
    // the whole cron run (tail 2026-10-26).
    try {
      await run(env, 'UPDATE locations SET clover_last_error = ? WHERE id = ?', error.message, location.id);
    } catch { /* keep the original error; the run must go on */ }
    // Surface the failure to the owner via the ops-alert channel
    // (@ShawaTeambot publishes pending rows); deduped to 1/hour per
    // location + failure text inside recordOpsAlert.
    await recordSyncErrorAlert(env, location, error);
    return { locationId: location.id, error: error.message };
  }
}

// Pushes the app menu to one Clover merchant: new items are created and the
// mapping stored, known items are updated, stopped dishes are made
// unavailable/hidden in Clover.
async function publishMenuToClover(env, location, creds) {
  const items = await all(env, 'SELECT id, name, name_en, price_cents, stopped, clover_item_id FROM menu_items WHERE active = 1 ORDER BY sort_order, id');
  let created = 0;
  let updated = 0;
  const errors = [];
  for (const item of items) {
    const payload = {
      name: item.name_en || item.name,
      price: item.price_cents,
      priceType: 'FIXED',
      available: !item.stopped,
      hidden: Boolean(item.stopped)
    };
    try {
      if (item.clover_item_id) {
        await cloverFetch(env, creds.merchantId, creds.token, `/items/${encodeURIComponent(item.clover_item_id)}`, { method: 'POST', payload });
        updated += 1;
      } else {
        const createdItem = await cloverFetch(env, creds.merchantId, creds.token, '/items', { method: 'POST', payload });
        if (createdItem.id) await run(env, 'UPDATE menu_items SET clover_item_id = ? WHERE id = ?', createdItem.id, item.id);
        created += 1;
      }
    } catch (error) {
      errors.push({ item: item.name, error: error.message });
    }
  }
  return { created, updated, errors };
}

/* ---------------- Finance: PnL, DR-15, suppliers, expenses ----------------
   Money view of the network, built only from data the panel already owns:
   revenue + collected tax from synced Clover/panel orders, food cost from
   recipe write-offs valued at purchase prices, labor from the panel
   timesheet (punches × owner-set rates), operating expenses entered by
   hand. Coverage is reported honestly: a dish without a recipe or an
   ingredient without a purchase price never silently counts as $0 cost —
   the endpoints return how much of the revenue is actually covered.
   Labor money follows the house rule: rates and pay are owner-only, so
   laborCost / EBITDA are present only in the owner's payload. */

export const EXPENSE_CATEGORIES = ['rent', 'utilities', 'aggregator', 'processing', 'marketing', 'repairs', 'supplies', 'other'];

const round2 = (value) => Math.round(value * 100) / 100;
const pct1 = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

// Period from ?from=YYYY-MM-DD&to=YYYY-MM-DD (NY calendar dates, `to`
// inclusive). Default: the current NY month up to today.
function financePeriod(searchParams) {
  const parts = nyParts(new Date());
  const monthStart = `${parts.year}-${String(parts.month).padStart(2, '0')}-01`;
  const today = nyDateKey(new Date());
  const valid = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : fallback);
  const fromKey = valid(searchParams.get('from'), monthStart);
  const toKey = valid(searchParams.get('to'), today);
  const [fy, fm, fd] = fromKey.split('-').map(Number);
  const [ty, tm, td] = toKey.split('-').map(Number);
  return {
    fromKey, toKey,
    fromIso: zonedTimeToUtc(fy, fm, fd).toISOString(),
    toIso: zonedTimeToUtc(ty, tm, td + 1).toISOString()
  };
}

// Recipe valuation snapshot: per dish — recipe cost at current purchase
// prices and whether every recipe ingredient carries a price at all.
async function recipeCostIndex(env) {
  const rows = await all(env, `SELECT r.menu_item_id, r.qty, i.cost_per_unit_cents
    FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id`);
  const index = new Map();
  for (const r of rows) {
    if (!index.has(r.menu_item_id)) index.set(r.menu_item_id, { costCents: 0, fullyPriced: true });
    const entry = index.get(r.menu_item_id);
    entry.costCents += r.qty * r.cost_per_unit_cents;
    if (!(r.cost_per_unit_cents > 0)) entry.fullyPriced = false;
  }
  return index;
}

async function buildPnl(env, actor, searchParams) {
  const ownerView = actor.rank === 'owner';
  const period = financePeriod(searchParams);
  const { fromIso, toIso } = period;
  const locationRows = await locations(env, true);
  const blank = () => ({
    orders: 0, grossCents: 0, taxCents: 0, taxKnownOrders: 0,
    linesRevenueCents: 0, mappedRevenueCents: 0, pricedRevenueCents: 0, foodCostCents: 0,
    laborHours: 0, laborRatedHours: 0, laborCostCents: 0,
    opexCents: 0, opexByCategory: {}
  });
  const byLocation = new Map(locationRows.map(l => [l.id, blank()]));
  const network = blank(); // location_id NULL buckets (orders/punches/expenses without a point)
  const bucketFor = (locationId) => {
    if (locationId == null) return network;
    if (!byLocation.has(locationId)) byLocation.set(locationId, blank());
    return byLocation.get(locationId);
  };

  const orderRows = await all(env, `SELECT id, location_id, total_cents, tax_cents FROM orders
    WHERE status = 'served' AND served_at >= ? AND served_at < ?`, fromIso, toIso);
  const orderLocation = new Map();
  for (const o of orderRows) {
    orderLocation.set(o.id, o.location_id);
    const b = bucketFor(o.location_id);
    b.orders += 1;
    b.grossCents += o.total_cents || 0;
    if (o.tax_cents != null) { b.taxCents += o.tax_cents; b.taxKnownOrders += 1; }
  }
  if (orderRows.length) {
    const recipeIndex = await recipeCostIndex(env);
    const lineRows = await all(env, `SELECT oi.order_id, oi.menu_item_id, oi.price_cents, oi.qty
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'served' AND o.served_at >= ? AND o.served_at < ?`, fromIso, toIso);
    for (const line of lineRows) {
      const b = bucketFor(orderLocation.get(line.order_id));
      const lineRevenue = (line.price_cents || 0) * (line.qty || 0);
      b.linesRevenueCents += lineRevenue;
      const recipe = line.menu_item_id ? recipeIndex.get(line.menu_item_id) : null;
      if (recipe) {
        b.mappedRevenueCents += lineRevenue;
        b.foodCostCents += recipe.costCents * (line.qty || 0);
        if (recipe.fullyPriced) b.pricedRevenueCents += lineRevenue;
      }
    }
  }

  const punchRows = await all(env, `SELECT p.clock_in, p.clock_out, p.location_id,
      e.hourly_rate_cents, e.location_id AS employee_location_id
    FROM punches p JOIN employees e ON e.id = p.employee_id
    WHERE p.clock_in >= ? AND p.clock_in < ?`, fromIso, toIso);
  const capEnd = new Date(Math.min(Date.now(), new Date(toIso).getTime()));
  for (const p of punchRows) {
    const start = new Date(p.clock_in);
    const end = p.clock_out ? new Date(p.clock_out) : capEnd;
    const hours = Math.max(0, (end - start) / 3600000);
    if (!(hours > 0)) continue;
    const b = bucketFor(p.location_id ?? p.employee_location_id);
    b.laborHours = round2(b.laborHours + hours);
    if (p.hourly_rate_cents != null) {
      b.laborRatedHours = round2(b.laborRatedHours + hours);
      b.laborCostCents += hours * p.hourly_rate_cents;
    }
  }

  const expenseRows = await all(env, `SELECT location_id, category, SUM(amount_cents) AS cents FROM expense_entries
    WHERE expense_date >= ? AND expense_date <= ? GROUP BY location_id, category`, period.fromKey, period.toKey);
  for (const r of expenseRows) {
    const b = bucketFor(r.location_id);
    b.opexCents += Number(r.cents || 0);
    b.opexByCategory[r.category] = (b.opexByCategory[r.category] || 0) + Number(r.cents || 0);
  }

  const view = (locationId, name, b) => {
    const netCents = b.grossCents - b.taxCents;
    const result = {
      locationId, name,
      orders: b.orders,
      gross: round2(b.grossCents / 100),
      taxCollected: round2(b.taxCents / 100),
      taxCoveragePct: b.orders ? pct1(b.taxKnownOrders, b.orders) : 0,
      netRevenue: round2(netCents / 100),
      foodCost: round2(b.foodCostCents / 100),
      foodCostPct: netCents > 0 ? pct1(b.foodCostCents, netCents) : 0,
      coverage: {
        mappedPct: pct1(b.mappedRevenueCents, b.linesRevenueCents),
        pricedPct: pct1(b.pricedRevenueCents, b.linesRevenueCents)
      },
      laborHours: round2(b.laborHours),
      laborCoveragePct: pct1(b.laborRatedHours, b.laborHours),
      opex: round2(b.opexCents / 100),
      opexByCategory: Object.fromEntries(Object.entries(b.opexByCategory).map(([k, v]) => [k, round2(v / 100)]))
    };
    // Rates are owner-only: without them EBITDA would be fiction, so both
    // stay out of non-owner payloads (same rule as the timesheet).
    if (ownerView) {
      result.laborCost = round2(b.laborCostCents / 100);
      result.ebitda = round2((netCents - b.foodCostCents - b.laborCostCents - b.opexCents) / 100);
      result.ebitdaPct = netCents > 0 ? pct1(netCents - b.foodCostCents - b.laborCostCents - b.opexCents, netCents) : 0;
    }
    return result;
  };

  const rows = locationRows.filter(l => l.active || byLocation.get(l.id)?.orders).map(l => view(l.id, l.name, byLocation.get(l.id)));
  if (network.orders || network.opexCents || network.laborHours) rows.push(view(null, 'Сеть / без точки', network));
  const total = blank();
  for (const b of [...byLocation.values(), network]) {
    total.orders += b.orders; total.grossCents += b.grossCents; total.taxCents += b.taxCents;
    total.taxKnownOrders += b.taxKnownOrders; total.linesRevenueCents += b.linesRevenueCents;
    total.mappedRevenueCents += b.mappedRevenueCents; total.pricedRevenueCents += b.pricedRevenueCents;
    total.foodCostCents += b.foodCostCents; total.laborHours += b.laborHours;
    total.laborRatedHours += b.laborRatedHours; total.laborCostCents += b.laborCostCents;
    total.opexCents += b.opexCents;
    for (const [k, v] of Object.entries(b.opexByCategory)) total.opexByCategory[k] = (total.opexByCategory[k] || 0) + v;
  }
  return { period: { from: period.fromKey, to: period.toKey }, ownerView, locations: rows, total: view(0, 'Итого', total) };
}

// DR-15 (Florida sales tax) summary for one month: the exact lines the
// owner/accountant types into floridarevenue.com. Gross is what Clover
// collected (tax included); taxable = gross − tax collected; the tax line
// counts only orders whose collected tax the sync actually captured —
// coverage says how much of the month that is.
async function buildDr15(env, searchParams) {
  const parts = nyParts(new Date());
  const monthParam = searchParams.get('month');
  const match = /^(\d{4})-(\d{2})$/.exec(monthParam || '');
  const year = match ? Number(match[1]) : parts.year;
  const month = match ? Number(match[2]) : parts.month;
  const fromIso = zonedTimeToUtc(year, month, 1).toISOString();
  const toIso = zonedTimeToUtc(year, month + 1, 1).toISOString();
  const dueYear = month === 12 ? year + 1 : year;
  const dueMonth = month === 12 ? 1 : month + 1;
  const dueDate = `${dueYear}-${String(dueMonth).padStart(2, '0')}-20`;
  const locationRows = await locations(env, true);
  const rows = [];
  const totals = { locationId: 0, name: 'Итого', orders: 0, cloverOrders: 0, grossCents: 0, taxCents: 0, taxKnownOrders: 0 };
  for (const loc of locationRows) {
    const agg = await one(env, `SELECT COUNT(*) AS orders,
        SUM(CASE WHEN source = 'clover' THEN 1 ELSE 0 END) AS clover_orders,
        COALESCE(SUM(total_cents), 0) AS gross_cents,
        COALESCE(SUM(tax_cents), 0) AS tax_cents,
        SUM(CASE WHEN tax_cents IS NOT NULL THEN 1 ELSE 0 END) AS tax_known
      FROM orders WHERE status = 'served' AND location_id = ? AND served_at >= ? AND served_at < ?`,
      loc.id, fromIso, toIso);
    const entry = {
      locationId: loc.id, name: loc.name,
      orders: Number(agg?.orders || 0), cloverOrders: Number(agg?.clover_orders || 0),
      grossCents: Number(agg?.gross_cents || 0), taxCents: Number(agg?.tax_cents || 0),
      taxKnownOrders: Number(agg?.tax_known || 0)
    };
    rows.push(entry);
    totals.orders += entry.orders; totals.cloverOrders += entry.cloverOrders;
    totals.grossCents += entry.grossCents; totals.taxCents += entry.taxCents;
    totals.taxKnownOrders += entry.taxKnownOrders;
  }
  const view = (e) => ({
    locationId: e.locationId, name: e.name, orders: e.orders, cloverOrders: e.cloverOrders,
    grossSales: round2(e.grossCents / 100),
    taxCollected: round2(e.taxCents / 100),
    taxableSales: round2((e.grossCents - e.taxCents) / 100),
    taxCoveragePct: e.orders ? pct1(e.taxKnownOrders, e.orders) : 0,
    // Collection allowance: 2.5% of the first $1,200 of tax, max $30 per
    // location per month, kept when filing electronically on time.
    allowance: round2(Math.min(e.taxCents, 120000) * 0.025 / 100)
  });
  return {
    month: `${year}-${String(month).padStart(2, '0')}`,
    dueDate,
    locations: rows.map(view),
    total: view(totals)
  };
}

/* Suppliers registry: invoiced (purchase documents) − paid (manual payment
   marks) = open balance. The panel never moves money; a payment row is the
   owner's mark that the bank payment happened. */
// Supplier names are matched case-insensitively in JS on purpose: SQLite
// lower() only folds ASCII, and supplier names here are often Cyrillic.
async function findSupplierByName(env, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const rows = await all(env, 'SELECT * FROM suppliers');
  return rows.find(row => String(row.name || '').trim().toLowerCase() === key) || null;
}

async function supplierAggregates(env, supplierId) {
  const docs = await all(env, `SELECT id, doc_date, total_cents FROM purchase_documents
    WHERE supplier_id = ? ORDER BY doc_date ASC, id ASC`, supplierId);
  const paid = await one(env, 'SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM supplier_payments WHERE supplier_id = ?', supplierId);
  const invoicedCents = docs.reduce((sum, d) => sum + (d.total_cents || 0), 0);
  const paidCents = Number(paid?.cents || 0);
  // FIFO: payments cover the oldest invoices first; the first invoice not
  // fully covered is the oldest open one.
  let remaining = paidCents;
  let oldestOpenDate = null;
  for (const d of docs) {
    if (remaining >= (d.total_cents || 0)) { remaining -= (d.total_cents || 0); continue; }
    oldestOpenDate = d.doc_date || null;
    break;
  }
  if (invoicedCents - paidCents <= 0) oldestOpenDate = null;
  return {
    docsCount: docs.length, invoicedCents, paidCents,
    balanceCents: invoicedCents - paidCents,
    lastDocDate: docs.length ? docs[docs.length - 1].doc_date : null,
    oldestOpenDate
  };
}

function supplierView(row, agg) {
  return {
    id: row.id, name: row.name, contactName: row.contact_name || '', phone: row.phone || '',
    email: row.email || '', note: row.note || '', active: Boolean(row.active),
    docsCount: agg.docsCount, invoiced: round2(agg.invoicedCents / 100),
    paid: round2(agg.paidCents / 100), balance: round2(agg.balanceCents / 100),
    lastDocDate: agg.lastDocDate, oldestOpenDate: agg.oldestOpenDate
  };
}

async function listSuppliers(env) {
  const rows = await all(env, 'SELECT * FROM suppliers ORDER BY active DESC, name');
  const out = [];
  for (const row of rows) out.push(supplierView(row, await supplierAggregates(env, row.id)));
  return out;
}

/* ---------------- Dashboard & state ---------------- */

async function buildDashboard(env, actor) {
  const todayStart = startOfNyDay(new Date());
  const weekStart = addUtcDays(todayStart, -6);
  const todayIso = todayStart.toISOString();
  const weekIso = weekStart.toISOString();
  const revenueToday = await one(env, `SELECT COALESCE(SUM(total_cents),0) AS cents, COUNT(*) AS orders FROM orders WHERE status = 'served' AND served_at >= ?`, todayIso);
  const revenueWeek = await one(env, `SELECT COALESCE(SUM(total_cents),0) AS cents, COUNT(*) AS orders FROM orders WHERE status = 'served' AND served_at >= ?`, weekIso);
  const openOrders = await all(env, `SELECT location_id, COUNT(*) AS n FROM orders WHERE status IN ('new','cooking','ready') GROUP BY location_id`);
  const lowStockRows = await all(env, 'SELECT * FROM ingredients WHERE active = 1 AND stock <= min_stock ORDER BY name');
  const onShiftRows = await all(env, `SELECT p.*, e.first_name, e.last_name FROM punches p JOIN employees e ON e.id = p.employee_id WHERE p.clock_out IS NULL ORDER BY p.clock_in`);
  const locationRows = await locations(env);
  const dash = {
    revenueToday: Number(revenueToday?.cents || 0) / 100,
    revenueTodayOrders: Number(revenueToday?.orders || 0),
    revenueWeek: Number(revenueWeek?.cents || 0) / 100,
    revenueWeekOrders: Number(revenueWeek?.orders || 0),
    openOrdersByLocation: locationRows.map(l => ({ locationId: l.id, name: l.name, open: Number(openOrders.find(o => o.location_id === l.id)?.n || 0) })),
    lowStock: lowStockRows.map(ingredientView),
    onShift: onShiftRows.map(p => ({ punchId: p.id, employeeId: p.employee_id, name: `${p.first_name} ${p.last_name}`.trim(), locationId: p.location_id, clockIn: p.clock_in }))
  };
  return dash;
}

async function buildState(env, actor) {
  const companyName = await getSetting(env, 'companyName');
  const locationRows = await locations(env, true);
  const employees = await visibleEmployees(env, actor);
  const punches = await visiblePunches(env, actor);
  const menu = await menuWithRecipes(env);
  const ingredientRows = await all(env, 'SELECT * FROM ingredients WHERE active = 1 ORDER BY name');
  const orderRows = await all(env, `SELECT * FROM orders WHERE status IN ('new','cooking','ready')
    OR (source = 'clover' AND status = 'served' AND served_at >= ?) ORDER BY created_at DESC LIMIT 100`, startOfNyDay(new Date()).toISOString());
  const orders = await orderViews(env, orderRows);
  const state = {
    ok: true,
    me: publicEmployee(actor, actor),
    companyName,
    locations: locationRows.filter(l => l.active),
    allLocations: locationRows,
    employees,
    punches,
    menu,
    ingredients: ingredientRows.map(ingredientView),
    orders,
    dashboard: await buildDashboard(env, actor),
    serverTime: nowIso(),
    timeZone: TIME_ZONE
  };
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) {
    const rows = await all(env, 'SELECT * FROM invites ORDER BY created_at DESC');
    state.invites = rows.filter(r => actor.rank === 'owner' || RANK_LEVEL[r.rank] <= RANK_LEVEL[actor.rank] || r.created_by === actor.id).map(r => inviteView(r, state.locations));
  }
  state.catalog = await catalogSettings(env);
  if (actor.rank === 'owner') {
    const cloverLocations = [];
    const rawLocations = await all(env, 'SELECT * FROM locations ORDER BY sort_order, id');
    for (const loc of rawLocations) cloverLocations.push(await cloverLocationStatus(env, loc));
    state.clover = {
      merchantId: await getSetting(env, 'cloverMerchantId'),
      hasToken: Boolean(await getSetting(env, 'cloverToken')),
      connected: false,
      locations: cloverLocations
    };
  }
  return state;
}

export async function runScheduled(env, event = {}) {
  // Cron (every 15 min): pull Clover sales for every connected location.
  const rows = await all(env, 'SELECT * FROM locations WHERE active = 1');
  // One order budget per invocation: ~6 D1 subrequests per imported order,
  // 140 orders ≈ 850 subrequests — safely under the 1000/invocation cap
  // that killed earlier runs ("Too many API requests by single Worker
  // invocation", tail 2026-10-26). Later locations still get their first
  // page; the remainder resumes next tick from the saved watermark.
  const budget = { remaining: 140 };
  const menuIndex = rows.length ? await buildMenuIndex(env) : null;
  const synced = [];
  for (const location of rows) synced.push(await syncCloverLocationGuarded(env, location, budget, menuIndex));
  // Debug heartbeat (2026-10-26): the per-location sync summary is otherwise
  // invisible — last_sync_at/watermark stayed empty while orders imported.
  try { await setSetting(env, 'cloverCronDebug', JSON.stringify({ at: nowIso(), synced })); } catch { /* never break the cron on debug */ }
  // Temperature control: alert on equipment with no reading for over
  // 6 hours (NY 08:00-23:00 only, anti-spam 1 per 6h per unit). This
  // check must never break the cron.
  let tempMissing = null;
  try { tempMissing = await checkMissingTemperatures(env); } catch { tempMissing = null; }
  return { ok: true, synced, tempMissing };
}

/* ---------------- Disputes (adjustments & chargebacks) ----------------
   Registry for the four channels of Adam's IT task #3 (design:
   goals/shawa-ceo/files/it-tasks-2026-10-26/disputes-workflow.md). The
   panel prepares everything up to the Submit click — deadlines, an
   evidence package from the synced panel/Clover order and a ready dispute
   text. Filing is manual in every channel: no public dispute API exists. */

const DISPUTE_CHANNELS = {
  uber: { label: 'Uber Eats', kind: 'adjustment', windowDays: 30, portalUrl: 'https://merchants.ubereats.com/manager/orders', portalName: 'Uber Eats Manager → Orders → Dispute' },
  doordash: { label: 'DoorDash', kind: 'adjustment', windowDays: 10, targetDays: 7, portalUrl: 'https://www.doordash.com/merchant/', portalName: 'DoorDash Merchant Portal → Financials → Transactions → Error charge → Dispute Charge' },
  grubhub: { label: 'Grubhub', kind: 'adjustment', windowDays: 30, portalUrl: 'https://restaurant.grubhub.com/', portalName: 'Grubhub for Merchants → Financials → Prepaid Order Adjustment → Dispute Adjustment', email: 'restaurants@grubhub.com' },
  clover: { label: 'Clover / Fiserv', kind: 'chargeback', windowDays: null, slaDays: 3, portalUrl: '', portalName: 'Портал эквайрера (Fiserv ClientLine / Dispute Manager у Conectados) — ответ по уведомлению' }
};
const DISPUTE_STATUSES = ['new', 'evidence_ready', 'submitted', 'won', 'lost', 'expired', 'skipped'];
const DISPUTE_TERMINAL = ['won', 'lost', 'expired', 'skipped'];
const DISPUTE_STATUS_LABEL = {
  new: 'Новый', evidence_ready: 'Пакет готов', submitted: 'Подан',
  won: 'Выигран', lost: 'Проигран', expired: 'Просрочен', skipped: 'Не спорим'
};

function validDateKey(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const d = new Date(`${text}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : text;
}
function addDaysToKey(key, days) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysUntilKey(key, todayKey = nyDateKey(new Date())) {
  if (!key) return null;
  const a = new Date(`${todayKey}T12:00:00Z`).getTime();
  const b = new Date(`${key}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

// Deadline of record: the channel window counted from the order date
// (Uber/Grubhub 30d, DoorDash 10d hard with a 7d internal target). For
// Clover chargebacks the only valid deadline is the date printed in the
// acquirer notice — it is required input and stored verbatim.
function disputeDeadline(channel, orderDate, givenDeadline) {
  const given = validDateKey(givenDeadline);
  if (channel === 'clover') {
    return given ? { deadlineAt: given, source: 'notice' } : { error: 'Для chargeback укажите дату дедлайна из уведомления эквайрера' };
  }
  const meta = DISPUTE_CHANNELS[channel];
  if (!meta) return { error: 'Неизвестный канал спора' };
  if (given) return { deadlineAt: given, source: 'notice' };
  if (!orderDate) return { error: 'Укажите дату заказа — от неё считается дедлайн канала' };
  return { deadlineAt: addDaysToKey(orderDate, meta.windowDays), source: 'rule' };
}

function disputeView(row, locationRows, employeeRows) {
  const meta = DISPUTE_CHANNELS[row.channel] || {};
  const location = (locationRows || []).find(l => l.id === row.location_id);
  const creator = (employeeRows || []).find(e => e.id === row.created_by);
  const submitter = (employeeRows || []).find(e => e.id === row.submitted_by);
  const terminal = DISPUTE_TERMINAL.includes(row.status);
  const daysLeft = terminal ? null : daysUntilKey(row.deadline_at);
  let evidence = {};
  try { evidence = JSON.parse(row.evidence_json || '{}'); } catch { evidence = {}; }
  return {
    id: row.id, channel: row.channel, channelLabel: meta.label || row.channel,
    kind: row.kind, kindLabel: row.kind === 'chargeback' ? 'Chargeback' : 'Adjustment',
    locationId: row.location_id, locationName: location?.name || '',
    panelOrderId: row.panel_order_id, cloverOrderId: row.clover_order_id || '',
    channelOrderId: row.channel_order_id || '',
    amount: row.amount_cents / 100, amountCents: row.amount_cents,
    fee: row.fee_cents / 100, feeCents: row.fee_cents,
    reason: row.reason || '', orderDate: row.order_date || '', disputeDate: row.dispute_date || '',
    deadlineAt: row.deadline_at || '', deadlineSource: row.deadline_source,
    daysLeft, overdue: daysLeft != null && daysLeft < 0,
    status: row.status, statusLabel: DISPUTE_STATUS_LABEL[row.status] || row.status, terminal,
    submittedAt: row.submitted_at, submittedByName: submitter ? employeeName(submitter) : '',
    outcomeAmount: row.outcome_amount_cents == null ? null : row.outcome_amount_cents / 100,
    outcomeNote: row.outcome_note || '', evidence, note: row.note || '',
    createdByName: creator ? employeeName(creator) : '',
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

async function disputeRows(env) {
  // Open cases first, strictly by deadline (the queue is worked by time
  // left, not by arrival); terminal cases after, newest first.
  return all(env, `SELECT * FROM disputes ORDER BY
    CASE WHEN status IN ('won','lost','expired','skipped') THEN 1 ELSE 0 END,
    CASE WHEN status IN ('won','lost','expired','skipped') THEN '' ELSE deadline_at END ASC,
    id DESC`);
}

async function listDisputes(env, actor, searchParams) {
  const locationRows = await locations(env, true);
  const employeeRows = await all(env, 'SELECT id, first_name, last_name FROM employees');
  let rows = await disputeRows(env);
  const status = searchParams.get('status');
  const channel = searchParams.get('channel');
  if (status && DISPUTE_STATUSES.includes(status)) rows = rows.filter(r => r.status === status);
  if (channel && DISPUTE_CHANNELS[channel]) rows = rows.filter(r => r.channel === channel);
  const views = rows.map(r => disputeView(r, locationRows, employeeRows));
  const open = views.filter(v => !v.terminal);
  const summary = {
    open: open.length,
    overdue: open.filter(v => v.overdue).length,
    dueSoon: open.filter(v => !v.overdue && v.daysLeft != null && v.daysLeft <= 3).length,
    openAmount: Math.round(open.reduce((s, v) => s + v.amountCents, 0)) / 100,
    wonAmount: Math.round(views.filter(v => v.status === 'won').reduce((s, v) => s + (v.outcomeAmount != null ? Math.round(v.outcomeAmount * 100) : v.amountCents), 0)) / 100,
    lostAmount: Math.round(views.filter(v => v.status === 'lost' || v.status === 'expired').reduce((s, v) => s + v.amountCents, 0)) / 100
  };
  return { disputes: views, summary };
}

async function createDispute(env, actor, data) {
  const channel = String(data.channel || '');
  const meta = DISPUTE_CHANNELS[channel];
  if (!meta) return { error: fail(400, 'Выберите канал: Uber Eats, DoorDash, Grubhub или Clover') };
  const locationId = data.locationId ? Number(data.locationId) : null;
  if (locationId && !(await one(env, 'SELECT id FROM locations WHERE id = ?', locationId))) {
    return { error: fail(400, 'Точка не найдена') };
  }
  const amountCents = Math.round(Number(data.amount || 0) * 100);
  if (!(amountCents > 0)) return { error: fail(400, 'Укажите сумму удержания больше нуля') };
  const orderDate = validDateKey(data.orderDate);
  const disputeDate = validDateKey(data.disputeDate) || nyDateKey(new Date());
  const dl = disputeDeadline(channel, orderDate, data.deadlineAt);
  if (dl.error) return { error: fail(400, dl.error) };
  // Link to the panel order when we can: explicit id wins, then the Clover
  // order id, then the channel order id matched against Clover orders.
  let panelOrder = null;
  if (data.panelOrderId) panelOrder = await one(env, 'SELECT * FROM orders WHERE id = ?', Number(data.panelOrderId));
  const cloverOrderId = String(data.cloverOrderId || '').trim();
  const channelOrderId = String(data.channelOrderId || '').trim();
  if (!panelOrder && cloverOrderId) panelOrder = await one(env, 'SELECT * FROM orders WHERE clover_order_id = ?', cloverOrderId);
  if (!panelOrder && channelOrderId) panelOrder = await one(env, 'SELECT * FROM orders WHERE clover_order_id = ?', channelOrderId);
  const result = await run(env, `INSERT INTO disputes(channel, kind, location_id, panel_order_id, clover_order_id, channel_order_id,
      amount_cents, fee_cents, reason, order_date, dispute_date, deadline_at, deadline_source, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    channel, meta.kind, locationId || panelOrder?.location_id || null,
    panelOrder?.id || null, cloverOrderId || panelOrder?.clover_order_id || '',
    channelOrderId, amountCents, Math.max(0, Math.round(Number(data.fee || 0) * 100)),
    String(data.reason || '').trim(), orderDate, disputeDate, dl.deadlineAt, dl.source,
    String(data.note || '').trim(), actor.id);
  const row = await one(env, 'SELECT * FROM disputes WHERE id = ?', result.meta?.last_row_id);
  return { row };
}

async function updateDispute(env, actor, id, data) {
  const row = await one(env, 'SELECT * FROM disputes WHERE id = ?', id);
  if (!row) return { error: fail(404, 'Спор не найден') };
  const terminal = DISPUTE_TERMINAL.includes(row.status);
  const updates = [];
  const params = [];
  const assign = (column, value) => { updates.push(`${column} = ?`); params.push(value); };
  if (data.note !== undefined) assign('note', String(data.note || ''));
  if (data.evidence !== undefined && typeof data.evidence === 'object') {
    let current = {};
    try { current = JSON.parse(row.evidence_json || '{}'); } catch { current = {}; }
    assign('evidence_json', JSON.stringify({ ...current, ...data.evidence }));
  }
  if (data.outcomeNote !== undefined) assign('outcome_note', String(data.outcomeNote || ''));
  if (data.outcomeAmount !== undefined) {
    assign('outcome_amount_cents', data.outcomeAmount === null || data.outcomeAmount === '' ? null : Math.round(Number(data.outcomeAmount) * 100));
  }
  if (data.deadlineAt !== undefined && !terminal) {
    const dl = validDateKey(data.deadlineAt);
    if (!dl) return { error: fail(400, 'Неверная дата дедлайна') };
    assign('deadline_at', dl);
    assign('deadline_source', 'notice');
  }
  if (data.status !== undefined) {
    const status = String(data.status);
    if (!DISPUTE_STATUSES.includes(status)) return { error: fail(400, 'Неизвестный статус') };
    if (terminal && status !== row.status) return { error: fail(409, 'Спор закрыт — статус больше не меняется') };
    if (status === 'submitted' && row.status !== 'submitted') {
      assign('submitted_at', nowIso());
      assign('submitted_by', actor.id);
    }
    assign('status', status);
  }
  if (!updates.length) return { error: fail(400, 'Нет изменений') };
  params.push(nowIso(), id);
  await run(env, `UPDATE disputes SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`, ...params);
  return { row: await one(env, 'SELECT * FROM disputes WHERE id = ?', id) };
}

/* Minimal RFC-4180 CSV reader: quotes, embedded commas/newlines, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(cell => String(cell).trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(cell => String(cell).trim() !== '')) rows.push(row);
  return rows;
}

const CSV_HEADER_ALIASES = {
  orderId: ['order id', 'order #', 'order number', 'order', 'transaction id', 'transaction', 'заказ'],
  amount: ['error charge', 'adjustment', 'adjustment amount', 'amount', 'chargeback amount', 'withheld', 'сумма'],
  date: ['order date', 'date', 'transaction date', 'дата заказа', 'дата'],
  reason: ['reason', 'error type', 'adjustment reason', 'error', 'причина'],
  fee: ['fee', 'chargeback fee', 'комиссия']
};
function csvColumnMap(headers) {
  const normalized = headers.map(h => String(h || '').trim().toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
    const idx = normalized.findIndex(h => aliases.includes(h));
    if (idx >= 0) map[key] = idx;
  }
  return map;
}
function parseCsvAmount(value) {
  const text = String(value || '').replace(/[$,\s]/g, '').replace(/\((.*)\)/, '-$1');
  const num = Number(text);
  return Number.isFinite(num) ? Math.abs(num) : 0;
}
function parseCsvDate(value) {
  const text = String(value || '').trim();
  if (validDateKey(text)) return text;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(text);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? '' : nyDateKey(d);
}

// Imports a portal Transactions/Payouts CSV export for one channel: rows
// with a recognizable order id + amount become cases (deadlines from the
// channel rule), duplicates by channel + channel order id are skipped.
async function importDisputesCsv(env, actor, data) {
  const channel = String(data.channel || '');
  if (!DISPUTE_CHANNELS[channel]) return { error: fail(400, 'Выберите канал для импорта') };
  if (channel === 'clover') return { error: fail(400, 'Chargeback-кейсы Clover заводятся вручную: дедлайн берётся из уведомления эквайрера') };
  const locationId = data.locationId ? Number(data.locationId) : null;
  const table = parseCsv(data.csv);
  if (table.length < 2) return { error: fail(400, 'В CSV не нашлось строк данных') };
  const map = csvColumnMap(table[0]);
  if (map.orderId === undefined || map.amount === undefined) {
    return { error: fail(400, 'Не узнаю формат выгрузки: нужны колонки с номером заказа и суммой (Error charge / Adjustment / Amount)') };
  }
  let created = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    const orderId = String(cells[map.orderId] || '').trim();
    const amount = parseCsvAmount(cells[map.amount]);
    if (!orderId || !(amount > 0)) { skipped += 1; continue; }
    const existing = await one(env, 'SELECT id FROM disputes WHERE channel = ? AND channel_order_id = ?', channel, orderId);
    if (existing) { skipped += 1; continue; }
    const orderDate = map.date !== undefined ? parseCsvDate(cells[map.date]) : '';
    const result = await createDispute(env, actor, {
      channel, locationId, channelOrderId: orderId, cloverOrderId: orderId,
      amount, fee: map.fee !== undefined ? parseCsvAmount(cells[map.fee]) : 0,
      reason: map.reason !== undefined ? String(cells[map.reason] || '').trim() : '',
      orderDate, disputeDate: nyDateKey(new Date())
    });
    if (result.error) { errors.push({ line: i + 1, orderId }); skipped += 1; continue; }
    created += 1;
  }
  return { created, skipped, errors };
}

/* Evidence package: everything the panel already knows about the order
   (receipt lines, totals, timeline) + an honest checklist of what only a
   human can attach (CCTV clip, sealed-bag photo, payment slip details —
   card brand/last4/auth are NOT stored by the Clover sync, so the package
   says so instead of inventing them) + a ready English dispute text per
   channel (Grubhub additionally in the 4-field email format). */
async function buildDisputeEvidence(env, dispute) {
  let order = null;
  if (dispute.panel_order_id) order = await one(env, 'SELECT * FROM orders WHERE id = ?', dispute.panel_order_id);
  if (!order && dispute.clover_order_id) order = await one(env, 'SELECT * FROM orders WHERE clover_order_id = ?', dispute.clover_order_id);
  if (!order && dispute.channel_order_id) order = await one(env, 'SELECT * FROM orders WHERE clover_order_id = ?', dispute.channel_order_id);
  const location = dispute.location_id
    ? await one(env, 'SELECT * FROM locations WHERE id = ?', dispute.location_id)
    : (order ? await one(env, 'SELECT * FROM locations WHERE id = ?', order.location_id) : null);
  const companyName = await getSetting(env, 'companyName');
  const meta = DISPUTE_CHANNELS[dispute.channel];
  let evidence = {};
  try { evidence = JSON.parse(dispute.evidence_json || '{}'); } catch { evidence = {}; }
  const orderViewFull = order ? await orderView(env, order) : null;
  const itemsText = orderViewFull
    ? orderViewFull.items.map(i => `${i.name} x${i.qty} — $${(i.price * i.qty).toFixed(2)}`).join('; ')
    : '';
  const orderRef = dispute.channel_order_id || dispute.clover_order_id || (order ? order.clover_order_id : '') || (order ? `#${order.id}` : '');
  const fmtUsd = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
  const facts = [
    `Order: ${orderRef || '—'}`,
    dispute.clover_order_id && dispute.clover_order_id !== orderRef ? `POS (Clover) order: ${dispute.clover_order_id}` : '',
    order && !dispute.clover_order_id ? `Panel order: #${order.id}` : '',
    `Location: ${location?.name || '—'}${location?.address ? `, ${location.address}` : ''}`,
    `Order date: ${dispute.order_date || (order ? nyDateKey(new Date(order.created_at)) : '—')}`,
    order ? `Placed (NY): ${order.created_at}; served/closed: ${order.served_at || '—'}` : '',
    order ? `Order total: ${fmtUsd(order.total_cents)}; items: ${itemsText}` : '',
    `Withheld: ${fmtUsd(dispute.amount_cents)}${dispute.fee_cents ? ` + fee ${fmtUsd(dispute.fee_cents)}` : ''}`,
    dispute.reason ? `Stated reason: ${dispute.reason}` : ''
  ].filter(Boolean);
  let text;
  if (dispute.channel === 'grubhub') {
    text = [
      `To: ${meta.email}`,
      `Subject: Dispute of prepaid order adjustment — order ${orderRef}`,
      '',
      `Order number: ${orderRef}`,
      `Order date: ${dispute.order_date || '—'}`,
      `Adjustment date: ${dispute.dispute_date || '—'}`,
      `Reason for dispute: The order was prepared in full and handed over as ordered (${itemsText || 'see attached receipt'}). ${evidence.photo ? 'A photo of the sealed bag with the order ID is attached. ' : ''}${evidence.cctv ? 'CCTV footage of the packing is available and attached. ' : ''}The POS timeline (attached) confirms the order was completed and picked up. Please reverse the adjustment of ${fmtUsd(dispute.amount_cents)}.`,
      '',
      ...facts.map(f => `- ${f}`),
      '',
      companyName || ''
    ].join('\n');
  } else if (dispute.channel === 'clover') {
    text = [
      `REPRESENTMENT — chargeback dispute`,
      `Merchant: ${companyName} — ${location?.name || ''}`,
      `Case / order reference: ${orderRef}`,
      `Amount disputed: ${fmtUsd(dispute.amount_cents)}${dispute.fee_cents ? ` (plus fee ${fmtUsd(dispute.fee_cents)})` : ''}`,
      '',
      `The transaction is legitimate: the order below was placed, paid and handed to the guest. Enclosed: (1) POS receipt with line items and totals; (2) order timeline from the POS; (3) payment record from Clover (card brand, last 4, authorization code — attach from the Clover payment record); ${evidence.cctv ? '(4) CCTV stills/clip of the handover; ' : ''}We request reversal of the chargeback and the fee.`,
      '',
      ...facts.map(f => `- ${f}`),
      '',
      companyName || ''
    ].join('\n');
  } else {
    text = [
      `We dispute the ${fmtUsd(dispute.amount_cents)} adjustment for order ${orderRef} (${meta.label}, ${location?.name || ''}).`,
      `The order was prepared in full and handed over as ordered: ${itemsText || 'see attached receipt'}. The POS timeline confirms placement and handover times.`,
      evidence.photo ? 'Attached: photo of the sealed bag showing the order ID.' : 'Note: no sealed-bag photo for this order (SOP in rollout).',
      evidence.cctv ? 'Attached: CCTV clip of the packing/handover.' : 'CCTV clip of the packing is being retrieved by the location manager.',
      'Please reverse this adjustment.',
      '',
      ...facts.map(f => `- ${f}`),
      '',
      companyName || ''
    ].join('\n');
  }
  return {
    disputeId: dispute.id,
    channel: dispute.channel,
    channelLabel: meta.label,
    portalUrl: meta.portalUrl,
    portalName: meta.portalName,
    portalEmail: meta.email || null,
    companyName,
    location: location ? locationView(location) : null,
    order: orderViewFull,
    checklist: [
      { key: 'receipt', label: 'Чек заказа из Clover/панели', present: Boolean(order), auto: true },
      { key: 'timeline', label: 'Таймлайн заказа (создан → выдан)', present: Boolean(order), auto: true },
      { key: 'payment', label: 'Платёж: бренд/последние 4/auth code', present: false, auto: false, note: 'Синк Clover не хранит платёжные реквизиты — взять из записи оплаты в Clover и приложить вручную' },
      { key: 'cctv', label: 'Клип CCTV упаковки/выдачи', present: Boolean(evidence.cctv), auto: false },
      { key: 'photo', label: 'Фото запечатанного пакета с ID заказа', present: Boolean(evidence.photo), auto: false }
    ],
    text
  };
}

/* ---------------- Router ---------------- */

/* ---------------- Staff checklists (results written by @ShawaTeambot) ----------------
   The bot owns the runs (Telegram groups of each location); the panel only
   reads checklist_runs. One finished run = one row: location is the location
   NAME (as in the bot config), day is the NY calendar day (YYYY-MM-DD). */

const CHECKLIST_AREA_LABEL = { kitchen: 'Кухня', front: 'Фронт' };
const CHECKLIST_KIND_LABEL = { opening: 'Открытие', closing: 'Закрытие' };
const CHECKLIST_RUNS_PER_DAY = 4; // kitchen/front × opening/closing

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function checklistRunView(row) {
  const detail = parseJsonList(row.detail_json).map(d => ({
    item: String(d?.item || ''),
    done: Boolean(d?.done),
    by: d?.by ? String(d.by) : '',
    at: d?.at ? String(d.at) : ''
  }));
  const total = Number(row.total_items || 0);
  const done = Number(row.done_items || 0);
  // A run auto-completes the moment the last open item is checked off, so for
  // a completed run the closer is the person who made that final mark.
  let closedBy = '';
  if (row.status === 'completed') {
    const marked = detail.filter(d => d.done && d.at).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    closedBy = marked.length ? marked[marked.length - 1].by : '';
  }
  return {
    id: row.id,
    location: row.location,
    kind: row.kind,
    kindLabel: CHECKLIST_KIND_LABEL[row.kind] || row.kind,
    area: row.area,
    areaLabel: CHECKLIST_AREA_LABEL[row.area] || row.area,
    day: row.day,
    status: row.status,
    startedBy: row.started_by || '',
    startedAt: row.started_at || '',
    finishedAt: row.finished_at || '',
    closedBy,
    totalItems: total,
    doneItems: done,
    pct: total > 0 ? Math.round((done / total) * 100) : 0,
    missed: detail.filter(d => !d.done).map(d => d.item),
    detail,
    shifts: parseJsonList(row.shift_json).map(s => ({
      employee: String(s?.employee || ''),
      startsAt: s?.starts_at || '',
      endsAt: s?.ends_at || ''
    }))
  };
}

function checklistWeekDays(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const monday = weekStartNy(zonedTimeToUtc(y, m, d));
  return Array.from({ length: 7 }, (_, i) => nyDateKey(addUtcDays(monday, i)));
}

async function buildChecklists(env, params) {
  const day = String(params.get('day') || nyDateKey(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: fail(400, 'День укажите в формате ГГГГ-ММ-ДД') };
  const locationFilter = String(params.get('location') || '').trim().slice(0, 120);
  const locationNames = (await locations(env, true)).map(l => l.name);

  const runRows = locationFilter
    ? await all(env, 'SELECT * FROM checklist_runs WHERE day = ? AND location = ? ORDER BY location, started_at, id', day, locationFilter)
    : await all(env, 'SELECT * FROM checklist_runs WHERE day = ? ORDER BY location, started_at, id', day);

  // Weekly summary: expected runs = elapsed days of that week (Mon..today)
  // × 4 checklists per location per day; pct = fully completed / expected.
  const weekDays = checklistWeekDays(day);
  const todayKey = nyDateKey(new Date());
  const elapsedDays = weekDays.filter(k => k <= todayKey).length;
  const expectedPerLocation = elapsedDays * CHECKLIST_RUNS_PER_DAY;
  const weekRows = await all(env, `SELECT location, status, COUNT(*) AS runs, SUM(done_items) AS done, SUM(total_items) AS total
    FROM checklist_runs WHERE day >= ? AND day <= ? GROUP BY location, status`, weekDays[0], weekDays[6]);
  const byLocation = new Map();
  const ensure = (name) => {
    if (!byLocation.has(name)) byLocation.set(name, { location: name, runs: 0, completed: 0, finishedEarly: 0, doneItems: 0, totalItems: 0 });
    return byLocation.get(name);
  };
  for (const name of locationNames) ensure(name);
  for (const row of weekRows) {
    const entry = ensure(row.location);
    entry.runs += Number(row.runs || 0);
    if (row.status === 'completed') entry.completed += Number(row.runs || 0);
    if (row.status === 'finished_early') entry.finishedEarly += Number(row.runs || 0);
    entry.doneItems += Number(row.done || 0);
    entry.totalItems += Number(row.total || 0);
  }
  const week = [...byLocation.values()].map(e => ({
    ...e,
    expected: expectedPerLocation,
    pct: expectedPerLocation > 0 ? Math.round((e.completed / expectedPerLocation) * 100) : null,
    itemsPct: e.totalItems > 0 ? Math.round((e.doneItems / e.totalItems) * 100) : null
  }));
  return { ok: true, day, weekStart: weekDays[0], weekEnd: weekDays[6], locations: locationNames, runs: runRows.map(checklistRunView), week };
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method.toUpperCase();
  try {
    if (path === '/api/bootstrap' && method === 'GET') {
      const count = await one(env, 'SELECT COUNT(*) AS count FROM employees');
      return json({ ok: true, companyName: await getSetting(env, 'companyName'), hasOwner: Number(count?.count || 0) > 0, locations: await locations(env), timeZone: TIME_ZONE, today: nyDateKey(new Date()) });
    }
    if (path === '/api/auth/register' && method === 'POST') return register(request, env);
    if (path === '/api/auth/register/start' && method === 'POST') return registerStart(request, env);
    if (path === '/api/auth/register/verify' && method === 'POST') return registerVerify(request, env);
    if (path === '/api/auth/register/resend' && method === 'POST') return registerResend(request, env);
    if (path === '/api/auth/login' && method === 'POST') return login(request, env);
    if (path === '/api/auth/reset-password' && method === 'POST') return resetPassword(request, env);
    if (path === '/api/auth/reset/request' && method === 'POST') return resetRequest(request, env);
    if (path === '/api/auth/reset/confirm' && method === 'POST') return resetConfirm(request, env);
    if (path === '/api/punches/kiosk' && method === 'POST') {
      const data = await body(request);
      const employee = await employeeById(env, data.employeeId);
      if (!employee || !employee.active) return fail(404, 'Сотрудник не найден');
      if (!employee.pin_hash) return fail(400, 'PIN сотрудника не задан');
      if (!(await verifySecret(data.pin, employee.pin_hash))) return fail(401, 'Неверный PIN');
      return clockAction(env, employee, data, employee);
    }
    // Inbound invoice webhook: no session — a shared secret instead (header
    // x-invoice-secret or Bearer). Used by mail forwarders while Email
    // Routing is being enabled; the Email Worker path needs no secret.
    if (path === '/api/invoice-inbound' && method === 'POST') {
      const secret = env.INVOICE_INBOUND_SECRET || await getSetting(env, 'invoiceInboundSecret');
      if (!secret) return fail(503, 'Почтовый канал инвойсов не настроен');
      const given = request.headers.get('x-invoice-secret') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!given || await sha256Hex(given) !== await sha256Hex(String(secret))) return fail(403, 'Неверный секрет канала');
      const data = await body(request);
      const stored = await storeInboundInvoice(env, { ...normalizeWebhookPayload(data), todayKey: nyDateKey(new Date()) });
      return json({ ok: true, draftId: stored.id, lines: stored.lines }, 201);
    }
    // Ops alerts webhook: no session — a shared secret instead (header
    // x-ops-secret or Bearer), same pattern as invoice-inbound. External
    // order systems (mangal-ops / mangal-web) report orders that failed
    // to reach Clover; rows land as 'pending' and @ShawaTeambot publishes
    // them. The secret is generated and stored on first use (see
    // opsAlertSecret); its value is never exposed by the API.
    if (path === '/api/ops/alert' && method === 'POST') {
      const secret = await opsAlertSecret(env);
      const given = request.headers.get('x-ops-secret') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!given || await sha256Hex(given) !== await sha256Hex(String(secret))) return fail(401, 'Неверный секрет канала оповещений');
      const data = await body(request);
      const locationKey = String(data.location_key || '');
      const kind = String(data.kind || '').trim().slice(0, 80);
      const text = String(data.text || '').trim().slice(0, 2000);
      const source = String(data.source || '').trim().slice(0, 120);
      if (!OPS_LOCATION_KEYS.includes(locationKey)) return fail(400, 'location_key: sunny_isles | miami_downtown | fort_lauderdale | hallandale | network');
      if (!kind) return fail(400, 'Укажите kind');
      if (!text) return fail(400, 'Укажите text');
      if (!source) return fail(400, 'Укажите source');
      const result = await run(env, 'INSERT INTO ops_alerts(location_key, kind, text, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        locationKey, kind, text, source, 'pending', nowIso());
      return json({ ok: true, id: result.meta?.last_row_id });
    }
    const inviteLookup = /^\/api\/invites\/([A-Za-z0-9-]+)$/.exec(path);
    if (inviteLookup && method === 'GET' && !request.headers.get('authorization')) {
      const invite = await one(env, 'SELECT * FROM invites WHERE code = ?', inviteLookup[1].toUpperCase());
      if (!invite) return fail(404, 'Приглашение не найдено');
      return json({ ok: true, companyName: await getSetting(env, 'companyName'), invite: inviteView(invite, await locations(env)) });
    }

    /* Public website catalog (no auth): the future mangal-web consumer pulls
       the published master catalog from here. Only catalog_published items,
       only uploaded photos of published items are served. */
    if (path === '/api/public/catalog' && method === 'GET') {
      return publicCatalog(env, url);
    }
    const publicPhoto = /^\/api\/public\/catalog\/photos\/([A-Za-z0-9._-]+)$/.exec(path);
    if (publicPhoto && method === 'GET') {
      const key = decodeURIComponent(publicPhoto[1]);
      const row = /^\d+$/.test(key)
        ? await one(env, 'SELECT photo_jpeg FROM menu_items WHERE id = ? AND catalog_published = 1 AND active = 1', Number(key))
        : await one(env, 'SELECT photo_jpeg FROM menu_items WHERE code = ? AND catalog_published = 1 AND active = 1', key);
      if (!row?.photo_jpeg) return fail(404, 'Фото не найдено');
      const bytes = Uint8Array.from(atob(row.photo_jpeg), c => c.charCodeAt(0));
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
    }

    const actor = await authenticate(request, env);
    if (!actor) return fail(401, 'Нужно войти');
    if (path === '/api/auth/me' && method === 'GET') return json({ ok: true, employee: publicEmployee(actor, actor), companyName: await getSetting(env, 'companyName') });
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = (request.headers.get('authorization') || '').slice(7);
      await run(env, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
      return json({ ok: true });
    }
    if (path === '/api/state' && method === 'GET') return json(await buildState(env, actor));
    if (path === '/api/dashboard' && method === 'GET') return json({ ok: true, dashboard: await buildDashboard(env, actor) });
    if (path === '/api/checklists' && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Чек-листы видит управляющий и выше');
      const result = await buildChecklists(env, url.searchParams);
      if (result.error) return result.error;
      return json(result);
    }

    /* Temperature control: any authorized user reads and records
       readings; equipment management is manager+. */
    if (path === '/api/temperatures' && method === 'GET') {
      return json(await buildTemperatures(env));
    }
    if (path === '/api/temperatures/history' && method === 'GET') {
      const equipmentId = Number(url.searchParams.get('equipment_id') || url.searchParams.get('equipmentId') || 0);
      if (!equipmentId) return fail(400, 'Укажите equipment_id');
      const equipment = await one(env, 'SELECT * FROM temp_equipment WHERE id = ?', equipmentId);
      if (!equipment) return fail(404, 'Оборудование не найдено');
      let days = Number(url.searchParams.get('days') || 7);
      if (!Number.isFinite(days) || days < 1) days = 7;
      days = Math.min(31, Math.floor(days));
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', equipment.location_id);
      const readings = await all(env,
        `SELECT * FROM temp_readings WHERE equipment_id = ? AND created_at >= datetime('now', '-${days} days') ORDER BY created_at DESC, id DESC LIMIT 1000`,
        equipmentId);
      return json({
        ok: true, days,
        equipment: { ...tempEquipmentView(equipment), location_name: location?.name || '', locationName: location?.name || '' },
        location: location ? locationView(location) : null,
        readings: readings.map(tempReadingView)
      });
    }
    if (path === '/api/temperatures/journal' && method === 'GET') {
      const dayParam = String(url.searchParams.get('day') || '');
      const day = dayParam || nyDateKey(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail(400, 'День укажите в формате ГГГГ-ММ-ДД');
      const [jy, jm, jd] = day.split('-').map(Number);
      const dayStart = zonedTimeToUtc(jy, jm, jd);
      const dayEnd = addUtcDays(dayStart, 1);
      const locationIdRaw = url.searchParams.get('location_id') || url.searchParams.get('locationId');
      let location = null;
      let equipmentRows = [];
      let readings = [];
      if (locationIdRaw) {
        const locationId = Number(locationIdRaw);
        if (!locationId) return fail(400, 'Укажите location_id');
        location = await one(env, 'SELECT * FROM locations WHERE id = ?', locationId);
        if (!location) return fail(404, 'Точка не найдена');
        equipmentRows = await all(env, 'SELECT * FROM temp_equipment WHERE location_id = ? ORDER BY name, id', locationId);
        readings = await all(env, `SELECT r.*, e.name AS equipment_name, e.type AS equipment_type, e.location_id AS location_id
          FROM temp_readings r JOIN temp_equipment e ON e.id = r.equipment_id
          WHERE e.location_id = ? AND datetime(r.created_at) >= datetime(?) AND datetime(r.created_at) < datetime(?)
          ORDER BY r.created_at DESC, r.id DESC`, locationId, dayStart.toISOString(), dayEnd.toISOString());
      } else {
        equipmentRows = await all(env, 'SELECT * FROM temp_equipment ORDER BY location_id, name, id');
        readings = await all(env, `SELECT r.*, e.name AS equipment_name, e.type AS equipment_type, e.location_id AS location_id
          FROM temp_readings r JOIN temp_equipment e ON e.id = r.equipment_id
          WHERE datetime(r.created_at) >= datetime(?) AND datetime(r.created_at) < datetime(?)
          ORDER BY r.created_at DESC, r.id DESC`, dayStart.toISOString(), dayEnd.toISOString());
      }
      const readingViews = readings.map(r => ({
        ...tempReadingView(r),
        equipment_name: r.equipment_name, equipmentName: r.equipment_name,
        equipment_type: r.equipment_type, location_id: r.location_id, locationId: r.location_id
      }));
      return json({
        ok: true, day,
        location_id: location ? location.id : null, locationId: location ? location.id : null,
        location: location ? locationView(location) : null,
        equipment: equipmentRows.map(tempEquipmentView),
        readings: readingViews
      });
    }
    if (path === '/api/temperatures/readings' && method === 'POST') {
      const data = await body(request);
      const equipmentId = Number(data.equipment_id ?? data.equipmentId ?? 0);
      if (!equipmentId) return fail(400, 'Укажите equipment_id');
      const equipment = await one(env, 'SELECT * FROM temp_equipment WHERE id = ?', equipmentId);
      if (!equipment) return fail(404, 'Оборудование не найдено');
      if (!equipment.active) return fail(400, 'Оборудование выключено — замер не принимается');
      const value = Number(data.value_f ?? data.valueF ?? data.value);
      if (!Number.isFinite(value) || value < -60 || value > 160) return fail(400, 'Температура должна быть числом от -60 до 160 °F');
      let humidity = null;
      if (data.humidity_pct !== undefined && data.humidity_pct !== null && data.humidity_pct !== '') {
        humidity = Number(data.humidity_pct);
        if (!Number.isFinite(humidity) || humidity < 0 || humidity > 100) return fail(400, 'Влажность должна быть от 0 до 100%');
      } else if (data.humidityPct !== undefined && data.humidityPct !== null && data.humidityPct !== '') {
        humidity = Number(data.humidityPct);
        if (!Number.isFinite(humidity) || humidity < 0 || humidity > 100) return fail(400, 'Влажность должна быть от 0 до 100%');
      }
      const enteredBy = employeeName(actor);
      // created_at is NOT set — the DEFAULT CURRENT_TIMESTAMP applies.
      const result = await run(env,
        'INSERT INTO temp_readings(equipment_id, value_f, humidity_pct, source, entered_by) VALUES (?, ?, ?, ?, ?)',
        equipment.id, value, humidity, 'panel', enteredBy);
      const readingId = result.meta?.last_row_id;
      const deviation = tempIsDeviation(equipment, value);
      const critical = tempIsCritical(equipment, value);
      if (deviation) {
        const location = await one(env, 'SELECT * FROM locations WHERE id = ?', equipment.location_id);
        if (location) {
          await recordOpsAlert(env, {
            locationKey: locationKeyFor(location),
            kind: critical ? 'temp_critical' : 'temp_deviation',
            text: tempDeviationText(location, equipment, value).slice(0, 2000),
            source: 'shawa-ceo-temp'
          });
        }
      }
      const status = deviation ? 'deviation' : 'ok';
      return json({ ok: true, id: readingId, readingId, status, deviation, critical, equipment_id: equipment.id, value_f: value, humidity_pct: humidity }, 201);
    }
    if (path === '/api/temperatures/equipment' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Оборудование добавляет управляющий и выше');
      const data = await body(request);
      const locationId = Number(data.location_id ?? data.locationId ?? 0);
      if (!locationId) return fail(400, 'Укажите location_id');
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', locationId);
      if (!location) return fail(400, 'Точка не найдена');
      const name = String(data.name || '').trim();
      if (!name) return fail(400, 'Укажите название оборудования');
      const type = String(data.type || '');
      if (!TEMP_TYPES.includes(type)) return fail(400, 'Тип оборудования: fridge, freezer, walkin или storage');
      const parseNorm = (raw) => {
        if (raw === undefined || raw === null || raw === '') return { value: null };
        const num = Number(raw);
        if (!Number.isFinite(num) || num < -60 || num > 160) return { error: 'Границы нормы должны быть числами от -60 до 160 °F' };
        return { value: num };
      };
      const minParsed = parseNorm(data.norm_min_f ?? data.normMinF);
      if (minParsed.error) return fail(400, minParsed.error);
      const maxParsed = parseNorm(data.norm_max_f ?? data.normMaxF);
      if (maxParsed.error) return fail(400, maxParsed.error);
      if (minParsed.value != null && maxParsed.value != null && minParsed.value > maxParsed.value) {
        return fail(400, 'Нижняя граница нормы не может быть выше верхней');
      }
      const result = await run(env,
        'INSERT INTO temp_equipment(location_id, name, type, norm_min_f, norm_max_f) VALUES (?, ?, ?, ?, ?)',
        locationId, name, type, minParsed.value, maxParsed.value);
      const row = await one(env, 'SELECT * FROM temp_equipment WHERE id = ?', result.meta?.last_row_id);
      return json({ ok: true, id: row.id, equipment: tempEquipmentView(row) }, 201);
    }
    const tempActiveMatch = /^\/api\/temperatures\/equipment\/(\d+)\/active$/.exec(path);
    if (tempActiveMatch && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Оборудование изменяет управляющий и выше');
      const equipment = await one(env, 'SELECT * FROM temp_equipment WHERE id = ?', tempActiveMatch[1]);
      if (!equipment) return fail(404, 'Оборудование не найдено');
      const data = await body(request);
      const active = data.active === undefined ? !equipment.active : Boolean(data.active);
      await run(env, 'UPDATE temp_equipment SET active = ? WHERE id = ?', active ? 1 : 0, equipment.id);
      const updated = await one(env, 'SELECT * FROM temp_equipment WHERE id = ?', equipment.id);
      return json({ ok: true, equipment: tempEquipmentView(updated) });
    }

    if (path === '/api/company' && method === 'POST') {
      if (actor.rank !== 'owner') return fail(403, 'Название компании меняет только владелец');
      const data = await body(request);
      if (!String(data.name || '').trim()) return fail(400, 'Укажите название компании');
      await setSetting(env, 'companyName', String(data.name).trim());
      return json({ ok: true, companyName: String(data.name).trim() });
    }
    if (path === '/api/settings/clover' && method === 'GET') {
      if (actor.rank !== 'owner') return fail(403, 'Настройки Clover видит только владелец');
      return json({ ok: true, merchantId: await getSetting(env, 'cloverMerchantId'), hasToken: Boolean(await getSetting(env, 'cloverToken')), connected: false });
    }
    if (path === '/api/settings/clover' && method === 'POST') {
      if (actor.rank !== 'owner') return fail(403, 'Настройки Clover меняет только владелец');
      const data = await body(request);
      if (data.merchantId !== undefined) await setSetting(env, 'cloverMerchantId', String(data.merchantId || '').trim());
      if (data.token) await setSetting(env, 'cloverToken', String(data.token));
      if (data.clearToken) await setSetting(env, 'cloverToken', '');
      return json({ ok: true, merchantId: await getSetting(env, 'cloverMerchantId'), hasToken: Boolean(await getSetting(env, 'cloverToken')), connected: false });
    }

    /* Clover per location: credentials (owner), connection check (owner),
       sales sync (manager+), menu publishing (owner). The stored token is
       never returned — only the connection state. */
    const locCloverMatch = /^\/api\/locations\/(\d+)\/clover$/.exec(path);
    if (locCloverMatch && method === 'GET') {
      if (actor.rank !== 'owner') return fail(403, 'Clover точки видит только владелец');
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', locCloverMatch[1]);
      if (!location) return fail(404, 'Точка не найдена');
      return json({ ok: true, clover: await cloverLocationStatus(env, location) });
    }
    if (locCloverMatch && method === 'POST') {
      if (actor.rank !== 'owner') return fail(403, 'Clover точки подключает только владелец');
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', locCloverMatch[1]);
      if (!location) return fail(404, 'Точка не найдена');
      const data = await body(request);
      const merchantId = data.merchantId !== undefined ? String(data.merchantId || '').trim() : location.clover_merchant_id;
      const token = data.clearToken ? '' : (data.token ? String(data.token) : location.clover_token);
      // A changed merchant invalidates the previously verified merchant name.
      const merchantName = merchantId === location.clover_merchant_id ? location.clover_merchant_name : '';
      await run(env, 'UPDATE locations SET clover_merchant_id = ?, clover_token = ?, clover_merchant_name = ? WHERE id = ?',
        merchantId, token, merchantName, location.id);
      const updated = await one(env, 'SELECT * FROM locations WHERE id = ?', location.id);
      return json({ ok: true, clover: await cloverLocationStatus(env, updated) });
    }
    const locCloverTest = /^\/api\/locations\/(\d+)\/clover\/test$/.exec(path);
    if (locCloverTest && method === 'POST') {
      if (actor.rank !== 'owner') return fail(403, 'Подключение Clover проверяет только владелец');
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', locCloverTest[1]);
      if (!location) return fail(404, 'Точка не найдена');
      const creds = await cloverCredsFor(env, location);
      if (!creds) return fail(400, 'Сначала укажите Merchant ID и токен — у точки или общие в настройках Clover');
      try {
        const merchant = await cloverFetch(env, creds.merchantId, creds.token, '');
        const name = String(merchant.name || '');
        await run(env, 'UPDATE locations SET clover_merchant_name = ?, clover_last_error = ? WHERE id = ?', name, '', location.id);
        const updated = await one(env, 'SELECT * FROM locations WHERE id = ?', location.id);
        return json({ ok: true, merchantName: name, clover: await cloverLocationStatus(env, updated) });
      } catch (error) {
        await run(env, 'UPDATE locations SET clover_last_error = ? WHERE id = ?', error.message, location.id);
        return fail(502, error.message);
      }
    }
    const locCloverSync = /^\/api\/locations\/(\d+)\/clover\/sync$/.exec(path);
    if (locCloverSync && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Синхронизацию запускает управляющий и выше');
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', locCloverSync[1]);
      if (!location) return fail(404, 'Точка не найдена');
      const creds = await cloverCredsFor(env, location);
      if (!creds) return fail(400, 'Точка не подключена к Clover');
      try {
        const summary = await syncCloverLocation(env, location, creds);
        const updated = await one(env, 'SELECT * FROM locations WHERE id = ?', location.id);
        return json({ ok: true, ...summary, clover: await cloverLocationStatus(env, updated) });
      } catch (error) {
        await run(env, 'UPDATE locations SET clover_last_error = ? WHERE id = ?', error.message, location.id);
        await recordSyncErrorAlert(env, location, error);
        return fail(502, error.message);
      }
    }
    const locCloverPublish = /^\/api\/locations\/(\d+)\/clover\/publish-menu$/.exec(path);
    if (locCloverPublish && method === 'POST') {
      if (actor.rank !== 'owner') return fail(403, 'Меню в Clover публикует только владелец');
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', locCloverPublish[1]);
      if (!location) return fail(404, 'Точка не найдена');
      const creds = await cloverCredsFor(env, location);
      if (!creds) return fail(400, 'Точка не подключена к Clover');
      const summary = await publishMenuToClover(env, location, creds);
      return json({ ok: true, ...summary });
    }

    if (path === '/api/locations' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Точки добавляет управляющий и выше');
      const data = await body(request);
      if (!String(data.name || '').trim()) return fail(400, 'Укажите название точки');
      const status = ['active', 'opening', 'closed'].includes(data.status) ? data.status : 'active';
      const result = await run(env, 'INSERT INTO locations(name, address, status, sort_order) VALUES (?, ?, ?, ?)', String(data.name).trim(), String(data.address || '').trim(), status, Number(data.sort || 0));
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const locationMatch = /^\/api\/locations\/(\d+)$/.exec(path);
    if (locationMatch && method === 'PATCH') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Точки изменяет управляющий и выше');
      const data = await body(request);
      const existing = await one(env, 'SELECT * FROM locations WHERE id = ?', locationMatch[1]);
      if (!existing) return fail(404, 'Точка не найдена');
      const status = ['active', 'opening', 'closed'].includes(data.status) ? data.status : existing.status;
      await run(env, 'UPDATE locations SET name = ?, address = ?, status = ?, sort_order = ?, active = ? WHERE id = ?',
        data.name !== undefined ? String(data.name).trim() : existing.name,
        data.address !== undefined ? String(data.address).trim() : existing.address,
        status,
        data.sort !== undefined ? Number(data.sort || 0) : existing.sort_order,
        data.active !== undefined ? (data.active ? 1 : 0) : existing.active,
        locationMatch[1]);
      return json({ ok: true });
    }

    /* 3D view of a location: scene staff (real employees or the flagged demo
       roster) and shift calls. Calling is manager+; no messages are sent. */
    const sceneMatch = /^\/api\/locations\/(\d+)\/scene$/.exec(path);
    if (sceneMatch && method === 'GET') {
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', sceneMatch[1]);
      if (!location) return fail(404, 'Точка не найдена');
      return json({ ok: true, ...(await buildLocationScene(env, actor, location)) });
    }
    const callsMatch = /^\/api\/locations\/(\d+)\/calls$/.exec(path);
    if (callsMatch && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Вызывать сотрудников может управляющий и выше');
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', callsMatch[1]);
      if (!location) return fail(404, 'Точка не найдена');
      const data = await body(request);
      const result = await callToShift(env, actor, location, String(data.key || ''));
      if (result.error) return result.error;
      return json({ ok: true, scene: result.scene });
    }
    const callsCancelMatch = /^\/api\/locations\/(\d+)\/calls\/cancel$/.exec(path);
    if (callsCancelMatch && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Отменять вызов может управляющий и выше');
      const location = await one(env, 'SELECT * FROM locations WHERE id = ?', callsCancelMatch[1]);
      if (!location) return fail(404, 'Точка не найдена');
      const data = await body(request);
      const result = await cancelShiftCall(env, actor, location, String(data.key || ''));
      if (result.error) return result.error;
      return json({ ok: true, scene: result.scene });
    }

    const employeeMatch = /^\/api\/employees\/(\d+)$/.exec(path);
    if (employeeMatch && method === 'PATCH') return updateEmployee(request, env, actor, Number(employeeMatch[1]));

    if (path === '/api/invites' && method === 'POST') return createInvite(request, env, actor);
    if (inviteLookup && method === 'DELETE') {
      const invite = await one(env, 'SELECT * FROM invites WHERE code = ?', inviteLookup[1].toUpperCase());
      if (!invite) return fail(404, 'Приглашение не найдено');
      if (actor.rank !== 'owner' && invite.created_by !== actor.id) return fail(403, 'Можно отозвать только своё приглашение');
      await run(env, 'UPDATE invites SET revoked_at = ? WHERE code = ?', nowIso(), invite.code);
      return json({ ok: true });
    }
    if (inviteLookup && method === 'GET') {
      const invite = await one(env, 'SELECT * FROM invites WHERE code = ?', inviteLookup[1].toUpperCase());
      if (!invite) return fail(404, 'Приглашение не найдено');
      return json({ ok: true, invite: inviteView(invite, await locations(env)) });
    }

    if (path === '/api/punches' && method === 'POST') {
      const data = await body(request);
      return clockAction(env, actor, data, actor);
    }
    if (path === '/api/timesheet' && method === 'GET') return json({ ok: true, rows: await timesheet(env, actor, url.searchParams) });

    /* Website master catalog: Publish bumps the sync version and stamps the
       time; the public endpoint serves whatever is flagged catalog_published.
       The consumer (mangal-web) polls the version — its code is not here. */
    if (path === '/api/catalog/publish' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Каталог публикует управляющий и выше');
      const current = await catalogSettings(env);
      const version = current.version + 1;
      const publishedAt = nowIso();
      await setSetting(env, 'catalogVersion', String(version));
      await setSetting(env, 'catalogPublishedAt', publishedAt);
      const count = await one(env, 'SELECT COUNT(*) AS n FROM menu_items WHERE catalog_published = 1 AND active = 1');
      return json({ ok: true, version, publishedAt, items: Number(count?.n || 0) });
    }

    /* Menu */
    if (path === '/api/menu' && method === 'GET') return json({ ok: true, menu: await menuWithRecipes(env) });
    if (path === '/api/menu' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Меню изменяет управляющий и выше');
      const data = await body(request);
      if (!String(data.name || '').trim()) return fail(400, 'Укажите название блюда');
      const priceCents = Math.round(Number(data.price || 0) * 100);
      if (!(priceCents >= 0)) return fail(400, 'Проверьте цену');
      const code = /^[a-z0-9][a-z0-9-]{1,60}$/.test(String(data.code || '')) ? String(data.code) : null;
      const result = await run(env, `INSERT INTO menu_items(code, name, name_en, category, price_cents, sort_order, description_en, photo_url, tags, calories, protein_g, catalog_published, catalog_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        code, String(data.name).trim(), String(data.nameEn || ''), String(data.category || ''), priceCents, Number(data.sort || 0),
        String(data.descriptionEn || '').trim(), String(data.photoUrl || '').trim().slice(0, 1000), tagsToStore(data.tags),
        data.calories === undefined || data.calories === '' || data.calories === null ? null : Math.max(0, Math.round(Number(data.calories) || 0)),
        data.proteinG === undefined || data.proteinG === '' || data.proteinG === null ? null : Math.max(0, Number(data.proteinG) || 0),
        data.catalogPublished ? 1 : 0, nowIso());
      const newId = result.meta?.last_row_id;
      await saveCloverBindings(env, newId, data.cloverBindings);
      return json({ ok: true, id: newId }, 201);
    }
    const menuMatch = /^\/api\/menu\/(\d+)$/.exec(path);
    if (menuMatch && method === 'PATCH') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Меню изменяет управляющий и выше');
      const item = await one(env, 'SELECT * FROM menu_items WHERE id = ?', menuMatch[1]);
      if (!item) return fail(404, 'Позиция не найдена');
      const data = await body(request);
      let photoJpeg = item.photo_jpeg ?? null;
      if (data.clearPhoto) photoJpeg = null;
      if (data.photoData !== undefined && data.photoData !== null && data.photoData !== '') {
        photoJpeg = normalizePhotoJpeg(data.photoData);
        if (!photoJpeg) return fail(400, 'Не удалось прочитать фото — нужен JPEG до ~700 КБ');
      }
      const catalogTouched = ['descriptionEn', 'photoUrl', 'photoData', 'clearPhoto', 'tags', 'calories', 'proteinG', 'catalogPublished', 'cloverBindings', 'nameEn', 'category']
        .some(key => data[key] !== undefined);
      await run(env, `UPDATE menu_items SET name = ?, name_en = ?, category = ?, price_cents = ?, stopped = ?, active = ?,
        description_en = ?, photo_url = ?, photo_jpeg = ?, tags = ?, calories = ?, protein_g = ?, catalog_published = ?, catalog_updated_at = ? WHERE id = ?`,
        data.name !== undefined ? String(data.name).trim() : item.name,
        data.nameEn !== undefined ? String(data.nameEn) : item.name_en,
        data.category !== undefined ? String(data.category) : item.category,
        data.price !== undefined ? Math.round(Number(data.price) * 100) : item.price_cents,
        data.stopped !== undefined ? (data.stopped ? 1 : 0) : item.stopped,
        data.active !== undefined ? (data.active ? 1 : 0) : item.active,
        data.descriptionEn !== undefined ? String(data.descriptionEn).trim() : (item.description_en || ''),
        data.photoUrl !== undefined ? String(data.photoUrl).trim().slice(0, 1000) : (item.photo_url || ''),
        photoJpeg,
        data.tags !== undefined ? tagsToStore(data.tags) : (item.tags || ''),
        data.calories !== undefined ? (data.calories === null || data.calories === '' ? null : Math.max(0, Math.round(Number(data.calories) || 0))) : (item.calories ?? null),
        data.proteinG !== undefined ? (data.proteinG === null || data.proteinG === '' ? null : Math.max(0, Number(data.proteinG) || 0)) : (item.protein_g ?? null),
        data.catalogPublished !== undefined ? (data.catalogPublished ? 1 : 0) : (item.catalog_published || 0),
        catalogTouched ? nowIso() : (item.catalog_updated_at ?? null),
        menuMatch[1]);
      await saveCloverBindings(env, item.id, data.cloverBindings);
      return json({ ok: true });
    }
    const recipeMatch = /^\/api\/menu\/(\d+)\/recipe$/.exec(path);
    if (recipeMatch && method === 'PUT') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Техкарты изменяет управляющий и выше');
      const item = await one(env, 'SELECT * FROM menu_items WHERE id = ?', recipeMatch[1]);
      if (!item) return fail(404, 'Позиция не найдена');
      const data = await body(request);
      const lines = Array.isArray(data.lines) ? data.lines : [];
      await run(env, 'DELETE FROM recipes WHERE menu_item_id = ?', item.id);
      for (const line of lines) {
        const qty = Number(line.qty);
        if (!line.ingredientId || !(qty > 0)) continue;
        const ingredient = await one(env, 'SELECT id FROM ingredients WHERE id = ?', Number(line.ingredientId));
        if (!ingredient) return fail(400, 'Ингредиент не найден');
        await run(env, 'INSERT INTO recipes(menu_item_id, ingredient_id, qty) VALUES (?, ?, ?)', item.id, ingredient.id, qty);
      }
      return json({ ok: true, costCents: await recipeCostCents(env, item.id) });
    }

    /* Ingredients & stock movements */
    if (path === '/api/ingredients' && method === 'GET') {
      const rows = await all(env, 'SELECT * FROM ingredients WHERE active = 1 ORDER BY name');
      return json({ ok: true, ingredients: rows.map(ingredientView) });
    }
    if (path === '/api/ingredients' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Ингредиенты добавляет управляющий и выше');
      const data = await body(request);
      if (!String(data.name || '').trim()) return fail(400, 'Укажите название ингредиента');
      const result = await run(env, 'INSERT INTO ingredients(name, unit, stock, min_stock, cost_per_unit_cents) VALUES (?, ?, ?, ?, ?)',
        String(data.name).trim(), String(data.unit || 'г'), Number(data.stock || 0), Number(data.minStock || 0),
        Math.round(Number(data.costPerUnit || 0) * 100));
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const ingredientMatch = /^\/api\/ingredients\/(\d+)$/.exec(path);
    if (ingredientMatch && method === 'PATCH') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Ингредиенты изменяет управляющий и выше');
      const row = await one(env, 'SELECT * FROM ingredients WHERE id = ?', ingredientMatch[1]);
      if (!row) return fail(404, 'Ингредиент не найден');
      const data = await body(request);
      await run(env, 'UPDATE ingredients SET name = ?, unit = ?, min_stock = ?, cost_per_unit_cents = ?, active = ? WHERE id = ?',
        data.name !== undefined ? String(data.name).trim() : row.name,
        data.unit !== undefined ? String(data.unit) : row.unit,
        data.minStock !== undefined ? Number(data.minStock) : row.min_stock,
        data.costPerUnit !== undefined ? Math.round(Number(data.costPerUnit) * 100) : row.cost_per_unit_cents,
        data.active !== undefined ? (data.active ? 1 : 0) : row.active,
        ingredientMatch[1]);
      return json({ ok: true });
    }
    if (path === '/api/purchases' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Закупки вносит управляющий и выше');
      const data = await body(request);
      const ingredient = await one(env, 'SELECT * FROM ingredients WHERE id = ?', Number(data.ingredientId));
      if (!ingredient) return fail(404, 'Ингредиент не найден');
      const qty = Number(data.qty);
      if (!(qty > 0)) return fail(400, 'Укажите количество больше нуля');
      const totalCostCents = Math.round(Number(data.totalCost || 0) * 100);
      // Legacy single-line purchase: stored as a one-line document so the
      // document history and the purchases ledger stay consistent.
      const doc = await createPurchaseDocument(env, actor, {
        supplier: String(data.supplier || ''), docDate: data.docDate, note: String(data.note || ''),
        source: 'manual', lines: [{ ingredient, qty, totalCostCents, note: String(data.note || '') }]
      });
      return json({ ok: true, id: doc.lineIds[0], documentId: doc.documentId }, 201);
    }
    if (path === '/api/purchase-documents' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Закупки вносит управляющий и выше');
      const data = await body(request);
      const rawLines = Array.isArray(data.lines) ? data.lines : [];
      if (!rawLines.length) return fail(400, 'Добавьте хотя бы одну строку закупки');
      let photo = null;
      if (data.photoJpeg) {
        photo = normalizePhotoJpeg(data.photoJpeg);
        if (!photo) return fail(400, 'Фото счёта не принято: нужен JPEG до ~700 КБ');
      }
      const preparedResult = await preparePurchaseLines(env, rawLines);
      if (preparedResult.error) return preparedResult.error;
      const prepared = preparedResult.lines;
      const doc = await createPurchaseDocument(env, actor, {
        supplier: String(data.supplier || '').trim(), supplierId: data.supplierId ? Number(data.supplierId) : null,
        docDate: data.docDate, note: String(data.note || ''),
        source: data.source === 'scan' ? 'scan' : 'manual', photoJpeg: photo, lines: prepared
      });
      return json({ ok: true, id: doc.documentId, totalCents: doc.totalCents }, 201);
    }
    if (path === '/api/purchase-documents' && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const rows = await all(env, `SELECT d.id, d.supplier, d.supplier_id, d.doc_date, d.note, d.total_cents, d.source, d.created_at,
          (d.photo_jpeg IS NOT NULL) AS has_photo, e.first_name, e.last_name,
          EXISTS(SELECT 1 FROM invoice_drafts inv WHERE inv.document_id = d.id AND inv.status = 'confirmed') AS email_origin
        FROM purchase_documents d LEFT JOIN employees e ON e.id = d.created_by
        ORDER BY d.id DESC LIMIT 50`);
      const documents = [];
      for (const row of rows) {
        const lines = await all(env, 'SELECT * FROM purchase_lines WHERE document_id = ? ORDER BY id', row.id);
        documents.push({
          id: row.id, supplier: row.supplier, supplierId: row.supplier_id, docDate: row.doc_date, note: row.note,
          total: row.total_cents / 100, totalCents: row.total_cents, source: row.source,
          emailOrigin: Boolean(row.email_origin),
          createdAt: row.created_at, hasPhoto: Boolean(row.has_photo),
          createdByName: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
          lines: lines.map(l => ({ id: l.id, ingredientId: l.ingredient_id, name: l.name, unit: l.unit, qty: l.qty, total: l.total_cost_cents / 100, totalCostCents: l.total_cost_cents }))
        });
      }
      return json({ ok: true, documents });
    }
    const purchasePhoto = /^\/api\/purchase-documents\/(\d+)\/photo$/.exec(path);
    if (purchasePhoto && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const row = await one(env, 'SELECT photo_jpeg FROM purchase_documents WHERE id = ?', purchasePhoto[1]);
      if (!row || !row.photo_jpeg) return fail(404, 'Фото не прикреплено');
      return json({ ok: true, photoJpeg: row.photo_jpeg });
    }

    /* Inbound invoice drafts (email channel): nothing here posts stock by
       itself — confirm converts the draft into a purchase document through
       the same posting code as manual/scan entry. */
    if (path === '/api/invoice-drafts' && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const rows = await all(env, `SELECT d.*, e.first_name AS r_first_name, e.last_name AS r_last_name
        FROM invoice_drafts d LEFT JOIN employees e ON e.id = d.resolved_by
        ORDER BY (d.status = 'pending') DESC, d.id DESC LIMIT 50`);
      return json({ ok: true, drafts: rows.map(row => invoiceDraftView(row)) });
    }
    const draftMatch = /^\/api\/invoice-drafts\/(\d+)$/.exec(path);
    if (draftMatch && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const row = await one(env, `SELECT d.*, e.first_name AS r_first_name, e.last_name AS r_last_name
        FROM invoice_drafts d LEFT JOIN employees e ON e.id = d.resolved_by WHERE d.id = ?`, draftMatch[1]);
      if (!row) return fail(404, 'Черновик не найден');
      return json({ ok: true, draft: invoiceDraftView(row, { withText: true }) });
    }
    const draftPhoto = /^\/api\/invoice-drafts\/(\d+)\/photo$/.exec(path);
    if (draftPhoto && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const row = await one(env, 'SELECT photo_jpeg FROM invoice_drafts WHERE id = ?', draftPhoto[1]);
      if (!row || !row.photo_jpeg) return fail(404, 'Фото не прикреплено');
      return json({ ok: true, photoJpeg: row.photo_jpeg });
    }
    const draftConfirm = /^\/api\/invoice-drafts\/(\d+)\/confirm$/.exec(path);
    if (draftConfirm && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Закупки вносит управляющий и выше');
      const draft = await one(env, 'SELECT * FROM invoice_drafts WHERE id = ?', draftConfirm[1]);
      if (!draft) return fail(404, 'Черновик не найден');
      if (draft.status !== 'pending') return fail(409, 'Черновик уже обработан');
      const data = await body(request);
      const rawLines = Array.isArray(data.lines) ? data.lines : [];
      if (!rawLines.length) return fail(400, 'Добавьте хотя бы одну строку закупки');
      const preparedResult = await preparePurchaseLines(env, rawLines);
      if (preparedResult.error) return preparedResult.error;
      const doc = await createPurchaseDocument(env, actor, {
        supplier: String(data.supplier !== undefined ? data.supplier : draft.supplier || '').trim(),
        supplierId: data.supplierId ? Number(data.supplierId) : null,
        docDate: data.docDate || draft.doc_date, note: String(data.note !== undefined ? data.note : draft.note || ''),
        source: 'manual', photoJpeg: draft.photo_jpeg || null, lines: preparedResult.lines
      });
      await run(env, `UPDATE invoice_drafts SET status = 'confirmed', document_id = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`,
        doc.documentId, actor.id, nowIso(), draft.id);
      return json({ ok: true, id: doc.documentId, totalCents: doc.totalCents }, 201);
    }
    const draftReject = /^\/api\/invoice-drafts\/(\d+)\/reject$/.exec(path);
    if (draftReject && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const draft = await one(env, 'SELECT * FROM invoice_drafts WHERE id = ?', draftReject[1]);
      if (!draft) return fail(404, 'Черновик не найден');
      if (draft.status !== 'pending') return fail(409, 'Черновик уже обработан');
      await run(env, `UPDATE invoice_drafts SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE id = ?`,
        actor.id, nowIso(), draft.id);
      return json({ ok: true });
    }
    if (path === '/api/writeoffs' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Списания вносит управляющий и выше');
      const data = await body(request);
      const ingredient = await one(env, 'SELECT * FROM ingredients WHERE id = ?', Number(data.ingredientId));
      if (!ingredient) return fail(404, 'Ингредиент не найден');
      const qty = Number(data.qty);
      if (!(qty > 0)) return fail(400, 'Укажите количество больше нуля');
      const result = await run(env, 'INSERT INTO writeoffs(ingredient_id, qty, reason, created_by) VALUES (?, ?, ?, ?)',
        ingredient.id, qty, String(data.reason || ''), actor.id);
      await run(env, 'UPDATE ingredients SET stock = stock - ? WHERE id = ?', qty, ingredient.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    if (path === '/api/stocktakes' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Инвентаризацию вносит управляющий и выше');
      const data = await body(request);
      const ingredient = await one(env, 'SELECT * FROM ingredients WHERE id = ?', Number(data.ingredientId));
      if (!ingredient) return fail(404, 'Ингредиент не найден');
      const actual = Number(data.actualQty);
      if (!(actual >= 0)) return fail(400, 'Укажите фактический остаток');
      const diff = actual - Number(ingredient.stock);
      const result = await run(env, 'INSERT INTO stocktakes(ingredient_id, expected_qty, actual_qty, diff, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        ingredient.id, Number(ingredient.stock), actual, diff, String(data.note || ''), actor.id);
      await run(env, 'UPDATE ingredients SET stock = ? WHERE id = ?', actual, ingredient.id);
      return json({ ok: true, id: result.meta?.last_row_id, diff }, 201);
    }
    if (path === '/api/stock-history' && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const purchases = await all(env, `SELECT p.*, i.name AS ingredient_name FROM purchases p JOIN ingredients i ON i.id = p.ingredient_id ORDER BY p.id DESC LIMIT 50`);
      const writeoffs = await all(env, `SELECT w.*, i.name AS ingredient_name FROM writeoffs w JOIN ingredients i ON i.id = w.ingredient_id ORDER BY w.id DESC LIMIT 50`);
      const stocktakes = await all(env, `SELECT s.*, i.name AS ingredient_name FROM stocktakes s JOIN ingredients i ON i.id = s.ingredient_id ORDER BY s.id DESC LIMIT 50`);
      return json({ ok: true, purchases, writeoffs, stocktakes });
    }

    /* Orders */
    if (path === '/api/orders' && method === 'GET') {
      const rows = await all(env, `SELECT * FROM orders WHERE status IN ('new','cooking','ready')
        OR (source = 'clover' AND status = 'served' AND served_at >= ?) ORDER BY created_at DESC LIMIT 100`, startOfNyDay(new Date()).toISOString());
      const list = await orderViews(env, rows);
      return json({ ok: true, orders: list });
    }
    if (path === '/api/orders' && method === 'POST') return createOrder(request, env, actor);
    const orderMatch = /^\/api\/orders\/(\d+)$/.exec(path);
    if (orderMatch && method === 'GET') {
      const order = await one(env, 'SELECT * FROM orders WHERE id = ?', orderMatch[1]);
      if (!order) return fail(404, 'Заказ не найден');
      return json({ ok: true, order: await orderView(env, order) });
    }
    const orderStatus = /^\/api\/orders\/(\d+)\/status$/.exec(path);
    if (orderStatus && method === 'POST') return setOrderStatus(request, env, actor, Number(orderStatus[1]));

    /* Finance: PnL + DR-15 (manager+; labor money and EBITDA owner-only
       inside the payload), operating expenses, suppliers registry. */
    if (path === '/api/finance/pnl' && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Финансы видит управляющий и выше');
      return json({ ok: true, pnl: await buildPnl(env, actor, url.searchParams) });
    }
    if (path === '/api/finance/dr15' && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Финансы видит управляющий и выше');
      return json({ ok: true, dr15: await buildDr15(env, url.searchParams) });
    }
    if (path === '/api/expenses' && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : '0000-01-01';
      const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : '9999-12-31';
      const rows = await all(env, `SELECT x.*, e.first_name, e.last_name FROM expense_entries x
        LEFT JOIN employees e ON e.id = x.created_by
        WHERE x.expense_date >= ? AND x.expense_date <= ? ORDER BY x.expense_date DESC, x.id DESC LIMIT 200`, from, to);
      return json({ ok: true, expenses: rows.map(r => ({
        id: r.id, locationId: r.location_id, category: r.category, amount: r.amount_cents / 100,
        date: r.expense_date, note: r.note || '', createdByName: `${r.first_name || ''} ${r.last_name || ''}`.trim()
      })) });
    }
    if (path === '/api/expenses' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Расходы вносит управляющий и выше');
      const data = await body(request);
      const category = EXPENSE_CATEGORIES.includes(data.category) ? data.category : null;
      if (!category) return fail(400, 'Неизвестная категория расхода');
      const amountCents = Math.round(Number(data.amount || 0) * 100);
      if (!(amountCents > 0)) return fail(400, 'Укажите сумму больше нуля');
      let locationId = null;
      if (data.locationId) {
        const loc = await one(env, 'SELECT id FROM locations WHERE id = ?', Number(data.locationId));
        if (!loc) return fail(400, 'Точка не найдена');
        locationId = loc.id;
      }
      const date = data.date ? validDocDate(data.date) : nyDateKey(new Date());
      const result = await run(env, 'INSERT INTO expense_entries(location_id, category, amount_cents, expense_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        locationId, category, amountCents, date, String(data.note || ''), actor.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const expenseMatch = /^\/api\/expenses\/(\d+)$/.exec(path);
    if (expenseMatch && method === 'DELETE') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      await run(env, 'DELETE FROM expense_entries WHERE id = ?', expenseMatch[1]);
      return json({ ok: true });
    }
    if (path === '/api/suppliers' && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Поставщиков видит управляющий и выше');
      return json({ ok: true, suppliers: await listSuppliers(env) });
    }
    if (path === '/api/suppliers' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Поставщиков добавляет управляющий и выше');
      const data = await body(request);
      const name = String(data.name || '').trim();
      if (!name) return fail(400, 'Укажите название поставщика');
      if (await findSupplierByName(env, name)) return fail(409, 'Поставщик с таким названием уже есть');
      const result = await run(env, 'INSERT INTO suppliers(name, contact_name, phone, email, note) VALUES (?, ?, ?, ?, ?)',
        name, String(data.contactName || '').trim(), String(data.phone || '').trim(), String(data.email || '').trim(), String(data.note || '').trim());
      const newId = result.meta?.last_row_id;
      // Adopt invoices that were entered before the card existed (same
      // backfill rule as migration 0007, applied at card-creation time;
      // matched in JS because SQLite lower() does not fold Cyrillic).
      const orphans = await all(env, "SELECT id, supplier FROM purchase_documents WHERE supplier_id IS NULL AND TRIM(supplier) <> ''");
      for (const doc of orphans) {
        if (String(doc.supplier || '').trim().toLowerCase() === name.toLowerCase()) {
          await run(env, 'UPDATE purchase_documents SET supplier_id = ? WHERE id = ?', newId, doc.id);
        }
      }
      const row = await one(env, 'SELECT * FROM suppliers WHERE id = ?', newId);
      return json({ ok: true, supplier: supplierView(row, await supplierAggregates(env, row.id)) }, 201);
    }
    const supplierMatch = /^\/api\/suppliers\/(\d+)$/.exec(path);
    if (supplierMatch && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const row = await one(env, 'SELECT * FROM suppliers WHERE id = ?', supplierMatch[1]);
      if (!row) return fail(404, 'Поставщик не найден');
      const documents = await all(env, `SELECT d.id, d.supplier, d.doc_date, d.note, d.total_cents, d.source, d.created_at,
          (d.photo_jpeg IS NOT NULL) AS has_photo FROM purchase_documents d WHERE d.supplier_id = ? ORDER BY d.id DESC LIMIT 100`, row.id);
      const payments = await all(env, `SELECT p.*, e.first_name, e.last_name FROM supplier_payments p
        LEFT JOIN employees e ON e.id = p.created_by WHERE p.supplier_id = ? ORDER BY p.paid_date DESC, p.id DESC`, row.id);
      return json({ ok: true,
        supplier: supplierView(row, await supplierAggregates(env, row.id)),
        documents: documents.map(d => ({ id: d.id, supplier: d.supplier, docDate: d.doc_date, note: d.note, total: d.total_cents / 100, source: d.source, createdAt: d.created_at, hasPhoto: Boolean(d.has_photo) })),
        payments: payments.map(p => ({ id: p.id, amount: p.amount_cents / 100, paidDate: p.paid_date, method: p.method || '', note: p.note || '', createdByName: `${p.first_name || ''} ${p.last_name || ''}`.trim(), createdAt: p.created_at }))
      });
    }
    if (supplierMatch && method === 'PATCH') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const row = await one(env, 'SELECT * FROM suppliers WHERE id = ?', supplierMatch[1]);
      if (!row) return fail(404, 'Поставщик не найден');
      const data = await body(request);
      if (data.name !== undefined && String(data.name).trim() && String(data.name).trim().toLowerCase() !== row.name.toLowerCase()) {
        const duplicate = await findSupplierByName(env, String(data.name).trim());
        if (duplicate && Number(duplicate.id) !== Number(row.id)) return fail(409, 'Поставщик с таким названием уже есть');
      }
      await run(env, 'UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, email = ?, note = ?, active = ? WHERE id = ?',
        data.name !== undefined ? String(data.name).trim() : row.name,
        data.contactName !== undefined ? String(data.contactName).trim() : row.contact_name,
        data.phone !== undefined ? String(data.phone).trim() : row.phone,
        data.email !== undefined ? String(data.email).trim() : row.email,
        data.note !== undefined ? String(data.note).trim() : row.note,
        data.active !== undefined ? (data.active ? 1 : 0) : row.active,
        row.id);
      const updated = await one(env, 'SELECT * FROM suppliers WHERE id = ?', row.id);
      return json({ ok: true, supplier: supplierView(updated, await supplierAggregates(env, row.id)) });
    }
    const supplierPayment = /^\/api\/suppliers\/(\d+)\/payments$/.exec(path);
    if (supplierPayment && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Оплаты отмечает управляющий и выше');
      const row = await one(env, 'SELECT * FROM suppliers WHERE id = ?', supplierPayment[1]);
      if (!row) return fail(404, 'Поставщик не найден');
      const data = await body(request);
      const amountCents = Math.round(Number(data.amount || 0) * 100);
      if (!(amountCents > 0)) return fail(400, 'Укажите сумму оплаты больше нуля');
      const date = data.date ? validDocDate(data.date) : nyDateKey(new Date());
      const result = await run(env, 'INSERT INTO supplier_payments(supplier_id, amount_cents, paid_date, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        row.id, amountCents, date, String(data.method || '').trim(), String(data.note || '').trim(), actor.id);
      return json({ ok: true, id: result.meta?.last_row_id, supplier: supplierView(row, await supplierAggregates(env, row.id)) }, 201);
    }
    const supplierPaymentDel = /^\/api\/suppliers\/(\d+)\/payments\/(\d+)$/.exec(path);
    if (supplierPaymentDel && method === 'DELETE') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      await run(env, 'DELETE FROM supplier_payments WHERE id = ? AND supplier_id = ?', supplierPaymentDel[2], supplierPaymentDel[1]);
      return json({ ok: true });
    }

    /* Disputes: financial registry — manager+ only, like purchase docs. */
    if (path === '/api/disputes' && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Споры видит управляющий и выше');
      return json({ ok: true, ...(await listDisputes(env, actor, url.searchParams)) });
    }
    if (path === '/api/disputes' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Споры заводит управляющий и выше');
      const result = await createDispute(env, actor, await body(request));
      if (result.error) return result.error;
      const locationRows = await locations(env, true);
      const employeeRows = await all(env, 'SELECT id, first_name, last_name FROM employees');
      return json({ ok: true, dispute: disputeView(result.row, locationRows, employeeRows) }, 201);
    }
    if (path === '/api/disputes/import' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Импорт споров — управляющий и выше');
      const result = await importDisputesCsv(env, actor, await body(request));
      if (result.error) return result.error;
      return json({ ok: true, ...result });
    }
    const disputeEvidence = /^\/api\/disputes\/(\d+)\/evidence$/.exec(path);
    if (disputeEvidence && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const dispute = await one(env, 'SELECT * FROM disputes WHERE id = ?', disputeEvidence[1]);
      if (!dispute) return fail(404, 'Спор не найден');
      return json({ ok: true, evidence: await buildDisputeEvidence(env, dispute) });
    }
    const disputeMatch = /^\/api\/disputes\/(\d+)$/.exec(path);
    if (disputeMatch && method === 'GET') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const dispute = await one(env, 'SELECT * FROM disputes WHERE id = ?', disputeMatch[1]);
      if (!dispute) return fail(404, 'Спор не найден');
      const locationRows = await locations(env, true);
      const employeeRows = await all(env, 'SELECT id, first_name, last_name FROM employees');
      return json({ ok: true, dispute: disputeView(dispute, locationRows, employeeRows) });
    }
    if (disputeMatch && method === 'PATCH') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Споры изменяет управляющий и выше');
      const result = await updateDispute(env, actor, Number(disputeMatch[1]), await body(request));
      if (result.error) return result.error;
      const locationRows = await locations(env, true);
      const employeeRows = await all(env, 'SELECT id, first_name, last_name FROM employees');
      return json({ ok: true, dispute: disputeView(result.row, locationRows, employeeRows) });
    }

    return fail(404, 'Не найдено');
  } catch (error) {
    console.error(error);
    return fail(500, 'Внутренняя ошибка');
  }
}
