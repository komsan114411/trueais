'use strict';
/**
 * เครื่องมือแอดมินแบบบรรทัดคำสั่ง (ใช้ได้ทั้งตอนระบบเปิดอยู่และปิดอยู่)
 *   npm run admin -- list
 *   npm run admin -- create --email boss@shop.com --password Boss12345 [--name "เจ้าของร้าน"]
 *   npm run admin -- reset-password --user boss@shop.com --password NewPass123
 *   npm run admin -- unlock --user boss@shop.com [--activate]
 *   npm run admin -- disable-2fa --user boss@shop.com   (กรณีโทรศัพท์ที่ใช้รับรหัส 6 หลักหาย)
 *   npm run admin -- backup             (สำรองฐานข้อมูลทันที → data/backups)
 *   npm run admin -- notify-test        (ทดสอบส่งแจ้งเตือน LINE / Telegram ตามค่าใน .env — เหมือนปุ่มในหน้าตั้งค่า)
 *   npm run admin -- reconcile          (ตรวจยอดกระเป๋าเงินทุกบัญชีเทียบกับสมุดบัญชี)
 *   npm run admin -- restore <ไฟล์.json.gz> --yes      (PostgreSQL: กู้คืนจากไฟล์สำรอง — แทนที่ข้อมูลทั้งหมด)
 *   npm run admin -- import-sqlite [<ไฟล์.db>] --yes  (PostgreSQL: ย้ายข้อมูลจาก SQLite เดิม ค่าเริ่มต้น data/topup.db)
 * --user ใส่อีเมลหรือเบอร์โทรก็ได้ (--email / --phone ใช้ได้เหมือนเดิม)
 * ไม่ใส่ --password → อ่านจากตัวแปร TOPUP_NEW_PASSWORD (ไฟล์ reset-admin-password.bat ส่งมาทางนี้ กันปัญหาอักขระพิเศษ)
 * ทุกการแก้บัญชีถูกบันทึกในหน้าแอดมิน → Log → การกระทำของแอดมิน (ผู้ทำ = ระบบ, via: cli)
 */
const path = require('node:path');
const config = require('../src/config');
const db = require('../src/db');

const CLI = { via: 'cli' };
const LOCK_NOTE = 'หมายเหตุ: ถ้าระบบกำลังเปิดอยู่ การล็อกชั่วคราวราย IP (ใส่รหัสผ่านผิด 5 ครั้ง) และการล็อกรหัส 2 ชั้น เก็บในหน่วยความจำของระบบ — จะหายเองภายใน 15 นาที หรือเมื่อปิด-เปิดระบบใหม่';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);
const who = (u) => u.email || u.phone || `#${u.id}`;
const audit = (...a) => require('../src/services/audit').log(...a);
const users = () => require('../src/services/users');

/** หาบัญชีจาก --user (อีเมลหรือเบอร์โทร) / --email / --phone */
function findUser() {
  const { normalizePhone } = require('../src/lib/phone');
  const input = String(arg('user') ?? arg('email') ?? arg('phone') ?? '').trim();
  if (!input) throw new Error('กรุณาระบุบัญชี เช่น --user boss@shop.com หรือ --user 0812345678');
  const phone = input.includes('@') ? null : normalizePhone(input);
  const u = phone ? db.get('SELECT * FROM users WHERE phone = ?', phone) : db.get('SELECT * FROM users WHERE email = ?', input.toLowerCase());
  if (!u) throw new Error(`ไม่พบบัญชี ${input} (ดูรายชื่อแอดมินด้วยคำสั่ง list)`);
  return u;
}

function newPassword() {
  const pw = arg('password') ?? process.env.TOPUP_NEW_PASSWORD;
  if (!pw) throw new Error('กรุณาใส่รหัสผ่านใหม่ด้วย --password <รหัสผ่านใหม่>');
  return pw;
}

const suspendedNote = (u) => `⚠ บัญชี ${who(u)} ถูกระงับการใช้งานอยู่ — ยังเข้าสู่ระบบไม่ได้ ถ้าต้องการเปิดใช้ด้วย สั่ง: npm run admin -- unlock --user ${who(u)} --activate`;

