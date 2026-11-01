'use strict';
/**
 * ทะเบียนผู้ให้บริการ — ใช้ได้หลายเจ้าพร้อมกัน (PROVIDERS=hubzell,wondd)
 *   configured() = เจ้าที่เปิดใช้ใน .env ตามลำดับ
 *   ordered()    = ลำดับจริงที่ใช้เลือก (แอดมินจัดลำดับ/ปิดชั่วคราวได้ในหน้าตั้งค่า)
 * การเลือกเจ้าสำหรับแต่ละรายการอยู่ที่ services/router.js
 */
const config = require('../config');
const mock = require('./mock');
const wondd = require('./wondd');
const hubzell = require('./hubzell');

const registry = { mock, mock2: mock.mock2, wondd, hubzell };

function configured() {
  const names = [...new Set(config.provider.list)];
  if (!names.length) throw new Error('ยังไม่ได้ตั้งผู้ให้บริการ (PROVIDER หรือ PROVIDERS ใน .env)');
  for (const n of names) {
    if (!Object.hasOwn(registry, n)) throw new Error(`ไม่รู้จักผู้ให้บริการ "${n}" (ใช้ได้: ${Object.keys(registry).join(', ')})`);
  }
  // ห้ามปนโหมดทดสอบกับผู้ให้บริการจริงเด็ดขาด (ไม่ว่าจะเปิดด้วย start.bat / npm start / Docker)
  // — รายการที่ถูกส่งต่อไปโหมดทดสอบจะ "สำเร็จ" ทั้งที่ไม่ได้เติมจริง ลูกค้าเสียเงินฟรี (ยกเว้นตอนรันชุดทดสอบอัตโนมัติ)
  const isMock = (n) => n === 'mock' || n === 'mock2';
  if (names.some(isMock) && names.some((n) => !isMock(n)) && !config.isTest) {
    throw new Error(`ห้ามใช้ผู้ให้บริการทดสอบ (mock/mock2) ร่วมกับผู้ให้บริการจริงใน PROVIDERS (ตอนนี้: ${names.join(',')}) — ให้เหลือเฉพาะเจ้าจริง เช่น PROVIDERS=hubzell หรือ PROVIDERS=hubzell,wondd`);
  }
  return names;
}

/** ลำดับที่ใช้จริง: ตามที่แอดมินจัดไว้ (provider_priority) แล้วต่อด้วยเจ้าที่เหลือ ไม่รวมเจ้าที่ปิดชั่วคราว */
function ordered() {
  const settings = require('../services/settings');
  const all = configured();
  const pri = String(settings.get('provider_priority') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const disabled = new Set(String(settings.get('providers_disabled') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out = [...pri.filter((n) => all.includes(n)), ...all.filter((n) => !pri.includes(n))];
  return [...new Set(out)].filter((n) => !disabled.has(n));
}

const byName = (name) => (Object.hasOwn(registry, String(name)) ? registry[name] : null);

/** เจ้าหลักสำหรับหน้าจอ/ระบบเดิม (เจ้าแรกในลำดับ) */
function primary() {
  const list = ordered();
  return registry[list[0] || configured()[0]];
}

const active = primary;

/** โหมดจริง = มีผู้ให้บริการจริง (ไม่ใช่ mock) อย่างน้อย 1 เจ้า */
const isLive = () => configured().some((n) => n !== 'mock' && n !== 'mock2');

module.exports = { active, primary, byName, isLive, configured, ordered, registry };
