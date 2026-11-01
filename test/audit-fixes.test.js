'use strict';
// ทดสอบจุดที่ผู้ตรวจระบบรอบล่าสุดพบ: แพ็กเกจถูกลบแล้วเลขถูกใช้ซ้ำ, แอดมินยึดบัญชีกัน, สลิปถูกสลับ,
// ข้อความภายในหลุดถึงลูกค้า, ทำรายการซ้ำขณะรายการเดิมยังรอผล, ค่าว่างกลายเป็น 0, query แปลกทำระบบล่ม ฯลฯ
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setupEnv, Client, ADMIN_PASSWORD, CUSTOMER_PASSWORD } = require('./helpers');

setupEnv({ PROVIDERS: 'mock,mock2' });
const { start } = require('../src/server');
const db = require('../src/db');
const wallet = require('../src/services/wallet');
const deposits = require('../src/services/deposits');
const settings = require('../src/services/settings');

let app;
let base;
let admin;

const PNG_BASE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let pngSeq = 1;
const freshPng = () => `data:image/png;base64,${Buffer.concat([PNG_BASE, Buffer.from(`audit-${pngSeq++}`)]).toString('base64')}`;
const key = () => crypto.randomUUID();
let seq = 7000;
const phone = (suffix = '1234') => `08${String(10000 + seq++).slice(-4)}${suffix}`;
const balanceOf = (userId) => db.get('SELECT balance FROM users WHERE id = ?', userId).balance;
const slipVer = async (id) => (await admin.get(`/api/admin/deposits?q=${id}`)).body.data.rows.find((d) => d.id === id)?.slip_ver;
const STAFF_PASSWORD = 'Kitchen-Lamp-74';

async function newCustomer(credit) {
  const c = new Client(base);
  const r = await c.post('/api/auth/register', { name: 'ลูกค้าตรวจระบบ', phone: `09${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`, password: CUSTOMER_PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.user = r.body.data.user;
  if (credit) assert.equal((await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: String(credit), note: 'เครดิตทดสอบ', request_id: key() })).status, 200);
  return c;
}

before(async () => {
  app = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
  admin = new Client(base);
  assert.equal((await admin.post('/api/auth/login', { identifier: 'admin@test.local', password: ADMIN_PASSWORD })).status, 200);
  const s = await admin.put('/api/admin/settings', {
    mock_success_rate: 100, mock_async_rate: 0, mock_callback_delay_sec: 0, mock_timeout_rate: 0,
    daily_limit_baht: 0, order_rate_per_min: 600, duplicate_window_sec: 0, promptpay_id: '0812345678',
  });
  assert.equal(s.status, 200, JSON.stringify(s.body));
});

after(async () => {
  await app.close();
});

