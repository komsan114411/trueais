'use strict';
// สมาชิก: สมัคร, เข้าสู่ระบบ, เซสชัน, จัดการผู้ใช้ (แอดมิน)
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const { E, AppError } = require('../lib/errors');
const { hashPassword, verifyPassword, dummyVerify, randomToken, sha256 } = require('../lib/security');
const { normalizePhone } = require('../lib/phone');
const totp = require('../lib/totp');
const QRCode = require('qrcode');
const settings = require('./settings');
const audit = require('./audit');
const logger = require('../lib/logger');
const { alertAdmin } = require('../lib/notify');

// กันเดารหัสผ่าน แบบที่คนร้ายใช้ "ล็อกบัญชีคนอื่น" ไม่ได้ง่ายๆ:
//   - ผิด 5 ครั้งจาก IP เดียวกัน → ล็อกเฉพาะ IP นั้นกับบัญชีนั้น 15 นาที
//   - ผิดรวมทุก IP 30 ครั้งติด → ล็อกทั้งบัญชี 15 นาที + แจ้งแอดมิน (ยกเว้น IP ที่เจ้าของบัญชีล็อกอินสำเร็จล่าสุด)
const MAX_FAILED_PER_IP = 5;
const MAX_FAILED_ACCOUNT = 30;
const LOCK_MINUTES = 15;
const ipFailures = new Map(); // `${userId}|${ip}` → { count, lockedUntil, last }

function ipKey(ip) {
  const s = String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  // IPv6: นับรวมทั้งวง /64 (คนร้ายเปลี่ยน IP ในวงเดียวกันได้ง่าย)
  return s.includes(':') ? s.split(':').slice(0, 4).join(':') : s;
}

/** ปลดล็อกการเข้าสู่ระบบของบัญชีนี้ทุก IP (ใช้ตอนแอดมินรีเซ็ตรหัส/เปิดใช้บัญชี) */
function clearLoginFailures(u) {
  const prefix = `u:${u.id}|`;
  for (const k of [...ipFailures.keys()]) if (k.startsWith(prefix)) ipFailures.delete(k);
  mfaFailures.delete(u.id);
}

function sweepIpFailures() {
  if (ipFailures.size < 5000) return;
  const now = Date.now();
  for (const [k, v] of ipFailures) if (v.lockedUntil < now && now - v.last > LOCK_MINUTES * 60000) ipFailures.delete(k);
  while (ipFailures.size > 20000) ipFailures.delete(ipFailures.keys().next().value);
}

// รหัสผ่านยอดนิยมที่ถูกเดาง่าย (ตรวจตอนสมัคร/เปลี่ยนรหัส)
const COMMON_PASSWORDS = new Set([
  'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'qwerty123', 'qwerty1234', 'abc12345',
  'abcd1234', 'abc123456', 'a1234567', 'a12345678', 'aa123456', 'admin123', 'admin1234', 'admin12345', 'iloveyou1',
  '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'qwe12345', 'asd12345', 'test1234', 'test12345', 'welcome1', 'letmein1', 'master123',
  'changeme1', 'thailand1', 'bangkok1', 'p12345678', 'q1w2e3r4', '12345678a', '123456789a', 'a123456789',
]);

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email,
    role: u.role,
    status: u.status,
    balance: u.balance,
    daily_limit: u.daily_limit,
    two_factor: Boolean(u.totp_secret),
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  };
}

const getById = (id) => db.get('SELECT * FROM users WHERE id = ?', id);

function validateName(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 60) throw E.validation('กรุณากรอกชื่อ 2-60 ตัวอักษร', { field: 'name' });
  return n;
}

function validateEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return null;
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw E.validation('อีเมลไม่ถูกต้อง', { field: 'email' });
  return e;
}

function validatePassword(pw, field = 'password', { phone, email } = {}) {
  const p = String(pw ?? '');
  if (p.length < 8 || p.length > 128) throw E.validation('รหัสผ่านต้องมี 8-128 ตัวอักษร', { field });
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw E.validation('รหัสผ่านต้องมีทั้งตัวอักษรภาษาอังกฤษและตัวเลข', { field });
  const lower = p.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(p.replace(/\d+$/, '')) || /^(?:0123456789|1234567890|123456789)/.test(p)) {
    throw E.validation('รหัสผ่านนี้เดาง่ายเกินไป กรุณาตั้งรหัสที่คาดเดายากกว่านี้', { field });
  }
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 9 && p.replace(/\D/g, '').includes(digits.slice(-8))) {
    throw E.validation('รหัสผ่านห้ามมีเบอร์โทรศัพท์ของตัวเอง', { field });
  }
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) throw E.validation('รหัสผ่านห้ามมีชื่ออีเมลของตัวเอง', { field });
  return p;
}

