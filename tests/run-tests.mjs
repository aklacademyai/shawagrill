#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const snapshot = path.join(root, '../goals/shawa-ceo/hidden_files/myteam-backup-2026-10-22-1251utc.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myteam-prod-test-'));
const db = path.join(tmp, 'test.sqlite');
const port = 18787 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

execFileSync(process.execPath, [path.join(root, 'tools/import-snapshot.mjs'), snapshot, '--db', db, '--force'], { stdio: 'inherit' });
const server = spawn(process.execPath, [path.join(root, 'tools/local-server.mjs'), '--db', db, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${base}/api/bootstrap`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start. Log:\n${serverLog}`);
}
async function req(pathname, { method = 'GET', token = '', body, expected } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (expected !== undefined) assert.equal(response.status, expected, `${method} ${pathname}: ${JSON.stringify(data)}`);
  else assert.ok(response.ok, `${method} ${pathname} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
function nyPreviousWeek() {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date())) parts[p.type] = p.value;
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  const todayUtcNoon = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12);
  const monday = todayUtcNoon - (((weekday + 6) % 7) + 7) * 86400000;
  const key = new Date(monday).toISOString().slice(0, 10);
  const wednesday = new Date(monday + 2 * 86400000).toISOString().slice(0, 10);
  return { key, wednesday };
}

try {
  await waitReady();
  const bootstrap = await req('/api/bootstrap');
  assert.equal(bootstrap.companyName, 'SHAWA GRILL & MANGAL');
  assert.equal(bootstrap.locations.length, 4);
  assert.equal(bootstrap.locations[0].address, '17066 Collins Ave, Sunny Isles Beach, FL 33160');
  assert.equal(bootstrap.locations[1].address, '2929 Biscayne Blvd, Miami, FL 33137');
  assert.equal(bootstrap.locations[2].address, '2630 W Broward Blvd, Ste 105, Fort Lauderdale, FL 33312');
  assert.equal(bootstrap.locations[3].address, '410 NE 1st Ave, Suite 8, Hallandale Beach, FL');

  const ownerLogin = await req('/api/auth/login', { method: 'POST', body: { contact: '+19547161616' } });
  const owner = ownerLogin.token;
  const ownerState = await req('/api/state', { token: owner });
  assert.equal(ownerState.me.rank, 'owner');
  assert.equal(ownerState.punches.length, 2, 'seed owner punches preserved');

  const cookInvite = await req('/api/invites', { method: 'POST', token: owner, body: { position: 'Повар', locationId: 1 } });
  assert.equal(cookInvite.invite.rank, 'staff');
  const cookReg = await req('/api/auth/register', { method: 'POST', body: { firstName: 'Тест', lastName: 'Повар', contact: '+19540000001', pin: '1111', password: 'cookpass', inviteCode: cookInvite.invite.code }, expected: 201 });
  const cook = cookReg.token;
  const cookId = cookReg.employee.id;
  assert.equal(cookReg.employee.position, 'Повар');
  assert.equal(cookReg.employee.locationId, 1);
  assert.equal(cookReg.employee.rank, 'staff');

  const managerInvite = await req('/api/invites', { method: 'POST', token: owner, body: { position: 'Менеджер', locationId: 1 } });
  assert.equal(managerInvite.invite.rank, 'manager');
  const managerReg = await req('/api/auth/register', { method: 'POST', body: { firstName: 'Тест', lastName: 'Менеджер', contact: 'manager@test.local', pin: '2222', password: 'managerpass', inviteCode: managerInvite.invite.code }, expected: 201 });
  const manager = managerReg.token;
  const managerId = managerReg.employee.id;

  await req('/api/invites', { method: 'POST', token: manager, body: { position: 'Директор', rank: 'director', locationId: 1 }, expected: 403 });

  const boundInvite = await req('/api/invites', { method: 'POST', token: owner, body: { position: 'Повар', locationId: 1, contact: 'bound@test.local' } });
  assert.equal(boundInvite.invite.contact, 'bound@test.local');
  await req('/api/auth/register', { method: 'POST', body: { firstName: 'Тест', lastName: 'Чужой', contact: 'other@test.local', password: 'otherpass', inviteCode: boundInvite.invite.code }, expected: 400 });
  const boundReg = await req('/api/auth/register', { method: 'POST', body: { firstName: 'Тест', lastName: 'Свой', contact: 'bound@test.local', password: 'boundpass', inviteCode: boundInvite.invite.code }, expected: 201 });
  assert.equal(boundReg.employee.position, 'Повар');

  // Email-code flow: locally mail is not configured, so /start must fall back
  // to verificationRequired=false; the pending state machine is then driven
  // with a directly inserted row carrying a known code hash.
  const startInvite = await req('/api/invites', { method: 'POST', token: owner, body: { position: 'Повар', locationId: 1 } });
  const startFallback = await req('/api/auth/register/start', { method: 'POST', body: { firstName: 'Тест', lastName: 'Почта', contact: 'start@test.local', inviteCode: startInvite.invite.code } });
  assert.equal(startFallback.verificationRequired, false);

  const codeInvite = await req('/api/invites', { method: 'POST', token: owner, body: { position: 'Повар', locationId: 1 } });
  const salt = crypto.randomBytes(16);
  const codeHash = `pbkdf2$100000$${salt.toString('hex')}$${crypto.pbkdf2Sync('654321', salt, 100000, 32, 'sha256').toString('hex')}`;
  const pendingPayload = JSON.stringify({ firstName: 'Тест', lastName: 'Код', phone: '', email: 'code@test.local', rank: 'staff', position: 'Повар', locationId: 1, inviteCode: codeInvite.invite.code, companyName: null });
  execFileSync('sqlite3', [db, `INSERT INTO pending_registrations(id, payload, code_hash, expires_at) VALUES ('test-pending-1', '${pendingPayload}', '${codeHash}', '2099-01-01T00:00:00.000Z');`]);
  await req('/api/auth/register/verify', { method: 'POST', body: { pendingId: 'test-pending-1', code: '000000' }, expected: 401 });
  await req('/api/auth/register/verify', { method: 'POST', body: { pendingId: 'test-pending-1', code: '654321' } });
  const pendingReg = await req('/api/auth/register', { method: 'POST', body: { pendingId: 'test-pending-1', password: 'pendingpass' }, expected: 201 });
  assert.equal(pendingReg.employee.email, 'code@test.local');
  assert.equal(pendingReg.employee.position, 'Повар');
  assert.equal(pendingReg.employee.hasPassword, true);
  await req('/api/auth/login', { method: 'POST', body: { contact: 'code@test.local', password: 'pendingpass' } });

  await req(`/api/employees/${cookId}`, { method: 'PATCH', token: owner, body: { hourlyRate: 20 } });
  const ownerTeamState = await req('/api/state', { token: owner });
  assert.equal(ownerTeamState.employees.find(e => e.id === cookId).hourlyRate, 20);
  const cookStateRaw = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${cook}` } })).text();
  assert.ok(!cookStateRaw.includes('hourlyRate'), 'non-owner state must not contain hourlyRate');
  assert.ok(!cookStateRaw.includes('"cost"'), 'non-owner state must not contain labor cost');
  const cookState = JSON.parse(cookStateRaw);
  assert.equal(cookState.employees.length, 1, 'staff sees only own team card');
  assert.equal(cookState.locations.length, 4, 'staff sees all locations');

  const award = await req('/api/points/award', { method: 'POST', token: manager, body: { employeeId: cookId, points: 5, reason: 'Отличная смена' } });
  assert.equal(award.balance, 5);
  await req('/api/points/award', { method: 'POST', token: manager, body: { employeeId: cookId, points: -1, reason: 'Нельзя' }, expected: 403 });

  // Backdate test employees in the disposable DB so they belong to the completed test week.
  execFileSync('sqlite3', [db, `UPDATE employees SET created_at = '2026-10-01T00:00:00.000Z' WHERE id IN (${cookId}, ${managerId});`]);
  const { key: weekKey, wednesday } = nyPreviousWeek();
  const shiftStart = `${wednesday}T15:00:00.000Z`;
  const shiftEnd = `${wednesday}T23:00:00.000Z`;
  await req('/api/shifts', { method: 'POST', token: owner, body: { employeeId: cookId, locationId: 1, startsAt: shiftStart, endsAt: shiftEnd } });
  await req('/api/shifts', { method: 'POST', token: owner, body: { employeeId: managerId, locationId: 1, startsAt: shiftStart, endsAt: shiftEnd } });
  for (const [tok, id] of [[cook, cookId], [manager, managerId]]) {
    await req('/api/punches', { method: 'POST', token: tok, body: { action: 'in', at: `${wednesday}T14:55:00.000Z`, locationId: 1 } });
    await req('/api/punches', { method: 'POST', token: tok, body: { action: 'out', at: `${wednesday}T23:05:00.000Z` } });
  }
  await req('/api/violations', { method: 'POST', token: owner, body: { employeeId: managerId, occurredOn: wednesday, reason: 'Тестовое замечание' } });
  const weekly = await req('/api/jobs/weekly', { method: 'POST', token: owner, body: { weekKey } });
  assert.ok(weekly.bonusesAwarded >= 1, 'clean employee receives weekly bonus');
  const cookAfterWeekly = await req('/api/state', { token: cook });
  assert.equal(cookAfterWeekly.dashboard.myPoints, 15, 'cook = manual 5 + weekly bonus 10');
  assert.ok(cookAfterWeekly.pointEvents.some(e => e.type === 'weekly_bonus' && e.weekKey === weekKey));
  const managerAfterWeekly = await req('/api/state', { token: manager });
  assert.ok(!managerAfterWeekly.pointEvents.some(e => e.employeeId === managerId && e.type === 'weekly_bonus'), 'violation cancels weekly bonus');

  const ratings = await req('/api/ratings', { token: cook });
  assert.ok(ratings.published, 'published ratings visible to staff');
  assert.ok(ratings.published.employees.some(e => e.employeeId === cookId));
  assert.ok(ratings.published.locations.some(l => l.name === 'Sunny Isles'));

  const ownerTimesheet = await req('/api/timesheet', { token: owner });
  const cookTimesheet = await req('/api/timesheet', { token: cook });
  const ownerCookRow = ownerTimesheet.rows.find(r => r.employeeId === cookId);
  const cookRow = cookTimesheet.rows.find(r => r.employeeId === cookId);
  assert.ok(ownerCookRow.hours > 8, 'timesheet includes seeded + test hours');
  assert.ok(ownerCookRow.cost > 0, 'owner sees labor cost');
  assert.ok(!('cost' in cookRow), 'cook timesheet has hours only');

  const series = await req('/api/shifts', { method: 'POST', token: owner, body: { employeeId: cookId, locationId: 1, startsAt: '2027-01-04T15:00:00.000Z', endsAt: '2027-01-04T23:00:00.000Z', repeatWeekly: true, occurrences: 4 } });
  assert.equal(series.count, 4);
  const seriesState = await req('/api/state', { token: owner });
  assert.equal(seriesState.shifts.filter(s => s.seriesId === series.seriesId).length, 4);

  const soonStart = new Date(Date.now() + 30 * 60000);
  const soonEnd = new Date(Date.now() + 150 * 60000);
  await req('/api/shifts', { method: 'POST', token: owner, body: { employeeId: cookId, locationId: 1, startsAt: soonStart.toISOString(), endsAt: soonEnd.toISOString() } });
  await req('/api/jobs/reminders', { method: 'POST', token: owner, body: {} });
  const notifications = await req('/api/notifications', { token: cook });
  assert.ok(notifications.notifications.some(n => n.type === 'shift_2h'));
  assert.ok(notifications.notifications.some(n => n.type === 'shift_1h'));

  const task = await req('/api/tasks', { method: 'POST', token: owner, body: { title: 'Проверить холодильник', assigneeId: cookId, locationId: 1, checklist: ['Температура', 'Фото'] } });
  await req(`/api/tasks/${task.id}`, { method: 'PATCH', token: cook, body: { status: 'done' } });
  const announcement = await req('/api/announcements', { method: 'POST', token: owner, body: { title: 'Собрание', body: 'В понедельник в 10:00' } });
  await req(`/api/announcements/${announcement.id}/read`, { method: 'POST', token: cook, body: {} });
  const poll = await req('/api/polls', { method: 'POST', token: owner, body: { question: 'Нужен новый график?', options: ['Да', 'Нет'] } });
  const pollState = await req('/api/state', { token: cook });
  const optionId = pollState.polls.find(p => p.id === poll.id).options[0].id;
  await req(`/api/polls/${poll.id}/vote`, { method: 'POST', token: cook, body: { optionId } });
  const template = await req('/api/checklists/templates', { method: 'POST', token: owner, body: { name: 'Открытие', items: ['Свет', 'Касса'], locationId: 1 } });
  await req('/api/checklists/runs', { method: 'POST', token: cook, body: { templateId: template.id, items: ['Свет', 'Касса'] } });
  const course = await req('/api/courses', { method: 'POST', token: owner, body: { title: 'Стандарты кухни' } });
  const lesson = await req(`/api/courses/${course.id}/lessons`, { method: 'POST', token: owner, body: { title: 'Гигиена' } });
  await req(`/api/lessons/${lesson.id}/progress`, { method: 'POST', token: cook, body: { done: true } });
  const videoLesson = await req(`/api/courses/${course.id}/lessons`, { method: 'POST', token: owner, body: { title: 'Видео: стандарты подачи', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', questions: [
    { question: 'Что сделать сначала?', options: ['Вымыть руки', 'Сразу готовить'], correctIndex: 0 },
    { question: 'Температура хранения?', options: ['+10°C', '+4°C и ниже'], correctIndex: 1 }
  ] } });
  await req(`/api/lessons/${videoLesson.id}/quiz`, { method: 'POST', token: cook, body: { answers: [0, 1] }, expected: 400 });
  await req(`/api/lessons/${videoLesson.id}/watch`, { method: 'POST', token: cook, body: {} });
  const quizData = await req(`/api/lessons/${videoLesson.id}/quiz`, { token: cook });
  assert.equal(quizData.questions.length, 2);
  assert.ok(!('correctIndex' in quizData.questions[0]) && !('correct_index' in quizData.questions[0]), 'quiz payload must not leak correct answers');
  const attempt = await req(`/api/lessons/${videoLesson.id}/quiz`, { method: 'POST', token: cook, body: { answers: [0, 0] } });
  assert.equal(attempt.score, 1);
  assert.equal(attempt.completed, false);
  const passed = await req(`/api/lessons/${videoLesson.id}/quiz`, { method: 'POST', token: cook, body: { answers: [0, 1] } });
  assert.equal(passed.score, 2);
  assert.equal(passed.completed, true);
  await req(`/api/lessons/${videoLesson.id}/questions`, { method: 'POST', token: cook, body: { question: 'Лишний?', options: ['а', 'б'], correctIndex: 0 }, expected: 403 });
  const ownerTrainingState = await req('/api/state', { token: owner });
  assert.ok(ownerTrainingState.trainingProgress.some(p => p.lessonId === videoLesson.id && p.completedAt && p.score === 2));
  const cookTrainingState = await req('/api/state', { token: cook });
  const vl = cookTrainingState.courses.flatMap(c => c.lessons).find(l => l.id === videoLesson.id);
  assert.equal(vl.questionCount, 2);
  assert.equal(vl.myResult.score, 2);
  assert.ok(vl.myResult.completedAt);
  // Lesson assignments: location target with a past due date -> overdue for the cook
  const assignLesson = await req(`/api/courses/${course.id}/lessons`, { method: 'POST', token: owner, body: { title: 'Видео: назначение и срок', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', questions: [
    { question: 'Готовы?', options: ['Да', 'Нет'], correctIndex: 0 }
  ] } });
  const yesterday = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await req(`/api/lessons/${assignLesson.id}/assignments`, { method: 'POST', token: cook, body: { locationId: 1, dueDate: yesterday }, expected: 403 });
  await req(`/api/lessons/${assignLesson.id}/assignments`, { method: 'POST', token: owner, body: { locationId: 1, dueDate: yesterday } });
  const cookAssignState = await req('/api/state', { token: cook });
  const myA = cookAssignState.myAssignments.find(a => a.lessonId === assignLesson.id);
  assert.ok(myA, 'cook sees the location assignment as his own');
  assert.equal(myA.dueDate, yesterday);
  assert.equal(myA.overdue, true, 'past due date + not completed = overdue');
  const ownerAssignState = await req('/api/state', { token: owner });
  const apRow = ownerAssignState.assignmentProgress.find(p => p.lessonId === assignLesson.id && p.employeeId === cookId);
  assert.ok(apRow && apRow.overdue === true && apRow.completed === false, 'manager progress flags the overdue assignee');
  // Re-posting the same target updates the due date instead of duplicating the assignment
  await req(`/api/lessons/${assignLesson.id}/assignments`, { method: 'POST', token: owner, body: { locationId: 1, dueDate: tomorrow } });
  const cookAssignState2 = await req('/api/state', { token: cook });
  assert.equal(cookAssignState2.myAssignments.filter(a => a.lessonId === assignLesson.id).length, 1);
  assert.equal(cookAssignState2.myAssignments.find(a => a.lessonId === assignLesson.id).overdue, false);
  await req(`/api/lessons/${assignLesson.id}/assignments`, { method: 'POST', token: owner, body: { locationId: 1, dueDate: yesterday } });
  // Completing the lesson clears the overdue flag everywhere
  await req(`/api/lessons/${assignLesson.id}/watch`, { method: 'POST', token: cook, body: {} });
  const passedAssign = await req(`/api/lessons/${assignLesson.id}/quiz`, { method: 'POST', token: cook, body: { answers: [0] } });
  assert.equal(passedAssign.completed, true);
  const cookAssignState3 = await req('/api/state', { token: cook });
  const myA3 = cookAssignState3.myAssignments.find(a => a.lessonId === assignLesson.id);
  assert.ok(myA3.completed && myA3.overdue === false);
  const ownerAssignState3 = await req('/api/state', { token: owner });
  assert.equal(ownerAssignState3.assignmentProgress.find(p => p.lessonId === assignLesson.id && p.employeeId === cookId).completed, true);
  // A lesson assigned only to another location is hidden from the cook but visible to the owner
  const hiddenLesson = await req(`/api/courses/${course.id}/lessons`, { method: 'POST', token: owner, body: { title: 'Только для второй точки', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
  await req(`/api/lessons/${hiddenLesson.id}/assignments`, { method: 'POST', token: owner, body: { locationId: 2, dueDate: tomorrow } });
  const cookHiddenState = await req('/api/state', { token: cook });
  assert.ok(!cookHiddenState.courses.flatMap(c => c.lessons).some(l => l.id === hiddenLesson.id), 'targeted lesson is hidden from non-assignees');
  const ownerHiddenState = await req('/api/state', { token: owner });
  const hiddenForOwner = ownerHiddenState.courses.flatMap(c => c.lessons).find(l => l.id === hiddenLesson.id);
  assert.ok(hiddenForOwner && hiddenForOwner.assignments.length === 1, 'manager sees the lesson and its assignments');
  // Direct assignment to the cook + removal
  const direct = await req(`/api/lessons/${hiddenLesson.id}/assignments`, { method: 'POST', token: owner, body: { employeeId: cookId, dueDate: tomorrow } });
  const cookDirectState = await req('/api/state', { token: cook });
  assert.ok(cookDirectState.myAssignments.some(a => a.lessonId === hiddenLesson.id), 'direct assignment reaches the employee');
  await req(`/api/lessons/${hiddenLesson.id}/assignments/${direct.id}`, { method: 'DELETE', token: owner });
  const cookDirectState2 = await req('/api/state', { token: cook });
  assert.ok(!cookDirectState2.myAssignments.some(a => a.lessonId === hiddenLesson.id), 'removed assignment disappears');
  const documentRow = await req('/api/documents', { method: 'POST', token: owner, body: { title: 'Правила безопасности', body: 'Прочитать всем' } });
  await req(`/api/documents/${documentRow.id}/ack`, { method: 'POST', token: cook, body: {} });
  await req('/api/kb', { method: 'POST', token: owner, body: { title: 'Касса', body: 'Как открывать смену' } });
  const finalCookState = await req('/api/state', { token: cook });
  assert.ok(finalCookState.channels.every(c => c.minRank <= 1), 'staff receives only level-1 channels in state');
  const ownerChannel = finalCookState.channels.find(c => c.minRank === 5);
  assert.equal(ownerChannel, undefined);
  const allChannelsOwnerState = await req('/api/state', { token: owner });
  const ownerOnlyChannel = allChannelsOwnerState.channels.find(c => c.minRank === 5);
  await req(`/api/channels/${ownerOnlyChannel.id}/messages`, { method: 'POST', token: cook, body: { body: 'Нельзя' }, expected: 403 });
  const teamChannel = allChannelsOwnerState.channels.find(c => c.minRank === 1);
  await req(`/api/channels/${teamChannel.id}/messages`, { method: 'POST', token: cook, body: { body: 'Всем привет' } });
  const timeoff = await req('/api/timeoff', { method: 'POST', token: cook, body: { startsOn: '2027-02-01', endsOn: '2027-02-03', reason: 'Семейные дела' } });
  await req(`/api/timeoff/${timeoff.id}/decide`, { method: 'POST', token: manager, body: { status: 'approved' } });

  console.log('All MyTeam production core-flow tests passed.');
} finally {
  server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}