test('แพ็กเกจ: ลบแล้วเลขไม่ถูกใช้ซ้ำ + การจับคู่ถูกลบด้วย / ราคาว่างไม่กลายเป็น 0 / แก้รหัส-ลบระหว่างมีรายการค้างไม่ได้', async () => {
  const mk = (code, extra = {}) => admin.post('/api/admin/products', { network_code: 'AIS', provider_code: code, name: `แพ็กเกจ ${code}`, price_baht: '99', cost_baht: '90', ...extra });
  assert.equal((await mk('AUDIT-EMPTY', { cost_baht: '' })).status, 400, 'ต้นทุนว่าง = ไม่ผ่าน');
  assert.equal((await mk('AUDIT-EMPTY2', { price_baht: '   ' })).status, 400, 'ราคาว่าง = ไม่ผ่าน');
  const comma = await mk('AUDIT-COMMA', { price_baht: '1,299', cost_baht: '1,250.50' });
  assert.equal(comma.status, 201, JSON.stringify(comma.body));
  assert.equal(comma.body.data.price, 129900);
  assert.equal(comma.body.data.cost, 125050);

  const a = (await mk('AUDIT-A')).body.data;
  db.run("INSERT INTO provider_map (provider, kind, network_code, product_id, service_id, input_field, phone_format, cost, enabled, updated_at) VALUES ('hubzell', 'package', 'AIS', ?, 'HZ_X', 'mobile', 'local', 1000, 1, ?)", a.id, db.nowIso());
  assert.equal((await admin.del(`/api/admin/products/${a.id}`)).status, 200);
  assert.equal(db.get("SELECT COUNT(*) AS c FROM provider_map WHERE kind = 'package' AND product_id = ?", a.id).c, 0, 'การจับคู่ของแพ็กเกจที่ลบต้องหายไปด้วย');
  const b = (await mk('AUDIT-B')).body.data;
  assert.ok(b.id > a.id, `แพ็กเกจใหม่ต้องไม่ได้เลขเดิม (${a.id})`);

  // รายการค้าง (mock "stuck") → ห้ามลบ/ห้ามแก้รหัส
  assert.equal((await admin.put(`/api/admin/products/${b.id}`, { enabled: true })).status, 200);
  const c = await newCustomer(500);
  const r = await c.post('/api/orders', { type: 'package', productId: b.id, phone: phone('2222'), idempotencyKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  assert.equal((await admin.del(`/api/admin/products/${b.id}`)).body.error.code, 'PRODUCT_IN_USE');
  assert.equal((await admin.put(`/api/admin/products/${b.id}`, { provider_code: 'AUDIT-B2' })).body.error.code, 'PRODUCT_IN_USE');
  assert.equal((await admin.put(`/api/admin/products/${b.id}`, { name: 'แพ็กเกจ AUDIT-B (แก้ชื่อได้)' })).status, 200, 'แก้ชื่อ/ราคายังทำได้');
});

test('เครือข่าย: ช่องส่วนลดว่างไม่กลายเป็น 0% / ลดส่วนลดจนร้านขายต่ำกว่าทุน → ต้องยืนยันก่อน', async () => {
  const empty = await admin.put('/api/admin/networks/DTAC', { customer_discount: '' });
  assert.equal(empty.status, 400);
  // ร้าน B ตั้งส่วนลด DTAC 3% (ทุน 3.25%) → ลดส่วนลดผู้ให้บริการเหลือ 2% = ร้าน B ขายต่ำกว่าทุน
  assert.equal((await admin.put('/api/admin/shops/mock2', { networks: { DTAC: { discount_percent: 3 } } })).status, 200);
  const r = await admin.put('/api/admin/networks/DTAC', { provider_discount: 2 });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'NETWORK_IMPACT');
  assert.ok(r.body.error.details.impacts.some((x) => x.includes('3%')), JSON.stringify(r.body.error.details));
  assert.equal(db.get("SELECT provider_discount_bp FROM networks WHERE code = 'DTAC'").provider_discount_bp, 325, 'ยังไม่บันทึก');
  assert.equal((await admin.put('/api/admin/networks/DTAC', { provider_discount: 2, confirm_impact: true })).status, 200);
  await admin.put('/api/admin/networks/DTAC', { provider_discount: 3.25 });
  await admin.put('/api/admin/shops/mock2', { networks: { DTAC: { inherit: true } } });
  const items = (await admin.get('/api/admin/security')).body.data.items;
  assert.ok(items.every((i) => i.group === 'setup' || i.group === 'security'), 'รายการตรวจต้องมีกลุ่ม');
});

test('แอดมิน: ห้ามเติมเงิน/อนุมัติให้ตัวเอง, แตะบัญชีแอดมินอื่นต้องยืนยันรหัสผ่าน, ยอดใหญ่ต้องยืนยันซ้ำ', async () => {
  const mk = await admin.post('/api/admin/users', { name: 'พนักงาน', email: 'staff@test.local', password: STAFF_PASSWORD, role: 'admin' });
  assert.equal(mk.status, 201, JSON.stringify(mk.body));
  const staffId = mk.body.data.user.id;
  const staff = new Client(base);
  assert.equal((await staff.post('/api/auth/login', { identifier: 'staff@test.local', password: STAFF_PASSWORD })).status, 200);

  const self = await staff.post(`/api/admin/users/${staffId}/adjust`, { amount: '5000', note: 'เติมให้ตัวเอง', request_id: key() });
  assert.equal(self.status, 403);
  assert.equal(self.body.error.code, 'SELF_ACTION');

  const owner = db.get("SELECT id FROM users WHERE email = 'admin@test.local'");
  const noAuth = await staff.post(`/api/admin/users/${owner.id}/password`, { password: 'Taken-Over-123' });
  assert.equal(noAuth.status, 403);
  assert.equal(noAuth.body.error.code, 'REAUTH_REQUIRED');
  const wrong = await staff.post(`/api/admin/users/${owner.id}/password`, { password: 'Taken-Over-123', actor_password: 'not-my-password' });
  assert.equal(wrong.body.error.code, 'REAUTH_FAILED');
  assert.equal((await staff.post(`/api/admin/users/${owner.id}/role`, { role: 'customer' })).body.error.code, 'REAUTH_REQUIRED');
  // ยืนยันรหัสผ่านถูก → ทำได้ (และระบบแจ้งเตือนแอดมินทุกคน)
  const okSuspend = await staff.post(`/api/admin/users/${owner.id}/status`, { status: 'active', actor_password: STAFF_PASSWORD });
  assert.equal(okSuspend.status, 200, JSON.stringify(okSuspend.body));

  // ลูกค้าธรรมดา: ไม่ต้องยืนยันซ้ำ / ยอดใหญ่ต้องยืนยัน / หักเกินยอดบอกชัด
  const c = await newCustomer(0);
  const big = await staff.post(`/api/admin/users/${c.user.id}/adjust`, { amount: '100000', note: 'ปรับยอดทดสอบ', request_id: key() });
  assert.equal(big.status, 409);
  assert.equal(big.body.error.code, 'LARGE_ADJUST');
  assert.equal(balanceOf(c.user.id), 0);
  assert.equal((await staff.post(`/api/admin/users/${c.user.id}/adjust`, { amount: '100000', note: 'ปรับยอดทดสอบ', request_id: key(), confirm_large: true })).status, 200);
  const over = await staff.post(`/api/admin/users/${c.user.id}/adjust`, { amount: '-200000', note: 'หักเกิน', request_id: key(), confirm_large: true });
  assert.equal(over.status, 400);
  assert.match(over.body.error.message, /หักได้สูงสุด/);

  // อนุมัติรายการเติมเงินของตัวเองไม่ได้
  const dep = await staff.post('/api/deposits', { amount: 100, method: 'promptpay' });
  assert.equal(dep.status, 201, JSON.stringify(dep.body));
  assert.equal((await staff.post(`/api/deposits/${dep.body.data.deposit.id}/slip`, { image: freshPng() })).status, 200);
  const own = await staff.post(`/api/admin/deposits/${dep.body.data.deposit.id}/approve`, { slip_ver: await slipVer(dep.body.data.deposit.id) });
  assert.equal(own.status, 403);
  assert.equal(own.body.error.code, 'SELF_ACTION');
  assert.deepEqual(wallet.reconcile(), []);
});

test('เติมเงิน: เปลี่ยนสลิประหว่างแอดมินตรวจ → อนุมัติไม่ได้ / สลิปที่ถูกเปลี่ยนออกใช้กับรายการอื่นไม่ได้ / รายการหมดเวลาเปิดอนุมัติได้เมื่อยืนยัน', async () => {
  const c = await newCustomer(0);
  const d1 = (await c.post('/api/deposits', { amount: 100, method: 'promptpay' })).body.data;
  assert.ok(d1.pay_to?.promptpay_id, 'ลูกค้าเห็นเลขพร้อมเพย์ไว้โอนเอง/คัดลอก');
  const slipA = freshPng();
  assert.equal((await c.post(`/api/deposits/${d1.deposit.id}/slip`, { image: slipA })).status, 200);
  const seen = await slipVer(d1.deposit.id);
  assert.equal((await c.post(`/api/deposits/${d1.deposit.id}/slip`, { image: freshPng() })).status, 200, 'เปลี่ยนสลิปได้ (ส่งรูปผิด)');
  const stale = await admin.post(`/api/admin/deposits/${d1.deposit.id}/approve`, { slip_ver: seen });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'SLIP_CHANGED');
  // สลิป A (ที่ถูกเปลี่ยนออก) เอาไปใช้กับรายการอื่นไม่ได้
  const d2 = (await c.post('/api/deposits', { amount: 200, method: 'promptpay' })).body.data;
  const reuse = await c.post(`/api/deposits/${d2.deposit.id}/slip`, { image: slipA });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error.code, 'SLIP_USED');
  assert.equal((await admin.post(`/api/admin/deposits/${d1.deposit.id}/approve`, { slip_ver: await slipVer(d1.deposit.id) })).status, 200);

  // ค้นหาด้วยยอดเงินที่มีเศษสตางค์ / เบอร์แบบมีขีด
  const amt = (d1.deposit.amount / 100).toFixed(2);
  assert.ok((await admin.get(`/api/admin/deposits?q=${amt}`)).body.data.rows.some((d) => d.id === d1.deposit.id), `ค้นยอด ${amt}`);
  const dashed = c.user.phone.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
  assert.ok((await admin.get(`/api/admin/users?q=${dashed}`)).body.data.rows.some((u) => u.id === c.user.id), 'ค้นเบอร์แบบมีขีด');

  // หมดเวลา (48 ชม.) แล้วเงินเข้ามาทีหลัง → อนุมัติได้เมื่อยืนยัน + ระบุหมายเหตุ
  const d3 = (await c.post('/api/deposits', { amount: 300, method: 'promptpay' })).body.data.deposit;
  db.run('UPDATE deposits SET created_at = ? WHERE id = ?', new Date(Date.now() - 49 * 3600000).toISOString(), d3.id);
  assert.equal(deposits.expireStale(), 1);
  const late = await c.post(`/api/deposits/${d3.id}/slip`, { image: freshPng() });
  assert.match(late.body.error.message, /หมดเวลา/);
  const closed = await admin.post(`/api/admin/deposits/${d3.id}/approve`, {});
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error.code, 'DEPOSIT_CLOSED');
  assert.equal((await admin.post(`/api/admin/deposits/${d3.id}/approve`, { reopen: true })).status, 400, 'ต้องมีหมายเหตุ');
  const reopened = await admin.post(`/api/admin/deposits/${d3.id}/approve`, { reopen: true, no_slip: true, note: 'เงินเข้าบัญชี 10:20 ตรวจแล้ว' });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(balanceOf(c.user.id), d1.deposit.amount + d3.amount);

  // รายการเปิดค้างเกินกำหนด → บอกเลขรายการเดิมให้กลับไปใช้
  for (let i = 0; i < 3; i++) await c.post('/api/deposits', { amount: 50 + i, method: 'promptpay' });
  const limit = await c.post('/api/deposits', { amount: 60, method: 'promptpay' });
  assert.equal(limit.body.error.code, 'DEPOSIT_OPEN_LIMIT');
  assert.ok(Array.isArray(limit.body.error.details.open) && limit.body.error.details.open.length >= 3);
  assert.deepEqual(wallet.reconcile(), []);
});

