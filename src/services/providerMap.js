'use strict';
/**
 * จับคู่สินค้าของเรา กับ "บริการราคาคงที่" ของผู้ให้บริการ (เช่น HubZell: 1 ยอดเติม = 1 service_id)
 *   - ดึงรายการบริการ (sync) → แอดมินเลือกจับคู่ → เปิดใช้ (ค่าเริ่มต้นปิดเสมอ)
 *   - ห้ามเปิดใช้ถ้าต้นทุนสูงกว่าราคาที่เราขาย (ขาดทุน)
 *   - sync ครั้งถัดไป: ต้นทุนเปลี่ยน → อัปเดต, บริการหาย/ใช้ไม่ได้/ทำให้ขาดทุน → ปิดการจับคู่อัตโนมัติ + แจ้งแอดมิน
 */
const db = require('../db');
const { E } = require('../lib/errors');
const { parseBaht, afterDiscount, fmt } = require('../lib/money');
const { alertAdmin } = require('../lib/notify');
const providers = require('../providers');
const catalog = require('./catalog');
const audit = require('./audit');

function mappedProvider(name) {
  const p = providers.byName(name);
  if (!p || p.capabilities.catalog !== 'mapped') throw E.notFound('ผู้ให้บริการนี้ไม่ต้องจับคู่รายการ');
  if (!providers.configured().includes(name)) throw E.validation(`ยังไม่ได้เปิดใช้ ${p.label} ใน .env (PROVIDERS)`);
  return p;
}

/** ราคาที่เราขายลูกค้า สำหรับการจับคู่นี้ (ใช้ตรวจว่าไม่ขาดทุน) */
function sellPrice(m) {
  if (m.kind === 'topup') {
    const net = catalog.getNetwork(m.network_code);
    return net ? afterDiscount(m.face_value, require('./shops').discountBp(m.provider, net)) : 0;
  }
  const p = catalog.getProduct(m.product_id);
  return p ? p.price : 0;
}

/** เดาว่าบริการนี้คือ เครือข่าย/ยอด/แพ็กเกจอะไร จากชื่อ (แอดมินต้องตรวจก่อนบันทึก) */
function suggest(row) {
  const text = `${row.product_name || ''} ${row.service_name || ''} ${row.product_code || ''}`;
  let network = null;
  if (/\bAIS\b|12\s*call|one[-\s]?2[-\s]?call|เอไอเอส/i.test(text)) network = 'AIS';
  else if (/\bTRUE\b|truemove|ทรู/i.test(text)) network = 'TRUE';
  else if (/\bDTAC\b|ดีแทค/i.test(text)) network = 'DTAC';
  const isPackage = /เน็ต|internet|data|\bnet\b|แพ็ก|package|\d+\s*(GB|MB)|ไม่อั้น|unlimited/i.test(text);
  let faceValue = null;
  if (!isPackage) {
    const m = /(\d{1,4})\s*(บาท|฿|THB|baht)/i.exec(row.service_name || '') || /^\D*(\d{1,4})\D*$/.exec(row.service_name || '');
    if (m) faceValue = Number(m[1]) * 100;
  }
  return { network_code: network, kind: isPackage ? 'package' : 'topup', face_value: faceValue };
}

