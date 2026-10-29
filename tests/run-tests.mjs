#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shawa-ceo-test-'));
const db = path.join(tmp, 'test.sqlite');
const port = 18787 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

// --- Mock Clover API: a local stand-in for https://api.clover.com ---
// Merchant GOODMID accepts only "Bearer good-token"; anything else is a 401,
// exactly like the real API rejecting a bad/rotated merchant token.
const cloverT1 = Date.now() - 3600000;
const mockOrders = [
  { id: 'CLV-ORD-A', total: 1199, createdTime: cloverT1, modifiedTime: cloverT1, payments: { elements: [{ result: 'SUCCESS', taxAmount: 84 }] }, lineItems: { elements: [{ id: 'LI-A1', name: 'Шаурма куриная классическая', price: 1199, unitQty: 1000, item: { id: 'CLV-UNMAPPED-1' } }] } },
  { id: 'CLV-ORD-B', total: 500, createdTime: cloverT1, modifiedTime: cloverT1, payments: { elements: [{ result: 'SUCCESS', taxAmount: 35 }] }, lineItems: { elements: [{ id: 'LI-B1', name: 'Mystery Item', price: 500, unitQty: 1000 }] } },
  { id: 'CLV-ORD-C', total: 999, createdTime: cloverT1, modifiedTime: cloverT1, paymentState: 'OPEN', payments: { elements: [] }, lineItems: { elements: [] } }
];
let mockItemCounter = 0;
const cloverMock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'v3' || parts[1] !== 'merchants') return send(404, { message: 'not found' });
  const mid = parts[2];
  if (mid !== 'GOODMID' || req.headers.authorization !== 'Bearer good-token') return send(401, { message: 'Invalid access token' });
  if (req.method === 'GET' && parts.length === 3) return send(200, { id: mid, name: 'SHAWA Test Merchant' });
  if (req.method === 'GET' && parts[3] === 'orders') {
    const match = /modifiedTime>=(\d+)/.exec(url.searchParams.get('filter') || '');
    const since = match ? Number(match[1]) : 0;
    return send(200, { elements: mockOrders.filter(o => o.modifiedTime >= since) });
  }
  if (req.method === 'POST' && parts[3] === 'items' && parts.length === 4) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { const parsedBody = JSON.parse(raw || '{}'); mockItemCounter += 1; send(200, { id: `CLV-ITEM-${mockItemCounter}`, name: parsedBody.name, price: parsedBody.price }); });
    return;
  }
  if (req.method === 'POST' && parts[3] === 'items' && parts.length === 5) return send(200, { id: parts[4] });
  return send(404, { message: 'not found' });
});
await new Promise(resolve => cloverMock.listen(0, '127.0.0.1', resolve));
const cloverMockBase = `http://127.0.0.1:${cloverMock.address().port}`;

execFileSync(process.execPath, [path.join(root, 'tools/seed-db.mjs'), '--db', db, '--force'], { stdio: 'inherit' });
const server = spawn(process.execPath, [path.join(root, 'tools/local-server.mjs'), '--db', db, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLOVER_API_BASE: cloverMockBase, INVOICE_INBOUND_SECRET: ['test', 'inbound', 'secret'].join('-'), OPS_ALERT_SECRET: ['test', 'ops', 'secret'].join('-') } });
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

// --- Invoice parser unit tests (pure module, real-world fixtures) ---
const { parseInvoiceText, parseInvoiceLine } = await import('../public/purchase-parse.js');
{
  const fixtureIngredients = [{ id: 11, name: 'Chicken Breast' }, { id: 12, name: 'Tomatoes' }, { id: 13, name: 'Молоко' }];
  const l1 = parseInvoiceLine('Chicken Breast 10 lb $24.90');
  assert.equal(l1.qty, 10); assert.equal(l1.unit, 'lb');
  assert.ok(Math.abs(l1.totalCost - 24.9) < 0.001, `l1 total ${l1.totalCost}`);
  assert.equal(l1.name, 'Chicken Breast');
  const l2 = parseInvoiceLine('Tomatoes 5 kg 1 250.00');
  assert.equal(l2.qty, 5); assert.equal(l2.unit, 'kg'); assert.equal(l2.totalCost, 1250);
  const l3 = parseInvoiceLine('Молоко 3.2% 10 л 950');
  assert.equal(l3.qty, 10); assert.equal(l3.unit, 'л'); assert.equal(l3.totalCost, 950);
  assert.ok(l3.name.includes('Молоко'), `l3 name ${l3.name}`);
  const parsed = parseInvoiceText('INVOICE #4471\nChicken Breast 10 lb $24.90\nTomatoes 5 kg 1 250.00\nМолоко 3.2% 10 л 950\nTotal 2 224.90', fixtureIngredients);
  assert.equal(parsed.length, 3, `parsed lines ${JSON.stringify(parsed)}`);
  assert.equal(parsed[0].ingredientId, 11);
  assert.equal(parsed[1].ingredientId, 12);
  assert.equal(parsed[2].ingredientId, 13);
  console.log('Invoice parser unit tests passed.');
}

