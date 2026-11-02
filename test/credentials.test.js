'use strict';
// คีย์ร้าน / ช่องทางแจ้งเตือน ใส่จากหลังบ้าน (ไม่ต้องแก้ .env / Railway Variables)
//   เก็บแบบเข้ารหัส · ไม่ส่งค่าลับกลับไปหน้าเว็บ · ต้องยืนยันรหัสผ่าน · ใช้ได้ทันที · ทดสอบการเชื่อมต่อให้เลย
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupEnv, Client, ADMIN_PASSWORD } = require('./helpers');
const { createFakeHubzell } = require('./fakeHubzell');
const { createFakeWepay } = require('./fakeWepay');

const HZ_KEY = 'hz_live_key_0123456789abcdefWXYZ';
const HZ_SECRET = 'hz_secret_9876543210fedcbaQRST';
const WP_USER = 'wp_shop_admin';
const WP_PASS = 'Wp Pass with spaces 2569'; // รหัสผ่านใช้ตามที่พิมพ์ (ไม่ตัดช่องว่าง)
// ไม่มีคีย์ร้านใน environment เลย (เหมือนบน Railway ตอนนี้)
const dataDir = setupEnv({ PROVIDERS: 'hubzell,wepay', PROVIDER_TIMEOUT_MS: '1000' });
const config = require('../src/config');
const { start } = require('../src/server');
const db = require('../src/db');
const breaker = require('../src/services/breaker');
const credentials = require('../src/services/credentials');
const securityCheck = require('../src/services/securityCheck');
const providers = require('../src/providers');
const hubzell = require('../src/providers/hubzell');
const notify = require('../src/lib/notify');

let app;
let base;
let admin;
let hz;
let wp;

const put = (group, fields, extra = { actor_password: ADMIN_PASSWORD }) => admin.put(`/api/admin/credentials/${group}`, { fields, ...extra });
const groupOf = async (name) => (await admin.get('/api/admin/credentials')).body.data.groups.find((g) => g.group === name);
const field = (g, key) => g.fields.find((f) => f.key === key);
const balanceCalls = () => hz.state.requests.filter((r) => r.path === '/api/v1/balance').length;
const ready = (name) => providers.byName(name).configStatus().ready;

