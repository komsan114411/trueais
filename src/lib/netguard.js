'use strict';
/**
 * กันการยิงคำขอไปยังเครือข่ายภายใน (SSRF)
 * webhook / callback_url ของร้านค้าต้องชี้ไปที่อยู่สาธารณะเท่านั้น — ห้าม localhost, วง LAN, metadata ของ cloud ฯลฯ
 * ตรวจ 2 ชั้น: ตอนบันทึก URL (validatePublicUrl) และตอนเชื่อมต่อจริงหลังแปลงชื่อโดเมนเป็น IP (safePost)
 * ชั้นที่ 2 กันกรณีโดเมนเปลี่ยน IP ภายหลัง (DNS rebinding)
 */
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const config = require('../config');
const { E } = require('./errors');

// แยกรายการ IPv4 / IPv6 คนละชุด — BlockList ของ Node เทียบ IPv4 กับกฎ IPv6 แบบ mapped ด้วย
// (ถ้ารวมชุดเดียว กฎ ::ffff:0:0/96 จะบล็อก IPv4 ทุกเบอร์)
const BLOCKED_V4 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED_V4.addSubnet(addr, prefix, 'ipv4');
const BLOCKED_V6 = new net.BlockList();
for (const [addr, prefix] of [
  ['::', 96], // ::, ::1 และ IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped (DNS ปกติไม่ตอบแบบนี้ — บล็อกทั้งหมด)
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED_V6.addSubnet(addr, prefix, 'ipv6');

/** true = เป็น IP ภายใน/สงวน (ห้ามส่งไป) — ค่าที่ไม่ใช่ IP ถือว่าห้าม */
function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED_V4.check(ip, 'ipv4');
  if (family === 6) return BLOCKED_V6.check(ip, 'ipv6');
  return true;
}

/** IP นี้อยู่ในเครือข่ายภายใน/เครื่องเดียวกันหรือไม่ (รองรับรูปแบบ ::ffff:a.b.c.d ที่ Node ใช้กับการเชื่อมต่อ IPv4) */
function isPrivateNetworkIp(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(String(ip || ''));
  return isBlockedIp(m ? m[1] : String(ip || ''));
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.home.arpa', '.corp'];
function isInternalHostname(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || !h.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((s) => h.endsWith(s));
}

const allowPrivate = () => Boolean(config.webhookAllowPrivate);
const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, '');
// พอร์ตต่ำกว่า 1024 (เช่น 22 SSH, 25 อีเมล) ไม่ใช่ปลายทาง webhook ปกติ — กันใช้ระบบเรายิงบริการอื่น
const portAllowed = (u) => !u.port || ['80', '443'].includes(u.port) || Number(u.port) >= 1024;

/** ตรวจ URL ก่อนบันทึก: ต้องเป็น http(s) ที่อยู่สาธารณะ ไม่มีชื่อผู้ใช้/รหัสผ่านใน URL — คืน URL ที่จัดรูปแบบแล้ว */
function validatePublicUrl(value, field = 'url', label = 'URL') {
  const s = String(value ?? '').trim();
  let u;
  try { u = new URL(s); } catch { throw E.validation(`${label} ไม่ถูกต้อง`, { field }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw E.validation(`${label} ต้องขึ้นต้นด้วย http:// หรือ https://`, { field });
  if (u.username || u.password) throw E.validation(`${label} ห้ามมีชื่อผู้ใช้หรือรหัสผ่านอยู่ในลิงก์`, { field });
  const out = u.toString();
  if (out.length > 500) throw E.validation(`${label} ยาวเกิน 500 ตัวอักษร`, { field });
  if (!portAllowed(u)) throw E.validation(`${label} ใช้พอร์ต ${u.port} ไม่ได้ (ใช้ได้: 80, 443 หรือ 1024 ขึ้นไป)`, { field });
  if (!allowPrivate()) {
    const host = hostOf(u);
    if (net.isIP(host) ? isBlockedIp(host) : isInternalHostname(host)) {
      throw E.validation(`${label} ต้องเป็นที่อยู่สาธารณะบนอินเทอร์เน็ต (ห้ามใช้ localhost หรือ IP ภายใน)`, { field });
    }
  }
  return out;
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!allowPrivate()) {
      const bad = addresses.find((a) => isBlockedIp(a.address));
      if (bad) {
        const e = new Error(`ปลายทางเป็นที่อยู่ภายใน (${bad.address}) ระบบไม่อนุญาตให้ส่ง`);
        e.code = 'EBLOCKEDADDR';
        return callback(e);
      }
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * POST ไปยัง URL ภายนอกอย่างปลอดภัย: ตรวจ IP ตอนเชื่อมต่อ, ไม่ตาม redirect, จำกัดเวลารวม, ไม่อ่าน body เกิน 64KB
 * คืน { ok, status, error }
 */
function safePost(url, { headers = {}, body = '', timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ ok: false, status: null, error: 'URL ไม่ถูกต้อง' }); return; }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) { resolve({ ok: false, status: null, error: 'รองรับเฉพาะ http/https' }); return; }
    const host = hostOf(u);
    if (!portAllowed(u)) { resolve({ ok: false, status: null, error: `ไม่อนุญาตพอร์ต ${u.port}` }); return; }
    if (!allowPrivate() && (net.isIP(host) ? isBlockedIp(host) : isInternalHostname(host))) {
      resolve({ ok: false, status: null, error: 'ปลายทางเป็นที่อยู่ภายใน ระบบไม่อนุญาตให้ส่ง' });
      return;
    }
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(r);
    };
    const req = mod.request(u, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      lookup: guardedLookup,
      agent: false,
    }, (res) => {
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) res.destroy();
      });
      const done = () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, error: res.statusCode >= 200 && res.statusCode < 300 ? null : `HTTP ${res.statusCode}` });
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
    });
    const deadline = setTimeout(() => {
      req.destroy();
      finish({ ok: false, status: null, error: `หมดเวลา (${Math.round(timeoutMs / 1000)} วินาที)` });
    }, timeoutMs);
    deadline.unref?.();
    req.on('error', (e) => finish({ ok: false, status: null, error: e.code === 'EBLOCKEDADDR' ? e.message : e.code || e.message || 'ส่งไม่สำเร็จ' }));
    req.end(body);
  });
}

module.exports = { isBlockedIp, isPrivateNetworkIp, isInternalHostname, validatePublicUrl, safePost };
