'use strict';
// /api/provider/callback/:name — รับแจ้งผลจากผู้ให้บริการ (WonDD / mock)
// ต้องติดตั้งก่อน body parser ตัวหลัก เพราะต้องใช้ข้อมูลดิบ (raw body) ตรวจลายเซ็น
const express = require('express');
const providers = require('../../providers');
const orders = require('../../services/orders');
const { logCall, callbackToken } = require('../../providers/base');
const { safeEqual } = require('../../lib/security');
const logger = require('../../lib/logger');

const router = express.Router();

router.all('/callback/:name', express.raw({ type: () => true, limit: '100kb' }), (req, res) => {
  const started = Date.now();
  const provider = Object.hasOwn(providers.registry, req.params.name) ? providers.byName(req.params.name) : null;
  if (!provider || typeof provider.handleCallback !== 'function') return res.status(404).type('text/plain').send('not found');

  // รหัสลับใน URL (?t=...) — ตรวจแล้วตัดออก ไม่ส่งต่อให้ตัวอ่านข้อมูล และไม่บันทึกลง log
  const { t: token, ...query } = req.query || {};
  const tokenOk = typeof token === 'string' && safeEqual(token, callbackToken(provider.name));

  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const ct = String(req.get('content-type') || '');
  let parsed = null;
  if (rawBody && ct.includes('json')) {
    try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
  } else if (rawBody && ct.includes('x-www-form-urlencoded')) {
    parsed = Object.fromEntries(new URLSearchParams(rawBody));
  }

  let result;
  try {
    result = provider.handleCallback({ rawBody, headers: req.headers, query, body: parsed, ip: req.ip, method: req.method, tokenOk });
  } catch (err) {
    logger.error('อ่าน callback ไม่สำเร็จ', err);
    result = { ok: false, status: 400, body: 'error', error: err.message };
  }

  const applied = [];
  if (result.ok) {
    for (const u of result.updates || []) {
      try {
        applied.push({ ref: u.ref, outcome: u.outcome, ...orders.applyCallback(provider.name, u) });
      } catch (err) {
        logger.error(`อัปเดตจาก callback ไม่สำเร็จ ${u.ref}`, err);
        applied.push({ ref: u.ref, ok: false, reason: err.message });
      }
    }
  }

  logCall({
    provider: provider.name,
    action: 'callback',
    orderRef: result.updates?.[0]?.ref || null,
    method: req.method,
    url: req.originalUrl,
    // callback ที่ถูกปฏิเสธเก็บแค่ช่วงต้น (กันคนยิงขยะจน log บวม)
    request: rawBody ? rawBody.slice(0, result.ok ? 4000 : 500) : JSON.stringify(query).slice(0, 2000),
    httpStatus: result.ok ? 200 : result.status,
    response: JSON.stringify({ ip: req.ip, applied }),
    outcome: result.updates?.[0]?.outcome || null,
    error: result.ok ? null : result.error || 'rejected',
    durationMs: Date.now() - started,
  });

  const reply = result.ok ? result.response || { status: 200, body: 'OK' } : { status: result.status || 400, body: result.body || 'error' };
  res.status(reply.status).type('text/plain').send(String(reply.body));
});

module.exports = router;