test('ตั้งค่า: หมายเลขพร้อมเพย์ผิดบันทึกไม่ได้ (+66 แปลงให้) / ตัวเลขว่างไม่กลายเป็น 0 / ทดสอบ QR / ทดสอบแจ้งเตือน', async () => {
  for (const bad of ['081-234-567', '8123456789', 'abc0812345678', '12345678901']) {
    const r = await admin.put('/api/admin/settings', { promptpay_id: bad });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await admin.put('/api/admin/settings', { promptpay_id: '+66812345678' })).status, 200);
  assert.equal(settings.get('promptpay_id'), '0812345678');
  for (const v of [null, '', true]) assert.equal((await admin.put('/api/admin/settings', { duplicate_window_sec: v })).status, 400, JSON.stringify(v));
  const qr = await admin.post('/api/admin/settings/promptpay-test', {});
  assert.equal(qr.status, 200);
  assert.ok(qr.body.data.qr_svg.includes('<svg'));
  assert.equal(qr.body.data.target, '081-234-5678');
  assert.equal((await admin.post('/api/admin/settings/promptpay-test', { promptpay_id: '123' })).status, 400);
  const n = await admin.post('/api/admin/notify/test', {});
  assert.equal(n.status, 200);
  assert.equal(n.body.data.configured, false);
});

