'use strict';
// ทดสอบจุดที่ผู้ตรวจระบบสลับเจ้าพบ (14 ข้อ): คำตอบที่ไม่อยู่ในคู่มือ, ธงอาจเติมซ้ำ, ผลมาช้า, 404/บล็อก IP,
// KYC ยิงรัว, sync ไม่ครบ, ต้นทุน 0, รหัสสินค้าของร้านค้า ฯลฯ — ใช้ HubZell จำลองที่ตรวจลายเซ็นจริง
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setupEnv, Client, ADMIN_PASSWORD, CUSTOMER_PASSWORD } = require('./helpers');
const { createFakeHubzell } = require('./fakeHubzell');

const HZ_KEY = 'hz_test_key';
const HZ_SECRET = 'hz_test_secret_value';
setupEnv({ PROVIDERS: 'hubzell,mock', HUBZELL_API_KEY: HZ_KEY, HUBZELL_SECRET_KEY: HZ_SECRET, PROVIDER_TIMEOUT_MS: '1000' });
const config = require('../src/config');
const { start } = require('../src/server');
const db = require('../src/db');
const orders = require('../src/services/orders');
const wallet = require('../src/services/wallet');
const breaker = require('../src/services/breaker');
const settings = require('../src/services/settings');
const providers = require('../src/providers');
const hubzell = require('../src/providers/hubzell');

let app;
let base;
let admin;
let fake;
const maps = {};

const balanceOf = (userId) => db.get('SELECT balance FROM users WHERE id = ?', userId).balance;
const orderRow = (ref) => db.get('SELECT * FROM orders WHERE ref = ?', ref);
const attemptsOf = (ref) => db.all('SELECT a.* FROM order_attempts a JOIN orders o ON o.id = a.order_id WHERE o.ref = ? ORDER BY attempt_no', ref);
const states = (ref) => attemptsOf(ref).map((a) => `${a.provider}:${a.state}`);
const mockGot = (ref) => Boolean(db.get('SELECT 1 AS x FROM mock_txns WHERE ref = ?', ref));
const refunds = (ref) => db.get("SELECT COUNT(*) AS c FROM wallet_ledger WHERE type = 'refund' AND ref_type = 'order' AND ref_id = ?", orderRow(ref).id).c;
const key = () => crypto.randomUUID();
let seq = 300;
const phone = (suffix) => `08${String(1000 + seq++).slice(-4)}${suffix}`;
const callbackUrl = () => `${base}/api/provider/callback/hubzell`;
const envelope = (code, extra = {}) => ({ status: 1, code, message: code, data: null, trace_id: 'TRC-T', ...extra });

async function newCustomer(credit) {
  const c = new Client(base);
  const r = await c.post('/api/auth/register', { name: 'ลูกค้าทดสอบ', phone: `09${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`, password: CUSTOMER_PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.user = r.body.data.user;
  if (credit) assert.equal((await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: String(credit), note: 'เครดิตทดสอบ' })).status, 200);
  return c;
}

