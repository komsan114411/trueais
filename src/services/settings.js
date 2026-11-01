'use strict';
// การตั้งค่าที่แอดมินแก้ได้จากหน้าเว็บ (เก็บในฐานข้อมูล) — schema นี้ใช้สร้างฟอร์มหน้าแอดมินอัตโนมัติ
const db = require('../db');
const { E } = require('../lib/errors');
const { randomToken } = require('../lib/security');

const GROUPS = {
  general: 'ทั่วไป',
  safety: 'ป้องกันความผิดพลาด',
  wallet: 'กระเป๋าเงิน / รับเงิน',
  provider: 'ผู้ให้บริการ (WonDD / HubZell)',
  mock: 'โหมดทดสอบ (Mock)',
};

const SCHEMA = {
  site_name: { type: 'string', default: 'TopUp Center', label: 'ชื่อเว็บไซต์', group: 'general', public: true, max: 60 },
  site_tagline: { type: 'string', default: 'เติมเงินมือถือ & แพ็กเกจเน็ต AIS • True • dtac', label: 'คำโปรยใต้ชื่อเว็บ', group: 'general', public: true, max: 120 },
  announcement: { type: 'text', default: '', label: 'ประกาศบนหน้าเว็บ (เว้นว่าง = ไม่แสดง)', group: 'general', public: true, max: 500 },
  support_line: { type: 'string', default: '', label: 'LINE ID สำหรับติดต่อ', group: 'general', public: true, max: 60 },
  support_phone: { type: 'string', default: '', label: 'เบอร์โทรสำหรับติดต่อ', group: 'general', public: true, max: 60 },
  registration_enabled: { type: 'boolean', default: true, label: 'เปิดรับสมัครสมาชิกใหม่', group: 'general', public: true },
  maintenance_mode: { type: 'boolean', default: false, label: 'ปิดปรับปรุงระบบ (หยุดรับรายการใหม่ทั้งหมด)', group: 'general', public: true },
  maintenance_message: { type: 'string', default: 'ระบบปิดปรับปรุงชั่วคราว กรุณาลองใหม่ภายหลัง', label: 'ข้อความแสดงตอนปิดปรับปรุง', group: 'general', public: true, max: 200 },

  duplicate_window_sec: { type: 'number', default: 120, min: 0, max: 86400, label: 'กันเติมซ้ำ: เบอร์ + ยอดเดียวกันภายในกี่วินาที', help: '0 = ปิดการตรวจ', group: 'safety' },
  order_rate_per_min: { type: 'number', default: 6, min: 1, max: 600, label: 'จำนวนรายการสูงสุดต่อนาที ต่อผู้ใช้ 1 คน (หน้าเว็บ)', group: 'safety' },
  api_rate_per_min: { type: 'number', default: 60, min: 1, max: 6000, label: 'จำนวนรายการสูงสุดต่อนาที ผ่าน API ร้านค้า', group: 'safety' },
  daily_limit_baht: { type: 'number', default: 5000, min: 0, max: 10000000, label: 'วงเงินใช้จ่ายสูงสุดต่อวัน ต่อผู้ใช้ (บาท)', help: '0 = ไม่จำกัด (ตั้งรายคนได้ที่หน้าผู้ใช้)', group: 'safety' },
  max_bulk_items: { type: 'number', default: 30, min: 1, max: 200, label: 'จำนวนเบอร์สูงสุดต่อการเติมหลายรายการ', group: 'safety', public: true },
  review_after_min: { type: 'number', default: 30, min: 1, max: 1440, label: 'แจ้งแอดมินเมื่อรายการค้างสถานะเกินกี่นาที', group: 'safety' },
  max_status_checks: { type: 'number', default: 12, min: 1, max: 100, label: 'เช็กสถานะอัตโนมัติสูงสุดกี่ครั้ง ก่อนส่งให้แอดมินตรวจ', group: 'safety' },
  breaker_threshold: { type: 'number', default: 5, min: 1, max: 100, label: 'หยุดรับรายการชั่วคราว เมื่อเชื่อมต่อผู้ให้บริการล้มเหลวติดกันกี่ครั้ง', group: 'safety' },
  breaker_cooldown_sec: { type: 'number', default: 300, min: 30, max: 86400, label: 'ระยะเวลาหยุดรับรายการชั่วคราว (วินาที)', group: 'safety' },

  deposit_min_baht: { type: 'number', default: 20, min: 1, max: 1000000, label: 'เติมเงินเข้ากระเป๋าขั้นต่ำ (บาท)', group: 'wallet', public: true },
  deposit_max_baht: { type: 'number', default: 50000, min: 1, max: 10000000, label: 'เติมเงินเข้ากระเป๋าสูงสุดต่อครั้ง (บาท)', group: 'wallet', public: true },
  deposit_unique_satang: { type: 'boolean', default: true, label: 'เพิ่มเศษสตางค์ให้ยอดโอนไม่ซ้ำกัน (ช่วยตรวจสลิปง่ายขึ้น)', group: 'wallet' },
  promptpay_id: { type: 'string', default: '', label: 'หมายเลขพร้อมเพย์รับเงิน (เบอร์มือถือ หรือเลขบัตร 13 หลัก)', group: 'wallet', max: 20 },
  promptpay_name: { type: 'string', default: '', label: 'ชื่อบัญชีพร้อมเพย์ (แสดงให้ลูกค้าตรวจสอบ)', group: 'wallet', public: true, max: 100 },
  bank_accounts: { type: 'text', default: '', label: 'บัญชีธนาคารสำหรับโอน (แสดงให้ลูกค้า)', group: 'wallet', public: true, max: 1000 },

  routing_mode: {
    type: 'string', default: 'priority', label: 'วิธีเลือกผู้ให้บริการ', group: 'provider', pattern: '^(priority|cheapest)$',
    options: [{ value: 'priority', label: 'ตามลำดับ (ใช้เจ้าแรกก่อน เจ้าถัดไปเป็นสำรอง)' }, { value: 'cheapest', label: 'ต้นทุนต่ำสุดก่อน (กำไรมากที่สุด)' }],
  },
  failover_enabled: { type: 'boolean', default: true, label: 'สลับไปผู้ให้บริการสำรองอัตโนมัติ เมื่อเจ้าที่เลือกไม่รับรายการ', help: 'สลับเฉพาะกรณีมั่นใจว่าเจ้าแรกยังไม่ได้ทำรายการ (ต่อไม่ติด/ปฏิเสธ) — กรณีไม่รู้ผล (เช่น หมดเวลารอ) จะไม่สลับ เพื่อกันเติมซ้ำ', group: 'provider' },
  provider_priority: { type: 'string', default: '', label: 'ลำดับผู้ให้บริการ (คั่นด้วย , เช่น hubzell,wondd)', help: 'เว้นว่าง = ตามลำดับใน .env (PROVIDERS)', group: 'provider', max: 200, pattern: '^$|^[a-z0-9_]+(,[a-z0-9_]+)*$' },
  providers_disabled: { type: 'string', default: '', label: 'ปิดใช้ผู้ให้บริการชั่วคราว (คั่นด้วย ,)', help: 'รายการใหม่จะไม่ถูกส่งไปเจ้าที่ปิด (รายการที่ส่งไปแล้วยังติดตามผลตามปกติ)', group: 'provider', max: 200, pattern: '^$|^[a-z0-9_]+(,[a-z0-9_]+)*$' },
  low_balance_baht: { type: 'number', default: 1000, min: 0, max: 10000000, label: 'แจ้งเตือนเมื่อเครดิตที่ผู้ให้บริการต่ำกว่า (บาท)', group: 'provider' },
  log_retention_days: { type: 'number', default: 90, min: 7, max: 3650, label: 'เก็บ log การเชื่อมต่อย้อนหลังกี่วัน', group: 'provider' },

  mock_success_rate: { type: 'number', default: 85, min: 0, max: 100, label: 'โอกาสเติมสำเร็จ (%)', group: 'mock' },
  mock_async_rate: { type: 'number', default: 50, min: 0, max: 100, label: 'โอกาสที่ผลมาทีหลังผ่าน callback (%)', group: 'mock' },
  mock_callback_delay_sec: { type: 'number', default: 5, min: 0, max: 600, label: 'เวลาก่อนส่ง callback (วินาที)', group: 'mock' },
  mock_timeout_rate: { type: 'number', default: 0, min: 0, max: 100, label: 'โอกาสจำลอง timeout (%)', group: 'mock' },
};

