'use strict';
/**
 * ════════════════════════════════════════════════════════════════════
 *  HubZell Gateway API adapter  (คู่มือ: https://shop.hubzell.com/docs)
 * ════════════════════════════════════════════════════════════════════
 *  - ทุกคำขอเซ็น HMAC-SHA256: X-Api-Key / X-Timestamp / X-Signature
 *      X-Signature = hex(HMAC(secret, METHOD \n PATH \n TIMESTAMP \n RAW_BODY))  (PATH รวม /api/v1, ไม่รวม query)
 *  - ต้อง whitelist IP ของเซิร์ฟเวอร์ใน Reseller Console ก่อน (whitelist ว่าง = ถูกปฏิเสธทุกคำขอ)
 *  - client_ref = เลขที่รายการของเรา (ref) — ส่งซ้ำเลขเดิม HubZell ตอบ DUPLICATE_REQUEST และไม่ตัดเงินซ้ำ
 *    (คู่มือ: หมดเวลารอ/เน็ตหลุด/INTERNAL_ERROR → ส่งซ้ำด้วย client_ref เดิมได้อย่างปลอดภัย)
 *  - ราคาเป็น "บริการราคาคงที่" (service_id) → ต้องจับคู่ยอดเติม/แพ็กเกจกับ service_id ในหน้าแอดมินก่อนเปิดใช้
 *  - ไม่มี sandbox: ทุกรายการเป็นของจริงและตัดเงินจริง
 *  - จำกัด 120 คำขอ/นาที/IP และ "ยิง URL ที่ไม่มีอยู่ 5 ครั้ง/5 นาที" หรือ "KYC_NOT_APPROVED 5 ครั้ง/5 นาที" = บล็อก IP 24 ชม.
 *    → ไฟล์นี้เรียกเฉพาะ endpoint ที่มีในคู่มือ, หยุดเรียกเองเมื่อเจอ 404 ครบ 2 ครั้งใน 5 นาที,
 *      ส่งรายการใหม่พร้อมกันได้จำกัด และเช็กการพักซ้ำทุกครั้งก่อนส่ง
 *
 *  กันเติมซ้ำ 2 เจ้า: ถือว่า "HubZell ไม่ได้สร้างรายการ" (ส่งต่อเจ้าสำรองได้) เฉพาะรหัสข้อผิดพลาดที่คู่มือระบุ
 *  และสถานะ HTTP ตรงตามคู่มือเท่านั้น — คำตอบอื่นทั้งหมด (รหัสไม่รู้จัก, 5xx, รูปแบบแปลก) = "ไม่รู้ผล" ห้ามส่งเจ้าอื่น
 * ════════════════════════════════════════════════════════════════════
 */
const config = require('../config');
const db = require('../db');
const { httpCall, markOutcome } = require('./base');
const { hmacSha256, safeEqual } = require('../lib/security');
const { alertAdmin } = require('../lib/notify');
const breaker = require('../services/breaker');

const NAME = 'hubzell';
const cfg = config.hubzell;
const CAPABILITIES = { statusCheck: true, balance: true, products: true, callback: true, catalog: 'mapped' };

// สถานะรายการของ HubZell → สถานะกลาง
//   FAILED = HubZell คืนเงินให้เราอัตโนมัติ (ตามคู่มือ) → คืนเงินลูกค้าได้
//   REFUNDED = HubZell คืนเงินรายการที่เคยสำเร็จให้เราแล้ว → คืนเงินลูกค้าได้ (เราไม่เสียเงิน)
//   ถ้ารายการในระบบเราสำเร็จไปแล้ว จะกลายเป็น "ผลขัดแย้ง" ให้แอดมินตรวจ (ไม่ขยับเงินเอง)
const STATUS = { SUCCESS: 'success', FAILED: 'failed', CANCELLED: 'failed', REFUNDED: 'failed', PENDING: 'processing', SENT: 'processing' };
const mapStatus = (s) => STATUS[String(s || '').toUpperCase()] || 'unknown';