async function topup(c, ph, amount = 50, extra = {}) {
  const r = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: ph, amount, idempotencyKey: key(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  return r.body.data.order.ref;
}

async function poll(ref) {
  db.run('UPDATE orders SET next_check_at = ? WHERE ref = ?', new Date(Date.now() - 1000).toISOString(), ref);
  await orders.pollDue();
}

/** callback ของ HubZell ที่ลงลายเซ็นถูกต้อง (เหมือนที่ HubZell ส่งจริง) */
async function signedCallback(ref, status) {
  const body = JSON.stringify({ transaction_id: '9001', client_ref: ref, status, input: {}, category: 'MOBILE_TOPUP', amount: 48.75, currency: 'THB', message: 'ok' });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', HZ_SECRET).update(`${ts}\n${body}`).digest('hex');
  const r = await fetch(callbackUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hubzell-Timestamp': ts, 'X-Hubzell-Signature': sig }, body });
  return r.status;
}

before(async () => {
  fake = createFakeHubzell({ apiKey: HZ_KEY, secret: HZ_SECRET });
  const port = await fake.listen();
  config.hubzell.baseUrl = `http://127.0.0.1:${port}/api/v1`;
  app = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
  admin = new Client(base);
  assert.equal((await admin.post('/api/auth/login', { identifier: 'admin@test.local', password: ADMIN_PASSWORD })).status, 200);
  const s = await admin.put('/api/admin/settings', {
    mock_success_rate: 100, mock_async_rate: 0, mock_callback_delay_sec: 0, mock_timeout_rate: 0,
    daily_limit_baht: 0, order_rate_per_min: 600, duplicate_window_sec: 0,
  });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await admin.post('/api/admin/providers/hubzell/sync', {})).status, 200);
  for (const [svc, amount] of [['HZ_AIS_20', 20], ['HZ_AIS_50', 50], ['HZ_AIS_100', 100]]) {
    const m = await admin.post('/api/admin/providers/hubzell/mappings', { service_id: svc, kind: 'topup', network_code: 'AIS', face_value_baht: amount, enabled: true });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    maps[svc] = m.body.data.id;
  }
  const made = await admin.post('/api/admin/providers/hubzell/catalog/HZ_AIS_NET_3GB/product', { network_code: 'AIS', price_baht: 19, name: 'เน็ต 3GB 1 วัน (HubZell)' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  maps.pkg = made.body.data.product.id;
  assert.equal((await admin.put(`/api/admin/products/${maps.pkg}`, { enabled: true })).status, 200);
  const pm = (await admin.get('/api/admin/providers/hubzell/catalog')).body.data.mappings.find((m) => m.product_id === maps.pkg);
  maps.pkgMap = pm.id;
  assert.equal((await admin.put(`/api/admin/providers/hubzell/mappings/${pm.id}`, { enabled: true })).status, 200);
});

after(async () => {
  await app.close();
  await fake.close();
});

beforeEach(() => {
  breaker.reset();
  hubzell._internal.resetGuards();
  fake.state.createOverrides.length = 0;
  fake.state.forced = null;
});

test('#1 HubZell ตอบข้อผิดพลาดที่ไม่อยู่ในคู่มือ → ไม่สลับเจ้า ไม่คืนเงิน → เช็กสถานะ = ส่งซ้ำเลขเดิม แล้วรู้ผลจริง', async () => {
  const variants = [
    ['รหัสที่ไม่รู้จัก', { http: 400, body: envelope('SOMETHING_NEW') }],
    ['ไม่มีรหัส', { http: 400, body: { status: 1, message: 'x' } }],
    ['409 ที่ไม่ใช่เลขซ้ำ', { http: 409, body: envelope('CONFLICT') }],
    ['408 แบบมีรูปแบบ', { http: 408, body: envelope('REQUEST_TIMEOUT') }],
    ['200 แต่ status = 1', { http: 200, body: envelope('ACCEPTED_LATER') }],
    ['รหัสในคู่มือ แต่ HTTP ไม่ตรงคู่มือ', { http: 500, body: envelope('INSUFFICIENT_BALANCE') }],
    ['หน้า HTML จากไฟร์วอลล์', { http: 403, body: '<html><body>Access denied</body></html>' }],
  ];
  const c = await newCustomer(60 * variants.length);
  for (const [label, ov] of variants) {
    breaker.reset();
    fake.state.createOverrides.push({ ...ov, create: true }); // HubZell สร้างรายการแล้วจริง แต่ตอบแปลก
    const ref = await topup(c, phone('2001'), 50);
    let o = orderRow(ref);
    assert.equal(o.status, 'processing', label);
    assert.equal(o.provider, 'hubzell', label);
    assert.equal(mockGot(ref), false, `${label}: ห้ามส่งเจ้าสำรอง (HubZell อาจทำไปแล้ว)`);
    assert.equal(refunds(ref), 0, label);
    assert.deepEqual(states(ref), ['hubzell:unknown'], label);
    await poll(ref);
    o = orderRow(ref);
    assert.equal(o.status, 'success', label);
    assert.equal(fake.createCount(ref), 2, `${label}: ส่งซ้ำด้วยเลขเดิม 1 ครั้ง`);
    assert.equal(attemptsOf(ref)[0].resends, 1, label);
    assert.equal(mockGot(ref), false, label);
  }
  assert.equal(balanceOf(c.user.id), 60 * variants.length * 100 - 5000 * variants.length);
  assert.deepEqual(wallet.reconcile(), []);
});

test('#7 คำขอหลุดก่อนถึง HubZell → ไม่รู้ผล → ส่งซ้ำเลขเดิม = HubZell สร้างรายการตอนนั้น (1 รายการ ไม่ไปเจ้าอื่น)', async () => {
  const c = await newCustomer(100);
  fake.state.createOverrides.push({ drop: true });
  const ref = await topup(c, phone('2002'), 50);
  assert.equal(orderRow(ref).status, 'processing');
  assert.equal(fake.state.orders.has(ref), false);
  await poll(ref);
  assert.equal(orderRow(ref).status, 'success');
  assert.equal(fake.state.orders.has(ref), true);
  assert.equal(fake.createCount(ref), 2);
  assert.equal(mockGot(ref), false);
  assert.equal(hubzell._internal.recent404(), 0, 'ไม่ยิงค้นรายการที่ไม่มี (กัน 404)');
});

test('#4 เจ้าที่ปฏิเสธ แจ้งภายหลังว่าสำเร็จ ขณะรายการรอส่งต่อ → ให้เจ้านั้นทำต่อ (ไม่ส่งเจ้าอื่น ไม่คืนเงิน)', async () => {
  breaker.open('mock', 600, 'ทดสอบ: พักเจ้าสำรอง');
  const c = await newCustomer(100);
  const ref = await topup(c, phone('7008'), 50); // HubZell ปฏิเสธ (ข้อมูลไม่ผ่าน) + เจ้าสำรองถูกพัก → รอ
  assert.equal(orderRow(ref).status, 'pending');
  assert.deepEqual(states(ref), ['hubzell:rejected']);
  assert.equal(await signedCallback(ref, 'SUCCESS'), 200);
  const o = orderRow(ref);
  assert.equal(o.status, 'success');
  assert.equal(o.provider, 'hubzell');
  assert.deepEqual(states(ref), ['hubzell:success']);
  assert.equal(refunds(ref), 0);
  breaker.reset('mock');
  db.run('UPDATE orders SET created_at = ? WHERE ref = ?', new Date(Date.now() - 60000).toISOString(), ref);
  orders.recoverPending();
  await app.queue.idle();
  assert.equal(mockGot(ref), false, 'ห้ามส่งเจ้าสำรองอีก');
  assert.equal(balanceOf(c.user.id), 5000);
});

test('#3 ธง "อาจเติมซ้ำ 2 เจ้า" ถูกล็อก: ผลสำเร็จของเจ้าที่ทำรายการล้างเองไม่ได้ ต้องให้เจ้าหน้าที่ล้าง', async () => {
  const c = await newCustomer(100);
  fake.state.createOverrides.push({ http: 400, body: envelope('VALIDATION_ERROR') }); // HubZell ปฏิเสธ (ตามคู่มือ)
  const ref = await topup(c, phone('2222'), 50); // เจ้าสำรอง (mock) รับไว้แล้วรอผล
  let o = orderRow(ref);
  assert.equal(o.provider, 'mock');
  assert.equal(o.status, 'processing');
  assert.equal(await signedCallback(ref, 'SUCCESS'), 200); // HubZell บอกว่าทำสำเร็จ!
  o = orderRow(ref);
  assert.equal(o.needs_review, 1);
  assert.equal(o.review_sticky, 1);
  assert.match(o.review_reason, /อาจเติมซ้ำ/);
  orders.applyResult(o.id, { outcome: 'success', providerStatus: 'SUCCESS', message: 'ok' }, 'callback', { provider: 'mock' });
  o = orderRow(ref);
  assert.equal(o.status, 'success');
  assert.equal(o.needs_review, 1, 'ผลของเจ้าที่ทำรายการต้องไม่ล้างธงนี้');
  assert.match(o.review_reason, /อาจเติมซ้ำ/);
  const detail = await admin.get(`/api/admin/orders/${o.id}`);
  assert.equal(detail.body.data.order.review_locked, true);
  const cleared = await admin.post(`/api/admin/orders/${o.id}/clear-review`, { note: 'ตรวจกับทั้งสองเจ้าแล้ว', expected_status: 'success' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  o = orderRow(ref);
  assert.equal(o.needs_review, 0);
  assert.equal(o.review_sticky, 0);
});

test('#5 ผลที่มาช้าจากเจ้าก่อนหน้า (หลังสลับเจ้าแล้ว) → ไม่นำมาใช้ ไม่คืนเงิน', async () => {
  const c = await newCustomer(100);
  fake.state.createOverrides.push({ http: 400, body: envelope('VALIDATION_ERROR') });
  const ref = await topup(c, phone('2222'), 50);
  const o = orderRow(ref);
  assert.equal(o.provider, 'mock');
  orders.applyResult(o.id, { outcome: 'failed', providerStatus: 'FAILED', message: 'ผลเก่าของ HubZell' }, 'status', { provider: 'hubzell' });
  const after1 = orderRow(ref);
  assert.equal(after1.status, 'processing');
  assert.equal(refunds(ref), 0);
  assert.deepEqual(states(ref), ['hubzell:rejected', 'mock:accepted']);
});

test('#13 ผลขัดแย้ง: ระหว่างรอคำตอบตอนส่ง HubZell แจ้งว่ารับรายการแล้ว แต่คำตอบบอกว่าปฏิเสธ → ไม่สลับเจ้า ไม่คืนเงิน ส่งให้ตรวจ', async () => {
  const c = await newCustomer(100);
  fake.state.createOverrides.push({ http: 400, body: envelope('VALIDATION_ERROR'), create: true, createStatus: 'PENDING', delayMs: 400 });
  const r = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: phone('2003'), amount: 50, idempotencyKey: key() });
  assert.equal(r.status, 201);
  const ref = r.body.data.order.ref;
  for (let i = 0; i < 100 && fake.createCount(ref) === 0; i++) await new Promise((x) => setTimeout(x, 10));
  assert.equal(await signedCallback(ref, 'PENDING'), 200); // มาถึงก่อนคำตอบของคำขอส่ง
  await app.queue.idle();
  const o = orderRow(ref);
  assert.equal(o.status, 'processing');
  assert.equal(o.provider, 'hubzell');
  assert.equal(o.needs_review, 1);
  assert.match(o.review_reason, /ผลขัดแย้ง/);
  assert.equal(mockGot(ref), false);
  assert.equal(refunds(ref), 0);
  assert.deepEqual(states(ref), ['hubzell:accepted']);
});

test('#6 API ร้านค้า: ส่งซ้ำ reference เดิมของแพ็กเกจที่ไปทาง HubZell → ได้รายการเดิม (แม้ปิดปรับปรุงอยู่) และเห็นรหัสสินค้าของเรา', async () => {
  const c = await newCustomer(100);
  const k = await admin.post('/api/admin/api-keys', { user_id: c.user.id, name: 'ร้านทดสอบ' });
  assert.equal(k.status, 201, JSON.stringify(k.body));
  const call = (method, url, body) => fetch(base + url, {
    method, headers: { Authorization: `Bearer ${k.body.data.api_key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (x) => ({ status: x.status, body: await x.json() }));
  const req = { type: 'package', network: 'AIS', product_code: 'HUBZELL:HZ_AIS_NET_3GB', phone: phone('2004'), reference: 'HZ-PKG-REF-0001' };
  const first = await call('POST', '/api/v1/orders', req);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await app.queue.idle();
  const row = orderRow(first.body.data.order.ref);
  assert.equal(row.provider, 'hubzell');
  assert.equal(row.product_code, 'HUBZELL:HZ_AIS_NET_3GB', 'เก็บรหัสสินค้าของเรา (ที่ร้านค้าส่งมา)');
  assert.equal(attemptsOf(row.ref)[0].code, 'HZ_AIS_NET_3GB', 'รหัสบริการ HubZell อยู่ในบันทึกการส่ง');
  await admin.put('/api/admin/settings', { maintenance_mode: true });
  try {
    const again = await call('POST', '/api/v1/orders', req);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.existing, true);
    assert.equal(again.body.data.order.ref, first.body.data.order.ref);
  } finally {
    await admin.put('/api/admin/settings', { maintenance_mode: false });
  }
  assert.equal(balanceOf(c.user.id), 10000 - 1900, 'ตัดเงินครั้งเดียว');
});

test('#7 กันโดนบล็อก IP: HubZell ไม่มีบริการ → ปิดการจับคู่นั้น / ค้นไม่พบ 2 ครั้ง → หยุดเช็กให้แอดมินตรวจ / 404 ครบ 2 ครั้ง → หยุดเรียกทั้งหมด', async () => {
  // ก) บริการถูกลบที่ HubZell → สร้างรายการได้ 404 → ปิดการจับคู่ + ส่งเจ้าสำรอง (ยังไม่ได้สร้างรายการ)
  const svc = fake.state.products.HZ_AIS.services.find((s) => s.id === 'HZ_AIS_100');
  fake.state.products.HZ_AIS.services = fake.state.products.HZ_AIS.services.filter((s) => s.id !== 'HZ_AIS_100');
  const c = await newCustomer(300);
  try {
    const ref = await topup(c, phone('2005'), 100);
    assert.equal(orderRow(ref).provider, 'mock');
    assert.deepEqual(states(ref), ['hubzell:rejected', 'mock:success']);
    assert.equal(db.get('SELECT enabled FROM provider_map WHERE id = ?', maps.HZ_AIS_100).enabled, 0, 'ปิดการจับคู่ทันที');
    const before404 = fake.state.requests.length;
    await topup(c, phone('2006'), 100);
    assert.equal(fake.state.requests.length, before404, 'รายการถัดไปไม่ยิง HubZell ซ้ำ');
  } finally {
    fake.state.products.HZ_AIS.services.push(svc);
    await admin.put(`/api/admin/providers/hubzell/mappings/${maps.HZ_AIS_100}`, { enabled: true });
  }

  // ข) รายการที่ HubZell เคยรับแล้ว แต่ค้นไม่พบ 2 ครั้ง → หยุดเช็กอัตโนมัติ + ให้แอดมินตรวจ (ไม่คืนเงินเอง)
  hubzell._internal.resetGuards();
  const ref2 = await topup(c, phone('7006'), 50);
  assert.deepEqual(states(ref2), ['hubzell:accepted']);
  fake.state.orders.delete(ref2);
  await poll(ref2);
  hubzell._internal.resetGuards(); // แยกทดสอบตัวนับรายรายการ ออกจากตัวนับรวม
  await poll(ref2);
  const o2 = orderRow(ref2);
  assert.equal(o2.status, 'processing');
  assert.equal(o2.next_check_at, null, 'หยุดเช็กอัตโนมัติ');
  assert.equal(o2.needs_review, 1);
  assert.match(o2.review_reason, /ไม่พบรายการนี้/);
  assert.equal(refunds(ref2), 0);

  // ค) 404 ครบ 2 ครั้งใน 5 นาที → ไม่ส่งคำขอใดๆ ไป HubZell อีก (HubZell บล็อก IP ที่ 5 ครั้ง)
  hubzell._internal.resetGuards();
  breaker.reset();
  fake.state.forced = [404, 'NOT_FOUND'];
  const n0 = fake.state.requests.length;
  for (let i = 0; i < 4; i++) await hubzell.getBalance();
  assert.equal(fake.state.requests.length - n0, 2, 'ยิงได้ไม่เกิน 2 ครั้ง');
  assert.equal(breaker.isOpen('hubzell'), true);
  fake.state.forced = null;
});

test('#8 KYC ยังไม่ผ่าน: ส่งพร้อมกันหลายรายการ → ถึง HubZell แค่ตามจำนวนคิว / การพักนานยังอยู่หลังรีสตาร์ท / IP ถูกบล็อก = พัก 24 ชม.', async () => {
  const saved = config.hubzell.maxConcurrent;
  config.hubzell.maxConcurrent = 1;
  try {
    const kyc0 = fake.state.requests.filter((r) => r.code === 'KYC_NOT_APPROVED').length;
    const jobs = [1, 2, 3, 4, 5].map((i) => hubzell.submit({ ref: `TPKYC${i}${Date.now()}`.slice(0, 18), type: 'topup', network_code: 'AIS', face_value: 5000, phone: phone('7003') }));
    const results = await Promise.all(jobs);
    const kyc = fake.state.requests.filter((r) => r.code === 'KYC_NOT_APPROVED').length - kyc0;
    assert.equal(kyc, 1, 'คิว 1 ช่อง: ถึง HubZell แค่ 1 คำขอ ที่เหลือเห็นการพักแล้วไม่ยิง');
    assert.equal(results.filter((r) => r.providerStatus === 'PAUSED').length, 4);
    for (const r of results) assert.equal(r.outcome, 'failed'); // ทุกคำขอยังไม่ได้สร้างรายการ → ส่งต่อเจ้าอื่นได้
  } finally {
    config.hubzell.maxConcurrent = saved;
  }
  // ทั้งชุด (เติมหลายรายการ) ก็ไม่ยิงซ้ำหลังเจอ KYC
  breaker.reset();
  const c = await newCustomer(500);
  const kycBefore = fake.state.requests.filter((r) => r.code === 'KYC_NOT_APPROVED').length;
  const items = [1, 2, 3, 4, 5].map(() => ({ type: 'topup', network: 'AIS', phone: phone('7003'), amount: 50 }));
  const bulk = await c.post('/api/orders/bulk', { items, batchKey: key() });
  assert.equal(bulk.status, 201, JSON.stringify(bulk.body));
  await app.queue.idle();
  const kycSent = fake.state.requests.filter((r) => r.code === 'KYC_NOT_APPROVED').length - kycBefore;
  assert.ok(kycSent <= config.hubzell.maxConcurrent, `ยิง KYC ${kycSent} ครั้ง (เกินจำนวนคิว)`);
  for (const o of bulk.body.data.orders) assert.equal(orderRow(o.ref).provider, 'mock');

  // พัก 1 ชม. (KYC) ถูกบันทึกในฐานข้อมูล → รีสตาร์ทแล้วยังพัก
  assert.ok(settings.getInternal('_breaker_hubzell')?.until > Date.now());
  breaker._forgetMemory();
  assert.equal(breaker.isOpen('hubzell'), true, 'หลังรีสตาร์ทยังพักอยู่');
  breaker.reset('hubzell');
  breaker._forgetMemory();
  assert.equal(breaker.isOpen('hubzell'), false, 'แอดมินกดรีเซ็ตแล้ว = หายจริง');

  // IP ถูกบล็อก (24 ชม.) → พัก 24 ชม.
  const r = hubzell._internal.interpret({ status: 403, json: { status: 1, code: 'IP_BLOCKED', message: 'blocked' } }, 'submit');
  assert.equal(r.outcome, 'failed');
  assert.equal(r.trip.seconds, 86400);
});

test('#9 HUBZELL_API_URL ผิด → ถือว่ายังตั้งค่าไม่ครบ ไม่ส่งคำขอเลย (กันยิง URL ผิดจนโดนบล็อก)', async () => {
  const saved = config.hubzell.baseUrl;
  try {
    for (const bad of ['gateway.hubzell.com/api/v1', 'https://gateway.hubzell.com', 'http://gateway.hubzell.com/api/v1', 'https://gateway.hubzell.com/api/v1?x=1']) {
      config.hubzell.baseUrl = bad;
      const st = hubzell.configStatus();
      assert.equal(st.ready, false, bad);
      assert.ok(st.missing.some((m) => m.includes('HUBZELL_API_URL')), bad);
    }
    config.hubzell.baseUrl = 'gateway.hubzell.com/api/v1';
    const n0 = fake.state.requests.length;
    const c = await newCustomer(100);
    const ref = await topup(c, phone('2007'), 50);
    assert.equal(orderRow(ref).provider, 'mock');
    assert.equal(fake.state.requests.length, n0);
  } finally {
    config.hubzell.baseUrl = saved;
  }
  assert.equal(hubzell.configStatus().ready, true);
});

test('#10 ดึงรายการบริการได้ไม่ครบ (เช่น โดนจำกัดความถี่) → ไม่ปิดการจับคู่ของสินค้านั้น / ได้รายการว่าง → ไม่อัปเดตเลย', async () => {
  fake.state.failProducts.set('HZ_AIS', [429, 'VALIDATION_ERROR']);
  const sync = await admin.post('/api/admin/providers/hubzell/sync', {});
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body.data.incomplete, 1);
  assert.equal(sync.body.data.disabled.length, 0, JSON.stringify(sync.body.data.disabled));
  for (const id of [maps.HZ_AIS_20, maps.HZ_AIS_50, maps.HZ_AIS_100]) assert.equal(db.get('SELECT enabled FROM provider_map WHERE id = ?', id).enabled, 1);

  const savedProducts = fake.state.products;
  fake.state.products = {};
  try {
    const empty = await admin.post('/api/admin/providers/hubzell/sync', {});
    assert.equal(empty.status, 400);
    assert.match(empty.body.error.message, /ว่างเปล่า/);
    assert.equal(db.get('SELECT enabled FROM provider_map WHERE id = ?', maps.HZ_AIS_50).enabled, 1);
  } finally {
    fake.state.products = savedProducts;
  }
});

test('#11 HubZell แจ้งยอดที่ตัดเป็น 0 → ไม่บันทึกต้นทุนเพี้ยน', async () => {
  const c = await newCustomer(100);
  fake.state.createOverrides.push({
    http: 200, create: true,
    body: (b) => ({ status: 0, code: 'SUCCESS', message: 'ok', data: { status: 'SUCCESS', transaction_id: 'T0', client_ref: b.client_ref, total_amount: 0 } }),
  });
  const ref = await topup(c, phone('2008'), 50);
  const o = orderRow(ref);
  assert.equal(o.status, 'success');
  assert.equal(o.cost, 4875);
  assert.equal(db.get('SELECT cost FROM provider_map WHERE id = ?', maps.HZ_AIS_50).cost, 4875);
});

test('#12 เช็กสถานะแล้วเจอปัญหาบัญชี (เช่น key ผิด) → พัก HubZell เหมือนตอนส่ง', async () => {
  const c = await newCustomer(100);
  const ref = await topup(c, phone('7006'), 50);
  assert.deepEqual(states(ref), ['hubzell:accepted']);
  fake.state.forced = [401, 'INVALID_SIGNATURE'];
  await poll(ref);
  fake.state.forced = null;
  assert.equal(breaker.isOpen('hubzell'), true);
  assert.match(breaker.snapshot('hubzell').reason, /key/);
  assert.equal(orderRow(ref).status, 'processing', 'ไม่สรุปผลรายการจากการเช็กที่ผิดพลาด');
  breaker.reset();
  assert.equal(await fake.finish(ref, 'SUCCESS', callbackUrl()), 200);
  assert.equal(orderRow(ref).status, 'success');
});

test('#2 #14 ห้ามใช้ mock ร่วมกับเจ้าจริง (ทุกวิธีเปิด) + ค่าความถี่/คิวถูกจำกัดตามคู่มือ', () => {
  config.isTest = false;
  try {
    assert.throws(() => providers.configured(), /mock\/mock2/);
  } finally {
    config.isTest = true;
  }
  const path = require.resolve('../src/config');
  const orig = require.cache[path];
  const saved = { ...process.env };
  Object.assign(process.env, { HUBZELL_RATE_PER_MIN: '500', HUBZELL_MAX_CONCURRENT: '50', PROVIDER_CONCURRENCY: '99' });
  try {
    delete require.cache[path];
    const fresh = require('../src/config');
    assert.equal(fresh.hubzell.ratePerMin, 120);
    assert.equal(fresh.hubzell.maxConcurrent, 5);
    assert.equal(fresh.provider.concurrency, 10);
  } finally {
    require.cache[path] = orig;
    for (const k of ['HUBZELL_RATE_PER_MIN', 'HUBZELL_MAX_CONCURRENT', 'PROVIDER_CONCURRENCY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('ร้านแบบจับคู่บริการ: ปิดการจับคู่แพ็กเกจแล้วไม่แสดง/สั่งไม่ได้ + สลับเจ้าไม่ส่งยอดที่เครือข่ายไม่อนุญาต', async () => {
  // ก) ปิดการจับคู่แพ็กเกจ → ร้าน HubZell ไม่แสดงแพ็กเกจนี้ และสั่งผ่านร้านนี้ไม่ได้ (ยังไม่ตัดเงิน)
  assert.equal((await admin.put(`/api/admin/providers/hubzell/mappings/${maps.pkgMap}`, { enabled: false })).status, 200);
  const c = await newCustomer(200);
  try {
    const cat = await c.get('/api/catalog');
    const hz = cat.body.data.shops.find((s) => s.code === 'hubzell');
    assert.equal(hz.product_ids.includes(maps.pkg), false);
    const r = await c.post('/api/orders', { type: 'package', productId: maps.pkg, phone: phone('2009'), idempotencyKey: key(), shop: 'hubzell' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'PRODUCT_NOT_AT_SHOP');
  } finally {
    await admin.put(`/api/admin/providers/hubzell/mappings/${maps.pkgMap}`, { enabled: true });
  }

  // ข) ยอด 25 บาท มีเฉพาะที่ HubZell (เครือข่ายไม่เปิดให้กรอกยอดเอง) → HubZell ไม่รับ → ห้ามส่งต่อเจ้าที่ไม่รองรับยอดนี้ → คืนเงิน
  assert.equal((await admin.put('/api/admin/networks/AIS', { topup_allow_custom: false })).status, 200);
  const m25 = await admin.post('/api/admin/providers/hubzell/mappings', { service_id: 'HZ_AIS_20', kind: 'topup', network_code: 'AIS', face_value_baht: 25, enabled: true });
  assert.equal(m25.status, 201, JSON.stringify(m25.body));
  try {
    fake.state.createOverrides.push({ http: 400, body: envelope('VALIDATION_ERROR') });
    const ref = await topup(c, phone('2010'), 25, { shop: 'hubzell' });
    const o = orderRow(ref);
    assert.equal(o.status, 'failed');
    assert.equal(mockGot(ref), false, 'ห้ามส่งยอดที่เครือข่ายไม่อนุญาตไปเจ้าอื่น');
    assert.equal(refunds(ref), 1);
  } finally {
    await admin.del(`/api/admin/providers/hubzell/mappings/${m25.body.data.id}`);
    await admin.put('/api/admin/networks/AIS', { topup_allow_custom: true });
  }
  assert.deepEqual(wallet.reconcile(), []);
  assert.deepEqual(wallet.reconcileOrders(), []);
});
