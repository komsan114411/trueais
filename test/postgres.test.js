'use strict';
// ฐานข้อมูล PostgreSQL: การแปลง SQL, transaction, สำรอง/กู้คืน, ย้ายข้อมูลจาก SQLite
// ส่วนที่ต้องมีฐานข้อมูลจริงรันเมื่อตั้ง DATABASE_URL เท่านั้น (npm run test:pg)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupEnv } = require('./helpers');

const dataDir = setupEnv();
const { translate } = require('../src/database/postgres');

test('แปลง SQL เป็นแบบ PostgreSQL: ? → $n (ข้ามข้อความในเครื่องหมายคำพูด) / LIKE → ILIKE / INSERT ได้ id กลับ', () => {
  assert.equal(translate('SELECT * FROM users WHERE id = ? AND name = ?'), 'SELECT * FROM users WHERE id = $1 AND name = $2');
  assert.equal(translate("SELECT '?' AS a, \"x?\" FROM t WHERE b = ? -- c?\n AND d = ?"), "SELECT '?' AS a, \"x?\" FROM t WHERE b = $1 -- c?\n AND d = $2");
  assert.equal(translate("SELECT 'it''s ?' FROM t WHERE a = ?"), "SELECT 'it''s ?' FROM t WHERE a = $1");
  assert.equal(translate('SELECT 1 FROM t WHERE name LIKE ? OR phone like ?'), "SELECT 1 FROM t WHERE name ILIKE $1 ESCAPE '' OR phone ILIKE $2 ESCAPE ''");
  assert.equal(translate("SELECT 1 FROM t WHERE note LIKE 'abc%' AND unlike = ?"), "SELECT 1 FROM t WHERE note ILIKE 'abc%' AND unlike = $1");
  assert.equal(translate('INSERT INTO orders (ref) VALUES (?)'), 'INSERT INTO orders (ref) VALUES ($1) RETURNING id');
  assert.equal(translate('INSERT INTO settings (key, value) VALUES (?, ?)'), 'INSERT INTO settings (key, value) VALUES ($1, $2)');
  assert.equal(translate('INSERT INTO orders (ref) VALUES (?) RETURNING ref'), 'INSERT INTO orders (ref) VALUES ($1) RETURNING ref');
});

const pg = Boolean(process.env.DATABASE_URL);
const db = require('../src/db');
const config = require('../src/config');

