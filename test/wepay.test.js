'use strict';
// ทดสอบร้าน wePAY (ใช้ wePAY จำลอง) — ลำดับ: wepay (หลัก) → mock (สำรอง)
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setupEnv, Client, waitFor, ADMIN_PASSWORD, CUSTOMER_PASSWORD } = require('./helpers');
const { createFakeWepay } = require('./fakeWepay');

const WP_USER = 'wp_test_shop';
const WP_PASS = 'Wp-Test-Pass-2569';
setupEnv({ PROVIDERS: 'wepay,mock', WEPAY_USERNAME: WP_USER, WEPAY_PASSWORD: WP_PASS, PROVIDER_TIMEOUT_MS: '1000', WEPAY_DISCOUNTS: 'AIS:1,DTAC:3,TRUE:3' });
const config = require('../src/config');
const { start } = require('../src/server');
const db = require('../src/db');
const orders = require('../src/services/orders');
const breaker = require('../src/services/breaker');
const providerStatus = require('../src/services/providerStatus');
const wepay = require('../src/providers/wepay');
const { callbackUrl } = require('../src/providers/base');

let app;
let base;
let admin;
let fake;

const orderRow = (ref) => db.get('SELECT * FROM orders WHERE ref = ?', ref);
const balanceOf = (userId) => db.get('SELECT balance FROM users WHERE id = ?', userId).balance;
const mockGot = (ref) => Boolean(db.get('SELECT 1 AS x FROM mock_txns WHERE ref = ?', ref));
const refunds = (ref) => db.get("SELECT COUNT(*) AS c FROM wallet_ledger WHERE type = 'refund' AND ref_type = 'order' AND ref_id = ?", orderRow(ref).id).c;
const states = (ref) => db.all('SELECT a.provider, a.state FROM order_attempts a JOIN orders o ON o.id = a.order_id WHERE o.ref = ? ORDER BY attempt_no', ref).map((a) => `${a.provider}:${a.state}`);
const key = () => crypto.randomUUID();
let seq = 10;
const phone = (suffix) => `08${String(1000 + seq++).slice(-4)}${suffix}`;

async function newCustomer(credit) {
  const c = new Client(base);
  const r = await c.post('/api/auth/register', { name: 'ลูกค้า wePAY', phone: `09${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`, password: CUSTOMER_PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.user = r.body.data.user;
  if (credit) assert.equal((await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: String(credit), note: 'เครดิตทดสอบ' })).status, 200);
  return c;
}

