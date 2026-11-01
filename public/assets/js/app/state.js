// สถานะกลางของหน้าเว็บลูกค้า: รายการสินค้า (catalog) + ผู้ใช้ที่ล็อกอิน
import { api, session, loadMe } from '../lib.js';

export const state = { catalog: null, catalogAt: 0, user: null };

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(what) {
  for (const fn of listeners) {
    try { fn(what); } catch (e) { console.error(e); }
  }
}

/** โหลด catalog (เก็บไว้ 30 วินาที) — มีสถานะระบบ เช่น ปิดปรับปรุง / หยุดรับรายการชั่วคราว */
export async function loadCatalog(force = false) {
  if (!force && state.catalog && Date.now() - state.catalogAt < 30000) return state.catalog;
  const c = await api.get('/api/catalog');
  state.catalog = c;
  state.catalogAt = Date.now();
  emit('catalog');
  return c;
}

/** ดึงข้อมูลผู้ใช้ล่าสุด (ยอดเงินในกระเป๋า) */
export async function refreshUser() {
  const had = Boolean(state.user);
  try {
    state.user = await loadMe();
  } catch {
    /* ใช้ค่าเดิม */
  }
  emit('user');
  // เซสชันหมดอายุระหว่างใช้งาน → พาไปหน้าเข้าสู่ระบบ (แทนที่หน้าจะพังเพราะไม่มีข้อมูลผู้ใช้)
  if (had && !state.user) window.dispatchEvent(new CustomEvent('session-expired'));
  return state.user;
}

export function setUser(u) {
  state.user = u;
  session.user = u;
  if (!u) session.csrf = null;
  emit('user');
}

export const networkOf = (code) =>
  state.catalog?.networks.find((n) => n.code === String(code || '').toUpperCase()) || null;

export const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : '#6b7280');

// ───────────── ร้าน (ผู้ให้บริการที่ลูกค้าเลือกได้ — แต่ละร้านมีส่วนลด/ยอดที่ขายของตัวเอง) ─────────────

export const shopList = () => state.catalog?.shops || [];
export const shopOf = (code) => (code ? shopList().find((s) => s.code === code) || null : null);
/** ข้อมูลร้านสำหรับเครือข่ายนี้ { discount_bp, amounts (null = ทุกยอดที่เครือข่ายกำหนด | [บาท]), custom } */
export const shopNet = (shop, netCode) => shop?.networks?.[String(netCode || '').toUpperCase()] || null;
/** ร้านนี้มีบริการเติมเงินค่ายนี้ไหม (amounts = [] คือไม่มียอดให้เลือกเลย) */
export const shopServes = (shop, netCode) => {
  const sn = shopNet(shop, netCode);
  return Boolean(sn) && (sn.amounts === null || sn.amounts === undefined || sn.amounts.length > 0);
};
/** ร้านที่ลูกค้าเลือกได้ตอนนี้ (ไม่ปิดชั่วคราว) */
export const shopOpen = (shop) => Boolean(shop) && !shop.paused;

// จำร้านที่ใช้ล่าสุดไว้ในเครื่องนี้ (ความสะดวกเท่านั้น — อ่าน/เขียนไม่ได้ก็ไม่เป็นไร)
const LAST_SHOP_KEY = 'topup.lastShop';
export function lastShop() {
  try { return localStorage.getItem(LAST_SHOP_KEY) || null; } catch { return null; }
}
export function rememberShop(code) {
  try { if (code) localStorage.setItem(LAST_SHOP_KEY, String(code)); } catch { /* ignore */ }
}

/** ข้อความ "ร้าน" ของรายการ + บอกเมื่อระบบส่งต่อร้านอื่นให้อัตโนมัติ */
export function shopNote(o) {
  if (!o) return '';
  if (o.shop_name && o.handled_by && o.handled_by !== o.shop_name) return `${o.shop_name} → ส่งต่อให้ ${o.handled_by} อัตโนมัติ (ราคาเดิม)`;
  return o.shop_name || o.handled_by || '';
}

/** เหตุผลที่ยังสั่งรายการไม่ได้ (null = สั่งได้) */
export function orderBlockReason() {
  const c = state.catalog;
  if (!c) return 'กำลังโหลดข้อมูล...';
  if (c.settings.maintenance_mode) return c.settings.maintenance_message || 'ระบบปิดปรับปรุงชั่วคราว';
  if (!c.mode.ready) return 'ระบบเติมเงินยังไม่พร้อมให้บริการ (ผู้ดูแลกำลังตั้งค่า)';
  if (c.mode.paused) return 'ระบบผู้ให้บริการขัดข้องชั่วคราว กรุณาลองใหม่ในอีกสักครู่';
  return null;
}

/** ตรวจลิงก์ ?next= ให้ไปได้เฉพาะหน้าในเว็บนี้ */
export function safeNext(next) {
  const n = String(next || '');
  return n.startsWith('/') && !n.startsWith('//') ? n : '/';
}
