'use strict';
// ทดสอบการปิดช่องโหว่และระบบกันความผิดพลาดชุดที่ 2 (SSRF, callback ปลอม, ล็อกอิน, 2FA, สลิปซ้ำ, ราคาเปลี่ยน ฯลฯ)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { setupEnv, Client, waitFor, ADMIN_PASSWORD, CUSTOMER_PASSWORD } = require('./helpers');

setupEnv();
const config = require('../src/config');
const { start } = require('../src/server');
const db = require('../src/db');
const orders = require('../src/services/orders');
const users = require('../src/services/users');
const webhooks = require('../src/services/webhooks');
const apikeys = require('../src/services/apikeys');
const totp = require('../src/lib/totp');
const netguard = require('../src/lib/netguard');
const { sendCsv } = require('../src/lib/csv');

let app;
let base;
let admin;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG2 = `data:image/png;base64,${Buffer.concat([Buffer.from(PNG.split(',')[1], 'base64'), Buffer.from([1])]).toString('base64')}`;

const balanceOf = (userId) => db.get('SELECT balance FROM users WHERE id = ?', userId).balance;
const orderRow = (ref) => db.get('SELECT * FROM orders WHERE ref = ?', ref);
const refunds = (orderId) => db.get("SELECT COUNT(*) AS c FROM wallet_ledger WHERE type = 'refund' AND ref_id = ?", orderId).c;
const key = () => crypto.randomUUID();
const randomPhone = () => `09${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
let seq = 3000;
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
    daily_limit_baht: 0, order_rate_per_min: 600, duplicate_window_sec: 0,
  });
});

after(async () => {
  await app.close();
});

test('SSRF: URL ภายใน (localhost, LAN, metadata, IP แปลงรูป) ถูกปฏิเสธทั้งตอนบันทึกและตอนส่งจริง', async () => {
  config.webhookAllowPrivate = false;
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const bad = [
      'http://localhost/x', 'http://127.0.0.1:8080/x', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data',
      'http://[::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/', 'http://192.168.1.10/',
      'http://100.64.0.1/', 'http://user:pass@example.com/', 'https://example.com:22/', 'ftp://example.com/',
      'http://intranet/', 'http://printer.local/', 'http://[fd00::1]/', 'http://0.0.0.0/',
    ];
    for (const u of bad) assert.throws(() => netguard.validatePublicUrl(u), undefined, `ต้องปฏิเสธ ${u}`);
    assert.equal(netguard.validatePublicUrl('https://shop.example.com/hook'), 'https://shop.example.com/hook');
    assert.equal(netguard.validatePublicUrl('https://shop.example.com:8443/hook'), 'https://shop.example.com:8443/hook');
    assert.equal(netguard.isBlockedIp('8.8.8.8'), false);

    const port = srv.address().port;
    assert.equal((await netguard.safePost(`http://127.0.0.1:${port}/`, { body: '{}' })).ok, false);
    assert.equal((await netguard.safePost(`http://localhost:${port}/`, { body: '{}' })).ok, false);

    // webhook ที่ค้างอยู่ในคิวแต่ชี้เข้า IP ภายใน → ส่งไม่ออก
    const c = await newCustomer(100);
    const o = await topup(c, freshPhone('7001'), 20);
    assert.equal(o.status, 201, JSON.stringify(o.body));
    db.run("INSERT INTO webhook_deliveries (order_id, url, event, payload, status, attempts, next_attempt_at, created_at) VALUES (?, ?, 'order.updated', '{}', 'pending', 0, ?, ?)",
      orderRow(o.body.data.order.ref).id, `http://127.0.0.1:${port}/hook`, db.nowIso(), db.nowIso());
    await webhooks.deliverDue();
    const w = db.get('SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT 1');
    assert.equal(w.status, 'pending');
    assert.ok(w.last_error);
    assert.equal(hits, 0, 'ต้องไม่มีการเชื่อมต่อเข้าเครื่องภายในเลย');

    // ผ่าน API: ตั้ง webhook ภายใน / callback_url ภายใน ไม่ได้
    const m = await newCustomer(500);
    const k = await admin.post('/api/admin/api-keys', { user_id: m.user.id, name: 'ร้านทดสอบ', webhook_url: 'http://169.254.169.254/x' });
    assert.equal(k.status, 400);
    const k2 = await admin.post('/api/admin/api-keys', { user_id: m.user.id, name: 'ร้านทดสอบ' });
    assert.equal(k2.status, 201);
    const r = await fetch(`${base}/api/v1/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k2.body.data.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'topup', network: 'AIS', phone: freshPhone('7002'), amount: 50, reference: 'REF-SSRF-0001', callback_url: `http://127.0.0.1:${app.port}/api/admin/users` }),
    });
    assert.equal(r.status, 400);
    assert.equal(db.get('SELECT COUNT(*) AS c FROM orders WHERE user_id = ?', m.user.id).c, 0);
  } finally {
    config.webhookAllowPrivate = true;
    srv.close();
  }
});