function list() {
  const rows = db.all(`SELECT id, name, email, phone, status, CASE WHEN totp_secret IS NULL THEN 'ไม่ได้เปิด' ELSE 'เปิดแล้ว' END AS two_factor,
    locked_until, last_login_at FROM users WHERE role = 'admin' ORDER BY id`);
  if (!rows.length) console.log('ยังไม่มีบัญชีแอดมิน — เปิดระบบ (start.bat) ครั้งแรกเพื่อสร้างจาก ADMIN_EMAIL / ADMIN_PASSWORD ใน .env');
  else console.table(rows);
}

async function create() {
  const u = await users().createUser({ name: arg('name') || 'ผู้ดูแลระบบ', email: arg('email'), phone: arg('phone'), password: newPassword(), role: 'admin' }, { requirePhone: false });
  audit(null, 'user.create', 'user', u.id, { ...CLI, role: 'admin' });
  console.log(`✓ สร้างแอดมินแล้ว: #${u.id} ${who(u)}`);
}

async function resetPassword() {
  const u = findUser();
  const pw = newPassword();
  const svc = users();
  const { hashPassword } = require('../src/lib/security');
  svc.validatePassword(pw, 'password', { phone: u.phone, email: u.email });
  db.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', await hashPassword(pw), db.nowIso(), u.id);
  svc.destroyUserSessions(u.id);
  if (u.role === 'admin') svc.removeBootstrapPasswordFile();
  audit(null, 'user.password_reset', 'user', u.id, CLI);
  console.log(`✓ ตั้งรหัสผ่านใหม่ให้ ${who(u)} แล้ว — อุปกรณ์ที่เคยเข้าสู่ระบบไว้ถูกออกจากระบบทั้งหมด`);
  if (u.status !== 'active') console.log(suspendedNote(u));
  console.log(LOCK_NOTE);
}

function unlock() {
  const u = findUser();
  db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', db.nowIso(), u.id);
  audit(null, 'user.unlock', 'user', u.id, CLI);
  console.log(`✓ ปลดล็อกการใส่รหัสผ่านผิดของ ${who(u)} แล้ว`);
  // บัญชีที่แอดมินระงับไว้ ห้ามเปิดคืนเงียบๆ — ต้องสั่ง --activate เอง
  if (u.status !== 'active') {
    if (hasFlag('activate')) {
      db.run("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?", db.nowIso(), u.id);
      audit(null, 'user.activate', 'user', u.id, CLI);
      console.log(`✓ เปิดใช้งานบัญชี ${who(u)} ที่ถูกระงับไว้แล้ว`);
    } else {
      console.log(suspendedNote(u));
    }
  }
  console.log(LOCK_NOTE);
}

function disable2fa() {
  const u = findUser();
  if (!u.totp_secret && !u.totp_pending) {
    console.log(`บัญชี ${who(u)} ไม่ได้เปิดยืนยันตัวตน 2 ชั้นอยู่แล้ว — ไม่ต้องแก้อะไร`);
    return;
  }
  db.run('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?', db.nowIso(), u.id);
  users().destroyUserSessions(u.id);
  audit(null, 'user.2fa_reset', 'user', u.id, CLI);
  console.log(`✓ ปิดการยืนยันตัวตน 2 ชั้นของ ${who(u)} แล้ว — เข้าสู่ระบบด้วยรหัสผ่านอย่างเดียวได้ แล้วควรเปิดใหม่ทันทีที่หน้า "บัญชีของฉัน"`);
  if (u.status !== 'active') console.log(suspendedNote(u));
}

async function backup() {
  const r = await require('../src/services/backup').backupNow();
  audit(null, 'system.backup', 'backup', r.name, { ...CLI, size: r.size });
  const dir = path.join(config.dataDir, 'backups');
  const size = r.size >= 1048576 ? `${(r.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(r.size / 1024))} KB`;
  console.log(`✓ ไฟล์สำรอง: ${path.join(dir, r.name)} (${size})`);
  console.log(`  ไฟล์สำรองเก่าในโฟลเดอร์ ${dir} ถูกลบให้อัตโนมัติ — ควรคัดลอกไปเก็บนอกเครื่องด้วย (แฟลชไดรฟ์ / Google Drive)`);
  console.log(`  ไฟล์สลิปอยู่ที่ ${config.uploadDir} (ไม่ได้รวมอยู่ในไฟล์สำรอง ให้คัดลอกแยก)`);
}