async function createUser({ name, phone, email, password, role = 'customer' }, { requirePhone = true } = {}) {
  const n = validateName(name);
  let p = null;
  if (phone || requirePhone) {
    p = normalizePhone(phone);
    if (!p) throw new AppError('INVALID_PHONE', 'เบอร์โทรศัพท์ไม่ถูกต้อง ต้องเป็นเบอร์มือถือ 10 หลัก', 400, { field: 'phone' });
  }
  const e = validateEmail(email);
  if (!p && !e) throw E.validation('ต้องมีเบอร์โทรหรืออีเมลอย่างน้อย 1 อย่าง');
  validatePassword(password, 'password', { phone: p, email: e });
  if (!['customer', 'admin'].includes(role)) throw E.validation('สิทธิ์ผู้ใช้ไม่ถูกต้อง');
  if (p && db.get('SELECT id FROM users WHERE phone = ?', p)) throw E.conflict('PHONE_TAKEN', 'เบอร์นี้ถูกใช้สมัครแล้ว', { field: 'phone' });
  if (e && db.get('SELECT id FROM users WHERE email = ?', e)) throw E.conflict('EMAIL_TAKEN', 'อีเมลนี้ถูกใช้สมัครแล้ว', { field: 'email' });
  const hash = await hashPassword(password);
  const now = db.nowIso();
  try {
    const r = db.run(
      'INSERT INTO users (name, phone, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      n, p, e, hash, role, now, now,
    );
    return getById(Number(r.lastInsertRowid));
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw E.conflict('ACCOUNT_TAKEN', 'เบอร์หรืออีเมลนี้ถูกใช้สมัครแล้ว');
    throw err;
  }
}

async function register(input, { ip } = {}) {
  if (!settings.get('registration_enabled')) throw E.forbidden('ปิดรับสมัครสมาชิกชั่วคราว');
  const user = await createUser({ ...input, role: 'customer' });
  audit.log(user.id, 'user.register', 'user', user.id, null, ip);
  return user;
}

// ───────────── เซสชัน ─────────────

function createSession(userId, { ip, userAgent } = {}) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionDays * 86400000);
  db.run(
    'INSERT INTO sessions (id, user_id, csrf, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token), userId, csrf, ip, String(userAgent || '').slice(0, 200), now.toISOString(), now.toISOString(), expires.toISOString(),
  );
  return { token, csrf, expiresAt: expires };
}