async function syncCatalog(name, actor, ip) {
  const p = mappedProvider(name);
  const r = await p.fetchCatalog();
  if (!r.ok) throw E.validation(`ดึงรายการจาก ${p.label} ไม่สำเร็จ: ${r.message}`);
  const listed = new Set((r.listed || []).map(String));
  const fetched = new Set((r.fetched || []).map(String));
  const hasEnabled = db.get('SELECT COUNT(*) AS c FROM provider_map WHERE provider = ? AND enabled = 1', name).c > 0;
  if (!listed.size && hasEnabled) {
    // ได้รายการว่างทั้งที่มีการจับคู่เปิดใช้อยู่ — อาจเป็นปัญหาชั่วคราวของผู้ให้บริการ → ไม่ปิดการจับคู่ทั้งหมด
    throw E.validation(`${p.label} ส่งรายการบริการว่างเปล่า — ระบบไม่อัปเดตเพื่อความปลอดภัย (การจับคู่เดิมยังใช้ได้) กรุณาลองใหม่ภายหลัง`);
  }
  const now = db.nowIso();
  const disabled = [];
  const updated = [];
  db.tx(() => {
    // ลบเฉพาะข้อมูลของสินค้าที่ดึงรายละเอียดใหม่ได้ หรือสินค้าที่ผู้ให้บริการไม่มีแล้ว
    // สินค้าที่ดึงรายละเอียดไม่สำเร็จ (เช่น โดนจำกัดความถี่) → คงข้อมูลเดิมไว้ ไม่สรุปว่าบริการหาย
    for (const old of db.all('SELECT service_id, product_code FROM provider_catalog WHERE provider = ?', name)) {
      const code = String(old.product_code || '');
      if (fetched.has(code) || !listed.has(code)) db.run('DELETE FROM provider_catalog WHERE provider = ? AND service_id = ?', name, old.service_id);
    }
    for (const x of r.rows) {
      db.run(
        `INSERT OR REPLACE INTO provider_catalog (provider, service_id, product_code, product_name, service_name, category, currency, price,
           input_field, input_pattern, phone_format, inputs_json, supported, unsupported_reason, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        name, x.serviceId, x.productCode, x.productName, x.serviceName, x.category, x.currency, x.price,
        x.inputField, x.inputPattern, x.phoneFormat, JSON.stringify(x.inputs || []).slice(0, 4000), x.supported ? 1 : 0, x.reason, now,
      );
    }
    // ตรวจทุกการจับคู่เดิมกับข้อมูลล่าสุด
    for (const m of db.all('SELECT * FROM provider_map WHERE provider = ?', name)) {
      const c = db.get('SELECT * FROM provider_catalog WHERE provider = ? AND service_id = ?', name, m.service_id);
      let reason = null;
      if (!c) reason = 'บริการนี้ไม่มีแล้ว';
      else if (!c.supported) reason = `ใช้ไม่ได้: ${c.unsupported_reason || '-'}`;
      else if (c.price > sellPrice(m)) reason = `ต้นทุนใหม่ ${fmt(c.price)} สูงกว่าราคาขาย ${fmt(sellPrice(m))}`;
      if (c && c.supported) {
        if (c.price !== m.cost || c.input_field !== m.input_field || c.input_pattern !== m.input_pattern || c.phone_format !== m.phone_format) {
          db.run('UPDATE provider_map SET cost = ?, input_field = ?, input_pattern = ?, phone_format = ?, updated_at = ? WHERE id = ?',
            c.price, c.input_field, c.input_pattern, c.phone_format, now, m.id);
          if (c.price !== m.cost) updated.push(`${m.service_id}: ${fmt(m.cost)} → ${fmt(c.price)}`);
        }
      }
      if (reason && m.enabled) {
        db.run('UPDATE provider_map SET enabled = 0, updated_at = ? WHERE id = ?', now, m.id);
        disabled.push(`${m.service_id} (${m.kind === 'topup' ? `${m.network_code} ${fmt(m.face_value)} บาท` : `แพ็กเกจ #${m.product_id}`}): ${reason}`);
      }
    }
  });
  audit.log(actor.id, 'provider.sync', 'provider', name, { services: r.rows.length, disabled, updated, errors: r.errors }, ip);
  if (disabled.length) {
    alertAdmin(`map-disabled-${name}`, `${p.label}: ปิดการจับคู่ ${disabled.length} รายการอัตโนมัติ\n${disabled.slice(0, 10).join('\n')}`, { cooldownSec: 60 });
  }
  return {
    services: r.rows.length,
    supported: r.rows.filter((x) => x.supported).length,
    products: r.products,
    // สินค้าที่ดึงรายละเอียดไม่ได้ในรอบนี้ (คงข้อมูลเดิม) — ถ้ามี ควรกดดึงใหม่อีกครั้งภายหลัง
    incomplete: [...listed].filter((c) => !fetched.has(c)).length,
    errors: r.errors || [],
    disabled,
    cost_changed: updated,
  };
}

function mappingView(m) {
  const net = catalog.getNetwork(m.network_code);
  const product = m.product_id ? catalog.getProduct(m.product_id) : null;
  const sell = sellPrice(m);
  const c = db.get('SELECT service_name, product_name FROM provider_catalog WHERE provider = ? AND service_id = ?', m.provider, m.service_id);
  return {
    ...m,
    enabled: Boolean(m.enabled),
    network_name: net?.name || m.network_code,
    product_name: product ? product.name : null,
    service_name: c?.service_name || null,
    service_product: c?.product_name || null,
    sell_price: sell,
    profit: sell - m.cost,
    loss: m.cost > sell,
  };
}

function listCatalog(name) {
  const p = mappedProvider(name);
  const rows = db.all('SELECT * FROM provider_catalog WHERE provider = ? ORDER BY product_name, price', name);
  const maps = db.all('SELECT * FROM provider_map WHERE provider = ? ORDER BY kind, network_code, face_value, product_id', name).map(mappingView);
  const byService = new Map();
  for (const m of maps) {
    if (!byService.has(m.service_id)) byService.set(m.service_id, []);
    byService.get(m.service_id).push(m.id);
  }
  // ยอดเติมที่ลูกค้าเลือกได้ แต่ยังไม่มีบริการของเจ้านี้รองรับ (เจ้านี้จะถูกข้ามสำหรับยอดนั้น)
  const gaps = [];
  for (const net of catalog.listNetworks()) {
    for (const baht of net.topup_presets) {
      if (!maps.some((m) => m.kind === 'topup' && m.enabled && m.network_code === net.code && m.face_value === baht * 100)) gaps.push({ network_code: net.code, amount: baht });
    }
  }
  return {
    provider: { name, label: p.label },
    synced_at: rows[0]?.synced_at || null,
    catalog: rows.map((r) => ({ ...r, supported: Boolean(r.supported), inputs: undefined, inputs_json: undefined, mapping_ids: byService.get(r.service_id) || [], suggestion: suggest(r) })),
    mappings: maps,
    topup_gaps: gaps,
  };
}

function validateMapping(name, input) {
  const serviceId = String(input.service_id || '');
  const c = db.get('SELECT * FROM provider_catalog WHERE provider = ? AND service_id = ?', name, serviceId);
  if (!c) throw E.validation('ไม่พบบริการนี้ — กด "ดึงรายการ" ใหม่ก่อน', { field: 'service_id' });
  if (!c.supported) throw E.validation(`บริการนี้ใช้กับระบบไม่ได้: ${c.unsupported_reason || '-'}`, { field: 'service_id' });
  const kind = input.kind === 'package' ? 'package' : input.kind === 'topup' ? 'topup' : null;
  if (!kind) throw E.validation('กรุณาเลือกว่าเป็น "เติมเงิน" หรือ "แพ็กเกจ"', { field: 'kind' });
  const net = catalog.getNetwork(input.network_code);
  if (!net) throw E.validation('กรุณาเลือกเครือข่าย', { field: 'network_code' });
  const m = { provider: name, kind, network_code: net.code, face_value: null, product_id: null, service_id: c.service_id, input_field: c.input_field, input_pattern: c.input_pattern, phone_format: c.phone_format, cost: c.price };
  if (kind === 'topup') {
    const face = parseBaht(input.face_value_baht, 'face_value_baht');
    if (face % 100 !== 0) throw E.validation('ยอดเติมต้องเป็นจำนวนเต็มบาท', { field: 'face_value_baht' });
    if (face < net.topup_min || face > net.topup_max) throw E.validation(`ยอดเติม ${net.name} ต้องอยู่ระหว่าง ${fmt(net.topup_min)} - ${fmt(net.topup_max)} บาท`, { field: 'face_value_baht' });
    m.face_value = face;
  } else {
    const product = catalog.getProduct(Number(input.product_id));
    if (!product) throw E.validation('กรุณาเลือกแพ็กเกจในระบบที่ตรงกับบริการนี้', { field: 'product_id' });
    if (product.network_code !== net.code) throw E.validation('แพ็กเกจที่เลือกไม่ใช่ของเครือข่ายนี้', { field: 'product_id' });
    m.product_id = product.id;
  }
  return m;
}

function upsertMapping(name, input, actor, ip) {
  const p = mappedProvider(name);
  const m = validateMapping(name, input || {});
  const enabled = input.enabled === true;
  const sell = sellPrice(m);
  if (enabled && m.cost > sell) throw E.validation(`ต้นทุน ${fmt(m.cost)} บาท สูงกว่าราคาที่ขายลูกค้า ${fmt(sell)} บาท — เปิดใช้ไม่ได้ (จะขาดทุน)`, { field: 'enabled' });
  const now = db.nowIso();
  const existing = m.kind === 'topup'
    ? db.get("SELECT id FROM provider_map WHERE provider = ? AND kind = 'topup' AND network_code = ? AND face_value = ?", name, m.network_code, m.face_value)
    : db.get("SELECT id FROM provider_map WHERE provider = ? AND kind = 'package' AND product_id = ?", name, m.product_id);
  let id;
  if (existing) {
    db.run(
      'UPDATE provider_map SET service_id = ?, input_field = ?, input_pattern = ?, phone_format = ?, cost = ?, enabled = ?, updated_at = ? WHERE id = ?',
      m.service_id, m.input_field, m.input_pattern, m.phone_format, m.cost, enabled ? 1 : 0, now, existing.id,
    );
    id = existing.id;
  } else {
    const r = db.run(
      `INSERT INTO provider_map (provider, kind, network_code, face_value, product_id, service_id, input_field, input_pattern, phone_format, cost, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      name, m.kind, m.network_code, m.face_value, m.product_id, m.service_id, m.input_field, m.input_pattern, m.phone_format, m.cost, enabled ? 1 : 0, now,
    );
    id = Number(r.lastInsertRowid);
  }
  audit.log(actor.id, 'provider.map', 'provider_map', id, { provider: name, ...m, enabled }, ip);
  return mappingView(db.get('SELECT * FROM provider_map WHERE id = ?', id));
}

function setEnabled(name, id, enabled, actor, ip) {
  mappedProvider(name);
  const m = db.get('SELECT * FROM provider_map WHERE id = ? AND provider = ?', Number(id), name);
  if (!m) throw E.notFound('ไม่พบการจับคู่นี้');
  if (enabled) {
    const c = db.get('SELECT supported FROM provider_catalog WHERE provider = ? AND service_id = ?', name, m.service_id);
    if (!c || !c.supported) throw E.validation('บริการนี้ไม่มีแล้วหรือใช้ไม่ได้ — กด "ดึงรายการ" ใหม่ก่อน');
    const sell = sellPrice(m);
    if (m.cost > sell) throw E.validation(`ต้นทุน ${fmt(m.cost)} บาท สูงกว่าราคาที่ขายลูกค้า ${fmt(sell)} บาท — เปิดใช้ไม่ได้ (จะขาดทุน)`);
  }
  db.run('UPDATE provider_map SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, db.nowIso(), m.id);
  audit.log(actor.id, enabled ? 'provider.map_enable' : 'provider.map_disable', 'provider_map', m.id, { provider: name, service_id: m.service_id }, ip);
  return mappingView(db.get('SELECT * FROM provider_map WHERE id = ?', m.id));
}

function removeMapping(name, id, actor, ip) {
  mappedProvider(name);
  const r = db.run('DELETE FROM provider_map WHERE id = ? AND provider = ?', Number(id), name);
  if (r.changes !== 1) throw E.notFound('ไม่พบการจับคู่นี้');
  audit.log(actor.id, 'provider.map_delete', 'provider_map', Number(id), { provider: name }, ip);
}

/**
 * สร้างแพ็กเกจใหม่ในระบบจากบริการของผู้ให้บริการ (ใช้ตอนขายผ่าน HubZell เป็นหลัก)
 * สินค้าใหม่ "ปิดขาย" ไว้ก่อน + จับคู่ให้อัตโนมัติ (ปิดใช้) — แอดมินตรวจราคาแล้วเปิดเอง
 */
function createProductFromService(name, serviceId, input, actor, ip) {
  const p = mappedProvider(name);
  const c = db.get('SELECT * FROM provider_catalog WHERE provider = ? AND service_id = ?', name, String(serviceId));
  if (!c) throw E.notFound('ไม่พบบริการนี้');
  if (!c.supported) throw E.validation(`บริการนี้ใช้กับระบบไม่ได้: ${c.unsupported_reason || '-'}`);
  const net = catalog.getNetwork(input.network_code);
  if (!net) throw E.validation('กรุณาเลือกเครือข่าย', { field: 'network_code' });
  const price = parseBaht(input.price_baht, 'price_baht');
  if (price < c.price) throw E.validation(`ราคาขายต้องไม่ต่ำกว่าต้นทุน ${fmt(c.price)} บาท`, { field: 'price_baht' });
  const product = db.tx(() => {
    const created = catalog.createProduct({
      network_code: net.code,
      provider_code: `${name.toUpperCase()}:${c.service_id}`.slice(0, 64).replace(/[^A-Za-z0-9_\-.:]/g, '_'),
      name: String(input.name || c.service_name || '').trim() || c.service_name,
      description: input.description || null,
      category: input.category || 'เน็ต',
      data_label: input.data_label || null,
      validity_days: input.validity_days ?? null,
      price_baht: price / 100,
      cost_baht: c.price / 100,
      enabled: false,
    }, actor, ip);
    db.run('UPDATE products SET origin = ? WHERE id = ?', name, created.id);
    upsertMapping(name, { service_id: c.service_id, kind: 'package', network_code: net.code, product_id: created.id, enabled: false }, actor, ip);
    return catalog.getProduct(created.id);
  });
  audit.log(actor.id, 'provider.create_product', 'product', product.id, { provider: name, service_id: c.service_id }, ip);
  return { product, provider: p.label };
}

module.exports = { syncCatalog, listCatalog, upsertMapping, setEnabled, removeMapping, createProductFromService, suggest };
