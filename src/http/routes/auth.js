'use strict';
// /api/auth — สมัคร, เข้าสู่ระบบ, ออกจากระบบ, ข้อมูลตัวเอง
const express = require('express');
const config = require('../../config');
const users = require('../../services/users');
const { ok, rateLimit, sameOrigin, csrf, requireUser, setSessionCookie, clearSessionCookie } = require('../middleware');

const router = express.Router();

const loginLimiter = rateLimit({ windowMs: 60000, max: config.limits.loginPerMinute });
const registerLimiter = rateLimit({ windowMs: 3600000, max: config.limits.registerPerHour });
// เปลี่ยนรหัสผ่าน: กันใช้เซสชันที่ขโมยมาเดารหัสผ่านปัจจุบัน
const passwordLimiter = rateLimit({ windowMs: 15 * 60000, max: 10, key: (req) => `pw${req.user?.id}` });

const meResponse = (req) => (req.user ? { user: users.publicUser(req.user), csrf: req.session.csrf } : { user: null, csrf: null });

router.get('/me', (req, res) => ok(res, meResponse(req)));

router.post('/register', sameOrigin, registerLimiter, async (req, res) => {
  const b = req.body || {};
  const user = await users.register({ name: b.name, phone: b.phone, email: b.email, password: b.password }, { ip: req.ip });
  const session = users.createSession(user.id, { ip: req.ip, userAgent: req.get('user-agent') });
  setSessionCookie(res, session.token);
  ok(res, { user: users.publicUser(user), csrf: session.csrf }, 201);
});

router.post('/login', sameOrigin, loginLimiter, async (req, res) => {
  const b = req.body || {};
  if (req.session) {
    users.destroySession(req.cookies.sid);
    clearSessionCookie(res);
  }
  const result = await users.login({ identifier: b.identifier, password: b.password }, { ip: req.ip, userAgent: req.get('user-agent') });
  // เปิดยืนยันตัวตน 2 ชั้นไว้ → ขอรหัส 6 หลักก่อน (ยังไม่ให้เซสชัน)
  if (result.mfaRequired) return ok(res, { user: null, csrf: null, mfa_required: true, mfa_token: result.mfaToken });
  setSessionCookie(res, result.token);
  ok(res, { user: users.publicUser(result.user), csrf: result.csrf });
});

router.post('/login/verify', sameOrigin, loginLimiter, (req, res) => {
  const b = req.body || {};
  const result = users.loginMfa({ mfaToken: b.mfa_token, code: b.code }, { ip: req.ip, userAgent: req.get('user-agent') });
  setSessionCookie(res, result.token);
  ok(res, { user: users.publicUser(result.user), csrf: result.csrf });
});

router.post('/logout', csrf, (req, res) => {
  if (req.session) users.destroySession(req.cookies.sid);
  clearSessionCookie(res);
  ok(res, { user: null });
});

router.post('/change-password', requireUser, csrf, passwordLimiter, async (req, res) => {
  const b = req.body || {};
  await users.changePassword(req.user, b.currentPassword, b.newPassword, { sessionId: req.session.id, ip: req.ip });
  ok(res, { changed: true });
});

router.put('/profile', requireUser, csrf, (req, res) => {
  const b = req.body || {};
  const user = users.updateProfile(req.user, { name: b.name, email: b.email });
  ok(res, { user: users.publicUser(user) });
});

// ───────────── ยืนยันตัวตน 2 ชั้น ─────────────

router.post('/2fa/setup', requireUser, csrf, passwordLimiter, async (req, res) => {
  ok(res, await users.totpSetup(req.user, (req.body || {}).password, { sessionId: req.session.id }));
});

router.post('/2fa/enable', requireUser, csrf, passwordLimiter, (req, res) => {
  const user = users.totpEnable(req.user, (req.body || {}).code, { sessionId: req.session.id, ip: req.ip });
  ok(res, { user: users.publicUser(user) });
});

router.post('/2fa/disable', requireUser, csrf, passwordLimiter, async (req, res) => {
  const b = req.body || {};
  const user = await users.totpDisable(req.user, { password: b.password, code: b.code }, { ip: req.ip, sessionId: req.session.id });
  ok(res, { user: users.publicUser(user) });
});

// ───────────── อุปกรณ์ที่เข้าสู่ระบบอยู่ ─────────────

router.get('/sessions', requireUser, (req, res) => ok(res, { sessions: users.listSessions(req.user, req.session.id) }));

router.post('/sessions/revoke-others', requireUser, csrf, (req, res) => {
  const r = users.destroyUserSessions(req.user.id, req.session.id);
  ok(res, { revoked: r.changes });
});

router.delete('/sessions/:id', requireUser, csrf, (req, res) => {
  users.revokeSession(req.user, req.params.id, req.session.id);
  ok(res, { revoked: true });
});

module.exports = router;