before(async () => {
  hz = createFakeHubzell({ apiKey: HZ_KEY, secret: HZ_SECRET });
  config.hubzell.baseUrl = `http://127.0.0.1:${await hz.listen()}/api/v1`;
  wp = createFakeWepay({ username: WP_USER, password: WP_PASS });
  config.wepay.apiUrl = `http://127.0.0.1:${await wp.listen()}/client_api.json.php`;
  app = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.port}`;
  admin = new Client(base);
  assert.equal((await admin.post('/api/auth/login', { identifier: 'admin@test.local', password: ADMIN_PASSWORD })).status, 200);
});

after(async () => {
  await app.close();
  await hz.close();
  await wp.close();
});

test('ยังไม่ได้ใส่คีย์ → ร้านไม่พร้อม ลูกค้าสั่งไม่ได้ · หน้าแอดมินเห็นช่องที่ต้องใส่', async () => {
  const r = await admin.get('/api/admin/credentials');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.groups.map((g) => g.group), ['hubzell', 'wepay', 'notify']);
  const g = r.body.data.groups[0];
  assert.equal(g.ready, false);
  assert.equal(field(g, 'apiKey').set, false);
  assert.equal(field(g, 'apiKey').required, true);
  assert.equal(field(g, 'webhookSecret').required, false);
  assert.equal(ready('hubzell'), false);
  assert.equal(ready('wepay'), false);
  const cat = await new Client(base).get('/api/catalog');
  assert.equal(cat.body.data.mode.ready, false);

  // หน้าผู้ให้บริการได้สถานะคีย์ของแต่ละร้านมาด้วย + ข้อความบอกให้กดปุ่มในหลังบ้าน (ไม่ใช่ไปแก้ Railway)
  const pv = (await admin.get('/api/admin/providers')).body.data;
  assert.equal(pv.providers.find((p) => p.name === 'hubzell').credentials.group, 'hubzell');
  assert.equal(pv.notify_credentials.group, 'notify');
  const item = securityCheck.checklist(null).find((i) => i.key === 'provider_hubzell');
  assert.match(item.message, /ใส่คีย์ร้าน/);
  assert.match(item.message, /API Key/);

  // ไม่ได้ล็อกอินแอดมิน → ใช้ไม่ได้
  assert.ok([401, 403].includes((await new Client(base).get('/api/admin/credentials')).status));
});

test('รูปแบบผิดบอกทันที (ยังไม่ต้องใส่รหัสผ่าน) · ไม่ยืนยันรหัสผ่าน / รหัสผิด → ไม่บันทึก', async () => {
  let r = await put('hubzell', { apiKey: 'key with spaces 0123' }, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.field, 'apiKey');
  r = await put('hubzell', { nope: 'x' }, {});
  assert.equal(r.status, 400);
  assert.equal((await put('wondd', { apiKey: HZ_KEY }, {})).status, 404);

  r = await put('hubzell', { apiKey: HZ_KEY, secret: HZ_SECRET }, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'REAUTH_REQUIRED');
  assert.match(r.body.error.message, /คีย์ร้าน/);
  r = await put('hubzell', { apiKey: HZ_KEY, secret: HZ_SECRET }, { actor_password: 'Wrong-Pass-1234' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'REAUTH_FAILED');
  assert.equal(config.hubzell.apiKey, '');
  assert.equal(ready('hubzell'), false);
});

test('บันทึกคีย์ HubZell → ใช้ได้ทันที + ทดสอบการเชื่อมต่อให้เลย · เก็บแบบเข้ารหัส · ไม่ส่งค่าลับกลับ', async () => {
  credentials._reset();
  const r = await put('hubzell', { apiKey: `  ${HZ_KEY}\n`, secret: HZ_SECRET }); // ช่องว่าง/ขึ้นบรรทัดจากการคัดลอกถูกตัด
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.test.ok, true, JSON.stringify(d.test));
  assert.equal(d.test.balance, 500000);
  assert.equal(d.group.ready, true);
  const f = field(d.group, 'apiKey');
  assert.equal(f.source, 'admin');
  assert.equal(f.hint, `••••${HZ_KEY.slice(-4)}`);
  assert.ok(f.updated_at);
  assert.equal(f.updated_by, 'admin@test.local');
  for (const body of [r.body, (await admin.get('/api/admin/providers')).body, (await admin.get('/api/admin/credentials')).body]) {
    const text = JSON.stringify(body);
    assert.ok(!text.includes(HZ_KEY) && !text.includes(HZ_SECRET), 'ไม่ส่งค่าลับกลับไปหน้าเว็บ');
  }

  // ระบบใช้คีย์ใหม่ทันที (ไม่ต้องรีสตาร์ท) — ลูกค้าเห็นร้าน
  assert.equal(config.hubzell.apiKey, HZ_KEY);
  assert.equal(config.hubzell.secret, HZ_SECRET);
  assert.equal(ready('hubzell'), true);
  assert.equal((await new Client(base).get('/api/catalog')).body.data.mode.ready, true);

  // ในฐานข้อมูลมีแต่ข้อความเข้ารหัส · กุญแจอยู่ในไฟล์แยก (ไฟล์สำรองฐานข้อมูลที่หลุดไปอ่านคีย์ไม่ได้)
  const row = db.get("SELECT value FROM settings WHERE key = '_cred_hubzell'");
  assert.ok(row && !row.value.includes(HZ_KEY) && !row.value.includes(HZ_SECRET));
  assert.match(row.value, /"enc":"v1:/);
  const keyFile = path.join(dataDir, 'credentials.key');
  assert.equal(credentials.keyFile(), keyFile);
  assert.equal(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64').length, 32);

  // audit log บอกว่าแก้ช่องไหน (ไม่มีค่า)
  const a = db.get("SELECT detail FROM audit_logs WHERE action = 'credentials.update' ORDER BY id DESC LIMIT 1");
  assert.ok(a && !a.detail.includes(HZ_KEY));
  assert.match(a.detail, /API Key/);

  // กดบันทึกซ้ำทันที (ภายใน 10 วินาที) → ไม่ยิงทดสอบซ้ำ
  const calls = balanceCalls();
  const again = await put('hubzell', { webhookSecret: 'whsec_test_0123456789abcdef' });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.test.skipped, true);
  assert.equal(balanceCalls(), calls);
  assert.equal(config.hubzell.webhookSecret, 'whsec_test_0123456789abcdef');
});

test('คีย์ผิด → บันทึกได้แต่บอกว่าเชื่อมต่อไม่สำเร็จ และพักร้านไว้ · ใส่คีย์ถูก → เลิกพักทันที', async () => {
  credentials._reset();
  let r = await put('hubzell', { secret: 'wrong-secret-0123456789' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.test.ok, false);
  assert.match(r.body.data.test.message, /INVALID_SIGNATURE/);
  assert.equal(breaker.isOpen('hubzell'), true, 'คีย์ผิด = ไม่ส่งรายการไปร้านนี้');

  credentials._reset();
  r = await put('hubzell', { secret: HZ_SECRET });
  assert.equal(r.body.data.test.ok, true);
  assert.equal(breaker.isOpen('hubzell'), false);
});

test('HubZell ตอบ KYC_NOT_APPROVED → หยุดเรียกเองหลัง 2 ครั้งใน 5 นาที (HubZell บล็อก IP 24 ชม. ที่ 5 ครั้ง)', async () => {
  hz.state.forced = [403, 'KYC_NOT_APPROVED'];
  hubzell._internal.resetGuards();
  try {
    const kyc = () => hz.state.requests.filter((r) => r.code === 'KYC_NOT_APPROVED').length;
    const start0 = kyc();
    for (let i = 0; i < 5; i++) await hubzell.getBalance();
    assert.equal(kyc() - start0, 2);
    assert.match((await hubzell.getBalance()).message, /KYC/);
  } finally {
    hz.state.forced = null;
    hubzell._internal.resetGuards();
    breaker.reset();
  }
  assert.equal((await hubzell.getBalance()).ok, true);
});

test('wePAY: ชื่อผู้ใช้ + รหัสผ่าน (มีช่องว่างได้) + เงินคืนแต่ละเครือข่าย', async () => {
  credentials._reset();
  let r = await put('wepay', { username: WP_USER, password: WP_PASS, discountBp: { AIS: '1.5', DTAC: '2', TRUE: '2.75' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.test.ok, true, JSON.stringify(r.body.data.test));
  assert.equal(config.wepay.password, WP_PASS);
  assert.deepEqual({ ...config.wepay.discountBp }, { AIS: 150, DTAC: 200, TRUE: 275 });
  assert.equal(config.wepay.discountsSet, true);
  assert.equal(providers.byName('wepay').quote({ type: 'topup', network: { code: 'AIS', topup_min: 1000, topup_max: 150000 }, faceValue: 10000 }).cost, 9850);
  const g = r.body.data.group;
  assert.equal(field(g, 'username').value, WP_USER, 'ชื่อผู้ใช้ไม่ใช่ความลับ — แสดงได้');
  assert.equal(field(g, 'password').hint, null, 'รหัสผ่านไม่แสดงแม้แต่ 4 ตัวท้าย');
  assert.deepEqual(field(g, 'discountBp').value, { AIS: 1.5, DTAC: 2, TRUE: 2.75 });
  assert.ok(!JSON.stringify(r.body).includes(WP_PASS));
  assert.equal(securityCheck.checklist(null).find((i) => i.key === 'provider_wepay_discounts'), undefined);

  r = await put('wepay', { discountBp: { AIS: '50', DTAC: '2', TRUE: '2' } }, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.field, 'discountBp.AIS');
  r = await put('wepay', { discountBp: { AIS: '1', DTAC: '', TRUE: '2' } }, {});
  assert.equal(r.body.error.details.field, 'discountBp.DTAC');
});

test('ลบค่าในหลังบ้าน → กลับไปใช้ค่าจาก environment (ถ้ามี)', async () => {
  config.wepay.username = 'env_user'; // เหมือนตั้ง WEPAY_USERNAME ไว้ใน environment
  try {
    assert.equal(config.wepay.username, WP_USER, 'ค่าที่ใส่ในหลังบ้านใช้ก่อน');
    const r = await put('wepay', { username: null });
    assert.equal(r.status, 200);
    assert.equal(config.wepay.username, 'env_user');
    const f = field(r.body.data.group, 'username');
    assert.equal(f.source, 'env');
    assert.equal(f.value, 'env_user');
  } finally {
    config.wepay.username = '';
  }
  assert.equal(ready('wepay'), false);
  credentials._reset();
  assert.equal((await put('wepay', { username: WP_USER })).status, 200);
  assert.equal(ready('wepay'), true);
});

test('แจ้งเตือน LINE / Telegram: รูปแบบ token ผิดถูกปฏิเสธ · ใส่ครบแล้วระบบรู้ว่าตั้งช่องทางแล้ว', async () => {
  let r = await put('notify', { telegramToken: 'not-a-token' }, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.field, 'telegramToken');
  r = await put('notify', { telegramToken: '123456789:AAEexampleTokenValue_abcdefghij', telegramChatId: '-1001234567890' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.test, null);
  assert.equal(r.body.data.group.ready, true);
  assert.equal(notify.channels().telegram, true);
  assert.equal(field(r.body.data.group, 'telegramChatId').value, '-1001234567890');
  assert.equal(securityCheck.checklist(null).find((i) => i.key === 'notify').level, 'ok');
  r = await put('notify', { telegramToken: null, telegramChatId: null });
  assert.equal(r.status, 200);
  assert.equal(notify.channels().telegram, false);
});

test('เข้ารหัส: ใช้ข้ามช่องไม่ได้ · ข้อมูลถูกแก้ = ถอดไม่ได้', () => {
  const { encrypt, decrypt } = credentials._internal;
  const aad = Buffer.from('topup-credentials:v1:hubzell.apiKey');
  const enc = encrypt('top-secret-value', aad);
  assert.equal(decrypt(enc, aad), 'top-secret-value');
  assert.equal(decrypt(enc, Buffer.from('topup-credentials:v1:hubzell.secret')), null, 'ย้ายไปใช้กับช่องอื่นไม่ได้');
  const [v, iv, tag, ct] = enc.split(':');
  const flipped = Buffer.from(ct, 'base64');
  flipped[0] ^= 1;
  assert.equal(decrypt([v, iv, tag, flipped.toString('base64')].join(':'), aad), null);
  assert.equal(decrypt('garbage', aad), null);
});

// ต้องอยู่ท้ายสุด (ลบไฟล์กุญแจ)
test('ไฟล์กุญแจหาย (เช่น ย้ายเครื่อง) → ระบบไม่ล้ม ใช้ค่าจาก environment แทน และเตือนให้ใส่ใหม่', async () => {
  fs.rmSync(credentials.keyFile());
  credentials._reset();
  assert.equal(config.hubzell.apiKey, '');
  assert.equal(ready('hubzell'), false);
  assert.deepEqual(credentials.unreadableGroups(), ['HubZell', 'wePAY']);
  const g = await groupOf('hubzell');
  assert.equal(g.unreadable, true);
  assert.equal(field(g, 'apiKey').unreadable, true);
  assert.equal(field(g, 'apiKey').set, false);
  assert.ok(securityCheck.checklist(null).find((i) => i.key === 'credentials_unreadable'));
  assert.equal((await new Client(base).get('/api/catalog')).status, 200);

  // ใส่ใหม่ → สร้างกุญแจใหม่ ใช้ได้ทันที · ช่องที่ยังไม่ได้ใส่ใหม่ยังขึ้นว่า "ใช้ไม่ได้" ให้เห็น
  let r = await put('hubzell', { apiKey: HZ_KEY, secret: HZ_SECRET });
  assert.equal(r.status, 200);
  assert.equal(config.hubzell.apiKey, HZ_KEY);
  assert.equal(ready('hubzell'), true);
  assert.equal(field(r.body.data.group, 'apiKey').unreadable, false);
  assert.equal(field(r.body.data.group, 'webhookSecret').unreadable, true);
  assert.deepEqual(credentials.unreadableGroups(), ['HubZell', 'wePAY']);
  r = await put('hubzell', { webhookSecret: null });
  assert.equal(r.body.data.group.unreadable, false);
  assert.deepEqual(credentials.unreadableGroups(), ['wePAY']);
});