test('TRUST_PROXY แบบตัวเลข: เชื่อ X-Forwarded-For เฉพาะเมื่อต่อมาจาก proxy ในเครือข่ายภายใน (คนนอกปลอม IP ไม่ได้)', () => {
  const { parseTrustProxy } = require('../src/http/app');
  const trust = parseTrustProxy('1');
  assert.equal(trust('127.0.0.1', 0), true);
  assert.equal(trust('::ffff:127.0.0.1', 0), true);
  assert.equal(trust('172.17.0.1', 0), true, 'docker bridge');
  assert.equal(trust('8.8.8.8', 0), false, 'ต่อตรงจากอินเทอร์เน็ต → ไม่เชื่อ XFF');
  assert.equal(trust('::ffff:8.8.8.8', 0), false);
  assert.equal(trust('127.0.0.1', 1), false, 'เกินจำนวน proxy ที่ตั้ง');
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
});

test('API key: จำกัด IP แบบช่วง (CIDR) และ IPv6 ได้ ข้อมูลผิดรูปแบบถูกปฏิเสธ', () => {
  assert.equal(apikeys.ipAllowed('203.0.113.0/24', '203.0.113.9'), true);
  assert.equal(apikeys.ipAllowed('203.0.113.0/24', '::ffff:203.0.113.9'), true);
  assert.equal(apikeys.ipAllowed('203.0.113.0/24,198.51.100.7', '198.51.100.7'), true);
  assert.equal(apikeys.ipAllowed('203.0.113.0/24', '10.0.0.1'), false);
  assert.equal(apikeys.ipAllowed('2001:db8::/32', '2001:db8::5'), true);
  assert.throws(() => apikeys.validateIps('300.1.1.1'));
  assert.throws(() => apikeys.validateIps('1.2.3.4/33'));
  assert.equal(apikeys.validateIps(' 1.2.3.4 , 10.0.0.0/8 '), '1.2.3.4,10.0.0.0/8');
});

test('callback ที่ไม่มีลายเซ็น: เช็กสถานะจริงก่อน — callback ปลอม "ไม่สำเร็จ" ไม่ทำให้คืนเงิน', async () => {
  const c = await newCustomer(500);
  const r = await topup(c, freshPhone('2222'), 100); // ค้างสถานะ (processing)
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await app.queue.idle();
  const ref = r.body.data.order.ref;
  assert.equal(orderRow(ref).status, 'processing');
  const balance = balanceOf(c.user.id);
  // ที่ผู้ให้บริการ (จำลอง) เติมสำเร็จแล้วจริง
  db.run("UPDATE mock_txns SET final_status = 'success', message = 'เติมเงินสำเร็จ [จำลอง]', finalize_at = ? WHERE ref = ?", new Date(Date.now() - 1000).toISOString(), ref);
  const res = orders.applyCallback('mock', { ref, outcome: 'failed', message: 'ปลอม', trust: 'token' });
  assert.equal(res.verifying, true);
  await waitFor(() => orderRow(ref).status === 'success');
  assert.equal(refunds(orderRow(ref).id), 0, 'ต้องไม่คืนเงินจาก callback ปลอม');
  assert.equal(balanceOf(c.user.id), balance);
});

