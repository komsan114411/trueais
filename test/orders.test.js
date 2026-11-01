'use strict';
// ทดสอบทั้งระบบ (เปิดเซิร์ฟเวอร์จริง + ผู้ให้บริการจำลอง)
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
const settings = require('../src/services/settings');
const orders = require('../src/services/orders');
const wallet = require('../src/services/wallet');
const { hmacSha256 } = require('../src/lib/security');

let app;
let base;
let admin;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const balanceOf = (userId) => db.get('SELECT balance FROM users WHERE id = ?', userId).balance;
const orderRow = (ref) => db.get('SELECT * FROM orders WHERE ref = ?', ref);
const refunds = (orderId) => db.get("SELECT COUNT(*) AS c FROM wallet_ledger WHERE type = 'refund' AND ref_id = ?", orderId).c;
const key = () => crypto.randomUUID();

let phoneSeq = 1000;
const freshPhone = (suffix) => `08${String(10000000 + phoneSeq++).slice(-4)}${suffix}`; // 08 + 4 หลัก + 4 หลักท้าย

async function newCustomer(credit = 0) {
  const c = new Client(base);
  const phone = `09${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const r = await c.post('/api/auth/register', { name: 'ลูกค้าทดสอบ', phone, password: CUSTOMER_PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.user = r.body.data.user;
  if (credit) {
    const a = await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: String(credit), note: 'เครดิตทดสอบ' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
  }
  return c;
}

async function topup(c, phone, amount, extra = {}) {
  return c.post('/api/orders', { type: 'topup', network: 'AIS', phone, amount, idempotencyKey: key(), ...extra });
}

before(async () => {
  app = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
  admin = new Client(base);
  const r = await admin.post('/api/auth/login', { identifier: 'admin@test.local', password: ADMIN_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await admin.put('/api/admin/settings', {
    mock_success_rate: 100, mock_async_rate: 0, mock_callback_delay_sec: 0, mock_timeout_rate: 0,
    daily_limit_baht: 0, order_rate_per_min: 600,
  });
  assert.equal(s.status, 200, JSON.stringify(s.body));
});

after(async () => {
  await app.close();
});

test('สมัคร/เข้าสู่ระบบ และบังคับ CSRF', async () => {
  const c = await newCustomer();
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.data.user.id, c.user.id);
  const noCsrf = await fetch(`${base}/api/orders`, { method: 'POST', headers: { Cookie: c.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  const bad = await new Client(base).post('/api/auth/login', { identifier: c.user.phone, password: 'wrong-pass1' });
  assert.equal(bad.status, 401);
  const anon = await new Client(base).post('/api/orders', {});
  assert.equal(anon.status, 401);
});

test('ยอดเงินไม่พอ → ไม่สร้างรายการ ไม่ตัดเงิน', async () => {
  const c = await newCustomer(0);
  const r = await topup(c, freshPhone('7001'), 100);
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders WHERE user_id = ?', c.user.id).c, 0);
});

test('เติมสำเร็จ → ตัดเงินถูกต้อง มีประวัติครบ', async () => {
  const c = await newCustomer(500);
  const r = await topup(c, freshPhone('7002'), 100);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  const o = orderRow(r.body.data.order.ref);
  assert.equal(o.status, 'success');
  assert.equal(balanceOf(c.user.id), 40000);
  const detail = await c.get(`/api/orders/${o.ref}`);
  assert.ok(detail.body.data.events.length >= 3);
  const list = await c.get('/api/orders?status=success');
  assert.equal(list.body.data.total, 1);
  const w = await c.get('/api/wallet');
  assert.equal(w.body.data.balance, 40000);
});

test('ผู้ให้บริการปฏิเสธ (…0000) → ไม่สำเร็จ + คืนเงินครั้งเดียว', async () => {
  const c = await newCustomer(200);
  const r = await topup(c, freshPhone('0000'), 50);
  await app.queue.idle();
  const o = orderRow(r.body.data.order.ref);
  assert.equal(o.status, 'failed');
  assert.equal(balanceOf(c.user.id), 20000);
  assert.equal(refunds(o.id), 1);
  // ผลเดิมซ้ำ (เช่น callback ซ้ำ) ต้องไม่คืนเงินซ้ำ
  orders.applyResult(o.id, { outcome: 'failed', message: 'ซ้ำ' }, 'callback');
  assert.equal(refunds(o.id), 1);
  assert.equal(balanceOf(c.user.id), 20000);
});

test('เชื่อมต่อไม่ได้ (…4444) → มั่นใจว่าไม่ได้ส่ง จึงคืนเงินทันที', async () => {
  const c = await newCustomer(100);
  const r = await topup(c, freshPhone('4444'), 20);
  await app.queue.idle();
  assert.equal(orderRow(r.body.data.order.ref).status, 'failed');
  assert.equal(balanceOf(c.user.id), 10000);
  require('../src/services/breaker').reset();
});

test('Timeout หลังส่ง (…1111) → ห้ามคืนเงิน ห้ามส่งซ้ำ แล้วเช็กสถานะพบว่าสำเร็จ', async () => {
  const c = await newCustomer(300);
  const r = await topup(c, freshPhone('1111'), 100);
  await app.queue.idle();
  let o = orderRow(r.body.data.order.ref);
  assert.equal(o.status, 'processing', 'ไม่รู้ผลต้องค้างไว้ ไม่ใช่ failed');
  assert.equal(balanceOf(c.user.id), 20000, 'ต้องยังไม่คืนเงิน');
  assert.equal(refunds(o.id), 0);
  const submits = db.get("SELECT COUNT(*) AS c FROM provider_logs WHERE order_ref = ? AND action = 'submit'", o.ref).c;
  // ถึงเวลาเช็กสถานะ
  db.run('UPDATE orders SET next_check_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), o.id);
  await orders.pollDue();
  o = orderRow(o.ref);
  assert.equal(o.status, 'success');
  assert.equal(balanceOf(c.user.id), 20000);
  assert.equal(db.get("SELECT COUNT(*) AS c FROM provider_logs WHERE order_ref = ? AND action = 'submit'", o.ref).c, submits, 'ต้องไม่ส่งซ้ำ');
  require('../src/services/breaker').reset();
});

test('ผลมาทีหลังผ่าน callback: สำเร็จ (…5555) และ ไม่สำเร็จ (…3333)', async () => {
  const c = await newCustomer(500);
  const ok = await topup(c, freshPhone('5555'), 100);
  const fail = await topup(c, freshPhone('3333'), 150);
  await app.queue.idle();
  assert.equal(orderRow(ok.body.data.order.ref).status, 'processing');
  await waitFor(() => orderRow(ok.body.data.order.ref).status === 'success');
  await waitFor(() => orderRow(fail.body.data.order.ref).status === 'failed');
  assert.equal(balanceOf(c.user.id), 40000); // 500 - 100 (150 คืนแล้ว)
  const cb = db.get("SELECT COUNT(*) AS c FROM provider_logs WHERE action = 'callback' AND order_ref = ?", ok.body.data.order.ref).c;
  assert.equal(cb, 1);
});

test('callback ปลอม (ลายเซ็นผิด) ต้องถูกปฏิเสธ', async () => {
  const res = await fetch(`${base}/api/provider/callback/mock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mock-Signature': 'bad' }, body: JSON.stringify({ ref: 'X', status: 'success' }),
  });
  assert.equal(res.status, 401);
});

