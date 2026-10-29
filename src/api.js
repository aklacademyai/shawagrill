import {
  TIME_ZONE,
  addUtcDays,
  isWeeklyPublicationMoment,
  nyDateKey,
  nyParts,
  previousWeekRange,
  startOfNyDay,
  weekRangeFromKey,
  weekStartNy
} from './time.js';

export const RANK_LEVEL = { staff: 1, lead: 2, manager: 3, director: 4, owner: 5 };
export const RANK_LABEL = {
  staff: 'Сотрудник',
  lead: 'Старший смены',
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
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
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
async function hashPin(pin) {
  if (!pin) return null;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$100000$${bytesToHex(salt)}$${bytesToHex(bits)}`;
}
async function verifyPin(pin, stored) {
  if (!stored) return !pin;
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = hexToBytes(parts[2]);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return bytesToHex(bits) === parts[3];
}

export function rankForPosition(position) {
  const value = String(position || '').trim().toLowerCase();
  if (value === 'директор') return 'director';
  if (value === 'менеджер' || value === 'управляющий') return 'manager';
  if (value === 'шеф-повар' || value === 'старший смены') return 'lead';
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
  // The rate is deliberately absent, not merely hidden by the UI, for every non-owner.
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

async function ensureStandardChannels(env) {
  const standards = [
    ['Вся команда', 1], ['Старшие смены', 2], ['Управляющие', 3], ['Руководство', 4], ['Владелец', 5]
  ];
  for (const [name, minRank] of standards) {
    await run(env, `INSERT INTO chat_channels(name, location_id, min_rank)
      SELECT ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM chat_channels WHERE name = ? AND location_id IS NULL)`, name, minRank, name);
  }
}

async function employeeById(env, id) { return one(env, 'SELECT * FROM employees WHERE id = ?', Number(id)); }
async function locations(env) {
  const rows = await all(env, 'SELECT * FROM locations WHERE active = 1 ORDER BY sort_order, id');
  return rows.map(r => ({ id: r.id, name: r.name, address: r.address, sort: r.sort_order, active: Boolean(r.active) }));
}

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
      from: env.MAIL_FROM || 'MyTeam <onboarding@resend.dev>',
      to: [to],
      subject: `Код подтверждения MyTeam: ${code}`,
      text: `Ваш код подтверждения для регистрации в MyTeam${companyName ? ` (${companyName})` : ''}: ${code}\n\nКод действует 10 минут. Если вы не регистрировались в MyTeam, просто проигнорируйте это письмо.`
    })
  });
  if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
}

// Shared registration validation: names/contact format, duplicate check and
// invite/company resolution — the same rules register() always enforced.
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
  let companyName = null;
  if (isFirst) {
    rank = 'owner';
    position = 'Владелец';
    companyName = data.companyName ? String(data.companyName).trim() : null;
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
  return { firstName, lastName, contact, isFirst, rank, position, locationId, invite, companyName };
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
    inviteCode: resolved.invite ? resolved.invite.code : null,
    companyName: resolved.companyName
  };
  await run(env, 'INSERT INTO pending_registrations(id, payload, code_hash, expires_at) VALUES (?, ?, ?, ?)',
    id, JSON.stringify(payload), await hashPin(code), new Date(Date.now() + 10 * 60 * 1000).toISOString());
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
  if (!(await verifyPin(String(data.code || '').trim(), pending.code_hash))) {
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
    await hashPin(code), new Date(Date.now() + 10 * 60 * 1000).toISOString(), pending.id);
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
  const passwordHash = await hashPin(password);
  let result;
  try {
    result = await run(env, `INSERT INTO employees(first_name, last_name, phone, email, pin_hash, password_hash, rank, position, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, payload.firstName, payload.lastName, contact.phone, contact.email, null, passwordHash, payload.rank, payload.position, payload.locationId);
  } catch {
    return fail(409, 'Такой телефон или email уже зарегистрирован — войдите');
  }
  const employeeId = result.meta?.last_row_id;
  if (invite) await run(env, 'UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?', employeeId, nowIso(), invite.code);
  if (payload.companyName) await setSetting(env, 'companyName', payload.companyName);
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
  if (resolved.companyName) await setSetting(env, 'companyName', resolved.companyName);
  if (contact.email && mailConfigured(env)) {
    return fail(400, 'Для регистрации по email сначала подтвердите адрес кодом из письма');
  }

  const password = String(data.password || '');
  if (password.length < 6) return fail(400, 'Придумайте пароль — минимум 6 символов');
  const passwordHash = await hashPin(password);
  const pinHash = await hashPin(data.pin || '');
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
    if (!(await verifyPin(data.password, employee.password_hash))) return fail(401, 'Неверный пароль');
  } else if (employee.pin_hash) {
    const provided = data.pin || data.password;
    if (!provided) return json({ ok: false, needsPin: true, error: 'Введите PIN' }, 401);
    if (!(await verifyPin(provided, employee.pin_hash))) return fail(401, 'Неверный PIN');
  }
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
      from: env.MAIL_FROM || 'MyTeam <onboarding@resend.dev>',
      to: [to],
      subject: `Сброс пароля MyTeam: ${code}`,
      text: `Код для сброса пароля в MyTeam${companyName ? ` (${companyName})` : ''}: ${code}\n\nКод действует 10 минут. Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо — пароль останется прежним.`
    })
  });
  if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
}

async function sendSmsCode(env, to, code) {
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: `MyTeam: код сброса пароля ${code}. Действует 10 минут.` });
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
    employee.id, channel, target, await hashPin(code), new Date(Date.now() + 10 * 60 * 1000).toISOString(), nowIso());
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
  if (!(await verifyPin(String(data.code || '').trim(), row.code_hash))) {
    await run(env, 'UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return fail(401, 'Неверный код');
  }
  await run(env, 'UPDATE employees SET password_hash = ? WHERE id = ?', await hashPin(newPassword), employee.id);
  await run(env, 'UPDATE password_reset_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
  await run(env, 'DELETE FROM sessions WHERE employee_id = ?', employee.id);
  const token = await createSession(env, employee.id);
  return json({ ok: true, token, employee: publicEmployee(employee, employee), companyName: await getSetting(env, 'companyName') });
}

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
    if (data.pin !== undefined) assign('pin_hash', await hashPin(data.pin));
    if (data.password !== undefined) {
      const newPassword = String(data.password || '');
      if (newPassword.length < 6) return fail(400, 'Пароль — минимум 6 символов');
      assign('password_hash', await hashPin(newPassword));
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
  if (RANK_LEVEL[rank] <= RANK_LEVEL.manager && locationId && !(await one(env, 'SELECT id FROM locations WHERE id = ?', locationId))) {
    return fail(400, 'Точка не найдена');
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => alphabet[b % alphabet.length]).join('');
  const code = `MT-${pick(4)}-${pick(4)}`;
  await run(env, 'INSERT INTO invites(code, created_by, rank, position, location_id, contact, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    code, actor.id, rank, position, locationId, boundContact, data.expiresAt || null);
  const row = await one(env, 'SELECT * FROM invites WHERE code = ?', code);
  return json({ ok: true, invite: inviteView(row, await locations(env)) }, 201);
}

function shiftView(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    locationId: row.location_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    seriesId: row.series_id,
    occurrence: row.occurrence,
    isOpen: Boolean(row.is_open),
    swapStatus: row.swap_status,
    note: row.note || ''
  };
}

async function visibleShifts(env, actor) {
  let rows;
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) {
    rows = await all(env, 'SELECT * FROM shifts ORDER BY starts_at');
  } else if (actor.rank === 'lead') {
    rows = await all(env, 'SELECT * FROM shifts WHERE employee_id = ? OR location_id = ? OR is_open = 1 ORDER BY starts_at', actor.id, actor.location_id);
  } else {
    rows = await all(env, 'SELECT * FROM shifts WHERE employee_id = ? OR (is_open = 1 AND (location_id = ? OR location_id IS NULL)) ORDER BY starts_at', actor.id, actor.location_id);
  }
  return rows.map(shiftView);
}

