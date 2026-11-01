'use strict';
// API key สำหรับเว็บไซต์ร้านค้าที่ต้องการเชื่อมต่อแบบ server-to-server (/api/v1)
const net = require('node:net');
const db = require('../db');
const { E } = require('../lib/errors');
const { randomToken, sha256 } = require('../lib/security');
const { validatePublicUrl } = require('../lib/netguard');
const audit = require('./audit');

function validateUrl(url) {
  if (url === undefined || url === null || String(url).trim() === '') return null;
  return validatePublicUrl(url, 'webhook_url', 'Webhook URL');
}

/** รายการ IP ที่อนุญาต: IP เดี่ยว หรือช่วงแบบ CIDR เช่น 203.0.113.0/24 (คั่นด้วย , หรือเว้นวรรค) */
function parseIpEntry(entry) {
  const [ip, bits, extra] = String(entry).trim().split('/');
  const family = net.isIP(ip);
  if (!family || extra !== undefined) return null;
  if (bits === undefined) return { ip, prefix: null, family };
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)) return null;
  return { ip, prefix: Number(bits), family };
}

function validateIps(list) {
  if (list === undefined || list === null) return null;
  const entries = String(list).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (entries.length > 50) throw E.validation('ใส่ IP ได้สูงสุด 50 รายการ', { field: 'ip_allowlist' });
  for (const e of entries) if (!parseIpEntry(e)) throw E.validation(`IP ไม่ถูกต้อง: ${e}`, { field: 'ip_allowlist' });
  return entries.length ? entries.join(',') : null;
}

function ipAllowed(allowlist, ip) {
  const block = new net.BlockList();
  for (const entry of String(allowlist).split(',')) {
    const p = parseIpEntry(entry);
    if (!p) continue;
    const type = p.family === 4 ? 'ipv4' : 'ipv6';
    if (p.prefix === null) block.addAddress(p.ip, type);
    else block.addSubnet(p.ip, p.prefix, type);
  }
  const clean = String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  const family = net.isIP(clean);
  return family ? block.check(clean, family === 4 ? 'ipv4' : 'ipv6') : false;
}

function publicKey(k) {
  return {
    id: k.id, user_id: k.user_id, user_name: k.user_name, name: k.name, key_prefix: k.key_prefix,
    webhook_url: k.webhook_url, ip_allowlist: k.ip_allowlist, status: k.status, last_used_at: k.last_used_at, created_at: k.created_at,
  };
}

function create({ userId, name, webhookUrl, ipAllowlist }, actor, ip) {
  const user = db.get('SELECT id, status FROM users WHERE id = ?', Number(userId));
  if (!user) throw E.validation('ไม่พบบัญชีผู้ใช้ที่จะผูกกับ API key', { field: 'user_id' });
  const n = String(name || '').trim().slice(0, 60);
  if (n.length < 2) throw E.validation('กรุณาตั้งชื่อ API key เช่น "เว็บร้านหลัก"', { field: 'name' });
  const key = `tk_${randomToken(24)}`;
  const secret = `whsec_${randomToken(24)}`;
  const r = db.run(
    'INSERT INTO api_keys (user_id, name, key_prefix, key_hash, webhook_url, webhook_secret, ip_allowlist, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    user.id, n, key.slice(0, 10), sha256(key), validateUrl(webhookUrl), secret, validateIps(ipAllowlist), 'active', db.nowIso(),
  );
  audit.log(actor.id, 'apikey.create', 'api_key', Number(r.lastInsertRowid), { user_id: user.id, name: n }, ip);
  // แสดงคีย์เต็มครั้งเดียวเท่านั้น (ระบบเก็บแค่ค่า hash)
  return { ...publicKey(db.get('SELECT * FROM api_keys WHERE id = ?', Number(r.lastInsertRowid))), api_key: key, webhook_secret: secret };
}

function update(id, { name, webhookUrl, ipAllowlist }, actor, ip) {
  const k = db.get('SELECT * FROM api_keys WHERE id = ?', Number(id));
  if (!k) throw E.notFound('ไม่พบ API key');
  const n = name !== undefined ? String(name).trim().slice(0, 60) : k.name;
  if (n.length < 2) throw E.validation('ชื่อ API key สั้นเกินไป', { field: 'name' });
  db.run('UPDATE api_keys SET name = ?, webhook_url = ?, ip_allowlist = ? WHERE id = ?',
    n, webhookUrl !== undefined ? validateUrl(webhookUrl) : k.webhook_url, ipAllowlist !== undefined ? validateIps(ipAllowlist) : k.ip_allowlist, k.id);
  audit.log(actor.id, 'apikey.update', 'api_key', k.id, null, ip);
  return publicKey(db.get('SELECT * FROM api_keys WHERE id = ?', k.id));
}

function revoke(id, actor, ip) {
  const r = db.run("UPDATE api_keys SET status = 'revoked' WHERE id = ? AND status = 'active'", Number(id));
  if (r.changes !== 1) throw E.validation('API key นี้ถูกยกเลิกไปแล้วหรือไม่มีอยู่');
  audit.log(actor.id, 'apikey.revoke', 'api_key', Number(id), null, ip);
}

function list() {
  return db.all('SELECT k.*, u.name AS user_name FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.id DESC').map(publicKey);
}

/** ตรวจ API key จาก header — คืน { key, user } หรือ throw */
function authenticate(token, ip) {
  if (!token || typeof token !== 'string' || !token.startsWith('tk_') || token.length > 100) throw E.unauthorized('API key ไม่ถูกต้อง');
  const k = db.get('SELECT * FROM api_keys WHERE key_hash = ?', sha256(token));
  if (!k || k.status !== 'active') throw E.unauthorized('API key ไม่ถูกต้องหรือถูกยกเลิกแล้ว');
  const cleanIp = String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (k.ip_allowlist && !ipAllowed(k.ip_allowlist, cleanIp)) throw E.forbidden(`IP ${cleanIp} ไม่ได้รับอนุญาตให้ใช้ API key นี้`);
  const user = db.get('SELECT * FROM users WHERE id = ?', k.user_id);
  if (!user || user.status !== 'active') throw E.forbidden('บัญชีที่ผูกกับ API key ถูกระงับ');
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60000) db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', db.nowIso(), k.id);
  return { key: k, user };
}

module.exports = { create, update, revoke, list, authenticate, ipAllowed, validateIps };
