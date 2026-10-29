const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const tokenKey = 'myteam_token';
let token = localStorage.getItem(tokenKey) || '';
let appState = null;
let bootstrap = { companyName: '', hasOwner: false, locations: [] };
let currentTab = 'home';
let selectedLocationId = null;
let selectedPosition = null;
let selectedChannelId = null;
let trainingLocFilter = 'all';
let timesheetRows = [];
let ratingsData = null;
let deferredInstallPrompt = null;

const STANDARD_ROLES = ['Директор', 'Менеджер', 'Шеф-повар', 'Повар', 'Официант', 'Кассир'];
const RANK_LABEL = { staff: 'Сотрудник', lead: 'Старший смены', manager: 'Управляющий', director: 'Директор', owner: 'Владелец' };

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3600);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}
function formObject(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) data[key] = value;
  for (const checkbox of $$('input[type="checkbox"]', form)) data[checkbox.name] = checkbox.checked;
  return data;
}
function fmtDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'America/New_York', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function fmtDay(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'America/New_York', dateStyle: 'medium' }).format(new Date(value));
}
function locationName(id) { return appState?.locations.find(l => l.id === Number(id))?.name || 'Без точки'; }
function employeeName(id) { return appState?.employees.find(e => e.id === Number(id))?.name || 'Сотрудник'; }
function can(rankLevel) { return (appState?.me.rankLevel || 0) >= rankLevel; }
function setAuthError(message) {
  const el = $('#authError');
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

async function loadBootstrap() {
  bootstrap = await api('/api/bootstrap');
  $('#companyName').textContent = bootstrap.companyName || 'MyTeam';
  $('#companyField').classList.toggle('hidden', bootstrap.hasOwner);
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) {
    $('#showRegister').click();
    $('#regStep1Form [name="inviteCode"]').value = invite.toUpperCase();
  }
}

async function loadState() {
  appState = await api('/api/state');
  $('#companyName').textContent = appState.companyName || 'MyTeam';
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#bottomNav').classList.remove('hidden');
  $('#profileChip').classList.remove('hidden');
  $('#logoutButton').classList.remove('hidden');
  $('#profileChip').textContent = `${appState.me.name} · ${appState.me.rankLabel}`;
  if (!selectedLocationId && appState.locations[0]) selectedLocationId = appState.locations[0].id;
  if (!selectedChannelId && appState.channels[0]) selectedChannelId = appState.channels[0].id;
  updateInstallUi();
  render();
}

function showAuth() {
  token = '';
  localStorage.removeItem(tokenKey);
  appState = null;
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  $('#bottomNav').classList.add('hidden');
  $('#profileChip').classList.add('hidden');
  $('#logoutButton').classList.add('hidden');
}

function render() {
  $$('#bottomNav button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  const page = $('#pageContent');
  if (!appState) return;
  ({ home: renderHome, shifts: renderShifts, time: renderTime, team: renderTeam, tasks: renderTasks, feed: renderFeed,
     checklists: renderChecklists, learning: renderLearning, chat: renderChat, rating: renderRating }[currentTab] || renderHome)(page);
}

function pageHead(title, subtitle) { return `<div class="page-head"><div><p>${esc(subtitle || '')}</p><h1>${esc(title)}</h1></div></div>`; }

function renderHome(page) {
  const d = appState.dashboard;
  const upcoming = appState.shifts.filter(s => new Date(s.startsAt) > new Date()).slice(0, 5);
  page.innerHTML = `
    ${pageHead('Команда сегодня', `${fmtDay(new Date())} · панель руководителя`)}
    <div class="grid four">
      <div class="card"><div class="metric">${esc(d.hoursToday)} ч</div><div class="metric-label">Часы сегодня · ${d.punchesToday} отметок</div></div>
      <div class="card"><div class="metric">${esc(d.shiftsToday)}</div><div class="metric-label">Смен сегодня · открытых ${d.openShifts}</div></div>
      <div class="card"><div class="metric">${esc(d.activeTasks)}</div><div class="metric-label">Активных задач · просрочено ${d.overdueTasks}</div></div>
      <div class="card"><div class="metric">${esc(d.myPoints)} ⭐</div><div class="metric-label">Мои поинты · эффективность ${esc(d.myEfficiency)}%</div></div>
      ${appState.me.rank === 'owner' ? `<div class="card"><div class="metric">$${esc(d.laborCostToday || 0)}</div><div class="metric-label">Труд сегодня · видит только владелец</div></div>` : ''}
      <div class="card"><div class="metric">${esc(d.pendingTimeoff)}</div><div class="metric-label">Заявок ждут решения</div></div>
    </div>
    <section class="section grid two">
      <div class="card"><h2>Ближайшие смены</h2><div class="list">
        ${upcoming.length ? upcoming.map(s => `<div class="item"><div class="row"><strong>${esc(fmtDate(s.startsAt))}</strong><span class="badge">${esc(locationName(s.locationId))}</span></div><p>${esc(employeeName(s.employeeId))} · до ${esc(fmtDate(s.endsAt))}</p></div>`).join('') : '<p class="muted">Ближайших смен пока нет.</p>'}
      </div></div>
      <div class="card"><h2>Уведомления</h2><div class="list">
        ${appState.notifications.length ? appState.notifications.map(n => `<div class="item"><div class="row"><strong>${esc(n.title)}</strong>${n.readAt ? '<span class="badge gray">прочитано</span>' : `<button class="secondary" data-read-notification="${n.id}">Прочитано</button>`}</div><p>${esc(n.body)}</p><small class="muted">${esc(fmtDate(n.dueAt))}</small></div>`).join('') : '<p class="muted">Новых уведомлений нет.</p>'}
      </div></div>
    </section>
    <section class="section card"><h2>Разделы</h2><div class="chips">${['shifts','time','tasks','team','feed','checklists','learning','chat','rating'].map(tab => `<button data-tab-link="${tab}">${esc({shifts:'Смены',time:'Время',tasks:'Задачи',team:'Команда',feed:'Лента',checklists:'Чек-листы',learning:'Обучение',chat:'Чат',rating:'Рейтинг'}[tab])}</button>`).join('')}</div></section>`;
  $$('[data-read-notification]', page).forEach(btn => btn.addEventListener('click', async () => { await api(`/api/notifications/${btn.dataset.readNotification}/read`, { method: 'POST' }); await loadState(); }));
  $$('[data-tab-link]', page).forEach(btn => btn.addEventListener('click', () => { currentTab = btn.dataset.tabLink; render(); }));
}

function employeeOptions(selected = '') {
  return appState.employees.filter(e => e.active).map(e => `<option value="${e.id}" ${Number(selected) === e.id ? 'selected' : ''}>${esc(e.name)} · ${esc(e.position || e.rankLabel)}</option>`).join('');
}
function locationOptions(selected = '') {
  return appState.locations.map(l => `<option value="${l.id}" ${Number(selected) === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
}

function renderShifts(page) {
  const canCreate = can(2);
  page.innerHTML = `${pageHead('Смены', 'Расписание по времени America/New_York')}
    ${canCreate ? `<div class="card form-card"><h2>Назначить смену</h2><form id="shiftForm" class="form-grid">
      <label>Сотрудник<select name="employeeId"><option value="">Открытая смена</option>${employeeOptions()}</select></label>
      <label>Точка<select name="locationId">${locationOptions()}</select></label>
      <label>Начало<input type="datetime-local" name="startsAt" required></label>
      <label>Окончание<input type="datetime-local" name="endsAt" required></label>
      <label class="wide">Примечание<input name="note"></label>
      <label>Повторов<input type="number" name="occurrences" value="26" min="1" max="52"></label>
      <label class="checkline"><input type="checkbox" name="repeatWeekly"> Повторять каждую неделю</label>
      <button class="primary" type="submit">Создать</button></form></div>` : ''}
    <div class="list">${appState.shifts.length ? appState.shifts.map(s => `<article class="item"><div class="row"><div><strong>${esc(fmtDate(s.startsAt))} — ${esc(fmtDate(s.endsAt))}</strong><p>${esc(s.employeeId ? employeeName(s.employeeId) : 'Открытая смена')} · ${esc(locationName(s.locationId))}${s.seriesId ? ' · серия' : ''}</p>${s.note ? `<p>${esc(s.note)}</p>` : ''}</div><div>
      ${s.isOpen ? `<button class="primary" data-claim-shift="${s.id}">Взять смену</button>` : ''}
      ${s.seriesId && can(2) ? `<button class="secondary" data-stop-series="${s.id}">Остановить серию</button>` : ''}
    </div></div></article>`).join('') : '<div class="card">Смен пока нет.</div>'}</div>`;
  const form = $('#shiftForm', page);
  if (form) form.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(form);
    d.startsAt = new Date(d.startsAt).toISOString(); d.endsAt = new Date(d.endsAt).toISOString(); d.employeeId = d.employeeId ? Number(d.employeeId) : null; d.locationId = Number(d.locationId); d.occurrences = Number(d.occurrences);
    const result = await api('/api/shifts', { method: 'POST', body: JSON.stringify(d) }); toast(`Создано смен: ${result.count}`); await loadState(); });
  $$('[data-claim-shift]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/shifts/${b.dataset.claimShift}/claim`, { method: 'POST' }); toast('Смена назначена вам'); await loadState(); }));
  $$('[data-stop-series]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/shifts/${b.dataset.stopSeries}/stop-series`, { method: 'POST' }); toast('Будущие смены серии удалены'); await loadState(); }));
}

