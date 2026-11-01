'use strict';
/**
 * รหัสยืนยัน 6 หลักที่เปลี่ยนทุก 30 วินาที (TOTP ตามมาตรฐาน RFC 6238)
 * ใช้กับแอป Google Authenticator, Microsoft Authenticator, 1Password ฯลฯ
 */
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const s = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('รหัสลับ base32 ไม่ถูกต้อง');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));
const currentStep = (now = Date.now()) => Math.floor(now / 1000 / PERIOD);

/** รหัสของช่วงเวลา step (คืนเป็นสตริง 6 หลัก) */
function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const bin = ((h[offset] & 127) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * ตรวจรหัส: ยอมให้นาฬิกาคลาดได้ ±1 ช่วง (30 วินาที) และห้ามใช้รหัสเดิม/รหัสเก่ากว่าที่ใช้ไปแล้ว (กันดักรหัสไปใช้ซ้ำ)
 * คืนหมายเลข step ที่ตรง หรือ null
 */
function verify(secret, code, { lastStep = null, window = 1, now = Date.now() } = {}) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const step = currentStep(now);
  for (let d = -window; d <= window; d++) {
    const s = step + d;
    if (lastStep !== null && lastStep !== undefined && s <= lastStep) continue;
    const expected = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

function otpauthUrl({ secret, account, issuer }) {
  const label = `${issuer}:${account}`;
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD) });
  return `otpauth://totp/${encodeURIComponent(label)}?${q.toString()}`;
}

module.exports = { generateSecret, verify, codeAt, currentStep, otpauthUrl, base32Encode, base32Decode };
