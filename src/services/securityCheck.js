'use strict';
// ตรวจความปลอดภัยของการตั้งค่า — แสดงตอนเปิดระบบ และเป็นรายการตรวจในหน้าแดชบอร์ดแอดมิน
const config = require('../config');
const db = require('../db');
const { channels } = require('../lib/notify');

/** ค่าตั้งใน .env ที่เสี่ยง (ไม่ขึ้นกับผู้ใช้) */
function configWarnings() {
  const out = [];
  const tp = String(config.trustProxy || '').trim();
  if (tp && !/^\d+$/.test(tp) && tp !== 'true' && tp !== 'false' && /(^|,)\s*(0\.0\.0\.0\/0|::\/0)\s*(,|$)/.test(tp)) {
    out.push('TRUST_PROXY เชื่อทุก IP (0.0.0.0/0) — ใครก็ปลอม IP ผ่าน X-Forwarded-For ได้ ให้ใส่เฉพาะ IP/วงของ proxy จริง');
  }
  if (config.isProd && !config.publicUrl.startsWith('https://')) {
    out.push('PUBLIC_URL ยังไม่ใช่ https:// — ควรเปิดใช้ HTTPS ก่อนเปิดให้ลูกค้าใช้งานจริง (รหัสผ่านและคุกกี้จะถูกเข้ารหัส)');
  }
  if (config.isProd && !require('../providers').isLive()) {
    out.push('ยังเป็นโหมดทดสอบ (PROVIDER=mock) — รายการจะไม่ถูกเติมจริง ห้ามรับเงินลูกค้าจริงในโหมดนี้');
  }
  if (!config.isTest && require('../providers').configured().includes('hubzell') && config.provider.concurrency > 4) {
    out.push(`PROVIDER_CONCURRENCY=${config.provider.concurrency} สูง — HubZell บล็อก IP 24 ชม. ถ้าเจอข้อผิดพลาดบัญชีซ้ำ 5 ครั้งใน 5 นาที แนะนำไม่เกิน 4`);
  }
  if (config.webhookAllowPrivate && !config.isTest) {
    out.push('WEBHOOK_ALLOW_PRIVATE เปิดอยู่ — webhook ส่งเข้า IP ภายในได้ ใช้เฉพาะตอนทดสอบในเครื่องเท่านั้น');
  }
  if (config.admin.password && !config.isTest && db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").c > 0) {
    out.push('สร้างแอดมินแล้ว — ลบค่า ADMIN_PASSWORD ออกจากไฟล์ .env ได้เลย (ไม่ควรเก็บรหัสผ่านไว้ในไฟล์)');
  }
  return out;
}

/** รายการตรวจสำหรับแอดมินที่ล็อกอินอยู่ → [{ key, level: 'warn' | 'info', message }] */
function checklist(admin) {
  const users = require('./users');
  const backup = require('./backup');
  const items = configWarnings().map((message) => ({ key: 'config', level: 'warn', message }));
  if (users.bootstrapPasswordFileExists()) {
    items.push({ key: 'bootstrap_password', level: 'warn', message: 'ยังใช้รหัสผ่านแอดมินที่ระบบสุ่มให้ (ไฟล์ data/ADMIN-PASSWORD.txt) — เปลี่ยนรหัสผ่านแล้วระบบจะลบไฟล์ให้อัตโนมัติ' });
  }
  if (admin && !admin.totp_secret) {
    items.push({ key: 'admin_2fa', level: 'warn', message: 'บัญชีของคุณยังไม่ได้เปิดยืนยันตัวตน 2 ชั้น — แนะนำให้เปิดที่หน้า "บัญชีของฉัน" (ใช้แอป Google Authenticator)' });
  }
  const no2fa = db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active' AND totp_secret IS NULL").c;
  if (no2fa > (admin && !admin.totp_secret ? 1 : 0)) {
    items.push({ key: 'admins_2fa', level: 'info', message: `มีแอดมิน ${no2fa} คนที่ยังไม่เปิดยืนยันตัวตน 2 ชั้น` });
  }
  // ผู้ให้บริการ (ร้าน)
  const providers = require('../providers');
  for (const name of providers.configured()) {
    const p = providers.byName(name);
    const st = p.configStatus();
    if (!st.ready) items.push({ key: `provider_${name}`, level: 'warn', message: `${p.label} ยังตั้งค่าไม่ครบ (${st.missing.join(', ')}) — ระบบจะไม่ส่งรายการไปร้านนี้` });
    if (st.ready && p.capabilities.catalog === 'mapped') {
      const n = db.get('SELECT COUNT(*) AS c FROM provider_map WHERE provider = ? AND enabled = 1', name).c;
      if (!n) items.push({ key: `provider_${name}_map`, level: 'info', message: `${p.label} ยังไม่ได้จับคู่บริการ — ไปที่ "ผู้ให้บริการ & ร้าน" กด "ดึงรายการ" แล้วจับคู่ยอด/แพ็กเกจ` });
      if (!config.publicUrl.startsWith('https://')) items.push({ key: `provider_${name}_https`, level: 'info', message: `${p.label} ส่งผลกลับ (callback) ได้เฉพาะ URL สาธารณะ — ตั้ง PUBLIC_URL เป็น https:// ของเว็บจริง (ระหว่างนี้ระบบเช็กสถานะเองอัตโนมัติ)` });
    }
  }
  const ch = channels();
  if (!ch.line && !ch.telegram) {
    items.push({ key: 'notify', level: 'info', message: 'ยังไม่ได้ตั้งค่าแจ้งเตือนผ่าน LINE หรือ Telegram (.env) — จะไม่รู้ทันทีเมื่อมีรายการต้องตรวจสอบ' });
  }
  if (!config.isTest) {
    const latest = backup.list()[0];
    if (!latest || Date.now() - Date.parse(latest.created_at) > 48 * 3600000) {
      items.push({ key: 'backup', level: 'warn', message: 'ไม่มีไฟล์สำรองข้อมูลในช่วง 2 วันที่ผ่านมา — กด "สำรองข้อมูลตอนนี้" ที่หน้าตั้งค่า และควรคัดลอกโฟลเดอร์ data/backups ไปเก็บที่อื่นด้วย' });
    }
  }
  return items;
}

module.exports = { configWarnings, checklist };
