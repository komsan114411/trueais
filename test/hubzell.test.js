'use strict';
// ทดสอบ HubZell + ผู้ให้บริการหลายเจ้า + สลับอัตโนมัติ (ใช้ HubZell จำลองที่ตรวจลายเซ็นจริงตามคู่มือ)
// ลำดับ: hubzell (หลัก) → mock (สำรอง)
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setupEnv, Client, waitFor, ADMIN_PASSWORD, CUSTOMER_PASSWORD } = require('./helpers');
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
const providerStatus = require('../src/services/providerStatus');
const hubzell = require('../src/providers/hubzell');

let app;
let base;
let admin;
let fake;
const maps = {};

const balanceOf = (userId) => db.get('SELECT balance FROM users WHERE id = ?', userId).balance;
const orderRow = (ref) => db.get('SELECT * FROM orders WHERE ref = ?', ref);
const attemptsOf = (ref) => db.all('SELECT a.* FROM order_attempts a JOIN orders o ON o.id = a.order_id WHERE o.ref = ? ORDER BY attempt_no', ref);
const mockGot = (ref) => Boolean(db.get('SELECT 1 AS x FROM mock_txns WHERE ref = ?', ref));
const refunds = (ref) => db.get("SELECT COUNT(*) AS c FROM wallet_ledger WHERE type = 'refund' AND ref_type = 'order' AND ref_id = ?", orderRow(ref).id).c;
const key = () => crypto.randomUUID();
let seq = 100;
const phone = (suffix) => `08${String(1000 + seq++).slice(-4)}${suffix}`;
const callbackUrl = () => `${base}/api/provider/callback/hubzell`;

async function newCustomer(credit) {
  const c = new Client(base);
  const r = await c.post('/api/auth/register', { name: 'ลูกค้า HubZell', phone: `09${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`, password: CUSTOMER_PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.user = r.body.data.user;
  if (credit) assert.equal((await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: String(credit), note: 'เครดิตทดสอบ' })).status, 200);
  return c;
}

