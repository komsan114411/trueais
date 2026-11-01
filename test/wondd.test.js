'use strict';
// โหมดจริง (PROVIDER=wondd) แต่ยังตั้งค่าไม่ครบ → ต้องไม่รับรายการ ไม่ตัดเงิน และไม่ขายแพ็กเกจตัวอย่าง
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, Client, ADMIN_PASSWORD, CUSTOMER_PASSWORD } = require('./helpers');

setupEnv({ PROVIDER: 'wondd' });
const { start } = require('../src/server');
const db = require('../src/db');

let app;
let base;
let admin;

before(async () => {
  app = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
  admin = new Client(base);
  await admin.post('/api/auth/login', { identifier: 'admin@test.local', password: ADMIN_PASSWORD });
});

after(async () => {
  await app.close();
});

test('ยังตั้งค่า WonDD ไม่ครบ → ปฏิเสธรายการก่อนตัดเงิน', async () => {
  const c = new Client(base);
  const reg = await c.post('/api/auth/register', { name: 'ลูกค้า', phone: '0898765432', password: CUSTOMER_PASSWORD });
  assert.equal(reg.status, 201);
  await admin.post(`/api/admin/users/${reg.body.data.user.id}/adjust`, { amount: '500', note: 'ทดสอบ' });
  const r = await c.post('/api/orders', { type: 'topup', network: 'AIS', phone: '0812345678', amount: 100, idempotencyKey: 'test-key-0001' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'PROVIDER_NOT_READY');
  assert.equal(db.get('SELECT balance FROM users WHERE id = ?', reg.body.data.user.id).balance, 50000);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders').c, 0);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM provider_logs').c, 0, 'ต้องไม่มีการเรียก WonDD เลย');
});

test('โหมดจริงต้องไม่แสดง/ไม่ขายแพ็กเกจตัวอย่าง และหน้าแอดมินแจ้งสิ่งที่ขาด', async () => {
  const cat = await new Client(base).get('/api/catalog');
  assert.equal(cat.body.data.mode.live, true);
  assert.equal(cat.body.data.mode.ready, false);
  assert.equal(cat.body.data.products.length, 0, 'แพ็กเกจตัวอย่างต้องถูกซ่อน');
  const p = await admin.get('/api/admin/provider');
  assert.equal(p.body.data.live, true);
  assert.equal(p.body.data.config.ready, false);
  assert.ok(p.body.data.config.missing.length >= 2);
  // URL สำหรับตั้งที่ WonDD ต้องมีรหัสลับ ?t=... ต่อท้าย
  assert.match(p.body.data.callback_url, /\/api\/provider\/callback\/wondd\?t=[a-f0-9]{40}$/);
});

test('callback ของ WonDD ที่ไม่มีการยืนยันตัวตน (ไม่มีรหัส/ลายเซ็น/IP) → ปฏิเสธ', async () => {
  const forged = await fetch(`${base}/api/provider/callback/wondd`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'ref=TPXXXX&status=failed',
  });
  assert.equal(forged.status, 401);
  const wrong = await fetch(`${base}/api/provider/callback/wondd?t=${'0'.repeat(40)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'ref=TPXXXX&status=failed',
  });
  assert.equal(wrong.status, 401);
  const log = db.get("SELECT * FROM provider_logs WHERE action = 'callback' ORDER BY id DESC LIMIT 1");
  assert.ok(log.error, 'ต้องบันทึกว่าถูกปฏิเสธ');
  assert.doesNotMatch(log.url, /0{40}/, 'ห้ามบันทึกรหัสลับลง log');
});

test('callback ของ WonDD ก่อนยืนยันคู่มือ (มีรหัสถูกต้อง) → บันทึก log แต่ไม่ขยับเงิน', async () => {
  const { callbackToken } = require('../src/providers/base');
  const res = await fetch(`${base}/api/provider/callback/wondd?t=${callbackToken('wondd')}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'ref=TPXXXX&status=success',
  });
  assert.equal(res.status, 200);
  const log = db.get("SELECT * FROM provider_logs WHERE action = 'callback' ORDER BY id DESC LIMIT 1");
  assert.equal(log.outcome, 'unknown');
  assert.match(log.url, /t=\*\*\*/, 'รหัสลับใน URL ต้องถูกซ่อนใน log');
});