// ข้อผิดพลาดที่คู่มือระบุ + สถานะ HTTP ตามคู่มือ = HubZell ปฏิเสธก่อนสร้างรายการ (ยังไม่ตัดเงิน) → ส่งต่อเจ้าสำรองได้
// trip = พักการส่งไป HubZell กี่วินาที (ปัญหาฝั่งบัญชี/ระบบ — ส่งต่อก็พังเหมือนเดิม)
const REJECT = {
  INSUFFICIENT_BALANCE: { http: [400, 403], trip: 600, reason: 'เครดิตที่ HubZell ไม่พอ — กรุณาเติมเครดิต' },
  MAINTENANCE_MODE: { http: [503], trip: 300, reason: 'HubZell ปิดปรับปรุงระบบ' },
  KYC_NOT_APPROVED: { http: [403], trip: 3600, reason: 'บัญชี HubZell ยังไม่ผ่าน KYC (หยุดส่งทันที — ถ้าซ้ำ 5 ครั้ง HubZell จะบล็อก IP 24 ชม.)' },
  RESELLER_DISABLED: { http: [403], trip: 3600, reason: 'บัญชีตัวแทน HubZell ถูกปิด' },
  IP_NOT_WHITELISTED: { http: [403], trip: 1800, reason: 'IP ของเซิร์ฟเวอร์ยังไม่อยู่ใน whitelist ของ HubZell' },
  IP_BLOCKED: { http: [403], trip: 86400, reason: 'HubZell บล็อก IP ของเซิร์ฟเวอร์ 24 ชม.' },
  MISSING_CREDENTIALS: { http: [401], trip: 1800, reason: 'ตั้งค่า HubZell ไม่ครบ (API key / secret key)' },
  INVALID_SIGNATURE: { http: [401], trip: 1800, reason: 'API key หรือ secret key ของ HubZell ไม่ถูกต้อง' },
  EXPIRED_TIMESTAMP: { http: [401], trip: 300, reason: 'นาฬิกาเซิร์ฟเวอร์คลาดเคลื่อนเกิน 5 นาที (เปิดตั้งเวลาอัตโนมัติ/NTP)' },
  INVALID_TIMESTAMP_FORMAT: { http: [401], trip: 1800, reason: 'รูปแบบเวลาในคำขอไม่ถูกต้อง' },
  CURRENCY_NOT_ENABLED: { http: [400], trip: 1800, reason: 'สกุลเงินนี้ยังไม่เปิดใช้ในบัญชี HubZell' },
  NOT_FOUND: { http: [404], trip: 0, reason: 'HubZell ไม่พบบริการนี้ หรือบริการนี้ใช้ไม่ได้ชั่วคราว' },
  VALIDATION_ERROR: { http: [400, 429], trip: 0, reason: 'HubZell ไม่รับข้อมูลรายการนี้' },
};
const ruleOf = (code) => (Object.hasOwn(REJECT, code) ? REJECT[code] : null);

// ───────────── จำกัดความถี่ของเราเอง (ไม่ให้โดน 429 / บล็อก) ─────────────
const calls = [];
async function takeSlot(maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const now = Date.now();
    while (calls.length && calls[0] <= now - 60000) calls.shift();
    if (calls.length < cfg.ratePerMin) {
      calls.push(now);
      return true;
    }
    const wait = calls[0] + 60000 - now + 5;
    if (now + wait > deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(wait, 1000)));
  }
}

// ───────────── กันโดนบล็อก IP: หยุดเรียกเองเมื่อเจอ "ไม่พบ" (404) ครบ 2 ครั้งใน 5 นาที (HubZell บล็อกที่ 5 ครั้ง) ─────────────
const NOT_FOUND_WINDOW_MS = 5 * 60000;
const NOT_FOUND_BUDGET = 2;
const notFoundAt = [];
function recent404() {
  const cut = Date.now() - NOT_FOUND_WINDOW_MS;
  while (notFoundAt.length && notFoundAt[0] <= cut) notFoundAt.shift();
  return notFoundAt.length;
}
function note404(endpoint) {
  notFoundAt.push(Date.now());
  if (recent404() < NOT_FOUND_BUDGET) return;
  const sec = Math.max(1, Math.ceil((notFoundAt[0] + NOT_FOUND_WINDOW_MS - Date.now()) / 1000));
  const reason = `HubZell ตอบ "ไม่พบ" (404) ${NOT_FOUND_BUDGET} ครั้งใน 5 นาที — หยุดเรียก HubZell ชั่วคราวเพื่อกันโดนบล็อก IP 24 ชม. (ตรวจ HUBZELL_API_URL และการจับคู่บริการ)`;
  breaker.open(NAME, sec, reason);
  alertAdmin('hubzell-404', `${reason}\nล่าสุด: ${endpoint}`, { cooldownSec: 600 });
}

// ───────────── กันโดนบล็อก IP: บัญชียังไม่ผ่าน KYC (HubZell บล็อกเมื่อตอบ KYC_NOT_APPROVED ครบ 5 ครั้งใน 5 นาที) ─────────────
// การพักร้าน (breaker) กันเฉพาะการส่งรายการ — ตัวนับนี้กันการเช็กเครดิต/ทดสอบคีย์ซ้ำๆ ด้วย (เช่น แอดมินบันทึกคีย์หลายรอบ)
const KYC_BUDGET = 2;
const kycAt = [];
function recentKyc() {
  const cut = Date.now() - NOT_FOUND_WINDOW_MS;
  while (kycAt.length && kycAt[0] <= cut) kycAt.shift();
  return kycAt.length;
}

// ───────────── ส่งรายการใหม่พร้อมกันได้จำกัด (ถ้าบัญชีมีปัญหา จะเสียแค่ไม่กี่คำขอก่อนพัก) ─────────────
let creating = 0;
const createQueue = [];
function acquireCreate(maxWaitMs) {
  if (creating < cfg.maxConcurrent) {
    creating += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const entry = { grant: null };
    const timer = setTimeout(() => {
      const i = createQueue.indexOf(entry);
      if (i >= 0) createQueue.splice(i, 1);
      resolve(false);
    }, maxWaitMs);
    timer.unref?.();
    entry.grant = () => {
      clearTimeout(timer);
      creating += 1;
      resolve(true);
    };
    createQueue.push(entry);
  });
}
function releaseCreate() {
  creating = Math.max(0, creating - 1);
  const next = createQueue.shift();
  if (next) next.grant();
}

