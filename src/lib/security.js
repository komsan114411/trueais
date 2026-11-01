'use strict';
// รหัสผ่าน, token, ลายเซ็น HMAC
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// ใช้เทียบรหัสผ่านปลอมเมื่อไม่พบผู้ใช้ เพื่อไม่ให้เดาได้จากเวลาตอบกลับ
let dummyHash = null;
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
  return false;
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmacSha256 = (secret, data) => crypto.createHmac('sha256', String(secret)).update(data).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// อักขระที่อ่านง่าย ไม่มี 0/O/1/I
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return out;
}

/** เลขที่รายการ เช่น TP261101K7Q2M9XD (ปี ค.ศ. 2 หลัก + เดือน + วัน ตามเวลาไทย) */
function orderRef(prefix = 'TP') {
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  const ymd = bkk.toISOString().slice(2, 10).replace(/-/g, '');
  return `${prefix}${ymd}${randomCode(8)}`;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, randomToken, sha256, hmacSha256, safeEqual, randomCode, orderRef };