test('ลูกค้า: ไม่เห็นหมายเหตุภายในของแอดมิน / ข้อความภายในของผู้ให้บริการ / query แปลกไม่ทำระบบล่ม / วงเงินต่อวันแจ้งตั้งแต่หน้ายืนยัน', async () => {
  const c = await newCustomer(0);
  assert.equal((await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: '300', note: 'ลูกค้าเคยโกง ระวัง', request_id: key() })).status, 200);
  const w = (await c.get('/api/wallet')).body.data;
  const row = w.ledger.rows.find((l) => l.type === 'adjust');
  assert.equal(row.note, 'ปรับยอดโดยผู้ดูแลระบบ');
  assert.equal(row.actor_name, undefined);
  assert.equal(row.request_id, undefined);

  // ร้านทั้งสองไม่รับรายการ (ทุกเจ้าปฏิเสธ) → ลูกค้าเห็นข้อความทั่วไป แอดมินเห็นเหตุผลเต็ม
  settings.setInternal('_mock_balance', 0);
  settings.setInternal('_mock2_balance', 0);
  try {
    const r = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: phone('3456'), amount: 50, idempotencyKey: key() });
    assert.equal(r.status, 201);
    await app.queue.idle();
    const mine = (await c.get(`/api/orders/${r.body.data.order.ref}`)).body.data;
    assert.equal(mine.order.status, 'failed');
    assert.doesNotMatch(mine.order.message, /mock|ผู้ให้บริการทุกเจ้า/);
    for (const e of mine.events) assert.doesNotMatch(e.message, /mock|เครดิต/);
    const adminView = (await admin.get(`/api/admin/orders/${r.body.data.order.ref}`)).body.data.order;
    assert.match(adminView.message, /ผู้ให้บริการทุกเจ้า|เครดิต/);
  } finally {
    settings.setInternal('_mock_balance', 1000000);
    settings.setInternal('_mock2_balance', 1000000);
  }

  assert.equal((await c.get('/api/wallet?type=a&type=b')).status, 200, 'ชื่อ query ซ้ำ ต้องไม่ทำให้ระบบล่ม');
  assert.equal((await admin.get('/api/admin/deposits?status=a&status=b')).status, 200);
  assert.equal((await c.get('/api/orders?from=2026-13-45')).status, 400);
  assert.equal((await c.get('/api/orders?from=2026-02-31')).status, 400);
  assert.equal((await admin.get('/api/admin/reports/sales?from=2026-02-31&to=2026-03-01')).status, 400);

  assert.equal((await admin.post(`/api/admin/users/${c.user.id}/limit`, { daily_limit_baht: 60 })).status, 200);
  const q = await c.post('/api/orders/quote', { type: 'topup', network: 'AIS', phone: phone('4567'), amount: 100 });
  assert.equal(q.status, 403);
  assert.equal(q.body.error.code, 'DAILY_LIMIT');
});

