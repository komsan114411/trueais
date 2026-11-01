'use strict';
/**
 * ร้าน (ลูกค้าเลือกได้) — 1 ร้าน = ผู้ให้บริการ 1 เจ้า (เช่น HubZell, WonDD)
 *   - แต่ละร้านตั้งส่วนลดให้ลูกค้าแยกตามเครือข่ายได้ (ไม่ตั้ง = ใช้ส่วนลดมาตรฐานของเครือข่าย)
 *   - ร้านแบบจับคู่บริการ (HubZell) ขายได้เฉพาะยอดที่จับคู่และเปิดใช้ไว้
 *   - ราคาที่ลูกค้าตกลงตอนสั่ง = ราคาของร้านที่เลือก — ถ้าร้านนั้นไม่รับรายการ ระบบส่งต่อร้านอื่น "ในราคาเดิม"
 *     เฉพาะร้านที่ต้นทุนไม่เกินราคานั้น (ไม่ขาดทุน)
 */
const db = require('../db');
const { E, AppError } = require('../lib/errors');
const { afterDiscount, percentToBp, fmt } = require('../lib/money');
const providers = require('../providers');
const breaker = require('./breaker');
const audit = require('./audit');

const isMapped = (code) => providers.byName(code)?.capabilities.catalog === 'mapped';

function displayName(code) {
  if (!code) return null;
  const p = providers.byName(code);
  return db.get('SELECT display_name FROM shops WHERE provider = ?', code)?.display_name || p?.shopName || p?.label || code;
}

/** ร้านที่ลูกค้าเลือกได้ตอนนี้ (เปิดใช้ + ตั้งค่าครบ) ตามลำดับ */
const visible = () => providers.ordered().filter((n) => providers.byName(n)?.configStatus().ready);

/** ส่วนลดลูกค้า (basis point) ของร้านนี้ สำหรับเครือข่ายนี้ — ร้าน null = ส่วนลดมาตรฐาน */
function discountBp(code, net) {
  if (!code) return net.customer_discount_bp;
  const r = db.get('SELECT customer_discount_bp FROM shop_networks WHERE provider = ? AND network_code = ?', code, net.code);
  return r ? r.customer_discount_bp : net.customer_discount_bp;
}

/** ยอดเติม (สตางค์) ที่ร้านแบบจับคู่บริการขายได้ (ไม่ขาดทุน) — null = ร้านแบบแคตตาล็อกหลัก ขายตามที่เครือข่ายกำหนด */
function mappedAmounts(code, net) {
  if (!isMapped(code)) return null;
  const bp = discountBp(code, net);
  return db.all("SELECT face_value, cost FROM provider_map WHERE provider = ? AND kind = 'topup' AND network_code = ? AND enabled = 1 ORDER BY face_value", code, net.code)
    .filter((m) => m.face_value >= net.topup_min && m.face_value <= net.topup_max && m.cost <= afterDiscount(m.face_value, bp))
    .map((m) => m.face_value);
}

/** ร้านนี้ขายยอดนี้ไม่ได้ → คืนข้อความเหตุผล (ขายได้ = null) */
function topupBlocked(code, net, face) {
  const amounts = mappedAmounts(code, net);
  if (amounts && !amounts.includes(face)) return `${displayName(code)} ไม่มียอด ${fmt(face)} บาท ของ ${net.name} — กรุณาเลือกยอดอื่น หรือร้านอื่น`;
  return null;
}

/**
 * แพ็กเกจนี้ร้านนี้ขายได้ไหม
 *   ร้านแบบแคตตาล็อกหลัก (WonDD/โหมดทดสอบ) → เฉพาะแพ็กเกจของแคตตาล็อกหลัก
 *   ร้านแบบจับคู่บริการ (HubZell) → ต้องมีการจับคู่ที่ "เปิดใช้" และไม่ขาดทุน (ปิดการจับคู่แล้ว = ไม่แสดงให้เลือก)
 */
function sellsPackage(code, product) {
  const origin = product.origin || 'primary';
  if (!isMapped(code)) return origin === 'primary';
  const m = db.get("SELECT cost FROM provider_map WHERE provider = ? AND kind = 'package' AND product_id = ? AND enabled = 1", code, product.id);
  return Boolean(m) && m.cost <= product.price;
}

/** ตรวจร้านที่ลูกค้าส่งมา — ไม่ระบุ / 'auto' = ให้ระบบเลือก (คืน null) */
function resolve(code) {
  if (code === undefined || code === null || code === '') return null;
  if (typeof code !== 'string') throw E.validation('ร้านที่เลือกไม่ถูกต้อง', { field: 'shop' });
  const c = code.trim().toLowerCase();
  if (c === '' || c === 'auto') return null;
  if (!visible().includes(c)) throw new AppError('SHOP_UNAVAILABLE', 'ร้านที่เลือกไม่เปิดให้บริการในขณะนี้ กรุณาเลือกร้านอื่น', 400, { field: 'shop' });
  return c;
}