async function topup(c, ph, amount = 50, network = 'AIS') {
  const r = await c.post('/api/orders', { type: 'topup', network, phone: ph, amount, idempotencyKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  return r.body.data.order.ref;
}

async function poll(ref) {
  db.run('UPDATE orders SET next_check_at = ? WHERE ref = ?', new Date(Date.now() - 1000).toISOString(), ref);
  await orders.pollDue();
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
});

after(async () => {
  await app.close();
  await fake.close();
});

beforeEach(() => {
  breaker.reset();
});

test('ลายเซ็นคำขอ HubZell ตรงตามสูตรในคู่มือ (METHOD\\nPATH\\nTIMESTAMP\\nBODY)', () => {
  const { sign } = hubzell._internal;
  const body = '{"service_id":"X","input":{"mobile":"0812345678"},"client_ref":"TP1"}';
  const expected = crypto.createHmac('sha256', 'sec').update(`POST\n/api/v1/orders/create\n1790000000\n${body}`).digest('hex');
  assert.equal(sign('sec', 'POST', '/api/v1/orders/create', 1790000000, body), expected);
  assert.equal(sign('sec', 'GET', '/api/v1/balance', 1, ''), crypto.createHmac('sha256', 'sec').update('GET\n/api/v1/balance\n1\n').digest('hex'));
  const { detectFormat } = hubzell._internal;
  assert.equal(detectFormat('^0[0-9]{9}$'), 'local');
  assert.equal(detectFormat('^66[0-9]{9}$'), 'intl');
  assert.equal(detectFormat('^[a-z]+$'), null);
});

test('ดึงรายการบริการ HubZell + จับคู่: ใช้ไม่ได้ถ้าต้องกรอกหลายช่อง, รู้รูปแบบเบอร์ 66, ห้ามเปิดจับคู่ที่ขาดทุน', async () => {
  const sync = await admin.post('/api/admin/providers/hubzell/sync', {});
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.ok(sync.body.data.services >= 6);
  assert.equal(fake.state.requests.filter((r) => r.code === 'INVALID_SIGNATURE').length, 0, 'ทุกคำขอต้องลงลายเซ็นถูก');
  const cat = (await admin.get('/api/admin/providers/hubzell/catalog')).body.data;
  const multi = cat.catalog.find((x) => x.service_id === 'HZ_MULTI_1');
  assert.equal(multi.supported, false);
  assert.match(multi.unsupported_reason, /2 ช่อง/);
  assert.equal(cat.catalog.find((x) => x.service_id === 'HZ_TRUE_50').phone_format, 'intl');
  assert.equal(cat.catalog.find((x) => x.service_id === 'HZ_AIS_50').suggestion.network_code, 'AIS');
  assert.equal(cat.catalog.find((x) => x.service_id === 'HZ_AIS_50').suggestion.face_value, 5000);

  for (const [svc, net, amount] of [['HZ_AIS_20', 'AIS', 20], ['HZ_AIS_50', 'AIS', 50], ['HZ_AIS_100', 'AIS', 100], ['HZ_TRUE_50', 'TRUE', 50]]) {
    const m = await admin.post('/api/admin/providers/hubzell/mappings', { service_id: svc, kind: 'topup', network_code: net, face_value_baht: amount, enabled: true });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    maps[svc] = m.body.data.id;
  }
  // ต้นทุน 19.50 แต่ถ้าจับคู่กับยอด 10 บาท (ขาย 10) = ขาดทุน → เปิดไม่ได้
  const loss = await admin.post('/api/admin/providers/hubzell/mappings', { service_id: 'HZ_AIS_20', kind: 'topup', network_code: 'AIS', face_value_baht: 10, enabled: true });
  assert.equal(loss.status, 400);
  assert.equal((await admin.post('/api/admin/providers/hubzell/mappings', { service_id: 'HZ_MULTI_1', kind: 'topup', network_code: 'AIS', face_value_baht: 10 })).status, 400);

  // สร้างแพ็กเกจในระบบจากบริการของ HubZell (ปิดไว้ก่อน) แล้วเปิดขาย
  const made = await admin.post('/api/admin/providers/hubzell/catalog/HZ_AIS_NET_3GB/product', { network_code: 'AIS', price_baht: 19, name: 'เน็ต 3GB 1 วัน (HubZell)' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  maps.pkg = made.body.data.product.id;
  assert.equal(made.body.data.product.enabled, 0);
  assert.equal(made.body.data.product.origin, 'hubzell');
  assert.equal((await admin.put(`/api/admin/products/${maps.pkg}`, { enabled: true })).status, 200);
  const pm = (await admin.get('/api/admin/providers/hubzell/catalog')).body.data.mappings.find((m) => m.product_id === maps.pkg);
  assert.equal((await admin.put(`/api/admin/providers/hubzell/mappings/${pm.id}`, { enabled: true })).status, 200);

  const p = await admin.get('/api/admin/providers');
  assert.deepEqual(p.body.data.providers.map((x) => x.name), ['hubzell', 'mock']);
  assert.equal(p.body.data.providers[0].mappings.enabled, 5);
});

test('ส่งผ่าน HubZell สำเร็จ: ใช้ client_ref = เลขที่รายการ, ต้นทุนเป็นของ HubZell, เบอร์รูปแบบ 66 สำหรับ True', async () => {
  const c = await newCustomer(200);
  const ref = await topup(c, phone('1234'), 50);
  const o = orderRow(ref);
  assert.equal(o.status, 'success');
  assert.equal(o.provider, 'hubzell');
  assert.equal(o.cost, 4875);
  assert.ok(fake.state.orders.has(ref), 'client_ref ต้องเป็นเลขที่รายการของเรา');
  assert.equal(mockGot(ref), false);
  assert.equal(balanceOf(c.user.id), 15000);

  const ph = phone('4321');
  const tref = await topup(c, ph, 50, 'TRUE');
  assert.equal(orderRow(tref).provider, 'hubzell');
  assert.equal(fake.state.orders.get(tref).input.msisdn, `66${ph.slice(1)}`);

  const pkg = await c.post('/api/orders', { type: 'package', productId: maps.pkg, phone: phone('5678'), idempotencyKey: key() });
  assert.equal(pkg.status, 201, JSON.stringify(pkg.body));
  await app.queue.idle();
  const po = orderRow(pkg.body.data.order.ref);
  assert.equal(po.status, 'success');
  assert.equal(po.provider, 'hubzell');
  // รายการเก็บรหัสสินค้าของเรา (ร้านค้าใช้อ้างอิง/ส่งซ้ำได้) — รหัสบริการของ HubZell อยู่ในบันทึกการส่ง
  assert.equal(po.product_code, 'HUBZELL:HZ_AIS_NET_3GB');
  assert.equal(attemptsOf(po.ref)[0].code, 'HZ_AIS_NET_3GB');
  assert.equal(fake.state.orders.get(po.ref).service_id, 'HZ_AIS_NET_3GB');
});

test('HubZell เครดิตไม่พอ → สลับไปเจ้าสำรองอัตโนมัติ (ตัดเงินลูกค้าครั้งเดียว) และพัก HubZell', async () => {
  const c = await newCustomer(200);
  const ref = await topup(c, phone('7001'), 50);
  const o = orderRow(ref);
  assert.equal(o.status, 'success');
  assert.equal(o.provider, 'mock');
  assert.equal(fake.state.orders.has(ref), false, 'HubZell ต้องไม่ได้สร้างรายการ');
  assert.equal(mockGot(ref), true);
  assert.deepEqual(attemptsOf(ref).map((a) => `${a.provider}:${a.state}`), ['hubzell:rejected', 'mock:success']);
  assert.equal(balanceOf(c.user.id), 15000, 'ตัดเงินครั้งเดียว');
  assert.equal(breaker.isOpen('hubzell'), true, 'พัก HubZell หลังเครดิตไม่พอ');
  // รายการถัดไปไม่ยิง HubZell เลย
  const before = fake.createCount();
  const ref2 = await topup(c, phone('1111'), 20);
  assert.equal(fake.createCount(), before);
  assert.equal(orderRow(ref2).provider, 'mock');
});

test('HubZell ปิดปรับปรุง / ข้อมูลไม่ผ่าน / ส่งถี่เกิน → ยังไม่ได้ทำรายการ จึงสลับเจ้าได้', async () => {
  const c = await newCustomer(500);
  for (const sfx of ['7002', '7008', '7009']) {
    breaker.reset();
    const ref = await topup(c, phone(sfx), 50);
    assert.equal(orderRow(ref).status, 'success', sfx);
    assert.equal(orderRow(ref).provider, 'mock', sfx);
    assert.equal(fake.state.orders.has(ref), false, sfx);
  }
  assert.deepEqual(wallet.reconcile(), []);
});

test('HubZell KYC ยังไม่ผ่าน → พักทันที ไม่ยิงซ้ำ (HubZell บล็อก IP ถ้าโดนซ้ำ 5 ครั้ง)', async () => {
  const c = await newCustomer(500);
  const before = fake.createCount();
  await topup(c, phone('7003'), 50);
  assert.equal(fake.createCount() - before, 1);
  for (let i = 0; i < 4; i++) await topup(c, phone('7003'), 20);
  assert.equal(fake.createCount() - before, 1, 'ห้ามยิง HubZell ซ้ำหลังเจอ KYC_NOT_APPROVED');
  assert.match(breaker.snapshot('hubzell').reason, /KYC/);
});

test('HubZell หมดเวลารอ แต่จริงๆ สร้างรายการแล้ว → ห้ามสลับเจ้า ห้ามคืนเงิน → เช็กสถานะแล้วพบว่าสำเร็จ', async () => {
  const c = await newCustomer(200);
  const ref = await topup(c, phone('7005'), 50);
  let o = orderRow(ref);
  assert.equal(o.status, 'processing');
  assert.equal(o.provider, 'hubzell');
  assert.equal(mockGot(ref), false, 'ห้ามส่งเจ้าสำรองตอนไม่รู้ผล');
  assert.equal(refunds(ref), 0);
  await poll(ref);
  o = orderRow(ref);
  assert.equal(o.status, 'success');
  assert.equal(mockGot(ref), false);
  assert.equal(balanceOf(c.user.id), 15000);
});

test('HubZell ตอบ 500 / การเชื่อมต่อหลุดกลางทาง (แต่สร้างรายการแล้ว) → ห้ามสลับเจ้า → เช็กสถานะ', async () => {
  const c = await newCustomer(200);
  for (const sfx of ['7004', '7010']) {
    breaker.reset();
    const ref = await topup(c, phone(sfx), 50);
    assert.equal(orderRow(ref).status, 'processing', sfx);
    assert.equal(mockGot(ref), false, sfx);
    await poll(ref);
    assert.equal(orderRow(ref).status, 'success', sfx);
    assert.equal(mockGot(ref), false, sfx);
  }
  assert.equal(balanceOf(c.user.id), 10000);
});

test('HubZell ตอบ "เลขอ้างอิงซ้ำ" = เคยรับรายการแล้ว → รอผล ไม่คืนเงิน ไม่ส่งเจ้าอื่น', async () => {
  const c = await newCustomer(200);
  const ref = await topup(c, phone('7011'), 50);
  assert.equal(orderRow(ref).status, 'processing');
  assert.equal(mockGot(ref), false);
  await poll(ref);
  assert.equal(orderRow(ref).status, 'success');
});

test('PENDING → callback ลงลายเซ็นถูกต้อง → สำเร็จ / ลายเซ็นผิด หรือเวลาเก่า → ปฏิเสธ', async () => {
  const c = await newCustomer(200);
  const ref = await topup(c, phone('7006'), 50);
  assert.equal(orderRow(ref).status, 'processing');
  assert.equal(await fake.finish(ref, 'SUCCESS', callbackUrl(), { badSignature: true }), 401);
  assert.equal(await fake.finish(ref, 'SUCCESS', callbackUrl(), { staleTs: true }), 400);
  assert.equal(orderRow(ref).status, 'processing');
  assert.equal(await fake.finish(ref, 'SUCCESS', callbackUrl()), 200);
  await waitFor(() => orderRow(ref).status === 'success');
  assert.equal(mockGot(ref), false);
});

test('PENDING → ภายหลังไม่สำเร็จ → คืนเงินครั้งเดียว (รับรายการไปแล้ว จึงไม่สลับเจ้า)', async () => {
  const c = await newCustomer(200);
  const ref = await topup(c, phone('7007'), 50);
  assert.equal(await fake.finish(ref, 'FAILED', callbackUrl()), 200);
  await waitFor(() => orderRow(ref).status === 'failed');
  assert.equal(await fake.finish(ref, 'FAILED', callbackUrl()), 200); // callback ซ้ำ
  assert.equal(refunds(ref), 1);
  assert.equal(mockGot(ref), false);
  assert.equal(balanceOf(c.user.id), 20000);
  // ผลจาก HubZell ทันที (รับรายการแล้วไม่สำเร็จ) ก็ไม่สลับเจ้าเช่นกัน
  const ref2 = await topup(c, phone('0000'), 50);
  assert.equal(orderRow(ref2).status, 'failed');
  assert.equal(mockGot(ref2), false);
  assert.equal(refunds(ref2), 1);
});

test('ยอดที่ HubZell ไม่มีบริการ → ไปเจ้าที่รองรับ / ปิดเจ้าสำรองด้วย → ปฏิเสธก่อนตัดเงิน / ปิดทุกเจ้าไม่ได้', async () => {
  const c = await newCustomer(200);
  const ref = await topup(c, phone('3001'), 30); // HubZell ไม่มีบริการ 30 บาท
  assert.equal(orderRow(ref).provider, 'mock');
  assert.equal(fake.createCount(ref), 0);
  assert.equal((await admin.put('/api/admin/settings', { providers_disabled: 'mock' })).status, 200);
  try {
    const r = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: phone('3002'), amount: 30, idempotencyKey: key() });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'NO_PROVIDER');
    assert.equal(balanceOf(c.user.id), 17000, 'ไม่ตัดเงิน');
    const q = await c.post('/api/orders/quote', { type: 'topup', network: 'AIS', phone: phone('3003'), amount: 30 });
    assert.equal(q.status, 503, 'หน้ายืนยันต้องเตือนก่อน');
    assert.equal((await admin.put('/api/admin/settings', { providers_disabled: 'mock,hubzell' })).status, 400);
    assert.equal((await admin.put('/api/admin/settings', { provider_priority: 'wondd' })).status, 400, 'ชื่อที่ไม่ได้เปิดใช้');
  } finally {
    await admin.put('/api/admin/settings', { providers_disabled: '' });
  }
});