test('ผลที่เข้ามาตอนรายการยังไม่ได้ส่ง (pending) → ไม่นำมาใช้', async () => {
  orders.setEnqueue(() => {}); // หยุดส่งชั่วคราว
  let o;
  try {
    const c = await newCustomer(200);
    const r = await topup(c, freshPhone('7101'), 50);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    o = orderRow(r.body.data.order.ref);
    assert.equal(o.status, 'pending');
    orders.applyResult(o.id, { outcome: 'success', message: 'ปลอม' }, 'callback');
    assert.equal(orderRow(o.ref).status, 'pending');
    assert.equal(orders.applyCallback('mock', { ref: o.ref, outcome: 'failed', trust: 'signed' }).ok, false);
    assert.equal(orderRow(o.ref).status, 'pending');
    assert.equal(refunds(o.id), 0);
  } finally {
    orders.setEnqueue((id) => app.queue.push(id));
  }
  app.queue.push(o.id);
  await app.queue.idle();
  assert.equal(orderRow(o.ref).status, 'success');
});

test('ส่งคำขอเดิมซ้ำตอนปิดปรับปรุง → ได้รายการเดิม ไม่ error และไม่ตัดเงินซ้ำ', async () => {
  const c = await newCustomer(200);
  const k = key();
  const phone = freshPhone('7102');
  const first = await topup(c, phone, 50, { idempotencyKey: k });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await admin.put('/api/admin/settings', { maintenance_mode: true });
  try {
    const again = await topup(c, phone, 50, { idempotencyKey: k });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.existing, true);
    assert.equal(again.body.data.order.ref, first.body.data.order.ref);
    const other = await topup(c, freshPhone('7103'), 50);
    assert.equal(other.status, 503);
    // รหัสเดิมแต่ข้อมูลต่าง (เปลี่ยนเครือข่าย) → ไม่ใช่คำขอเดิม
    const changed = await c.post('/api/orders', { type: 'topup', network: 'DTAC', phone, amount: 50, idempotencyKey: k });
    assert.notEqual(changed.status, 200);
  } finally {
    await admin.put('/api/admin/settings', { maintenance_mode: false });
  }
  const changed = await c.post('/api/orders', { type: 'topup', network: 'DTAC', phone, amount: 50, idempotencyKey: k });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, 'IDEMPOTENCY_MISMATCH');
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders WHERE user_id = ?', c.user.id).c, 1);
});

