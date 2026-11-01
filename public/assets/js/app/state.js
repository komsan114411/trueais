// สถานะกลางของหน้าเว็บลูกค้า: รายการสินค้า (catalog) + ผู้ใช้ที่ล็อกอิน
import { api, session, loadMe, qs, raw, inkOf } from '../lib.js';

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
/**
 * ตัวแปร CSS สีของเครือข่ายสำหรับ style="" : --net (สีแบรนด์ ใช้กับแถบ/เส้นขอบ)
 * + --net-ink (สีเข้มขึ้น ใช้เป็นพื้นของตัวอักษรสีขาว / สีตัวอักษรบนพื้นอ่อน ให้อ่านง่าย)
 */
export const netVars = (color) => {
  const c = safeColor(color);
  return raw(`--net:${c};--net-ink:${inkOf(c)}`);
};

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

// จำร้านที่ใช้ล่าสุดไว้ในเครื่องนี้ แยกตามบัญชี (ความสะดวกเท่านั้น — อ่าน/เขียนไม่ได้ก็ไม่เป็นไร)
const LAST_SHOP_KEY = 'topup.lastShop';
const perUser = (key) => `${key}.${state.user?.id || 'guest'}`;
export function lastShop() {
  try { return localStorage.getItem(perUser(LAST_SHOP_KEY)) || null; } catch { return null; }
}
export function rememberShop(code) {
  try { if (code) localStorage.setItem(perUser(LAST_SHOP_KEY), String(code)); } catch { /* ignore */ }
}

// ───────────── เบอร์ที่เคยทำรายการล่าสุด (กดเลือกได้ทันที ไม่ต้องพิมพ์) ─────────────

let recentCache = { uid: null, at: 0, list: [] };
/** [{ phone, name, network, network_confirmed, shop, last_topup_amount, last_package_id, count, last_at }] — เก็บไว้ 60 วินาที */
export async function recentNumbers(force = false) {
  const uid = state.user?.id;
  if (!uid) return [];
  if (!force && recentCache.uid === uid && Date.now() - recentCache.at < 60000) return recentCache.list;
  try {
    const list = await api.get('/api/phonebook/recent');
    recentCache = { uid, at: Date.now(), list: Array.isArray(list) ? list : [] };
  } catch {
    return recentCache.uid === uid ? recentCache.list : [];
  }
  return recentCache.list;
}
/** หลังสั่งรายการใหม่ → รายการเบอร์ล่าสุด / ประวัติของเบอร์เปลี่ยน */
export const forgetRecentNumbers = () => {
  recentCache = { uid: null, at: 0, list: [] };
  histCache.clear();
};

// ───────────── ประวัติของเบอร์ (ใช้เลือก/ตรวจเครือข่ายให้ตรงกับเบอร์ — กันเติมผิดเครือข่าย) ─────────────

const histCache = new Map();
const histOrder = (o) => (o ? { ref: o.ref, network: o.network, status: o.status, final: Boolean(o.final), shop: o.shop || null, at: o.created_at } : null);
/**
 * ประวัติการทำรายการของเบอร์นี้ในบัญชีนี้ (เก็บไว้ 60 วินาที)
 *   null      = ไม่เคยทำรายการเบอร์นี้เลย
 *   undefined = ตรวจไม่ได้ (เช่น เน็ตหลุด) — อย่าสรุปว่าเป็นเบอร์ใหม่
 *   { network, confirmed, at, last }
 *     confirmed = true  → network คือเครือข่ายของรายการ "สำเร็จ" ล่าสุด (at = เวลาที่สำเร็จ)
 *     confirmed = false → ยังไม่เคยสำเร็จ: network = เครือข่ายของรายการล่าสุด (ให้ลูกค้าตรวจเอง ไม่เลือกให้)
 *     last = รายการล่าสุดของเบอร์นี้ (ทุกสถานะ) { ref, network, status, final, shop, at }
 */
export async function phoneHistory(phone) {
  const uid = state.user?.id;
  if (!uid || !phone) return undefined;
  const key = `${uid}|${phone}`;
  const hit = histCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.v;
  // undefined = ค้นไม่สำเร็จ · null = ไม่พบ
  const find = (status) => api.get(`/api/orders${qs({ q: phone, status, pageSize: 5 })}`, { timeout: 15000 })
    .then((d) => (d?.rows || []).find((o) => o.phone === phone) || null, () => undefined);
  const [ok, last] = await Promise.all([find('success'), find('')]);
  let v;
  if (ok) v = { network: ok.network, confirmed: true, at: ok.completed_at || ok.created_at, last: histOrder(last) };
  else if (last) v = { network: last.network, confirmed: ok === undefined && last.status === 'success', at: last.created_at, last: histOrder(last) };
  else if (ok === null && last === null) v = null;
  if (v !== undefined && uid === state.user?.id) histCache.set(key, { at: Date.now(), v });
  return v;
}