test('เลือกต้นทุนต่ำสุด: แม้ตั้งลำดับ mock ก่อน ระบบเลือก HubZell เพราะต้นทุนถูกกว่า', async () => {
  const c = await newCustomer(300);
  await admin.put('/api/admin/settings', { provider_priority: 'mock,hubzell', routing_mode: 'priority' });
  try {
    assert.equal(orderRow(await topup(c, phone('4001'), 50)).provider, 'mock');
    await admin.put('/api/admin/settings', { routing_mode: 'cheapest' });
    const ref = await topup(c, phone('4002'), 50);
    assert.equal(orderRow(ref).provider, 'hubzell');
    assert.equal(orderRow(ref).cost, 4875);
  } finally {
    await admin.put('/api/admin/settings', { provider_priority: '', routing_mode: 'priority' });
  }
});

test('HubZell ขึ้นราคาเกินราคาขาย → sync แล้วปิดการจับคู่อัตโนมัติ รายการไปเจ้าอื่น (ไม่ขายขาดทุน)', async () => {
  const svc = fake.state.products.HZ_AIS.services.find((s) => s.id === 'HZ_AIS_20');
  svc.price = 25;
  try {
    const sync = await admin.post('/api/admin/providers/hubzell/sync', {});
    assert.equal(sync.status, 200);
    assert.ok(sync.body.data.disabled.some((x) => x.includes('HZ_AIS_20')));
    const c = await newCustomer(100);
    const ref = await topup(c, phone('5001'), 20);
    assert.equal(orderRow(ref).provider, 'mock');
    assert.equal((await admin.put(`/api/admin/providers/hubzell/mappings/${maps.HZ_AIS_20}`, { enabled: true })).status, 400, 'เปิดไม่ได้เพราะขาดทุน');
  } finally {
    svc.price = 19.5;
    await admin.post('/api/admin/providers/hubzell/sync', {});
    await admin.put(`/api/admin/providers/hubzell/mappings/${maps.HZ_AIS_20}`, { enabled: true });
  }
});

