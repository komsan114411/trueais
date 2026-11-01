'use strict';
// สมุดโทรศัพท์: บันทึกเบอร์ที่เติมบ่อย
const db = require('../db');
const { E, AppError } = require('../lib/errors');
const { normalizePhone } = require('../lib/phone');
const catalog = require('./catalog');

const MAX_ENTRIES = 200;

function validate({ name, phone, network }) {
  const n = String(name ?? '').trim().slice(0, 60);
  if (!n) throw E.validation('กรุณาตั้งชื่อเรียก เช่น "แม่", "ร้านค้า"', { field: 'name' });
  const p = normalizePhone(phone);
  if (!p) throw new AppError('INVALID_PHONE', 'เบอร์โทรศัพท์ไม่ถูกต้อง', 400, { field: 'phone' });
  let net = null;
  if (network) {
    if (!catalog.getNetwork(network)) throw E.validation('เครือข่ายไม่ถูกต้อง', { field: 'network' });
    net = String(network).toUpperCase();
  }
  return { name: n, phone: p, network: net };
}

const list = (user) => db.all('SELECT id, name, phone, network_code AS network, created_at FROM phonebook WHERE user_id = ? ORDER BY name', user.id);

function add(user, input) {
  const v = validate(input);
  if (db.get('SELECT COUNT(*) AS c FROM phonebook WHERE user_id = ?', user.id).c >= MAX_ENTRIES) throw E.validation(`บันทึกได้สูงสุด ${MAX_ENTRIES} เบอร์`);
  if (db.get('SELECT id FROM phonebook WHERE user_id = ? AND phone = ?', user.id, v.phone)) throw E.conflict('PHONE_EXISTS', 'เบอร์นี้อยู่ในสมุดโทรศัพท์แล้ว', { field: 'phone' });
  const r = db.run('INSERT INTO phonebook (user_id, name, phone, network_code, created_at) VALUES (?, ?, ?, ?, ?)', user.id, v.name, v.phone, v.network, db.nowIso());
  return db.get('SELECT id, name, phone, network_code AS network, created_at FROM phonebook WHERE id = ?', Number(r.lastInsertRowid));
}

function update(user, id, input) {
  const v = validate(input);
  const row = db.get('SELECT id FROM phonebook WHERE id = ? AND user_id = ?', Number(id), user.id);
  if (!row) throw E.notFound('ไม่พบรายชื่อ');
  const dup = db.get('SELECT id FROM phonebook WHERE user_id = ? AND phone = ? AND id != ?', user.id, v.phone, row.id);
  if (dup) throw E.conflict('PHONE_EXISTS', 'เบอร์นี้อยู่ในสมุดโทรศัพท์แล้ว', { field: 'phone' });
  db.run('UPDATE phonebook SET name = ?, phone = ?, network_code = ? WHERE id = ?', v.name, v.phone, v.network, row.id);
  return db.get('SELECT id, name, phone, network_code AS network, created_at FROM phonebook WHERE id = ?', row.id);
}

function remove(user, id) {
  const r = db.run('DELETE FROM phonebook WHERE id = ? AND user_id = ?', Number(id), user.id);
  if (r.changes !== 1) throw E.notFound('ไม่พบรายชื่อ');
}

/**
 * เบอร์ที่เคยทำรายการล่าสุด (ไม่เกิน 8 เบอร์ ภายใน 180 วัน) — ให้ลูกค้ากดเลือกได้ทันทีโดยไม่ต้องพิมพ์ (ลดการพิมพ์เบอร์ผิด)
 *   network = เครือข่ายของรายการ "สำเร็จ" ล่าสุดของเบอร์นั้น (network_confirmed = true)
 *             ถ้ายังไม่เคยสำเร็จ ใช้เครือข่ายของรายการล่าสุด (network_confirmed = false — หน้าเว็บจะให้ลูกค้าตรวจเอง)
 */
const RECENT_DAYS = 180;
function recent(user, { limit = 8 } = {}) {
  const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
  const rows = db.all(
    `SELECT phone, type, network_code, face_value, product_id, shop, status, created_at FROM orders
     WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 300`,
    user.id, since,
  );
  const names = new Map(db.all('SELECT phone, name FROM phonebook WHERE user_id = ?', user.id).map((r) => [r.phone, r.name]));
  const byPhone = new Map();
  for (const o of rows) {
    let e = byPhone.get(o.phone);
    if (!e) {
      if (byPhone.size >= limit) continue;
      e = {
        phone: o.phone, name: names.get(o.phone) || null, network: o.network_code, network_confirmed: false, shop: o.shop || null,
        last_at: o.created_at, count: 0, last_topup_amount: null, last_package_id: null,
      };
      byPhone.set(o.phone, e);
    }
    e.count += 1;
    if (!e.network_confirmed && o.status === 'success') {
      e.network = o.network_code;
      e.network_confirmed = true;
    }
    if (e.last_topup_amount === null && o.type === 'topup') e.last_topup_amount = o.face_value / 100;
    if (e.last_package_id === null && o.type === 'package') e.last_package_id = o.product_id;
  }
  return [...byPhone.values()];
}

module.exports = { list, add, update, remove, recent };