function getSession(token, { background = false } = {}) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const id = sha256(token);
  const row = db.get(
    `SELECT s.id AS session_id, s.csrf AS session_csrf, s.expires_at AS session_expires, s.last_seen_at AS session_seen,
            s.created_at AS session_created, u.*
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    id,
  );
  if (!row) return null;
  const now = Date.now();
  const hardLimit = Date.parse(row.session_created) + config.sessionMaxDays * 86400000;
  const adminIdle = row.role === 'admin' && now - Date.parse(row.session_seen) > config.adminIdleHours * 3600000;
  if (Date.parse(row.session_expires) < now || now > hardLimit || adminIdle) {
    db.run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  if (row.status !== 'active') return null;
  // คำขอเบื้องหลัง (รีเฟรชอัตโนมัติ) ไม่ต่อเวลา — แอดมินที่เปิดหน้าทิ้งไว้จะถูกออกจากระบบตามเวลาที่ตั้ง
  let extendedUntil = null;
  if (!background && now - Date.parse(row.session_seen) > 10 * 60 * 1000) {
    const nextExpiry = Math.min(now + config.sessionDays * 86400000, hardLimit);
    db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', db.nowIso(), new Date(nextExpiry).toISOString(), id);
    extendedUntil = nextExpiry;
  }
  const { session_id, session_csrf, session_expires, session_seen, session_created, ...user } = row;
  return { id: session_id, csrf: session_csrf, user, extendedUntil };
}

const destroySession = (token) => token && db.run('DELETE FROM sessions WHERE id = ?', sha256(token));
const destroyUserSessions = (userId, exceptSessionId = null) =>
  db.run('DELETE FROM sessions WHERE user_id = ? AND id IS DISTINCT FROM ?', userId, exceptSessionId);

// ───────────── เข้าสู่ระบบ ─────────────

async function login({ identifier, password }, { ip, userAgent } = {}) {
  const id = String(identifier ?? '').trim();
  if (!id || !password) throw E.validation('กรุณากรอกเบอร์โทร/อีเมล และรหัสผ่าน');
  const phone = normalizePhone(id);
  const email = id.toLowerCase().slice(0, 200);
  const invalid = () => new AppError('INVALID_CREDENTIALS', 'เบอร์โทร/อีเมล หรือรหัสผ่านไม่ถูกต้อง', 401);
  const lockedMsg = (until) => new AppError('ACCOUNT_LOCKED', `ใส่รหัสผ่านผิดหลายครั้ง ระบบล็อกการเข้าสู่ระบบชั่วคราว กรุณาลองใหม่ในอีก ${Math.max(1, Math.ceil((until - Date.now()) / 60000))} นาที`, 423);
  if (typeof password !== 'string' || password.length > 256) {
    await dummyVerify('x');
    throw invalid();
  }
  const user = phone ? db.get('SELECT * FROM users WHERE phone = ?', phone) : db.get('SELECT * FROM users WHERE email = ?', email);
  // นับผิดต่อ "บัญชี + IP" (บัญชีที่ไม่มีจริงนับตามชื่อที่กรอก → ถูกล็อกเหมือนกัน เดาไม่ได้ว่าบัญชีไหนมีอยู่)
  const fk = `${user ? `u:${user.id}` : phone ? `p:${phone}` : `e:${email}`}|${ipKey(ip)}`;
  const f = ipFailures.get(fk);
  if (f && f.lockedUntil > Date.now()) {
    await dummyVerify(password); // เวลาตอบเท่ากับกรณีปกติ
    throw lockedMsg(f.lockedUntil);
  }
  const recordFailure = () => {
    const entry = f && Date.now() - f.last < LOCK_MINUTES * 60000 ? f : { count: 0, lockedUntil: 0, last: 0 };
    entry.count += 1;
    entry.last = Date.now();
    if (entry.count >= MAX_FAILED_PER_IP) {
      entry.count = 0;
      entry.lockedUntil = Date.now() + LOCK_MINUTES * 60000;
    }
    ipFailures.set(fk, entry);
    sweepIpFailures();
    return entry.lockedUntil > Date.now();
  };
  if (!user) {
    await dummyVerify(password);
    recordFailure();
    throw invalid();
  }
  // ล็อกทั้งบัญชี — ยกเว้น IP ที่เจ้าของบัญชีเคยเข้าสำเร็จล่าสุด (คนร้ายจึงล็อกเจ้าของออกจากบัญชีไม่ได้ง่ายๆ)
  const accountLockedUntil = user.locked_until ? Date.parse(user.locked_until) : 0;
  if (accountLockedUntil > Date.now() && ipKey(user.last_login_ip) !== ipKey(ip)) {
    await dummyVerify(password);
    throw lockedMsg(accountLockedUntil);
  }

  const ok = await verifyPassword(password, user.password_hash);
  const now = db.nowIso();
  if (!ok) {
    if (recordFailure()) audit.log(null, 'user.locked_ip', 'user', user.id, { reason: `รหัสผ่านผิด ${MAX_FAILED_PER_IP} ครั้งจาก IP เดียวกัน`, ip }, ip);
    const failed = user.failed_logins + 1;
    const lock = failed >= MAX_FAILED_ACCOUNT ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
    db.run('UPDATE users SET failed_logins = ?, locked_until = COALESCE(?, locked_until), updated_at = ? WHERE id = ?', lock ? 0 : failed, lock, now, user.id);
    if (lock) {
      audit.log(null, 'user.locked', 'user', user.id, { reason: `รหัสผ่านผิดรวม ${MAX_FAILED_ACCOUNT} ครั้ง` }, ip);
      alertAdmin(`locked-${user.id}`, `มีการเดารหัสผ่านบัญชี ${user.email || user.phone} (ผิดรวม ${MAX_FAILED_ACCOUNT} ครั้ง) ระบบล็อกบัญชีชั่วคราว ${LOCK_MINUTES} นาที\nIP ล่าสุด: ${ip}`, { cooldownSec: 1800 });
    }
    throw invalid();
  }
  if (user.status !== 'active') throw E.forbidden('บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
  ipFailures.delete(fk);
  if (user.totp_secret) {
    // เปิดยืนยันตัวตน 2 ชั้นไว้ → ต้องใส่รหัส 6 หลักจากแอปก่อน (ยังไม่สร้างเซสชัน)
    db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', now, user.id);
    return { mfaRequired: true, mfaToken: createMfaChallenge(user.id) };
  }
  return completeLogin(user, { ip, userAgent });
}

function completeLogin(user, { ip, userAgent }) {
  const now = db.nowIso();
  db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?', now, ip, now, user.id);
  const session = createSession(user.id, { ip, userAgent });
  audit.log(user.id, 'user.login', 'user', user.id, null, ip);
  return { ...session, user: getById(user.id) };
}

// ───────────── ยืนยันตัวตน 2 ชั้น (รหัส 6 หลักจากแอป Authenticator) ─────────────

const MFA_TTL_MS = 5 * 60000;
const MFA_MAX_ATTEMPTS = 5; // ใส่รหัสผิดได้กี่ครั้งต่อการล็อกอิน 1 รอบ
const MFA_MAX_FAILS = 10; // ใส่ผิดรวมกี่ครั้ง (ทุกรอบ) แล้วล็อกการยืนยัน 15 นาที
const mfaChallenges = new Map(); // sha256(token) → { userId, expires, attempts }
const mfaFailures = new Map(); // userId → { count, until, last }

function createMfaChallenge(userId) {
  const now = Date.now();
  for (const [k, v] of mfaChallenges) if (v.expires < now) mfaChallenges.delete(k);
  while (mfaChallenges.size > 10000) mfaChallenges.delete(mfaChallenges.keys().next().value);
  const token = randomToken(32);
  mfaChallenges.set(sha256(token), { userId, expires: now + MFA_TTL_MS, attempts: 0 });
  return token;
}

const invalidCode = (message = 'รหัสยืนยันไม่ถูกต้อง หรือหมดอายุแล้ว (รหัสเปลี่ยนทุก 30 วินาที)') => new AppError('INVALID_CODE', message, 401, { field: 'code' });

function loginMfa({ mfaToken, code }, { ip, userAgent } = {}) {
  const key = typeof mfaToken === 'string' && mfaToken.length <= 100 ? sha256(mfaToken) : null;
  const ch = key ? mfaChallenges.get(key) : null;
  if (!ch || ch.expires < Date.now()) {
    if (key) mfaChallenges.delete(key);
    throw new AppError('MFA_EXPIRED', 'หมดเวลายืนยันตัวตน กรุณาเข้าสู่ระบบใหม่อีกครั้ง', 401);
  }
  const user = getById(ch.userId);
  if (!user || user.status !== 'active' || !user.totp_secret) {
    mfaChallenges.delete(key);
    throw new AppError('MFA_EXPIRED', 'กรุณาเข้าสู่ระบบใหม่อีกครั้ง', 401);
  }
  const lock = mfaFailures.get(user.id);
  if (lock && lock.until > Date.now()) {
    throw new AppError('ACCOUNT_LOCKED', `ใส่รหัสยืนยันผิดหลายครั้ง กรุณาลองใหม่ในอีก ${Math.ceil((lock.until - Date.now()) / 60000)} นาที`, 423);
  }
  const step = totp.verify(user.totp_secret, code, { lastStep: user.totp_last_step });
  // บันทึก step ที่ใช้แล้วแบบมีเงื่อนไข — รหัสเดียวกันใช้ซ้ำไม่ได้แม้ยิงพร้อมกัน
  const used = step !== null && db.run(
    'UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', step, user.id, step,
  ).changes === 1;
  if (!used) {
    ch.attempts += 1;
    const f = lock && Date.now() - lock.last < 15 * 60000 ? lock : { count: 0, until: 0, last: 0 };
    f.count += 1;
    f.last = Date.now();
    if (f.count >= MFA_MAX_FAILS) {
      f.count = 0;
      f.until = Date.now() + 15 * 60000;
      alertAdmin(`mfa-${user.id}`, `มีการใส่รหัสยืนยัน 2 ชั้นผิดหลายครั้งในบัญชี ${user.email || user.phone} (รหัสผ่านถูกแล้ว) — ถ้าไม่ใช่เจ้าของบัญชี ให้เปลี่ยนรหัสผ่านทันที\nIP: ${ip}`, { cooldownSec: 1800 });
    }
    mfaFailures.set(user.id, f);
    audit.log(user.id, 'user.mfa_failed', 'user', user.id, null, ip);
    if (ch.attempts >= MFA_MAX_ATTEMPTS) {
      mfaChallenges.delete(key);
      throw new AppError('MFA_EXPIRED', 'ใส่รหัสยืนยันผิดหลายครั้ง กรุณาเข้าสู่ระบบใหม่อีกครั้ง', 401);
    }
    throw invalidCode();
  }
  mfaChallenges.delete(key);
  mfaFailures.delete(user.id);
  return completeLogin(user, { ip, userAgent });
}

/** เริ่มเปิดใช้: ยืนยันรหัสผ่าน → สร้างรหัสลับ + QR ให้สแกนด้วยแอป (ยังไม่เปิดจนกว่าจะยืนยันรหัส 6 หลัก) */
async function totpSetup(user, password, { sessionId } = {}) {
  const row = getById(user.id);
  if (row.totp_secret) throw E.validation('เปิดใช้การยืนยันตัวตน 2 ชั้นอยู่แล้ว');
  await checkCurrentPassword(row, password, { sessionId, field: 'password', message: 'รหัสผ่านไม่ถูกต้อง' });
  const secret = totp.generateSecret();
  db.run('UPDATE users SET totp_pending = ?, updated_at = ? WHERE id = ?', secret, db.nowIso(), row.id);
  const url = totp.otpauthUrl({ secret, account: row.email || row.phone || `user${row.id}`, issuer: settings.get('site_name') || 'TopUp' });
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 220 });
  return { secret, otpauth_url: url, qr_svg: svg };
}

function totpEnable(user, code, { sessionId, ip } = {}) {
  const row = getById(user.id);
  if (row.totp_secret) throw E.validation('เปิดใช้การยืนยันตัวตน 2 ชั้นอยู่แล้ว');
  if (!row.totp_pending) throw E.validation('กรุณากดเริ่มตั้งค่าใหม่อีกครั้ง');
  const step = totp.verify(row.totp_pending, code);
  if (step === null) throw new AppError('INVALID_CODE', 'รหัสไม่ถูกต้อง — ตรวจว่าเวลาในโทรศัพท์ตรง แล้วใส่รหัสล่าสุดจากแอป', 400, { field: 'code' });
  const now = db.nowIso();
  db.run('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ?, updated_at = ? WHERE id = ?', now, step, now, row.id);
  destroyUserSessions(row.id, sessionId); // ออกจากระบบอุปกรณ์อื่นทั้งหมด
  audit.log(row.id, 'user.2fa_enable', 'user', row.id, null, ip);
  return getById(row.id);
}

async function totpDisable(user, { password, code }, { ip, sessionId } = {}) {
  const row = getById(user.id);
  if (!row.totp_secret) throw E.validation('ยังไม่ได้เปิดใช้การยืนยันตัวตน 2 ชั้น');
  await checkCurrentPassword(row, password, { sessionId, field: 'password', message: 'รหัสผ่านไม่ถูกต้อง' });
  const step = totp.verify(row.totp_secret, code, { lastStep: row.totp_last_step });
  if (step === null) throw new AppError('INVALID_CODE', 'รหัสยืนยันไม่ถูกต้อง', 400, { field: 'code' });
  db.run('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?', db.nowIso(), row.id);
  audit.log(row.id, 'user.2fa_disable', 'user', row.id, null, ip);
  return getById(row.id);
}

/**
 * ยืนยันตัวตนผู้ทำรายการอีกครั้ง (รหัสผ่าน + รหัส 6 หลักถ้าเปิดยืนยัน 2 ชั้นไว้)
 * ใช้กับการกระทำที่มีผลกับบัญชีแอดมิน: ตั้งรหัสผ่านใหม่ / ปิดยืนยัน 2 ชั้น / ระงับ / เปลี่ยนสิทธิ์
 * กันแอดมินคนหนึ่ง (หรือคนที่แอบใช้เครื่องที่ล็อกอินค้างไว้) ยึดบัญชีเจ้าของร้าน — ใส่รหัสผิด 5 ครั้ง = ออกจากระบบ
 */
async function requireReauth(actor, auth = {}, { sessionId } = {}) {
  const row = getById(actor.id);
  const pw = auth?.actor_password;
  if (pw === undefined || pw === null || pw === '') {
    throw new AppError('REAUTH_REQUIRED', 'การกระทำนี้มีผลกับบัญชีแอดมิน — กรุณายืนยันรหัสผ่านของคุณอีกครั้ง', 403, { totp: Boolean(row.totp_secret) });
  }
  try {
    await checkCurrentPassword(row, pw, { sessionId, field: 'actor_password', message: 'รหัสผ่านของคุณไม่ถูกต้อง' });
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') throw new AppError('REAUTH_FAILED', 'รหัสผ่านของคุณไม่ถูกต้อง', 403, { field: 'actor_password' });
    throw err;
  }
  if (row.totp_secret) {
    if (!auth.actor_code) throw new AppError('REAUTH_REQUIRED', 'กรุณากรอกรหัส 6 หลักจากแอปยืนยันตัวตนของคุณด้วย', 403, { totp: true });
    const step = totp.verify(row.totp_secret, auth.actor_code, { lastStep: row.totp_last_step });
    if (step === null) throw new AppError('REAUTH_FAILED', 'รหัสยืนยัน 6 หลักไม่ถูกต้อง หรือหมดอายุแล้ว', 403, { field: 'actor_code' });
    db.run('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', step, row.id, step);
  }
}

/** แจ้งแอดมินทุกคน (LINE/Telegram) เมื่อมีการแตะบัญชีแอดมิน */
function alertAdminAccountChange(actor, target, what) {
  alertAdmin(`admin-acct-${target.id}-${Date.now()}`, `บัญชีแอดมิน ${target.email || target.phone || target.id} ถูก${what} โดย ${actor.email || actor.name || actor.id} — ถ้าไม่ใช่คุณทำ กรุณาตรวจสอบทันที`, { cooldownSec: 0 });
}

/** แอดมินปิดการยืนยัน 2 ชั้นให้ลูกค้า (เช่น ลูกค้าทำโทรศัพท์หาย) — ออกจากระบบทุกอุปกรณ์ของบัญชีนั้นด้วย */
async function adminResetTotp(id, actor, ip, auth = {}, ctx = {}) {
  const u = getById(Number(id));
  if (!u) throw E.notFound('ไม่พบผู้ใช้');
  if (!u.totp_secret && !u.totp_pending) throw E.validation('บัญชีนี้ไม่ได้เปิดใช้การยืนยันตัวตน 2 ชั้น');
  if (u.role === 'admin') await requireReauth(actor, auth, ctx);
  db.run('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?', db.nowIso(), u.id);
  destroyUserSessions(u.id);
  audit.log(actor.id, 'user.2fa_reset', 'user', u.id, null, ip);
  if (u.role === 'admin') alertAdminAccountChange(actor, u, 'ปิดการยืนยันตัวตน 2 ชั้น');
  return getById(u.id);
}

// ───────────── อุปกรณ์ที่เข้าสู่ระบบอยู่ ─────────────

function listSessions(user, currentSessionId) {
  return db.all('SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', user.id, db.nowIso())
    .map((s) => ({ id: s.id.slice(0, 16), ip: s.ip, user_agent: s.user_agent, created_at: s.created_at, last_seen_at: s.last_seen_at, current: s.id === currentSessionId }));
}

function revokeSession(user, shortId, currentSessionId) {
  const sid = String(shortId || '');
  if (!/^[a-f0-9]{16}$/.test(sid)) throw E.notFound('ไม่พบอุปกรณ์นี้');
  const row = db.get("SELECT id FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?", user.id, sid);
  if (!row) throw E.notFound('ไม่พบอุปกรณ์นี้');
  if (row.id === currentSessionId) throw E.validation('อุปกรณ์นี้คือเครื่องที่ใช้อยู่ — ใช้ปุ่ม "ออกจากระบบ" แทน');
  db.run('DELETE FROM sessions WHERE id = ?', row.id);
}

// ใส่รหัสผ่านปัจจุบันผิด (ตอนเปลี่ยนรหัส/ตั้งค่าความปลอดภัย) เกิน 5 ครั้ง → ออกจากระบบเครื่องนั้นทันที
// กันคนที่ได้เซสชันไป (เช่น ลืมออกจากระบบที่เครื่องสาธารณะ) เดารหัสผ่านจริงต่อเรื่อยๆ
const reauthFailures = new Map(); // sessionId → count
async function checkCurrentPassword(row, password, { sessionId, field = 'currentPassword', message = 'รหัสผ่านปัจจุบันไม่ถูกต้อง' } = {}) {
  if (await verifyPassword(String(password ?? ''), row.password_hash)) {
    if (sessionId) reauthFailures.delete(sessionId);
    return;
  }
  if (sessionId) {
    const count = (reauthFailures.get(sessionId) || 0) + 1;
    reauthFailures.set(sessionId, count);
    while (reauthFailures.size > 5000) reauthFailures.delete(reauthFailures.keys().next().value);
    if (count >= 5) {
      reauthFailures.delete(sessionId);
      db.run('DELETE FROM sessions WHERE id = ?', sessionId);
      audit.log(row.id, 'user.reauth_locked', 'user', row.id, { reason: 'ใส่รหัสผ่านปัจจุบันผิด 5 ครั้ง' });
      throw new AppError('UNAUTHORIZED', 'ใส่รหัสผ่านผิดหลายครั้ง ระบบออกจากระบบให้เพื่อความปลอดภัย กรุณาเข้าสู่ระบบใหม่', 401);
    }
  }
  throw new AppError('INVALID_CREDENTIALS', message, 400, { field });
}

async function changePassword(user, currentPassword, newPassword, { sessionId, ip } = {}) {
  const row = getById(user.id);
  await checkCurrentPassword(row, currentPassword, { sessionId });
  validatePassword(newPassword, 'newPassword', { phone: row.phone, email: row.email });
  if (currentPassword === newPassword) throw E.validation('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม', { field: 'newPassword' });
  db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(newPassword), db.nowIso(), user.id);
  destroyUserSessions(user.id, sessionId);
  audit.log(user.id, 'user.password_change', 'user', user.id, null, ip);
  if (row.role === 'admin') removeBootstrapPasswordFile();
}

/** ไฟล์รหัสผ่านแอดมินที่ระบบสุ่มให้ตอนติดตั้ง — ลบทิ้งเมื่อแอดมินเปลี่ยนรหัสแล้ว (ไม่ให้รหัสค้างอยู่ในเครื่อง) */
function removeBootstrapPasswordFile() {
  try { fs.rmSync(path.join(config.dataDir, 'ADMIN-PASSWORD.txt'), { force: true }); } catch { /* ignore */ }
}

function updateProfile(user, { name, email }) {
  const n = validateName(name);
  const e = validateEmail(email);
  const current = getById(user.id);
  // บัญชีที่ไม่มีเบอร์โทร (เช่น แอดมิน) ต้องมีอีเมลไว้ใช้เข้าสู่ระบบ — ห้ามลบอีเมลทิ้ง
  if (!e && !current.phone) throw E.validation('บัญชีนี้ใช้อีเมลเข้าสู่ระบบ จึงต้องมีอีเมล', { field: 'email' });
  if (e && db.get('SELECT id FROM users WHERE email = ? AND id != ?', e, user.id)) throw E.conflict('EMAIL_TAKEN', 'อีเมลนี้ถูกใช้แล้ว', { field: 'email' });
  db.run('UPDATE users SET name = ?, email = ?, updated_at = ? WHERE id = ?', n, e, db.nowIso(), user.id);
  return getById(user.id);
}

// ───────────── แอดมิน ─────────────

function list({ q, role, status, page, pageSize } = {}) {
  const where = [];
  const params = [];
  if (q) {
    const like = `%${String(q).trim().replace(/[%_]/g, '')}%`;
    // เบอร์ที่พิมพ์แบบมีขีด/ช่องว่าง (089-123-4567) → ค้นด้วยตัวเลขล้วน
    const digits = String(q).replace(/[^0-9]/g, '');
    const phoneLike = digits.length >= 3 ? `%${digits}%` : like;
    where.push('(u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ? OR CAST(u.id AS TEXT) = ?)');
    params.push(like, phoneLike, like, String(q).trim());
  }
  if (role) { where.push('u.role = ?'); params.push(role); }
  if (status) { where.push('u.status = ?'); params.push(status); }
  const res = db.paged({
    select: `u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
             (SELECT COALESCE(SUM(price), 0) FROM orders o WHERE o.user_id = u.id AND o.status = 'success') AS total_spent`,
    from: 'users u', where, params, order: 'u.id DESC', page, pageSize,
  });
  res.rows = res.rows.map((u) => ({ ...publicUser(u), order_count: u.order_count, total_spent: u.total_spent, locked_until: u.locked_until, last_login_ip: u.last_login_ip }));
  return res;
}

function detail(id) {
  const u = getById(Number(id));
  if (!u) throw E.notFound('ไม่พบผู้ใช้');
  const stats = db.get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN status = 'success' THEN price END), 0) AS spent,
            COALESCE(SUM(CASE WHEN status = 'success' THEN price - cost END), 0) AS profit,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success, COALESCE(SUM(CASE WHEN status IN ('failed','refunded') THEN 1 ELSE 0 END), 0) AS failed
     FROM orders WHERE user_id = ?`,
    u.id,
  );
  return { user: { ...publicUser(u), locked_until: u.locked_until, last_login_ip: u.last_login_ip }, stats };
}

