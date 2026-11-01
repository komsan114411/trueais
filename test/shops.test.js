'use strict';
// ทดสอบ "เลือกร้าน": ลูกค้าเลือกร้านเอง + ราคาแต่ละร้าน + ร้านที่เลือกไม่รับ → ส่งต่อร้านอื่นในราคาเดิม (ไม่ขาดทุน)
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setupEnv, Client, ADMIN_PASSWORD, CUSTOMER_PASSWORD } = require('./helpers');

setupEnv({ PROVIDERS: 'mock,mock2' });
const { start } = require('../src/server');
const db = require('../src/db');
const settings = require('../src/services/settings');
const breaker = require('../src/services/breaker');
const wallet = require('../src/services/wallet');

let app;
let base;
let admin;
const balanceOf = (userId) => db.get('SELECT balance FROM users WHERE id = ?', userId).balance;
const orderRow = (ref) => db.get('SELECT * FROM orders WHERE ref = ?', ref);
const attemptsOf = (ref) => db.all('SELECT a.provider, a.state FROM order_attempts a JOIN orders o ON o.id = a.order_id WHERE o.ref = ? ORDER BY attempt_no', ref).map((a) => `${a.provider}:${a.state}`);
const key = () => crypto.randomUUID();
let seq = 200;
const phone = () => `08${String(10000000 + seq++).slice(-8)}`;

async function newCustomer(credit) {
  const c = new Client(base);
  const r = await c.post('/api/auth/register', { name: 'ลูกค้าเลือกร้าน', phone: `09${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`, password: CUSTOMER_PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.user = r.body.data.user;
  if (credit) assert.equal((await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: String(credit), note: 'เครดิตทดสอบ' })).status, 200);
  return c;
}

before(async () => {
  app = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
  admin = new Client(base);
  assert.equal((await admin.post('/api/auth/login', { identifier: 'admin@test.local', password: ADMIN_PASSWORD })).status, 200);
  await admin.put('/api/admin/settings', {
    mock_success_rate: 100, mock_async_rate: 0, mock_callback_delay_sec: 0, mock_timeout_rate: 0,
    daily_limit_baht: 0, order_rate_per_min: 600, duplicate_window_sec: 0,
  });
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  breaker.reset();
  settings.setInternal('_mock_balance', 1000000);
  settings.setInternal('_mock2_balance', 1000000);
});

test('หน้าเว็บเห็น 2 ร้าน + ตั้งราคาแต่ละร้านได้ (ส่วนลดเกินต้นทุนตั้งไม่ได้)', async () => {
  const cat = (await new Client(base).get('/api/catalog')).body.data;
  assert.deepEqual(cat.shops.map((s) => s.code), ['mock', 'mock2']);
  assert.deepEqual(cat.shops.map((s) => s.name), ['ร้านทดสอบ A', 'ร้านทดสอบ B']);
  assert.equal(cat.shops[0].networks.AIS.amounts, null, 'ร้านแคตตาล็อกหลักเติมได้ทุกยอด');

  // AIS ต้นทุนมีส่วนลด 1.2% → ตั้งส่วนลดลูกค้า 2% ไม่ได้ (ขาดทุน), 1% ได้
  assert.equal((await admin.put('/api/admin/shops/mock2', { networks: { AIS: { discount_percent: 2 } } })).status, 400);
  const ok = await admin.put('/api/admin/shops/mock2', { display_name: 'ร้านประหยัด', networks: { AIS: { discount_percent: 1 } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.name, 'ร้านประหยัด');
  const list = (await admin.get('/api/admin/shops')).body.data;
  const b = list.find((s) => s.code === 'mock2');
  assert.equal(b.networks.find((n) => n.code === 'AIS').discount_percent, 1);
  assert.equal(b.networks.find((n) => n.code === 'AIS').max_percent, 1.2);
  const cat2 = (await new Client(base).get('/api/catalog')).body.data;
  assert.equal(cat2.shops[1].name, 'ร้านประหยัด');
  assert.equal(cat2.shops[1].networks.AIS.discount_bp, 100);
});

test('ลูกค้าเลือกร้าน → ได้ราคาของร้านนั้น และร้านนั้นเป็นคนทำรายการ', async () => {
  const c = await newCustomer(200);
  const qa = await c.post('/api/orders/quote', { type: 'topup', network: 'AIS', phone: phone(), amount: 50, shop: 'mock' });
  const qb = await c.post('/api/orders/quote', { type: 'topup', network: 'AIS', phone: phone(), amount: 50, shop: 'mock2' });
  assert.equal(qa.body.data.price, 5000);
  assert.equal(qb.body.data.price, 4950);
  assert.equal(qb.body.data.shop_name, 'ร้านประหยัด');
  const r = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: phone(), amount: 50, shop: 'mock2', idempotencyKey: key(), expectedPrice: 4950 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  const o = orderRow(r.body.data.order.ref);
  assert.equal(o.shop, 'mock2');
  assert.equal(o.provider, 'mock2');
  assert.equal(o.price, 4950);
  assert.equal(o.status, 'success');
  assert.equal(balanceOf(c.user.id), 20000 - 4950);
  const view = (await c.get(`/api/orders/${o.ref}`)).body.data.order;
  assert.equal(view.shop_name, 'ร้านประหยัด');
  assert.equal(view.handled_by, 'ร้านประหยัด');
});

test('ร้านที่เลือกไม่รับรายการ (เครดิตร้านหมด) → ส่งต่อร้านอื่นอัตโนมัติ ในราคาเดิมที่ลูกค้าตกลง', async () => {
  settings.setInternal('_mock2_balance', 0);
  const c = await newCustomer(200);
  const r = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: phone(), amount: 50, shop: 'mock2', idempotencyKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  const o = orderRow(r.body.data.order.ref);
  assert.equal(o.status, 'success');
  assert.equal(o.shop, 'mock2', 'จำร้านที่ลูกค้าเลือกไว้');
  assert.equal(o.provider, 'mock', 'ร้านอื่นทำรายการแทน');
  assert.equal(o.price, 4950, 'ราคาเดิมที่ลูกค้าตกลง');
  assert.ok(o.cost <= o.price, 'ไม่ขาดทุน');
  assert.deepEqual(attemptsOf(o.ref), ['mock2:rejected', 'mock:success']);
  const view = (await c.get(`/api/orders/${o.ref}`)).body.data.order;
  assert.equal(view.shop_name, 'ร้านประหยัด');
  assert.equal(view.handled_by, 'ร้านทดสอบ A');
  assert.equal(balanceOf(c.user.id), 20000 - 4950);
});

test('ร้านที่เลือกถูกพักชั่วคราว → ระบบส่งร้านสำรองให้เลยในราคาเดิม / ร้านที่ปิดใช้ → เลือกไม่ได้ (ไม่ตัดเงิน)', async () => {
  const c = await newCustomer(200);
  breaker.open('mock2', 60, 'ทดสอบ');
  const r = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: phone(), amount: 50, shop: 'mock2', idempotencyKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  const o = orderRow(r.body.data.order.ref);
  assert.equal(o.provider, 'mock');
  assert.equal(o.price, 4950);
  assert.equal((await new Client(base).get('/api/catalog')).body.data.shops[1].paused, true);
  breaker.reset();

  assert.equal((await admin.put('/api/admin/settings', { providers_disabled: 'mock2' })).status, 200);
  try {
    const x = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: phone(), amount: 50, shop: 'mock2', idempotencyKey: key() });
    assert.equal(x.status, 400);
    assert.equal(x.body.error.code, 'SHOP_UNAVAILABLE');
    assert.equal((await new Client(base).get('/api/catalog')).body.data.shops.length, 1);
  } finally {
    await admin.put('/api/admin/settings', { providers_disabled: '' });
  }
  assert.equal(balanceOf(c.user.id), 20000 - 4950);
});