function renderTime(page) {
  const myOpen = appState.punches.find(p => p.employeeId === appState.me.id && !p.clockOut);
  page.innerHTML = `${pageHead('Время', 'Отметки, киоск по PIN, отпуска и табель')}
    <div class="grid two">
      <div class="card"><h2>Моя смена</h2><p>${myOpen ? `Начата: ${esc(fmtDate(myOpen.clockIn))}` : 'Сейчас вы не отмечены.'}</p><div class="row">
        <button class="primary" id="clockIn" ${myOpen ? 'disabled' : ''}>Начать смену</button><button class="secondary" id="clockOut" ${myOpen ? '' : 'disabled'}>Завершить смену</button></div>
        <h3 style="margin-top:22px">Киоск по PIN</h3><form id="kioskForm" class="stack"><label>ID сотрудника<input type="number" name="employeeId" required></label><label>PIN<input name="pin" inputmode="numeric" required></label><label>Действие<select name="action"><option value="in">Приход</option><option value="out">Уход</option></select></label><button class="secondary" type="submit">Отметить через киоск</button></form></div>
      <div class="card"><h2>Заявка на отпуск / выходной</h2><form id="timeoffForm" class="stack"><label>Тип<select name="type"><option value="timeoff">Отпуск</option><option value="dayoff">Выходной</option><option value="sick">Больничный</option></select></label><div class="grid two"><label>С даты<input type="date" name="startsOn" required></label><label>По дату<input type="date" name="endsOn" required></label></div><label>Причина<textarea name="reason"></textarea></label><button class="primary" type="submit">Отправить заявку</button></form></div>
    </div>
    <section class="section"><div class="row"><h2>Заявки</h2></div><div class="list">${appState.timeoff.map(t => `<div class="item"><div class="row"><div><strong>${esc(employeeName(t.employeeId))}</strong><p>${esc(t.startsOn)} — ${esc(t.endsOn)} · ${esc(t.reason || '')}</p></div><span class="badge ${t.status === 'approved' ? 'green' : t.status === 'rejected' ? 'red' : ''}">${esc(t.status)}</span></div>${can(3) && t.status === 'pending' ? `<div class="chips"><button data-timeoff="${t.id}" data-status="approved">Одобрить</button><button data-timeoff="${t.id}" data-status="rejected">Отклонить</button></div>` : ''}</div>`).join('') || '<div class="card">Заявок нет.</div>'}</div></section>
    <section class="section"><div class="row"><h2>Табель</h2><button class="secondary" id="loadTimesheet">Обновить табель</button></div><div class="table-wrap"><table><thead><tr><th>Сотрудник</th><th>Часы</th><th>Отметок</th>${appState.me.rank === 'owner' ? '<th>Стоимость труда</th>' : ''}</tr></thead><tbody id="timesheetBody"><tr><td colspan="4">Нажмите «Обновить табель».</td></tr></tbody></table></div>
    <p class="hint">Для всех, кроме владельца, табель показывает только часы — без ставок и сумм.</p></section>
    <section class="section"><h2>Мои отметки</h2><div class="list">${appState.punches.filter(p => p.employeeId === appState.me.id).map(p => `<div class="item"><strong>${esc(fmtDate(p.clockIn))} — ${p.clockOut ? esc(fmtDate(p.clockOut)) : 'ещё идёт'}</strong><p>${esc(p.hours)} ч · ${esc(locationName(p.locationId))}</p></div>`).join('') || '<div class="card">Отметок пока нет.</div>'}</div></section>`;
  $('#clockIn', page).addEventListener('click', async () => { await api('/api/punches', { method: 'POST', body: JSON.stringify({ action: 'in' }) }); await loadState(); });
  $('#clockOut', page).addEventListener('click', async () => { await api('/api/punches', { method: 'POST', body: JSON.stringify({ action: 'out' }) }); await loadState(); });
  $('#kioskForm', page).addEventListener('submit', async e => { e.preventDefault(); const d = formObject(e.target); d.employeeId = Number(d.employeeId); await api('/api/punches/kiosk', { method: 'POST', body: JSON.stringify(d) }); toast('Отметка сохранена'); await loadState(); });
  $('#timeoffForm', page).addEventListener('submit', async e => { e.preventDefault(); await api('/api/timeoff', { method: 'POST', body: JSON.stringify(formObject(e.target)) }); toast('Заявка отправлена'); await loadState(); });
  $$('[data-timeoff]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/timeoff/${b.dataset.timeoff}/decide`, { method: 'POST', body: JSON.stringify({ status: b.dataset.status }) }); await loadState(); }));
  $('#loadTimesheet', page).addEventListener('click', async () => { const data = await api('/api/timesheet'); timesheetRows = data.rows;
    $('#timesheetBody', page).innerHTML = timesheetRows.map(r => `<tr><td>${esc(r.employeeName)}</td><td>${esc(r.hours)}</td><td>${esc(r.punches)}</td>${appState.me.rank === 'owner' ? `<td>$${esc(r.cost || 0)}</td>` : ''}</tr>`).join('') || '<tr><td colspan="4">Нет данных</td></tr>'; });
}

function employeeCard(e) {
  const isMe = e.id === appState.me.id;
  return `<article class="item"><div class="row"><div><strong>${esc(e.name)}</strong><p>${esc(e.position || 'Без должности')} · ${esc(e.rankLabel)} · ${esc(locationName(e.locationId))}</p><small class="muted">${esc(e.phone || e.email || '')}</small></div><span class="badge ${e.active ? 'green' : 'red'}">${e.active ? 'активен' : 'выключен'}</span></div>
  ${can(3) && !isMe ? `<details class="inline-edit"><summary>Изменить</summary><form class="stack" data-edit-employee="${e.id}">
    <label>Должность<input name="position" value="${esc(e.position || '')}"></label>
    <label>Точка<select name="locationId"><option value="">Без точки</option>${locationOptions(e.locationId)}</select></label>
    <label>Ранг<select name="rank">${Object.entries(RANK_LABEL).map(([value, label]) => `<option value="${value}" ${e.rank === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>PIN — задать или сбросить (пусто = не менять)<input name="pin" inputmode="numeric" autocomplete="off" placeholder="${e.hasPin ? 'PIN задан' : 'PIN не задан'}"></label>
    <label>Пароль входа — задать или сбросить (пусто = не менять)<input name="password" type="password" autocomplete="off" placeholder="${e.hasPassword ? 'Пароль задан' : 'Пароль не задан'}"></label>
    ${appState.me.rank === 'owner' ? `<label>Ставка, $/час<input type="number" step="0.01" name="hourlyRate" value="${e.hourlyRate ?? ''}" placeholder="Не задана"></label>` : ''}
    <label class="checkline"><input type="checkbox" name="active" ${e.active ? 'checked' : ''}> Активен</label>
    <button class="primary" type="submit">Сохранить</button></form></details>` : ''}
  ${appState.me.rank === 'owner' && Object.prototype.hasOwnProperty.call(e, 'hourlyRate') ? `<p><span class="badge">Ставка: ${e.hourlyRate == null ? 'не задана' : `$${e.hourlyRate}/час`}</span></p>` : ''}
  ${isMe ? `<details class="inline-edit"><summary>Мой пароль</summary><form class="stack" data-my-password>
    <p class="muted">${e.hasPassword ? 'Пароль задан — вход в ваш профиль только с паролем.' : 'Пароль не задан: любой, кто введёт ваш номер телефона или email, войдёт в ваш профиль. Задайте пароль.'}</p>
    <label>${e.hasPassword ? 'Новый пароль' : 'Пароль для входа'}<input name="password" type="password" autocomplete="new-password" minlength="6" placeholder="От 6 символов"></label>
    <label>PIN для киоска отметок <span class="optional">(необязательно)</span><input name="pin" inputmode="numeric" autocomplete="off" placeholder="${e.hasPin ? 'PIN задан — пусто = не менять' : '4–6 цифр'}"></label>
    <button class="primary" type="submit">Сохранить</button></form></details>` : ''}</article>`;
}

function renderTeam(page) {
  const me = appState.me;
  if (!can(3)) {
    page.innerHTML = `${pageHead('Команда', 'Ваши данные и точки сети')}<div class="grid two"><div class="card"><h2>Мои данные</h2>${employeeCard(me)}</div>
      <div class="card"><h2>Локации</h2><div class="list">${appState.locations.map(l => `<div class="item"><div class="row"><strong>${esc(l.name)}</strong>${me.locationId === l.id ? '<span class="badge green">ваша точка</span>' : ''}</div><p>${esc(l.address)}</p></div>`).join('')}</div></div></div>`;
    return;
  }
  const owners = appState.employees.filter(e => e.rank === 'owner');
  const directors = appState.employees.filter(e => e.rank === 'director');
  const selectedLocation = appState.locations.find(l => l.id === Number(selectedLocationId)) || appState.locations[0];
  const positionsHere = [...new Set([...STANDARD_ROLES, ...appState.employees.filter(e => e.locationId === selectedLocation?.id).map(e => e.position).filter(Boolean), 'Без должности'])];
  if (!selectedPosition || !positionsHere.includes(selectedPosition)) selectedPosition = positionsHere[0];
  const tabEmployees = selectedLocation ? appState.employees.filter(e => e.locationId === selectedLocation.id && ((e.position || 'Без должности') === selectedPosition)) : [];
  page.innerHTML = `${pageHead('Команда', appState.companyName || '')}
    ${me.rank === 'owner' ? `<div class="grid two"><form id="companyForm" class="card stack"><h2>Компания</h2><label>Название компании<input name="name" value="${esc(appState.companyName || '')}"></label><button class="primary">Сохранить название</button></form>
    <form id="bonusForm" class="card stack"><h2>Недельный бонус</h2><label>Поинтов за чистую неделю<input type="number" name="points" value="${esc(appState.weeklyBonusPoints || 10)}" min="0"></label><button class="primary">Сохранить бонус</button></form></div>` : ''}
    <section class="section grid two"><div class="card"><div class="row"><h2>Владельцы · ${owners.length}</h2></div><div class="list">${owners.map(employeeCard).join('') || '<p class="muted">Пока никого.</p>'}</div>
      ${me.rank === 'owner' ? `<form class="stack" data-invite-form data-rank="owner" data-position="Совладелец"><label>Телефон или email человека <span class="optional">(необязательно)</span><input name="contact" placeholder="Код будет привязан к этому контакту"></label><button class="secondary" type="submit">+ Пригласить совладельца</button><div class="invite-result"></div></form>` : ''}</div>
    <div class="card"><div class="row"><h2>Директора · ${directors.length}</h2></div><div class="list">${directors.map(employeeCard).join('') || '<p class="muted">Пока никого.</p>'}</div>
      ${can(4) ? `<form class="stack" data-invite-form data-rank="director" data-position="Директор"><label>Телефон или email человека <span class="optional">(необязательно)</span><input name="contact" placeholder="Код будет привязан к этому контакту"></label><button class="secondary" type="submit">+ Пригласить директора</button><div class="invite-result"></div></form>` : ''}</div></section>
    <section class="section"><h2>Локации</h2><div class="list">${appState.locations.map(l => `<button class="location-row" data-location="${l.id}"><span>${esc(l.name)}<small>${esc(l.address)}</small></span><span>${appState.employees.filter(e => e.locationId === l.id).length} чел. →</span></button>`).join('')}</div>
    ${can(3) ? `<form id="locationForm" class="card form-card stack" style="margin-top:14px"><h3>Добавить точку</h3><div class="grid two"><label>Название<input name="name" required></label><label>Адрес<input name="address"></label></div><button class="secondary">Добавить точку</button></form>` : ''}</section>
    ${selectedLocation ? `<section class="section"><div class="row"><h2>${esc(selectedLocation.name)}</h2><span class="badge">${esc(selectedLocation.address)}</span></div>
      <div class="tabs">${positionsHere.map(position => `<button data-position="${esc(position)}" class="${position === selectedPosition ? 'active' : ''}">${esc(position)} · ${appState.employees.filter(e => e.locationId === selectedLocation.id && ((e.position || 'Без должности') === position)).length}</button>`).join('')}</div>
      <div class="list">${tabEmployees.map(employeeCard).join('') || '<div class="card">В этой должности пока никого нет.</div>'}</div>
      <form class="card stack" data-invite-form data-location="${selectedLocation.id}" data-position="${esc(selectedPosition === 'Без должности' ? '' : selectedPosition)}"><h3>Приглашение: ${esc(selectedPosition)} · ${esc(selectedLocation.name)}</h3><label>Телефон или email человека <span class="optional">(необязательно)</span><input name="contact" placeholder="Код будет привязан к этому контакту"></label><button class="primary" type="submit">+ Пригласить</button><div class="invite-result"></div></form></section>` : ''}
    <section class="section"><h2>Активные приглашения</h2><div class="list">${appState.invites.filter(i => i.active).map(i => `<div class="item"><div class="row"><div><strong>${esc(i.code)}</strong><p>${esc(i.position || 'Без должности')} · ${esc(i.rankLabel)} · ${esc(i.locationName || 'вся сеть')}</p></div><button class="secondary" data-revoke-invite="${esc(i.code)}">Отозвать</button></div><p class="hint">Ссылка: <code>?invite=${esc(i.code)}</code> — код подставится сам.</p></div>`).join('') || '<div class="card">Активных приглашений нет.</div>'}</div></section>`;
  const companyForm = $('#companyForm', page); if (companyForm) companyForm.addEventListener('submit', async e => { e.preventDefault(); await api('/api/company', { method: 'POST', body: JSON.stringify(formObject(e.target)) }); toast('Название компании сохранено'); await loadState(); });
  const bonusForm = $('#bonusForm', page); if (bonusForm) bonusForm.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(e.target); await api('/api/settings/weekly-bonus', { method: 'POST', body: JSON.stringify({ points: Number(d.points) }) }); toast('Бонус обновлён'); await loadState(); });
  $$('[data-location]', page).forEach(b => b.addEventListener('click', () => { selectedLocationId = Number(b.dataset.location); selectedPosition = null; render(); }));
  $$('[data-position]', page).forEach(b => b.addEventListener('click', () => { selectedPosition = b.dataset.position; render(); }));
  $$('[data-invite-form]', page).forEach(form => form.addEventListener('submit', async e => { e.preventDefault(); const payload = { position: form.dataset.position || null, locationId: form.dataset.location ? Number(form.dataset.location) : null }; if (form.dataset.rank) payload.rank = form.dataset.rank;
    const fd = formObject(form); if (fd.contact) payload.contact = fd.contact;
    const result = await api('/api/invites', { method: 'POST', body: JSON.stringify(payload) }); $('.invite-result', form).innerHTML = `<p>Код: <strong>${esc(result.invite.code)}</strong></p><pre class="code">${esc(location.origin + location.pathname + '?invite=' + result.invite.code)}</pre>`; toast('Приглашение создано'); setTimeout(loadState, 1200); }));
  $$('[data-revoke-invite]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/invites/${b.dataset.revokeInvite}`, { method: 'DELETE' }); await loadState(); }));
  const locForm = $('#locationForm', page); if (locForm) locForm.addEventListener('submit', async e => { e.preventDefault(); await api('/api/locations', { method: 'POST', body: JSON.stringify(formObject(e.target)) }); await loadState(); });
  $$('[data-edit-employee]', page).forEach(form => form.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(form); d.locationId = d.locationId ? Number(d.locationId) : null; if (d.hourlyRate === '') d.hourlyRate = null; else if (d.hourlyRate !== undefined) d.hourlyRate = Number(d.hourlyRate);
    if (!d.pin) delete d.pin;
    if (!d.password) delete d.password;
    await api(`/api/employees/${form.dataset.editEmployee}`, { method: 'PATCH', body: JSON.stringify(d) }); toast('Профиль обновлён'); await loadState(); }));
  $$('[data-my-password]', page).forEach(form => form.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(form); const payload = {}; if (d.password) payload.password = d.password; if (d.pin) payload.pin = d.pin; if (!Object.keys(payload).length) { toast('Введите пароль или PIN'); return; } await api(`/api/employees/${appState.me.id}`, { method: 'PATCH', body: JSON.stringify(payload) }); toast('Сохранено'); await loadState(); }));
}

