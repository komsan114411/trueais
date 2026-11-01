'use strict';
/**
 * เครื่องมือแอดมินแบบบรรทัดคำสั่ง
 *   npm run admin -- list
 *   npm run admin -- create --email boss@shop.com --password Boss12345 [--name "เจ้าของร้าน"]
 *   npm run admin -- reset-password --email boss@shop.com --password NewPass123
 *   npm run admin -- unlock --email boss@shop.com
 *   npm run admin -- disable-2fa --email boss@shop.com   (กรณีโทรศัพท์ที่ใช้รับรหัส 6 หลักหาย)
 *   npm run admin -- reconcile          (ตรวจยอดกระเป๋าเงินทุกบัญชีเทียบกับสมุดบัญชี)
 */
const config = require('../src/config');
const db = require('../src/db');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  db.open(config.dbFile);
  const users = require('../src/services/users');
  const { hashPassword } = require('../src/lib/security');

  if (cmd === 'list') {
    const rows = db.all("SELECT id, name, email, phone, status, CASE WHEN totp_secret IS NULL THEN 'ไม่ได้เปิด' ELSE 'เปิดแล้ว' END AS two_factor, last_login_at FROM users WHERE role = 'admin' ORDER BY id");
    console.table(rows);
    return;
  }
  if (cmd === 'create') {
    const u = await users.createUser({ name: arg('name') || 'ผู้ดูแลระบบ', email: arg('email'), phone: arg('phone'), password: arg('password'), role: 'admin' }, { requirePhone: false });
    console.log(`สร้างแอดมินแล้ว: #${u.id} ${u.email || u.phone}`);
    return;
  }
  if (cmd === 'reset-password' || cmd === 'unlock' || cmd === 'disable-2fa') {
    const email = String(arg('email') || '').toLowerCase();
    const u = db.get('SELECT * FROM users WHERE email = ?', email);
    if (!u) throw new Error(`ไม่พบบัญชี ${email}`);
    if (cmd === 'reset-password') {
      users.validatePassword(arg('password'), 'password', { phone: u.phone, email: u.email });
      db.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', await hashPassword(arg('password')), db.nowIso(), u.id);
      users.destroyUserSessions(u.id);
      if (u.role === 'admin') users.removeBootstrapPasswordFile();
      console.log(`เปลี่ยนรหัสผ่านของ ${email} แล้ว`);
    } else if (cmd === 'disable-2fa') {
      db.run('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?', db.nowIso(), u.id);
      users.destroyUserSessions(u.id);
      require('../src/services/audit').log(null, 'user.2fa_reset', 'user', u.id, { by: 'cli' });
      console.log(`ปิดการยืนยันตัวตน 2 ชั้นของ ${email} แล้ว — เข้าสู่ระบบด้วยรหัสผ่านอย่างเดียวได้ แล้วควรเปิดใหม่ทันที`);
    } else {
      db.run("UPDATE users SET failed_logins = 0, locked_until = NULL, status = 'active', updated_at = ? WHERE id = ?", db.nowIso(), u.id);
      console.log(`ปลดล็อก ${email} แล้ว`);
    }
    return;
  }
  if (cmd === 'reconcile') {
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
    return;
  }
  console.log(`คำสั่งที่ใช้ได้:
  npm run admin -- list
  npm run admin -- create --email <อีเมล> --password <รหัสผ่าน> [--name <ชื่อ>]
  npm run admin -- reset-password --email <อีเมล> --password <รหัสผ่านใหม่>
  npm run admin -- unlock --email <อีเมล>
  npm run admin -- disable-2fa --email <อีเมล>
  npm run admin -- reconcile`);
}

main()
  .catch((err) => {
    console.error(`ผิดพลาด: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
