'use strict';
/**
 * Circuit breaker แยกตามผู้ให้บริการ
 * - เชื่อมต่อล้มเหลวติดกันหลายครั้ง → พักผู้ให้บริการนั้นชั่วคราว (รายการใหม่จะไปเจ้าสำรองแทน ถ้ามี)
 * - ปัญหาการตั้งค่า/บัญชี (เช่น รหัสผิด, KYC ยังไม่ผ่าน, IP ไม่ได้ whitelist) → พักทันทีเป็นเวลานาน + แจ้งแอดมิน
 *   (HubZell บล็อก IP 24 ชม. ถ้าโดน KYC_NOT_APPROVED ซ้ำ 5 ครั้งใน 5 นาที — ต้องหยุดยิงทันที)
 * - พักนานตั้งแต่ 5 นาทีขึ้นไป → บันทึกลงฐานข้อมูล (รีสตาร์ทเซิร์ฟเวอร์แล้วยังพักอยู่ ไม่กลับไปยิงซ้ำ)
 */
const settings = require('./settings');
const { alertAdmin } = require('../lib/notify');

const states = new Map();
const PERSIST_MIN_SEC = 300;
const savedKey = (key) => `_breaker_${key}`;

function st(name) {
  const key = String(name || 'default');
  if (!states.has(key)) {
    const s = { consecutive: 0, openUntil: 0, lastError: null, openedAt: null, reason: null };
    const saved = settings.getInternal(savedKey(key), null);
    if (saved && Number(saved.until) > Date.now()) {
      s.openUntil = Number(saved.until);
      s.openedAt = saved.openedAt || null;
      s.reason = saved.reason || null;
    }
    states.set(key, s);
  }
  return states.get(key);
}

const isOpen = (name) => Date.now() < st(name).openUntil;

function open(name, seconds, reason) {
  const s = st(name);
  const until = Date.now() + Math.max(1, seconds) * 1000;
  if (until > s.openUntil) {
    s.openUntil = until;
    s.openedAt = new Date().toISOString();
  }
  s.reason = reason;
  if (seconds >= PERSIST_MIN_SEC) settings.setInternal(savedKey(String(name || 'default')), { until: s.openUntil, openedAt: s.openedAt, reason });
}

/**
 * บันทึกผลการเชื่อมต่อ
 *   result.trip = { seconds, reason } → พักทันที (ปัญหาฝั่งผู้ให้บริการ/การตั้งค่า)
 *   result.transport / notSent       → นับความล้มเหลวติดกัน ครบเกณฑ์แล้วพัก
 *   อย่างอื่น                         → เชื่อมต่อได้ปกติ รีเซ็ตตัวนับ
 */
function record(name, result) {
  const s = st(name);
  if (result?.local) return; // ระบบเราปฏิเสธเอง (ยังไม่ได้ติดต่อผู้ให้บริการ) — ไม่เกี่ยวกับความพร้อมของผู้ให้บริการ
  if (result?.trip) {
    s.lastError = result.message || result.trip.reason;
    open(name, result.trip.seconds, result.trip.reason);
    alertAdmin(`breaker-${name}-${result.trip.reason}`, `พักผู้ให้บริการ ${name} ${Math.round(result.trip.seconds / 60)} นาที: ${result.trip.reason}\n${result.message || ''}\n(รายการใหม่จะส่งไปผู้ให้บริการสำรองถ้ามี)`, { cooldownSec: 600 });
    return;
  }
  if (result && (result.transport || result.notSent)) {
    s.consecutive += 1;
    s.lastError = result.message || 'connection error';
    const threshold = settings.get('breaker_threshold');
    if (s.consecutive >= threshold && !isOpen(name)) {
      const cooldown = settings.get('breaker_cooldown_sec');
      open(name, cooldown, `เชื่อมต่อล้มเหลวติดกัน ${s.consecutive} ครั้ง`);
      alertAdmin(`breaker-${name}`, `เชื่อมต่อผู้ให้บริการ ${name} ล้มเหลวติดกัน ${s.consecutive} ครั้ง — พักชั่วคราว ${cooldown} วินาที (รายการใหม่จะส่งไปผู้ให้บริการสำรองถ้ามี)\nล่าสุด: ${s.lastError}`, { cooldownSec: 60 });
    }
    return;
  }
  s.consecutive = 0;
}

/** รีเซ็ต — ไม่ระบุชื่อ = ทุกเจ้า */
function reset(name) {
  const keys = name === undefined || name === null
    ? new Set([...states.keys(), ...Object.keys(require('../providers').registry)]) // โหลดตอนใช้ (กัน require วนกัน)
    : new Set([String(name)]);
  for (const k of keys) {
    states.delete(k);
    if (settings.getInternal(savedKey(k), null)) settings.setInternal(savedKey(k), null);
  }
}

function snapshot(name) {
  const s = st(name);
  return {
    open: isOpen(name),
    consecutiveFailures: s.consecutive,
    openUntil: s.openUntil ? new Date(s.openUntil).toISOString() : null,
    openedAt: s.openedAt,
    reason: isOpen(name) ? s.reason : null,
    lastError: s.lastError,
  };
}

/** ใช้ในการทดสอบเท่านั้น: ล้างสถานะในหน่วยความจำ (จำลองการรีสตาร์ทเซิร์ฟเวอร์ — ค่าที่บันทึกในฐานข้อมูลยังอยู่) */
const _forgetMemory = () => states.clear();

module.exports = { isOpen, record, open, reset, snapshot, _forgetMemory };