function renderTasks(page) {
  page.innerHTML = `${pageHead('Задачи', 'Назначения, сроки и шаги')}
    <div class="card form-card"><h2>Новая задача</h2><form id="taskForm" class="form-grid"><label class="wide">Название<input name="title" required></label><label>Исполнитель<select name="assigneeId"><option value="">Без исполнителя</option>${employeeOptions()}</select></label><label>Точка<select name="locationId"><option value="">Вся сеть</option>${locationOptions()}</select></label><label>Срок<input type="datetime-local" name="dueAt"></label><label class="wide">Описание<textarea name="description"></textarea></label><button class="primary">Создать</button></form></div>
    <div class="list">${appState.tasks.map(t => `<article class="item"><div class="row"><div><strong>${esc(t.title)}</strong><p>${esc(t.description || '')}</p><small class="muted">${esc(t.assigneeId ? employeeName(t.assigneeId) : 'Без исполнителя')} · ${esc(locationName(t.locationId))} · срок ${esc(fmtDate(t.dueAt))}</small></div><span class="badge ${t.status === 'done' ? 'green' : ''}">${esc(t.status)}</span></div>
    ${t.checklist?.length ? `<ul>${t.checklist.map(item => `<li>${esc(typeof item === 'string' ? item : item.text || '')}</li>`).join('')}</ul>` : ''}
    <div class="chips"><button data-task-status="${t.id}:open">Открыта</button><button data-task-status="${t.id}:in_progress">В работе</button><button data-task-status="${t.id}:done">Готово</button></div></article>`).join('') || '<div class="card">Задач пока нет.</div>'}</div>`;
  $('#taskForm', page).addEventListener('submit', async e => { e.preventDefault(); const d = formObject(e.target); d.assigneeId = d.assigneeId ? Number(d.assigneeId) : null; d.locationId = d.locationId ? Number(d.locationId) : null; d.dueAt = d.dueAt ? new Date(d.dueAt).toISOString() : null; await api('/api/tasks', { method: 'POST', body: JSON.stringify(d) }); await loadState(); });
  $$('[data-task-status]', page).forEach(b => b.addEventListener('click', async () => { const [id, status] = b.dataset.taskStatus.split(':'); await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadState(); }));
}

