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

module.exports = { list, add, update, remove };