const sign = (secret, method, path, ts, raw) => hmacSha256(secret, `${method}\n${path}\n${ts}\n${raw}`);

/** HUBZELL_API_URL ใช้ได้ไหม (ผิด = ไม่ส่งคำขอเลย กันยิง URL ที่ไม่มีจนโดนบล็อก) — คืนข้อความปัญหา หรือ null */
function baseUrlProblem() {
  let u;
  try { u = new URL(cfg.baseUrl); } catch { return 'HUBZELL_API_URL ไม่ใช่ URL ที่ถูกต้อง (เช่น https://gateway.hubzell.com/api/v1)'; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return 'HUBZELL_API_URL ต้องขึ้นต้นด้วย https://';
  if (u.search || u.hash || u.username || u.password) return 'HUBZELL_API_URL ต้องไม่มี ? # หรือชื่อผู้ใช้ในลิงก์';
  if (!/\/api\/v1$/.test(u.pathname)) return 'HUBZELL_API_URL ต้องลงท้ายด้วย /api/v1 (เช่น https://gateway.hubzell.com/api/v1)';
  return null;
}

const notSentRes = (error, extra = {}) => ({ ok: false, status: null, json: null, text: null, error, notSent: true, ...extra });

async function request(method, endpoint, { body, query = '', action, orderRef, timeoutMs = 20000 } = {}) {
  const bad = baseUrlProblem();
  if (bad) return notSentRes(bad);
  let path;
  try { path = new URL(`${cfg.baseUrl}${endpoint}`).pathname; } catch { return notSentRes('HUBZELL_API_URL ไม่ถูกต้อง'); }
  if (recent404() >= NOT_FOUND_BUDGET) {
    return notSentRes('หยุดเรียก HubZell ชั่วคราว (เจอ "ไม่พบ" หลายครั้งใน 5 นาที — กันโดนบล็อก IP)', { guarded: true });
  }
  if (recentKyc() >= KYC_BUDGET) {
    return notSentRes('หยุดเรียก HubZell ชั่วคราว 5 นาที: บัญชี HubZell ยังไม่ผ่าน KYC (กันโดนบล็อก IP 24 ชม.) — รอ KYC ผ่านก่อนแล้วค่อยลองใหม่', { guarded: true });
  }
  const raw = body === undefined ? '' : JSON.stringify(body);
  if (!(await takeSlot(action === 'submit' || action === 'resend' ? 15000 : 5000))) {
    return notSentRes('ส่งคำขอถี่เกินกำหนด (รอคิวไม่ทัน)', { rateLimited: true });
  }
  const ts = Math.floor(Date.now() / 1000);
  const headers = { 'X-Api-Key': cfg.apiKey, 'X-Timestamp': String(ts), 'X-Signature': sign(cfg.secret, method, path, ts, raw) };
  const res = await httpCall({
    provider: NAME, action, orderRef, method, url: `${cfg.baseUrl}${endpoint}${query}`, headers,
    rawBody: method === 'GET' ? undefined : raw, logRequest: body === undefined ? null : body, timeoutMs,
  });
  if (res.status === 404) note404(`${method} ${endpoint}`);
  if (res.json && typeof res.json === 'object' && res.json.code === 'KYC_NOT_APPROVED') kycAt.push(Date.now());
  return res;
}

const envelope = (res) => (res.json && typeof res.json === 'object' && (res.json.status === 0 || res.json.status === 1) ? res.json : null);
const toSatang = (n) => {
  const v = Math.round(Number(n) * 100);
  return Number.isSafeInteger(v) && v >= 0 ? v : undefined;
};

/**
 * แปลงคำตอบ HubZell เป็นผลลัพธ์กลาง — action: 'submit' | 'status'
 * expectedRef = เลขที่รายการของเรา (ตรวจว่า HubZell ตอบข้อมูลของรายการนี้จริง)
 */
function interpret(res, action, expectedRef) {
  if (res.error) return { outcome: 'unknown', notSent: Boolean(res.notSent), transport: true, message: res.error };
  const e = envelope(res);
  if (!e) {
    // ไม่ใช่รูปแบบคำตอบของ HubZell (เช่น หน้า HTML ของไฟร์วอลล์/พร็อกซี) → ไม่รู้ผล + นับเป็นปัญหาการเชื่อมต่อ
    return {
      outcome: 'unknown',
      transport: true,
      providerStatus: `HTTP_${res.status}`,
      message: res.status >= 500 || res.status === 408 ? `HubZell ขัดข้อง (HTTP ${res.status})` : `อ่านคำตอบจาก HubZell ไม่ได้ (HTTP ${res.status})`,
    };
  }
  const trace = e.trace_id ? ` (trace ${e.trace_id})` : '';
  if (e.status === 0) {
    if (res.status < 200 || res.status >= 300) {
      return { outcome: 'unknown', transport: true, providerStatus: `HTTP_${res.status}`, message: `HubZell ตอบสำเร็จแต่สถานะ HTTP ผิดปกติ (${res.status})${trace}` };
    }
    const d = e.data && typeof e.data === 'object' ? e.data : {};
    if (expectedRef && d.client_ref !== undefined && d.client_ref !== null && String(d.client_ref) !== expectedRef) {
      return {
        outcome: 'unknown',
        providerStatus: 'REF_MISMATCH',
        message: `HubZell ตอบข้อมูลของรายการอื่น (${String(d.client_ref).slice(0, 40)}) — ไม่นำมาใช้`,
        review: 'HubZell ตอบข้อมูลที่เลขที่รายการไม่ตรงกับรายการนี้ — กรุณาตรวจในหน้า HubZell',
      };
    }
    const outcome = mapStatus(d.status);
    return {
      outcome,
      providerStatus: d.status ? String(d.status).slice(0, 40) : undefined,
      providerTxnId: d.transaction_id ? String(d.transaction_id) : undefined,
      message: d.failure_reason || d.message || (outcome === 'processing' ? 'HubZell รับรายการแล้ว กำลังดำเนินการ' : outcome === 'success' ? 'เติมเงินสำเร็จ' : undefined),
      chargedAmount: toSatang(d.total_amount ?? d.amount),
    };
  }
  const code = String(e.code || '');
  const rule = ruleOf(code);
  const asDocumented = Boolean(rule && rule.http.includes(res.status));
  if (action === 'status') {
    // เช็กสถานะ: ไม่พบรายการ / ผิดพลาด = "ยังไม่รู้ผล" เสมอ (ห้ามสรุปว่าไม่สำเร็จ — รายการอาจยังไม่เข้าระบบ)
    const trip = asDocumented && rule.trip ? { seconds: rule.trip, reason: rule.reason } : undefined;
    return { outcome: 'unknown', providerStatus: code || `HTTP_${res.status}`, message: `${e.message || code}${trace}`, ...(trip ? { trip } : {}) };
  }
  if (code === 'DUPLICATE_REQUEST') {
    // เลขอ้างอิงนี้ HubZell รับไปแล้ว (เช่น ครั้งก่อนหมดเวลารอ) → รอผล ห้ามคืนเงิน ห้ามส่งเจ้าอื่น
    return { outcome: 'processing', providerStatus: code, message: 'HubZell ได้รับรายการนี้แล้ว (เลขอ้างอิงเดิม) — รอผล' };
  }
  if (!asDocumented) {
    // INTERNAL_ERROR / 5xx / รหัสที่ไม่รู้จัก / สถานะ HTTP ไม่ตรงคู่มือ → HubZell อาจสร้างรายการไปแล้ว
    // ห้ามคืนเงิน ห้ามส่งเจ้าอื่น — ระบบจะส่งซ้ำด้วย client_ref เดิมเพื่อหาผล (ไม่ตัดเงินซ้ำ)
    return {
      outcome: 'unknown',
      transport: true,
      providerStatus: code || `HTTP_${res.status}`,
      message: `HubZell ตอบ ${code || 'ข้อผิดพลาด'} (HTTP ${res.status}) — ยังไม่แน่ใจว่าสร้างรายการแล้วหรือไม่ ระบบจะตรวจสอบต่ออัตโนมัติ${trace}`,
    };
  }
  let trip;
  if (code === 'VALIDATION_ERROR' && res.status === 429) trip = { seconds: 60, reason: 'ส่งคำขอถี่เกินกำหนดของ HubZell (120 ครั้ง/นาที)' };
  else if (rule.trip) trip = { seconds: rule.trip, reason: rule.reason };
  return {
    outcome: 'failed',
    retryable: true,
    providerStatus: code,
    message: `${rule.reason} — ${e.message || code}${trace}`,
    ...(trip ? { trip } : {}),
  };
}

// ───────────── เบอร์โทร: ปรับรูปแบบตามที่ HubZell กำหนดในช่องกรอก ─────────────

/** หารูปแบบเบอร์ที่ตรงกับ regex ของ HubZell: local = 08xxxxxxxx, intl = 668xxxxxxxx, intl_plus = +668xxxxxxxx */
function detectFormat(pattern) {
  if (!pattern) return 'local';
  let re;
  try { re = new RegExp(pattern); } catch { return null; }
  if (re.test('0812345678')) return 'local';
  if (re.test('66812345678')) return 'intl';
  if (re.test('+66812345678')) return 'intl_plus';
  return null;
}

function formatPhone(phone, fmt) {
  if (fmt === 'intl') return `66${phone.slice(1)}`;
  if (fmt === 'intl_plus') return `+66${phone.slice(1)}`;
  return phone;
}

const mapFor = (kind, networkCode, faceValue, productId) => (kind === 'topup'
  ? db.get("SELECT * FROM provider_map WHERE provider = ? AND kind = 'topup' AND network_code = ? AND face_value = ?", NAME, networkCode, faceValue)
  : db.get("SELECT * FROM provider_map WHERE provider = ? AND kind = 'package' AND product_id = ?", NAME, productId));

// ───────────── ใช้โดยตัวเลือกผู้ให้บริการ (router) ─────────────

/** ราคาทุน + รหัสบริการ ของรายการนี้ที่ HubZell (null = HubZell ยังขายรายการนี้ไม่ได้ / ยังไม่ได้จับคู่) */
function quote(item) {
  const row = item.type === 'topup'
    ? mapFor('topup', item.network.code, item.faceValue)
    : item.product ? mapFor('package', null, null, item.product.id) : null;
  if (!row || !row.enabled) return null;
  return { cost: row.cost, code: row.service_id, mapId: row.id };
}

function configStatus() {
  const missing = [];
  // ใส่ได้ที่หลังบ้าน (ปุ่ม "ใส่คีย์ร้าน") หรือ HUBZELL_API_KEY / HUBZELL_SECRET_KEY ใน environment
  if (!cfg.apiKey) missing.push('API Key (จากหน้า Developer ใน HubZell Reseller Console)');
  if (!cfg.secret) missing.push('Secret Key');
  const bad = baseUrlProblem();
  if (bad) missing.push(bad);
  return { ready: missing.length === 0, missing };
}

// ───────────── คำสั่งหลัก ─────────────

const pausedResult = () => ({
  outcome: 'failed', retryable: true, notSent: true, local: true, providerStatus: 'PAUSED',
  message: `พักการส่งไป HubZell อยู่ (${breaker.snapshot(NAME).reason || 'ปัญหาการเชื่อมต่อ'}) — ไม่ได้ส่งคำขอ`,
});

/** ส่งคำขอสร้างรายการ (ครั้งแรก หรือส่งซ้ำด้วย client_ref เดิม) — ผ่านคิวจำกัดจำนวน + เช็กการพักก่อนส่งทุกครั้ง */
async function sendCreate(order, map, action) {
  if (breaker.isOpen(NAME)) return pausedResult();
  if (!(await acquireCreate(15000))) {
    return { outcome: 'failed', retryable: true, notSent: true, local: true, providerStatus: 'BUSY', message: 'คิวส่งรายการไป HubZell เต็ม — ไม่ได้ส่งคำขอ' };
  }
  try {
    // ระหว่างรอคิว คำขออื่นอาจเจอปัญหาบัญชี (เช่น KYC) จน HubZell ถูกพักไปแล้ว → ไม่ยิงซ้ำ
    if (breaker.isOpen(NAME)) return pausedResult();
    const body = { service_id: map.service_id, input: { [map.input_field]: formatPhone(order.phone, map.phone_format) }, client_ref: order.ref };
    const res = await request('POST', '/orders/create', { body, action, orderRef: order.ref, timeoutMs: config.provider.timeoutMs });
    const result = interpret(res, 'submit', order.ref);
    markOutcome(res.logId, result.outcome);
    // พักทันทีก่อนปล่อยคิว — คำขอถัดไปที่รออยู่จะเห็นการพักและไม่ยิงซ้ำ
    if (result.trip) breaker.record(NAME, { trip: result.trip, message: result.message });
    return result;
  } finally {
    releaseCreate();
  }
}

function disableMapping(map, why) {
  const r = db.run('UPDATE provider_map SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1', db.nowIso(), map.id);
  if (r.changes) {
    alertAdmin(`hubzell-map-404-${map.id}`, `HubZell ไม่พบบริการ ${map.service_id} — ระบบปิดการจับคู่นี้แล้ว (รายการใหม่ไปเจ้าอื่น)\nกรุณากด "ดึงรายการจาก HubZell" แล้วจับคู่ใหม่ (ถ้าเกิดกับทุกบริการ ให้ตรวจ HUBZELL_API_URL)\n${why || ''}`, { cooldownSec: 60 });
  }
}

async function submit(order) {
  if (!configStatus().ready) {
    return { outcome: 'failed', retryable: true, local: true, providerStatus: 'NOT_CONFIGURED', message: 'ยังตั้งค่า HubZell ไม่ครบ ระบบจึงไม่ได้ส่งคำขอ' };
  }
  const map = order.route?.mapId
    ? db.get('SELECT * FROM provider_map WHERE id = ?', order.route.mapId)
    : mapFor(order.type, order.network_code, order.face_value, order.product_id);
  if (!map || !map.enabled) {
    return { outcome: 'failed', retryable: true, local: true, providerStatus: 'NO_MAPPING', message: 'ยังไม่ได้จับคู่รายการนี้กับบริการของ HubZell — ไม่ได้ส่งคำขอ' };
  }
  const value = formatPhone(order.phone, map.phone_format);
  if (map.input_pattern) {
    let ok = false;
    try { ok = new RegExp(map.input_pattern).test(value); } catch { ok = false; }
    if (!ok) return { outcome: 'failed', retryable: true, local: true, providerStatus: 'INPUT_FORMAT', message: `รูปแบบเบอร์ไม่ตรงกับที่ HubZell กำหนด (${map.input_pattern}) — ไม่ได้ส่งคำขอ` };
  }
  const result = await sendCreate(order, map, 'submit');
  if (result.outcome === 'failed' && result.providerStatus === 'NOT_FOUND') disableMapping(map, result.message);
  return result;
}

/** ค้นผลด้วยเลขที่รายการ (client_ref) — "ไม่พบ" ติดกัน 2 ครั้ง = หยุดเช็กอัตโนมัติ ให้แอดมินตรวจ (กันยิง 404 จนโดนบล็อก) */
async function lookup(order, attempt) {
  const res = await request('GET', `/orders/by-reference/${encodeURIComponent(order.ref)}`, { action: 'status', orderRef: order.ref, timeoutMs: 15000 });
  const result = interpret(res, 'status', order.ref);
  markOutcome(res.logId, result.outcome);
  if (!attempt) return result;
  if (result.providerStatus === 'NOT_FOUND') {
    const n = (attempt.not_found || 0) + 1;
    db.run('UPDATE order_attempts SET not_found = ?, updated_at = ? WHERE id = ?', n, db.nowIso(), attempt.id);
    if (n >= 2) {
      return {
        ...result,
        stopChecks: true,
        review: 'HubZell ไม่พบรายการนี้ (ค้นด้วยเลขที่รายการ 2 ครั้ง) — หยุดเช็กอัตโนมัติเพื่อกันโดนบล็อก IP กรุณาตรวจในหน้า HubZell ว่ามีรายการนี้หรือไม่ ก่อนยืนยันผล',
      };
    }
  } else if (attempt.not_found && result.outcome !== 'unknown') {
    db.run('UPDATE order_attempts SET not_found = 0, updated_at = ? WHERE id = ?', db.nowIso(), attempt.id);
  }
  return result;
}

/**
 * ส่งซ้ำด้วย client_ref เดิม (คู่มือแนะนำเมื่อหมดเวลารอ/เน็ตหลุด/INTERNAL_ERROR):
 *   HubZell รับไปแล้ว → DUPLICATE_REQUEST (ไม่ตัดเงินซ้ำ) → ค้นผลจริงต่อทันที
 *   HubZell ยังไม่ได้รับ → สร้างรายการตอนนี้ (ลูกค้าได้ของตามที่จ่าย)
 *   ถูกปฏิเสธ → ยังสรุปไม่ได้ว่าครั้งแรกไม่ถึง (HubZell อาจตรวจอย่างอื่นก่อนเลขซ้ำ) → "ไม่รู้ผล" ไว้ก่อน ห้ามคืนเงิน
 * คืน null = ส่งซ้ำไม่ได้ตอนนี้ (ปิด/ลบการจับคู่ไปแล้ว, HubZell ถูกพัก, คิวเต็ม) → ใช้การค้นผลแทน (อ่านอย่างเดียว ใช้ได้แม้บัญชีติด KYC)
 */
async function resend(order, attempt) {
  const map = db.get('SELECT * FROM provider_map WHERE provider = ? AND service_id = ? AND enabled = 1 ORDER BY id LIMIT 1', NAME, attempt.code);
  if (!map) return null;
  const r = await sendCreate(order, map, 'resend');
  if (r.notSent) return null;
  db.run('UPDATE order_attempts SET resends = resends + 1, updated_at = ? WHERE id = ?', db.nowIso(), attempt.id);
  if (r.outcome === 'processing' && r.providerStatus === 'DUPLICATE_REQUEST') {
    // รับไปแล้วแน่นอน → ค้นผลล่าสุด (มีรายการอยู่จริง จึงไม่เสี่ยง 404)
    const found = await lookup(order, { ...attempt, not_found: 0 });
    return found.outcome === 'unknown' ? { ...r, message: 'HubZell ยืนยันว่ารับรายการนี้แล้ว (เลขอ้างอิงเดิม) — รอผล' } : found;
  }
  if (r.outcome === 'failed' && r.retryable) {
    return {
      outcome: 'unknown',
      providerStatus: r.providerStatus,
      message: `ส่งซ้ำ (เลขอ้างอิงเดิม) แล้ว HubZell ตอบ: ${r.message} — ยังไม่สรุปผล จะตรวจอีกครั้ง`,
      ...(r.trip ? { trip: r.trip } : {}),
    };
  }
  return r;
}

/** เช็กสถานะ — ctx.attempt = บันทึกการส่งไป HubZell ของรายการนี้ (ใช้ตัดสินว่าต้องส่งซ้ำหรือค้นผล) */
async function checkStatus(order, { attempt } = {}) {
  if (!configStatus().ready) return { outcome: 'unknown', message: 'ยังตั้งค่า HubZell ไม่ครบ' };
  const att = attempt || (order.id
    ? db.get('SELECT * FROM order_attempts WHERE order_id = ? AND provider = ? ORDER BY attempt_no DESC LIMIT 1', order.id, NAME)
    : null);
  // ยังไม่เคยได้คำตอบว่า HubZell รับรายการ (หมดเวลารอ/เน็ตหลุด/500/เครื่องดับระหว่างส่ง) → ส่งซ้ำด้วยเลขเดิม
  if (att && (att.state === 'unknown' || att.state === 'sending')) {
    const r = await resend(order, att);
    if (r) return r;
  }
  return lookup(order, att);
}

async function getBalance() {
  if (!configStatus().ready) return { ok: false, message: 'ยังตั้งค่า HubZell ไม่ครบ' };
  const res = await request('GET', '/balance', { query: `?currency=${encodeURIComponent(cfg.currency)}`, action: 'balance', timeoutMs: 15000 });
  const e = envelope(res);
  // /balance มีอยู่เสมอ — ได้ "ไม่พบ" แปลว่า HUBZELL_API_URL ผิด → พักไว้ก่อน (ไม่ยิง URL ผิดซ้ำจนโดนบล็อก)
  const wrongUrl = { seconds: 1800, reason: 'ไม่พบ endpoint ของ HubZell — ตรวจ HUBZELL_API_URL (ต้องเป็น https://gateway.hubzell.com/api/v1)' };
  if (res.error) return { ok: false, message: res.error };
  if (!e) return { ok: false, message: `HTTP ${res.status}`, ...(res.status === 404 ? { trip: wrongUrl } : {}) };
  if (e.status !== 0) {
    if (e.code === 'NOT_FOUND') return { ok: false, code: e.code, message: `${e.code}: ${e.message || ''}`, trip: wrongUrl };
    const rule = ruleOf(e.code);
    // ปัญหาบัญชี/การตั้งค่า (เช่น key ผิด, IP ไม่อยู่ใน whitelist) → พักเจ้านี้ไว้ก่อน รายการใหม่จะไปเจ้าสำรอง
    const configError = rule?.trip && !['INSUFFICIENT_BALANCE', 'MAINTENANCE_MODE', 'VALIDATION_ERROR'].includes(e.code);
    return { ok: false, code: e.code, message: thaiError(e), ...(configError ? { trip: { seconds: rule.trip, reason: rule.reason } } : {}) };
  }
  const n = Number(e.data?.available);
  if (!Number.isFinite(n)) return { ok: false, message: 'อ่านยอดเครดิตไม่ได้' };
  return { ok: true, balance: Math.round(n * 100) };
}

/**
 * ดึงรายการบริการเติมเงินมือถือ/แพ็กเกจ (หมวด MOBILE_TOPUP) จาก HubZell
 * ใช้ได้เฉพาะสินค้าที่ต้องกรอก "เบอร์โทร 1 ช่อง" เท่านั้น — อย่างอื่นถูกทำเครื่องหมายว่าใช้ไม่ได้ พร้อมเหตุผล
 * listed = สินค้าทั้งหมดที่ HubZell มีตอนนี้, fetched = สินค้าที่ดึงรายละเอียดได้ครบ
 * (สินค้าที่ดึงรายละเอียดไม่ได้ → ห้ามสรุปว่าบริการหาย — ระบบจะไม่ปิดการจับคู่ของสินค้านั้น)
 */
const MAX_PRODUCTS = 60;
async function fetchCatalog() {
  if (!configStatus().ready) return { ok: false, message: 'ยังตั้งค่า HubZell ไม่ครบ' };
  const res = await request('GET', '/products', { query: `?category=MOBILE_TOPUP&currency=${encodeURIComponent(cfg.currency)}`, action: 'products', timeoutMs: 20000 });
  const e = envelope(res);
  if (res.error || !e) return { ok: false, message: res.error || `HTTP ${res.status}` };
  if (e.status !== 0) return { ok: false, message: thaiError(e) };
  const products = (Array.isArray(e.data?.items) ? e.data.items : [])
    .flatMap((g) => (Array.isArray(g.products) ? g.products : []).map((p) => ({ ...p, category: p.category || g.category })))
    .filter((p) => p && p.product_id !== undefined && p.product_id !== null && String(p.product_id) !== '');
  const listed = products.map((p) => String(p.product_id));
  const fetched = [];
  const rows = [];
  const errors = [];
  if (products.length > MAX_PRODUCTS) errors.push(`HubZell มีสินค้า ${products.length} รายการ ดึงรายละเอียดได้ครั้งละ ${MAX_PRODUCTS} รายการ (ที่เหลือคงข้อมูลเดิมไว้)`);
  for (const p of products.slice(0, MAX_PRODUCTS)) {
    const r = await request('GET', `/products/${encodeURIComponent(String(p.product_id))}`, { action: 'products', timeoutMs: 20000 });
    const d = envelope(r);
    if (r.error || !d || d.status !== 0) {
      errors.push(`${p.product_id}: ${r.error || d?.code || `HTTP ${r.status}`}`);
      continue;
    }
    fetched.push(String(p.product_id));
    const detail = d.data || {};
    const inputs = Array.isArray(detail.inputs) ? detail.inputs : [];
    let reason = null;
    let field = null;
    let pattern = null;
    let fmt = 'local';
    if (inputs.length !== 1) reason = inputs.length ? `ต้องกรอก ${inputs.length} ช่อง (ระบบรองรับเฉพาะเบอร์โทร 1 ช่อง)` : 'สินค้านี้ไม่มีช่องกรอกเบอร์โทร';
    else if (inputs[0].type === 'select') reason = 'ช่องกรอกเป็นแบบตัวเลือก ไม่ใช่เบอร์โทร';
    else {
      field = String(inputs[0].name || '');
      pattern = inputs[0].validation ? String(inputs[0].validation) : null;
      fmt = detectFormat(pattern);
      if (!field) reason = 'ไม่รู้ชื่อช่องกรอก';
      else if (!fmt) reason = `รูปแบบเบอร์ที่ HubZell ต้องการ (${pattern}) ไม่ตรงกับเบอร์มือถือไทย`;
    }
    const currency = String(detail.currency || p.currency || '');
    if (!reason && currency !== cfg.currency) reason = `ราคาเป็นสกุล ${currency} (ระบบใช้ ${cfg.currency})`;
    for (const s of Array.isArray(detail.services) ? detail.services : []) {
      const price = toSatang(s.price);
      rows.push({
        serviceId: String(s.id),
        productCode: String(p.product_id),
        productName: String(detail.product_name || p.product_name || '').slice(0, 200),
        serviceName: String(s.name || '').slice(0, 200),
        category: String(detail.category || p.category || ''),
        currency,
        price: price && price > 0 ? price : null,
        inputField: field,
        inputPattern: pattern,
        phoneFormat: fmt || 'local',
        inputs,
        supported: !reason && Boolean(price && price > 0),
        reason: reason || (price && price > 0 ? null : 'ไม่มีราคา'),
      });
    }
  }
  return { ok: true, rows, products: products.length, listed, fetched, errors };
}

/**
 * callback จาก HubZell — ต้องมีลายเซ็นถูกต้องเสมอ
 *   callback URL (หน้า Developer)  : X-Hubzell-Signature = HMAC(API secret key, timestamp \n raw body)
 *   webhook endpoint (event/payload): ใช้ signing secret ของ endpoint (HUBZELL_WEBHOOK_SECRET)
 * ลายเซ็นถูกต้อง = เชื่อผลได้ทันที (trust = signed)
 */
function handleCallback({ rawBody, headers, body }) {
  const ts = String(headers['x-hubzell-timestamp'] || '');
  const sig = String(headers['x-hubzell-signature'] || '').toLowerCase();
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!/^\d{9,11}$/.test(ts) || !(age <= 300)) {
    return { ok: false, status: 400, body: 'stale timestamp', error: 'เวลาใน callback ของ HubZell ไม่ถูกต้องหรือเก่าเกิน 5 นาที' };
  }
  const data = body && typeof body === 'object' ? body : null;
  const isEndpoint = Boolean(data && data.payload && typeof data.payload === 'object');
  const secret = isEndpoint ? cfg.webhookSecret : cfg.secret;
  if (!secret) return { ok: false, status: 401, body: 'not configured', error: isEndpoint ? 'ยังไม่ได้ใส่ Webhook signing secret ของ HubZell' : 'ยังไม่ได้ใส่ Secret Key ของ HubZell' };
  if (!safeEqual(sig, hmacSha256(secret, `${ts}\n${rawBody || ''}`))) {
    return { ok: false, status: 401, body: 'invalid signature', error: 'ลายเซ็น callback ของ HubZell ไม่ถูกต้อง' };
  }
  if (!data) return { ok: false, status: 400, body: 'bad json', error: 'ข้อมูล callback ไม่ใช่ JSON' };
  const o = isEndpoint
    ? { ref: data.payload.reference, status: data.payload.status, txn: data.payload.transactionId, message: data.payload.failureReason }
    : { ref: data.client_ref, status: data.status, txn: data.transaction_id, message: data.failure_reason || data.message };
  if (!o.ref) {
    // เช่น announcement.published — รับทราบแต่ไม่มีรายการให้อัปเดต
    return { ok: true, updates: [], response: { status: 200, body: 'OK' } };
  }
  return {
    ok: true,
    updates: [{
      ref: String(o.ref),
      outcome: mapStatus(o.status),
      providerStatus: o.status ? String(o.status).slice(0, 40) : undefined,
      providerTxnId: o.txn ? String(o.txn) : undefined,
      message: o.message ? String(o.message) : undefined,
      trust: 'signed',
    }],
    response: { status: 200, body: 'OK' },
  };
}

/** ข้อความผิดพลาดของ HubZell เป็นภาษาไทย (พร้อมรหัสเดิมไว้ค้นหา) */
function thaiError(e) {
  const rule = ruleOf(String(e?.code || ''));
  return rule ? `${rule.reason} (${e.code})` : `HubZell ตอบ ${e?.code || 'ข้อผิดพลาด'}${e?.message && e.message !== e.code ? `: ${e.message}` : ''}`;
}

/** ใช้ในการทดสอบเท่านั้น: ล้างตัวนับภายใน */
function _resetGuards() {
  notFoundAt.length = 0;
  kycAt.length = 0;
  calls.length = 0;
}

module.exports = {
  name: NAME,
  label: 'HubZell',
  shopName: 'HubZell',
  capabilities: CAPABILITIES,
  configStatus,
  quote,
  submit,
  checkStatus,
  getBalance,
  fetchCatalog,
  handleCallback,
  _internal: { sign, interpret, detectFormat, formatPhone, mapStatus, baseUrlProblem, resetGuards: _resetGuards, recent404 },
};