test('PostgreSQL: transaction — error ย้อนกลับทั้งก้อน / savepoint ย้อนเฉพาะชั้นใน / คำสั่งผิดที่ถูกกลืน error ห้าม commit ครึ่งๆ', { skip: !pg && 'ต้องตั้ง DATABASE_URL (npm run test:pg)' }, () => {
  db.open(config.dbFile);
  assert.equal(db.dialect(), 'postgres');
  const key = (k) => db.get('SELECT value FROM settings WHERE key = ?', k)?.value;
  const put = (k, v) => db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', k, v, db.nowIso());

  assert.throws(() => db.tx(() => { put('_t1', 'a'); throw new Error('stop'); }), /stop/);
  assert.equal(key('_t1'), undefined, 'error → ไม่บันทึกอะไรเลย');

  db.tx(() => {
    put('_t2', 'outer');
    assert.throws(() => db.tx(() => { put('_t3', 'inner'); throw new Error('inner'); }), /inner/);
    put('_t4', 'after');
  });
  assert.equal(key('_t2'), 'outer');
  assert.equal(key('_t3'), undefined, 'ชั้นในย้อนกลับ');
  assert.equal(key('_t4'), 'after', 'ชั้นนอกทำต่อได้หลังชั้นในย้อนกลับ');

  // คำสั่งผิดใน transaction แล้วโค้ดกลืน error ไว้ → PostgreSQL ยกเลิก transaction ทั้งก้อน: ต้องแจ้ง ไม่ใช่เงียบ
  assert.throws(() => db.tx(() => {
    put('_t5', 'x');
    try { db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', '_t2', 'dup', db.nowIso()); } catch { /* กลืน */ }
  }), (e) => ['DB_TX_ABORTED', '25P02'].includes(e.code));
  assert.equal(key('_t5'), undefined);
  // หลังจากนั้นใช้งานต่อได้ปกติ
  put('_t6', 'ok');
  assert.equal(key('_t6'), 'ok');
  assert.throws(() => db.tx(() => Promise.resolve()), /synchronous/);
  // ค่าที่ PostgreSQL ไม่รับ (ตัวเลขเกินช่วง / NaN) = ไม่พบ เหมือน SQLite ไม่ใช่ error ทั้งคำสั่ง
  assert.equal(db.get('SELECT id FROM orders WHERE id = ?', 1e30), undefined);
  assert.equal(db.get('SELECT id FROM orders WHERE id = ?', Number.NaN), undefined);
  assert.equal(db.get('SELECT ? LIKE ? AS m', 'C:\\', '%\\').m, 1, 'ทับขวาเป็นตัวอักษรธรรมดา (ไม่ใช่ตัว escape) เหมือน SQLite');
  assert.equal(db.get('SELECT ? LIKE ? AS m', 'ABC', 'a%').m, 1, 'ไม่สนตัวพิมพ์เล็ก/ใหญ่ เหมือน SQLite');
  for (const k of ['_t2', '_t4', '_t6']) db.run('DELETE FROM settings WHERE key = ?', k);
});

test('PostgreSQL: สำรอง → แก้ข้อมูล → กู้คืน ได้ข้อมูลเดิมครบ และเลขที่ใหม่ต่อจากเดิม', { skip: !pg && 'ต้องตั้ง DATABASE_URL (npm run test:pg)' }, async () => {
  db.open(config.dbFile);
  const transfer = require('../src/database/transfer');
  const now = db.nowIso();
  const uid = Number(db.run("INSERT INTO users (name, phone, password_hash, balance, created_at, updated_at) VALUES ('ทดสอบ สำรอง', '0811111111', 'x', 5000, ?, ?)", now, now).lastInsertRowid);
  db.run("INSERT INTO wallet_ledger (user_id, type, amount, balance_after, note, created_at) VALUES (?, 'adjust', 5000, 5000, 'ยอดตั้งต้น ''quote''', ?)", uid, now);
  const before = {
    users: db.all('SELECT * FROM users ORDER BY id'),
    ledger: db.all('SELECT * FROM wallet_ledger ORDER BY id'),
    products: db.all('SELECT * FROM products ORDER BY id'),
  };
  const file = path.join(dataDir, 'pg-roundtrip.json.gz');
  const r = await db.backupTo(file);
  assert.ok(r.size > 100);
  assert.equal(r.counts.users, before.users.length);

  db.run('UPDATE users SET balance = 0 WHERE id = ?', uid);
  db.run('DELETE FROM wallet_ledger');
  db.run("INSERT INTO users (name, phone, password_hash, created_at, updated_at) VALUES ('หลังสำรอง', '0822222222', 'x', ?, ?)", now, now);

  const res = transfer.restoreBackup(file);
  assert.equal(res.counts.users, before.users.length);
  assert.deepEqual(db.all('SELECT * FROM users ORDER BY id'), before.users);
  assert.deepEqual(db.all('SELECT * FROM wallet_ledger ORDER BY id'), before.ledger);
  assert.deepEqual(db.all('SELECT * FROM products ORDER BY id'), before.products);
  const next = Number(db.run("INSERT INTO users (name, phone, password_hash, created_at, updated_at) VALUES ('ใหม่', '0833333333', 'x', ?, ?)", now, now).lastInsertRowid);
  assert.ok(next > Math.max(...before.users.map((u) => u.id)), 'เลขที่ใหม่ต้องไม่ชนของเดิม');

  // ไฟล์ถูกตัดกลางทาง → ไม่ยอมกู้คืน (ข้อมูลเดิมไม่ถูกแตะ)
  const cut = path.join(dataDir, 'pg-cut.json.gz');
  const lines = require('node:zlib').gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n');
  fs.writeFileSync(cut, require('node:zlib').gzipSync(lines.slice(0, -2).join('\n')));
  assert.throws(() => transfer.restoreBackup(cut), /ไม่สมบูรณ์/);
  assert.ok(db.get('SELECT id FROM users WHERE id = ?', next));
});

test('PostgreSQL: ย้ายข้อมูลจากไฟล์ SQLite เดิม — ครบทุกแถว เลขที่เดิม และไม่แตะไฟล์ต้นฉบับ', { skip: !pg && 'ต้องตั้ง DATABASE_URL (npm run test:pg)' }, () => {
  db.open(config.dbFile);
  const transfer = require('../src/database/transfer');
  const { createSqlite } = require('../src/database/sqlite');
  const { seed } = require('../src/database/seed');
  const file = path.join(dataDir, 'old-local.db');
  const s = createSqlite(file);
  s.migrate();
  const now = new Date().toISOString();
  const shim = { get: (q, ...p) => s.get(q, p), run: (q, ...p) => s.run(q, p) };
  s.tx(() => seed(shim, now));
  s.run("INSERT INTO users (id, name, phone, password_hash, balance, created_at, updated_at) VALUES (41, 'ลูกค้าเดิม', '0844444444', 'h', 1500, ?, ?)", [now, now]);
  s.run("INSERT INTO orders (id, ref, user_id, type, network_code, product_name, phone, face_value, price, cost, status, provider, created_at, updated_at) VALUES (77, 'TPOLD0001', 41, 'topup', 'AIS', 'เติมเงิน AIS 50 บาท', '0844444444', 5000, 5000, 4940, 'success', 'mock', ?, ?)", [now, now]);
  s.run("INSERT INTO wallet_ledger (user_id, type, amount, balance_after, ref_type, ref_id, created_at) VALUES (41, 'order', -5000, 1500, 'order', 77, ?)", [now]);
  s.close();
  const sizeBefore = fs.statSync(file).size;

  const counts = transfer.importSqlite(file);
  assert.equal(counts.users, 1);
  assert.equal(counts.orders, 1);
  assert.equal(counts.products, 12);
  assert.equal(db.get('SELECT name FROM users WHERE id = 41').name, 'ลูกค้าเดิม');
  assert.equal(db.get("SELECT user_id FROM orders WHERE ref = 'TPOLD0001'").user_id, 41);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM wallet_ledger WHERE ref_id = 77').c, 1);
  assert.equal(fs.statSync(file).size, sizeBefore, 'ไม่แตะไฟล์ต้นฉบับ');
  const now2 = db.nowIso();
  const id = Number(db.run("INSERT INTO orders (ref, user_id, type, network_code, product_name, phone, face_value, price, cost, status, provider, created_at, updated_at) VALUES ('TPNEW0001', 41, 'topup', 'AIS', 'x', '0844444444', 1000, 1000, 990, 'pending', 'mock', ?, ?)", now2, now2).lastInsertRowid);
  assert.equal(id, 78, 'เลขที่รายการใหม่ต่อจากของเดิม');
  assert.equal(transfer.hasUsage(), true);
});

test.after(() => db.close());