test('ผลขัดแย้ง: คืนเงินไปแล้วแต่ภายหลังแจ้งว่าสำเร็จ → แจ้งแอดมิน ไม่ขยับเงินเอง', async () => {
  const c = await newCustomer(100);
  const r = await topup(c, freshPhone('0000'), 50);
  await app.queue.idle();
  const o = orderRow(r.body.data.order.ref);
  assert.equal(o.status, 'failed');
  const body = JSON.stringify({ ref: o.ref, status: 'success', txn_id: 'X1', message: 'late success' });
  const res = await fetch(`${base}/api/provider/callback/mock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mock-Signature': hmacSha256(settings.appSecret(), body) }, body,
  });
  assert.equal(res.status, 200);
  const after = orderRow(o.ref);
  assert.equal(after.status, 'failed');
  assert.equal(after.needs_review, 1);
  assert.equal(balanceOf(c.user.id), 10000);
  // แอดมินยืนยันว่าสำเร็จจริง → ดึงเงินที่คืนกลับ
  const fix = await admin.post(`/api/admin/orders/${o.ref}/mark-success`, { note: 'ตรวจกับผู้ให้บริการแล้ว' });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  assert.equal(orderRow(o.ref).status, 'success');
  assert.equal(balanceOf(c.user.id), 5000);
});

test('ค้างสถานะ (…2222) → เช็กครบจำนวนครั้งแล้วส่งให้แอดมินตรวจ → แอดมินยืนยันไม่สำเร็จ + คืนเงิน', async () => {
  await admin.put('/api/admin/settings', { max_status_checks: 2 });
  const c = await newCustomer(100);
  const r = await topup(c, freshPhone('2222'), 30);
  await app.queue.idle();
  const ref = r.body.data.order.ref;
  for (let i = 0; i < 2; i++) {
    db.run('UPDATE orders SET next_check_at = ? WHERE ref = ?', new Date(Date.now() - 1000).toISOString(), ref);
    await orders.pollDue();
  }
  assert.equal(orderRow(ref).needs_review, 1);
  assert.equal(orderRow(ref).status, 'processing');
  const review = await admin.get('/api/admin/orders?status=review');
  assert.ok(review.body.data.rows.some((x) => x.ref === ref));
  // เพิ่งส่งไปไม่ถึง 2 นาที → ต้องยืนยันซ้ำ (กันคืนเงินทั้งที่ผู้ให้บริการอาจยังเติมสำเร็จ)
  const early = await admin.post(`/api/admin/orders/${ref}/mark-failed`, { note: 'ผู้ให้บริการยืนยันว่าไม่สำเร็จ' });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'ORDER_RECENT');
  assert.equal(orderRow(ref).status, 'processing');
  // หน้าจอเห็นสถานะเก่า (แอดมินอีกคนเปลี่ยนไปแล้ว) → ปฏิเสธ
  const stale = await admin.post(`/api/admin/orders/${ref}/mark-failed`, { note: 'x', expected_status: 'success', confirm_recent: true });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'STATUS_CHANGED');
  const fail = await admin.post(`/api/admin/orders/${ref}/mark-failed`, { note: 'ผู้ให้บริการยืนยันว่าไม่สำเร็จ', expected_status: 'processing', confirm_recent: true });
  assert.equal(fail.status, 200, JSON.stringify(fail.body));
  assert.equal(orderRow(ref).status, 'failed');
  assert.equal(balanceOf(c.user.id), 10000);
  const again = await admin.post(`/api/admin/orders/${ref}/mark-failed`, {});
  assert.equal(again.status, 400, 'คืนเงินซ้ำไม่ได้');
  await admin.put('/api/admin/settings', { max_status_checks: 12 });
});

test('Idempotency: ส่งคำขอเดิมซ้ำ (กดซ้ำ/เน็ตหลุด) → ได้รายการเดิม ตัดเงินครั้งเดียว', async () => {
  const c = await newCustomer(300);
  const k = key();
  const phone = freshPhone('7003');
  const [a, b] = await Promise.all([topup(c, phone, 100, { idempotencyKey: k }), topup(c, phone, 100, { idempotencyKey: k })]);
  assert.equal(a.body.data.order.ref, b.body.data.order.ref);
  assert.ok(a.body.data.existing || b.body.data.existing);
  await app.queue.idle();
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders WHERE user_id = ?', c.user.id).c, 1);
  assert.equal(balanceOf(c.user.id), 20000);
  const mismatch = await topup(c, phone, 50, { idempotencyKey: k });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_MISMATCH');
});

test('กันเติมซ้ำ: เบอร์+ยอดเดียวกันในเวลาใกล้กัน ต้องยืนยันอีกครั้ง', async () => {
  const c = await newCustomer(300);
  const phone = freshPhone('7004');
  await topup(c, phone, 100);
  const q = await c.post('/api/orders/quote', { type: 'topup', network: 'AIS', phone, amount: 100 });
  assert.equal(q.body.data.warning.code, 'DUPLICATE_RECENT');
  const dup = await topup(c, phone, 100);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_RECENT');
  const forced = await topup(c, phone, 100, { confirmDuplicate: true });
  assert.equal(forced.status, 201);
  await app.queue.idle();
  assert.equal(balanceOf(c.user.id), 10000);
});

test('ตรวจข้อมูล: เบอร์ผิด, ยอดนอกช่วง, เครือข่ายปิด', async () => {
  const c = await newCustomer(500);
  assert.equal((await topup(c, '021234567', 100)).body.error.code, 'INVALID_PHONE');
  assert.equal((await topup(c, freshPhone('7005'), 5)).body.error.code, 'AMOUNT_OUT_OF_RANGE');
  assert.equal((await topup(c, freshPhone('7005'), 10.5)).body.error.code, 'VALIDATION_ERROR');
  await admin.put('/api/admin/networks/DTAC', { topup_enabled: false, notice: 'dtac ปิดปรับปรุง 22:00-23:00' });
  const closed = await c.post('/api/orders', { type: 'topup', network: 'DTAC', phone: freshPhone('7006'), amount: 100, idempotencyKey: key() });
  assert.equal(closed.body.error.code, 'NETWORK_CLOSED');
  assert.equal(closed.body.error.message, 'dtac ปิดปรับปรุง 22:00-23:00');
  await admin.put('/api/admin/networks/DTAC', { topup_enabled: true, notice: '' });
  const loss = await admin.put('/api/admin/networks/AIS', { customer_discount: 5 });
  assert.equal(loss.status, 400, 'ส่วนลดลูกค้ามากกว่าที่ได้ต้องถูกปฏิเสธ');
  assert.equal(balanceOf(c.user.id), 50000);
});

test('แพ็กเกจเน็ต: ซื้อสำเร็จ + ต้นทุน/กำไรถูกต้อง', async () => {
  const c = await newCustomer(500);
  const cat = await c.get('/api/catalog');
  const pkg = cat.body.data.products.find((p) => p.network === 'TRUE');
  const r = await c.post('/api/orders', { type: 'package', productId: pkg.id, phone: freshPhone('7007'), idempotencyKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  const o = orderRow(r.body.data.order.ref);
  assert.equal(o.status, 'success');
  assert.equal(o.price, pkg.price);
  assert.ok(o.cost < o.price);
  assert.equal(balanceOf(c.user.id), 50000 - pkg.price);
});

test('เติมหลายรายการ: มีรายการผิด = ไม่ตัดเงินเลย / ถูกทั้งหมด = สร้างครบ', async () => {
  const c = await newCustomer(1000);
  const bad = await c.post('/api/orders/bulk', { items: [
    { type: 'topup', network: 'AIS', phone: freshPhone('7008'), amount: 50 },
    { type: 'topup', network: 'AIS', phone: '12345', amount: 50 },
  ] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.details.errors[0].index, 1);
  assert.equal(balanceOf(c.user.id), 100000);
  const batchKey = key();
  const items = [
    { type: 'topup', network: 'AIS', phone: freshPhone('7009'), amount: 50 },
    { type: 'topup', network: 'TRUE', phone: freshPhone('7010'), amount: 100 },
    { type: 'topup', network: 'DTAC', phone: freshPhone('7011'), amount: 150 },
  ];
  const good = await c.post('/api/orders/bulk', { items, batchKey });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.data.orders.length, 3);
  const again = await c.post('/api/orders/bulk', { items, batchKey });
  assert.equal(again.body.data.existing, true, 'ส่งชุดเดิมซ้ำต้องไม่สร้างใหม่');
  await app.queue.idle();
  assert.equal(balanceOf(c.user.id), 100000 - 30000);
});

test('วงเงินต่อวัน และจำกัดความถี่', async () => {
  const c = await newCustomer(1000);
  await admin.post(`/api/admin/users/${c.user.id}/limit`, { daily_limit_baht: 150 });
  assert.equal((await topup(c, freshPhone('7012'), 100)).status, 201);
  const over = await topup(c, freshPhone('7013'), 100);
  assert.equal(over.body.error.code, 'DAILY_LIMIT');
  await admin.post(`/api/admin/users/${c.user.id}/limit`, { daily_limit_baht: null });
  await admin.put('/api/admin/settings', { order_rate_per_min: 2 });
  await topup(c, freshPhone('7014'), 10);
  const limited = await topup(c, freshPhone('7015'), 10);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  await admin.put('/api/admin/settings', { order_rate_per_min: 600 });
  await app.queue.idle();
});

test('ปิดปรับปรุงระบบ → ไม่รับรายการ ไม่ตัดเงิน', async () => {
  const c = await newCustomer(100);
  await admin.put('/api/admin/settings', { maintenance_mode: true });
  const r = await topup(c, freshPhone('7016'), 10);
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'MAINTENANCE');
  await admin.put('/api/admin/settings', { maintenance_mode: false });
  assert.equal(balanceOf(c.user.id), 10000);
});

test('เติมเงินเข้ากระเป๋า: QR พร้อมเพย์ → แนบสลิป → แอดมินอนุมัติได้ครั้งเดียว', async () => {
  await admin.put('/api/admin/settings', { promptpay_id: '0812345678', promptpay_name: 'ร้านทดสอบ' });
  const c = await newCustomer(0);
  const d = await c.post('/api/deposits', { amount: 100, method: 'promptpay' });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const dep = d.body.data.deposit;
  assert.ok(dep.amount > 10000 && dep.amount < 10100, 'ต้องมีเศษสตางค์');
  assert.ok(d.body.data.qr.svg.includes('<svg'));
  const fake = await c.post(`/api/deposits/${dep.id}/slip`, { image: 'data:image/png;base64,aGVsbG8=' });
  assert.equal(fake.status, 400, 'ไฟล์ปลอมต้องไม่ผ่าน');
  const slip = await c.post(`/api/deposits/${dep.id}/slip`, { image: PNG });
  assert.equal(slip.status, 200, JSON.stringify(slip.body));
  const img = await fetch(`${base}/api/admin/deposits/${dep.id}/slip`, { headers: { Cookie: admin.cookie } });
  assert.equal(img.status, 200);
  const ok1 = await admin.post(`/api/admin/deposits/${dep.id}/approve`, { note: 'ตรวจสลิปแล้ว', slip_ver: await slipVer(admin, dep.id) });
  assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
  assert.equal(balanceOf(c.user.id), dep.amount);
  const ok2 = await admin.post(`/api/admin/deposits/${dep.id}/approve`, { slip_ver: await slipVer(admin, dep.id) });
  assert.equal(ok2.status, 400);
  assert.equal(balanceOf(c.user.id), dep.amount);
});

test('API ร้านค้า (/api/v1) + webhook พร้อมลายเซ็น', async () => {
  const received = [];
  const hook = http.createServer((req, res) => {
    let data = '';
    req.on('data', (ch) => { data += ch; });
    req.on('end', () => { received.push({ headers: req.headers, body: data }); res.end('ok'); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
  try {
    const merchant = await newCustomer(1000);
    const k = await admin.post('/api/admin/api-keys', { user_id: merchant.user.id, name: 'เว็บร้านหลัก', webhook_url: hookUrl });
    assert.equal(k.status, 201, JSON.stringify(k.body));
    const { api_key: apiKey, webhook_secret: secret } = k.body.data;
    const call = (method, url, body) => fetch(base + url, {
      method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

    assert.equal((await call('GET', '/api/v1/balance')).body.data.balance, 1000);
    const products = await call('GET', '/api/v1/products');
    assert.ok(products.body.data.packages.length > 0);
    const noRef = await call('POST', '/api/v1/orders', { type: 'topup', network: 'AIS', phone: freshPhone('7017'), amount: 100 });
    assert.equal(noRef.status, 400);
    const reference = `INV-${Date.now()}`;
    const created = await call('POST', '/api/v1/orders', { type: 'topup', network: 'AIS', phone: freshPhone('7018'), amount: 100, reference });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const dupe = await call('POST', '/api/v1/orders', { type: 'topup', network: 'AIS', phone: created.body.data.order.phone, amount: 100, reference });
    assert.equal(dupe.status, 200);
    assert.equal(dupe.body.data.existing, true);
    await app.queue.idle();
    await waitFor(() => received.length >= 1);
    const w = received[0];
    const payload = JSON.parse(w.body);
    assert.equal(payload.data.reference, reference);
    assert.equal(payload.data.status, 'success');
    const expected = `sha256=${hmacSha256(secret, `${w.headers['x-webhook-timestamp']}.${w.body}`)}`;
    assert.equal(w.headers['x-webhook-signature'], expected);
    const byRef = await call('GET', `/api/v1/orders?reference=${reference}`);
    assert.equal(byRef.body.data.order.status, 'success');
    const bad = await fetch(`${base}/api/v1/balance`, { headers: { Authorization: 'Bearer tk_wrong' } });
    assert.equal(bad.status, 401);
  } finally {
    hook.close();
  }
});

test('หลังบ้าน: แดชบอร์ด รายงาน log และ CSV ใช้งานได้ / ลูกค้าเข้าไม่ได้', async () => {
  const c = await newCustomer();
  assert.equal((await c.get('/api/admin/dashboard')).status, 403);
  const d = await admin.get('/api/admin/dashboard');
  assert.equal(d.status, 200);
  assert.equal(d.body.data.series.length, 14);
  assert.ok(d.body.data.today.orders > 0);
  assert.equal((await admin.get('/api/admin/reports/sales?group=network')).status, 200);
  assert.equal((await admin.get('/api/admin/logs/provider')).status, 200);
  assert.equal((await admin.get('/api/admin/logs/audit')).status, 200);
  const csv = await fetch(`${base}/api/admin/orders/export.csv`, { headers: { Cookie: admin.cookie } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'ต้องมี BOM ให้ Excel อ่านภาษาไทยได้');
  assert.equal((await admin.get('/api/admin/settings')).body.data.schema.fields.length > 10, true);
});

test('สำรองฐานข้อมูล: ได้ไฟล์ที่เปิดอ่านได้จริง', async () => {
  const r = await admin.post('/api/admin/backups', {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const list = await admin.get('/api/admin/backups');
  assert.ok(list.body.data.some((b) => b.name === r.body.data.name));
  const path = require('node:path');
  const file = path.join(process.env.DATA_DIR, 'backups', r.body.data.name);
  if (db.isPostgres()) {
    // PostgreSQL: ไฟล์ .json.gz — บรรทัดแรกเป็นหัวไฟล์ บรรทัดสุดท้ายบอกจำนวนแถวของทุกตาราง
    assert.match(r.body.data.name, /\.json\.gz$/);
    const lines = require('node:zlib').gunzipSync(require('node:fs').readFileSync(file)).toString('utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[0]).format, 'topup-backup');
    const end = JSON.parse(lines.at(-1));
    assert.equal(end.end, true);
    assert.ok(end.counts.users > 1);
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const copy = new DatabaseSync(file, { readOnly: true });
    assert.ok(copy.prepare('SELECT COUNT(*) AS c FROM users').get().c > 1);
    copy.close();
  }
});

test('ตรวจบัญชี: ยอดในกระเป๋าทุกคนตรงกับสมุดบัญชี', () => {
  assert.deepEqual(wallet.reconcile(), []);
  const neg = db.get('SELECT COUNT(*) AS c FROM users WHERE balance < 0').c;
  assert.equal(neg, 0);
});