let cache = null;

function load() {
  cache = {};
  for (const row of db.all('SELECT key, value FROM settings')) {
    try { cache[row.key] = JSON.parse(row.value); } catch { /* ข้ามค่าที่เสีย */ }
  }
}

function all() {
  if (!cache) load();
  const out = {};
  for (const [k, s] of Object.entries(SCHEMA)) out[k] = k in cache ? cache[k] : s.default;
  return out;
}

const get = (key) => all()[key];

function coerce(key, value) {
  const s = Object.hasOwn(SCHEMA, key) ? SCHEMA[key] : null;
  if (!s) throw E.validation(`ไม่รู้จักการตั้งค่า "${String(key).slice(0, 40)}"`);
  if (s.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    throw E.validation(`${s.label}: ต้องเป็นเปิด/ปิด`, { field: key });
  }
  if (s.type === 'number') {
    // รับเฉพาะตัวเลข/ข้อความตัวเลข — ช่องว่าง, null, true/false ห้ามกลายเป็น 0 เงียบๆ (เช่น ปิดตัวกันรายการซ้ำโดยไม่ตั้งใจ)
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN;
    if (!Number.isFinite(n)) throw E.validation(`${s.label}: ต้องเป็นตัวเลข`, { field: key });
    if (!Number.isInteger(n)) throw E.validation(`${s.label}: ต้องเป็นจำนวนเต็ม`, { field: key });
    if (s.min !== undefined && n < s.min) throw E.validation(`${s.label}: ต้องไม่น้อยกว่า ${s.min}`, { field: key });
    if (s.max !== undefined && n > s.max) throw E.validation(`${s.label}: ต้องไม่เกิน ${s.max}`, { field: key });
    return n;
  }
  if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'number') {
    throw E.validation(`${s.label}: รูปแบบไม่ถูกต้อง`, { field: key });
  }
  const str = String(value ?? '').trim();
  if (key === 'promptpay_id') {
    // ตรวจด้วยกฎเดียวกับตอนสร้าง QR — หมายเลขผิด = ลูกค้าไม่มี QR หรือโอนเงินเข้าบัญชีคนอื่น
    try {
      return require('../lib/promptpay').normalizePromptPayId(str);
    } catch (err) {
      throw E.validation(`${s.label}: ${err.message}`, { field: key });
    }
  }
  if (s.max && str.length > s.max) throw E.validation(`${s.label}: ยาวเกิน ${s.max} ตัวอักษร`, { field: key });
  if (s.pattern && !new RegExp(s.pattern).test(str)) throw E.validation(`${s.label}: รูปแบบไม่ถูกต้อง`, { field: key });
  return str;
}