test('HubZell ตัดเงินจริงแพงกว่าที่จับคู่ไว้ (ขึ้นราคาระหว่างรอบ sync) → บันทึกต้นทุนจริง ปิดการจับคู่ทันที รายการถัดไปไม่ขาดทุน', async () => {
  const svc = fake.state.products.HZ_AIS.services.find((s) => s.id === 'HZ_AIS_100');
  svc.price = 101; // ขาย 100 บาท แต่ HubZell ตัด 101
  try {
    const c = await newCustomer(300);
    const ref = await topup(c, phone('8801'), 100);
    const o = orderRow(ref);
    assert.equal(o.provider, 'hubzell');
    assert.equal(o.cost, 10100, 'บันทึกต้นทุนจริง');
    const m = db.get('SELECT * FROM provider_map WHERE id = ?', maps.HZ_AIS_100);
    assert.equal(m.enabled, 0, 'ปิดการจับคู่ที่ขาดทุนทันที');
    const ref2 = await topup(c, phone('8802'), 100);
    assert.equal(orderRow(ref2).provider, 'mock', 'รายการถัดไปไปเจ้าอื่น');
  } finally {
    svc.price = 97.5;
    await admin.post('/api/admin/providers/hubzell/sync', {});
    await admin.put(`/api/admin/providers/hubzell/mappings/${maps.HZ_AIS_100}`, { enabled: true });
  }
});

