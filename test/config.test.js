'use strict';
// การอ่าน .env / ตรวจค่าตั้ง / ข้อความตอนเปิดระบบไม่สำเร็จ / เครื่องมือแอดมินแบบบรรทัดคำสั่ง
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setupEnv } = require('./helpers');

const dataDir = setupEnv();
const config = require('../src/config');
const { parseEnvText, parseEnvLines, loadEnvFile, parsePort, buildConfig, ConfigError } = config;
const ROOT = path.resolve(__dirname, '..');

// รันไฟล์ของระบบเป็นโปรแกรมแยก (เหมือนเจ้าของร้านเปิดเอง) — ไม่อ่าน .env จริง ใช้ฐานข้อมูลชั่วคราว
function runNode(script, args = [], env = {}) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000, env: { ...process.env, ENV_FILE: 'none', DATA_DIR: dataDir, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stderr.split(/\r?\n/).filter(Boolean) };
}

// ───────────── ตัวอ่าน .env ─────────────

test('.env: หมายเหตุท้ายบรรทัดต้องเว้นวรรคก่อน # — # ที่ติดกับค่ายังเป็นส่วนของค่า', () => {
  const v = parseEnvText([
    'PROVIDERS=hubzell,wondd   # ลำดับความสำคัญ',
    'HUBZELL_API_KEY=xyz # note',
    'PASSWORD=abc#123',
    'PASSWORD2=abc#123 # รหัสมี # อยู่ข้างใน',
    'HASH_FIRST=#abc',
    'TAB=1\t# tab ก่อน #',
    'EQ=a=b=c',
    'TH=ผู้ดูแลระบบ   # ชื่อไทย',
  ].join('\n'));
  assert.deepEqual(v, {
    PROVIDERS: 'hubzell,wondd', HUBZELL_API_KEY: 'xyz', PASSWORD: 'abc#123', PASSWORD2: 'abc#123',
    HASH_FIRST: '#abc', TAB: '1', EQ: 'a=b=c', TH: 'ผู้ดูแลระบบ',
  });
});

test('.env: ค่าในเครื่องหมายคำพูดใช้ตามนั้น และตัดข้อความหลังเครื่องหมายปิด', () => {
  const v = parseEnvText([
    'A="abc # not a comment"',
    "B='x #1' # comment",
    'C="quoted"trailing',
    'D=  "spaces before quote"',
    'E=""',
    "F=''",
    'G="no closing quote # cut',
    "H=it's #1",
  ].join('\n'));
  assert.deepEqual(v, { A: 'abc # not a comment', B: 'x #1', C: 'quoted', D: 'spaces before quote', E: '', F: '', G: '"no closing quote', H: "it's" });
});

test('.env: ค่าว่าง / บรรทัดหมายเหตุ / บรรทัดว่าง / เว้นวรรครอบ = / ไม่มี =', () => {
  const text = ['# หมายเหตุทั้งบรรทัด', '', '   # หมายเหตุย่อหน้า', 'EMPTY=', 'NOTE_ONLY=   # ใส่ทีหลัง', '  SPACED  =  value  ', 'no equals sign', '=novalue'].join('\n');
  assert.deepEqual(parseEnvText(text), { EMPTY: '', NOTE_ONLY: '', SPACED: 'value' });
  assert.deepEqual(parseEnvLines(text).filter((e) => e.invalid).map((e) => e.line), [7, 8], 'บอกเลขบรรทัดที่ผิดรูปแบบได้');
});

test('.env: CRLF / CR / BOM ตอนต้นไฟล์ (ไฟล์จาก Notepad) และตั้งซ้ำใช้บรรทัดล่างสุด', () => {
  assert.deepEqual(parseEnvText('﻿PORT=3000\r\nPROVIDERS=mock # x\r\nADMIN_EMAIL=a@b.co\r\n'), { PORT: '3000', PROVIDERS: 'mock', ADMIN_EMAIL: 'a@b.co' });
  assert.deepEqual(parseEnvText('A=1\rB=2\r'), { A: '1', B: '2' });
  assert.deepEqual(parseEnvText('PROVIDERS=mock,mock2\nPROVIDERS=hubzell\n'), { PROVIDERS: 'hubzell' });
});