function update(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw E.validation('ข้อมูลการตั้งค่าไม่ถูกต้อง');
  const values = {};
  for (const [k, v] of Object.entries(patch)) values[k] = coerce(k, v);
  const merged = { ...all(), ...values };
  if (merged.deposit_min_baht > merged.deposit_max_baht) throw E.validation('ยอดเติมขั้นต่ำต้องไม่มากกว่ายอดสูงสุด');
  if ('provider_priority' in values || 'providers_disabled' in values) {
    // โหลดตอนใช้ (กัน require วนกัน: providers → mock → settings)
    const providers = require('../providers');
    const configured = providers.configured();
    for (const key of ['provider_priority', 'providers_disabled']) {
      for (const n of String(merged[key] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!configured.includes(n)) throw E.validation(`ไม่มีผู้ให้บริการ "${n}" ในระบบ (เปิดใช้อยู่: ${configured.join(', ')})`, { field: key });
      }
    }
    const disabled = new Set(String(merged.providers_disabled || '').split(',').map((s) => s.trim()).filter(Boolean));
    if (configured.every((n) => disabled.has(n))) throw E.validation('ต้องเปิดใช้ผู้ให้บริการอย่างน้อย 1 เจ้า', { field: 'providers_disabled' });
  }
  const now = db.nowIso();
  db.tx(() => {
    for (const [k, v] of Object.entries(values)) {
      db.run(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        k, JSON.stringify(v), now,
      );
    }
  });
  cache = null;
  return { changed: Object.keys(values), values: all() };
}

// ค่าภายในระบบ (ไม่แสดงในหน้าตั้งค่า) ขึ้นต้นด้วย _
function getInternal(key, def = undefined) {
  if (!cache) load();
  return key in cache ? cache[key] : def;
}

function setInternal(key, value) {
  db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    key, JSON.stringify(value), db.nowIso(),
  );
  if (cache) cache[key] = value;
}

function appSecret() {
  let s = getInternal('_app_secret');
  if (!s) {
    s = randomToken(32);
    setInternal('_app_secret', s);
  }
  return s;
}

function publicSettings() {
  const a = all();
  const out = {};
  for (const [k, s] of Object.entries(SCHEMA)) if (s.public) out[k] = a[k];
  out.promptpay_enabled = Boolean(a.promptpay_id);
  return out;
}

const adminSchema = () => ({
  groups: GROUPS,
  fields: Object.entries(SCHEMA).map(([key, s]) => ({ key, ...s })),
});

const resetCache = () => { cache = null; };

module.exports = { all, get, update, getInternal, setInternal, appSecret, publicSettings, adminSchema, resetCache, SCHEMA };