test('key ของ HubZell ผิด (ตรวจตอนเช็กเครดิต) → พัก HubZell ทันที รายการไปเจ้าสำรอง', async () => {
  const saved = config.hubzell.secret;
  config.hubzell.secret = 'wrong-secret';
  try {
    const st = await providerStatus.refreshBalance('hubzell');
    assert.match(st.error, /INVALID_SIGNATURE/);
    assert.equal(breaker.isOpen('hubzell'), true);
  } finally {
    config.hubzell.secret = saved;
  }
  const c = await newCustomer(100);
  const before = fake.createCount();
  const ref = await topup(c, phone('6001'), 50);
  assert.equal(orderRow(ref).provider, 'mock');
  assert.equal(fake.createCount(), before);
  breaker.reset();
  const ok = await providerStatus.refreshBalance('hubzell');
  assert.equal(ok.error, null);
  assert.ok(ok.balance > 0);
});

test('เจ้าที่เคยปฏิเสธ แต่ภายหลังแจ้งว่าสำเร็จ (อาจเติมซ้ำ 2 เจ้า) → ส่งให้แอดมินตรวจทันที', async () => {
  const c = await newCustomer(100);
  const ref = await topup(c, phone('7008'), 50); // HubZell ปฏิเสธ → mock ทำสำเร็จ
  assert.equal(orderRow(ref).provider, 'mock');
  const body = JSON.stringify({ transaction_id: '1', client_ref: ref, status: 'SUCCESS', input: {}, category: 'MOBILE_TOPUP', amount: 48.75, currency: 'THB', message: 'ok' });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', HZ_SECRET).update(`${ts}\n${body}`).digest('hex');
  const r = await fetch(callbackUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hubzell-Timestamp': ts, 'X-Hubzell-Signature': sig }, body });
  assert.equal(r.status, 200);
  const o = orderRow(ref);
  assert.equal(o.needs_review, 1);
  assert.match(o.review_reason, /อาจเติมซ้ำ/);
  assert.equal(o.status, 'success', 'ไม่ขยับเงิน/สถานะเอง');
});

test('ยิงพร้อมกัน 60 รายการ ผลทุกแบบ 2 เจ้า → ไม่มีรายการไหนถูกทำ 2 เจ้า และยอดเงินถูกต้องทุกบาท', async () => {
  const suffixes = ['1201', '1202', '0000', '7001', '7002', '7004', '7005', '7006', '7007', '7008', '7009', '7010', '7011'];
  const customers = await Promise.all([1, 2, 3].map(() => newCustomer(2000)));
  const jobs = [];
  for (let i = 0; i < 60; i++) {
    const c = customers[i % 3];
    const amount = [20, 50, 100, 30][i % 4];
    jobs.push(c.post('/api/orders', { type: 'topup', network: 'AIS', phone: phone(suffixes[i % suffixes.length]), amount, idempotencyKey: key() }));
  }
  const res = await Promise.all(jobs);
  for (const r of res) assert.equal(r.status, 201, JSON.stringify(r.body));
  const refs = res.map((r) => r.body.data.order.ref);
  await app.queue.idle();
  // ปิดงานที่ค้าง: PENDING ที่ HubZell จบผลแบบสุ่ม, ที่เหลือเช็กสถานะ
  for (const ref of refs) {
    const f = fake.state.orders.get(ref);
    if (f && f.status === 'PENDING') await fake.finish(ref, Math.random() < 0.5 ? 'SUCCESS' : 'FAILED', callbackUrl());
  }
  await new Promise((r) => setTimeout(r, 300));
  for (let round = 0; round < 3; round++) {
    db.run("UPDATE orders SET next_check_at = ? WHERE status = 'processing'", new Date(Date.now() - 1000).toISOString());
    await orders.pollDue(200);
  }
  await waitFor(() => refs.every((ref) => ['success', 'failed'].includes(orderRow(ref).status)), { timeout: 8000 });

  for (const ref of refs) {
    const att = attemptsOf(ref);
    const live = att.filter((a) => a.state !== 'rejected');
    assert.ok(live.length <= 1, `${ref}: มีผู้ให้บริการทำรายการได้มากกว่า 1 เจ้า`);
    const atHubzell = fake.state.orders.has(ref);
    const atMock = mockGot(ref);
    assert.ok(!(atHubzell && atMock), `${ref}: ถูกส่งไปทำทั้ง 2 เจ้า`);
    for (const a of att) if (a.provider === 'hubzell' && a.state === 'rejected') assert.equal(atHubzell, false, `${ref}: HubZell สร้างรายการแล้วแต่ระบบสลับเจ้า`);
    const o = orderRow(ref);
    if (o.status === 'success') assert.ok(o.provider === 'hubzell' ? atHubzell : atMock, `${ref}: สำเร็จแต่ไม่มีที่เจ้าที่บันทึก`);
    assert.ok(refunds(ref) <= 1);
  }
  assert.deepEqual(wallet.reconcile(), []);
  assert.deepEqual(wallet.reconcileOrders(), []);
});