async function setStatus(id, status, actor, ip, auth = {}, ctx = {}) {
  if (!['active', 'suspended'].includes(status)) throw E.validation('สถานะไม่ถูกต้อง');
  const u = getById(Number(id));
  if (!u) throw E.notFound('ไม่พบผู้ใช้');
  if (u.id === actor.id) throw E.validation('ไม่สามารถระงับบัญชีของตัวเองได้');
  if (status === 'suspended' && u.role === 'admin' && countActiveAdmins() <= 1) throw E.validation('ต้องมีแอดมินที่ใช้งานได้อย่างน้อย 1 คน');
  if (u.role === 'admin') await requireReauth(actor, auth, ctx);
  db.run('UPDATE users SET status = ?, locked_until = NULL, failed_logins = 0, updated_at = ? WHERE id = ?', status, db.nowIso(), u.id);
  clearLoginFailures(u);
  if (status === 'suspended') destroyUserSessions(u.id);
  audit.log(actor.id, status === 'suspended' ? 'user.suspend' : 'user.activate', 'user', u.id, null, ip);
  if (u.role === 'admin') alertAdminAccountChange(actor, u, status === 'suspended' ? 'ระงับการใช้งาน' : 'เปิดใช้งานอีกครั้ง');
  return getById(u.id);
}