test('ราคาเปลี่ยนหลังลูกค้าเห็นราคา → ไม่ตัดเงิน ต้องยืนยันใหม่', async () => {
  const before = (await admin.get('/api/admin/networks')).body.data.find((n) => n.code === 'DTAC');
  await admin.put('/api/admin/networks/DTAC', { customer_discount: 2 });
  try {
    const c = await newCustomer(500);
    const phone = freshPhone('7104');
    const q = await c.post('/api/orders/quote', { type: 'topup', network: 'DTAC', phone, amount: 100 });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const seen = q.body.data.price;
    assert.equal(seen, 9800);
    await admin.put('/api/admin/networks/DTAC', { customer_discount: 0 });
    const r = await c.post('/api/orders', { type: 'topup', network: 'DTAC', phone, amount: 100, idempotencyKey: key(), expectedPrice: seen });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'PRICE_CHANGED');
    assert.equal(balanceOf(c.user.id), 50000, 'ต้องไม่ตัดเงิน');
    const ok = await c.post('/api/orders', { type: 'topup', network: 'DTAC', phone, amount: 100, idempotencyKey: key(), expectedPrice: 10000 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  } finally {
    await admin.put('/api/admin/networks/DTAC', { customer_discount: before.customer_discount_bp / 100 });
  }
});

test('ล็อกอินผิด 5 ครั้ง: ล็อกเฉพาะ IP นั้น (เจ้าของที่ IP อื่นยังเข้าได้) และบัญชีที่ไม่มีจริงก็ถูกล็อกเหมือนกัน', async () => {
  const c = await newCustomer();
  const id = c.user.phone;
  for (let i = 0; i < 5; i++) {
    await assert.rejects(users.login({ identifier: id, password: 'Wrong-pass1' }, { ip: '198.51.100.1' }), { code: 'INVALID_CREDENTIALS' });
  }
  await assert.rejects(users.login({ identifier: id, password: CUSTOMER_PASSWORD }, { ip: '198.51.100.1' }), { code: 'ACCOUNT_LOCKED' });
  const ok = await users.login({ identifier: id, password: CUSTOMER_PASSWORD }, { ip: '203.0.113.50' });
  assert.ok(ok.token, 'เจ้าของบัญชีจาก IP อื่นต้องเข้าได้');

  for (let i = 0; i < 5; i++) {
    await assert.rejects(users.login({ identifier: 'nobody@example.com', password: 'Wrong-pass1' }, { ip: '198.51.100.2' }), { code: 'INVALID_CREDENTIALS' });
  }
  await assert.rejects(users.login({ identifier: 'nobody@example.com', password: 'Wrong-pass1' }, { ip: '198.51.100.2' }), { code: 'ACCOUNT_LOCKED' });
});

test('ผิดรวม 30 ครั้งจากหลาย IP → ล็อกทั้งบัญชี แต่ IP ที่เจ้าของเคยเข้าสำเร็จยังเข้าได้', async () => {
  const c = await newCustomer();
  const id = c.user.phone;
  await users.login({ identifier: id, password: CUSTOMER_PASSWORD }, { ip: '203.0.113.77' });
  for (let i = 0; i < 30; i++) {
    await assert.rejects(users.login({ identifier: id, password: 'Wrong-pass1' }, { ip: `198.51.100.${20 + Math.floor(i / 4)}` }));
  }
  await assert.rejects(users.login({ identifier: id, password: CUSTOMER_PASSWORD }, { ip: '192.0.2.200' }), { code: 'ACCOUNT_LOCKED' });
  const ok = await users.login({ identifier: id, password: CUSTOMER_PASSWORD }, { ip: '203.0.113.77' });
  assert.ok(ok.token);
});

test('เปลี่ยนรหัสผ่าน: ใส่รหัสปัจจุบันผิด 5 ครั้ง → ออกจากระบบเครื่องนั้นทันที', async () => {
  const c = await newCustomer();
  for (let i = 0; i < 4; i++) {
    const r = await c.post('/api/auth/change-password', { currentPassword: 'Wrong-pass1', newPassword: 'Brand-New-Pass2' });
    assert.equal(r.status, 400);
  }
  const last = await c.post('/api/auth/change-password', { currentPassword: 'Wrong-pass1', newPassword: 'Brand-New-Pass2' });
  assert.equal(last.status, 401);
  assert.equal((await c.get('/api/auth/me')).body.data.user, null);
});

test('รหัสผ่านที่เดาง่าย / มีเบอร์ตัวเอง ถูกปฏิเสธตอนสมัคร', async () => {
  for (const pw of ['Password123', 'Test12345', 'abcd1234', 'aaaaaaa1', 'Admin12345']) {
    const r = await new Client(base).post('/api/auth/register', { name: 'ทดสอบ', phone: randomPhone(), password: pw });
    assert.equal(r.status, 400, pw);
  }
  const phone = randomPhone();
  const r = await new Client(base).post('/api/auth/register', { name: 'ทดสอบ', phone, password: `Xy${phone}` });
  assert.equal(r.status, 400);
});

test('ยืนยันตัวตน 2 ชั้น: เปิดใช้ → ล็อกอินต้องใส่รหัส 6 หลัก → ใช้รหัสซ้ำไม่ได้ → ปิดได้', async () => {
  const c = await newCustomer();
  assert.equal((await c.post('/api/auth/2fa/setup', { password: 'Wrong-pass1' })).status, 400);
  const s = await c.post('/api/auth/2fa/setup', { password: CUSTOMER_PASSWORD });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const { secret } = s.body.data;
  assert.match(s.body.data.otpauth_url, /^otpauth:\/\/totp\//);
  assert.ok(s.body.data.qr_svg.includes('<svg'));
  const step = totp.currentStep();
  const good = totp.codeAt(secret, step);
  const wrong = String((Number(good) + 500000) % 1000000).padStart(6, '0');
  assert.equal((await c.post('/api/auth/2fa/enable', { code: wrong })).status, 400);
  const en = await c.post('/api/auth/2fa/enable', { code: good });
  assert.equal(en.status, 200, JSON.stringify(en.body));
  assert.equal(en.body.data.user.two_factor, true);

  const d = new Client(base);
  const l1 = await d.post('/api/auth/login', { identifier: c.user.phone, password: CUSTOMER_PASSWORD });
  assert.equal(l1.status, 200);
  assert.equal(l1.body.data.mfa_required, true);
  assert.equal(l1.body.data.user, null);
  assert.equal((await d.get('/api/auth/me')).body.data.user, null, 'ยังไม่ได้เซสชันจนกว่าจะใส่รหัส');
  const replay = await d.post('/api/auth/login/verify', { mfa_token: l1.body.data.mfa_token, code: good });
  assert.equal(replay.status, 401, 'รหัสที่ใช้เปิดระบบไปแล้วใช้ซ้ำไม่ได้');
  const next = totp.codeAt(secret, step + 1);
  const v = await d.post('/api/auth/login/verify', { mfa_token: l1.body.data.mfa_token, code: next });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await d.get('/api/auth/me')).body.data.user.id, c.user.id);

  const e = new Client(base);
  const l2 = await e.post('/api/auth/login', { identifier: c.user.phone, password: CUSTOMER_PASSWORD });
  assert.equal((await e.post('/api/auth/login/verify', { mfa_token: l2.body.data.mfa_token, code: next })).status, 401, 'กันดักรหัสไปใช้ซ้ำ');
  assert.equal((await e.post('/api/auth/login/verify', { mfa_token: 'x'.repeat(43), code: next })).status, 401);

  db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step - 5, c.user.id); // จำลองว่าเวลาผ่านไปแล้ว
  const off = await d.post('/api/auth/2fa/disable', { password: CUSTOMER_PASSWORD, code: totp.codeAt(secret, totp.currentStep()) });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.data.user.two_factor, false);
  const l3 = await new Client(base).post('/api/auth/login', { identifier: c.user.phone, password: CUSTOMER_PASSWORD });
  assert.equal(l3.body.data.user.id, c.user.id);
});

