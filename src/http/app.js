'use strict';
// ประกอบ Express app: ความปลอดภัย → callback ผู้ให้บริการ → body parser → เซสชัน → เส้นทาง API → หน้าเว็บ
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { isPrivateNetworkIp } = require('../lib/netguard');
const mw = require('./middleware');

/**
 * TRUST_PROXY: เชื่อ IP จาก X-Forwarded-For เมื่อใด
 *   ตัวเลข / true → เชื่อเฉพาะเมื่อผู้ที่ต่อเข้ามาตรงๆ เป็น proxy ในเครือข่ายภายใน (loopback / LAN / docker)
 *                   คนที่ต่อเข้าพอร์ตระบบตรงจากอินเทอร์เน็ตจึงปลอม IP ไม่ได้
 *                   (ถ้าใช้ Cloudflare โดยไม่มี Nginx ให้ใส่วง IP ของ Cloudflare แทนตัวเลข)
 *   loopback / uniquelocal / IP / CIDR → ส่งให้ Express ตามรูปแบบมาตรฐาน
 */
function parseTrustProxy(v) {
  const s = String(v || '').trim();
  if (!s || s === 'false') return false;
  if (/^\d+$/.test(s) || s === 'true') {
    const hops = s === 'true' ? Infinity : Number(s);
    return (addr, i) => i < hops && isPrivateNetworkIp(addr);
  }
  return s;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(config.trustProxy));
  app.set('etag', 'strong');
  // ?a=1&a=2 → a = '1' เสมอ (ค่าเป็นข้อความเท่านั้น ไม่มี array/object ที่ทำให้คำสั่งฐานข้อมูลพัง)
  app.set('query parser', (str) => {
    const out = Object.create(null);
    for (const [k, v] of new URLSearchParams(str || '')) if (!(k in out)) out[k] = v;
    return out;
  });

  app.use(mw.securityHeaders);
  app.use('/api', mw.rateLimit({ windowMs: 60000, max: config.limits.apiPerMinute }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    require('../services/securityCheck').noteRequest(req); // จำว่ามี proxy อยู่หน้าเว็บไหม (เตือนให้ตั้ง TRUST_PROXY)
    next();
  });

  // callback จากผู้ให้บริการ ต้องได้ raw body → ติดตั้งก่อน body parser
  app.use('/api/provider', require('./routes/provider'));

  // รับเฉพาะ JSON (ไม่รับฟอร์ม HTML) — เว็บอื่นจึงส่งฟอร์มปลอมเข้ามาไม่ได้ (เบราว์เซอร์ต้องขออนุญาต CORS ก่อนส่ง JSON)
  const smallJson = express.json({ limit: '200kb' });
  const slipJson = express.json({ limit: '5mb' });
  app.use((req, res, next) => {
    // ส่งข้อมูลมาแต่ไม่ใช่ JSON (เช่น ฟอร์ม) → บอกให้ชัด แทนที่จะอ่านเป็นข้อมูลว่างแล้วแจ้งว่า "ขาดข้อมูล"
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
    if (req.path.startsWith('/api/') && hasBody && !['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'ต้องส่งข้อมูลเป็น JSON (Content-Type: application/json)' } });
    }
    return (/^\/api\/deposits\/\d+\/slip$/.test(req.path) ? slipJson : smallJson)(req, res, next);
  });

  app.use('/api/v1', require('./routes/merchant'));

  app.use(mw.loadSession);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/admin', require('./routes/admin'));
  app.get('/api/health', (req, res) => {
    try {
      require('../db').get('SELECT 1 AS ok');
    } catch {
      return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'ฐานข้อมูลไม่พร้อม' } });
    }
    mw.ok(res, { status: 'ok', time: new Date().toISOString() });
  });
  app.use('/api', require('./routes/customer'));
  app.use('/api', mw.notFoundApi);

  // หน้าเว็บ
  const pub = path.join(config.root, 'public');
  // ไฟล์ JS/CSS: ให้เบราว์เซอร์ถามเซิร์ฟเวอร์ทุกครั้ง (ไม่เปลี่ยน = ได้ 304 ไม่ต้องโหลดใหม่)
  // ห้ามเก็บแคชแบบมีอายุ — หลัง deploy เบราว์เซอร์จะได้ไฟล์เก่าปนใหม่ (import ไม่ตรงกัน) หน้าเว็บพังจนแคชหมดอายุ
  app.use('/assets', express.static(path.join(pub, 'assets'), {
    index: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  const sendPage = (file) => (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(pub, file));
  };
  app.get('/', sendPage('index.html'));
  app.get('/admin', sendPage('admin.html'));
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('ไม่พบหน้าที่ต้องการ'));
  app.use(mw.errorHandler);
  return app;
}

module.exports = { createApp, parseTrustProxy };