test('.env: loadEnvFile ไม่ทับค่าที่ตั้งไว้แล้ว + เตือนบรรทัดผิด/ตั้งซ้ำ + อ่านไฟล์ UTF-16 ได้', () => {
  const file = path.join(dataDir, 'sample.env');
  fs.writeFileSync(file, 'KEEP=from-file\nNEW=x # note\nNEW=y\noops\n');
  const target = { KEEP: 'from-env' };
  const warnings = [];
  assert.equal(loadEnvFile(file, target, warnings), true);
  assert.deepEqual(target, { KEEP: 'from-env', NEW: 'y' });
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /NEW ถูกตั้งซ้ำ.*บรรทัด 2 และ 3/);
  assert.match(warnings.join('\n'), /บรรทัดที่ 4 ไม่มีเครื่องหมาย =/);

  const utf16 = path.join(dataDir, 'utf16.env');
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('PORT=4000 # x\r\nADMIN_NAME=ร้านทดสอบ\r\n', 'utf16le')]));
  const t2 = {};
  loadEnvFile(utf16, t2);
  assert.deepEqual(t2, { PORT: '4000', ADMIN_NAME: 'ร้านทดสอบ' });

  assert.equal(loadEnvFile(path.join(dataDir, 'missing.env'), {}), false);
});

test('.env.example อ่านได้สะอาด: ไม่มีบรรทัดผิดรูปแบบ ชื่อไม่ซ้ำ และค่าตั้งไม่มีคำเตือน', () => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const lines = parseEnvLines(text);
  assert.deepEqual(lines.filter((e) => e.invalid), []);
  const keys = lines.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'ห้ามมีชื่อซ้ำใน .env.example');
  const vars = parseEnvText(text);
  for (const [k, v] of Object.entries(vars)) assert.doesNotMatch(v, /\s#/, `${k} ต้องไม่มีหมายเหตุติดมากับค่า`);
  assert.equal(vars.PROVIDERS, 'mock,mock2');
  const c = buildConfig(vars);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.warnings, []);
  assert.equal(c.port, 3000);
});

// ───────────── ตรวจค่าตั้ง ─────────────

test('PORT: ต้องเป็นเลขจำนวนเต็ม 1-65535 ไม่อย่างนั้นแจ้งเป็นภาษาไทยพร้อมชื่อ PORT', () => {
  assert.equal(parsePort(undefined), 3000);
  assert.equal(parsePort(''), 3000);
  assert.equal(parsePort(' 8080 '), 8080);
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('65535'), 65535);
  for (const bad of ['abc', '0', '-1', '65536', '70000', '80.5', '3000abc', '1e3', '0x50', '3 000']) {
    assert.throws(() => parsePort(bad), (err) => err instanceof ConfigError && err.envVar === 'PORT' && /^PORT ใน \.env: ต้องเป็นตัวเลข 1-65535/.test(err.message), `ต้องปฏิเสธ "${bad}"`);
  }
  const c = buildConfig({ PORT: 'abc' });
  assert.equal(c.errors.length, 1);
  assert.equal(c.errors[0].envVar, 'PORT');
  assert.equal(buildConfig({ PORT: '8080' }).publicUrl, 'http://localhost:8080');
});

test('ค่าตัวเลขที่ผิดรูปแบบ: ใช้ค่าเริ่มต้น/ปัดเข้าช่วง และเตือนภาษาไทยพร้อมชื่อตัวแปร (ไม่เงียบ)', () => {
  const c = buildConfig({
    PROVIDER_TIMEOUT_MS: '30,000', SESSION_DAYS: '7.5', LOGIN_LIMIT_PER_MINUTE: '0', API_LIMIT_PER_MINUTE: '-5',
    HUBZELL_RATE_PER_MIN: '500', PROVIDER_CONCURRENCY: '99', HUBZELL_MAX_CONCURRENT: 'สอง', WORKER_TICK_MS: '0',
  });
  assert.equal(c.provider.timeoutMs, 30000);
  assert.equal(c.sessionDays, 7);
  assert.equal(c.limits.loginPerMinute, 1);
  assert.equal(c.limits.apiPerMinute, 1);
  assert.equal(c.hubzell.ratePerMin, 120);
  assert.equal(c.provider.concurrency, 10);
  assert.equal(c.hubzell.maxConcurrent, 2);
  assert.equal(c.workerTickMs, 100);
  const all = c.warnings.join('\n');
  for (const name of ['PROVIDER_TIMEOUT_MS', 'SESSION_DAYS', 'LOGIN_LIMIT_PER_MINUTE', 'API_LIMIT_PER_MINUTE', 'HUBZELL_RATE_PER_MIN', 'PROVIDER_CONCURRENCY', 'HUBZELL_MAX_CONCURRENT', 'WORKER_TICK_MS']) {
    assert.match(all, new RegExp(`${name}=`), `ต้องเตือนเรื่อง ${name}`);
  }
  assert.deepEqual(c.errors, [], 'ค่าตัวเลขอื่นไม่ทำให้เปิดระบบไม่ได้');

  // ค่าที่ถูกต้องไม่มีคำเตือน
  const ok = buildConfig({ PROVIDER_TIMEOUT_MS: '1000', SESSION_DAYS: '14', HUBZELL_RATE_PER_MIN: '+60', PROVIDER_MIN_INTERVAL_MS: '0' });
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.hubzell.ratePerMin, 60);
  assert.equal(ok.provider.minIntervalMs, 0);
});

