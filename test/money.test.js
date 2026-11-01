'use strict';
// ทดสอบเรื่องเงินชุดที่ 2: งานเบื้องหลังไม่ค้าง, webhook ไม่ย้อนสถานะ, เติมเงินกระเป๋า, แอดมินแก้รายการ, API หลาย key ฯลฯ
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { setupEnv, Client, waitFor, ADMIN_PASSWORD, CUSTOMER_PASSWORD } = require('./helpers');

// รหัสสลิปที่แอดมินเห็น (ต้องส่งตอนอนุมัติ — กันลูกค้าเปลี่ยนสลิประหว่างแอดมินตรวจ)
const slipVer = async (admin, id) => (await admin.get(`/api/admin/deposits?q=${id}`)).body.data.rows.find((d) => d.id === id)?.slip_ver;

setupEnv();
const { start } = require('../src/server');
const db = require('../src/db');
const orders = require('../src/services/orders');
const wallet = require('../src/services/wallet');
const webhooks = require('../src/services/webhooks');
const worker = require('../src/services/worker');
const { parseBaht } = require('../src/lib/money');

let app;
let base;
let admin;
const PNG_BASE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let pngSeq = 0;
const freshPng = () => `data:image/png;base64,${Buffer.concat([PNG_BASE, Buffer.from(String(pngSeq++))]).toString('base64')}`;