// สาเหตุที่พบบ่อยตาม HTTP status ที่ LINE / Telegram ตอบกลับ
const NOTIFY_HINTS = {
  LINE: { 400: 'LINE_TO ไม่ถูกต้อง (User ID ขึ้นต้นด้วย U) หรือยังไม่ได้เพิ่มบัญชีทางการเป็นเพื่อน', 401: 'LINE_CHANNEL_ACCESS_TOKEN ไม่ถูกต้อง หรือถูกออกใหม่แล้ว', 429: 'ส่งเกินโควตาข้อความของเดือนนี้' },
  Telegram: { 400: 'TELEGRAM_CHAT_ID ไม่ถูกต้อง หรือยังไม่ได้กด Start คุยกับบอท', 401: 'TELEGRAM_BOT_TOKEN ไม่ถูกต้อง', 403: 'บอทถูกบล็อก หรือไม่ได้อยู่ในกลุ่มนั้น', 404: 'TELEGRAM_BOT_TOKEN ไม่ถูกต้อง' },
};

/** ส่งข้อความทดสอบผ่าน src/lib/notify.js (ทางเดียวกับปุ่ม "ส่งข้อความทดสอบ" ในหน้าตั้งค่า) — อ่าน .env ล่าสุด ไม่ต้องปิด-เปิดระบบ */
async function notifyTest() {
  const r = await require('../src/lib/notify').sendTest();
  if (!r.configured) {
    console.log('ยังไม่ได้ตั้งค่าแจ้งเตือน — ใส่ LINE_CHANNEL_ACCESS_TOKEN + LINE_TO หรือ TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID ใน .env (ดู README หัวข้อ "ตั้งค่าแจ้งเตือน LINE / Telegram")');
    process.exitCode = 1;
    return;
  }
  for (const c of r.channels) {
    if (c.ok) {
      console.log(`✓ ส่งข้อความทดสอบไป ${c.name} แล้ว — ตรวจดูในแอป ${c.name}`);
      continue;
    }
    const status = Number(/^HTTP (\d+)/.exec(c.error || '')?.[1]);
    const hint = NOTIFY_HINTS[c.name]?.[status] || (status ? '' : 'ตรวจการเชื่อมต่ออินเทอร์เน็ต');
    console.log(`✗ ส่งไป ${c.name} ไม่สำเร็จ${hint ? ` — ${hint}` : ''}\n  (${c.error})`);
    process.exitCode = 1;
  }
}

function reconcile() {
  const wallet = require('../src/services/wallet');
  const bad = wallet.reconcile();
  if (!bad.length) console.log('✓ ยอดเงินทุกบัญชีตรงกับสมุดบัญชี');
  else console.table(bad);
  const orders = wallet.reconcileOrders();
  if (!orders.length) console.log('✓ เงินที่เก็บจริงของทุกรายการตรงกับสถานะ');
  else {
    console.log('รายการที่เงินไม่ตรงสถานะ (net = ยอดสุทธิในสมุดบัญชี หน่วยสตางค์):');
    console.table(orders);
  }
  if (bad.length || orders.length) process.exitCode = 2;
}

const positional = (i) => {
  const v = process.argv[i];
  return v && !v.startsWith('--') ? v : null;
};
const transfer = () => require('../src/database/transfer');

function restore() {
  const input = positional(3);
  if (!input) throw new Error('ระบุไฟล์สำรอง เช่น npm run admin -- restore data/backups/topup-2026-11-02-0300.json.gz --yes');
  const file = path.resolve(input);
  if (!db.isPostgres()) {
    console.log('ระบบนี้ใช้ SQLite (ไม่ได้ตั้ง DATABASE_URL) — กู้คืนด้วยการคัดลอกไฟล์:');
    console.log(`  1) ปิดระบบ  2) คัดลอก ${file} ไปทับ ${config.dbFile}  3) ลบไฟล์ ${config.dbFile}-wal และ -shm ถ้ามี  4) เปิดระบบ`);
    process.exitCode = 1;
    return;
  }
  const b = transfer().readBackup(file); // ตรวจไฟล์ก่อนถามยืนยัน
  if (!hasFlag('yes')) {
    console.log(`ไฟล์สำรองเมื่อ ${b.header.created_at}: ผู้ใช้ ${b.counts.users || 0} บัญชี, รายการ ${b.counts.orders || 0} รายการ`);
    console.log(`ข้อมูลทั้งหมดในฐานข้อมูลตอนนี้จะถูกแทนที่ (ตอนนี้มี: ${JSON.stringify(transfer().usage())})`);
    console.log('ปิดระบบก่อน แล้วสั่งคำสั่งเดิมโดยเพิ่ม --yes ต่อท้ายเพื่อยืนยัน');
    process.exitCode = 1;
    return;
  }
  const r = transfer().restoreBackup(file);
  audit(null, 'system.restore', 'backup', path.basename(file), { ...CLI, created_at: r.created_at });
  console.log(`✓ กู้คืนข้อมูลจากไฟล์สำรอง (สร้างเมื่อ ${r.created_at}) แล้ว — เปิดระบบได้เลย`);
  console.table(r.counts);
}