test('ค่าเปิด/ปิด และ PUBLIC_URL ที่พิมพ์ผิด → ใช้ค่าเริ่มต้นที่ปลอดภัย + เตือน', () => {
  const c = buildConfig({ COOKIE_SECURE: 'ture', PUBLIC_URL: 'https://shop.example.com/', WEBHOOK_ALLOW_PRIVATE: 'maybe' });
  assert.equal(c.cookieSecure, true, 'https → คุกกี้ secure แม้พิมพ์ COOKIE_SECURE ผิด');
  assert.equal(c.webhookAllowPrivate, false);
  assert.equal(c.publicUrl, 'https://shop.example.com');
  assert.match(c.warnings.join('\n'), /COOKIE_SECURE=ture/);
  assert.match(c.warnings.join('\n'), /WEBHOOK_ALLOW_PRIVATE=maybe/);
  for (const [v, expected] of [['1', true], ['yes', true], ['ON', true], ['0', false], ['false', false], ['off', false]]) {
    assert.equal(buildConfig({ DISABLE_WORKER: v }).disableWorker, expected);
  }
  assert.match(buildConfig({ PUBLIC_URL: 'www.shop.com' }).warnings.join('\n'), /PUBLIC_URL=www\.shop\.com ต้องขึ้นต้นด้วย http/);
  assert.equal(buildConfig({ DEBUG: '1' }).debug, true);
  assert.equal(buildConfig({}).debug, false);
});

test('Railway: รู้ว่ารันบน Railway (ตัวแปร RAILWAY_* ที่ Railway ใส่ให้) + เวลาปิดระบบตอน deploy + ตั้งเงินคืน wePAY เองหรือยัง', () => {
  const local = buildConfig({});
  assert.equal(local.platform, null);
  assert.equal(local.drainingSeconds, 0);
  assert.equal(local.wepay.discountsSet, false);
  const rw = buildConfig({ RAILWAY_SERVICE_ID: 'svc-1', RAILWAY_DEPLOYMENT_DRAINING_SECONDS: '40', WEPAY_DISCOUNTS: 'AIS:1.5' });
  assert.equal(rw.platform, 'railway');
  assert.equal(rw.drainingSeconds, 40);
  assert.equal(rw.wepay.discountsSet, true);
  assert.equal(rw.wepay.discountBp.AIS, 150);
  assert.equal(buildConfig({ RAILWAY_ENVIRONMENT_ID: 'env-1', RAILWAY_DEPLOYMENT_DRAINING_SECONDS: 'abc' }).drainingSeconds, 0, 'ค่าผิด = ถือว่าไม่ได้ตั้ง');
});

// ───────────── เปิดระบบไม่สำเร็จ → บอกบรรทัดเดียวว่าต้องแก้ค่าไหน ─────────────

test('start(): ค่าตั้งผิดร้ายแรง → ไม่เปิดระบบ (ไม่แตะฐานข้อมูล)', async () => {
  const { start } = require('../src/server');
  const bad = new ConfigError('PORT', 'ต้องเป็นตัวเลข 1-65535');
  config.errors.push(bad);
  try {
    await assert.rejects(start({ port: 0, host: '127.0.0.1' }), (err) => err === bad);
    assert.equal(require('../src/db').raw(), null, 'ยังไม่เปิดฐานข้อมูล');
  } finally {
    config.errors.length = 0;
  }
});

test('start(): ADMIN_PASSWORD ใน .env ไม่ผ่านกฎ → บอกชื่อตัวแปร (ไม่ใช่ AppError + stack)', async () => {
  const { start, startupErrorLine } = require('../src/server');
  const saved = config.admin.password;
  config.admin.password = 'short';
  try {
    await assert.rejects(start({ port: 0, host: '127.0.0.1' }), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.envVar, 'ADMIN_PASSWORD');
      assert.equal(err.cause?.code, 'VALIDATION_ERROR');
      const line = startupErrorLine(err);
      assert.match(line, /^เปิดระบบไม่สำเร็จ: ADMIN_PASSWORD ใน \.env: รหัสผ่านต้องมี 8-128 ตัวอักษร/);
      assert.match(line, /แก้ไฟล์ \.env แล้วเปิด start\.bat ใหม่$/);
      assert.doesNotMatch(line, /\n/);
      return true;
    });
  } finally {
    config.admin.password = saved;
  }
});

