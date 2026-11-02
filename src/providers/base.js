'use strict';
/**
 * มาตรฐานกลางของผู้ให้บริการ (provider) ทุกเจ้า
 *
 * ทุกฟังก์ชันของ provider ต้อง "ไม่ throw" แต่คืนผลลัพธ์รูปแบบนี้:
 *   {
 *     outcome: 'success' | 'failed' | 'processing' | 'unknown',
 *     providerTxnId?: string,   // เลขที่รายการฝั่งผู้ให้บริการ
 *     providerStatus?: string,  // สถานะดิบจากผู้ให้บริการ (เก็บไว้ตรวจสอบ)
 *     message?: string,         // ข้อความอธิบาย
 *     notSent?: boolean,        // true = มั่นใจว่าคำขอ "ไม่ถึง" ผู้ให้บริการ (คืนเงินได้ปลอดภัย)
 *   }
 *
 * กฎสำคัญกันเติมซ้ำ/เงินหาย:
 *   - success    → สำเร็จแน่นอน
 *   - failed     → ไม่สำเร็จแน่นอน (ระบบคืนเงินลูกค้าอัตโนมัติ)
 *   - processing → ผู้ให้บริการรับเรื่องแล้ว รอผล
 *   - unknown    → ไม่รู้ผล (เช่น timeout หลังส่งไปแล้ว) → ห้ามคืนเงิน ห้ามส่งซ้ำ ให้ตรวจสถานะภายหลัง
 */
const config = require('../config');
const db = require('../db');
const settings = require('../services/settings');
require('../services/credentials'); // คีย์ร้านที่แอดมินใส่ในหลังบ้าน (ติดตั้งให้ config.hubzell / config.wepay อ่านได้)
const { hmacSha256 } = require('../lib/security');

const SECRET_KEYS = /pass|secret|key|token|sign|auth/i;

/**
 * รหัสลับประจำระบบสำหรับ callback ของผู้ให้บริการแต่ละเจ้า (แนบใน URL เป็น ?t=...)
 * ใช้ยืนยันว่า callback มาจากผู้ที่ได้ URL นี้จากเราเท่านั้น — ใช้ร่วมกับลายเซ็น/IP ถ้าผู้ให้บริการมีให้
 */
const callbackToken = (name) => hmacSha256(settings.appSecret(), `provider-callback:${name}`).slice(0, 40);
const callbackUrl = (name) => `${config.publicUrl}/api/provider/callback/${name}?t=${callbackToken(name)}`;

/** ซ่อนค่าลับใน query string ของ URL ก่อนบันทึก log */
function maskUrl(url) {
  if (!url || !String(url).includes('?')) return url;
  try {
    const u = new URL(url, 'http://x');
    for (const k of [...u.searchParams.keys()]) if (SECRET_KEYS.test(k) || k === 't') u.searchParams.set(k, '***');
    const out = u.toString();
    return /^https?:\/\//i.test(String(url)) ? out : out.replace(/^http:\/\/x/, '');
  } catch {
    return String(url).split('?')[0];
  }
}

function mask(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(mask);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = SECRET_KEYS.test(k) && v ? '***' : typeof v === 'object' ? mask(v) : v;
    }
    return out;
  }
  return obj;
}

const truncate = (s, n = 4000) => (s && s.length > n ? `${s.slice(0, n)}…[ตัด ${s.length - n} ตัวอักษร]` : s);

function logCall(entry) {
  try {
    const r = db.run(
      `INSERT INTO provider_logs (provider, action, order_ref, method, url, request, http_status, response, outcome, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.provider, entry.action, entry.orderRef, entry.method, maskUrl(entry.url),
      entry.request === undefined ? null : truncate(typeof entry.request === 'string' ? entry.request : JSON.stringify(mask(entry.request))),
      entry.httpStatus, truncate(entry.response), entry.outcome, entry.error, entry.durationMs, db.nowIso(),
    );
    return Number(r.lastInsertRowid);
  } catch {
    // log ห้ามทำให้การทำงานหลักล้ม
    return null;
  }
}

/** บันทึกผลที่แปลงแล้วลงใน log ของคำขอนั้น */
function markOutcome(logId, outcome) {
  if (!logId) return;
  try { db.run('UPDATE provider_logs SET outcome = ? WHERE id = ?', outcome, logId); } catch { /* ignore */ }
}

// error ที่มั่นใจได้ว่าคำขอยังไม่ถึงปลายทาง
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_INVALID_URL',
]);

function classifyError(err) {
  const code = err?.cause?.code || err?.code || '';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return { notSent: false, message: 'หมดเวลารอผลจากผู้ให้บริการ (timeout)', code: 'TIMEOUT' };
  }
  if (NOT_SENT_CODES.has(code)) {
    return { notSent: true, message: `เชื่อมต่อผู้ให้บริการไม่ได้ (${code})`, code };
  }
  return { notSent: false, message: `การเชื่อมต่อขัดข้องระหว่างส่ง (${code || err?.message || 'unknown'})`, code: code || 'NETWORK' };
}

/**
 * ส่ง HTTP ไปยังผู้ให้บริการ พร้อม timeout และบันทึก log ทุกครั้ง (ซ่อนรหัสลับ)
 * คืน { ok, status, text, json, error, notSent, durationMs }
 */
async function httpCall({ provider, action, orderRef, method = 'POST', url, headers = {}, body, form, rawBody, timeoutMs = 30000, logRequest }) {
  const started = Date.now();
  let payload;
  const h = { Accept: 'application/json, text/plain, */*', ...headers };
  if (rawBody !== undefined) {
    // ส่ง body ตามไบต์ที่ใช้คำนวณลายเซ็นทุกตัวอักษร (ห้าม JSON.stringify ซ้ำ)
    payload = rawBody;
    if (rawBody !== '') h['Content-Type'] = 'application/json';
  } else if (form) {
    payload = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
    h['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  const result = { ok: false, status: null, text: null, json: null, error: null, notSent: false, durationMs: 0 };
  try {
    const res = await fetch(url, { method, headers: h, body: method === 'GET' ? undefined : payload, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    result.status = res.status;
    result.text = await res.text();
    try { result.json = JSON.parse(result.text); } catch { result.json = null; }
    result.ok = res.ok;
  } catch (err) {
    const c = classifyError(err);
    result.error = c.message;
    result.errorCode = c.code;
    result.notSent = c.notSent;
  }
  result.durationMs = Date.now() - started;
  result.logId = logCall({
    provider, action, orderRef, method, url,
    request: logRequest ?? (form || body),
    httpStatus: result.status, response: result.text, error: result.error, durationMs: result.durationMs,
  });
  return result;
}

module.exports = { httpCall, logCall, markOutcome, mask, maskUrl, classifyError, truncate, callbackToken, callbackUrl };
