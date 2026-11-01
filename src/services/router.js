'use strict';
/**
 * เลือกผู้ให้บริการสำหรับแต่ละรายการ (หลายเจ้า + สลับอัตโนมัติ)
 *
 * เจ้าที่ "เลือกได้" ต้องผ่านทุกข้อ:
 *   1. เปิดใช้อยู่ (ไม่ได้ถูกปิดชั่วคราวในหน้าตั้งค่า) และตั้งค่าครบ
 *   2. ไม่ได้ถูกพักอยู่ (circuit breaker)
 *   3. ขายรายการนี้ได้ (เติมเงิน: เครือข่าย/ยอดนี้ — แพ็กเกจ: มีรหัสบริการของเจ้านั้น)
 *   4. ต้นทุนไม่เกินราคาขาย (ไม่ขายขาดทุน)
 *   5. เครดิตที่เจ้านั้น (ถ้าเพิ่งเช็ก) พอจ่ายต้นทุน
 *   6. ไม่เคยปฏิเสธรายการนี้มาก่อน (exclude)
 * เรียงตาม: ลำดับที่แอดมินตั้ง (priority) หรือ ต้นทุนต่ำสุด (cheapest)
 */
const db = require('../db');
const settings = require('./settings');
const breaker = require('./breaker');
const providers = require('../providers');
const { afterDiscount } = require('../lib/money');

const BALANCE_FRESH_MS = 15 * 60000;
const isMockName = (n) => n === 'mock' || n === 'mock2';

const presetsOf = (net) => {
  if (Array.isArray(net.topup_presets)) return net.topup_presets;
  try {
    const v = JSON.parse(net.topup_presets || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * ยอดนี้เติมผ่านแคตตาล็อกหลักได้ไหม (ตามที่ตั้งไว้ในเครือข่าย: ช่วงยอด, จำนวนเต็มบาท, เฉพาะยอดที่กำหนด)
 * — กันกรณีลูกค้าเลือกยอดที่มีเฉพาะร้านแบบจับคู่บริการ แล้วระบบส่งต่อให้เจ้าที่ไม่รองรับยอดนั้น
 */
function primaryAllows(net, face) {
  if (!Number.isSafeInteger(face) || face % 100 !== 0) return false;
  if (face < net.topup_min || face > net.topup_max) return false;
  return Boolean(net.topup_allow_custom) || presetsOf(net).includes(face / 100);
}

/** ราคาทุน/รหัสสินค้าของผู้ให้บริการแบบ "ใช้แคตตาล็อกหลัก" (WonDD / โหมดทดสอบ) */
function primaryQuote(name, item) {
  if (item.type === 'topup') {
    if (!primaryAllows(item.network, item.faceValue)) return null;
    return { cost: afterDiscount(item.faceValue, item.network.provider_discount_bp), code: item.network.provider_topup_code };
  }
  if (!item.product) return null;
  // สินค้าที่สร้างจากรายการของเจ้าอื่น (origin เช่น hubzell) — รหัสใน provider_code ไม่ใช่ของเจ้านี้
  if ((item.product.origin || 'primary') !== 'primary' && !isMockName(name)) return null;
  return { cost: item.product.cost, code: item.product.provider_code };
}

function quoteFor(name, item) {
  const p = providers.byName(name);
  if (!p) return null;
  try {
    return typeof p.quote === 'function' ? p.quote(item) : primaryQuote(name, item);
  } catch {
    return null;
  }
}

function balanceOf(name) {
  const b = settings.getInternal(`_provider_balance_${name}`, null);
  if (!b || b.balance === null || b.balance === undefined || !b.checked_at || b.error) return null;
  if (Date.now() - Date.parse(b.checked_at) > BALANCE_FRESH_MS) return null;
  return b.balance;
}

/**
 * รายการผู้ให้บริการที่ทำรายการนี้ได้ เรียงตามลำดับที่จะเลือก
 * item = { type, network (แถวเครือข่าย), faceValue, price, product (แถวสินค้า | null) }
 * คืน [{ name, provider, cost, code, mapId?, index }]
 */
function candidates(item, { exclude = [], ignoreBreaker = false, ignoreBalance = false, prefer = item.shop || null } = {}) {
  const out = [];
  providers.ordered().forEach((name, index) => {
    if (exclude.includes(name)) return;
    const p = providers.byName(name);
    if (!p || !p.configStatus().ready) return;
    if (!ignoreBreaker && breaker.isOpen(name)) return;
    const q = quoteFor(name, item);
    if (!q || !Number.isSafeInteger(q.cost) || q.cost < 0) return;
    if (q.cost > item.price) return; // ห้ามขายขาดทุน
    if (!ignoreBalance) {
      const bal = balanceOf(name);
      if (bal !== null && bal < q.cost) return; // เครดิตที่เจ้านี้ไม่พอ → ไปเจ้าอื่น
    }
    out.push({ name, provider: p, index, ...q });
  });
  if (settings.get('routing_mode') === 'cheapest') out.sort((a, b) => a.cost - b.cost || a.index - b.index);
  // ร้านที่ลูกค้าเลือกได้ก่อนเสมอ — เจ้าอื่นเป็นสำรอง (ราคาเดิมที่ลูกค้าจ่าย และต้องไม่ขาดทุน)
  if (prefer) {
    const i = out.findIndex((c) => c.name === prefer);
    if (i > 0) out.unshift(out.splice(i, 1)[0]);
  }
  return out;
}

/**
 * ตรวจก่อนรับรายการ (ก่อนตัดเงิน): มีเจ้าไหนทำรายการนี้ได้ไหม — ถ้าไม่ได้ บอกเหตุผลที่เข้าใจง่าย
 * คืน { pick } หรือ { reason: 'NOT_READY' | 'PAUSED' | 'NO_ROUTE' }
 */
function plan(item) {
  const list = candidates(item);
  if (list.length) return { pick: list[0] };
  const anyReady = providers.ordered().some((n) => providers.byName(n)?.configStatus().ready);
  if (!anyReady) return { reason: 'NOT_READY' };
  if (candidates(item, { ignoreBreaker: true, ignoreBalance: true }).length) return { reason: 'PAUSED' };
  return { reason: 'NO_ROUTE' };
}

/** สร้าง item จากแถวรายการสั่งซื้อ (ใช้ตอนส่งจริง) */
function itemFromOrder(order) {
  const network = db.get('SELECT * FROM networks WHERE code = ?', order.network_code);
  const product = order.product_id ? db.get('SELECT * FROM products WHERE id = ?', order.product_id) : null;
  return { type: order.type, network, faceValue: order.face_value, price: order.price, product, shop: order.shop || null };
}

module.exports = { candidates, plan, itemFromOrder, quoteFor, primaryQuote, balanceOf };