test('start(): พอร์ตถูกใช้อยู่ → บอกให้ปิดหน้าต่างเดิมหรือเปลี่ยน PORT', async () => {
  const { start, startupErrorLine } = require('../src/server');
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  try {
    await assert.rejects(start({ port: busy, host: '127.0.0.1' }), (err) => {
      assert.equal(err.envVar, 'PORT');
      assert.equal(err.cause?.code, 'EADDRINUSE');
      assert.match(startupErrorLine(err), new RegExp(`PORT ใน \\.env: พอร์ต ${busy} ถูกโปรแกรมอื่นใช้อยู่`));
      return true;
    });
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
  // ข้อผิดพลาดที่ไม่รู้จัก: ไม่บอกให้แก้ .env แต่บอกวิธีดูรายละเอียด
  assert.match(startupErrorLine(new Error('อะไรบางอย่าง\nบรรทัดสอง')), /^เปิดระบบไม่สำเร็จ: อะไรบางอย่าง \(ตั้ง DEBUG=1 ใน \.env/);
});

test('เปิดจากบรรทัดคำสั่ง: PORT ผิด → ออกด้วย code 1 พร้อมข้อความบรรทัดเดียว (stack เฉพาะ DEBUG=1)', () => {
  const r = runNode('src/server.js', [], { PORT: 'abc', NODE_ENV: '' });
  assert.equal(r.code, 1);
  assert.equal(r.lines.length, 1, r.err);
  assert.match(r.lines[0], /ERROR\s+เปิดระบบไม่สำเร็จ: PORT ใน \.env: ต้องเป็นตัวเลข 1-65535 \(ตอนนี้ตั้งไว้ "abc"\).*แก้ไฟล์ \.env แล้วเปิด start\.bat ใหม่/);

  const d = runNode('src/server.js', [], { PORT: '70000', NODE_ENV: '', DEBUG: '1' });
  assert.equal(d.code, 1);
  assert.match(d.err, /PORT ใน \.env/);
  assert.match(d.err, /\n\s+at /, 'DEBUG=1 แสดง stack');
});

// ───────────── เครื่องมือแอดมิน (scripts/admin.js) ─────────────

test('admin unlock: ไม่เปิดบัญชีที่ถูกระงับเงียบๆ (ต้อง --activate) + ทุกการแก้บันทึก audit (via: cli)', async () => {
  const db = require('../src/db');
  const { verifyPassword } = require('../src/lib/security');
  db.open(config.dbFile);
  const email = config.admin.email;
  const row = () => db.get('SELECT * FROM users WHERE email = ?', email);
  assert.ok(row(), 'มีแอดมินจากการทดสอบก่อนหน้า');
  db.run("UPDATE users SET status = 'suspended', failed_logins = 9, locked_until = ? WHERE email = ?", new Date(Date.now() + 3600000).toISOString(), email);
  const since = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs').id;

  const r1 = runNode('scripts/admin.js', ['unlock', '--user', email.toUpperCase()]);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /ถูกระงับการใช้งานอยู่/);
  assert.match(r1.out, /15 นาที หรือเมื่อปิด-เปิดระบบใหม่/);
  assert.equal(row().status, 'suspended', 'ปลดล็อกแล้วต้องยังถูกระงับ');
  assert.equal(row().locked_until, null);
  assert.equal(row().failed_logins, 0);

  const r2 = runNode('scripts/admin.js', ['unlock', '--user', email, '--activate']);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(row().status, 'active');

  // รหัสผ่านส่งทางตัวแปร (แบบ reset-admin-password.bat) — อักขระพิเศษต้องไม่เพี้ยน
  const pw = 'N3w&Pass|"word%x';
  const r3 = runNode('scripts/admin.js', ['reset-password', '--user', email], { TOPUP_NEW_PASSWORD: pw });
  assert.equal(r3.code, 0, r3.err);
  assert.equal(await verifyPassword(pw, row().password_hash), true);
  const weak = runNode('scripts/admin.js', ['reset-password', '--user', email, '--password', 'short']);
  assert.equal(weak.code, 1);
  assert.match(weak.err, /รหัสผ่านต้องมี 8-128 ตัวอักษร/);

  const logs = db.all('SELECT actor_id, action, detail FROM audit_logs WHERE id > ? ORDER BY id', since);
  assert.deepEqual(logs.map((l) => l.action), ['user.unlock', 'user.unlock', 'user.activate', 'user.password_reset']);
  for (const l of logs) {
    assert.equal(l.actor_id, null);
    assert.equal(JSON.parse(l.detail).via, 'cli');
  }
  db.close();
});