// ───────────── สมุดโทรศัพท์ (เก็บไว้ 60 วินาที — ใช้แสดงชื่อเรียกของเบอร์ในหน้าต่างยืนยัน) ─────────────

let bookCache = { uid: null, at: 0, list: null };
export async function phonebookList(force = false) {
  const uid = state.user?.id;
  if (!uid) return [];
  if (!force && bookCache.uid === uid && bookCache.list && Date.now() - bookCache.at < 60000) return bookCache.list;
  const list = await api.get('/api/phonebook');
  bookCache = { uid, at: Date.now(), list: Array.isArray(list) ? list : [] };
  return bookCache.list;
}
/** เพิ่ม/แก้ไข/ลบเบอร์ในสมุด → โหลดใหม่ครั้งหน้า */
export const forgetPhonebook = () => { bookCache = { uid: null, at: 0, list: null }; };

// ───────────── เติมเงินเข้ากระเป๋าที่ยังไม่เสร็จ (รอโอน/แนบสลิป หรือรอตรวจสลิป) ─────────────

/** รายการเติมเงินเข้ากระเป๋าที่ยังค้างอยู่ (ใหม่สุดก่อน) — ใช้แสดงแถบเตือนให้ทำต่อ */
export async function openDeposits() {
  if (!state.user) return [];
  const d = await api.get('/api/deposits?pageSize=10');
  return (d?.rows || []).filter((x) => x.status === 'pending');
}

// ───────────── รายการที่ค้างไว้เพราะเงินในกระเป๋าไม่พอ (เติมเงินเสร็จแล้วกลับมาทำต่อได้ทันที) ─────────────

const DRAFT_KEY = 'topup.draft';
const DRAFT_MAX_AGE_MS = 24 * 3600 * 1000;
const draftPathOk = (p) => typeof p === 'string' && /^\/(topup|packages)\?[\w=&%.:-]*$/.test(p) && p.length <= 300;
/** จำรายการที่กำลังทำไว้ (path ของหน้าเติมเงิน/แพ็กเกจพร้อมข้อมูลที่เลือก) */
export function saveDraft(path, label) {
  if (!state.user || !draftPathOk(path)) return;
  try { localStorage.setItem(perUser(DRAFT_KEY), JSON.stringify({ path, label: String(label || '').slice(0, 120), at: Date.now() })); } catch { /* ignore */ }
}
/** รายการที่ค้างไว้ของบัญชีนี้ (null = ไม่มี / เก่าเกิน 24 ชม.) */
export function getDraft() {
  if (!state.user) return null;
  try {
    const d = JSON.parse(localStorage.getItem(perUser(DRAFT_KEY)) || 'null');
    if (!d || !draftPathOk(d.path) || !(Date.now() - d.at < DRAFT_MAX_AGE_MS)) return null;
    return d;
  } catch {
    return null;
  }
}
export function clearDraft() {
  try { localStorage.removeItem(perUser(DRAFT_KEY)); } catch { /* ignore */ }
}
/** รายการที่ค้างไว้คือรายการเดียวกับที่เพิ่งสั่งไหม (ประเภทเดียวกัน + เบอร์เดียวกัน) — สั่งรายการอื่นไม่ลบรายการที่ค้างไว้ */
export function draftMatches(type, phone) {
  const d = getDraft();
  if (!d) return false;
  const [path, search = ''] = d.path.split('?');
  return path === (type === 'package' ? '/packages' : '/topup') && new URLSearchParams(search).get('phone') === phone;
}

// ───────────── รายการเติมหลายเบอร์ที่วางไว้ (คงไว้ระหว่างไปเติมเงินเข้ากระเป๋า — เฉพาะแท็บนี้) ─────────────

const BULK_KEY = 'topup.bulk';
export function loadBulkDraft() {
  if (!state.user) return null;
  try { return JSON.parse(sessionStorage.getItem(perUser(BULK_KEY)) || 'null'); } catch { return null; }
}
export function saveBulkDraft(d) {
  if (!state.user) return;
  try {
    if (!d || !String(d.text || '').trim()) sessionStorage.removeItem(perUser(BULK_KEY));
    else sessionStorage.setItem(perUser(BULK_KEY), JSON.stringify({ ...d, text: String(d.text).slice(0, 20000), at: Date.now() }));
  } catch { /* ignore */ }
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