function renderFeed(page) {
  page.innerHTML = `${pageHead('Лента', 'Объявления, опросы и награды')}
    <div class="grid two"><div class="card"><h2>Объявления</h2>${can(3) ? `<form id="announcementForm" class="stack"><label>Заголовок<input name="title" required></label><label>Текст<textarea name="body"></textarea></label><button class="primary">Опубликовать</button></form>` : ''}
      <div class="list" style="margin-top:14px">${appState.announcements.map(a => `<article class="item"><strong>${esc(a.title)}</strong><p>${esc(a.body)}</p><small class="muted">${esc(fmtDate(a.createdAt))}</small>${a.read ? '<span class="badge green">прочитано</span>' : `<button class="secondary" data-read-announcement="${a.id}">Подтвердить прочтение</button>`}</article>`).join('') || '<p class="muted">Объявлений нет.</p>'}</div></div>
    <div class="card"><h2>Опросы</h2>${can(3) ? `<form id="pollForm" class="stack"><label>Вопрос<input name="question" required></label><label>Варианты через запятую<input name="options" required placeholder="Да, Нет"></label><button class="primary">Создать опрос</button></form>` : ''}
      <div class="list" style="margin-top:14px">${appState.polls.map(p => `<article class="item"><strong>${esc(p.question)}</strong><div class="chips">${p.options.map(o => `<button data-vote="${p.id}:${o.id}" ${p.closed ? 'disabled' : ''}>${esc(o.text)} · ${o.votes}${p.myVote === o.id ? ' ✓' : ''}</button>`).join('')}</div>${p.closed ? '<span class="badge gray">закрыт</span>' : can(3) ? `<button class="secondary" data-close-poll="${p.id}">Закрыть</button>` : ''}</article>`).join('') || '<p class="muted">Опросов нет.</p>'}</div></div></div>
    <section class="section card"><h2>Награды</h2><div class="list">${appState.recognitions.map(r => `<div class="item"><strong>${esc(employeeName(r.employeeId))} · +${esc(r.points)}</strong><p>${esc(r.reason)}</p><small class="muted">${esc(fmtDate(r.createdAt))}</small></div>`).join('') || '<p class="muted">Наград пока нет.</p>'}</div></section>`;
  const af = $('#announcementForm', page); if (af) af.addEventListener('submit', async e => { e.preventDefault(); await api('/api/announcements', { method: 'POST', body: JSON.stringify(formObject(e.target)) }); await loadState(); });
  const pf = $('#pollForm', page); if (pf) pf.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(e.target); d.options = d.options.split(',').map(s => s.trim()).filter(Boolean); await api('/api/polls', { method: 'POST', body: JSON.stringify(d) }); await loadState(); });
  $$('[data-read-announcement]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/announcements/${b.dataset.readAnnouncement}/read`, { method: 'POST' }); await loadState(); }));
  $$('[data-vote]', page).forEach(b => b.addEventListener('click', async () => { const [pollId, optionId] = b.dataset.vote.split(':'); await api(`/api/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ optionId: Number(optionId) }) }); await loadState(); }));
  $$('[data-close-poll]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/polls/${b.dataset.closePoll}/close`, { method: 'POST' }); await loadState(); }));
}