async function setRole(id, role, actor, ip, auth = {}, ctx = {}) {
  if (!['customer', 'admin'].includes(role)) throw E.validation('สิทธิ์ไม่ถูกต้อง');
  const u = getById(Number(id));
  if (!u) throw E.notFound('ไม่พบผู้ใช้');
  if (u.id === actor.id) throw E.validation('ไม่สามารถเปลี่ยนสิทธิ์ของตัวเองได้');
  if (u.role === 'admin' && role !== 'admin' && countActiveAdmins() <= 1) throw E.validation('ต้องมีแอดมินอย่างน้อย 1 คน');
  // ปลดแอดมิน หรือแต่งตั้งแอดมินใหม่ = ต้องยืนยันตัวตนซ้ำ
  if (u.role === 'admin' || role === 'admin') await requireReauth(actor, auth, ctx);
  db.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', role, db.nowIso(), u.id);
  destroyUserSessions(u.id);
  audit.log(actor.id, 'user.role', 'user', u.id, { from: u.role, to: role }, ip);
  if (u.role === 'admin' || role === 'admin') alertAdminAccountChange(actor, u, role === 'admin' ? 'ตั้งเป็นแอดมิน' : 'ปลดจากแอดมิน');
  return getById(u.id);
}

function setDailyLimit(id, limitBaht, actor, ip) {
  const u = getById(Number(id));
  if (!u) throw E.notFound('ไม่พบผู้ใช้');
  let value = null;
  if (limitBaht !== null && limitBaht !== '' && limitBaht !== undefined) {
    const n = Number(limitBaht);
    if (!Number.isFinite(n) || n < 0 || n > 100000000) throw E.validation('วงเงินไม่ถูกต้อง');
    value = Math.round(n * 100);
  }
  db.run('UPDATE users SET daily_limit = ?, updated_at = ? WHERE id = ?', value, db.nowIso(), u.id);
  audit.log(actor.id, 'user.daily_limit', 'user', u.id, { daily_limit: value }, ip);
  return getById(u.id);
}