const balanceOf = (userId) => db.get('SELECT balance FROM users WHERE id = ?', userId).balance;
const orderRow = (ref) => db.get('SELECT * FROM orders WHERE ref = ?', ref);
const key = () => crypto.randomUUID();
const randomPhone = () => `09${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
let seq = 5000;
const freshPhone = (suffix) => `08${String(10000 + seq++).slice(-4)}${suffix}`;

async function newCustomer(credit = 0) {
  const c = new Client(base);
  const r = await c.post('/api/auth/register', { name: 'ลูกค้าทดสอบ', phone: randomPhone(), password: CUSTOMER_PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.user = r.body.data.user;
  if (credit) {
    const a = await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: String(credit), note: 'เครดิตทดสอบ' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
  }
  return c;
}

const topup = (c, phone, amount, extra = {}) => c.post('/api/orders', { type: 'topup', network: 'AIS', phone, amount, idempotencyKey: key(), ...extra });

before(async () => {
  app = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
  admin = new Client(base);
  const r = await admin.post('/api/auth/login', { identifier: 'admin@test.local', password: ADMIN_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await admin.put('/api/admin/settings', {
    mock_success_rate: 100, mock_async_rate: 0, mock_callback_delay_sec: 0, mock_timeout_rate: 0,
    daily_limit_baht: 0, order_rate_per_min: 600, promptpay_id: '0812345678',
  });
});

after(async () => {
  await app.close();
});

test('งานเบื้องหลัง: งานที่ error ครั้งหนึ่งต้องรันได้อีก และปุ่ม "รันตอนนี้" ต้องไม่ค้าง', async () => {
  const original = orders.recoverPending;
  orders.recoverPending = () => { throw new Error('boom'); };
  try {
    await assert.rejects(worker.runOnce(), /boom/);
  } finally {
    orders.recoverPending = original;
  }
  const result = await Promise.race([worker.runOnce().then(() => 'ok'), new Promise((r) => { setTimeout(() => r('hang'), 5000).unref(); })]);
  assert.equal(result, 'ok');
});

test('webhook ที่ส่งซ้ำรอบเก่าต้องไม่พาสถานะเก่ากลับมาทับของใหม่ (มี version ให้ร้านค้าเทียบ)', async () => {
  const received = [];
  let calls = 0;
  const hook = http.createServer((req, res) => {
    let data = '';
    req.on('data', (ch) => { data += ch; });
    req.on('end', () => {
      calls++;
      if (calls === 1) { res.statusCode = 500; res.end('down'); return; }
      received.push(JSON.parse(data));
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  try {
    const m = await newCustomer(500);
    const k = await admin.post('/api/admin/api-keys', { user_id: m.user.id, name: 'ร้านทดสอบ', webhook_url: `http://127.0.0.1:${hook.address().port}/hook` });
    assert.equal(k.status, 201, JSON.stringify(k.body));
    const created = await fetch(`${base}/api/v1/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k.body.data.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'topup', network: 'AIS', phone: freshPhone('8001'), amount: 50, reference: 'WH-ORDER-0001' }),
    }).then((r) => r.json());
    const ref = created.data.order.ref;
    await app.queue.idle();
    await waitFor(() => calls >= 1);
    const first = db.get('SELECT * FROM webhook_deliveries WHERE order_id = ? ORDER BY id LIMIT 1', orderRow(ref).id);
    await waitFor(() => db.get('SELECT status, attempts FROM webhook_deliveries WHERE id = ?', first.id).attempts === 1);

    const refund = await admin.post(`/api/admin/orders/${ref}/mark-failed`, { note: 'ลูกค้าขอคืน', expected_status: 'success' });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    await waitFor(() => received.length >= 1);
    assert.equal(received[0].data.status, 'refunded');

    assert.equal(webhooks.retryNow(first.id), true);
    await waitFor(() => received.length >= 2);
    assert.equal(received[1].data.status, 'refunded', 'การส่งซ้ำรอบเก่าต้องส่งสถานะปัจจุบัน');
    assert.ok(received[1].data.version >= received[0].data.version);
    assert.ok(received[1].data.updated_at);
  } finally {
    hook.close();
  }
});

test('API ร้านค้า: รหัสอ้างอิงแยกตาม API key — 2 เว็บของเจ้าของเดียวกันใช้เลขซ้ำกันได้', async () => {
  const m = await newCustomer(500);
  const ka = (await admin.post('/api/admin/api-keys', { user_id: m.user.id, name: 'เว็บ A' })).body.data.api_key;
  const kb = (await admin.post('/api/admin/api-keys', { user_id: m.user.id, name: 'เว็บ B' })).body.data.api_key;
  const call = (k, method, url, body) => fetch(base + url, {
    method, headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const pa = freshPhone('8101');
  const pb = freshPhone('8102');
  const a = await call(ka, 'POST', '/api/v1/orders', { type: 'topup', network: 'AIS', phone: pa, amount: 20, reference: 'INV-0001' });
  const b = await call(kb, 'POST', '/api/v1/orders', { type: 'topup', network: 'AIS', phone: pb, amount: 20, reference: 'INV-0001' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.notEqual(a.body.data.order.ref, b.body.data.order.ref);
  assert.equal((await call(ka, 'GET', '/api/v1/orders?reference=INV-0001')).body.data.order.phone, pa);
  assert.equal((await call(kb, 'GET', '/api/v1/orders?reference=INV-0001')).body.data.order.phone, pb);
});

test('เติมเงินกระเป๋า: กรอกเศษสตางค์เองไม่ได้, แนบสลิปแล้วยกเลิกเองไม่ได้, ไม่มีสลิป/ยอดเกินต้องยืนยัน', async () => {
  const c = await newCustomer();
  assert.equal((await c.post('/api/deposits', { amount: '100.18', method: 'promptpay' })).status, 400);

  const d1 = (await c.post('/api/deposits', { amount: 100, method: 'promptpay' })).body.data.deposit;
  assert.equal((await c.post(`/api/deposits/${d1.id}/slip`, { image: freshPng() })).status, 200);
  assert.equal((await c.post(`/api/deposits/${d1.id}/cancel`, {})).status, 400, 'แนบสลิปแล้วห้ามยกเลิกเอง');

  const d2 = (await c.post('/api/deposits', { amount: 200, method: 'promptpay' })).body.data.deposit;
  const noSlip = await admin.post(`/api/admin/deposits/${d2.id}/approve`, {});
  assert.equal(noSlip.status, 409);
  assert.equal(noSlip.body.error.code, 'NO_SLIP');
  assert.equal((await admin.post(`/api/admin/deposits/${d2.id}/approve`, { no_slip: true })).status, 400, 'ต้องมีหมายเหตุ');
  assert.equal((await admin.post(`/api/admin/deposits/${d2.id}/approve`, { no_slip: true, note: 'เงินเข้า 10:42 ตรวจในแอปธนาคารแล้ว' })).status, 200);

  const v1 = await slipVer(admin, d1.id);
  const over = await admin.post(`/api/admin/deposits/${d1.id}/approve`, { amount: '150', note: 'ลูกค้าโอนเกิน', slip_ver: v1 });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'AMOUNT_OVER_REQUESTED');
  const ok = await admin.post(`/api/admin/deposits/${d1.id}/approve`, { amount: '150', note: 'ลูกค้าโอนเกิน', confirm_over: true, slip_ver: v1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(balanceOf(c.user.id), d2.amount + 15000);
  assert.deepEqual(wallet.reconcile(), []);
});

test('เติมเงินกระเป๋า: ยอดเดียวกับรายการอื่นที่รอตรวจ/เพิ่งอนุมัติ → แอดมินเห็นคำเตือน', async () => {
  await admin.put('/api/admin/settings', { deposit_unique_satang: false });
  try {
    const a = await newCustomer();
    const b = await newCustomer();
    const da = (await a.post('/api/deposits', { amount: 333, method: 'promptpay' })).body.data.deposit;
    const dbb = (await b.post('/api/deposits', { amount: 333, method: 'promptpay' })).body.data.deposit;
    await a.post(`/api/deposits/${da.id}/slip`, { image: freshPng() });
    await b.post(`/api/deposits/${dbb.id}/slip`, { image: freshPng() });
    const rows = (await admin.get('/api/admin/deposits?status=waiting')).body.data.rows;
    assert.equal(rows.find((x) => x.id === da.id).amount_dup_of, dbb.id);
    assert.equal(rows.find((x) => x.id === dbb.id).amount_dup_of, da.id);
  } finally {
    await admin.put('/api/admin/settings', { deposit_unique_satang: true });
  }
});

test('แอดมินปรับยอด: กดซ้ำด้วยรหัสคำขอเดิม = ปรับครั้งเดียว', async () => {
  const c = await newCustomer();
  const rid = key();
  const r1 = await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: '500', note: 'โบนัส', request_id: rid });
  const r2 = await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: '500', note: 'โบนัส', request_id: rid });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.data.existing, true);
  assert.equal(balanceOf(c.user.id), 50000);
  const r3 = await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: '600', note: 'โบนัส', request_id: rid });
  assert.equal(r3.status, 409);
  assert.equal(balanceOf(c.user.id), 50000);
});

test('แอดมินแก้ผลรายการกลับไปกลับมาได้ โดยเงินถูกต้องทุกขั้น (คืนเงิน ↔ ดึงคืน)', async () => {
  const c = await newCustomer(100);
  const r = await topup(c, freshPhone('0000'), 20); // ผู้ให้บริการปฏิเสธ → คืนเงินอัตโนมัติ
  await app.queue.idle();
  const ref = r.body.data.order.ref;
  assert.equal(orderRow(ref).status, 'failed');
  assert.equal(balanceOf(c.user.id), 10000);
  assert.equal((await admin.post(`/api/admin/orders/${ref}/mark-success`, { note: 'ผู้ให้บริการแจ้งว่าเติมเข้าแล้ว' })).status, 200);
  assert.equal(balanceOf(c.user.id), 8000);
  assert.equal((await admin.post(`/api/admin/orders/${ref}/mark-failed`, { note: 'ตรวจใหม่แล้วไม่เข้า' })).status, 200);
  assert.equal(orderRow(ref).status, 'refunded');
  assert.equal(balanceOf(c.user.id), 10000);
  assert.equal((await admin.post(`/api/admin/orders/${ref}/mark-success`, { note: 'สรุปสุดท้ายว่าเข้า' })).status, 200);
  assert.equal(balanceOf(c.user.id), 8000);
  assert.deepEqual(wallet.reconcile(), []);
  assert.equal(wallet.reconcileOrders().some((x) => x.ref === ref), false);
});

test('ยืนยันสำเร็จแต่ลูกค้าใช้เงินที่คืนไปแล้ว → บันทึก "สำเร็จโดยไม่ดึงเงินคืน" ได้ และขึ้นในรายการตรวจบัญชี', async () => {
  const c = await newCustomer(20);
  const r = await topup(c, freshPhone('0000'), 20);
  await app.queue.idle();
  const ref = r.body.data.order.ref;
  assert.equal(balanceOf(c.user.id), 2000);
  await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: '-20', note: 'ลูกค้าใช้เงินไปแล้ว' });
  const short = await admin.post(`/api/admin/orders/${ref}/mark-success`, { note: 'เติมเข้าแล้ว' });
  assert.equal(short.status, 409);
  assert.equal(short.body.error.details.canSkipReversal, true);
  assert.equal((await admin.post(`/api/admin/orders/${ref}/mark-success`, { skip_reversal: true })).status, 400, 'ต้องมีเหตุผล');
  const ok = await admin.post(`/api/admin/orders/${ref}/mark-success`, { skip_reversal: true, note: 'จะเก็บเงินลูกค้าภายหลัง' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(orderRow(ref).status, 'success');
  assert.equal(balanceOf(c.user.id), 0);
  const recon = await admin.get('/api/admin/reconcile');
  assert.ok(recon.body.data.orders.some((x) => x.ref === ref), 'ต้องเตือนว่ารายการนี้ยังไม่ได้เก็บเงิน');
  assert.deepEqual(recon.body.data.mismatches, []);
  // เปลี่ยนใจเป็น "ไม่สำเร็จ" → ไม่คืนเงินซ้ำ (ลูกค้าไม่ได้ถูกเก็บเงินอยู่แล้ว) และหน้าจอรู้ว่าไม่ได้คืน
  const back = await admin.post(`/api/admin/orders/${ref}/mark-failed`, { note: 'สรุปว่าไม่เข้า' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.data.refunded, 0);
  assert.equal(balanceOf(c.user.id), 0);
  assert.equal((await admin.get('/api/admin/reconcile')).body.data.orders.some((x) => x.ref === ref), false);
});

test('callback ไม่มีลายเซ็น + ผู้ให้บริการเช็กสถานะไม่ได้ → ไม่ขยับเงิน ส่งให้แอดมินตรวจ', async () => {
  const mock = require('../src/providers/mock');
  const c = await newCustomer(100);
  const r = await topup(c, freshPhone('2222'), 20); // ค้างสถานะ
  await app.queue.idle();
  const ref = r.body.data.order.ref;
  mock.capabilities.statusCheck = false;
  try {
    const res = orders.applyCallback('mock', { ref, outcome: 'failed', trust: 'token' });
    assert.equal(res.review, true);
  } finally {
    mock.capabilities.statusCheck = true;
  }
  const o = orderRow(ref);
  assert.equal(o.status, 'processing');
  assert.equal(o.needs_review, 1);
  assert.equal(balanceOf(c.user.id), 8000);
});

test('เติมหลายรายการ: นับรวมกับการจำกัดความถี่ และแจ้ง "ทุก" รายการที่อาจซ้ำพร้อมกัน', async () => {
  const c = await newCustomer(1000);
  const p1 = freshPhone('8201');
  const p2 = freshPhone('8202');
  assert.equal((await topup(c, p1, 50)).status, 201);
  const items = [
    { type: 'topup', network: 'AIS', phone: p1, amount: 50 }, // ซ้ำกับรายการเมื่อครู่
    { type: 'topup', network: 'AIS', phone: p2, amount: 30 },
    { type: 'topup', network: 'AIS', phone: p2, amount: 30 }, // ซ้ำกันเองในชุด
  ];
  const dup = await c.post('/api/orders/bulk', { items, batchKey: key() });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body.error.details.duplicates.map((d) => d.index).sort(), [0, 2]);
  // ยืนยันแค่บรรทัดที่เห็น (บรรทัด 3) → บรรทัด 1 ที่ซ้ำกับรายการเมื่อครู่ต้องถูกแจ้งกลับมา ไม่ผ่านไปเงียบๆ
  const partial = await c.post('/api/orders/bulk', { items, batchKey: key(), confirmDuplicateIndexes: [2] });
  assert.equal(partial.status, 409);
  assert.deepEqual(partial.body.error.details.duplicates.map((d) => d.index), [0]);
  assert.equal((await c.post('/api/orders/bulk', { items, batchKey: key(), confirmDuplicate: true })).status, 409, 'ยืนยันแบบเหมาทั้งชุดไม่ได้แล้ว');
  const ok = await c.post('/api/orders/bulk', { items, batchKey: key(), confirmDuplicateIndexes: [0, 2] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  await app.queue.idle();

  await admin.put('/api/admin/settings', { order_rate_per_min: 2, max_bulk_items: 3 });
  try {
    const d = await newCustomer(1000);
    const three = [1, 2, 3].map((i) => ({ type: 'topup', network: 'AIS', phone: freshPhone(`83${i}0`), amount: 20 }));
    assert.equal((await d.post('/api/orders/bulk', { items: three, batchKey: key() })).status, 201);
    const more = await d.post('/api/orders/bulk', { items: [{ type: 'topup', network: 'AIS', phone: freshPhone('8399'), amount: 20 }], batchKey: key() });
    assert.equal(more.status, 429, 'ส่งชุดใหม่รัวๆ เพื่อเลี่ยงการจำกัดความถี่ไม่ได้');
  } finally {
    await admin.put('/api/admin/settings', { order_rate_per_min: 600, max_bulk_items: 30 });
  }
});

test('ข้อมูลผิดชนิด (array / true / ตัวคั่นหลักพันผิดตำแหน่ง) ถูกปฏิเสธ ไม่กลายเป็นยอดอื่น', async () => {
  assert.equal(parseBaht('1,000'), 100000);
  assert.equal(parseBaht('12,345.50'), 1234550);
  for (const bad of ['10,0', '1,00', [100], true, { a: 1 }, '1e3', '-5']) assert.throws(() => parseBaht(bad), undefined, JSON.stringify(bad));
  const c = await newCustomer(100);
  assert.equal((await c.post('/api/orders', { type: 'topup', network: ['AIS'], phone: freshPhone('8401'), amount: 20, idempotencyKey: key() })).status, 400);
  assert.equal((await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: freshPhone('8402'), amount: [20], idempotencyKey: key() })).status, 400);
  assert.equal((await c.post('/api/orders', { type: 'package', productId: true, phone: freshPhone('8403'), idempotencyKey: key() })).status, 400, 'ห้ามซื้อแพ็กเกจ #1 จาก productId: true');
  assert.equal((await c.post('/api/orders', { type: 'package', productId: '1.5', phone: freshPhone('8404'), idempotencyKey: key() })).status, 404);
  assert.equal(balanceOf(c.user.id), 10000);
});

test('WonDD: HTTP 4xx ที่แจ้งว่า "ซ้ำ" หรืออ่านไม่ออก → ไม่ถือว่าล้มเหลว (ไม่คืนเงินผิด)', () => {
  const { interpret } = require('../src/providers/wondd')._internal;
  assert.equal(interpret({ status: 422, json: { status: 'duplicate', message: 'ref ซ้ำ' } }, 'submit').outcome, 'unknown');
  assert.equal(interpret({ status: 409, json: null }, 'submit').outcome, 'unknown');
  assert.equal(interpret({ status: 404, json: null }, 'submit').outcome, 'unknown');
  assert.equal(interpret({ status: 400, json: { message: 'invalid mobile' } }, 'submit').outcome, 'failed');
  assert.equal(interpret({ status: 400, json: null }, 'status').outcome, 'unknown');
});