function renderChecklists(page) {
  page.innerHTML = `${pageHead('Чек-листы', 'Открытие, закрытие и контроль качества')}
    <div class="grid two"><div class="card"><h2>Шаблоны</h2>${can(3) ? `<form id="templateForm" class="stack"><label>Название<input name="name" required></label><label>Пункты, каждый с новой строки<textarea name="itemsText" required></textarea></label><label>Точка<select name="locationId"><option value="">Вся сеть</option>${locationOptions()}</select></label><button class="primary">Создать шаблон</button></form>` : ''}
    <div class="list" style="margin-top:14px">${appState.checklistTemplates.map(t => `<div class="item"><strong>${esc(t.name)}</strong><p>${esc(t.items.join(' · '))}</p></div>`).join('') || '<p class="muted">Шаблонов нет.</p>'}</div></div>
    <div class="card"><h2>Выполнить чек-лист</h2><form id="runForm" class="stack"><label>Шаблон<select name="templateId">${appState.checklistTemplates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label><label>Отметки / выполненные пункты<textarea name="itemsText" placeholder="Один пункт с новой строки"></textarea></label><label>Комментарий<textarea name="note"></textarea></label><button class="primary">Отправить</button></form>
    <h3 style="margin-top:18px">История</h3><div class="list">${appState.checklistRuns.map(r => `<div class="item"><strong>${esc(appState.checklistTemplates.find(t => t.id === r.templateId)?.name || 'Чек-лист')}</strong><p>${esc(employeeName(r.employeeId))} · ${esc(fmtDate(r.createdAt))}</p><p>${esc(r.items.join(' · '))}</p></div>`).join('') || '<p class="muted">Выполнений нет.</p>'}</div></div></div>`;
  const tf = $('#templateForm', page); if (tf) tf.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(e.target); d.items = d.itemsText.split('\n').map(s => s.trim()).filter(Boolean); d.locationId = d.locationId ? Number(d.locationId) : null; await api('/api/checklists/templates', { method: 'POST', body: JSON.stringify(d) }); await loadState(); });
  $('#runForm', page).addEventListener('submit', async e => { e.preventDefault(); const d = formObject(e.target); d.templateId = Number(d.templateId); d.items = d.itemsText.split('\n').map(s => s.trim()).filter(Boolean); await api('/api/checklists/runs', { method: 'POST', body: JSON.stringify(d) }); toast('Чек-лист отправлен'); await loadState(); });
}

