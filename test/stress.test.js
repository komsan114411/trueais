'use strict';
// ทดสอบหนัก: หลายคนยิงรายการพร้อมกัน + ผลลัพธ์สุ่มทุกแบบ → เงินต้องตรงทุกบาท ไม่คืนซ้ำ ไม่ส่งซ้ำ
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setupEnv, Client, waitFor, ADMIN_PASSWORD, CUSTOMER_PASSWORD } = require('./helpers');

setupEnv();
const { start } = require('../src/server');
const db = require('../src/db');
const orders = require('../src/services/orders');
const wallet = require('../src/services/wallet');

let app;
let base;
let admin;

before(async () => {
  app = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
  admin = new Client(base);
  await admin.post('/api/auth/login', { identifier: 'admin@test.local', password: ADMIN_PASSWORD });
  await admin.put('/api/admin/settings', {
    mock_success_rate: 70, mock_async_rate: 50, mock_callback_delay_sec: 0, mock_timeout_rate: 10,
    daily_limit_baht: 0, order_rate_per_min: 600, breaker_threshold: 100, duplicate_window_sec: 0,
  });
});

after(async () => {
  await app.close();
});

test('ยิงพร้อมกัน 100 รายการ (5 คน × 20) ผลสุ่มทุกแบบ → ยอดเงินถูกต้องทุกบาท', async () => {
  const USERS = 5;
  const PER_USER = 20;
  const CREDIT = 200000; // 2,000 บาท
  const suffixes = ['0000', '1111', '3333', '4444', '5555', '7777', '8888', '9999'];
  const customers = [];
  for (let i = 0; i < USERS; i++) {
    const c = new Client(base);
    const r = await c.post('/api/auth/register', { name: `ลูกค้า ${i}`, phone: `091000000${i}`, password: CUSTOMER_PASSWORD });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    c.user = r.body.data.user;
    await admin.post(`/api/admin/users/${c.user.id}/adjust`, { amount: String(CREDIT / 100), note: 'stress' });
    customers.push(c);
  }

  // ทุกคนยิงพร้อมกัน บางคำขอยิงซ้ำด้วย key เดิม (จำลองกดซ้ำ)
  const jobs = [];
  for (const c of customers) {
    for (let j = 0; j < PER_USER; j++) {
      const key = crypto.randomUUID();
      const body = {
        type: 'topup',
        network: ['AIS', 'TRUE', 'DTAC'][j % 3],
        phone: `08${String(crypto.randomInt(0, 10000)).padStart(4, '0')}${suffixes[crypto.randomInt(0, suffixes.length)]}`,
        amount: [10, 20, 50, 100][crypto.randomInt(0, 4)],
        idempotencyKey: key,
      };
      jobs.push(c.post('/api/orders', body));
      if (j % 5 === 0) jobs.push(c.post('/api/orders', body)); // กดซ้ำ
    }
  }
  const results = await Promise.all(jobs);
  for (const r of results) assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  assert.equal(db.get('SELECT COUNT(*) AS c FROM orders').c, USERS * PER_USER, 'กดซ้ำต้องไม่สร้างรายการเพิ่ม');

  // ให้ระบบทำงานจนทุกรายการได้ผลสุดท้าย (เร่งเวลาเช็กสถานะ)
  await app.queue.idle();
  await waitFor(async () => {
    db.run("UPDATE orders SET next_check_at = ? WHERE status = 'processing'", new Date(Date.now() - 1000).toISOString());
    await orders.pollDue(500);
    return db.get("SELECT COUNT(*) AS c FROM orders WHERE status IN ('pending','processing')").c === 0;
  }, { timeout: 15000, interval: 100 });

  // 1) ยอดในกระเป๋าตรงกับสมุดบัญชีทุกบัญชี
  assert.deepEqual(wallet.reconcile(), []);
  // 2) ยอดคงเหลือ = เครดิต - ยอดรายการที่สำเร็จ
  for (const c of customers) {
    const spent = db.get("SELECT COALESCE(SUM(price), 0) AS s FROM orders WHERE user_id = ? AND status = 'success'", c.user.id).s;
    const bal = db.get('SELECT balance FROM users WHERE id = ?', c.user.id).balance;
    assert.equal(bal, CREDIT - spent, `ยอดของ ${c.user.name} ไม่ตรง`);
  }
  // 3) รายการล้มเหลวคืนเงินครั้งเดียวพอดี / รายการสำเร็จไม่มีการคืนเงิน
  const bad = db.all(`SELECT o.ref, o.status, (SELECT COUNT(*) FROM wallet_ledger l WHERE l.type = 'refund' AND l.ref_id = o.id) AS refunds
                      FROM orders o WHERE (o.status = 'failed' AND refunds != 1) OR (o.status = 'success' AND refunds != 0)`);
  assert.deepEqual(bad, []);
  // 4) ไม่มีรายการไหนถูกส่งไปผู้ให้บริการเกิน 1 ครั้ง
  const multi = db.all("SELECT order_ref, COUNT(*) AS c FROM provider_logs WHERE action = 'submit' GROUP BY order_ref HAVING c > 1");
  assert.deepEqual(multi, []);
  // 5) timeout (…1111) ต้องไม่ถูกคืนเงิน เพราะฝั่งผู้ให้บริการเติมสำเร็จจริง
  const timeoutRefunded = db.get("SELECT COUNT(*) AS c FROM orders WHERE phone LIKE '%1111' AND status != 'success'").c;
  assert.equal(timeoutRefunded, 0);
  const counts = db.all('SELECT status, COUNT(*) AS c FROM orders GROUP BY status');
  assert.ok(counts.find((x) => x.status === 'success')?.c > 0);
  assert.ok(counts.find((x) => x.status === 'failed')?.c > 0);
});
