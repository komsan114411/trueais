'use strict';
// Middleware: ความปลอดภัย, เซสชัน, CSRF, จำกัดความถี่, API key, จัดการข้อผิดพลาด
const config = require('../config');
const { E, AppError } = require('../lib/errors');
const { RateLimiter } = require('../lib/ratelimit');
const { safeEqual } = require('../lib/security');
const logger = require('../lib/logger');
const users = require('../services/users');
const apikeys = require('../services/apikeys');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.frameAncestors === "'none'") res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `frame-ancestors ${config.frameAncestors}`,
    ].join('; '),
  );
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

function loadSession(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const s = users.getSession(req.cookies.sid);
  if (s) {
    req.session = s;
    req.user = s.user;
  }
  next();
}

function setSessionCookie(res, token) {
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: config.sessionDays * 86400000, path: '/' });
}

function clearSessionCookie(res) {
  res.clearCookie('sid', { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

function requireUser(req, res, next) {
  if (!req.user) throw E.unauthorized();
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) throw E.unauthorized();
  if (req.user.role !== 'admin') throw E.forbidden();
  next();
}

/** CSRF: คำขอที่เปลี่ยนข้อมูลต้องแนบ X-CSRF-Token ที่ได้จาก /api/auth/me */
function csrf(req, res, next) {
  if (SAFE_METHODS.has(req.method) || !req.session) return next();
  if (!safeEqual(req.get('x-csrf-token'), req.session.csrf)) throw E.csrf();
  next();
}

/** ป้องกันเว็บอื่นยิงคำขอ (ใช้กับ login/register ที่ยังไม่มีเซสชัน) */
function sameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  // เบราว์เซอร์รุ่นใหม่บอกมาเองว่าคำขอมาจากเว็บอื่น (cross-site) หรือไม่
  if (req.get('sec-fetch-site') === 'cross-site') throw E.forbidden('ไม่อนุญาตคำขอจากเว็บไซต์อื่น');
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('host') || origin === config.publicUrl) return next();
  } catch { /* fallthrough */ }
  throw E.forbidden('ไม่อนุญาตคำขอจากเว็บไซต์อื่น');
}

/** IP สำหรับนับความถี่ — IPv6 นับรวมทั้งวง /64 (เปลี่ยน IP ในวงเดียวกันเพื่อหลบการจำกัดไม่ได้) */
function clientKey(req) {
  const ip = String(req.ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}

function rateLimit({ windowMs, max, key = clientKey }) {
  const limiter = new RateLimiter({ windowMs, max });
  const mw = (req, res, next) => {
    const r = limiter.hit(key(req));
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      throw E.rateLimited(r.retryAfterSec);
    }
    next();
  };
  mw.limiter = limiter;
  return mw;
}

function apiKeyAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.get('x-api-key');
  const { key, user } = apikeys.authenticate(token, req.ip);
  req.apiKey = key;
  req.user = user;
  next();
}

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

function notFoundApi(req, res) {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'ไม่พบ API ที่เรียก' } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return;
  if (err instanceof AppError) {
    return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'ข้อมูลที่ส่งมีขนาดใหญ่เกินไป' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: { code: 'BAD_JSON', message: 'รูปแบบข้อมูลไม่ถูกต้อง (JSON)' } });
  }
  // error ฝั่งคำขอที่ไลบรารีบอกว่าแสดงได้ (เช่น charset ไม่รองรับ, URL เสีย) → 4xx ไม่ใช่ 500
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500 && err?.expose) {
    return res.status(status).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'คำขอไม่ถูกต้อง' } });
  }
  logger.error(`${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' } });
}

module.exports = {
  parseCookies, securityHeaders, loadSession, setSessionCookie, clearSessionCookie,
  requireUser, requireAdmin, csrf, sameOrigin, rateLimit, clientKey, apiKeyAuth, ok, notFoundApi, errorHandler,
};
