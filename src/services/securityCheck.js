'use strict';
// ตรวจความปลอดภัย + ความพร้อมเปิดร้าน — แสดงตอนเปิดระบบ และเป็นรายการตรวจ "พร้อมเปิดร้านหรือยัง" ในหน้าแดชบอร์ดแอดมิน
const config = require('../config');
const db = require('../db');
const { channels } = require('../lib/notify');

/** PUBLIC_URL เป็นที่อยู่บนอินเทอร์เน็ตจริง (ไม่ใช่เครื่องตัวเอง/วงแลน) = กำลังเปิดให้ลูกค้าใช้งานจริง */
function isPublicSite() {
  let host;
  try { host = new URL(config.publicUrl).hostname.toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test')) return false;
  if (host === '::1' || host === '[::1]' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

// มีคำขอที่ผ่าน proxy (มี X-Forwarded-For) ทั้งที่ยังไม่ได้ตั้ง TRUST_PROXY → ทุกคนจะถูกมองเป็น IP เดียวกัน
let forwardedSeen = false;
function noteRequest(req) {
  if (!forwardedSeen && req.headers['x-forwarded-for'] && !String(config.trustProxy || '').trim()) forwardedSeen = true;
}

const onRailway = () => config.platform === 'railway';
/** ที่แก้ค่าตั้งของระบบ: Railway = หน้า Variables ของบริการ, เครื่องทั่วไป = ไฟล์ .env */
const envWhere = () => (onRailway() ? 'Variables ของ Railway' : 'ไฟล์ .env');
// ปิดระบบอย่างปลอดภัยใช้เวลาสูงสุด ~32 วินาที (รอรายการที่กำลังส่งให้เสร็จ) — Railway ตั้งต้นให้ 0 วินาที = ถูกบังคับปิดทันที
const MIN_DRAINING_SECONDS = 35;

/**
 * ค่าตั้งที่เสี่ยง (ไม่ขึ้นกับผู้ใช้)
 *   includeEnv = รวมคำเตือนค่าที่พิมพ์ผิด (ตอนเปิดระบบ server.js แสดงส่วนนั้นแยกไว้แล้ว จึงส่ง false)
 */
function configWarnings({ includeEnv = true } = {}) {
  // ค่าตั้งที่พิมพ์ผิด (ระบบใช้ค่าเริ่มต้นแทน) — แสดงในหน้าแดชบอร์ดด้วย ไม่ใช่แค่ในหน้าต่างเปิดระบบ
  const out = includeEnv && Array.isArray(config.warnings) ? config.warnings.map((w) => `${onRailway() ? 'ค่าตั้ง' : 'ไฟล์ .env'}: ${w}`) : [];
  const tp = String(config.trustProxy || '').trim();
  if (tp && !/^\d+$/.test(tp) && tp !== 'true' && tp !== 'false' && /(^|,)\s*(0\.0\.0\.0\/0|::\/0)\s*(,|$)/.test(tp)) {
    out.push('TRUST_PROXY เชื่อทุก IP (0.0.0.0/0) — ใครก็ปลอม IP ผ่าน X-Forwarded-For ได้ ให้ใส่เฉพาะ IP/วงของ proxy จริง');
  }
  if (forwardedSeen) {
    out.push(`เว็บนี้อยู่หลัง proxy (เช่น Cloudflare / Nginx / Railway) แต่ยังไม่ได้ตั้ง TRUST_PROXY — ระบบจะเห็นลูกค้าทุกคนเป็น IP เดียวกัน (การจำกัดความถี่/ล็อกการเข้าสู่ระบบจะกระทบทุกคน) ตั้ง TRUST_PROXY=1 ใน ${envWhere()}`);
  }
  if (onRailway() && config.drainingSeconds < MIN_DRAINING_SECONDS) {
    out.push(`ตั้ง RAILWAY_DEPLOYMENT_DRAINING_SECONDS=40 ใน Variables ของ Railway (ตอนนี้ ${config.drainingSeconds} วินาที) — ไม่อย่างนั้นทุกครั้งที่ deploy ระบบจะถูกปิดทันที รายการที่กำลังส่งไปร้านจะค้างแบบ "ไม่ทราบผล" ต้องตรวจเองทีละรายการ`);
  }
  if (isPublicSite() && !config.publicUrl.startsWith('https://')) {
    out.push('PUBLIC_URL ยังไม่ใช่ https:// — ต้องเปิดใช้ HTTPS ก่อนให้ลูกค้าใช้งานจริง (รหัสผ่านและคุกกี้จะถูกเข้ารหัส)');
  }
  if ((config.isProd || isPublicSite()) && !require('../providers').isLive()) {
    out.push('ยังเป็นโหมดทดสอบ (mock) — รายการจะไม่ถูกเติมจริง ห้ามรับเงินลูกค้าจริงในโหมดนี้');
  }
  if (!config.isTest && require('../providers').configured().includes('hubzell') && config.provider.concurrency > 4) {
    out.push(`PROVIDER_CONCURRENCY=${config.provider.concurrency} สูง — HubZell บล็อก IP 24 ชม. ถ้าเจอข้อผิดพลาดบัญชีซ้ำ 5 ครั้งใน 5 นาที แนะนำไม่เกิน 4`);
  }
  if (config.webhookAllowPrivate && !config.isTest) {
    out.push('WEBHOOK_ALLOW_PRIVATE เปิดอยู่ — webhook ส่งเข้า IP ภายในได้ ใช้เฉพาะตอนทดสอบในเครื่องเท่านั้น');
  }
  if (config.admin.password && !config.isTest && db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").c > 0) {
    out.push(`สร้างแอดมินแล้ว — ลบค่า ADMIN_PASSWORD ออกจาก ${envWhere()} ได้เลย (ไม่ควรเก็บรหัสผ่านไว้ในค่าตั้ง)`);
  }
  return out;
}

/**
 * รายการตรวจสำหรับแอดมินที่ล็อกอินอยู่
 * → [{ key, level: 'warn' | 'info' | 'ok', message, link?, group: 'setup' | 'security' }]
 *   setup = ความพร้อมเปิดร้าน (รับเงิน / ผู้ให้บริการ / ราคา / แจ้งเตือน / สำรองข้อมูล) · security = ความปลอดภัยของบัญชีและระบบ
 *   link = หน้าที่ไปแก้ได้ (#/... = หลังบ้าน, /#/... = หน้าเว็บลูกค้า เช่น บัญชีของฉัน)
 */
function checklist(admin) {
  const users = require('./users');
  const backup = require('./backup');
  const settings = require('./settings');
  const providers = require('../providers');
  const shops = require('./shops');
  const catalog = require('./catalog');
  const credentials = require('./credentials');
  const s = settings.all();
  const items = [];
  const add = (group, key, level, message, link) => items.push({ key, level, message, group, ...(link ? { link } : {}) });

  // ───── ความปลอดภัย ─────
  for (const message of configWarnings()) add('security', 'config', 'warn', message);
  if (users.bootstrapPasswordFileExists()) {
    add('security', 'bootstrap_password', 'warn', 'ยังใช้รหัสผ่านแอดมินที่ระบบสุ่มให้ (ไฟล์ data/ADMIN-PASSWORD.txt) — เปลี่ยนรหัสผ่านแล้วระบบจะลบไฟล์ให้อัตโนมัติ', '/#/account');
  }
  if (admin && !admin.totp_secret) {
    add('security', 'admin_2fa', 'warn', 'บัญชีของคุณยังไม่ได้เปิดยืนยันตัวตน 2 ชั้น — เปิดที่หน้า "บัญชีของฉัน" (ใช้แอป Google Authenticator)', '/#/account');
  } else if (admin) {
    add('security', 'admin_2fa', 'ok', 'บัญชีของคุณเปิดยืนยันตัวตน 2 ชั้นแล้ว');
  }
  const no2fa = db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active' AND totp_secret IS NULL").c;
  if (no2fa > (admin && !admin.totp_secret ? 1 : 0)) {
    add('security', 'admins_2fa', 'info', `มีแอดมิน ${no2fa} คนที่ยังไม่เปิดยืนยันตัวตน 2 ชั้น`, '#/users');
  }

  // ───── รับเงินจากลูกค้า ─────
  if (!s.promptpay_id && !s.bank_accounts) {
    add('setup', 'payment', 'warn', 'ยังไม่ได้ตั้งช่องทางรับเงิน (พร้อมเพย์ / บัญชีธนาคาร) — ลูกค้าเติมเงินเข้ากระเป๋าไม่ได้', '#/settings');
  } else {
    add('setup', 'payment', 'ok', s.promptpay_id ? 'ตั้งพร้อมเพย์รับเงินแล้ว (กด "ทดสอบ QR 1 บาท" ที่หน้าตั้งค่า แล้วตรวจชื่อผู้รับในแอปธนาคาร)' : 'ตั้งบัญชีธนาคารรับเงินแล้ว');
  }
  if (!s.support_line && !s.support_phone) {
    add('setup', 'support', 'info', 'ยังไม่ได้ใส่ช่องทางติดต่อร้าน (LINE / เบอร์โทร) — ลูกค้าจะติดต่อไม่ได้เมื่อมีปัญหา', '#/settings');
  }

  // ───── ผู้ให้บริการ / ร้าน ─────
  if (!providers.isLive()) {
    add('setup', 'live', isPublicSite() ? 'warn' : 'info', `ยังเป็นโหมดทดสอบ (ร้านทดสอบ) — รายการจะไม่ถูกเติมจริง ตั้ง PROVIDERS ใน ${envWhere()} เป็นร้านจริง แล้วใส่คีย์ร้านที่หน้า "ผู้ให้บริการ & ร้าน" ก่อนเปิดร้าน (ขั้นตอนใน docs/GO-LIVE.md)`, '#/providers');
  }
  // คีย์ที่ใส่ในหลังบ้านแต่ถอดรหัสไม่ได้ (ไฟล์กุญแจหาย/เปลี่ยน เช่น ย้ายเครื่อง หรือกู้จากไฟล์สำรอง) → ระบบใช้ค่าจาก environment แทน
  const lost = credentials.unreadableGroups();
  if (lost.length) {
    add('setup', 'credentials_unreadable', 'warn', `คีย์ที่บันทึกไว้ในหลังบ้านใช้ไม่ได้: ${lost.join(', ')} — ไฟล์กุญแจเข้ารหัส (data/credentials.key) หายหรือเปลี่ยน ให้ใส่คีย์ใหม่อีกครั้ง`, '#/providers');
  }
  // ร้านจริงรับคำขอเฉพาะจาก IP ที่ลงทะเบียนไว้ — Railway แผน Hobby เปลี่ยน IP ขาออกได้ทุกครั้งที่ deploy
  const ipNote = onRailway() ? ' — บน Railway ต้องใช้แผน Pro แล้วเปิด Static Outbound IPs (Settings → Networking) และแจ้ง IP ทุกตัวที่ Railway แสดง' : '';
  const ipHow = { wepay: 'แจ้ง IP ขาออกของเซิร์ฟเวอร์ให้ wePAY ลงทะเบียน', hubzell: 'เพิ่ม IP ขาออกของเซิร์ฟเวอร์ใน IP Whitelist ที่หน้า Developer ของ HubZell' };
  let providersOk = true;
  for (const name of providers.configured()) {
    const p = providers.byName(name);
    const st = p.configStatus();
    if (!st.ready) {
      providersOk = false;
      const how = credentials.groupView(name) ? 'กด "ใส่คีย์ร้าน" ที่การ์ดร้านนี้ในหน้า "ผู้ให้บริการ & ร้าน"' : `แก้ใน ${envWhere()} แล้วรีสตาร์ทระบบ`;
      add('setup', `provider_${name}`, 'warn', `${p.label} ยังตั้งค่าไม่ครบ (${st.missing.join(', ')}) — ${how} · ระหว่างนี้ระบบไม่ส่งรายการไปร้านนี้`, '#/providers');
    }
    if (st.ready && p.capabilities.catalog === 'mapped') {
      const n = db.get('SELECT COUNT(*) AS c FROM provider_map WHERE provider = ? AND enabled = 1', name).c;
      if (!n) {
        providersOk = false;
        add('setup', `provider_${name}_map`, 'warn', `${p.label} ยังไม่ได้จับคู่บริการ — ไปที่ "ผู้ให้บริการ & ร้าน" กด "ดึงรายการ" แล้วจับคู่ยอด/แพ็กเกจ`, '#/providers');
      }
      if (!config.publicUrl.startsWith('https://')) {
        add('setup', `provider_${name}_https`, 'info', `${p.label} ส่งผลกลับ (callback) ได้เฉพาะ URL สาธารณะ — ตั้ง PUBLIC_URL เป็น https:// ของเว็บจริง (ระหว่างนี้ระบบเช็กสถานะเองอัตโนมัติ)`, '#/providers');
      }
    }
    if (st.ready && name === 'wepay') {
      if (!config.publicUrl.startsWith('https://')) {
        add('setup', 'provider_wepay_https', 'warn', 'wePAY แจ้งผลรายการกลับมาที่ PUBLIC_URL — ต้องเป็น https:// ที่เปิดจากอินเทอร์เน็ตได้ (ไม่อย่างนั้นรายการที่หมดเวลารอจะรู้ผลไม่ได้ ต้องตรวจเองทุกรายการ)', '#/providers');
      }
      if (!config.wepay.discountsSet) {
        add('setup', 'provider_wepay_discounts', 'info', 'wePAY: ใส่เงินคืนของบัญชีคุณที่ปุ่ม "คีย์ร้าน" ของ wePAY (ตอนนี้ใช้ค่ามาตรฐาน AIS 1% / dtac 3% / True 3%) — ระบบใช้คิดต้นทุนกันขายขาดทุน', '#/providers');
      }
    }
    // เชื่อมต่อร้านจริงได้หรือยัง: เช็กเครดิตสำเร็จ = คีย์ถูก + IP ลงทะเบียนแล้ว (ระบบเช็กทุก 5 นาที)
    if (st.ready && Object.hasOwn(ipHow, name)) {
      const bal = settings.getInternal(require('./providerStatus').balanceKey(name), null);
      const fresh = Boolean(bal?.checked_at) && Date.now() - Date.parse(bal.checked_at) < 24 * 3600000;
      if (fresh && !bal.error) {
        add('setup', `provider_${name}_conn`, 'ok', `เชื่อมต่อ ${p.label} สำเร็จ (คีย์ถูกต้อง และ IP ของเซิร์ฟเวอร์ลงทะเบียนแล้ว) — ทดสอบเติมยอดเล็กกับเบอร์ตัวเองก่อนเปิดขาย`);
      } else if (fresh) {
        providersOk = false;
        add('setup', `provider_${name}_conn`, 'warn', `เชื่อมต่อ ${p.label} ไม่สำเร็จ: ${String(bal.error).slice(0, 160)} — ตรวจคีย์ และ${ipHow[name]}${ipNote}`, '#/providers');
      } else {
        add('setup', `provider_${name}_conn`, 'info', `${p.label}: ${ipHow[name]}${ipNote} แล้วกด "เช็กเครดิต" ที่หน้าผู้ให้บริการ`, '#/providers');
      }
    }
  }
  if (providersOk && providers.isLive()) add('setup', 'providers', 'ok', 'ผู้ให้บริการพร้อมรับรายการ');

  // ───── ราคา: ร้านที่ส่วนลดเกินสูงสุด / การจับคู่ที่ขาดทุน / แพ็กเกจตัวอย่าง ─────
  const nets = catalog.listNetworks();
  const over = [];
  for (const code of shops.visible()) {
    for (const n of nets) {
      if (shops.discountBp(code, n) > shops.maxDiscountBp(code, n)) over.push(`${shops.displayName(code)} ${n.name}`);
    }
  }
  if (over.length) {
    add('setup', 'shop_over_max', 'warn', `ส่วนลดเกินสูงสุด (ขายต่ำกว่าต้นทุน — ลูกค้าจะสั่งร้านนี้ไม่ได้): ${over.slice(0, 6).join(', ')}${over.length > 6 ? ' ...' : ''}`, '#/providers?tab=shops');
  }
  const lossMaps = db.all("SELECT * FROM provider_map WHERE enabled = 1").filter((m) => {
    try { return m.cost > require('./providerMap').sellPrice(m); } catch { return false; }
  });
  if (lossMaps.length) add('setup', 'map_loss', 'warn', `มีการจับคู่บริการที่ต้นทุนสูงกว่าราคาขาย ${lossMaps.length} รายการ (ระบบจะไม่ใช้จนกว่าจะแก้ราคา)`, '#/providers');
  if (providers.isLive() && db.get('SELECT COUNT(*) AS c FROM products WHERE is_demo = 1').c) {
    add('setup', 'demo_products', 'info', 'ยังมีแพ็กเกจตัวอย่างในระบบ (ไม่แสดงให้ลูกค้าในโหมดจริง) — ลบได้ที่หน้า "สินค้า & เครือข่าย"', '#/catalog');
  }

  // ───── แจ้งเตือน ─────
  const ch = channels();
  if (!ch.line && !ch.telegram) {
    add('setup', 'notify', 'info', 'ยังไม่ได้ตั้งค่าแจ้งเตือนผ่าน LINE หรือ Telegram (ใส่ token ได้ที่หน้าตั้งค่า → แจ้งเตือนแอดมิน) — จะไม่รู้ทันทีเมื่อมีรายการต้องตรวจสอบหรือสลิปรออนุมัติ', '#/settings?focus=notify');
  } else {
    add('setup', 'notify', 'ok', 'ตั้งค่าแจ้งเตือนแล้ว (กด "ส่งข้อความทดสอบ" เพื่อตรวจว่าได้รับจริง)', '#/settings');
  }

  // ───── สำรองข้อมูล ─────
  if (!config.isTest) {
    const latest = backup.list()[0];
    if (!latest || Date.now() - Date.parse(latest.created_at) > 48 * 3600000) {
      add('setup', 'backup', 'warn', 'ไม่มีไฟล์สำรองข้อมูลในช่วง 2 วันที่ผ่านมา — กด "สำรองข้อมูลตอนนี้" ที่หน้าตั้งค่า', '#/settings');
    }
    const dl = settings.getInternal('_last_backup_download', null);
    if (!dl || Date.now() - Date.parse(dl) > 7 * 86400000) {
      add('setup', 'backup_offsite', 'info', onRailway()
        ? 'ยังไม่ได้ดาวน์โหลดไฟล์สำรองไปเก็บนอก Railway ในสัปดาห์นี้ — ถ้าบริการ Railway มีปัญหาหรือบัญชีถูกระงับ (เช่น ค้างชำระ) ข้อมูลลูกค้าและยอดเงินจะหายทั้งหมด (ดาวน์โหลดได้ที่หน้าตั้งค่า)'
        : 'ยังไม่ได้ดาวน์โหลดไฟล์สำรองไปเก็บนอกเครื่องในสัปดาห์นี้ — ถ้าเครื่องเสีย/หาย ข้อมูลจะหายทั้งหมด (ดาวน์โหลดได้ที่หน้าตั้งค่า)', '#/settings');
    } else {
      add('setup', 'backup_offsite', 'ok', `ดาวน์โหลดไฟล์สำรองเก็บนอก${onRailway() ? ' Railway' : 'เครื่อง'}แล้วในสัปดาห์นี้`);
    }
  }
  return items;
}

module.exports = { configWarnings, checklist, noteRequest, isPublicSite };