function videoEmbedHtml(url) {
  const yt = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/.exec(url || '');
  if (yt) return `<div class="video-wrap"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}" title="Видео урока" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url || '')) return `<div class="video-wrap"><video controls preload="metadata" src="${esc(url)}"></video></div>`;
  return `<p><a href="${esc(url)}" target="_blank" rel="noreferrer">▶ Открыть видео</a></p>`;
}

function parseQuestionsText(text) {
  const questions = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length < 3) continue;
    const options = [];
    let correctIndex = -1;
    for (const line of lines.slice(1)) {
      if (line.startsWith('*')) { correctIndex = options.length; options.push(line.slice(1).replace(/^[-•]\s*/, '').trim()); }
      else options.push(line.replace(/^[-•]\s*/, '').trim());
    }
    if (options.length >= 2 && correctIndex >= 0) questions.push({ question: lines[0], options, correctIndex });
  }
  return questions;
}

function fmtDue(dateOnly) { return dateOnly ? fmtDay(`${dateOnly}T12:00:00Z`) : ''; }

function assignmentHtml(l) {
  const parts = [];
  if (l.myAssignment) {
    parts.push(`<div class="row"><span class="badge">📌 Назначено вам${l.myAssignment.dueDate ? ` · срок до ${esc(fmtDue(l.myAssignment.dueDate))}` : ''}</span>${l.myAssignment.overdue ? '<span class="badge red">Просрочено</span>' : ''}</div>`);
  }
  if (can(3)) {
    const list = (l.assignments || []).map(a => `<span class="badge">${esc(a.employeeId ? employeeName(a.employeeId) : locationName(a.locationId))}${a.dueDate ? ` · до ${esc(a.dueDate)}` : ''} <button type="button" class="secondary" style="padding:2px 8px" data-unassign="${a.id}" data-unassign-lesson="${l.id}">✕</button></span>`).join(' ');
    parts.push(`<div class="assign-box"><div class="chips">${list || '<span class="muted">Назначений нет — урок виден всем</span>'}</div>
    <form class="row" data-assign-form="${l.id}">
      <select name="locationId"><option value="">Точка…</option>${appState.locations.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
      <select name="employeeId"><option value="">Сотрудник…</option>${appState.employees.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
      <input type="date" name="dueDate" title="Срок прохождения">
      <button class="secondary" type="submit">Назначить</button>
    </form></div>`);
  }
  return parts.join('');
}

function lessonHtml(l) {
  const r = l.myResult;
  if (!l.videoUrl) {
    return `<div class="lesson-block"><div class="row"><span>${esc(l.title)}</span><button class="secondary" data-lesson="${l.id}" data-done="${l.done ? 'false' : 'true'}">${l.done ? 'Пройдено ✓' : 'Отметить пройденным'}</button></div>${l.content ? `<p>${esc(l.content)}</p>` : ''}${assignmentHtml(l)}</div>`;
  }
  return `<div class="lesson-block">
    <div class="row"><strong>${esc(l.title)}</strong>${r?.completedAt ? '<span class="badge green">завершено</span>' : ''}</div>
    ${l.content ? `<p>${esc(l.content)}</p>` : ''}
    ${videoEmbedHtml(l.videoUrl)}
    <div class="row">
      ${r?.watched ? '<span class="badge green">Видео просмотрено ✓</span>' : `<button class="primary" data-watch-lesson="${l.id}">✓ Я посмотрел видео</button>`}
      ${l.questionCount ? (r?.completedAt ? `<span class="badge green">Тест пройден · ${esc(r.score)}/${esc(r.total)}</span>` : `<button class="secondary" data-quiz-toggle="${l.id}" ${r?.watched ? '' : 'disabled'}>Пройти тест · ${l.questionCount} вопр.</button>`) : ''}
    </div>
    ${l.questionCount && !r?.watched ? '<p class="hint">Тест откроется после отметки о просмотре видео.</p>' : ''}
    ${l.questionCount && r && !r.completedAt && r.score != null ? `<p class="hint">Последняя попытка: ${esc(r.score)} из ${esc(r.total)}. Для завершения нужны все правильные ответы — можно пройти ещё раз.</p>` : ''}
    <div class="quiz-box hidden" data-quiz-box="${l.id}"></div>
    ${assignmentHtml(l)}
  </div>`;
}

function renderLearning(page) {
  const locF = trainingLocFilter;
  const apRows = (appState.assignmentProgress || []).filter(p => locF === 'all' || p.locationId === Number(locF));
  const tpRows = (appState.trainingProgress || []).filter(p => locF === 'all' || p.locationId === Number(locF));
  page.innerHTML = `${pageHead('Обучение', 'Видеоуроки с тестами, курсы, база знаний и документы')}
    ${(appState.myAssignments || []).length ? `<div class="card" style="margin-bottom:14px"><h2>Мои назначенные уроки</h2><div class="list">${appState.myAssignments.map(a => `<div class="item"><div class="row"><div><strong>${esc(a.lessonTitle)}</strong><p>${esc(a.courseTitle)}${a.dueDate ? ` · срок до ${esc(fmtDue(a.dueDate))}` : ''}</p></div>${a.completed ? '<span class="badge green">завершено</span>' : a.overdue ? '<span class="badge red">Просрочено</span>' : a.watched ? '<span class="badge">видео просмотрено</span>' : '<span class="badge gray">не начато</span>'}</div></div>`).join('')}</div></div>` : ''}
    <div class="grid two"><div class="card"><h2>Курсы и видеоуроки</h2>${can(3) ? `<form id="courseForm" class="stack"><label>Название курса<input name="title" required></label><label>Описание<textarea name="description"></textarea></label><button class="primary">Создать курс</button></form>` : ''}
    <div class="list" style="margin-top:14px">${appState.courses.map(c => `<article class="item"><strong>${esc(c.title)}</strong><p>${esc(c.description || '')}</p>${c.lessons.map(lessonHtml).join('')}${can(3) ? `<form class="stack" data-lesson-form="${c.id}"><label>Новый урок<input name="title" required></label><label>Содержание<textarea name="content"></textarea></label><label>Ссылка на видео <span class="optional">(YouTube или файл mp4)</span><input name="videoUrl" placeholder="https://www.youtube.com/watch?v=…"></label><label>Вопросы теста <span class="optional">(необязательно)</span><textarea name="questionsText" rows="7" placeholder="Вопрос?&#10;- вариант&#10;* правильный вариант&#10;- вариант&#10;&#10;Следующий вопрос?&#10;- вариант&#10;* правильный вариант"></textarea></label><p class="hint">Тест: вопрос, под ним варианты по одному в строке; правильный вариант отметьте звёздочкой в начале строки. Вопросы разделяйте пустой строкой.</p><button class="secondary">Добавить урок</button></form>` : ''}</article>`).join('') || '<p class="muted">Курсов нет.</p>'}</div></div>
    <div><div class="card"><h2>База знаний</h2>${can(3) ? `<form id="kbForm" class="stack"><label>Заголовок<input name="title" required></label><label>Текст<textarea name="body"></textarea></label><button class="primary">Добавить статью</button></form>` : ''}<div class="list" style="margin-top:14px">${appState.kb.map(a => `<article class="item"><strong>${esc(a.title)}</strong><p>${esc(a.body)}</p></article>`).join('') || '<p class="muted">Статей нет.</p>'}</div></div>
    <div class="card" style="margin-top:14px"><h2>Документы</h2>${can(3) ? `<form id="documentForm" class="stack"><label>Название<input name="title" required></label><label>Текст<textarea name="body"></textarea></label><label>Ссылка<input name="url"></label><button class="primary">Добавить документ</button></form>` : ''}<div class="list" style="margin-top:14px">${appState.documents.map(d => `<article class="item"><strong>${esc(d.title)}</strong><p>${esc(d.body)}</p>${d.url ? `<p><a href="${esc(d.url)}" target="_blank" rel="noreferrer">Открыть</a></p>` : ''}${d.acknowledged ? '<span class="badge green">ознакомлен</span>' : `<button class="secondary" data-ack-document="${d.id}">Ознакомлен</button>`}</article>`).join('') || '<p class="muted">Документов нет.</p>'}</div></div>
    ${can(3) ? `<div class="card" style="margin-top:14px"><h2>Прогресс обучения</h2>
    <label>Точка <select id="trainingLocFilter"><option value="all" ${locF === 'all' ? 'selected' : ''}>Все точки</option>${appState.locations.map(x => `<option value="${x.id}" ${String(x.id) === String(locF) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    ${apRows.length ? `<h3 style="margin-top:12px">Назначения и сроки</h3><div class="list">${apRows.map(p => `<div class="item"><div class="row"><div><strong>${esc(p.employeeName)}</strong><p>${esc(p.courseTitle)} · ${esc(p.lessonTitle)}</p><small class="muted">${esc(locationName(p.locationId))}${p.dueDate ? ` · срок до ${esc(p.dueDate)}` : ''}${p.direct ? ' · назначено лично' : ''}</small></div>${p.completed ? `<span class="badge green">завершено${p.score != null && p.total != null ? ` · ${esc(p.score)}/${esc(p.total)}` : ''}</span>` : p.overdue ? '<span class="badge red">Просрочено</span>' : p.watched ? '<span class="badge">видео просмотрено</span>' : '<span class="badge gray">не начато</span>'}</div></div>`).join('')}</div>` : ''}
    <div class="list" style="margin-top:12px">${tpRows.map(p => `<div class="item"><div class="row"><div><strong>${esc(p.employeeName)}</strong><p>${esc(p.courseTitle)} · ${esc(p.lessonTitle)}</p><small class="muted">${esc(locationName(p.locationId))}</small></div>${p.completedAt ? `<span class="badge green">завершено · ${esc(p.score == null ? '✓' : `${p.score}/${p.total}`)}</span>` : p.watched ? '<span class="badge">видео просмотрено</span>' : '<span class="badge gray">начато</span>'}</div></div>`).join('') || '<p class="muted">Пока никто не начал видеоуроки.</p>'}</div></div>` : ''}</div></div>`;
  const cf = $('#courseForm', page); if (cf) cf.addEventListener('submit', async e => { e.preventDefault(); await api('/api/courses', { method: 'POST', body: JSON.stringify(formObject(e.target)) }); await loadState(); });
  $$('[data-lesson-form]', page).forEach(f => f.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(f); const questions = parseQuestionsText(d.questionsText);
    if (String(d.questionsText || '').trim() && !questions.length) { toast('Не удалось разобрать вопросы теста — проверьте формат: вопрос, варианты, правильный отмечен звёздочкой'); return; }
    await api(`/api/courses/${f.dataset.lessonForm}/lessons`, { method: 'POST', body: JSON.stringify({ title: d.title, content: d.content, videoUrl: d.videoUrl, questions }) }); toast('Урок добавлен'); await loadState(); }));
  $$('[data-lesson]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/lessons/${b.dataset.lesson}/progress`, { method: 'POST', body: JSON.stringify({ done: b.dataset.done === 'true' }) }); await loadState(); }));
  $$('[data-watch-lesson]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/lessons/${b.dataset.watchLesson}/watch`, { method: 'POST', body: JSON.stringify({}) }); toast('Просмотр отмечен'); await loadState(); }));
  $$('[data-assign-form]', page).forEach(f => f.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(f);
    if ((d.locationId && d.employeeId) || (!d.locationId && !d.employeeId)) { toast('Выберите точку или сотрудника'); return; }
    const payload = { dueDate: d.dueDate || null };
    if (d.locationId) payload.locationId = Number(d.locationId); else payload.employeeId = Number(d.employeeId);
    await api(`/api/lessons/${f.dataset.assignForm}/assignments`, { method: 'POST', body: JSON.stringify(payload) }); toast('Назначение сохранено'); await loadState(); }));
  $$('[data-unassign]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/lessons/${b.dataset.unassignLesson}/assignments/${b.dataset.unassign}`, { method: 'DELETE' }); toast('Назначение снято'); await loadState(); }));
  const locFilterEl = $('#trainingLocFilter', page); if (locFilterEl) locFilterEl.addEventListener('change', () => { trainingLocFilter = locFilterEl.value; render(); });
  $$('[data-quiz-toggle]', page).forEach(b => b.addEventListener('click', async () => {
    const box = $(`[data-quiz-box="${b.dataset.quizToggle}"]`, page);
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    const data = await api(`/api/lessons/${b.dataset.quizToggle}/quiz`);
    box.innerHTML = `<form class="stack" data-quiz-form="${b.dataset.quizToggle}">${data.questions.map((q, qi) => `<fieldset class="quiz-q"><legend>${esc(q.question)}</legend>${q.options.map((o, oi) => `<label class="checkline"><input type="radio" name="q${qi}" value="${oi}" required> ${esc(o)}</label>`).join('')}</fieldset>`).join('')}<button class="primary" type="submit">Отправить ответы</button></form>`;
    box.classList.remove('hidden');
    $(`[data-quiz-form="${b.dataset.quizToggle}"]`, box).addEventListener('submit', async e => { e.preventDefault(); const fd = new FormData(e.target);
      const answers = data.questions.map((q, qi) => { const v = fd.get(`q${qi}`); return v === null ? -1 : Number(v); });
      const res = await api(`/api/lessons/${b.dataset.quizToggle}/quiz`, { method: 'POST', body: JSON.stringify({ answers }) });
      toast(res.completed ? `Тест пройден: ${res.score} из ${res.total} ✓` : `Балл: ${res.score} из ${res.total} — попробуйте ещё раз`);
      await loadState(); });
  }));
  const kb = $('#kbForm', page); if (kb) kb.addEventListener('submit', async e => { e.preventDefault(); await api('/api/kb', { method: 'POST', body: JSON.stringify(formObject(e.target)) }); await loadState(); });
  const df = $('#documentForm', page); if (df) df.addEventListener('submit', async e => { e.preventDefault(); await api('/api/documents', { method: 'POST', body: JSON.stringify(formObject(e.target)) }); await loadState(); });
  $$('[data-ack-document]', page).forEach(b => b.addEventListener('click', async () => { await api(`/api/documents/${b.dataset.ackDocument}/ack`, { method: 'POST' }); await loadState(); }));
}

function renderChat(page) {
  const channel = appState.channels.find(c => c.id === Number(selectedChannelId)) || appState.channels[0];
  const messages = channel ? appState.messages.filter(m => m.channelId === channel.id) : [];
  page.innerHTML = `${pageHead('Чат', 'Каналы видны только рангам своего уровня и выше')}
    <div class="chips">${appState.channels.map(c => `<button data-channel="${c.id}" class="${channel?.id === c.id ? 'active' : ''}">${esc(c.name)} · от ${c.minRank}</button>`).join('')}</div>
    ${channel ? `<div class="card"><h2>${esc(channel.name)}</h2><div class="chat-box">${messages.map(m => `<div class="message ${m.employeeId === appState.me.id ? 'mine' : ''}"><strong>${esc(m.author)}</strong><p>${esc(m.body)}</p><small class="muted">${esc(fmtDate(m.createdAt))}</small></div>`).join('') || '<p class="muted">Сообщений пока нет.</p>'}</div><form id="messageForm" class="stack"><label>Сообщение<textarea name="body" required></textarea></label><button class="primary">Отправить</button></form></div>` : '<div class="card">Нет доступных каналов.</div>'}`;
  $$('[data-channel]', page).forEach(b => b.addEventListener('click', () => { selectedChannelId = Number(b.dataset.channel); render(); }));
  const form = $('#messageForm', page); if (form) form.addEventListener('submit', async e => { e.preventDefault(); await api(`/api/channels/${channel.id}/messages`, { method: 'POST', body: JSON.stringify(formObject(e.target)) }); await loadState(); });
}

function ratingTable(title, rows, locationRows = false) {
  return `<div class="card"><h2>${esc(title)}</h2>${rows?.length ? `<div class="table-wrap"><table><thead><tr><th>${locationRows ? 'Точка' : 'Сотрудник'}</th><th>Поинты</th><th>Эффективность</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(locationRows ? r.name : `${r.name} · ${r.position || ''}`)}</td><td>${esc(locationRows ? r.avgPoints : r.points)}</td><td>${esc(locationRows ? r.avgEfficiency : r.efficiency)}%</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Данных пока нет.</p>'}</div>`;
}
function renderRating(page) {
  const published = appState.publishedRatings;
  page.innerHTML = `${pageHead('Рейтинг', 'Поинты, эффективность и недельная публикация')}
    <div class="grid three"><div class="card"><div class="metric">${esc(appState.dashboard.myPoints)} ⭐</div><div class="metric-label">Мой баланс</div></div><div class="card"><div class="metric">${esc(appState.dashboard.myEfficiency)}%</div><div class="metric-label">Моя эффективность</div></div><div class="card"><div class="metric">${esc(appState.weeklyBonusPoints || 10)}</div><div class="metric-label">Бонус за чистую неделю</div></div></div>
    ${can(3) ? `<div class="grid two section"><form id="awardForm" class="card stack"><h2>Награда или списание</h2><label>Сотрудник<select name="employeeId">${employeeOptions()}</select></label><label>Поинты<input type="number" name="points" required placeholder="+10 или -5"></label><label>Причина<input name="reason" required></label><button class="primary">Сохранить</button><p class="hint">Положительные награды — управляющий и выше; списания — только владелец.</p></form>
    <form id="violationForm" class="card stack"><h2>Замечание</h2><label>Сотрудник<select name="employeeId">${employeeOptions()}</select></label><label>Дата<input type="date" name="occurredOn" required></label><label>Причина<input name="reason" required></label><button class="secondary">Добавить замечание</button><p class="hint">Замечание отменяет недельный бонус за свою неделю.</p></form></div>` : ''}
    ${appState.me.rank === 'owner' ? `<div class="card section"><h2>Недельный цикл</h2><p class="muted">В production цикл запускается по понедельникам в 07:13 (America/New_York): бонусы за завершённую неделю и публикация таблиц.</p><button class="primary" id="runWeekly">Запустить за прошлую неделю сейчас</button></div>` : ''}
    <section class="section grid two"><div>${ratingTable('Опубликованный рейтинг сотрудников', published?.employees || [])}</div><div>${ratingTable('Опубликованный рейтинг локаций', published?.locations || [], true)}</div></section>
    <section class="section"><h2>Моя история поинтов</h2><div class="list">${appState.pointEvents.filter(e => e.employeeId === appState.me.id).map(e => `<div class="item"><div class="row"><strong>${e.points > 0 ? '+' : ''}${esc(e.points)} ⭐</strong><span class="badge">${esc(e.type)}</span></div><p>${esc(e.reason)}</p><small class="muted">${esc(fmtDate(e.createdAt))}</small></div>`).join('') || '<div class="card">История пуста.</div>'}</div></section>`;
  const af = $('#awardForm', page); if (af) af.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(e.target); d.employeeId = Number(d.employeeId); d.points = Number(d.points); const r = await api('/api/points/award', { method: 'POST', body: JSON.stringify(d) }); toast(`Баланс: ${r.balance}`); await loadState(); });
  const vf = $('#violationForm', page); if (vf) vf.addEventListener('submit', async e => { e.preventDefault(); const d = formObject(e.target); d.employeeId = Number(d.employeeId); await api('/api/violations', { method: 'POST', body: JSON.stringify(d) }); toast('Замечание добавлено'); await loadState(); });
  const run = $('#runWeekly', page); if (run) run.addEventListener('click', async () => { const r = await api('/api/jobs/weekly', { method: 'POST', body: JSON.stringify({}) }); toast(`Неделя ${r.weekKey}: бонусов ${r.bonusesAwarded}`); await loadState(); });
}