// --- Inbound invoice store unit test: a real PDF attachment is parsed ---
{
  const { storeInboundInvoice } = await import('../src/invoice-inbound.js');
  const { LocalD1 } = await import('../tools/local-db.mjs');
  const unitDbPath = path.join(tmp, 'inbound-unit.sqlite');
  const unitDb = new LocalD1(unitDbPath);
  for (const file of fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await unitDb.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
  }
  const ingInsert = await unitDb.prepare('INSERT INTO ingredients(name, unit, stock, min_stock, cost_per_unit_cents) VALUES (?, ?, 0, 0, 0)').bind('Chicken Breast', 'lb').run();
  const unitIngredientId = ingInsert.meta.last_row_id;
  const makePdf = (text) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    let out = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((bodyText, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${bodyText}\nendobj\n`; });
    const xrefAt = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
    return new TextEncoder().encode(out);
  };
  const stored = await storeInboundInvoice({ DB: unitDb }, {
    sender: 'Supplier Co <billing@supplier.example>', subject: 'Invoice PDF',
    bodyText: '', todayKey: '2026-10-26',
    attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: makePdf('Chicken Breast 10 lb 24.90') }]
  });
  assert.ok(stored.id, 'inbound draft stored');
  assert.equal(stored.lines, 1, `pdf parsed lines ${JSON.stringify(stored)}`);
  const row = await unitDb.prepare('SELECT * FROM invoice_drafts WHERE id = ?').bind(stored.id).first();
  assert.equal(row.status, 'pending');
  assert.equal(row.attachment_kind, 'pdf');
  const draftLines = JSON.parse(row.lines_json);
  assert.equal(draftLines[0].ingredientId, unitIngredientId);
  assert.equal(draftLines[0].qty, 10);
  unitDb.close();
  console.log('Inbound invoice (PDF) unit test passed.');
}

try {
  await waitReady();

  // Bootstrap: company name, 4 seeded locations with exact addresses/statuses, 26 menu items.
  const bootstrap = await req('/api/bootstrap');
  assert.equal(bootstrap.companyName, 'SHAWA GRILL & MANGAL');
  assert.equal(bootstrap.hasOwner, false);
  assert.equal(bootstrap.locations.length, 4);
  assert.equal(bootstrap.locations[0].address, '17066 Collins Ave, Sunny Isles Beach, FL 33160');
  assert.equal(bootstrap.locations[1].address, '2929 Biscayne Blvd, Miami, FL 33137');
  assert.equal(bootstrap.locations[2].address, '2630 W Broward Blvd, Ste 105, Fort Lauderdale, FL 33312');
  assert.equal(bootstrap.locations[3].address, '410 NE 1st Ave, Suite 8, Hallandale Beach, FL');
  assert.equal(bootstrap.locations[3].status, 'opening');

  // Registration without invite before owner exists -> first becomes owner.
  const ownerReg = await req('/api/auth/register', { method: 'POST', body: { firstName: 'Тест', lastName: 'Владелец', contact: 'owner@test.local', password: 'ownerpass' }, expected: 201 });
  assert.equal(ownerReg.employee.rank, 'owner');
  const owner = ownerReg.token;

  // Second registration without invite is forbidden.
  await req('/api/auth/register', { method: 'POST', body: { firstName: 'Чужой', lastName: 'Человек', contact: 'stranger@test.local', password: 'strangerpass' }, expected: 403 });

  // Owner sets own password already done at registration; login works.
  const ownerLogin = await req('/api/auth/login', { method: 'POST', body: { contact: 'owner@test.local', password: 'ownerpass' } });
  assert.equal(ownerLogin.employee.rank, 'owner');
  await req('/api/auth/login', { method: 'POST', body: { contact: 'owner@test.local', password: 'wrong' }, expected: 401 });

  // Menu seed check via state.
  let state = await req('/api/state', { token: owner });
  assert.equal(state.menu.length, 26);
  const classic = state.menu.find(m => m.code === 'ch-classic');
  assert.equal(classic.price, 11.99);
  const plateMix = state.menu.find(m => m.code === 'plate-mix');
  assert.equal(plateMix.price, 24.99);

  // Personal invite bound to the cook's contact; wrong contact rejected.
  const boundInvite = await req('/api/invites', { method: 'POST', token: owner, body: { position: 'Повар', locationId: 1, contact: 'cook@test.local' } });
  assert.equal(boundInvite.invite.contact, 'cook@test.local');
  await req('/api/auth/register', { method: 'POST', body: { firstName: 'Не', lastName: 'Тот', contact: 'other@test.local', password: 'otherpass', inviteCode: boundInvite.invite.code }, expected: 400 });
  const cookReg = await req('/api/auth/register', { method: 'POST', body: { firstName: 'Тест', lastName: 'Повар', contact: 'cook@test.local', pin: '4321', password: 'cookpass', inviteCode: boundInvite.invite.code }, expected: 201 });
  const cook = cookReg.token;
  const cookId = cookReg.employee.id;
  assert.equal(cookReg.employee.position, 'Повар');
  assert.equal(cookReg.employee.locationId, 1);

  // Owner sets the cook's rate; cook must NOT see any rate or pay in API payloads.
  await req(`/api/employees/${cookId}`, { method: 'PATCH', token: owner, body: { hourlyRate: 18 } });
  const cookRaw = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${cook}` } })).text();
  assert.ok(!cookRaw.includes('hourlyRate'), 'non-owner state must not contain hourlyRate');
  const cookState = JSON.parse(cookRaw);
  assert.equal(cookState.employees.length, 1, 'staff sees only own card');
  await req(`/api/employees/${cookId}`, { method: 'PATCH', token: cook, body: { hourlyRate: 99 }, expected: 403 });

  // Clover settings: owner-only, stored, token never returned.
  await req('/api/settings/clover', { token: cook, expected: 403 });
  await req('/api/settings/clover', { method: 'POST', token: owner, body: { merchantId: 'TESTMERCH1', token: 'test-token-value' } });
  const clover = await req('/api/settings/clover', { token: owner });
  assert.equal(clover.merchantId, 'TESTMERCH1');
  assert.equal(clover.hasToken, true);
  assert.equal(clover.connected, false);
  assert.ok(!JSON.stringify(clover).includes('test-token-value'), 'Clover token value must never be returned');

  // Ingredients + purchase -> stock grows, unit cost updates.
  const chicken = await req('/api/ingredients', { method: 'POST', token: owner, body: { name: 'Курица маринованная', unit: 'г', minStock: 1000 } });
  const pita = await req('/api/ingredients', { method: 'POST', token: owner, body: { name: 'Пита', unit: 'шт', minStock: 10 } });
  await req('/api/purchases', { method: 'POST', token: owner, body: { ingredientId: chicken.id, qty: 5000, totalCost: 100 } });
  await req('/api/purchases', { method: 'POST', token: owner, body: { ingredientId: pita.id, qty: 100, totalCost: 20 } });
  state = await req('/api/state', { token: owner });
  const chickenRow = state.ingredients.find(i => i.id === chicken.id);
  assert.equal(chickenRow.stock, 5000);
  assert.equal(chickenRow.costPerUnit, 0.02);

  // Recipe for classic shawarma: 200 g chicken + 1 pita -> cost 200*2c + 20c = $4.20, foodcost 35%.
  const recipePut = await req(`/api/menu/${classic.id}/recipe`, { method: 'PUT', token: owner, body: { lines: [{ ingredientId: chicken.id, qty: 200 }, { ingredientId: pita.id, qty: 1 }] } });
  assert.equal(recipePut.costCents, 420);
  state = await req('/api/state', { token: owner });
  const classicNow = state.menu.find(m => m.id === classic.id);
  assert.equal(classicNow.cost, 4.2);
  assert.equal(classicNow.foodCostPct, 35);

  // Write-off and stocktake adjust stock with a diff record.
  await req('/api/writeoffs', { method: 'POST', token: owner, body: { ingredientId: pita.id, qty: 5, reason: 'Испорчено' } });
  const take = await req('/api/stocktakes', { method: 'POST', token: owner, body: { ingredientId: pita.id, actualQty: 90 } });
  assert.equal(take.diff, -5);
  state = await req('/api/state', { token: owner });
  assert.equal(state.ingredients.find(i => i.id === pita.id).stock, 90);

  // Purchase document with 3 lines (one creates an ingredient inline) + photo:
  // both stocks grow, unit costs refresh, history and photo are readable.
  const docPhoto = 'aGVsbG8td29ybGQ='; // "hello-world", stands in for a JPEG payload
  const docRes = await req('/api/purchase-documents', {
    method: 'POST', token: owner,
    body: {
      supplier: 'Тест Поставщик', docDate: '2026-10-22', note: 'Тестовый счёт', source: 'scan', photoJpeg: docPhoto,
      lines: [
        { ingredientId: chicken.id, qty: 1000, totalCost: 30 },
        { ingredientId: pita.id, qty: 10, totalCost: 3 },
        { newIngredient: { name: 'Специя тест', unit: 'г' }, qty: 100, totalCost: 5 }
      ]
    },
    expected: 201
  });
  assert.equal(docRes.totalCents, 3800);
  state = await req('/api/state', { token: owner });
  const chickenAfterDoc = state.ingredients.find(i => i.id === chicken.id);
  assert.equal(chickenAfterDoc.stock, 6000);
  assert.equal(chickenAfterDoc.costPerUnit, 0.03);
  const pitaAfterDoc = state.ingredients.find(i => i.id === pita.id);
  assert.equal(pitaAfterDoc.stock, 100);
  assert.equal(pitaAfterDoc.costPerUnit, 0.3);
  const spice = state.ingredients.find(i => i.name === 'Специя тест');
  assert.ok(spice, 'inline-created ingredient exists');
  assert.equal(spice.stock, 100);
  assert.equal(spice.costPerUnit, 0.05);
  const history = await req('/api/purchase-documents', { token: owner });
  const testDoc = history.documents.find(d => d.id === docRes.id);
  assert.ok(testDoc, 'document appears in history');
  assert.equal(testDoc.lines.length, 3);
  assert.equal(testDoc.total, 38);
  assert.equal(testDoc.hasPhoto, true);
  assert.equal(testDoc.source, 'scan');
  assert.equal(testDoc.supplier, 'Тест Поставщик');
  const photoBack = await req(`/api/purchase-documents/${docRes.id}/photo`, { token: owner });
  assert.equal(photoBack.photoJpeg, docPhoto);
  // Documents are manager+ only.
  await req('/api/purchase-documents', { token: cook, expected: 403 });
  await req('/api/purchase-documents', { method: 'POST', token: cook, body: { lines: [{ ingredientId: chicken.id, qty: 1, totalCost: 1 }] }, expected: 403 });
  // Legacy single purchase was already covered above and created 1-line documents:
  assert.ok(history.documents.filter(d => d.lines.length === 1).length >= 2, 'legacy purchases appear as one-line documents');

  // --- Inbound invoice drafts: webhook -> draft -> manual confirm/reject ---
  const inboundRaw = (headers, payload) => fetch(`${base}/api/invoice-inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload)
  });
  const badInbound = await inboundRaw({ 'x-invoice-secret': 'wrong' }, { from: 'X', text: 'Пита 1 шт 1.00' });
  assert.equal(badInbound.status, 403, 'inbound webhook rejects a wrong secret');
  const inboundText = 'Invoice INV-1001 from Sysco\nКурица маринованная 10 кг 250.00\nПита 20 шт 30.00\nTotal due 280.00 · 10/24/2026';
  const goodInbound = await inboundRaw({ 'x-invoice-secret': ['test', 'inbound', 'secret'].join('-') }, {
    from: 'Sysco <orders@sysco.example>', subject: 'Invoice #INV-1001', text: inboundText,
    attachments: [{ filename: 'inv-1001.jpg', contentType: 'image/jpeg', contentBase64: docPhoto }]
  });
  assert.equal(goodInbound.status, 201, 'inbound webhook accepts the shared secret');
  const inboundData = await goodInbound.json();
  assert.ok(inboundData.draftId, 'draft created');
  assert.equal(inboundData.lines, 2, `inbound parsed lines ${JSON.stringify(inboundData)}`);
  const draftsList = await req('/api/invoice-drafts', { token: owner });
  const draft = draftsList.drafts.find(d => d.id === inboundData.draftId);
  assert.ok(draft, 'draft visible in the panel list');
  assert.equal(draft.status, 'pending');
  assert.equal(draft.hasPhoto, true, 'jpeg attachment stored as the draft photo');
  assert.equal(draft.docDate, '2026-10-24', 'invoice date parsed from the message');
  assert.equal(draft.totalCents, 28000);
  assert.equal(draft.lines[0].ingredientId, chicken.id, 'line matched to the ingredient');
  await req('/api/invoice-drafts', { token: cook, expected: 403 });
  // Confirm: a real purchase document is posted, stock grows, origin is email.
  const chickenStockBefore = (await req('/api/state', { token: owner })).ingredients.find(i => i.id === chicken.id).stock;
  const confirmRes = await req(`/api/invoice-drafts/${draft.id}/confirm`, {
    method: 'POST', token: owner,
    body: { supplier: 'Sysco', docDate: draft.docDate, lines: draft.lines.map(l => ({ ingredientId: l.ingredientId, qty: l.qty, totalCost: l.totalCost })) },
    expected: 201
  });
  const chickenStockAfter = (await req('/api/state', { token: owner })).ingredients.find(i => i.id === chicken.id).stock;
  assert.equal(chickenStockAfter, chickenStockBefore + 10, 'confirm applies the draft to stock');
  const historyAfter = await req('/api/purchase-documents', { token: owner });
  const emailDoc = historyAfter.documents.find(d => d.id === confirmRes.id);
  assert.ok(emailDoc, 'confirmed draft appears in purchase history');
  assert.equal(emailDoc.emailOrigin, true, 'history marks the email origin');
  assert.equal(emailDoc.hasPhoto, true, 'draft photo carried into the document');
  await req(`/api/invoice-drafts/${draft.id}/confirm`, {
    method: 'POST', token: owner, body: { lines: [{ ingredientId: chicken.id, qty: 1, totalCost: 1 }] }, expected: 409
  });
  // Reject path: a second draft is discarded without touching stock.
  const secondInbound = await (await inboundRaw({ 'x-invoice-secret': ['test', 'inbound', 'secret'].join('-') }, { from: 'Spam', subject: 'junk', text: 'Пита 1 шт 1.00' })).json();
  await req(`/api/invoice-drafts/${secondInbound.draftId}/reject`, { method: 'POST', token: owner, body: {} });
  const draftsFinal = await req('/api/invoice-drafts', { token: owner });
  assert.equal(draftsFinal.drafts.find(d => d.id === secondInbound.draftId).status, 'rejected');
  console.log('Inbound invoice draft tests passed.');

  // Punches: cook clocks in/out for 2 hours; timesheet hours + owner-only pay.
  const inAt = new Date(Date.now() - 2 * 3600000).toISOString();
  const outAt = new Date().toISOString();
  await req('/api/punches', { method: 'POST', token: cook, body: { action: 'in', at: inAt, locationId: 1 } });
  await req('/api/punches', { method: 'POST', token: cook, body: { action: 'out', at: outAt } });
  const ownerTs = await req('/api/timesheet', { token: owner });
  const cookRowTs = ownerTs.rows.find(r => r.employeeId === cookId);
  assert.ok(Math.abs(cookRowTs.hours - 2) < 0.02, `owner timesheet hours ${cookRowTs.hours}`);
  assert.ok(Math.abs(cookRowTs.cost - 36) < 0.5, `owner timesheet pay ${cookRowTs.cost}`);
  const cookTsRaw = await (await fetch(`${base}/api/timesheet`, { headers: { authorization: `Bearer ${cook}` } })).text();
  assert.ok(!cookTsRaw.includes('"cost"'), 'staff timesheet must not contain cost');

  // Kiosk clock-in by employee id + PIN.
  await req('/api/punches/kiosk', { method: 'POST', body: { employeeId: cookId, pin: '0000', action: 'in' }, expected: 401 });
  await req('/api/punches/kiosk', { method: 'POST', body: { employeeId: cookId, pin: '4321', action: 'in', locationId: 1 }, expected: 201 });
  await req('/api/punches/kiosk', { method: 'POST', body: { employeeId: cookId, pin: '4321', action: 'out' } });

  // Order flow: 2x classic at table 3 -> cooking -> ready -> served.
  // Stock must drop by 2*200g chicken and 2 pita; dashboard revenue grows by $23.98.
  const before = await req('/api/state', { token: owner });
  const chickenBefore = before.ingredients.find(i => i.id === chicken.id).stock;
  const pitaBefore = before.ingredients.find(i => i.id === pita.id).stock;
  const revenueBefore = before.dashboard.revenueToday;
  const order = await req('/api/orders', { method: 'POST', token: cook, body: { locationId: 1, kind: 'dinein', tableNo: 3, items: [{ menuItemId: classic.id, qty: 2 }] }, expected: 201 });
  assert.equal(order.order.total, 23.98);
  assert.equal(order.order.status, 'new');
  await req(`/api/orders/${order.order.id}/status`, { method: 'POST', token: cook, body: { status: 'ready' }, expected: 400 });
  await req(`/api/orders/${order.order.id}/status`, { method: 'POST', token: cook, body: { status: 'cooking' } });
  await req(`/api/orders/${order.order.id}/status`, { method: 'POST', token: cook, body: { status: 'ready' } });
  const served = await req(`/api/orders/${order.order.id}/status`, { method: 'POST', token: cook, body: { status: 'served' } });
  assert.ok(served.order.servedAt);
  const after = await req('/api/state', { token: owner });
  assert.equal(after.ingredients.find(i => i.id === chicken.id).stock, chickenBefore - 400);
  assert.equal(after.ingredients.find(i => i.id === pita.id).stock, pitaBefore - 2);
  assert.ok(Math.abs(after.dashboard.revenueToday - (revenueBefore + 23.98)) < 0.001, `revenue ${revenueBefore} -> ${after.dashboard.revenueToday}`);
  assert.equal(after.dashboard.revenueTodayOrders, before.dashboard.revenueTodayOrders + 1);

  // --- Clover per-location integration (mock Clover API) ---
  // Credentials are owner-only; the token value is never returned.
  await req('/api/locations/1/clover', { token: cook, expected: 403 });
  await req('/api/locations/1/clover', { method: 'POST', token: cook, body: { merchantId: 'GOODMID', token: 'good-token' }, expected: 403 });
  const locSave = await req('/api/locations/1/clover', { method: 'POST', token: owner, body: { merchantId: 'GOODMID', token: 'good-token' } });
  assert.equal(locSave.clover.hasCreds, true);
  assert.equal(locSave.clover.hasToken, true);
  assert.equal(locSave.clover.connected, false, 'saved but not verified yet');
  assert.ok(!JSON.stringify(locSave).includes('good-token'), 'location Clover token must never be returned');
  state = await req('/api/state', { token: owner });
  assert.equal(state.clover.locations.find(l => l.locationId === 1).merchantId, 'GOODMID');
  assert.ok(!JSON.stringify(state).includes('good-token'), 'state must never contain the Clover token');

  // Connection check with a bad token -> friendly 502 text naming the 401.
  await req('/api/locations/1/clover', { method: 'POST', token: owner, body: { token: 'bad-token' } });
  const badCheck = await req('/api/locations/1/clover/test', { method: 'POST', token: owner, expected: 502 });
  assert.ok(badCheck.error.includes('401'), `friendly 401 text: ${badCheck.error}`);
  // Good token -> merchant name comes back and the location is "connected".
  await req('/api/locations/1/clover', { method: 'POST', token: owner, body: { token: 'good-token' } });
  const checked = await req('/api/locations/1/clover/test', { method: 'POST', token: owner });
  assert.equal(checked.merchantName, 'SHAWA Test Merchant');
  assert.equal(checked.clover.connected, true);

  // Sync: two paid orders import (the unpaid one is skipped). The line whose
  // name matches the classic shawarma maps to the dish and deducts the recipe
  // (200 g chicken + 1 pita); the unmatched line stays a text position but
  // its money still lands in revenue.
  const preSync = await req('/api/state', { token: owner });
  const chickenPreSync = preSync.ingredients.find(i => i.id === chicken.id).stock;
  const pitaPreSync = preSync.ingredients.find(i => i.id === pita.id).stock;
  const revenuePreSync = preSync.dashboard.revenueToday;
  const sync1 = await req('/api/locations/1/clover/sync', { method: 'POST', token: owner });
  assert.equal(sync1.imported, 2);
  assert.equal(sync1.skipped, 1);
  const postSync = await req('/api/state', { token: owner });
  assert.equal(postSync.ingredients.find(i => i.id === chicken.id).stock, chickenPreSync - 200);
  assert.equal(postSync.ingredients.find(i => i.id === pita.id).stock, pitaPreSync - 1);
  assert.ok(Math.abs(postSync.dashboard.revenueToday - (revenuePreSync + 16.99)) < 0.001, 'Clover totals count into revenue');
  const cloverOrders = postSync.orders.filter(o => o.source === 'clover');
  assert.equal(cloverOrders.length, 2, 'today Clover sales are visible on the board');
  const orderA = cloverOrders.find(o => o.cloverOrderId === 'CLV-ORD-A');
  assert.equal(orderA.items[0].menuItemId, classic.id, 'line matched to the dish by name');
  assert.equal(orderA.status, 'served');
  assert.ok(postSync.clover.locations.find(l => l.locationId === 1).lastSyncAt, 'last sync recorded');

  // Re-sync: the same orders return (inclusive watermark) and upsert —
  // no duplicates, no second stock deduction, revenue unchanged.
  const sync2 = await req('/api/locations/1/clover/sync', { method: 'POST', token: owner });
  assert.equal(sync2.imported, 0);
  assert.equal(sync2.updated, 2);
  const postSync2 = await req('/api/state', { token: owner });
  assert.equal(postSync2.orders.filter(o => o.source === 'clover').length, 2);
  assert.equal(postSync2.ingredients.find(i => i.id === chicken.id).stock, chickenPreSync - 200);
  assert.ok(Math.abs(postSync2.dashboard.revenueToday - (revenuePreSync + 16.99)) < 0.001);

  // Menu publishing: first run creates a Clover item for every active dish
  // and stores the mapping; the second run updates instead of creating.
  const pub1 = await req('/api/locations/1/clover/publish-menu', { method: 'POST', token: owner });
  assert.equal(pub1.created, 26);
  assert.equal(pub1.updated, 0);
  assert.equal(pub1.errors.length, 0);
  const menuAfterPub = await req('/api/menu', { token: owner });
  assert.ok(menuAfterPub.menu.every(m => m.cloverItemId), 'every dish has a Clover item id');
  const pub2 = await req('/api/locations/1/clover/publish-menu', { method: 'POST', token: owner });
  assert.equal(pub2.created, 0);
  assert.equal(pub2.updated, 26);
  await req('/api/locations/1/clover/publish-menu', { method: 'POST', token: cook, expected: 403 });
  await req('/api/locations/1/clover/sync', { method: 'POST', token: cook, expected: 403 });

  // --- Ops alerts webhook (/api/ops/alert) + internal sync-error alerts ---
  {
    const opsSecret = ['test', 'ops', 'secret'].join('-');
    const opsPost = (headers, payload) => fetch(`${base}/api/ops/alert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload)
    });
    // No secret -> 401; wrong secret -> 401.
    let r = await opsPost({}, { location_key: 'miami_downtown', kind: 'phone_order_failed', text: 'x', source: 'test' });
    assert.equal(r.status, 401, 'ops alert without secret must be 401');
    r = await opsPost({ 'x-ops-secret': 'wrong' }, { location_key: 'miami_downtown', kind: 'phone_order_failed', text: 'x', source: 'test' });
    assert.equal(r.status, 401, 'ops alert with wrong secret must be 401');
    // Validation: unknown location_key / empty kind -> 400.
    r = await opsPost({ 'x-ops-secret': opsSecret }, { location_key: 'boca', kind: 'k', text: 't', source: 's' });
    assert.equal(r.status, 400, 'bad location_key must be 400');
    r = await opsPost({ 'x-ops-secret': opsSecret }, { location_key: 'network', kind: '', text: 't', source: 's' });
    assert.equal(r.status, 400, 'missing kind must be 400');
    // Valid alerts via x-ops-secret and via Bearer both land as pending.
    r = await opsPost({ 'x-ops-secret': opsSecret }, { location_key: 'miami_downtown', kind: 'phone_order_failed', text: 'PHONE order NOT created in Clover · Edgewater · HTTP 401', source: 'mangal-ops' });
    assert.equal(r.status, 200, 'ops alert with the secret must be 200');
    const alert1 = await r.json();
    assert.equal(alert1.ok, true);
    assert.ok(Number.isInteger(alert1.id) && alert1.id > 0, 'alert id returned');
    r = await opsPost({ authorization: `Bearer ${opsSecret}` }, { location_key: 'network', kind: 'web_order_failed', text: 'WEB order NOT created · HTTP 500', source: 'mangal-web' });
    assert.equal(r.status, 200, 'Bearer secret accepted');

    const { DatabaseSync } = await import('node:sqlite');
    const sqlite = new DatabaseSync(db);
    const rows = sqlite.prepare('SELECT * FROM ops_alerts ORDER BY id').all();
    assert.equal(rows.length, 2, 'both alerts stored');
    assert.equal(rows[0].location_key, 'miami_downtown');
    assert.equal(rows[0].kind, 'phone_order_failed');
    assert.equal(rows[0].source, 'mangal-ops');
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].sent_at, null);
    assert.equal(rows[1].location_key, 'network');
    sqlite.close();

    // Internal sync-error alerts: location 2 with a bad Clover token fails
    // the sync twice — dedupe keeps exactly one sync_error row per hour,
    // with the location, the stage and the HTTP status in the text.
    await req('/api/locations/2/clover', { method: 'POST', token: owner, body: { merchantId: 'GOODMID', token: 'bad-token' } });
    await req('/api/locations/2/clover/sync', { method: 'POST', token: owner, expected: 502 });
    await req('/api/locations/2/clover/sync', { method: 'POST', token: owner, expected: 502 });
    const sqlite2 = new DatabaseSync(db);
    const syncAlerts = sqlite2.prepare("SELECT * FROM ops_alerts WHERE kind = 'sync_error'").all();
    assert.equal(syncAlerts.length, 1, `sync error deduped to one row, got ${syncAlerts.length}`);
    assert.equal(syncAlerts[0].location_key, 'miami_downtown');
    assert.equal(syncAlerts[0].source, 'shawa-ceo-sync');
    assert.equal(syncAlerts[0].status, 'pending');
    assert.ok(syncAlerts[0].text.includes('Miami Downtown'), 'alert text names the location');
    assert.ok(syncAlerts[0].text.includes('HTTP 401'), 'alert text carries the HTTP status');
    sqlite2.close();
    console.log('Ops alerts tests passed.');
  }

  // Stop-list: stopped item cannot be ordered.
  await req(`/api/menu/${classic.id}`, { method: 'PATCH', token: owner, body: { stopped: true } });
  await req('/api/orders', { method: 'POST', token: cook, body: { locationId: 1, kind: 'takeaway', items: [{ menuItemId: classic.id, qty: 1 }] }, expected: 400 });
  await req(`/api/menu/${classic.id}`, { method: 'PATCH', token: owner, body: { stopped: false } });

  // Low-stock alert shows on the dashboard when stock <= min.
  await req('/api/writeoffs', { method: 'POST', token: owner, body: { ingredientId: chicken.id, qty: 4600, reason: 'Тест минимума' } });
  const dashState = await req('/api/state', { token: owner });
  assert.ok(dashState.dashboard.lowStock.some(i => i.id === chicken.id), 'low stock alert includes chicken at min boundary');
  assert.ok(dashState.dashboard.onShift.length === 0);

  // --- 3D location scene: demo roster where no real staff, real people otherwise ---
  // Location 2 (Miami Downtown) has no employees in the app -> demo roster with
  // an honest demo flag; owner sees rates, pay and rating points.
  const scene2 = await req('/api/locations/2/scene', { token: owner });
  assert.equal(scene2.demo, true, 'location without staff falls back to demo roster');
  assert.equal(scene2.staff.length, 9);
  assert.ok(scene2.staff.every(s => s.key.startsWith('demo:2:')), 'demo keys are namespaced');
  assert.equal(scene2.summary.on, 7);
  assert.ok(scene2.summary.payToday > 0, 'owner sees day payroll');
  const demoChef = scene2.staff.find(s => s.key === 'demo:2:1');
  assert.equal(demoChef.role, 'chef');
  assert.equal(demoChef.rate, 32);
  assert.equal(demoChef.rating.points, 40 + 9 * 10 + 3 * 25, 'rating = 40 + 10/clean week + 25/award');
  // A staff actor gets the same scene but NO rate/pay anywhere in the payload.
  const scene2CookRaw = await (await fetch(`${base}/api/locations/2/scene`, { headers: { authorization: `Bearer ${cook}` } })).text();
  assert.ok(!scene2CookRaw.includes('"rate"'), 'staff scene payload must not contain rates');
  assert.ok(!scene2CookRaw.includes('"payToday"'), 'staff scene payload must not contain pay');
  const scene2Cook = JSON.parse(scene2CookRaw);
  assert.equal(scene2Cook.canCall, false);
  await req('/api/locations/2/scene', { expected: 401 });
  await req('/api/locations/999/scene', { token: owner, expected: 404 });

  // Location 1 has the real cook -> no demo mix; hours come from real punches.
  const scene1 = await req('/api/locations/1/scene', { token: owner });
  assert.equal(scene1.demo, false, 'real staff replaces the demo roster entirely');
  assert.equal(scene1.staff.length, 1);
  const cookScene = scene1.staff[0];
  assert.equal(cookScene.key, `emp:${cookId}`);
  assert.equal(cookScene.role, 'grill', 'position Повар maps to the grill role');
  assert.equal(cookScene.status, 'off', 'cook is clocked out at this point');
  assert.equal(cookScene.rate, 18);
  assert.ok(cookScene.hoursWeek >= 1.9, `scene hours from punches: ${cookScene.hoursWeek}`);
  assert.ok(Math.abs(cookScene.payWeek - cookScene.hoursWeek * 18) < 0.01, 'pay = hours x rate');

  // Shift calls: staff cannot call; owner can; duplicates and bad keys fail.
  const marcoKey = 'demo:2:8';
  await req('/api/locations/2/calls', { method: 'POST', token: cook, body: { key: marcoKey }, expected: 403 });
  const called = await req('/api/locations/2/calls', { method: 'POST', token: owner, body: { key: marcoKey } });
  const marco = called.scene.staff.find(s => s.key === marcoKey);
  assert.equal(marco.status, 'called');
  assert.ok(marco.calledAt, 'call carries a timestamp');
  assert.equal(called.scene.summary.called, 1);
  await req('/api/locations/2/calls', { method: 'POST', token: owner, body: { key: marcoKey }, expected: 409 });
  await req('/api/locations/2/calls', { method: 'POST', token: owner, body: { key: 'demo:2:1' }, expected: 409 });
  await req('/api/locations/2/calls', { method: 'POST', token: owner, body: { key: 'demo:2:99' }, expected: 404 });
  const cancelled = await req('/api/locations/2/calls/cancel', { method: 'POST', token: owner, body: { key: marcoKey } });
  assert.equal(cancelled.scene.staff.find(s => s.key === marcoKey).status, 'off');
  await req('/api/locations/2/calls/cancel', { method: 'POST', token: owner, body: { key: marcoKey }, expected: 404 });

  // Calling a real employee works the same; once he clocks in he is "on"
  // and a second call conflicts; after clock-out the call can be cancelled.
  const cookCalled = await req('/api/locations/1/calls', { method: 'POST', token: owner, body: { key: `emp:${cookId}` } });
  assert.equal(cookCalled.scene.staff[0].status, 'called');
  await req('/api/punches/kiosk', { method: 'POST', body: { employeeId: cookId, pin: '4321', action: 'in', locationId: 1 }, expected: 201 });
  const scene1On = await req('/api/locations/1/scene', { token: owner });
  assert.equal(scene1On.staff[0].status, 'on', 'open punch wins over the call mark');
  await req('/api/locations/1/calls', { method: 'POST', token: owner, body: { key: `emp:${cookId}` }, expected: 409 });
  await req('/api/punches/kiosk', { method: 'POST', body: { employeeId: cookId, pin: '4321', action: 'out' } });
  const cookCancelled = await req('/api/locations/1/calls/cancel', { method: 'POST', token: owner, body: { key: `emp:${cookId}` } });
  assert.equal(cookCancelled.scene.staff[0].status, 'off');

  // Checklists screen API: the bot's checklist_runs are manager+ only,
  // parsed defensively, and the weekly summary counts completed vs expected.
  {
    const { DatabaseSync } = await import('node:sqlite');
    const { nyDateKey, weekStartNy, addUtcDays } = await import('../src/time.js');
    const todayKey = nyDateKey(new Date());
    const at = (h, m) => new Date(Date.now() - 7200000 + h * 3600000 + m * 60000).toISOString();
    const sqlite = new DatabaseSync(db);
    const insertRun = sqlite.prepare(`INSERT INTO checklist_runs
      (location, kind, area, day, started_by, started_at, finished_at, status, total_items, done_items, detail_json, shift_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertRun.run('Sunny Isles', 'opening', 'kitchen', todayKey, 'Тест Менеджер', at(8, 1), at(8, 20), 'completed', 3, 3,
      JSON.stringify([
        { item: 'Включить гриль', done: true, by: 'Повар А', at: at(8, 5) },
        { item: 'Проверить вертел', done: true, by: 'Повар А', at: at(8, 10) },
        { item: 'Замариновать курицу', done: true, by: 'Повар Б', at: at(8, 20) }
      ]),
      JSON.stringify([{ shift_id: 1, employee: 'Повар А', starts_at: at(8, 0), ends_at: at(16, 0) }]));
    insertRun.run('Fort Lauderdale', 'closing', 'front', todayKey, 'Тест Кассир', at(22, 40), at(23, 5), 'finished_early', 4, 2,
      JSON.stringify([
        { item: 'Закрыть кассу', done: true, by: 'Кассир В', at: at(22, 45) },
        { item: 'Протереть столы', done: true, by: 'Кассир В', at: at(22, 55) },
        { item: 'Вынести мусор', done: false, by: null, at: null },
        { item: 'Выключить вывеску', done: false, by: null, at: null }
      ]), '[]');
    sqlite.close();

    await req('/api/checklists', { token: cook, expected: 403 });
    await req(`/api/checklists?day=${todayKey}`, { token: cook, expected: 403 });
    await req('/api/checklists?day=26.10.2026', { token: owner, expected: 400 });

    const cl = await req(`/api/checklists?day=${todayKey}`, { token: owner });
    assert.equal(cl.runs.length, 2);
    const sunny = cl.runs.find(r => r.location === 'Sunny Isles');
    assert.equal(sunny.pct, 100);
    assert.equal(sunny.closedBy, 'Повар Б', 'closer = last final mark on a completed run');
    assert.equal(sunny.missed.length, 0);
    assert.equal(sunny.shifts[0].employee, 'Повар А');
    const fl = cl.runs.find(r => r.location === 'Fort Lauderdale');
    assert.equal(fl.pct, 50);
    assert.equal(fl.closedBy, '');
    assert.deepEqual(fl.missed, ['Вынести мусор', 'Выключить вывеску']);

    const onlyFl = await req(`/api/checklists?day=${todayKey}&location=${encodeURIComponent('Fort Lauderdale')}`, { token: owner });
    assert.equal(onlyFl.runs.length, 1);

    const weekDays = Array.from({ length: 7 }, (_, i) => nyDateKey(addUtcDays(weekStartNy(new Date()), i)));
    const elapsed = weekDays.filter(k => k <= todayKey).length;
    const sunnyWeek = cl.week.find(w => w.location === 'Sunny Isles');
    assert.equal(sunnyWeek.completed, 1);
    assert.equal(sunnyWeek.expected, elapsed * 4);
    assert.equal(sunnyWeek.pct, Math.round((1 / (elapsed * 4)) * 100));
    const flWeek = cl.week.find(w => w.location === 'Fort Lauderdale');
    assert.equal(flWeek.finishedEarly, 1);
    assert.equal(flWeek.itemsPct, 50);

    const empty = await req('/api/checklists?day=2020-01-06', { token: owner });
    assert.equal(empty.runs.length, 0);
    assert.ok(empty.week.length >= 4, 'weekly summary lists all locations even with no runs');
    assert.ok(empty.week.every(w => w.pct === 0 && w.expected === 28), 'a fully past week expects 7x4 runs per location');
  }

  // --- Disputes: registry, deadline rules, evidence pack, CSV import ---
  const nyTodayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const dayKey = (offsetDays) => new Date(new Date(`${nyTodayKey}T12:00:00Z`).getTime() + offsetDays * 86400000).toISOString().slice(0, 10);
  await req('/api/disputes', { token: cook, expected: 403 });
  await req('/api/disputes', { method: 'POST', token: cook, body: { channel: 'uber', amount: 5 }, expected: 403 });

  // DoorDash: deadline = order date + 10 days (hard window), adjustment kind.
  const ddCase = await req('/api/disputes', {
    method: 'POST', token: owner, expected: 201,
    body: { channel: 'doordash', locationId: 1, channelOrderId: 'DD-1001', amount: 25.5, orderDate: dayKey(-5), disputeDate: dayKey(-4), reason: 'Missing item' }
  });
  assert.equal(ddCase.dispute.deadlineAt, dayKey(5), `doordash deadline ${ddCase.dispute.deadlineAt}`);
  assert.equal(ddCase.dispute.kind, 'adjustment');
  assert.equal(ddCase.dispute.status, 'new');
  assert.equal(ddCase.dispute.daysLeft, 5);

  // Uber: deadline = order date + 30 days.
  const uberCase = await req('/api/disputes', {
    method: 'POST', token: owner, expected: 201,
    body: { channel: 'uber', locationId: 2, channelOrderId: 'UB-2001', cloverOrderId: 'CLV-ORD-A', amount: 11.99, orderDate: dayKey(0), reason: 'Wrong item' }
  });
  assert.equal(uberCase.dispute.deadlineAt, dayKey(30));
  assert.equal(uberCase.dispute.panelOrderId > 0, true, 'case linked to the synced Clover order');

  // Evidence pack: receipt + timeline from the panel order, payment honestly
  // absent (the Clover sync stores no card data), ready English text.
  const pack = await req(`/api/disputes/${uberCase.dispute.id}/evidence`, { token: owner });
  assert.equal(pack.evidence.order.total, 11.99);
  assert.equal(pack.evidence.checklist.find(c => c.key === 'receipt').present, true);
  assert.equal(pack.evidence.checklist.find(c => c.key === 'payment').present, false);
  assert.ok(pack.evidence.text.includes('CLV-ORD-A'), 'dispute text references the order');
  assert.ok(pack.evidence.text.includes('Uber Eats'), 'dispute text names the channel');
  assert.ok(pack.evidence.portalUrl.includes('ubereats'), 'uber portal link present');

  // Grubhub pack is the 4-field email format.
  const ghCase = await req('/api/disputes', {
    method: 'POST', token: owner, expected: 201,
    body: { channel: 'grubhub', locationId: 3, channelOrderId: 'GH-3001', amount: 8.25, orderDate: dayKey(-2), disputeDate: dayKey(-1), reason: 'Missing item' }
  });
  const ghPack = await req(`/api/disputes/${ghCase.dispute.id}/evidence`, { token: owner });
  assert.ok(ghPack.evidence.text.includes('restaurants@grubhub.com'), 'grubhub email target');
  assert.ok(ghPack.evidence.text.includes('Adjustment date:'), 'grubhub 4-field format');

  // Clover chargeback: the notice deadline is required input.
  await req('/api/disputes', { method: 'POST', token: owner, body: { channel: 'clover', channelOrderId: 'CB-1', amount: 40, orderDate: dayKey(-9) }, expected: 400 });
  const cbCase = await req('/api/disputes', {
    method: 'POST', token: owner, expected: 201,
    body: { channel: 'clover', locationId: 1, channelOrderId: 'CB-1', amount: 40, fee: 15, orderDate: dayKey(-9), disputeDate: dayKey(-1), deadlineAt: dayKey(6), reason: 'Fraud claim' }
  });
  assert.equal(cbCase.dispute.kind, 'chargeback');
  assert.equal(cbCase.dispute.deadlineAt, dayKey(6));
  assert.equal(cbCase.dispute.deadlineSource, 'notice');

  // Status flow: submitted stamps who/when; terminal states lock the status.
  const submitted = await req(`/api/disputes/${ddCase.dispute.id}`, { method: 'PATCH', token: owner, body: { status: 'submitted', evidence: { cctv: true } } });
  assert.equal(submitted.dispute.status, 'submitted');
  assert.ok(submitted.dispute.submittedAt, 'submitted_at stamped');
  assert.equal(submitted.dispute.evidence.cctv, true);
  const won = await req(`/api/disputes/${ddCase.dispute.id}`, { method: 'PATCH', token: owner, body: { status: 'won', outcomeAmount: 25.5 } });
  assert.equal(won.dispute.outcomeAmount, 25.5);
  await req(`/api/disputes/${ddCase.dispute.id}`, { method: 'PATCH', token: owner, body: { status: 'lost' }, expected: 409 });
  await req(`/api/disputes/${ddCase.dispute.id}`, { method: 'PATCH', token: owner, body: { status: 'bogus' }, expected: 400 });

  // CSV import: portal export rows become cases; duplicates are skipped.
  const csv = 'Order ID,Date,Error charge,Reason\nDD-5001,10/20/2026,-13.40,Missing item\nDD-5002,10/21/2026,-7.00,Wrong item\nDD-5001,10/20/2026,-13.40,Missing item\n';
  const imported = await req('/api/disputes/import', { method: 'POST', token: owner, body: { channel: 'doordash', locationId: 1, csv } });
  assert.equal(imported.created, 2, `csv created ${JSON.stringify(imported)}`);
  assert.equal(imported.skipped, 1);
  const importedAgain = await req('/api/disputes/import', { method: 'POST', token: owner, body: { channel: 'doordash', locationId: 1, csv } });
  assert.equal(importedAgain.created, 0);
  assert.equal(importedAgain.skipped, 3);
  await req('/api/disputes/import', { method: 'POST', token: owner, body: { channel: 'clover', csv }, expected: 400 });

  // Registry summary: open cases and won-back money are counted.
  const registry = await req('/api/disputes', { token: owner });
  assert.ok(registry.summary.open >= 4, `open cases ${registry.summary.open}`);
  assert.equal(registry.summary.wonAmount, 25.5);
  const filtered = await req('/api/disputes?channel=doordash', { token: owner });
  assert.ok(filtered.disputes.every(d => d.channel === 'doordash'), 'channel filter');
  console.log('Disputes tests passed.');

  // --- Website master catalog (migration 0006) ---
  {
    // Public catalog needs no auth and starts empty (nothing is flagged).
    const emptyPub = await req('/api/public/catalog');
    assert.equal(emptyPub.version, 1);
    assert.equal(emptyPub.locations.length, 3, 'only active locations are published');
    assert.ok(emptyPub.locations.every(l => l.items.length === 0), 'unpublished items stay out');

    // Fill the master card of the seeded classic as the owner would.
    const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString('base64');
    const patched = await req(`/api/menu/${classic.id}`, { method: 'PATCH', token: owner, body: {
      descriptionEn: 'Test description EN', tags: 'new, spicy, new', calories: 650, proteinG: 32.5,
      catalogPublished: true, cloverBindings: { 1: 'CLV-SUNNY-1', 2: 'CLV-EDGE-1', 3: '' }
    } });
    assert.equal(patched.ok, true);
    await req(`/api/menu/${classic.id}`, { method: 'PATCH', token: owner, body: { photoData: jpegB64 } });

    const pub = await req('/api/public/catalog');
    const sunny = pub.locations.find(l => l.slug === 'sunny-isles');
    const edge = pub.locations.find(l => l.slug === 'edgewater');
    const fl = pub.locations.find(l => l.slug === 'fort-lauderdale');
    assert.equal(sunny.items.length, 1);
    const pubItem = sunny.items[0];
    assert.equal(pubItem.code, 'ch-classic');
    assert.equal(pubItem.description, 'Test description EN');
    assert.deepEqual(pubItem.tags, ['new', 'spicy'], 'tags are deduped');
    assert.equal(pubItem.calories, 650);
    assert.equal(pubItem.proteinG, 32.5);
    assert.equal(pubItem.cloverItemId, 'CLV-SUNNY-1');
    assert.equal(edge.items[0].cloverItemId, 'CLV-EDGE-1');
    assert.equal(fl.items[0].cloverItemId, 'CLV-ITEM-1', 'no per-location binding -> legacy global mapping from the Clover publish test is the fallback');
    assert.ok(!('price' in pubItem) && !('priceCents' in pubItem), 'public catalog carries no prices');
    assert.ok(pubItem.photoUrl.endsWith('/api/public/catalog/photos/ch-classic'), 'uploaded photo is served by the panel');

    // The uploaded photo bytes are publicly readable; unpublished items 404.
    const photoRes = await fetch(`${base}/api/public/catalog/photos/ch-classic`);
    assert.equal(photoRes.status, 200);
    assert.equal(photoRes.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await photoRes.arrayBuffer())], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const noPhoto = await fetch(`${base}/api/public/catalog/photos/plate-mix`);
    assert.equal(noPhoto.status, 404);

    // Publish bumps the version and stamps the time.
    const published = await req('/api/catalog/publish', { method: 'POST', token: owner });
    assert.equal(published.version, 2);
    assert.equal(published.items, 1);
    assert.ok(published.publishedAt);
    const pub2 = await req('/api/public/catalog');
    assert.equal(pub2.version, 2);
    assert.equal(pub2.publishedAt, published.publishedAt);

    // Staff may neither edit the master card nor publish.
    await req(`/api/menu/${classic.id}`, { method: 'PATCH', token: cook, body: { descriptionEn: 'nope' }, expected: 403 });
    await req('/api/catalog/publish', { method: 'POST', token: cook, expected: 403 });

    // State exposes catalog fields + bindings to the panel UI.
    const st = await req('/api/state', { token: owner });
    const classicView = st.menu.find(m => m.id === classic.id);
    assert.equal(classicView.catalogPublished, true);
    assert.equal(classicView.hasUploadedPhoto, true);
    assert.deepEqual(classicView.cloverBindings, [
      { locationId: 1, cloverItemId: 'CLV-SUNNY-1' },
      { locationId: 2, cloverItemId: 'CLV-EDGE-1' }
    ]);
    assert.equal(st.catalog.version, 2);
    console.log('Website catalog tests passed.');
  }

  // --- Finance: PnL, DR-15, expenses, suppliers (migration 0007) ---
  {
    const nyKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const todayKey = nyKey();
    const monthKey = todayKey.slice(0, 7);

    // Finance endpoints are manager+ only.
    await req('/api/finance/pnl', { token: cook, expected: 403 });
    await req('/api/finance/dr15', { token: cook, expected: 403 });
    await req('/api/suppliers', { token: cook, expected: 403 });
    await req('/api/expenses', { token: cook, expected: 403 });

    // PnL for location 1 today: the app order ($23.98, no tax figure) plus
    // Clover A ($11.99, tax $0.84) and B ($5.00, tax $0.35, unmapped line).
    const pnlRes = await req(`/api/finance/pnl?from=${todayKey}&to=${todayKey}`, { token: owner });
    const loc1 = pnlRes.pnl.locations.find(l => l.locationId === 1);
    assert.ok(loc1, 'pnl has location 1');
    assert.equal(loc1.orders, 3);
    assert.equal(loc1.gross, 40.97);
    assert.equal(loc1.taxCollected, 1.19, 'tax captured from Clover payments');
    assert.equal(loc1.taxCoveragePct, 66.7, 'app order carries no tax figure');
    assert.equal(loc1.netRevenue, 39.78);
    // Food cost uses CURRENT purchase prices; the confirmed Sysco email
    // draft repriced chicken, so pin the coverage and the EBITDA formula
    // instead of an absolute food-cost figure.
    assert.ok(loc1.foodCost > 0, 'food cost is priced from purchases');
    assert.equal(loc1.coverage.mappedPct, 87.8, `mapped coverage ${JSON.stringify(loc1.coverage)}`);
    assert.equal(loc1.coverage.pricedPct, 87.8, 'classic recipe is fully priced');
    // Labor at location 1: the cook's 2 rated hours at $18/h -> $36
    // (kiosk punches are seconds long), rate coverage 100%.
    assert.ok(Math.abs(loc1.laborCost - 36) < 0.6, `loc1 labor ${loc1.laborCost}`);
    assert.equal(loc1.laborCoveragePct, 100);
    assert.ok(Math.abs(loc1.ebitda - (loc1.netRevenue - loc1.foodCost - loc1.laborCost - loc1.opex)) < 0.011, `ebitda formula ${loc1.ebitda}`);
    // A non-owner manager gets hours but never labor money or EBITDA.
    const mgrInvite = await req('/api/invites', { method: 'POST', token: owner, body: { position: 'Управляющий', locationId: 1, contact: 'manager@test.local' } });
    await req('/api/auth/register', { method: 'POST', body: { firstName: 'Тест', lastName: 'Менеджер', contact: 'manager@test.local', password: 'managerpass', inviteCode: mgrInvite.invite.code }, expected: 201 });
    const mgrLogin = await req('/api/auth/login', { method: 'POST', body: { contact: 'manager@test.local', password: 'managerpass' } });
    const manager = mgrLogin.token;
    const mgrPnl = await req(`/api/finance/pnl?from=${todayKey}&to=${todayKey}`, { token: manager });
    assert.equal(mgrPnl.pnl.ownerView, false);
    assert.ok(!('laborCost' in mgrPnl.pnl.total), 'labor money hidden from non-owner');
    assert.ok(!('ebitda' in mgrPnl.pnl.total), 'ebitda hidden from non-owner');

    // Operating expense -> into PnL opex and EBITDA; delete removes it.
    const exp = await req('/api/expenses', { method: 'POST', token: owner, body: { locationId: 1, category: 'rent', amount: 1500, date: todayKey, note: 'Тест аренды' }, expected: 201 });
    const expList = await req(`/api/expenses?from=${todayKey}&to=${todayKey}`, { token: owner });
    assert.ok(expList.expenses.some(x => x.id === exp.id && x.amount === 1500 && x.category === 'rent'), 'expense listed');
    const pnlExp = await req(`/api/finance/pnl?from=${todayKey}&to=${todayKey}`, { token: owner });
    const loc1Exp = pnlExp.pnl.locations.find(l => l.locationId === 1);
    assert.equal(loc1Exp.opex, 1500);
    assert.equal(loc1Exp.opexByCategory.rent, 1500);
    assert.ok(Math.abs((loc1.ebitda - loc1Exp.ebitda) - 1500) < 0.011, `rent flows into ebitda: ${loc1.ebitda} -> ${loc1Exp.ebitda}`);
    await req(`/api/expenses/${exp.id}`, { method: 'DELETE', token: owner });
    await req('/api/expenses', { method: 'POST', token: owner, body: { category: 'bogus', amount: 10 }, expected: 400 });
    await req('/api/expenses', { method: 'POST', token: cook, body: { category: 'rent', amount: 10 }, expected: 403 });

    // DR-15 for the current month, location 1: A/C/D lines + allowance.
    const dr = await req(`/api/finance/dr15?month=${monthKey}`, { token: owner });
    const drLoc1 = dr.dr15.locations.find(l => l.locationId === 1);
    assert.equal(drLoc1.grossSales, 40.97);
    assert.equal(drLoc1.taxCollected, 1.19);
    assert.equal(drLoc1.taxableSales, 39.78);
    assert.equal(drLoc1.taxCoveragePct, 66.7);
    assert.equal(drLoc1.allowance, 0.03, '2.5% of the tax, capped by the first $1,200');
    const [yy, mm] = monthKey.split('-').map(Number);
    const expectedDue = mm === 12 ? `${yy + 1}-01-20` : `${yy}-${String(mm + 1).padStart(2, '0')}-20`;
    assert.equal(dr.dr15.dueDate, expectedDue, 'DR-15 is due on the 20th of the next month');

    // Suppliers: the $38 document from the purchase-documents test was
    // entered before any supplier card existed; creating the card adopts it.
    const sup = await req('/api/suppliers', { method: 'POST', token: owner, body: { name: 'Тест Поставщик', contactName: 'Иван', phone: '+1 555 0100' }, expected: 201 });
    assert.equal(sup.supplier.docsCount, 1, 'pre-existing document adopted by name');
    assert.equal(sup.supplier.invoiced, 38);
    assert.equal(sup.supplier.paid, 0);
    assert.equal(sup.supplier.balance, 38);
    assert.equal(sup.supplier.oldestOpenDate, '2026-10-22');
    await req('/api/suppliers', { method: 'POST', token: owner, body: { name: 'тест поставщик' }, expected: 409 });
    // A payment mark lowers the balance; the detail shows docs + payments.
    const pay = await req(`/api/suppliers/${sup.supplier.id}/payments`, { method: 'POST', token: owner, body: { amount: 20, date: todayKey, method: 'ACH' }, expected: 201 });
    assert.equal(pay.supplier.balance, 18);
    const detail = await req(`/api/suppliers/${sup.supplier.id}`, { token: owner });
    assert.equal(detail.documents.length, 1);
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.payments[0].method, 'ACH');
    // A new purchase document linked by supplierId joins the same balance.
    const linkedDoc = await req('/api/purchase-documents', {
      method: 'POST', token: owner, expected: 201,
      body: { supplierId: sup.supplier.id, docDate: todayKey, lines: [{ ingredientId: chicken.id, qty: 100, totalCost: 10 }] }
    });
    const detail2 = await req(`/api/suppliers/${sup.supplier.id}`, { token: owner });
    assert.equal(detail2.documents.length, 2);
    assert.equal(detail2.supplier.balance, 28);
    const histDoc = (await req('/api/purchase-documents', { token: owner })).documents.find(d => d.id === linkedDoc.id);
    assert.equal(histDoc.supplierId, sup.supplier.id, 'document carries the supplier link');
    assert.equal(histDoc.supplier, 'Тест Поставщик', 'document keeps the name snapshot');
    // Removing the payment mark restores the balance.
    await req(`/api/suppliers/${sup.supplier.id}/payments/${pay.id}`, { method: 'DELETE', token: owner });
    const detail3 = await req(`/api/suppliers/${sup.supplier.id}`, { token: owner });
    assert.equal(detail3.supplier.balance, 48);
    console.log('Finance tests passed.');
  }

  // --- Temperature control (migration 0010) ---
  {
    const { DatabaseSync } = await import('node:sqlite');
    const { nyDateKey: tempNyKey } = await import('../src/time.js');
    const todayNy = tempNyKey(new Date());
    const countAlerts = (kind) => {
      const s = new DatabaseSync(db);
      const row = s.prepare('SELECT COUNT(*) AS n FROM ops_alerts WHERE kind = ?').get(kind);
      s.close();
      return Number(row.n);
    };
    // A dedicated manager (manager+ creates equipment).
    const tempMgrInvite = await req('/api/invites', { method: 'POST', token: owner, body: { position: 'Управляющий', locationId: 1, contact: 'tempsmanager@test.local' } });
    await req('/api/auth/register', { method: 'POST', body: { firstName: 'Тест', lastName: 'ТемпМенеджер', contact: 'tempsmanager@test.local', password: 'tempsmanagerpass', inviteCode: tempMgrInvite.invite.code }, expected: 201 });
    const tempMgrLogin = await req('/api/auth/login', { method: 'POST', body: { contact: 'tempsmanager@test.local', password: 'tempsmanagerpass' } });
    const tempMgr = tempMgrLogin.token;

    // Manager creates equipment.
    const walkinRes = await req('/api/temperatures/equipment', { method: 'POST', token: tempMgr, expected: 201, body: { location_id: 1, name: 'Test Walk-in', type: 'walkin', norm_min_f: 33, norm_max_f: 41 } });
    const walkinId = walkinRes.equipment.id;
    assert.ok(walkinId > 0, 'walkin equipment created');
    assert.equal(walkinRes.equipment.type, 'walkin');
    const freezerRes = await req('/api/temperatures/equipment', { method: 'POST', token: tempMgr, expected: 201, body: { location_id: 1, name: 'Test Freezer', type: 'freezer', norm_min_f: null, norm_max_f: 0 } });
    const freezerId = freezerRes.equipment.id;
    assert.ok(freezerId > 0, 'freezer equipment created');
    // Invalid type is rejected.
    await req('/api/temperatures/equipment', { method: 'POST', token: tempMgr, body: { location_id: 1, name: 'Oven', type: 'oven' }, expected: 400 });

    // Staff gets 403 on creating equipment, but can read temperatures.
    await req('/api/temperatures/equipment', { method: 'POST', token: cook, body: { location_id: 1, name: 'Staff Fridge', type: 'fridge', norm_min_f: 33, norm_max_f: 41 }, expected: 403 });
    const tempsEmpty = await req('/api/temperatures', { token: cook });
    const sunnyGroup = tempsEmpty.locations.find(g => (g.location?.id || g.location_id) === 1);
    assert.ok(sunnyGroup, 'temperatures grouped by location');
    const walkinEmpty = sunnyGroup.equipment.find(e => e.id === walkinId);
    assert.equal(walkinEmpty.status, 'none', 'no readings yet -> status none');
    assert.equal(walkinEmpty.lastReading, null);

    const devBefore = countAlerts('temp_deviation');
    const critBefore = countAlerts('temp_critical');

    // Staff posts a reading in the norm: no alert.
    const inNorm = await req('/api/temperatures/readings', { method: 'POST', token: cook, expected: 201, body: { equipment_id: walkinId, value_f: 38, humidity_pct: 55 } });
    assert.equal(inNorm.ok, true);
    assert.equal(inNorm.status, 'ok');
    assert.equal(inNorm.deviation, false);
    assert.equal(inNorm.critical, false);
    assert.equal(countAlerts('temp_deviation'), devBefore, 'in-norm reading creates no deviation alert');
    assert.equal(countAlerts('temp_critical'), critBefore, 'in-norm reading creates no critical alert');
    const tempsOk = await req('/api/temperatures', { token: cook });
    const walkinOk = tempsOk.locations.find(g => (g.location?.id || g.location_id) === 1).equipment.find(e => e.id === walkinId);
    assert.equal(walkinOk.status, 'ok');
    assert.equal(walkinOk.lastReading.value_f, 38);
    assert.equal(walkinOk.lastReading.humidity_pct, 55);
    assert.equal(walkinOk.lastReading.source, 'panel');
    assert.ok(walkinOk.lastReading.entered_by.includes('Повар'), `entered_by is actor name: ${walkinOk.lastReading.entered_by}`);
    assert.ok(walkinOk.lastReading.created_at, 'last reading carries created_at');

    // Out-of-range value is rejected.
    await req('/api/temperatures/readings', { method: 'POST', token: cook, body: { equipment_id: walkinId, value_f: 999 }, expected: 400 });

    // Deviation (43F, norm 33-41, walkin critical threshold is >45): exactly one temp_deviation alert.
    const deviationRes = await req('/api/temperatures/readings', { method: 'POST', token: cook, expected: 201, body: { equipment_id: walkinId, value_f: 43 } });
    assert.equal(deviationRes.deviation, true);
    assert.equal(deviationRes.critical, false);
    assert.equal(deviationRes.status, 'deviation');
    assert.equal(countAlerts('temp_deviation'), devBefore + 1, 'exactly one temp_deviation alert');
    assert.equal(countAlerts('temp_critical'), critBefore, 'non-critical deviation creates no critical alert');
    {
      const s = new DatabaseSync(db);
      const row = s.prepare("SELECT * FROM ops_alerts WHERE kind = 'temp_deviation' ORDER BY id DESC LIMIT 1").get();
      s.close();
      assert.equal(row.location_key, 'sunny_isles');
      assert.equal(row.source, 'shawa-ceo-temp');
      assert.equal(row.status, 'pending');
      assert.ok(row.text.includes('Sunny Isles'), `alert text location: ${row.text}`);
      assert.ok(row.text.includes('Test Walk-in'), `alert text equipment: ${row.text}`);
      assert.ok(row.text.includes('43°F'), `alert text value: ${row.text}`);
      assert.ok(row.text.includes('33–41°F'), `alert text norm: ${row.text}`);
    }

    // Critical freezer reading (15F at norm <=0, freezer critical >10): exactly one temp_critical alert.
    const criticalRes = await req('/api/temperatures/readings', { method: 'POST', token: cook, expected: 201, body: { equipment_id: freezerId, value_f: 15 } });
    assert.equal(criticalRes.deviation, true);
    assert.equal(criticalRes.critical, true);
    assert.equal(countAlerts('temp_critical'), critBefore + 1, 'exactly one temp_critical alert');
    assert.equal(countAlerts('temp_deviation'), devBefore + 1, 'critical reading does not also create a deviation alert');
    {
      const s = new DatabaseSync(db);
      const row = s.prepare("SELECT * FROM ops_alerts WHERE kind = 'temp_critical' ORDER BY id DESC LIMIT 1").get();
      s.close();
      assert.equal(row.location_key, 'sunny_isles');
      assert.equal(row.source, 'shawa-ceo-temp');
      assert.ok(row.text.includes('Test Freezer'), `critical text equipment: ${row.text}`);
      assert.ok(row.text.includes('15°F'), `critical text value: ${row.text}`);
      assert.ok(row.text.includes('≤0°F'), `critical text norm with NULL min: ${row.text}`);
    }

    // History answers: equipment + readings descending.
    const history = await req(`/api/temperatures/history?equipment_id=${walkinId}&days=7`, { token: cook });
    assert.equal(history.equipment.id, walkinId);
    assert.ok(history.readings.length >= 2, `history readings ${history.readings.length}`);
    assert.equal(history.readings[0].value_f, 43, 'history is descending, latest first');
    assert.equal(history.readings[1].value_f, 38);

    // Journal answers: all readings of the location for the NY day + equipment list.
    const journal = await req(`/api/temperatures/journal?location_id=1&day=${todayNy}`, { token: cook });
    assert.equal(journal.day, todayNy);
    assert.ok(journal.equipment.some(e => e.id === walkinId), 'journal lists location equipment');
    assert.ok(journal.equipment.some(e => e.id === freezerId), 'journal lists freezer');
    assert.ok(journal.readings.some(r => r.equipment_id === walkinId && r.value_f === 43), 'journal has the deviation reading');
    assert.ok(journal.readings.some(r => r.equipment_id === freezerId && r.value_f === 15), 'journal has the freezer reading');

    // Deactivated equipment rejects readings.
    const deactivated = await req(`/api/temperatures/equipment/${freezerId}/active`, { method: 'POST', token: tempMgr, body: { active: false } });
    assert.equal(deactivated.equipment.active, false);
    await req('/api/temperatures/readings', { method: 'POST', token: cook, body: { equipment_id: freezerId, value_f: -5 }, expected: 400 });
    // Staff cannot toggle equipment either.
    await req(`/api/temperatures/equipment/${freezerId}/active`, { method: 'POST', token: cook, body: { active: true }, expected: 403 });

    console.log('Temperature control tests passed.');
  }

  console.log('All SHAWA CEO core-flow tests passed.');
} finally {
  server.kill('SIGTERM');
  cloverMock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
