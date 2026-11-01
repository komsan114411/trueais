'use strict';
// เครือข่าย (AIS / True / dtac), ยอดเติมเงิน, แพ็กเกจเน็ต และการคำนวณราคา
const db = require('../db');
const { E, AppError } = require('../lib/errors');
const { afterDiscount, percentToBp, fmt, parseBaht } = require('../lib/money');
const providers = require('../providers');
const { alertAdmin } = require('../lib/notify');
const audit = require('./audit');

const CODE_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

function parseNetwork(n) {
  if (!n) return null;
  let presets = [];
  try { presets = JSON.parse(n.topup_presets); } catch { presets = []; }
  return { ...n, topup_presets: Array.isArray(presets) ? presets : [] };
}

const getNetwork = (code) => parseNetwork(db.get('SELECT * FROM networks WHERE code = ?', String(code || '').toUpperCase()));
const listNetworks = () => db.all('SELECT * FROM networks ORDER BY sort, code').map(parseNetwork);

function publicNetwork(n) {
  return {
    code: n.code,
    name: n.name,
    full_name: n.full_name,
    color: n.color,
    open: Boolean(n.enabled),
    notice: n.notice || null,
    topup: {
      open: Boolean(n.enabled && n.topup_enabled),
      min: n.topup_min,
      max: n.topup_max,
      presets: n.topup_presets,
      allow_custom: Boolean(n.topup_allow_custom),
      discount_bp: n.customer_discount_bp,
    },
    package: { open: Boolean(n.enabled && n.package_enabled) },
  };
}

function adminNetwork(n) {
  return { ...n, enabled: Boolean(n.enabled), topup_enabled: Boolean(n.topup_enabled), package_enabled: Boolean(n.package_enabled), topup_allow_custom: Boolean(n.topup_allow_custom) };
}

/** ราคาเติมเงิน: ลูกค้าจ่าย = ยอดเติม - ส่วนลดลูกค้า, ต้นทุน = ยอดเติม - ส่วนลดจากผู้ให้บริการ */
/**
 * discountBp = ส่วนลดลูกค้าของร้านที่เลือก (ไม่ระบุ = ส่วนลดมาตรฐานของเครือข่าย)
 * skipPresets = ร้านแบบจับคู่บริการ (ตรวจยอดจากรายการที่จับคู่ไว้แทนปุ่มยอดของเครือข่าย)
 */
function quoteTopup(net, amountSatang, { discountBp, skipPresets = false } = {}) {
  if (amountSatang % 100 !== 0) throw E.validation('ยอดเติมเงินต้องเป็นจำนวนเต็มบาท', { field: 'amount' });
  if (amountSatang < net.topup_min || amountSatang > net.topup_max) {
    throw new AppError('AMOUNT_OUT_OF_RANGE', `เติมเงิน ${net.name} ได้ตั้งแต่ ${fmt(net.topup_min)} ถึง ${fmt(net.topup_max)} บาท`, 400, { field: 'amount' });
  }
  const baht = amountSatang / 100;
  if (!skipPresets && !net.topup_allow_custom && !net.topup_presets.includes(baht)) {
    throw new AppError('AMOUNT_NOT_ALLOWED', `${net.name} เติมได้เฉพาะยอด ${net.topup_presets.join(', ')} บาท`, 400, { field: 'amount' });
  }
  return {
    faceValue: amountSatang,
    price: afterDiscount(amountSatang, discountBp === undefined || discountBp === null ? net.customer_discount_bp : discountBp),
    cost: afterDiscount(amountSatang, net.provider_discount_bp),
    productName: `เติมเงิน ${net.name} ${baht.toLocaleString('th-TH')} บาท`,
    productCode: net.provider_topup_code,
    productId: null,
  };
}

function quotePackage(product, net) {
  return {
    faceValue: product.price,
    price: product.price,
    cost: product.cost,
    productName: `${net.name} ${product.name}`,
    productCode: product.provider_code,
    productId: product.id,
  };
}