function updateInstallUi() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#installCard').classList.toggle('hidden', standalone || !token);
  $('#installButton').textContent = standalone ? '✓ Как приложение' : '📲 На рабочий стол';
}
async function installApp() {
  if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; updateInstallUi(); return; }
  $('#installDialog').showModal();
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; updateInstallUi(); });
window.addEventListener('appinstalled', updateInstallUi);
$('#installButton').addEventListener('click', installApp);
$('#installCardButton').addEventListener('click', installApp);
$('#logoutButton').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} showAuth(); });
$$('#bottomNav button').forEach(b => b.addEventListener('click', () => { currentTab = b.dataset.tab; render(); }));
$('#showLogin').addEventListener('click', () => { $('#showLogin').classList.add('active'); $('#showRegister').classList.remove('active'); $('#loginForm').classList.remove('hidden'); $('#regStep1Form').classList.add('hidden'); $('#regCodeForm').classList.add('hidden'); $('#regStep2Form').classList.add('hidden'); $('#resetStep1Form').classList.add('hidden'); $('#resetStep2Form').classList.add('hidden'); });
$('#showRegister').addEventListener('click', () => { $('#showRegister').classList.add('active'); $('#showLogin').classList.remove('active'); $('#regStep1Form').classList.remove('hidden'); $('#regCodeForm').classList.add('hidden'); $('#regStep2Form').classList.add('hidden'); $('#loginForm').classList.add('hidden'); $('#resetStep1Form').classList.add('hidden'); $('#resetStep2Form').classList.add('hidden'); });
$('#loginForm').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { const d = formObject(e.target); d.pin = d.password; const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(d) }); token = result.token; localStorage.setItem(tokenKey, token); await loadState(); } catch (error) { setAuthError(error.message); } });
let resetContact = '';
function showResetStep(step) { $('#loginForm').classList.add('hidden'); $('#regStep1Form').classList.add('hidden'); $('#regCodeForm').classList.add('hidden'); $('#regStep2Form').classList.add('hidden'); $('#resetStep1Form').classList.toggle('hidden', step !== 1); $('#resetStep2Form').classList.toggle('hidden', step !== 2); }
$('#forgotLink').addEventListener('click', () => { setAuthError(''); showResetStep(1); });
$('#resetBack1').addEventListener('click', () => { $('#showLogin').click(); });
$('#resetBack2').addEventListener('click', () => { $('#showLogin').click(); });
$('#resetStep1Form').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { const d = formObject(e.target); resetContact = d.contact; const result = await api('/api/auth/reset/request', { method: 'POST', body: JSON.stringify(d) }); $('#resetCodeHint').textContent = `Код отправлен (${result.sentTo || ''}). Действует 10 минут.`; showResetStep(2); } catch (error) { setAuthError(error.message); } });
$('#resetStep2Form').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { const d = formObject(e.target); const result = await api('/api/auth/reset/confirm', { method: 'POST', body: JSON.stringify({ contact: resetContact, code: d.code, password: d.password }) }); token = result.token; localStorage.setItem(tokenKey, token); await loadState(); } catch (error) { setAuthError(error.message); } });
let regStep1Data = {};
let regPendingId = null;
function showRegStep(which) {
  $('#regStep1Form').classList.toggle('hidden', which !== 1);
  $('#regCodeForm').classList.toggle('hidden', which !== 'code');
  $('#regStep2Form').classList.toggle('hidden', which !== 2);
}
$('#regStep1Form').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); regStep1Data = formObject(e.target); try {
  const start = await api('/api/auth/register/start', { method: 'POST', body: JSON.stringify(regStep1Data) });
  if (start.verificationRequired) {
    regPendingId = start.pendingId;
    $('#regCodeHint').textContent = `Мы отправили 6-значный код на ${start.email}. Введите его сюда — код действует 10 минут.`;
    showRegStep('code'); $('#regCodeForm [name="code"]').focus();
  } else {
    regPendingId = null;
    showRegStep(2); $('#regStep2Form [name="password"]').focus();
  }
} catch (error) { setAuthError(error.message); } });
$('#regCodeForm').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { await api('/api/auth/register/verify', { method: 'POST', body: JSON.stringify({ pendingId: regPendingId, code: formObject(e.target).code }) }); showRegStep(2); $('#regStep2Form [name="password"]').focus(); } catch (error) { setAuthError(error.message); } });
$('#regResend').addEventListener('click', async () => { setAuthError(''); try { await api('/api/auth/register/resend', { method: 'POST', body: JSON.stringify({ pendingId: regPendingId }) }); toast('Код отправлен ещё раз'); } catch (error) { setAuthError(error.message); } });
$('#regCodeBack').addEventListener('click', () => showRegStep(1));
$('#regBack').addEventListener('click', () => showRegStep(1));
$('#regStep2Form').addEventListener('submit', async e => { e.preventDefault(); setAuthError(''); try { const pw = formObject(e.target); const payload = regPendingId ? { pendingId: regPendingId, password: pw.password } : { ...regStep1Data, ...pw }; const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }); token = result.token; localStorage.setItem(tokenKey, token); await loadState(); } catch (error) { setAuthError(error.message); } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => { try { await loadBootstrap(); if (token) await loadState(); } catch (error) { if (token) showAuth(); setAuthError(error.message); } })();