test('ส่งซ้ำรหัสอ้างอิงเดิมแต่เปลี่ยนร้าน = รายการคนละรายการ (ไม่คืนรายการเดิมผิดราคา)', async () => {
  const c = await newCustomer(200);
  const k = key();
  const ph = phone();
  const a = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: ph, amount: 20, shop: 'mock', idempotencyKey: k });
  assert.equal(a.status, 201);
  const same = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: ph, amount: 20, shop: 'mock', idempotencyKey: k });
  assert.equal(same.status, 200);
  assert.equal(same.body.data.existing, true);
  const other = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: ph, amount: 20, shop: 'mock2', idempotencyKey: k });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'IDEMPOTENCY_MISMATCH');
});

test('เติมหลายรายการเลือกร้านได้ทั้งชุด + API ร้านค้าส่ง shop ได้ + ยอดเงินถูกต้องทุกบาท', async () => {
  const c = await newCustomer(500);
  const items = [1, 2, 3].map(() => ({ type: 'topup', network: 'AIS', phone: phone(), amount: 50 }));
  const r = await c.post('/api/orders/bulk', { items, batchKey: key(), shop: 'mock2' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  for (const o of r.body.data.orders) {
    assert.equal(o.price, 4950);
    assert.equal(orderRow(o.ref).shop, 'mock2');
  }
  const k = await admin.post('/api/admin/api-keys', { user_id: c.user.id, name: 'ร้านทดสอบ API' });
  const call = (method, url, body) => fetch(base + url, {
    method, headers: { Authorization: `Bearer ${k.body.data.api_key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (x) => ({ status: x.status, body: await x.json() }));
  const prods = await call('GET', '/api/v1/products');
  assert.deepEqual(prods.body.data.shops.map((s) => s.code), ['mock', 'mock2']);
  assert.equal(prods.body.data.shops[1].topup.AIS.discount_percent, 1);
  const api = await call('POST', '/api/v1/orders', { type: 'topup', network: 'AIS', phone: phone(), amount: 50, reference: 'SHOP-API-0001', shop: 'mock2', expected_price: 49.5 });
  assert.equal(api.status, 201, JSON.stringify(api.body));
  assert.equal(api.body.data.order.shop, 'mock2');
  assert.equal(api.body.data.order.price, 49.5);
  assert.deepEqual(wallet.reconcile(), []);
  await app.queue.idle();
  assert.deepEqual(wallet.reconcileOrders(), []);
});