function importSqlite() {
  const file = path.resolve(positional(3) || config.dbFile);
  if (!db.isPostgres()) throw new Error('ตั้ง DATABASE_URL ของ PostgreSQL ปลายทางก่อน (คำสั่งนี้ย้ายข้อมูลจาก SQLite → PostgreSQL)');
  const t = transfer();
  if (t.hasUsage() && !hasFlag('replace')) {
    throw new Error(`PostgreSQL ปลายทางมีข้อมูลใช้งานแล้ว (${JSON.stringify(t.usage())}) — ถ้าต้องการแทนที่ทั้งหมดให้เพิ่ม --replace`);
  }
  if (!hasFlag('yes')) {
    console.log(`จะคัดลอกข้อมูลทั้งหมดจาก ${file} → PostgreSQL (ข้อมูลตั้งต้นใน PostgreSQL ถูกแทนที่) — ไฟล์ต้นฉบับไม่ถูกแก้`);
    console.log('สั่งคำสั่งเดิมโดยเพิ่ม --yes ต่อท้ายเพื่อยืนยัน');
    process.exitCode = 1;
    return;
  }
  const counts = t.importSqlite(file);
  audit(null, 'system.import_sqlite', 'database', path.basename(file), { ...CLI, users: counts.users, orders: counts.orders });
  console.log('✓ ย้ายข้อมูลเข้า PostgreSQL แล้ว');
  console.table(counts);
  console.log(`  ไฟล์สลิปอยู่ที่ ${config.uploadDir} — คัดลอกโฟลเดอร์นี้ไปที่เครื่อง/โฟลเดอร์ data ของระบบใหม่ด้วย`);
}

const COMMANDS = {
  list, create, 'reset-password': resetPassword, unlock, 'disable-2fa': disable2fa, backup, 'notify-test': notifyTest, reconcile,
  restore, 'import-sqlite': importSqlite,
};

const HELP = `คำสั่งที่ใช้ได้ (--user ใส่อีเมลหรือเบอร์โทรก็ได้):
  npm run admin -- list
  npm run admin -- create --email <อีเมล> --password <รหัสผ่าน> [--name <ชื่อ>]
  npm run admin -- reset-password --user <อีเมล/เบอร์> --password <รหัสผ่านใหม่>
  npm run admin -- unlock --user <อีเมล/เบอร์> [--activate]
  npm run admin -- disable-2fa --user <อีเมล/เบอร์>
  npm run admin -- backup
  npm run admin -- notify-test
  npm run admin -- reconcile
  npm run admin -- restore <ไฟล์สำรอง.json.gz> --yes       (PostgreSQL)
  npm run admin -- import-sqlite [<ไฟล์.db>] --yes [--replace] (ย้าย SQLite → PostgreSQL)`;

async function main() {
  const cmd = process.argv[2];
  const run = Object.hasOwn(COMMANDS, cmd || '') ? COMMANDS[cmd] : null;
  if (!run) {
    console.log(HELP);
    if (cmd) process.exitCode = 1;
    return;
  }
  // อ่าน .env ไม่ได้ → หยุด (ไม่อย่างนั้นอาจไปแก้ฐานข้อมูลผิดที่) — PORT ผิดไม่เกี่ยวกับเครื่องมือนี้
  const fatal = config.errors.find((e) => e.envVar !== 'PORT');
  if (fatal) throw fatal;
  db.open(config.dbFile);
  await run();
}

main()
  .catch((err) => {
    console.error(`ผิดพลาด: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