test('แอดมินรีเซ็ตการยืนยัน 2 ชั้นให้ลูกค้า (เช่น โทรศัพท์หาย) ได้ และลูกค้าถูกออกจากระบบทุกเครื่อง', async () => {
  const c = await newCustomer();
  const s = await c.post('/api/auth/2fa/setup', { password: CUSTOMER_PASSWORD });
  assert.equal((await c.post('/api/auth/2fa/enable', { code: totp.codeAt(s.body.data.secret, totp.currentStep()) })).status, 200);
  const r = await admin.post(`/api/admin/users/${c.user.id}/2fa/reset`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.user.two_factor, false);
  assert.equal((await c.get('/api/auth/me')).body.data.user, null);
  const l = await new Client(base).post('/api/auth/login', { identifier: c.user.phone, password: CUSTOMER_PASSWORD });
  assert.equal(l.body.data.user.id, c.user.id);
});

test('อุปกรณ์ที่เข้าสู่ระบบ: ดูรายการ ออกจากระบบรายเครื่อง และออกจากทุกเครื่องได้', async () => {
  const c = await newCustomer();
  const other = new Client(base);
  await other.post('/api/auth/login', { identifier: c.user.phone, password: CUSTOMER_PASSWORD });
  const list = await c.get('/api/auth/sessions');
  assert.equal(list.body.data.sessions.length, 2);
  assert.equal(list.body.data.sessions.filter((s) => s.current).length, 1);
  const notCurrent = list.body.data.sessions.find((s) => !s.current);
  assert.equal((await c.del(`/api/auth/sessions/${notCurrent.id}`)).status, 200);
  assert.equal((await other.get('/api/auth/me')).body.data.user, null);

  const third = new Client(base);
  await third.post('/api/auth/login', { identifier: c.user.phone, password: CUSTOMER_PASSWORD });
  const rv = await c.post('/api/auth/sessions/revoke-others', {});
  assert.equal(rv.body.data.revoked, 1);
  assert.equal((await third.get('/api/auth/me')).body.data.user, null);
  assert.equal((await c.get('/api/auth/me')).body.data.user.id, c.user.id);
});