async function resetPassword(id, newPassword, actor, ip, auth = {}, ctx = {}) {
  const u = getById(Number(id));
  if (!u) throw E.notFound('ไม่พบผู้ใช้');
  validatePassword(newPassword, 'password', { phone: u.phone, email: u.email });
  if (u.role === 'admin') await requireReauth(actor, auth, ctx);
  db.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', await hashPassword(newPassword), db.nowIso(), u.id);
  clearLoginFailures(u);
  destroyUserSessions(u.id);
  audit.log(actor.id, 'user.password_reset', 'user', u.id, null, ip);
  if (u.role === 'admin') alertAdminAccountChange(actor, u, 'ตั้งรหัสผ่านใหม่');
}

const countActiveAdmins = () => db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'").c;

/** ตอนเปิดระบบ: ถ้ายังไม่มีแอดมิน สร้างให้จาก .env (หรือสุ่มรหัสผ่านแล้วแสดงในหน้าจอ) */
async function ensureAdmin() {
  if (db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").c > 0) return null;
  const email = config.admin.email || 'admin@example.com';
  let password = config.admin.password;
  let generated = false;
  if (!password) {
    password = `Adm${randomToken(9)}9`;
    generated = true;
  }
  const user = await createUser({ name: config.admin.name, email, password, role: 'admin' }, { requirePhone: false });
  audit.log(null, 'user.admin_bootstrap', 'user', user.id, { email });
  if (generated) {
    const file = path.join(config.dataDir, 'ADMIN-PASSWORD.txt');
    try {
      fs.writeFileSync(file, `อีเมล: ${email}\nรหัสผ่าน: ${password}\n\nเข้าสู่ระบบแล้วเปลี่ยนรหัสผ่าน จากนั้นลบไฟล์นี้ทิ้ง\n`, { mode: 0o600 });
    } catch { /* ignore */ }
    logger.warn('════════════════════════════════════════════════════');
    logger.warn(' สร้างบัญชีแอดมินครั้งแรกแล้ว');
    logger.warn(`   อีเมล    : ${email}`);
    logger.warn(`   รหัสผ่าน : ${password}`);
    logger.warn(` (บันทึกไว้ที่ ${file} ด้วย — เปลี่ยนรหัสผ่านแล้วลบไฟล์ทิ้ง)`);
    logger.warn('════════════════════════════════════════════════════');
  } else {
    logger.info(`สร้างบัญชีแอดมิน ${email} จากค่าใน .env แล้ว`);
  }
  return user;
}

const bootstrapPasswordFileExists = () => fs.existsSync(path.join(config.dataDir, 'ADMIN-PASSWORD.txt'));

module.exports = {
  publicUser, getById, createUser, register, login, loginMfa, changePassword, updateProfile,
  createSession, getSession, destroySession, destroyUserSessions, listSessions, revokeSession,
  totpSetup, totpEnable, totpDisable, adminResetTotp,
  list, detail, setStatus, setRole, setDailyLimit, resetPassword, ensureAdmin, validatePassword,
  bootstrapPasswordFileExists, removeBootstrapPasswordFile,
};