test('ทำรายการซ้ำขณะรายการเดิมยังรอผล (แม้นานเกินช่วงกันซ้ำ) → ต้องยืนยันก่อน', async () => {
  const c = await newCustomer(300);
  const ph = phone('2222'); // mock "stuck" = รอผลตลอด
  const first = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: ph, amount: 50, idempotencyKey: key() });
  assert.equal(first.status, 201);
  await app.queue.idle();
  db.run('UPDATE orders SET created_at = ? WHERE ref = ?', new Date(Date.now() - 3600000).toISOString(), first.body.data.order.ref);
  const q = await c.post('/api/orders/quote', { type: 'topup', network: 'AIS', phone: ph, amount: 50 });
  assert.equal(q.status, 200);
  assert.equal(q.body.data.warning?.waiting, true);
  const again = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: ph, amount: 50, idempotencyKey: key() });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'DUPLICATE_RECENT');
  assert.equal(balanceOf(c.user.id), 25000, 'ตัดเงินครั้งเดียว');
  const confirmed = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: ph, amount: 50, idempotencyKey: key(), confirmDuplicate: true });
  assert.equal(confirmed.status, 201, 'ยืนยันแล้วทำได้');
});

test('API ร้านค้า: TOPUP/AUTO ตัวพิมพ์ใหญ่ได้, reference มีช่องว่างค้นเจอ, ส่งฟอร์มได้ 415, เบอร์ +66 0 ได้', async () => {
  const c = await newCustomer(300);
  const k = await admin.post('/api/admin/api-keys', { user_id: c.user.id, name: 'ร้านตรวจระบบ' });
  const call = (method, url, body, type = 'application/json') => fetch(base + url, {
    method, headers: { Authorization: `Bearer ${k.body.data.api_key}`, 'Content-Type': type }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }).then(async (x) => ({ status: x.status, body: await x.json(), headers: x.headers }));
  const r = await call('POST', '/api/v1/orders', { type: 'TOPUP', network: 'ais', phone: '+66 0899991234', amount: 50, reference: 'AUDIT-REF-001', shop: 'AUTO' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.order.phone, '0899991234');
  assert.equal((await call('GET', '/api/v1/orders?reference=%20AUDIT-REF-001%20')).status, 200);
  const form = await call('POST', '/api/v1/orders', 'type=topup&reference=x', 'application/x-www-form-urlencoded');
  assert.equal(form.status, 415);
  const pkg = await call('POST', '/api/v1/orders', { type: 'package', product_code: 'DEMO-AIS-D3G', phone: '0899991235', reference: 'AUDIT-REF-002' });
  assert.equal(pkg.status, 400);
  assert.equal(pkg.body.error.details.field, 'network');
});

test('สำรองข้อมูล: ดาวน์โหลดได้เฉพาะไฟล์สำรองจริง / กดสำรองบ่อยไม่ดันสำเนารายวันทิ้ง / เซสชันที่ใช้งานอยู่ได้คุกกี้ใหม่', async () => {
  const b = await admin.post('/api/admin/backups', {});
  assert.equal(b.status, 201);
  const dl = await fetch(`${base}/api/admin/backups/${b.body.data.name}/download`, { headers: { Cookie: admin.cookie } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition') || '', /attachment/);
  for (const bad of ['..%2F..%2Fpackage.json', 'topup.db', 'topup-2026-01-01-0000.db']) {
    assert.equal((await fetch(`${base}/api/admin/backups/${bad}/download`, { headers: { Cookie: admin.cookie } })).status, 404, bad);
  }
  // คำขอเบื้องหลังไม่ต่ออายุ / คำขอปกติต่ออายุและส่งคุกกี้ใหม่
  const sess = db.get("SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'admin@test.local' ORDER BY s.created_at DESC LIMIT 1");
  const old = new Date(Date.now() - 20 * 60000).toISOString();
  db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', old, sess.id);
  const bg = await fetch(`${base}/api/admin/dashboard`, { headers: { Cookie: admin.cookie, 'X-Background': '1' } });
  assert.equal(bg.status, 200);
  assert.equal(db.get('SELECT last_seen_at FROM sessions WHERE id = ?', sess.id).last_seen_at, old, 'รีเฟรชอัตโนมัติไม่นับเป็นการใช้งาน');
  const fg = await fetch(`${base}/api/admin/dashboard`, { headers: { Cookie: admin.cookie } });
  assert.equal(fg.status, 200);
  assert.notEqual(db.get('SELECT last_seen_at FROM sessions WHERE id = ?', sess.id).last_seen_at, old);
  assert.match(fg.headers.get('set-cookie') || '', /sid=/, 'ต่ออายุคุกกี้ในเบราว์เซอร์ด้วย');
});