async function topup(c, ph, amount = 50, network = 'AIS', shop = 'wepay') {
  const r = await c.post('/api/orders', { type: 'topup', network, phone: ph, amount, shop, idempotencyKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  return r.body.data.order.ref;
}

const callback = (ref, status, opts) => fake.finish(ref, status, opts);

before(async () => {
  fake = createFakeWepay({ username: WP_USER, password: WP_PASS });
  const port = await fake.listen();
  config.wepay.apiUrl = `http://127.0.0.1:${port}/client_api.json.php`;
  app = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
  config.publicUrl = base; // resp_url ที่ส่งให้ wePAY ชี้มาที่ระบบทดสอบนี้
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

test('แปลงคำตอบ wePAY: รับรายการ / ปฏิเสธแน่นอน (ส่งร้านอื่นได้) / ไม่รู้ผล (ห้ามคืนเงิน ห้ามส่งร้านอื่น)', () => {
  const { interpretSubmit, mapStatus, md5 } = wepay._internal;
  assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  const r = (status, json, extra = {}) => interpretSubmit({ status, json, text: json ? JSON.stringify(json) : extra.text || '', ...extra });
  const ok = r(200, { code: '00000', transaction_id: 123, total_amount: 9.65 });
  assert.equal(ok.outcome, 'processing');
  assert.equal(ok.providerTxnId, '123');
  assert.equal(ok.chargedAmount, 965);
  const poor = r(200, { code: '30019', desc: 'no money' });
  assert.equal(poor.outcome, 'failed');
  assert.equal(poor.retryable, true);
  assert.ok(poor.trip?.seconds > 0, 'เครดิตไม่พอ = พักร้านนี้');
  assert.equal(r(400, { code: '30018' }).outcome, 'failed', 'HTTP 4xx + รหัสปฏิเสธ = ปฏิเสธแน่นอน');
  assert.equal(r(502, { code: '30019' }).outcome, 'unknown', '5xx = ไม่รู้ผลเสมอ');
  assert.equal(r(200, { code: '30019', transaction_id: 5 }).outcome, 'unknown', 'มีเลขที่รายการ = อาจสร้างแล้ว');
  assert.equal(r(200, { code: '00000' }).outcome, 'unknown', 'สำเร็จแต่ไม่มีเลขที่รายการ = ไม่รู้ผล');
  const dup = r(200, { code: '30016' });
  assert.equal(dup.outcome, 'unknown');
  assert.match(dup.review, /30016/);
  assert.equal(r(200, { code: '39999' }).outcome, 'unknown', 'รหัสที่ไม่รู้จัก = ไม่รู้ผล');
  assert.equal(r(200, null, { text: 'ERROR|busy' }).outcome, 'unknown');
  assert.equal(interpretSubmit({ error: 'หมดเวลา', notSent: false }).outcome, 'unknown');
  assert.equal(interpretSubmit({ error: 'ต่อไม่ติด', notSent: true }).notSent, true);
  assert.equal(mapStatus('2'), 'success');
  assert.equal(mapStatus(4), 'failed');
  assert.equal(mapStatus('1'), 'processing');
  assert.equal(mapStatus(''), 'unknown');
});

test('ร้าน wePAY ในหน้าลูกค้า: ช่วงยอดของ wePAY (dtac ไม่เกิน 800) / ไม่ขายแพ็กเกจ / ยอดเกินช่วงถูกปฏิเสธก่อนตัดเงิน', async () => {
  const cat = (await new Client(base).get('/api/catalog')).body.data;
  const shop = cat.shops.find((s) => s.code === 'wepay');
  assert.ok(shop, 'มีร้าน wePAY ให้เลือก');
  assert.equal(shop.name, 'wePAY');
  assert.equal(shop.networks.DTAC.max, 800);
  assert.equal(shop.networks.AIS.max, 1000, 'ไม่เกินช่วงของเครือข่าย (1,000)');
  assert.equal(shop.networks.TRUE.min, 10, 'ไม่ต่ำกว่าช่วงของเครือข่าย (10)');
  assert.deepEqual(shop.product_ids, [], 'wePAY ยังไม่ขายแพ็กเกจ');

  const c = await newCustomer(2000);
  const tooMuch = await c.post('/api/orders', { type: 'topup', network: 'DTAC', phone: phone('1001'), amount: 900, shop: 'wepay', idempotencyKey: key() });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.body.error.code, 'AMOUNT_NOT_AT_SHOP');
  assert.match(tooMuch.body.error.message, /800/);
  assert.equal(balanceOf(c.user.id), 200000, 'ไม่ตัดเงิน');
  const pkg = cat.products?.find?.((p) => p.network === 'AIS') || db.get("SELECT id FROM products WHERE network_code = 'AIS' AND enabled = 1 LIMIT 1");
  const p = await c.post('/api/orders', { type: 'package', productId: pkg.id, phone: phone('1002'), shop: 'wepay', idempotencyKey: key() });
  assert.equal(p.status, 400, JSON.stringify(p.body));
  // ส่วนลดลูกค้าของร้าน wePAY ห้ามเกินเงินคืนที่ wePAY ให้ (ไม่อย่างนั้นขายขาดทุน)
  const s = await admin.put('/api/admin/shops/wepay', { networks: { DTAC: { discount_percent: 3.5 } } });
  assert.equal(s.status, 400);
  assert.match(s.body.error.message, /3%/);
});

test('เติมผ่าน wePAY: รับรายการ → wePAY แจ้งผลกลับ → ระบบเช็กยืนยันก่อน → สำเร็จ (ต้นทุนจริงตาม total_amount)', async () => {
  const c = await newCustomer(500);
  const ref = await topup(c, phone('1003'), 50, 'AIS');
  let o = orderRow(ref);
  assert.equal(o.status, 'processing');
  assert.equal(o.provider, 'wepay');
  assert.ok(o.provider_txn_id);
  assert.equal(o.cost, 4950, 'ต้นทุนจริง = ยอดที่ wePAY ตัด (เงินคืน 1%)');
  const sent = fake.state.requests.find((r) => r.body?.dest_ref === ref).body;
  assert.equal(sent.pay_to_company, '12CALL');
  assert.equal(sent.pay_to_amount, '50');
  assert.equal(sent.pay_to_ref1, o.phone);
  assert.match(sent.resp_url, /\/api\/provider\/callback\/wepay\?t=/);
  assert.equal(sent.password_hash, wepay._internal.md5(WP_PASS));
  assert.equal(sent.password, undefined, 'ไม่ส่งรหัสผ่านตรงๆ');

  const cb = await callback(ref, 2);
  assert.equal(cb.status, 200);
  assert.equal(cb.text, `SUCCEED|ORDER_ID=${ref}`);
  await waitFor(() => orderRow(ref).status === 'success');
  o = orderRow(ref);
  assert.equal(o.price, 5000);
  assert.equal(balanceOf(c.user.id), 45000);
  assert.equal(refunds(ref), 0);
  assert.equal(mockGot(ref), false);
  assert.ok(fake.state.requests.some((r) => r.body?.type === 'get_output'), 'ยืนยันผลกับ wePAY ก่อนบันทึก');
});

test('wePAY แจ้งว่าไม่สำเร็จ → ยืนยันแล้วคืนเงินครั้งเดียว (callback ซ้ำไม่คืนซ้ำ) / callback ไม่มีรหัสลับถูกปฏิเสธ / callback ปลอมไม่ขยับเงิน', async () => {
  const c = await newCustomer(500);
  const ref = await topup(c, phone('9005'), 100, 'TRUE');
  assert.equal(orderRow(ref).status, 'processing');

  // ไม่มีรหัสลับ ?t= → ปฏิเสธ
  const noToken = await fetch(`${base}/api/provider/callback/wepay`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `dest_ref=${ref}&status=4` });
  assert.equal(noToken.status, 401);
  const badToken = await fetch(`${base}/api/provider/callback/wepay?t=abc`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `dest_ref=${ref}&status=4` });
  assert.equal(badToken.status, 401);
  // มีรหัสลับแต่ข้อมูลปลอม (wePAY ยังบอกว่ากำลังทำ) → เช็กแล้วไม่คืนเงิน
  const forged = await fetch(callbackUrl('wepay'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `dest_ref=${ref}&status=4` });
  assert.equal(forged.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(orderRow(ref).status, 'processing');
  assert.equal(refunds(ref), 0);

  await callback(ref, 4);
  await waitFor(() => orderRow(ref).status === 'failed');
  assert.equal(refunds(ref), 1);
  assert.equal(balanceOf(c.user.id), 50000);
  await callback(ref, 4);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(refunds(ref), 1, 'callback ซ้ำไม่คืนเงินซ้ำ');
  assert.equal(mockGot(ref), false, 'ไม่ส่งร้านอื่นหลัง wePAY รับรายการแล้ว');
});

test('wePAY ปฏิเสธแน่นอน (เครดิตไม่พอ / IP ยังไม่ลงทะเบียน) → ส่งร้านสำรองในราคาเดิม + พัก wePAY', async () => {
  const c = await newCustomer(500);
  const ref = await topup(c, phone('9001'), 50, 'AIS');
  let o = orderRow(ref);
  assert.equal(o.provider, 'mock');
  assert.equal(o.status, 'success');
  assert.equal(o.price, 5000, 'ราคาเดิมที่ลูกค้าตกลง');
  assert.deepEqual(states(ref), ['wepay:rejected', 'mock:success']);
  assert.equal(breaker.isOpen('wepay'), true, 'พัก wePAY (เครดิตไม่พอ)');
  // ระหว่างพัก รายการใหม่ไปร้านสำรองทันที (ไม่ยิง wePAY ซ้ำ)
  const before = fake.submits();
  const ref2 = await topup(c, phone('1004'), 50, 'AIS');
  assert.equal(orderRow(ref2).provider, 'mock');
  assert.equal(fake.submits(), before);

  breaker.reset();
  const ref3 = await topup(c, phone('9009'), 20, 'DTAC');
  o = orderRow(ref3);
  assert.equal(o.provider, 'mock');
  assert.deepEqual(states(ref3), ['wepay:rejected', 'mock:success']);
  assert.match(db.get("SELECT message FROM order_attempts WHERE order_id = ? AND provider = 'wepay'", o.id).message, /IP/);
});

test('ไม่รู้ผล (หมดเวลารอ / 500 / ตอบแปลก / ไม่มีเลขที่รายการ) → ไม่คืนเงิน ไม่ส่งร้านอื่น ไม่ส่งซ้ำ / เลขซ้ำ → ส่งให้ตรวจ', async () => {
  const c = await newCustomer(1000);
  for (const suffix of ['9004', '9007', '9008']) {
    const ref = await topup(c, phone(suffix), 20, 'AIS');
    const o = orderRow(ref);
    assert.equal(o.status, 'processing', suffix);
    assert.equal(o.provider, 'wepay', suffix);
    assert.equal(mockGot(ref), false, `${suffix}: ห้ามส่งร้านอื่น`);
    assert.equal(refunds(ref), 0, suffix);
    assert.equal(fake.submits(ref), 1, `${suffix}: ห้ามส่งซ้ำ`);
  }
  const dup = await topup(c, phone('9006'), 20, 'AIS');
  assert.equal(orderRow(dup).needs_review, 1);
  assert.match(orderRow(dup).review_reason, /30016/);

  // หมดเวลารอ แต่ wePAY สร้างรายการแล้ว → รอ callback (มีเลขที่รายการ) → เช็กยืนยัน → สำเร็จ
  const ref = await topup(c, phone('9003'), 50, 'AIS');
  let o = orderRow(ref);
  assert.equal(o.status, 'processing');
  assert.equal(o.provider_txn_id, null);
  db.run('UPDATE orders SET next_check_at = ? WHERE ref = ?', new Date(Date.now() - 1000).toISOString(), ref);
  await orders.pollDue();
  o = orderRow(ref);
  assert.equal(o.status, 'processing', 'ไม่มีเลขที่รายการ = รอผล');
  assert.match(o.provider_message, /รอ wePAY แจ้งผล/);
  await waitFor(() => fake.state.txns.has(ref), { timeout: 3000 });
  await callback(ref, 2);
  await waitFor(() => orderRow(ref).status === 'success');
  assert.equal(fake.submits(ref), 1);
  assert.equal(mockGot(ref), false);
  assert.equal(refunds(ref), 0);
});

test('แดชบอร์ด "พร้อมเปิดร้าน": บอกว่าเชื่อมต่อ wePAY สำเร็จ/ไม่สำเร็จ และคำแนะนำเฉพาะ Railway (IP คงที่ / เวลาปิดระบบ)', async () => {
  const securityCheck = require('../src/services/securityCheck');
  const items = async () => {
    const r = await admin.get('/api/admin/dashboard');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data.security;
  };
  const find = (list, k) => list.find((i) => i.key === k);

  assert.equal((await providerStatus.refreshBalance('wepay')).error, null);
  let list = await items();
  assert.equal(find(list, 'provider_wepay_conn')?.level, 'ok', JSON.stringify(list));
  assert.ok(find(list, 'providers'), 'ร้านพร้อม → มีข้อ "ผู้ให้บริการพร้อมรับรายการ"');
  assert.equal(find(list, 'provider_wepay_discounts'), undefined, 'ตั้ง WEPAY_DISCOUNTS แล้ว → ไม่เตือน');

  const saved = { password: config.wepay.password, platform: config.platform, draining: config.drainingSeconds, discountsSet: config.wepay.discountsSet };
  try {
    // รหัสผ่านผิด → เช็กเครดิตไม่ผ่าน → "ต้องแก้" พร้อมสาเหตุ และไม่ขึ้นว่าร้านพร้อม
    config.wepay.password = 'wrong-password';
    config.platform = 'railway';
    config.drainingSeconds = 0;
    config.wepay.discountsSet = false;
    await providerStatus.refreshBalance('wepay');
    list = await items();
    const conn = find(list, 'provider_wepay_conn');
    assert.equal(conn?.level, 'warn');
    assert.match(conn.message, /รหัสผ่าน/);
    assert.match(conn.message, /Static Outbound IPs/, 'บน Railway บอกให้เปิด IP คงที่');
    assert.equal(find(list, 'providers'), undefined);
    assert.match(find(list, 'provider_wepay_discounts')?.message || '', /คีย์ร้าน/, 'บอกให้ใส่เงินคืนในหลังบ้าน (ไม่ต้องไปแก้ Railway)');
    assert.match(securityCheck.configWarnings().join('\n'), /RAILWAY_DEPLOYMENT_DRAINING_SECONDS=40/);
    config.drainingSeconds = 40;
    assert.doesNotMatch(securityCheck.configWarnings().join('\n'), /RAILWAY_DEPLOYMENT_DRAINING_SECONDS/);
    config.platform = null;
    config.drainingSeconds = 0;
    assert.doesNotMatch(securityCheck.configWarnings().join('\n'), /RAILWAY_DEPLOYMENT_DRAINING_SECONDS/, 'ไม่ได้รันบน Railway → ไม่เตือน');
  } finally {
    Object.assign(config, { platform: saved.platform, drainingSeconds: saved.draining });
    Object.assign(config.wepay, { password: saved.password, discountsSet: saved.discountsSet });
    breaker.reset();
  }
  assert.equal((await providerStatus.refreshBalance('wepay')).error, null);
});

test('ไฟล์หน้าเว็บ (JS/CSS) ให้เบราว์เซอร์ถามใหม่ทุกครั้ง — deploy แล้วไม่ได้ไฟล์เก่าปนใหม่', async () => {
  for (const file of ['/assets/js/app.js', '/assets/js/app/state.js', '/assets/css/app.css']) {
    const r = await fetch(base + file);
    assert.equal(r.status, 200, file);
    assert.equal(r.headers.get('cache-control'), 'no-cache', file);
    const etag = r.headers.get('etag');
    assert.ok(etag, file);
    // ส่งแบบเดียวกับเบราว์เซอร์ตอนถามซ้ำ (fetch ของ Node ใส่ Cache-Control: no-cache ให้เองถ้าไม่ระบุ ซึ่งบังคับให้ส่งไฟล์เต็ม)
    const again = await fetch(base + file, { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
    assert.equal(again.status, 304, `${file} ไม่เปลี่ยน = 304`);
  }
});

test('เครดิต wePAY / รหัสผ่านผิด → พักร้าน (รายการใหม่ไปร้านสำรอง)', async () => {
  const st = await providerStatus.refreshBalance('wepay');
  assert.equal(st.error, null);
  assert.ok(st.balance > 0);
  const saved = config.wepay.password;
  config.wepay.password = 'wrong-password';
  try {
    const bad = await providerStatus.refreshBalance('wepay');
    assert.match(bad.error, /รหัสผ่าน/);
    assert.equal(breaker.isOpen('wepay'), true);
  } finally {
    config.wepay.password = saved;
  }
});