async function createShift(request, env, actor) {
  if (!requireRank(actor, 'lead')) return fail(403, 'Смены назначает старший смены и выше');
  const data = await body(request);
  const startsAt = new Date(data.startsAt);
  const endsAt = new Date(data.endsAt);
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt) || endsAt <= startsAt) return fail(400, 'Проверьте время смены');
  const employeeId = data.employeeId ? Number(data.employeeId) : null;
  const locationId = data.locationId ? Number(data.locationId) : null;
  if (actor.rank === 'lead' && locationId !== actor.location_id && employeeId !== actor.id) return fail(403, 'Старший смены управляет только своей точкой');
  const duration = endsAt.getTime() - startsAt.getTime();
  let seriesId = null;
  if (data.repeatWeekly) {
    const series = await run(env, 'INSERT INTO shift_series(created_by) VALUES (?)', actor.id);
    seriesId = series.meta?.last_row_id;
  }
  const total = data.repeatWeekly ? Math.max(1, Math.min(52, Number(data.occurrences || 26))) : 1;
  const created = [];
  for (let i = 0; i < total; i += 1) {
    const start = new Date(startsAt.getTime() + i * 7 * 86400000);
    const end = new Date(start.getTime() + duration);
    const result = await run(env, `INSERT INTO shifts(employee_id, location_id, starts_at, ends_at, series_id, occurrence, is_open, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, employeeId, locationId, start.toISOString(), end.toISOString(), seriesId, seriesId ? i : null, employeeId ? 0 : 1, data.note || '', actor.id);
    created.push(result.meta?.last_row_id);
  }
  await generateShiftReminders(env, new Date());
  return json({ ok: true, ids: created, seriesId, count: created.length }, 201);
}

export async function generateShiftReminders(env, now = new Date()) {
  const horizon = new Date(now.getTime() + 2 * 3600000).toISOString();
  const floor = new Date(now.getTime() - 7 * 86400000).toISOString();
  const rows = await all(env, `SELECT * FROM shifts WHERE employee_id IS NOT NULL AND starts_at >= ? AND starts_at <= ?`, floor, horizon);
  let created = 0;
  for (const shift of rows) {
    const start = new Date(shift.starts_at);
    const reminders = [
      ['shift_2h', new Date(start.getTime() - 2 * 3600000), 'Смена через 2 часа'],
      ['shift_1h', new Date(start.getTime() - 3600000), 'Смена через 1 час']
    ];
    for (const [type, due, title] of reminders) {
      const existing = await one(env, 'SELECT id FROM notifications WHERE employee_id = ? AND related_shift_id = ? AND type = ?', shift.employee_id, shift.id, type);
      if (!existing) {
        await run(env, `INSERT INTO notifications(employee_id, type, title, body, related_shift_id, due_at) VALUES (?, ?, ?, ?, ?, ?)`,
          shift.employee_id, type, title, `Начало смены: ${shift.starts_at}`, shift.id, due.toISOString());
        created += 1;
      }
    }
  }
  return created;
}

async function dueNotifications(env, actor) {
  const rows = await all(env, 'SELECT * FROM notifications WHERE employee_id = ? AND due_at <= ? ORDER BY due_at DESC', actor.id, nowIso());
  return rows.map(r => ({ id: r.id, type: r.type, title: r.title, body: r.body, shiftId: r.related_shift_id, dueAt: r.due_at, readAt: r.read_at }));
}

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
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) rows = await all(env, 'SELECT * FROM punches ORDER BY clock_in DESC');
  else if (actor.rank === 'lead') rows = await all(env, 'SELECT * FROM punches WHERE employee_id = ? OR location_id = ? ORDER BY clock_in DESC', actor.id, actor.location_id);
  else rows = await all(env, 'SELECT * FROM punches WHERE employee_id = ? ORDER BY clock_in DESC', actor.id);
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

async function wasShiftAttended(env, shift) {
  const start = new Date(shift.starts_at).getTime();
  const from = new Date(start - 30 * 60000).toISOString();
  const to = new Date(start + 15 * 60000).toISOString();
  const punch = await one(env, `SELECT id FROM punches WHERE employee_id = ? AND clock_in >= ? AND clock_in <= ? AND clock_out IS NOT NULL LIMIT 1`,
    shift.employee_id, from, to);
  return Boolean(punch);
}

async function efficiencyForRange(env, employeeId, range) {
  const components = [];
  const shifts = await all(env, 'SELECT * FROM shifts WHERE employee_id = ? AND starts_at >= ? AND starts_at < ?',
    employeeId, range.start.toISOString(), range.end.toISOString());
  if (shifts.length) {
    let attended = 0;
    for (const shift of shifts) if (await wasShiftAttended(env, shift)) attended += 1;
    components.push(attended / shifts.length * 100);
  }
  const tasks = await all(env, `SELECT * FROM tasks WHERE assignee_id = ? AND due_at IS NOT NULL AND due_at < ?`, employeeId, range.end.toISOString());
  if (tasks.length) {
    const onTime = tasks.filter(t => t.status === 'done' && t.completed_at && t.due_at && t.completed_at <= t.due_at).length;
    components.push(onTime / tasks.length * 100);
  }
  if (!components.length) return 100;
  return Math.round(components.reduce((a, b) => a + b, 0) / components.length);
}

async function pointBalance(env, employeeId) {
  const row = await one(env, 'SELECT COALESCE(SUM(points), 0) AS total FROM point_events WHERE employee_id = ?', employeeId);
  return Number(row?.total || 0);
}

async function buildRatings(env, range) {
  const employees = await all(env, 'SELECT * FROM employees WHERE active = 1 ORDER BY last_name, first_name');
  const employeeRatings = [];
  for (const employee of employees) {
    employeeRatings.push({
      employeeId: employee.id,
      name: employeeName(employee),
      position: employee.position || '',
      locationId: employee.location_id,
      points: await pointBalance(env, employee.id),
      efficiency: await efficiencyForRange(env, employee.id, range)
    });
  }
  employeeRatings.sort((a, b) => b.points - a.points || b.efficiency - a.efficiency || a.name.localeCompare(b.name));
  const locationRows = await locations(env);
  const locationRatings = locationRows.map(location => {
    const members = employeeRatings.filter(e => e.locationId === location.id);
    return {
      locationId: location.id,
      name: location.name,
      employeeCount: members.length,
      avgPoints: members.length ? Math.round(members.reduce((s, e) => s + e.points, 0) / members.length * 10) / 10 : 0,
      avgEfficiency: members.length ? Math.round(members.reduce((s, e) => s + e.efficiency, 0) / members.length) : 0
    };
  }).sort((a, b) => b.avgPoints - a.avgPoints || b.avgEfficiency - a.avgEfficiency);
  return { employees: employeeRatings, locations: locationRatings };
}

export async function runWeeklyJob(env, weekKey) {
  const range = weekKey ? weekRangeFromKey(weekKey) : previousWeekRange(new Date());
  const bonus = Number(await getSetting(env, 'weeklyBonusPoints', '10')) || 0;
  const employees = await all(env, 'SELECT * FROM employees WHERE active = 1 AND created_at < ?', range.end.toISOString());
  const violations = await all(env, 'SELECT * FROM violations WHERE occurred_on >= ? AND occurred_on < ?', range.key, nyDateKey(range.end));
  const violatedIds = new Set(violations.map(v => v.employee_id));
  let bonusesAwarded = 0;
  for (const employee of employees) {
    if (violatedIds.has(employee.id)) continue;
    const shifts = await all(env, 'SELECT * FROM shifts WHERE employee_id = ? AND starts_at >= ? AND starts_at < ?', employee.id, range.start.toISOString(), range.end.toISOString());
    let clean = true;
    for (const shift of shifts) {
      if (!(await wasShiftAttended(env, shift))) { clean = false; break; }
    }
    if (!clean || bonus <= 0) continue;
    const existing = await one(env, "SELECT id FROM point_events WHERE employee_id = ? AND type = 'weekly_bonus' AND week_key = ?", employee.id, range.key);
    if (!existing) {
      await run(env, `INSERT INTO point_events(employee_id, points, reason, type, week_key) VALUES (?, ?, ?, 'weekly_bonus', ?)`,
        employee.id, bonus, 'Неделя без нарушений', range.key);
      bonusesAwarded += 1;
    }
  }
  const ratings = await buildRatings(env, range);
  const payload = { weekKey: range.key, weekStart: range.start.toISOString(), weekEnd: range.end.toISOString(), ...ratings };
  await run(env, `INSERT INTO rating_snapshots(week_key, week_start, week_end, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT(week_key) DO UPDATE SET payload = excluded.payload, published_at = CURRENT_TIMESTAMP`,
    range.key, range.start.toISOString(), range.end.toISOString(), JSON.stringify(payload));
  return { ok: true, weekKey: range.key, bonusesAwarded, ratings };
}

export async function extendRecurringShifts(env, now = new Date()) {
  const seriesRows = await all(env, 'SELECT * FROM shift_series WHERE active = 1');
  const target = new Date(now.getTime() + 28 * 86400000);
  let created = 0;
  for (const series of seriesRows) {
    const latest = await one(env, 'SELECT * FROM shifts WHERE series_id = ? ORDER BY occurrence DESC LIMIT 1', series.id);
    if (!latest) continue;
    let occurrence = Number(latest.occurrence || 0);
    let start = new Date(latest.starts_at);
    const duration = new Date(latest.ends_at) - start;
    while (start < target) {
      start = new Date(start.getTime() + 7 * 86400000);
      occurrence += 1;
      const existing = await one(env, 'SELECT id FROM shifts WHERE series_id = ? AND occurrence = ?', series.id, occurrence);
      if (existing) continue;
      await run(env, `INSERT INTO shifts(employee_id, location_id, starts_at, ends_at, series_id, occurrence, is_open, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, latest.employee_id, latest.location_id, start.toISOString(), new Date(start.getTime() + duration).toISOString(),
        series.id, occurrence, latest.is_open, latest.note || '', series.created_by);
      created += 1;
    }
  }
  return created;
}