// ───────────── แก้ไขเครือข่าย ─────────────

const toBool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

function bahtToSatang(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100000) throw E.validation(`${label} ต้องเป็นจำนวนเต็มบาท 1 - 100,000`);
  return n * 100;
}

function updateNetwork(code, patch, actor, ip) {
  const n = getNetwork(code);
  if (!n) throw E.notFound('ไม่พบเครือข่าย');
  const f = {};
  if ('name' in patch) {
    f.name = String(patch.name || '').trim();
    if (f.name.length < 1 || f.name.length > 30) throw E.validation('ชื่อเครือข่าย 1-30 ตัวอักษร');
  }
  if ('full_name' in patch) {
    f.full_name = String(patch.full_name || '').trim();
    if (f.full_name.length < 1 || f.full_name.length > 60) throw E.validation('ชื่อเต็ม 1-60 ตัวอักษร');
  }
  if ('color' in patch) {
    if (!/^#[0-9a-fA-F]{6}$/.test(patch.color)) throw E.validation('สีต้องอยู่ในรูปแบบ #RRGGBB');
    f.color = patch.color;
  }
  for (const k of ['enabled', 'topup_enabled', 'package_enabled', 'topup_allow_custom']) if (k in patch) f[k] = toBool(patch[k]);
  if ('notice' in patch) {
    f.notice = String(patch.notice || '').trim().slice(0, 200) || null;
  }
  if ('topup_min' in patch) f.topup_min = bahtToSatang(patch.topup_min, 'ยอดเติมขั้นต่ำ');
  if ('topup_max' in patch) f.topup_max = bahtToSatang(patch.topup_max, 'ยอดเติมสูงสุด');
  const min = f.topup_min ?? n.topup_min;
  const max = f.topup_max ?? n.topup_max;
  if (min > max) throw E.validation('ยอดเติมขั้นต่ำต้องไม่มากกว่ายอดสูงสุด');
  if ('topup_presets' in patch) {
    const raw = Array.isArray(patch.topup_presets) ? patch.topup_presets : String(patch.topup_presets || '').split(/[\s,]+/);
    const list = [...new Set(raw.filter((x) => x !== '' && x !== null).map(Number))].sort((a, b) => a - b);
    if (!list.length || list.length > 20) throw E.validation('ปุ่มยอดเติมต้องมี 1 - 20 ค่า');
    for (const v of list) {
      if (!Number.isInteger(v)) throw E.validation(`ปุ่มยอดเติมต้องเป็นจำนวนเต็มบาท (ไม่ใช่ ${Number.isFinite(v) ? v : 'ข้อความ'})`);
      if (v * 100 < min || v * 100 > max) throw E.validation(`ยอด ${v} บาท อยู่นอกช่วง ${min / 100} - ${max / 100} บาท`);
    }
    f.topup_presets = JSON.stringify(list);
  } else if ('topup_min' in patch || 'topup_max' in patch) {
    const bad = n.topup_presets.filter((v) => v * 100 < min || v * 100 > max);
    if (bad.length) throw E.validation(`ปุ่มยอดเติม ${bad.join(', ')} บาท อยู่นอกช่วงใหม่ กรุณาแก้ปุ่มยอดเติมด้วย`);
  }
  if ('customer_discount' in patch) f.customer_discount_bp = percentToBp(patch.customer_discount);
  if ('provider_discount' in patch) f.provider_discount_bp = percentToBp(patch.provider_discount);
  if ('package_provider_discount' in patch) f.package_provider_discount_bp = percentToBp(patch.package_provider_discount);
  const cust = f.customer_discount_bp ?? n.customer_discount_bp;
  const prov = f.provider_discount_bp ?? n.provider_discount_bp;
  if (cust > prov) {
    throw E.validation(`ส่วนลดลูกค้า (${cust / 100}%) มากกว่าส่วนลดที่ได้จากผู้ให้บริการ (${prov / 100}%) จะขาดทุนทุกรายการ`);
  }
  if ('provider_topup_code' in patch) {
    if (!CODE_RE.test(String(patch.provider_topup_code || ''))) throw E.validation('รหัสบริการเติมเงิน (provider code) ไม่ถูกต้อง');
    f.provider_topup_code = String(patch.provider_topup_code);
  }
  const keys = Object.keys(f);
  if (!keys.length) return adminNetwork(n);
  // การแก้ส่วนลด/ช่วงยอดอาจทำให้ร้านที่ตั้งส่วนลดไว้ขายต่ำกว่าต้นทุน หรือยอดของร้านแบบจับคู่บริการหายไป → แจ้งให้ยืนยันก่อน
  const impacts = networkImpacts(n, { ...n, ...f, topup_presets: n.topup_presets });
  if (impacts.length && patch.confirm_impact !== true) {
    throw new AppError('NETWORK_IMPACT', 'การแก้ไขนี้มีผลกับร้าน/ยอดที่ขายอยู่ — กรุณาตรวจรายการแล้วยืนยันอีกครั้ง', 409, { impacts });
  }
  db.run(`UPDATE networks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE code = ?`, ...keys.map((k) => f[k]), db.nowIso(), n.code);
  audit.log(actor.id, 'network.update', 'network', n.code, impacts.length ? { ...f, impacts } : f, ip);
  return adminNetwork(getNetwork(n.code));
}

/**
 * ผลกระทบของการแก้เครือข่ายต่อร้าน: ส่วนลดของร้านจะเกินสูงสุดใหม่ (ขายต่ำกว่าต้นทุน = ระบบข้ามร้านนั้น)
 * หรือยอดของร้านแบบจับคู่บริการที่จะขายไม่ได้แล้ว — คืนรายการข้อความ (ว่าง = ไม่กระทบ)
 */
function networkImpacts(before, after) {
  const shops = require('./shops'); // โหลดตอนใช้ (กัน require วนกัน)
  const out = [];
  for (const code of providers.configured()) {
    const name = shops.displayName(code);
    const own = Boolean(db.get('SELECT 1 AS x FROM shop_networks WHERE provider = ? AND network_code = ?', code, before.code));
    const overBefore = shops.discountBp(code, before) > shops.maxDiscountBp(code, before);
    const bpAfter = shops.discountBp(code, after);
    const maxAfter = shops.maxDiscountBp(code, after);
    if (bpAfter > maxAfter && !overBefore) {
      out.push(`${name}: ส่วนลด ${after.name} ${bpAfter / 100}%${own ? '' : ' (ค่ามาตรฐาน)'} จะเกินสูงสุดใหม่ ${maxAfter / 100}% — ลูกค้าจะสั่งผ่านร้านนี้ไม่ได้ (ระบบไม่ขายต่ำกว่าต้นทุน)`);
    }
    const a0 = shops.mappedAmounts(code, before);
    const a1 = shops.mappedAmounts(code, after);
    if (a0 && a1) {
      const lost = a0.filter((a) => !a1.includes(a));
      if (lost.length) out.push(`${name}: ยอด ${lost.map((a) => (a / 100).toLocaleString('th-TH')).join(', ')} บาท ของ ${after.name} จะขายไม่ได้ (ต้นทุนเกินราคาขายใหม่ หรืออยู่นอกช่วงยอด)`);
    }
  }
  return out;
}

// ───────────── แพ็กเกจ ─────────────

/**
 * เลขที่แพ็กเกจถัดไป — ไม่นำเลขของแพ็กเกจที่ลบไปแล้วกลับมาใช้ซ้ำ
 * (กันประวัติการสั่งซื้อ/การจับคู่บริการ/ลิงก์เก่า ชี้ไปที่แพ็กเกจใหม่ผิดตัว)
 */
function nextProductId() {
  const settings = require('./settings');
  const max = db.get('SELECT COALESCE(MAX(id), 0) AS m FROM products').m;
  return Math.max(max, Number(settings.getInternal('_product_id_hwm', 0)) || 0) + 1;
}
function rememberDeletedId(id) {
  const settings = require('./settings');
  if (id > (Number(settings.getInternal('_product_id_hwm', 0)) || 0)) settings.setInternal('_product_id_hwm', id);
}
/** รายการของแพ็กเกจนี้ที่ยังไม่จบ (ห้ามลบ/แก้รหัสระหว่างนี้ — ระบบใช้ข้อมูลแพ็กเกจตอนส่งรายการ) */
const activeOrdersOf = (productId) => db.get("SELECT COUNT(*) AS c FROM orders WHERE product_id = ? AND status IN ('pending','processing')", productId).c;
const IN_USE_MSG = 'แพ็กเกจนี้มีรายการที่กำลังดำเนินการอยู่ — รอให้รายการเสร็จก่อน (ระหว่างนี้ปิดขายไว้ได้)';

const getProduct = (id) => db.get('SELECT * FROM products WHERE id = ?', id);
const getProductByCode = (network, code) => db.get('SELECT * FROM products WHERE network_code = ? AND provider_code = ?', network, code);

function validateProduct(data, existing = null) {
  const out = {};
  const pick = (k) => (k in data ? data[k] : existing ? existing[k] : undefined);
  const network = String(pick('network_code') || '').toUpperCase();
  if (!getNetwork(network)) throw E.validation('กรุณาเลือกเครือข่าย', { field: 'network_code' });
  out.network_code = network;
  const code = String(pick('provider_code') || '').trim();
  if (!CODE_RE.test(code)) throw E.validation('รหัสแพ็กเกจ (provider code) ใช้ได้เฉพาะ A-Z 0-9 _ - . : ไม่เกิน 64 ตัว', { field: 'provider_code' });
  out.provider_code = code;
  const name = String(pick('name') || '').trim();
  if (name.length < 2 || name.length > 120) throw E.validation('ชื่อแพ็กเกจ 2-120 ตัวอักษร', { field: 'name' });
  out.name = name;
  out.description = String(pick('description') || '').trim().slice(0, 500) || null;
  out.category = String(pick('category') || 'เน็ต').trim().slice(0, 40) || 'เน็ต';
  out.data_label = String(pick('data_label') || '').trim().slice(0, 40) || null;
  const days = pick('validity_days');
  if (days === null || days === undefined || days === '') out.validity_days = null;
  else {
    const d = Number(days);
    if (!Number.isInteger(d) || d < 0 || d > 3650) throw E.validation('จำนวนวันไม่ถูกต้อง', { field: 'validity_days' });
    out.validity_days = d;
  }
  // ราคา: รับเป็นบาทจากฟอร์ม (price_baht / cost_baht) หรือสตางค์ (price / cost)
  // ช่องว่าง/ข้อความแปลก = แจ้งให้กรอกใหม่ (ห้ามกลายเป็น 0 เงียบๆ — ต้นทุน 0 ทำให้ระบบกันขาดทุน/รายงานกำไรผิดทั้งหมด)
  const baht = (v, field, label) => {
    if (v === null || v === undefined || String(v).trim() === '') throw E.validation(`กรุณากรอก${label}`, { field });
    try { return parseBaht(typeof v === 'number' ? v : String(v).trim(), field); } catch { throw E.validation(`${label}ไม่ถูกต้อง (เช่น 199 หรือ 1,299.50)`, { field }); }
  };
  const priceSatang = 'price_baht' in data ? baht(data.price_baht, 'price_baht', 'ราคาขาย') : pick('price');
  const costSatang = 'cost_baht' in data ? baht(data.cost_baht, 'cost_baht', 'ต้นทุน') : pick('cost');
  if (!Number.isSafeInteger(priceSatang) || priceSatang <= 0 || priceSatang > 10000000) throw E.validation('ราคาขายไม่ถูกต้อง', { field: 'price_baht' });
  if (!Number.isSafeInteger(costSatang) || costSatang < 0) throw E.validation('ต้นทุนไม่ถูกต้อง', { field: 'cost_baht' });
  if (costSatang > priceSatang) throw E.validation('ต้นทุนมากกว่าราคาขาย จะขาดทุนทุกรายการ', { field: 'cost_baht' });
  out.price = priceSatang;
  out.cost = costSatang;
  out.enabled = 'enabled' in data ? toBool(data.enabled) : existing ? existing.enabled : 1;
  const sort = Number(pick('sort') ?? 0);
  out.sort = Number.isInteger(sort) ? sort : 0;
  return out;
}

function listProducts({ network, q, enabled, demo } = {}) {
  const where = [];
  const params = [];
  if (network) { where.push('network_code = ?'); params.push(String(network).toUpperCase()); }
  if (q) { where.push('(name LIKE ? OR provider_code LIKE ?)'); const like = `%${String(q).replace(/[%_]/g, '')}%`; params.push(like, like); }
  if (enabled !== undefined) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (demo !== undefined) { where.push('is_demo = ?'); params.push(demo ? 1 : 0); }
  const sql = `SELECT p.*, (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id AND o.status = 'success') AS sold
               FROM products p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY network_code, sort, price`;
  return db.all(sql, ...params).map((p) => ({ ...p, enabled: Boolean(p.enabled), is_demo: Boolean(p.is_demo) }));
}

function createProduct(data, actor, ip) {
  const p = validateProduct(data);
  if (getProductByCode(p.network_code, p.provider_code)) throw E.conflict('PRODUCT_EXISTS', 'มีแพ็กเกจรหัสนี้ในเครือข่ายนี้แล้ว', { field: 'provider_code' });
  const now = db.nowIso();
  const id = nextProductId();
  db.run(
    `INSERT INTO products (id, network_code, provider_code, name, description, category, data_label, validity_days, price, cost, enabled, is_demo, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    id, p.network_code, p.provider_code, p.name, p.description, p.category, p.data_label, p.validity_days, p.price, p.cost, p.enabled, p.sort, now, now,
  );
  audit.log(actor.id, 'product.create', 'product', id, p, ip);
  return getProduct(id);
}

function updateProduct(id, data, actor, ip) {
  const existing = getProduct(Number(id));
  if (!existing) throw E.notFound('ไม่พบแพ็กเกจ');
  const p = validateProduct(data, existing);
  const dup = getProductByCode(p.network_code, p.provider_code);
  if (dup && dup.id !== existing.id) throw E.conflict('PRODUCT_EXISTS', 'มีแพ็กเกจรหัสนี้ในเครือข่ายนี้แล้ว', { field: 'provider_code' });
  const codeChanged = p.provider_code !== existing.provider_code;
  const netChanged = p.network_code !== existing.network_code;
  if ((codeChanged || netChanged) && activeOrdersOf(existing.id)) {
    throw E.conflict('PRODUCT_IN_USE', IN_USE_MSG, { field: codeChanged ? 'provider_code' : 'network_code' });
  }
  if (netChanged && db.get("SELECT 1 AS x FROM provider_map WHERE kind = 'package' AND product_id = ?", existing.id)) {
    throw E.conflict('PRODUCT_MAPPED', 'แพ็กเกจนี้จับคู่กับบริการของผู้ให้บริการไว้ — ลบการจับคู่ก่อนเปลี่ยนเครือข่าย', { field: 'network_code' });
  }
  // ถ้าแก้รหัสแพ็กเกจตัวอย่างให้เป็นรหัสจริง จะไม่ถือเป็นตัวอย่างอีกต่อไป
  const isDemo = existing.is_demo && p.provider_code === existing.provider_code ? 1 : 0;
  db.run(
    `UPDATE products SET network_code = ?, provider_code = ?, name = ?, description = ?, category = ?, data_label = ?, validity_days = ?,
       price = ?, cost = ?, enabled = ?, is_demo = ?, sort = ?, updated_at = ? WHERE id = ?`,
    p.network_code, p.provider_code, p.name, p.description, p.category, p.data_label, p.validity_days, p.price, p.cost, p.enabled, isDemo, p.sort, db.nowIso(), existing.id,
  );
  audit.log(actor.id, 'product.update', 'product', existing.id, p, ip);
  return getProduct(existing.id);
}

function deleteProduct(id, actor, ip) {
  const p = getProduct(Number(id));
  if (!p) throw E.notFound('ไม่พบแพ็กเกจ');
  if (activeOrdersOf(p.id)) throw E.conflict('PRODUCT_IN_USE', IN_USE_MSG);
  let mappings = 0;
  db.tx(() => {
    // ลบการจับคู่บริการของแพ็กเกจนี้ด้วย (ไม่ให้ค้างไปผูกกับแพ็กเกจอื่น)
    mappings = db.run("DELETE FROM provider_map WHERE kind = 'package' AND product_id = ?", p.id).changes;
    db.run('DELETE FROM products WHERE id = ?', p.id);
    rememberDeletedId(p.id);
  });
  audit.log(actor.id, 'product.delete', 'product', p.id, { name: p.name, provider_code: p.provider_code, mappings_removed: mappings }, ip);
}

function deleteDemoProducts(actor, ip) {
  const demo = db.all('SELECT id FROM products WHERE is_demo = 1');
  const busy = demo.filter((p) => activeOrdersOf(p.id));
  if (busy.length) throw E.conflict('PRODUCT_IN_USE', `แพ็กเกจตัวอย่าง ${busy.length} รายการยังมีรายการที่กำลังดำเนินการอยู่ — รอให้เสร็จก่อนลบ`);
  let deleted = 0;
  db.tx(() => {
    for (const p of demo) {
      db.run("DELETE FROM provider_map WHERE kind = 'package' AND product_id = ?", p.id);
      rememberDeletedId(p.id);
    }
    deleted = db.run('DELETE FROM products WHERE is_demo = 1').changes;
  });
  audit.log(actor.id, 'product.delete_demo', 'product', null, { deleted }, ip);
  return deleted;
}

/** ดึงรายการแพ็กเกจจากผู้ให้บริการ: ของใหม่จะถูกเพิ่มแบบ "ปิดขาย" ให้แอดมินตรวจราคาก่อนเปิด */
async function syncProducts(actor, ip) {
  // แคตตาล็อกหลัก (รหัสใน products.provider_code) เป็นของผู้ให้บริการแบบ "primary" เช่น WonDD
  // ผู้ให้บริการแบบจับคู่บริการ (เช่น HubZell) ใช้ปุ่ม "ดึงรายการ" ในหน้าผู้ให้บริการแทน
  const provider = providers.configured().map((n) => providers.byName(n))
    .find((p) => p.capabilities.catalog === 'primary' && p.capabilities.products && typeof p.listProducts === 'function');
  if (!provider) throw E.validation('ผู้ให้บริการหลักไม่รองรับการดึงรายการแพ็กเกจ (HubZell ให้ใช้ปุ่มในหน้าผู้ให้บริการ)');
  const res = await provider.listProducts();
  if (!res.ok) throw E.validation(`ดึงรายการแพ็กเกจไม่สำเร็จ: ${res.message}`);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const disabled = [];
  const now = db.nowIso();
  const validMoney = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 10000000;
  db.tx(() => {
    for (const item of res.products) {
      if (!getNetwork(item.networkCode) || !CODE_RE.test(item.providerCode) || !validMoney(item.price) || item.price <= 0 || !validMoney(item.cost)) { skipped++; continue; }
      const validity = Number.isInteger(item.validityDays) && item.validityDays >= 0 && item.validityDays <= 3650 ? item.validityDays : null;
      const existing = getProductByCode(item.networkCode, item.providerCode);
      if (existing) {
        // ต้นทุนใหม่สูงกว่าราคาขาย → ปิดขายทันที (ไม่ขายขาดทุนเงียบๆ) และเก็บต้นทุนจริงไว้
        // แอดมินจะเปิดขายใหม่ได้ต่อเมื่อปรับราคาขายให้ไม่ต่ำกว่าต้นทุนแล้ว (validateProduct บังคับ)
        const loss = item.cost > existing.price;
        db.run('UPDATE products SET name = ?, cost = ?, enabled = ?, validity_days = COALESCE(?, validity_days), is_demo = 0, updated_at = ? WHERE id = ?',
          item.name.slice(0, 120), item.cost, loss ? 0 : existing.enabled, validity, now, existing.id);
        if (loss && existing.enabled) disabled.push(`${existing.network_code} ${existing.name} (ทุน ${fmt(item.cost)} > ขาย ${fmt(existing.price)})`);
        updated++;
      } else {
        db.run(
          `INSERT INTO products (id, network_code, provider_code, name, category, validity_days, price, cost, enabled, is_demo, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'เน็ต', ?, ?, ?, 0, 0, ?, ?)`,
          // เก็บต้นทุนจริงเสมอ (ถ้าสูงกว่าราคาขาย แอดมินจะเปิดขายไม่ได้จนกว่าจะตั้งราคาใหม่)
          nextProductId(), item.networkCode, item.providerCode, item.name.slice(0, 120), validity, item.price, item.cost, now, now,
        );
        added++;
      }
    }
  });
  audit.log(actor.id, 'product.sync', 'product', null, { added, updated, skipped, disabled }, ip);
  if (disabled.length) {
    alertAdmin('sync-loss', `ปิดขายแพ็กเกจ ${disabled.length} รายการอัตโนมัติ เพราะต้นทุนใหม่สูงกว่าราคาขาย:\n${disabled.slice(0, 10).join('\n')}`, { cooldownSec: 60 });
  }
  return { added, updated, skipped, disabled: disabled.length };
}

// ───────────── สำหรับหน้าเว็บลูกค้า ─────────────

function publicCatalog() {
  const shops = require('./shops'); // โหลดตอนใช้ (shops ใช้ providers ซึ่งโหลดช้ากว่า)
  const live = providers.isLive();
  const networks = listNetworks().filter((n) => n.enabled || n.notice);
  const openPackageNets = new Set(networks.filter((n) => n.enabled && n.package_enabled).map((n) => n.code));
  const visibleShops = shops.visible();
  const rows = db
    .all('SELECT * FROM products WHERE enabled = 1 ORDER BY sort, price')
    .filter((p) => openPackageNets.has(p.network_code) && !(live && p.is_demo) && p.cost <= p.price)
    // ซ่อนแพ็กเกจที่ไม่มีร้านไหนขายได้ในตอนนี้
    .filter((p) => visibleShops.some((s) => shops.sellsPackage(s, p)));
  const products = rows
    .map((p) => ({
      id: p.id,
      network: p.network_code,
      code: p.provider_code,
      name: p.name,
      description: p.description,
      category: p.category,
      data_label: p.data_label,
      validity_days: p.validity_days,
      price: p.price,
    }));
  return { networks: networks.map(publicNetwork), products, shops: shops.publicShops(networks, rows) };
}

module.exports = {
  getNetwork, listNetworks, publicNetwork, adminNetwork, updateNetwork, quoteTopup, quotePackage,
  getProduct, getProductByCode, listProducts, createProduct, updateProduct, deleteProduct, deleteDemoProducts, syncProducts,
  publicCatalog,
};