test('เซสชัน: แอดมินไม่ได้ใช้งานเกินกำหนดต้องล็อกอินใหม่ และทุกเซสชันมีอายุสูงสุด', async () => {
  const email = `admin2-${Date.now()}@test.local`;
  const cr = await admin.post('/api/admin/users', { name: 'แอดมินสอง', email, password: 'Second-Admin-77', role: 'admin' });
  assert.equal(cr.status, 201, JSON.stringify(cr.body));
  const a2 = new Client(base);
  await a2.post('/api/auth/login', { identifier: email, password: 'Second-Admin-77' });
  assert.equal((await a2.get('/api/admin/dashboard')).status, 200);
  db.run('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?', new Date(Date.now() - 13 * 3600000).toISOString(), cr.body.data.user.id);
  assert.equal((await a2.get('/api/admin/dashboard')).status, 401);

  const c = await newCustomer();
  db.run('UPDATE sessions SET created_at = ? WHERE user_id = ?', new Date(Date.now() - 31 * 86400000).toISOString(), c.user.id);
  assert.equal((await c.get('/api/auth/me')).body.data.user, null);
});

test('ตั้งค่า/รายงาน/แบ่งหน้า: ชื่อแปลก (__proto__, toString) ค่าไม่ใช่จำนวนเต็ม และเลขหน้าใหญ่เกิน ไม่ทำให้ระบบพัง', async () => {
  assert.equal((await admin.put('/api/admin/settings', { toString: 'x' })).status, 400);
  const raw = await fetch(`${base}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf, 'Content-Type': 'application/json' },
    body: '{"__proto__": {"maintenance_mode": true}}',
  });
  assert.equal(raw.status, 400);
  assert.equal((await admin.put('/api/admin/settings', { duplicate_window_sec: 1.5 })).status, 400);
  assert.equal(db.get("SELECT COUNT(*) AS c FROM settings WHERE key IN ('toString','__proto__','constructor')").c, 0);
  assert.equal((await admin.get('/api/admin/reports/sales?group=constructor')).status, 400);
  assert.equal((await admin.get('/api/admin/reports/sales?from=2026-13-45')).status, 400);
  assert.equal((await admin.get('/api/admin/reports/sales?group=network&from=2026-01-01&to=2026-01-31')).status, 200);
  assert.equal((await admin.get('/api/admin/orders?page=1e400')).status, 200);
  assert.equal((await admin.get('/api/admin/orders?page=100000000000000000000000')).status, 200);
});

test('สลิปใบเดียวใช้ซ้ำไม่ได้ + อนุมัติยอดต่างจากที่แจ้งต้องระบุเหตุผล + ยอดเกินสูงสุดถูกปฏิเสธ', async () => {
  await admin.put('/api/admin/settings', { promptpay_id: '0812345678' });
  const c = await newCustomer();
  const d1 = (await c.post('/api/deposits', { amount: 100, method: 'promptpay' })).body.data.deposit;
  const d2 = (await c.post('/api/deposits', { amount: 200, method: 'promptpay' })).body.data.deposit;
  assert.equal((await c.post(`/api/deposits/${d1.id}/slip`, { image: PNG })).status, 200);
  const dup = await c.post(`/api/deposits/${d2.id}/slip`, { image: PNG });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'SLIP_USED');

  assert.equal((await admin.post(`/api/admin/deposits/${d1.id}/approve`, { amount: '1000' })).status, 400, 'ยอดต่างต้องมีเหตุผล');
  assert.equal((await admin.post(`/api/admin/deposits/${d1.id}/approve`, { amount: '999999', note: 'ทดสอบยอดเกิน' })).status, 400);
  const ok = await admin.post(`/api/admin/deposits/${d1.id}/approve`, { amount: '100', note: 'ลูกค้าโอนเลขกลม' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(balanceOf(c.user.id), 10000);
  assert.equal((await c.post(`/api/deposits/${d2.id}/slip`, { image: PNG })).status, 409, 'สลิปที่อนุมัติแล้วใช้ซ้ำไม่ได้');

  // สลิปของรายการที่ถูกปฏิเสธ แนบใหม่ได้ แต่แอดมินเห็นคำเตือน
  assert.equal((await c.post(`/api/deposits/${d2.id}/slip`, { image: PNG2 })).status, 200);
  assert.equal((await admin.post(`/api/admin/deposits/${d2.id}/reject`, { note: 'ไม่พบยอดโอน' })).status, 200);
  const d3 = (await c.post('/api/deposits', { amount: 300, method: 'promptpay' })).body.data.deposit;
  assert.equal((await c.post(`/api/deposits/${d3.id}/slip`, { image: PNG2 })).status, 200);
  const row = (await admin.get('/api/admin/deposits?status=waiting')).body.data.rows.find((x) => x.id === d3.id);
  assert.equal(row.slip_dup_of, d2.id);
});

test('ดึงรายการแพ็กเกจ: ต้นทุนใหม่สูงกว่าราคาขาย → ปิดขายอัตโนมัติ และเปิดขายเองโดยไม่แก้ราคาไม่ได้', async () => {
  const mock = require('../src/providers/mock');
  const prod = db.get("SELECT * FROM products WHERE network_code = 'AIS' AND is_demo = 1 ORDER BY id LIMIT 1");
  const savedCap = mock.capabilities.products;
  mock.capabilities.products = true;
  mock.listProducts = async () => ({
    ok: true,
    products: [{ networkCode: 'AIS', providerCode: prod.provider_code, name: prod.name, price: prod.price, cost: prod.price + 500, validityDays: 30 }],
  });
  try {
    const r = await admin.post('/api/admin/products/sync', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.disabled, 1);
    const p = db.get('SELECT * FROM products WHERE id = ?', prod.id);
    assert.equal(p.enabled, 0);
    assert.equal(p.cost, prod.price + 500);
    assert.equal((await admin.put(`/api/admin/products/${prod.id}`, { enabled: true })).status, 400);
    const cat = await new Client(base).get('/api/catalog');
    assert.equal(cat.body.data.products.some((x) => x.id === prod.id), false);
  } finally {
    mock.capabilities.products = savedCap;
    delete mock.listProducts;
    db.run('UPDATE products SET cost = ?, enabled = ?, is_demo = ? WHERE id = ?', prod.cost, prod.enabled, prod.is_demo, prod.id);
  }
});

test('HTTP: ไม่รับข้อมูลแบบฟอร์ม, ปฏิเสธคำขอข้ามเว็บ, มี security header, health ตรวจฐานข้อมูล, ชื่อไฟล์ CSV ปลอดภัย', async () => {
  const h = await fetch(`${base}/api/health`);
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('cross-origin-resource-policy'), 'same-origin');
  const form = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `identifier=admin%40test.local&password=${encodeURIComponent(ADMIN_PASSWORD)}`,
  });
  assert.equal(form.status, 400, 'ต้องไม่รับข้อมูลแบบฟอร์ม HTML');
  const xs = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ identifier: 'admin@test.local', password: ADMIN_PASSWORD }),
  });
  assert.equal(xs.status, 403);

  const set = {};
  sendCsv({ setHeader: (k, v) => { set[k] = v; }, send: () => {} }, 'sales-"x"\r\n-ไทย.csv', [{ label: 'a', key: 'a' }], []);
  assert.match(set['Content-Disposition'], /^attachment; filename="[A-Za-z0-9._-]+"$/);

  const sec = await admin.get('/api/admin/security');
  assert.equal(sec.status, 200);
  assert.ok(sec.body.data.items.some((i) => /2 ชั้น/.test(i.message)), 'ต้องแนะนำให้แอดมินเปิด 2FA');
});