function parseJsonList(value) {
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

async function buildState(env, actor) {
  await ensureStandardChannels(env);
  const companyName = await getSetting(env, 'companyName');
  const weeklyBonusPoints = Number(await getSetting(env, 'weeklyBonusPoints', '10')) || 10;
  const locationRows = await locations(env);
  const employees = await visibleEmployees(env, actor);
  const shifts = await visibleShifts(env, actor);
  const punches = await visiblePunches(env, actor);
  const notifications = await dueNotifications(env, actor);

  const announcementRows = await all(env, 'SELECT a.*, EXISTS(SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.employee_id = ?) AS is_read FROM announcements a ORDER BY a.created_at DESC', actor.id);
  const announcements = announcementRows.map(r => ({ id: r.id, title: r.title, body: r.body, createdBy: r.created_by, createdAt: r.created_at, read: Boolean(r.is_read) }));
  const pollRows = await all(env, 'SELECT * FROM polls ORDER BY created_at DESC');
  const polls = [];
  for (const poll of pollRows) {
    const options = await all(env, `SELECT o.*, (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id) AS votes FROM poll_options o WHERE o.poll_id = ? ORDER BY o.id`, poll.id);
    const mine = await one(env, 'SELECT option_id FROM poll_votes WHERE poll_id = ? AND employee_id = ?', poll.id, actor.id);
    polls.push({ id: poll.id, question: poll.question, closed: Boolean(poll.closed), createdAt: poll.created_at, myVote: mine?.option_id || null,
      options: options.map(o => ({ id: o.id, text: o.text, votes: Number(o.votes || 0) })) });
  }

  let taskRows;
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) taskRows = await all(env, 'SELECT * FROM tasks ORDER BY COALESCE(due_at, created_at)');
  else taskRows = await all(env, 'SELECT * FROM tasks WHERE assignee_id = ? OR location_id = ? ORDER BY COALESCE(due_at, created_at)', actor.id, actor.location_id);
  const tasks = taskRows.map(r => ({ id: r.id, title: r.title, description: r.description, assigneeId: r.assignee_id, locationId: r.location_id,
    dueAt: r.due_at, status: r.status, checklist: parseJsonList(r.checklist), completedAt: r.completed_at, createdAt: r.created_at }));

  const templates = (await all(env, 'SELECT * FROM checklist_templates ORDER BY name')).map(r => ({ id: r.id, name: r.name, items: parseJsonList(r.items), locationId: r.location_id }));
  let runRows;
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) runRows = await all(env, 'SELECT * FROM checklist_runs ORDER BY created_at DESC');
  else runRows = await all(env, 'SELECT * FROM checklist_runs WHERE employee_id = ? ORDER BY created_at DESC', actor.id);
  const checklistRuns = runRows.map(r => ({ id: r.id, templateId: r.template_id, employeeId: r.employee_id, locationId: r.location_id, items: parseJsonList(r.items), note: r.note, createdAt: r.created_at }));

  const todayNy = nyDateKey(new Date());
  const assignmentRows = await all(env, `SELECT a.*, l.title AS lesson_title, c.title AS course_title
    FROM lesson_assignments a JOIN lessons l ON l.id = a.lesson_id JOIN courses c ON c.id = l.course_id ORDER BY a.id`);
  const assignmentsByLesson = new Map();
  for (const a of assignmentRows) {
    if (!assignmentsByLesson.has(a.lesson_id)) assignmentsByLesson.set(a.lesson_id, []);
    assignmentsByLesson.get(a.lesson_id).push(a);
  }
  const assignmentForActor = (lessonId) => {
    const list = assignmentsByLesson.get(lessonId) || [];
    return list.find(a => a.employee_id === actor.id)
      || list.find(a => a.location_id && actor.location_id && a.location_id === actor.location_id)
      || null;
  };
  const myResultRows = await all(env, 'SELECT * FROM lesson_results WHERE employee_id = ?', actor.id);
  const myResultByLesson = new Map(myResultRows.map(r => [r.lesson_id, r]));
  const myDoneRows = await all(env, 'SELECT lesson_id FROM lesson_progress WHERE employee_id = ?', actor.id);
  const myDoneSet = new Set(myDoneRows.map(r => r.lesson_id));

  const courseRows = await all(env, 'SELECT * FROM courses ORDER BY title');
  const courses = [];
  for (const course of courseRows) {
    const lessons = await all(env, `SELECT l.*, EXISTS(SELECT 1 FROM lesson_progress p WHERE p.lesson_id = l.id AND p.employee_id = ?) AS done,
        (SELECT COUNT(*) FROM lesson_questions q WHERE q.lesson_id = l.id) AS qcount,
        r.watched_at AS r_watched, r.score AS r_score, r.total AS r_total, r.completed_at AS r_completed
      FROM lessons l LEFT JOIN lesson_results r ON r.lesson_id = l.id AND r.employee_id = ?
      WHERE l.course_id = ? ORDER BY l.sort_order, l.id`, actor.id, actor.id, course.id);
    const mapped = lessons.map(l => {
      const isDone = Boolean(l.done) || Boolean(l.r_completed);
      const mine = assignmentForActor(l.id);
      return { id: l.id, title: l.title, content: l.content, videoUrl: l.video_url || '', questionCount: Number(l.qcount || 0), done: Boolean(l.done),
        myResult: (l.r_watched || l.r_score != null || l.r_completed)
          ? { watched: Boolean(l.r_watched), score: l.r_score, total: l.r_total, completedAt: l.r_completed }
          : null,
        assignments: RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager
          ? (assignmentsByLesson.get(l.id) || []).map(a => ({ id: a.id, locationId: a.location_id, employeeId: a.employee_id, dueDate: a.due_date }))
          : undefined,
        myAssignment: mine ? { dueDate: mine.due_date || null, overdue: Boolean(mine.due_date && !isDone && mine.due_date < todayNy) } : null };
    });
    // A lesson with assignments is targeted: staff see it only when assigned to them.
    const visible = RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager
      ? mapped
      : mapped.filter(l => !(assignmentsByLesson.get(l.id) || []).length || assignmentForActor(l.id));
    courses.push({ id: course.id, title: course.title, description: course.description, lessons: visible });
  }

  const myAssignments = [];
  {
    const seen = new Set();
    const collect = (a) => {
      if (seen.has(a.lesson_id)) return;
      seen.add(a.lesson_id);
      const res = myResultByLesson.get(a.lesson_id);
      const completed = Boolean(res?.completed_at) || myDoneSet.has(a.lesson_id);
      myAssignments.push({ assignmentId: a.id, lessonId: a.lesson_id, lessonTitle: a.lesson_title, courseTitle: a.course_title,
        dueDate: a.due_date || null, overdue: Boolean(a.due_date && !completed && a.due_date < todayNy),
        watched: Boolean(res?.watched_at), completed, completedAt: res?.completed_at || null });
    };
    for (const a of assignmentRows) if (a.employee_id === actor.id) collect(a);
    for (const a of assignmentRows) if (a.location_id && actor.location_id && a.location_id === actor.location_id) collect(a);
    myAssignments.sort((x, y) => Number(y.overdue) - Number(x.overdue) || String(x.dueDate || '9999-99-99').localeCompare(String(y.dueDate || '9999-99-99')));
  }

  let assignmentProgress = [];
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) {
    const staffRows = await all(env, 'SELECT id, first_name, last_name, location_id FROM employees WHERE active = 1');
    const allResults = await all(env, 'SELECT * FROM lesson_results');
    const resultByKey = new Map(allResults.map(r => [`${r.lesson_id}:${r.employee_id}`, r]));
    const allDone = await all(env, 'SELECT lesson_id, employee_id FROM lesson_progress');
    const doneSet = new Set(allDone.map(r => `${r.lesson_id}:${r.employee_id}`));
    const byKey = new Map();
    const pushRow = (a, e) => {
      const key = `${a.lesson_id}:${e.id}`;
      const existing = byKey.get(key);
      if (existing && existing.direct) return; // a direct assignment already covers this employee
      const res = resultByKey.get(key);
      const completed = Boolean(res?.completed_at) || doneSet.has(key);
      byKey.set(key, { assignmentId: a.id, direct: Boolean(a.employee_id), lessonId: a.lesson_id, lessonTitle: a.lesson_title, courseTitle: a.course_title,
        employeeId: e.id, employeeName: `${e.first_name} ${e.last_name}`.trim(), locationId: e.location_id,
        dueDate: a.due_date || null, overdue: Boolean(a.due_date && !completed && a.due_date < todayNy), completed,
        watched: Boolean(res?.watched_at), score: res?.score ?? null, total: res?.total ?? null, completedAt: res?.completed_at || null });
    };
    for (const a of assignmentRows) if (a.employee_id) { const e = staffRows.find(x => x.id === a.employee_id); if (e) pushRow(a, e); }
    for (const a of assignmentRows) if (a.location_id) for (const e of staffRows.filter(x => x.location_id === a.location_id)) pushRow(a, e);
    assignmentProgress = [...byKey.values()].sort((x, y) => Number(y.overdue) - Number(x.overdue)
      || String(x.dueDate || '9999-99-99').localeCompare(String(y.dueDate || '9999-99-99')));
  }
  let trainingProgress = [];
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) {
    const rows = await all(env, `SELECT r.*, e.first_name, e.last_name, e.location_id, l.title AS lesson_title, c.title AS course_title
      FROM lesson_results r JOIN employees e ON e.id = r.employee_id
      JOIN lessons l ON l.id = r.lesson_id JOIN courses c ON c.id = l.course_id
      ORDER BY r.updated_at DESC LIMIT 500`);
    trainingProgress = rows.map(r => ({ employeeId: r.employee_id, employeeName: `${r.first_name} ${r.last_name}`.trim(), locationId: r.location_id,
      lessonId: r.lesson_id, lessonTitle: r.lesson_title, courseTitle: r.course_title,
      watched: Boolean(r.watched_at), watchedAt: r.watched_at, score: r.score, total: r.total, completedAt: r.completed_at }));
  }
  const documents = (await all(env, `SELECT d.*, EXISTS(SELECT 1 FROM document_acks a WHERE a.document_id = d.id AND a.employee_id = ?) AS ack
    FROM documents d ORDER BY d.created_at DESC`, actor.id)).map(r => ({ id: r.id, title: r.title, body: r.body, url: r.url, acknowledged: Boolean(r.ack), createdAt: r.created_at }));
  const kb = (await all(env, 'SELECT * FROM kb_articles ORDER BY title')).map(r => ({ id: r.id, title: r.title, body: r.body, updatedAt: r.updated_at }));

  const channelRows = await all(env, 'SELECT * FROM chat_channels WHERE min_rank <= ? ORDER BY min_rank, name', RANK_LEVEL[actor.rank]);
  const channels = channelRows.map(r => ({ id: r.id, name: r.name, locationId: r.location_id, minRank: r.min_rank }));
  let messages = [];
  if (channels.length) {
    const ids = channels.map(c => c.id);
    const rows = await all(env, `SELECT m.*, e.first_name, e.last_name, e.rank FROM chat_messages m JOIN employees e ON e.id = m.employee_id
      WHERE m.channel_id IN (${ids.map(() => '?').join(',')}) ORDER BY m.created_at`, ...ids);
    messages = rows.map(r => ({ id: r.id, channelId: r.channel_id, employeeId: r.employee_id, author: `${r.first_name} ${r.last_name}`.trim(), rank: r.rank, body: r.body, createdAt: r.created_at }));
  }

  let timeoffRows;
  if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) timeoffRows = await all(env, 'SELECT * FROM timeoff_requests ORDER BY created_at DESC');
  else timeoffRows = await all(env, 'SELECT * FROM timeoff_requests WHERE employee_id = ? ORDER BY created_at DESC', actor.id);
  const timeoff = timeoffRows.map(r => ({ id: r.id, employeeId: r.employee_id, type: r.type, startsOn: r.starts_on, endsOn: r.ends_on, reason: r.reason, status: r.status, createdAt: r.created_at }));

  const pointRows = RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager
    ? await all(env, 'SELECT * FROM point_events ORDER BY created_at DESC LIMIT 200')
    : await all(env, 'SELECT * FROM point_events WHERE employee_id = ? ORDER BY created_at DESC LIMIT 100', actor.id);
  const pointEvents = pointRows.map(r => ({ id: r.id, employeeId: r.employee_id, points: r.points, reason: r.reason, type: r.type, actorId: r.actor_id, weekKey: r.week_key, createdAt: r.created_at }));
  const violationRows = RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager
    ? await all(env, 'SELECT * FROM violations ORDER BY occurred_on DESC LIMIT 100')
    : await all(env, 'SELECT * FROM violations WHERE employee_id = ? ORDER BY occurred_on DESC', actor.id);
  const violations = violationRows.map(r => ({ id: r.id, employeeId: r.employee_id, occurredOn: r.occurred_on, reason: r.reason, createdBy: r.created_by }));

  const latestSnapshot = await one(env, 'SELECT * FROM rating_snapshots ORDER BY published_at DESC LIMIT 1');
  const publishedRatings = latestSnapshot ? JSON.parse(latestSnapshot.payload) : null;
  const currentRange = { start: weekStartNy(new Date()), end: addUtcDays(weekStartNy(new Date()), 7) };
  const myEfficiency = await efficiencyForRange(env, actor.id, currentRange);
  const recognitions = pointEvents.filter(e => e.type === 'manual' && e.points > 0);

  const todayStart = startOfNyDay(new Date()).toISOString();
  const todayEnd = addUtcDays(startOfNyDay(new Date()), 1).toISOString();
  const todayPunches = punches.filter(p => p.clockIn >= todayStart && p.clockIn < todayEnd);
  const dashboard = {
    hoursToday: Math.round(todayPunches.reduce((s, p) => s + p.hours, 0) * 100) / 100,
    punchesToday: todayPunches.length,
    shiftsToday: shifts.filter(s => s.startsAt >= todayStart && s.startsAt < todayEnd).length,
    openShifts: shifts.filter(s => s.isOpen).length,
    activeNow: punches.filter(p => !p.clockOut).length,
    pendingTimeoff: timeoff.filter(t => t.status === 'pending').length,
    activeTasks: tasks.filter(t => t.status !== 'done').length,
    overdueTasks: tasks.filter(t => t.status !== 'done' && t.dueAt && t.dueAt < nowIso()).length,
    myPoints: await pointBalance(env, actor.id),
    myEfficiency
  };
  if (actor.rank === 'owner') dashboard.laborCostToday = Math.round(todayPunches.reduce((s, p) => s + (p.cost || 0), 0) * 100) / 100;

  return {
    ok: true,
    companyName,
    weeklyBonusPoints: RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager ? weeklyBonusPoints : undefined,
    timeZone: TIME_ZONE,
    me: publicEmployee(actor, actor),
    locations: locationRows,
    employees,
    invites: [],
    shifts,
    notifications,
    punches,
    tasks,
    announcements,
    polls,
    checklistTemplates: templates,
    checklistRuns,
    courses,
    trainingProgress,
    myAssignments,
    assignmentProgress,
    documents,
    kb,
    channels,
    messages,
    timeoff,
    pointEvents,
    violations,
    recognitions,
    publishedRatings,
    dashboard
  };
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method.toUpperCase();
  try {
    if (path === '/api/bootstrap' && method === 'GET') {
      const count = await one(env, 'SELECT COUNT(*) AS count FROM employees');
      return json({ ok: true, companyName: await getSetting(env, 'companyName'), hasOwner: Number(count?.count || 0) > 0, locations: await locations(env), timeZone: TIME_ZONE });
    }
    if (path === '/api/auth/register' && method === 'POST') return register(request, env);
    if (path === '/api/auth/register/start' && method === 'POST') return registerStart(request, env);
    if (path === '/api/auth/register/verify' && method === 'POST') return registerVerify(request, env);
    if (path === '/api/auth/register/resend' && method === 'POST') return registerResend(request, env);
    if (path === '/api/auth/login' && method === 'POST') return login(request, env);
    if (path === '/api/auth/reset/request' && method === 'POST') return resetRequest(request, env);
    if (path === '/api/auth/reset/confirm' && method === 'POST') return resetConfirm(request, env);
    if (path === '/api/punches/kiosk' && method === 'POST') {
      const data = await body(request);
      const employee = await employeeById(env, data.employeeId);
      if (!employee || !employee.active) return fail(404, 'Сотрудник не найден');
      if (!employee.pin_hash) return fail(400, 'PIN сотрудника не задан');
      if (!(await verifyPin(data.pin, employee.pin_hash))) return fail(401, 'Неверный PIN');
      return clockAction(env, employee, data, employee);
    }
    const inviteLookup = /^\/api\/invites\/([A-Za-z0-9-]+)$/.exec(path);
    if (inviteLookup && method === 'GET' && !request.headers.get('authorization')) {
      const invite = await one(env, 'SELECT * FROM invites WHERE code = ?', inviteLookup[1].toUpperCase());
      if (!invite) return fail(404, 'Приглашение не найдено');
      const locationRows = await locations(env);
      return json({ ok: true, companyName: await getSetting(env, 'companyName'), invite: inviteView(invite, locationRows) });
    }

    const actor = await authenticate(request, env);
    if (!actor) return fail(401, 'Нужно войти');
    if (path === '/api/auth/me' && method === 'GET') return json({ ok: true, employee: publicEmployee(actor, actor), companyName: await getSetting(env, 'companyName') });
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = (request.headers.get('authorization') || '').slice(7);
      await run(env, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
      return json({ ok: true });
    }
    if (path === '/api/state' && method === 'GET') {
      const state = await buildState(env, actor);
      if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) {
        const rows = await all(env, 'SELECT * FROM invites ORDER BY created_at DESC');
        state.invites = rows.filter(r => actor.rank === 'owner' || RANK_LEVEL[r.rank] <= RANK_LEVEL[actor.rank] || r.created_by === actor.id).map(r => inviteView(r, state.locations));
      }
      return json(state);
    }
    if (path === '/api/company' && method === 'POST') {
      if (actor.rank !== 'owner') return fail(403, 'Название компании меняет только владелец');
      const data = await body(request);
      if (!String(data.name || '').trim()) return fail(400, 'Укажите название компании');
      await setSetting(env, 'companyName', String(data.name).trim());
      return json({ ok: true, companyName: String(data.name).trim() });
    }
    if (path === '/api/settings/weekly-bonus' && method === 'POST') {
      if (actor.rank !== 'owner') return fail(403, 'Размер бонуса настраивает владелец');
      const data = await body(request);
      const value = Math.max(0, Math.floor(Number(data.points || 0)));
      await setSetting(env, 'weeklyBonusPoints', value);
      return json({ ok: true, weeklyBonusPoints: value });
    }

    if (path === '/api/locations' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Точки добавляет управляющий и выше');
      const data = await body(request);
      const result = await run(env, 'INSERT INTO locations(name, address, sort_order) VALUES (?, ?, ?)', String(data.name || '').trim(), String(data.address || '').trim(), Number(data.sort || 0));
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const locationMatch = /^\/api\/locations\/(\d+)$/.exec(path);
    if (locationMatch && method === 'PATCH') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Точки изменяет управляющий и выше');
      const data = await body(request);
      await run(env, 'UPDATE locations SET name = ?, address = ?, sort_order = ? WHERE id = ?', data.name, data.address, Number(data.sort || 0), locationMatch[1]);
      return json({ ok: true });
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

    if (path === '/api/shifts' && method === 'POST') return createShift(request, env, actor);
    const shiftMatch = /^\/api\/shifts\/(\d+)$/.exec(path);
    if (shiftMatch && method === 'PATCH') {
      if (!requireRank(actor, 'lead')) return fail(403, 'Недостаточно прав');
      const data = await body(request);
      await run(env, 'UPDATE shifts SET employee_id = ?, location_id = ?, starts_at = ?, ends_at = ?, note = ? WHERE id = ?',
        data.employeeId || null, data.locationId || null, data.startsAt, data.endsAt, data.note || '', shiftMatch[1]);
      return json({ ok: true });
    }
    if (shiftMatch && method === 'DELETE') {
      if (!requireRank(actor, 'lead')) return fail(403, 'Недостаточно прав');
      await run(env, 'DELETE FROM shifts WHERE id = ?', shiftMatch[1]);
      return json({ ok: true });
    }
    const shiftClaim = /^\/api\/shifts\/(\d+)\/claim$/.exec(path);
    if (shiftClaim && method === 'POST') {
      const shift = await one(env, 'SELECT * FROM shifts WHERE id = ?', shiftClaim[1]);
      if (!shift?.is_open) return fail(404, 'Открытая смена не найдена');
      await run(env, 'UPDATE shifts SET employee_id = ?, is_open = 0 WHERE id = ?', actor.id, shift.id);
      return json({ ok: true });
    }
    const seriesStop = /^\/api\/shifts\/(\d+)\/stop-series$/.exec(path);
    if (seriesStop && method === 'POST') {
      if (!requireRank(actor, 'lead')) return fail(403, 'Недостаточно прав');
      const shift = await one(env, 'SELECT * FROM shifts WHERE id = ?', seriesStop[1]);
      if (!shift?.series_id) return fail(400, 'Смена не входит в серию');
      await run(env, 'UPDATE shift_series SET active = 0 WHERE id = ?', shift.series_id);
      await run(env, 'DELETE FROM shifts WHERE series_id = ? AND starts_at > ?', shift.series_id, nowIso());
      return json({ ok: true });
    }

    if (path === '/api/jobs/reminders' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      const extended = await extendRecurringShifts(env, new Date());
      const reminders = await generateShiftReminders(env, new Date());
      return json({ ok: true, extended, reminders });
    }
    if (path === '/api/jobs/weekly' && method === 'POST') {
      if (actor.rank !== 'owner') return fail(403, 'Недельный цикл запускает владелец');
      const data = await body(request);
      return json(await runWeeklyJob(env, data.weekKey || undefined));
    }
    if (path === '/api/notifications' && method === 'GET') return json({ ok: true, notifications: await dueNotifications(env, actor) });
    const notificationRead = /^\/api\/notifications\/(\d+)\/read$/.exec(path);
    if (notificationRead && method === 'POST') {
      await run(env, 'UPDATE notifications SET read_at = ? WHERE id = ? AND employee_id = ?', nowIso(), notificationRead[1], actor.id);
      return json({ ok: true });
    }

    if (path === '/api/punches' && method === 'POST') {
      const data = await body(request);
      return clockAction(env, actor, data, actor);
    }
    if (path === '/api/timesheet' && method === 'GET') return json({ ok: true, rows: await timesheet(env, actor, url.searchParams) });

    if (path === '/api/points/award' && method === 'POST') {
      const data = await body(request);
      const points = Math.trunc(Number(data.points || 0));
      if (!points || !String(data.reason || '').trim()) return fail(400, 'Укажите поинты и причину');
      if (points > 0 && !requireRank(actor, 'manager')) return fail(403, 'Награды выдаёт управляющий и выше');
      if (points < 0 && actor.rank !== 'owner') return fail(403, 'Списывать поинты может только владелец');
      const target = await employeeById(env, data.employeeId);
      if (!target) return fail(404, 'Сотрудник не найден');
      const result = await run(env, 'INSERT INTO point_events(employee_id, points, reason, type, actor_id) VALUES (?, ?, ?, ?, ?)',
        target.id, points, String(data.reason).trim(), points > 0 ? 'manual' : 'deduction', actor.id);
      return json({ ok: true, id: result.meta?.last_row_id, balance: await pointBalance(env, target.id) }, 201);
    }
    if (path === '/api/violations' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Замечания добавляет управляющий и выше');
      const data = await body(request);
      if (!data.employeeId || !String(data.reason || '').trim()) return fail(400, 'Укажите сотрудника и причину');
      const occurredOn = data.occurredOn || nyDateKey(new Date());
      const result = await run(env, 'INSERT INTO violations(employee_id, occurred_on, reason, created_by) VALUES (?, ?, ?, ?)', data.employeeId, occurredOn, String(data.reason).trim(), actor.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    if (path === '/api/ratings' && method === 'GET') {
      const latest = await one(env, 'SELECT * FROM rating_snapshots ORDER BY published_at DESC LIMIT 1');
      const range = { start: weekStartNy(new Date()), end: addUtcDays(weekStartNy(new Date()), 7) };
      const result = { ok: true, myPoints: await pointBalance(env, actor.id), myEfficiency: await efficiencyForRange(env, actor.id, range), published: latest ? JSON.parse(latest.payload) : null };
      if (RANK_LEVEL[actor.rank] >= RANK_LEVEL.manager) result.live = await buildRatings(env, range);
      return json(result);
    }

    // Tasks
    if (path === '/api/tasks' && method === 'POST') {
      const data = await body(request);
      const result = await run(env, `INSERT INTO tasks(title, description, assignee_id, location_id, due_at, checklist, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        String(data.title || '').trim(), data.description || '', data.assigneeId || null, data.locationId || null, data.dueAt || null, JSON.stringify(data.checklist || []), actor.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const taskMatch = /^\/api\/tasks\/(\d+)$/.exec(path);
    if (taskMatch && method === 'PATCH') {
      const data = await body(request);
      const task = await one(env, 'SELECT * FROM tasks WHERE id = ?', taskMatch[1]);
      if (!task) return fail(404, 'Задача не найдена');
      if (RANK_LEVEL[actor.rank] < RANK_LEVEL.manager && task.assignee_id !== actor.id) return fail(403, 'Можно менять только свои задачи');
      const status = data.status || task.status;
      await run(env, 'UPDATE tasks SET title = ?, description = ?, assignee_id = ?, location_id = ?, due_at = ?, status = ?, checklist = ?, completed_at = ?, updated_at = ? WHERE id = ?',
        data.title ?? task.title, data.description ?? task.description, data.assigneeId ?? task.assignee_id, data.locationId ?? task.location_id,
        data.dueAt ?? task.due_at, status, JSON.stringify(data.checklist ?? parseJsonList(task.checklist)), status === 'done' ? (task.completed_at || nowIso()) : null, nowIso(), task.id);
      return json({ ok: true });
    }

    // Feed: announcements and polls
    if (path === '/api/announcements' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Объявления публикует управляющий и выше');
      const data = await body(request);
      const result = await run(env, 'INSERT INTO announcements(title, body, created_by) VALUES (?, ?, ?)', String(data.title || '').trim(), data.body || '', actor.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const announcementRead = /^\/api\/announcements\/(\d+)\/read$/.exec(path);
    if (announcementRead && method === 'POST') {
      await run(env, 'INSERT OR IGNORE INTO announcement_reads(announcement_id, employee_id) VALUES (?, ?)', announcementRead[1], actor.id);
      return json({ ok: true });
    }
    if (path === '/api/polls' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Опросы создаёт управляющий и выше');
      const data = await body(request);
      const options = (data.options || []).map(x => String(x).trim()).filter(Boolean);
      if (!String(data.question || '').trim() || options.length < 2) return fail(400, 'Нужны вопрос и минимум два варианта');
      const result = await run(env, 'INSERT INTO polls(question, created_by) VALUES (?, ?)', String(data.question).trim(), actor.id);
      const pollId = result.meta?.last_row_id;
      for (const option of options) await run(env, 'INSERT INTO poll_options(poll_id, text) VALUES (?, ?)', pollId, option);
      return json({ ok: true, id: pollId }, 201);
    }
    const pollVote = /^\/api\/polls\/(\d+)\/vote$/.exec(path);
    if (pollVote && method === 'POST') {
      const data = await body(request);
      const poll = await one(env, 'SELECT * FROM polls WHERE id = ?', pollVote[1]);
      if (!poll || poll.closed) return fail(400, 'Опрос закрыт');
      await run(env, 'INSERT INTO poll_votes(poll_id, option_id, employee_id) VALUES (?, ?, ?) ON CONFLICT(poll_id, employee_id) DO UPDATE SET option_id = excluded.option_id',
        poll.id, data.optionId, actor.id);
      return json({ ok: true });
    }
    const pollClose = /^\/api\/polls\/(\d+)\/close$/.exec(path);
    if (pollClose && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Недостаточно прав');
      await run(env, 'UPDATE polls SET closed = 1 WHERE id = ?', pollClose[1]);
      return json({ ok: true });
    }

    // Checklists
    if (path === '/api/checklists/templates' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Шаблоны создаёт управляющий и выше');
      const data = await body(request);
      const result = await run(env, 'INSERT INTO checklist_templates(name, items, location_id, created_by) VALUES (?, ?, ?, ?)',
        String(data.name || '').trim(), JSON.stringify(data.items || []), data.locationId || null, actor.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    if (path === '/api/checklists/runs' && method === 'POST') {
      const data = await body(request);
      const result = await run(env, 'INSERT INTO checklist_runs(template_id, employee_id, location_id, items, note) VALUES (?, ?, ?, ?, ?)',
        data.templateId, actor.id, data.locationId || actor.location_id, JSON.stringify(data.items || []), data.note || '');
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }

    // Learning, documents, knowledge base
    const normalizeQuestion = (raw) => {
      const question = String(raw?.question || '').trim();
      const options = Array.isArray(raw?.options) ? raw.options.map(o => String(o).trim()).filter(Boolean) : [];
      const correctIndex = Number(raw?.correctIndex ?? raw?.correct_index ?? 0);
      if (!question || options.length < 2 || options.length > 6 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) return null;
      return { question, options, correctIndex };
    };
    const insertQuestions = async (lessonId, rawList) => {
      const list = Array.isArray(rawList) ? rawList : [];
      let sort = Number((await one(env, 'SELECT COALESCE(MAX(sort_order), -1) AS m FROM lesson_questions WHERE lesson_id = ?', lessonId))?.m ?? -1);
      for (const raw of list) {
        const q = normalizeQuestion(raw);
        if (!q) return false;
        sort += 1;
        await run(env, 'INSERT INTO lesson_questions(lesson_id, question, options, correct_index, sort_order) VALUES (?, ?, ?, ?, ?)',
          lessonId, q.question, JSON.stringify(q.options), q.correctIndex, sort);
      }
      return true;
    };
    if (path === '/api/courses' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Курсы создаёт управляющий и выше');
      const data = await body(request);
      const result = await run(env, 'INSERT INTO courses(title, description, created_by) VALUES (?, ?, ?)', String(data.title || '').trim(), data.description || '', actor.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const lessonCreate = /^\/api\/courses\/(\d+)\/lessons$/.exec(path);
    if (lessonCreate && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Уроки добавляет управляющий и выше');
      const data = await body(request);
      const videoUrl = String(data.videoUrl || '').trim();
      if (videoUrl && !/^https?:\/\//i.test(videoUrl)) return fail(400, 'Ссылка на видео должна начинаться с http:// или https://');
      const result = await run(env, 'INSERT INTO lessons(course_id, title, content, video_url, sort_order) VALUES (?, ?, ?, ?, ?)', lessonCreate[1], String(data.title || '').trim(), data.content || '', videoUrl, Number(data.sort || 0));
      const lessonId = result.meta?.last_row_id;
      if (Array.isArray(data.questions) && data.questions.length) {
        if (!(await insertQuestions(lessonId, data.questions))) return fail(400, 'Проверьте вопросы теста: нужен текст, 2–6 вариантов и отмеченный правильный ответ');
      }
      return json({ ok: true, id: lessonId }, 201);
    }
    // Lesson assignments: target a location or a specific employee, optional due date
    const lessonAssignments = /^\/api\/lessons\/(\d+)\/assignments$/.exec(path);
    if (lessonAssignments && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Назначать уроки может управляющий и выше');
      const lesson = await one(env, 'SELECT id FROM lessons WHERE id = ?', lessonAssignments[1]);
      if (!lesson) return fail(404, 'Урок не найден');
      const data = await body(request);
      const locationId = data.locationId ? Number(data.locationId) : null;
      const employeeId = data.employeeId ? Number(data.employeeId) : null;
      if ((locationId && employeeId) || (!locationId && !employeeId)) return fail(400, 'Укажите точку или сотрудника, но не обоих сразу');
      if (locationId && !(await one(env, 'SELECT id FROM locations WHERE id = ?', locationId))) return fail(400, 'Точка не найдена');
      if (employeeId && !(await one(env, 'SELECT id FROM employees WHERE id = ? AND active = 1', employeeId))) return fail(400, 'Сотрудник не найден');
      let dueDate = data.dueDate ? String(data.dueDate).trim() : null;
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return fail(400, 'Срок — дата в формате ГГГГ-ММ-ДД');
      if (!dueDate) dueDate = null;
      const existing = locationId
        ? await one(env, 'SELECT id FROM lesson_assignments WHERE lesson_id = ? AND location_id = ?', lesson.id, locationId)
        : await one(env, 'SELECT id FROM lesson_assignments WHERE lesson_id = ? AND employee_id = ?', lesson.id, employeeId);
      if (existing) {
        await run(env, 'UPDATE lesson_assignments SET due_date = ? WHERE id = ?', dueDate, existing.id);
        return json({ ok: true, id: existing.id });
      }
      const result = await run(env, 'INSERT INTO lesson_assignments(lesson_id, location_id, employee_id, due_date, assigned_by) VALUES (?, ?, ?, ?, ?)',
        lesson.id, locationId, employeeId, dueDate, actor.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const lessonAssignmentDelete = /^\/api\/lessons\/(\d+)\/assignments\/(\d+)$/.exec(path);
    if (lessonAssignmentDelete && method === 'DELETE') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Снимать назначения может управляющий и выше');
      await run(env, 'DELETE FROM lesson_assignments WHERE id = ? AND lesson_id = ?', lessonAssignmentDelete[2], lessonAssignmentDelete[1]);
      return json({ ok: true });
    }
    const lessonProgress = /^\/api\/lessons\/(\d+)\/progress$/.exec(path);
    if (lessonProgress && method === 'POST') {
      const data = await body(request);
      if (data.done === false) await run(env, 'DELETE FROM lesson_progress WHERE lesson_id = ? AND employee_id = ?', lessonProgress[1], actor.id);
      else await run(env, 'INSERT OR IGNORE INTO lesson_progress(lesson_id, employee_id) VALUES (?, ?)', lessonProgress[1], actor.id);
      return json({ ok: true });
    }
    // Video training: questions, watch confirmation, quiz
    const lessonQuestions = /^\/api\/lessons\/(\d+)\/questions$/.exec(path);
    if (lessonQuestions && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Вопросы добавляет управляющий и выше');
      const lesson = await one(env, 'SELECT id FROM lessons WHERE id = ?', lessonQuestions[1]);
      if (!lesson) return fail(404, 'Урок не найден');
      const data = await body(request);
      if (!(await insertQuestions(lesson.id, [data]))) return fail(400, 'Проверьте вопрос: нужен текст, 2–6 вариантов и отмеченный правильный ответ');
      return json({ ok: true }, 201);
    }
    const lessonQuiz = /^\/api\/lessons\/(\d+)\/quiz$/.exec(path);
    if (lessonQuiz && method === 'GET') {
      const lesson = await one(env, 'SELECT id FROM lessons WHERE id = ?', lessonQuiz[1]);
      if (!lesson) return fail(404, 'Урок не найден');
      const rows = await all(env, 'SELECT id, question, options FROM lesson_questions WHERE lesson_id = ? ORDER BY sort_order, id', lesson.id);
      // Correct answers are never sent to the client.
      return json({ ok: true, questions: rows.map(r => ({ id: r.id, question: r.question, options: parseJsonList(r.options) })) });
    }
    const lessonWatch = /^\/api\/lessons\/(\d+)\/watch$/.exec(path);
    if (lessonWatch && method === 'POST') {
      const lesson = await one(env, 'SELECT id FROM lessons WHERE id = ?', lessonWatch[1]);
      if (!lesson) return fail(404, 'Урок не найден');
      await run(env, `INSERT INTO lesson_results(lesson_id, employee_id, watched_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(lesson_id, employee_id) DO UPDATE SET watched_at = COALESCE(lesson_results.watched_at, excluded.watched_at), updated_at = excluded.updated_at`,
        lesson.id, actor.id, nowIso(), nowIso());
      const qcount = await one(env, 'SELECT COUNT(*) AS c FROM lesson_questions WHERE lesson_id = ?', lesson.id);
      if (!Number(qcount?.c || 0)) {
        // A video lesson without a quiz is complete once watched.
        await run(env, 'UPDATE lesson_results SET completed_at = COALESCE(completed_at, ?) WHERE lesson_id = ? AND employee_id = ?', nowIso(), lesson.id, actor.id);
        await run(env, 'INSERT OR IGNORE INTO lesson_progress(lesson_id, employee_id) VALUES (?, ?)', lesson.id, actor.id);
      }
      return json({ ok: true });
    }
    if (lessonQuiz && method === 'POST') {
      const lesson = await one(env, 'SELECT id FROM lessons WHERE id = ?', lessonQuiz[1]);
      if (!lesson) return fail(404, 'Урок не найден');
      const questions = await all(env, 'SELECT id, correct_index FROM lesson_questions WHERE lesson_id = ? ORDER BY sort_order, id', lesson.id);
      if (!questions.length) return fail(400, 'У этого урока нет теста');
      const resultRow = await one(env, 'SELECT * FROM lesson_results WHERE lesson_id = ? AND employee_id = ?', lesson.id, actor.id);
      if (!resultRow?.watched_at) return fail(400, 'Сначала посмотрите видео и нажмите «Я посмотрел видео»');
      const data = await body(request);
      const answers = Array.isArray(data.answers) ? data.answers : [];
      let score = 0;
      questions.forEach((q, i) => { if (Number(answers[i]) === Number(q.correct_index)) score += 1; });
      const total = questions.length;
      const completed = score === total;
      await run(env, `INSERT INTO lesson_results(lesson_id, employee_id, watched_at, score, total, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lesson_id, employee_id) DO UPDATE SET score = excluded.score, total = excluded.total,
          completed_at = COALESCE(lesson_results.completed_at, excluded.completed_at), updated_at = excluded.updated_at`,
        lesson.id, actor.id, resultRow.watched_at, score, total, completed ? nowIso() : null, nowIso());
      if (completed) await run(env, 'INSERT OR IGNORE INTO lesson_progress(lesson_id, employee_id) VALUES (?, ?)', lesson.id, actor.id);
      return json({ ok: true, score, total, completed });
    }
    if (path === '/api/documents' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Документы добавляет управляющий и выше');
      const data = await body(request);
      const result = await run(env, 'INSERT INTO documents(title, body, url, created_by) VALUES (?, ?, ?, ?)', String(data.title || '').trim(), data.body || '', data.url || '', actor.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const documentAck = /^\/api\/documents\/(\d+)\/ack$/.exec(path);
    if (documentAck && method === 'POST') {
      await run(env, 'INSERT OR IGNORE INTO document_acks(document_id, employee_id) VALUES (?, ?)', documentAck[1], actor.id);
      return json({ ok: true });
    }
    if (path === '/api/kb' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Статьи добавляет управляющий и выше');
      const data = await body(request);
      const result = await run(env, 'INSERT INTO kb_articles(title, body, created_by) VALUES (?, ?, ?)', String(data.title || '').trim(), data.body || '', actor.id);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }

    // Rank chats
    if (path === '/api/channels' && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Каналы создаёт управляющий и выше');
      const data = await body(request);
      const minRank = Math.max(1, Math.min(RANK_LEVEL[actor.rank], Number(data.minRank || 1)));
      const result = await run(env, 'INSERT INTO chat_channels(name, location_id, min_rank) VALUES (?, ?, ?)', String(data.name || '').trim(), data.locationId || null, minRank);
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const channelMessages = /^\/api\/channels\/(\d+)\/messages$/.exec(path);
    if (channelMessages && (method === 'GET' || method === 'POST')) {
      await ensureStandardChannels(env);
      const channel = await one(env, 'SELECT * FROM chat_channels WHERE id = ?', channelMessages[1]);
      if (!channel) return fail(404, 'Канал не найден');
      if (RANK_LEVEL[actor.rank] < Number(channel.min_rank)) return fail(403, 'У вашего ранга нет доступа к этому чату');
      if (method === 'GET') {
        const rows = await all(env, `SELECT m.*, e.first_name, e.last_name, e.rank FROM chat_messages m JOIN employees e ON e.id = m.employee_id
          WHERE m.channel_id = ? ORDER BY m.created_at`, channel.id);
        return json({ ok: true, messages: rows.map(r => ({ id: r.id, channelId: r.channel_id, employeeId: r.employee_id, author: `${r.first_name} ${r.last_name}`.trim(), rank: r.rank, body: r.body, createdAt: r.created_at })) });
      }
      const data = await body(request);
      if (!String(data.body || '').trim()) return fail(400, 'Пустое сообщение');
      const result = await run(env, 'INSERT INTO chat_messages(channel_id, employee_id, body) VALUES (?, ?, ?)', channel.id, actor.id, String(data.body).trim());
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }

    // Time off
    if (path === '/api/timeoff' && method === 'POST') {
      const data = await body(request);
      const result = await run(env, 'INSERT INTO timeoff_requests(employee_id, type, starts_on, ends_on, reason) VALUES (?, ?, ?, ?, ?)',
        actor.id, data.type || 'timeoff', data.startsOn, data.endsOn, data.reason || '');
      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }
    const timeoffDecide = /^\/api\/timeoff\/(\d+)\/decide$/.exec(path);
    if (timeoffDecide && method === 'POST') {
      if (!requireRank(actor, 'manager')) return fail(403, 'Заявки решает управляющий и выше');
      const data = await body(request);
      const status = data.status === 'approved' ? 'approved' : 'rejected';
      await run(env, 'UPDATE timeoff_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', status, actor.id, nowIso(), timeoffDecide[1]);
      return json({ ok: true });
    }

    return fail(404, 'Маршрут API не найден');
  } catch (error) {
    console.error(error);
    return fail(500, `Внутренняя ошибка: ${error.message || 'unknown'}`);
  }
}

export async function runScheduled(env, event = {}) {
  await extendRecurringShifts(env, new Date());
  await generateShiftReminders(env, new Date());
  // Cron expressions are UTC; the actual 07:13 decision is made in America/New_York.
  if (isWeeklyPublicationMoment(new Date())) {
    await runWeeklyJob(env);
  }
}