/** ข้อมูลร้านสำหรับหน้าเว็บลูกค้า (ราคา = ยอด - ส่วนลดของร้าน) */
function publicShops(networks, products) {
  return visible().map((code) => ({
    code,
    name: displayName(code),
    paused: breaker.isOpen(code),
    networks: Object.fromEntries(networks.map((n) => {
      const amounts = mappedAmounts(code, n);
      return [n.code, {
        discount_bp: discountBp(code, n),
        // null = เติมได้ทุกยอดตามที่เครือข่ายกำหนด (ปุ่มยอด + กรอกเอง) / array = เฉพาะยอดเหล่านี้ (บาท)
        amounts: amounts ? amounts.map((a) => a / 100) : null,
        custom: amounts ? false : Boolean(n.topup_allow_custom),
      }];
    })),
    product_ids: products.filter((p) => sellsPackage(code, p)).map((p) => p.id),
  }));
}

/** ส่วนลดสูงสุดที่ตั้งได้โดยไม่ขาดทุน (bp) สำหรับร้าน+เครือข่ายนี้ */
function maxDiscountBp(code, net) {
  if (!isMapped(code)) return net.provider_discount_bp;
  const maps = db.all("SELECT face_value, cost FROM provider_map WHERE provider = ? AND kind = 'topup' AND network_code = ? AND enabled = 1", code, net.code);
  if (!maps.length) return 10000;
  // ส่วนลดต้องไม่ทำให้ราคาต่ำกว่าต้นทุนของยอดใดเลย
  return Math.min(...maps.map((m) => Math.floor(((m.face_value - m.cost) * 10000) / m.face_value)));
}

function adminList(networks) {
  const configured = providers.configured();
  const shown = visible();
  return configured.map((code) => {
    const p = providers.byName(code);
    const row = db.get('SELECT display_name FROM shops WHERE provider = ?', code);
    return {
      code,
      label: p.label,
      default_name: p.shopName || p.label,
      display_name: row?.display_name || null,
      name: displayName(code),
      visible: shown.includes(code),
      mapped: isMapped(code),
      networks: networks.map((n) => {
        const own = db.get('SELECT customer_discount_bp FROM shop_networks WHERE provider = ? AND network_code = ?', code, n.code);
        return {
          code: n.code,
          name: n.name,
          discount_percent: discountBp(code, n) / 100,
          custom: Boolean(own),
          default_percent: n.customer_discount_bp / 100,
          max_percent: maxDiscountBp(code, n) / 100,
          amounts: isMapped(code) ? (mappedAmounts(code, n) || []).map((a) => a / 100) : null,
        };
      }),
    };
  });
}

/**
 * แก้ชื่อร้าน / ส่วนลดแต่ละเครือข่าย
 * input = { display_name?, networks?: { AIS: { discount_percent } | { inherit: true } } }
 */
function update(code, input, actor, ip, networks) {
  const c = String(code || '').toLowerCase();
  if (!providers.configured().includes(c)) throw E.notFound('ไม่พบร้านนี้');
  const now = db.nowIso();
  const changes = {};
  db.tx(() => {
    if (input.display_name !== undefined) {
      const name = String(input.display_name ?? '').trim().replace(/\s+/g, ' ');
      if (name.length > 40) throw E.validation('ชื่อร้านยาวเกิน 40 ตัวอักษร', { field: 'display_name' });
      db.run('INSERT INTO shops (provider, display_name, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at',
        c, name || null, now);
      changes.display_name = name || null;
    }
    if (input.networks && typeof input.networks === 'object') {
      for (const [netCode, v] of Object.entries(input.networks)) {
        const net = networks.find((n) => n.code === String(netCode).toUpperCase());
        if (!net) throw E.validation(`ไม่รู้จักเครือข่าย ${netCode}`);
        if (!v || v.inherit === true) {
          db.run('DELETE FROM shop_networks WHERE provider = ? AND network_code = ?', c, net.code);
          changes[net.code] = 'มาตรฐาน';
          continue;
        }
        const bp = percentToBp(v.discount_percent);
        const max = maxDiscountBp(c, net);
        if (bp > max) {
          throw E.validation(`ส่วนลด ${net.name} ของ ${displayName(c)} ตั้งได้ไม่เกิน ${max / 100}% (มากกว่านี้จะขายต่ำกว่าต้นทุน)`, { field: `networks.${net.code}` });
        }
        db.run(
          'INSERT INTO shop_networks (provider, network_code, customer_discount_bp, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider, network_code) DO UPDATE SET customer_discount_bp = excluded.customer_discount_bp, updated_at = excluded.updated_at',
          c, net.code, bp, now,
        );
        changes[net.code] = bp / 100;
      }
    }
  });
  audit.log(actor.id, 'shop.update', 'shop', c, changes, ip);
  return adminList(networks).find((s) => s.code === c);
}

module.exports = { displayName, visible, discountBp, mappedAmounts, topupBlocked, sellsPackage, resolve, publicShops, adminList, update, maxDiscountBp };
