'use strict';
/**
 * ════════════════════════════════════════════════════════════════════
 *  WonDD API Adapter  (www.wondd.com)
 * ════════════════════════════════════════════════════════════════════
 *  ⚠️ สถานะ ณ 1 พ.ย. 2569: WonDD ยังไม่เปิดใช้ API ให้บัญชีนี้ และยังไม่ส่งคู่มือ
 *     (คำขอ "ขอเปิดใช้ API" เลขที่ HN69110000001 รอตอบกลับ)
 *     WonDD แจ้งว่าการใช้ API ต้องยื่นเอกสารสมัครเป็น Sub Agent ก่อน
 *
 *  ส่วนที่ไม่ขึ้นกับรูปแบบ API ทำไว้ครบแล้ว:
 *    ✓ timeout และแยกกรณี "ส่งไม่ถึง" (คืนเงินได้) กับ "ไม่รู้ผล" (ห้ามคืน/ห้ามส่งซ้ำ)
 *    ✓ บันทึก log ทุกคำขอ/คำตอบ (ซ่อนรหัสลับ)
 *    ✓ ตรวจ callback ด้วย IP + ลายเซ็น
 *    ✓ สถานะที่ไม่รู้จัก = unknown เสมอ (ไม่มีการขยับเงินจากข้อมูลที่ไม่แน่ใจ)
 *
 *  เมื่อได้คู่มือจริง: แก้เฉพาะจุดที่มีป้าย [MAP] แล้วตั้ง MAPPING_VERIFIED = true
 *  ขั้นตอนละเอียดอยู่ใน docs/WONDD-INTEGRATION.md
 * ════════════════════════════════════════════════════════════════════
 */
const config = require('../config');
const { httpCall, markOutcome, callbackUrl } = require('./base');
const { hmacSha256, safeEqual } = require('../lib/security');

const NAME = 'wondd';
const cfg = config.wondd;

// [MAP] 0) เปลี่ยนเป็น true หลังแก้ไฟล์นี้ตามคู่มือ WonDD และทดสอบกับยอดเล็กๆ แล้วเท่านั้น
//          ระหว่างที่เป็น false ระบบจะ "ไม่ส่ง" คำขอเติมเงินจริงเด็ดขาด และไม่ตัดเงินลูกค้า
const MAPPING_VERIFIED = false;

// [MAP] 1) ความสามารถของ API (ปิดอันที่ WonDD ไม่มี)
const CAPABILITIES = { statusCheck: true, balance: true, products: true, callback: true, catalog: 'primary' };

// [MAP] 2) path ของแต่ละคำสั่ง (ต่อท้าย WONDD_API_URL)
const ENDPOINTS = {
  topup: '/topup',
  package: '/package',
  status: '/status',
  balance: '/balance',
  products: '/products',
};

// [MAP] 3) รหัสสถานะของ WonDD → สถานะกลาง (ใส่เฉพาะที่ยืนยันจากคู่มือแล้ว)
//   success = สำเร็จ | failed = ไม่สำเร็จแน่นอน (ระบบคืนเงินลูกค้า) | processing = กำลังดำเนินการ
//   ค่าที่ไม่อยู่ในตาราง → unknown (ไม่คืนเงิน ไม่ส่งซ้ำ รอเช็กสถานะ/แอดมินตรวจ) เพื่อความปลอดภัย
//   ⚠️ อย่าเดารหัสตัวเลข เช่น "0" — บางระบบ 0 = สำเร็จ บางระบบ 0 = ล้มเหลว
// [MAP] 3b) HTTP 4xx ตอนส่งรายการที่ WonDD ยืนยันว่า "ปฏิเสธก่อนทำรายการแน่นอน" (คืนเงินลูกค้าได้)
//   รหัสอื่น / คำตอบที่อ่านไม่ออก / แจ้งว่ารายการซ้ำ → unknown (ไม่คืนเงิน รอเช็กสถานะ) — ปลอดภัยกว่า
const REJECT_HTTP_CODES = new Set([400, 401, 403, 422]);

const STATUS_MAP = {
  success: 'success',
  successful: 'success',
  completed: 'success',
  failed: 'failed',
  fail: 'failed',
  rejected: 'failed',
  cancelled: 'failed',
  pending: 'processing',
  processing: 'processing',
  waiting: 'processing',
};

// [MAP] 4) ข้อมูลยืนยันตัวตน + ลายเซ็นที่แนบทุกคำขอ
function signedFields(payload) {
  const fields = {
    ...payload,
    username: cfg.username || undefined,
    apikey: cfg.apiKey || undefined,
    timestamp: Math.floor(Date.now() / 1000),
  };
  if (cfg.secret) {
    // ตัวอย่าง: HMAC-SHA256 ของ key=value เรียงตามตัวอักษร คั่นด้วย & — แก้ตามคู่มือจริง
    const base = Object.keys(fields).filter((k) => fields[k] !== undefined).sort().map((k) => `${k}=${fields[k]}`).join('&');
    fields.sign = hmacSha256(cfg.secret, base);
  }
  return fields;
}

// [MAP] 5) คำขอเติมเงิน / สมัครแพ็กเกจ
function buildSubmit(order) {
  const isPackage = order.type === 'package';
  return {
    path: isPackage ? ENDPOINTS.package : ENDPOINTS.topup,
    form: signedFields({
      ref: order.ref, // เลขอ้างอิงของเรา (ไม่ซ้ำ) — ใช้ตามหารายการและกันเติมซ้ำ
      service: isPackage ? order.product_code : order.provider_topup_code,
      mobile: order.phone,
      amount: (order.face_value / 100).toFixed(2),
      // มีรหัสลับ ?t=... ต่อท้าย — callback ที่ไม่มีรหัสนี้ (และไม่มีลายเซ็น/IP ที่ถูกต้อง) จะถูกปฏิเสธ
      callback_url: callbackUrl(NAME),
    }),
  };
}

// [MAP] 6) อ่านข้อมูลจากคำตอบ / callback ของ WonDD
function readFields(data) {
  if (!data || typeof data !== 'object') return null;
  const status = data.status ?? data.result ?? data.state;
  return {
    ref: data.ref ?? data.reference ?? data.order_ref ?? data.refid,
    providerStatus: status === undefined || status === null ? undefined : String(status),
    providerTxnId: data.transaction_id ?? data.txid ?? data.trans_id ?? data.doccode,
    message: data.message ?? data.msg ?? data.detail,
    balance: data.balance ?? data.credit,
  };
}

// [MAP] 7) ตรวจลายเซ็น callback (ใช้เมื่อตั้ง WONDD_CALLBACK_SECRET แล้วเท่านั้น)
function verifyCallbackSignature({ rawBody, headers, data }) {
  const given = headers['x-signature'] || data.sign || data.signature;
  const expected = hmacSha256(cfg.callbackSecret, rawBody || '');
  return safeEqual(given, expected);
}

// [MAP] 8) แปลงรายการสินค้าจาก WonDD (ใช้ปุ่ม "ดึงรายการแพ็กเกจ" ในหน้าแอดมิน)
function readProducts(json) {
  const list = Array.isArray(json) ? json : json?.data || json?.products || [];
  return list.map((p) => ({
    networkCode: String(p.network || p.operator || '').toUpperCase(),
    providerCode: String(p.code || p.service || p.id || ''),
    name: String(p.name || p.title || ''),
    price: Math.round(Number(p.price || p.amount || 0) * 100),
    cost: Math.round(Number(p.cost || p.net_price || p.price || 0) * 100),
    validityDays: p.days ? Number(p.days) : null,
  })).filter((p) => p.providerCode && p.name && p.price > 0);
}

// ───────────────────── ส่วนด้านล่างไม่ต้องแก้ ─────────────────────

function mapStatus(raw) {
  if (raw === undefined || raw === null) return 'unknown';
  return STATUS_MAP[String(raw).trim().toLowerCase()] || 'unknown';
}

function configStatus() {
  const missing = [];
  if (!cfg.baseUrl) missing.push('WONDD_API_URL (ที่อยู่ API จาก WonDD)');
  if (!cfg.username && !cfg.apiKey) missing.push('WONDD_USERNAME หรือ WONDD_API_KEY');
  if (!MAPPING_VERIFIED) missing.push('แก้ src/providers/wondd.js ตามคู่มือ WonDD แล้วตั้ง MAPPING_VERIFIED = true');
  return { ready: missing.length === 0, missing };
}

/** แปลงผล HTTP เป็นผลลัพธ์กลาง */
function interpret(res, action) {
  if (res.error) return { outcome: 'unknown', notSent: res.notSent, message: res.error, transport: true };
  if (res.status >= 500 || res.status === 408) return { outcome: 'unknown', message: `ผู้ให้บริการขัดข้อง (HTTP ${res.status})`, transport: true };
  if (res.status >= 300 && res.status < 400) return { outcome: 'unknown', message: `ผู้ให้บริการตอบกลับผิดรูปแบบ (HTTP ${res.status})`, transport: true };
  if (res.status === 409) return { outcome: 'unknown', message: 'ผู้ให้บริการแจ้งว่ารายการซ้ำ (HTTP 409) — ต้องตรวจสอบ' };
  if (res.status >= 400) {
    const f = readFields(res.json) || {};
    if (action !== 'submit') return { outcome: 'unknown', providerStatus: `HTTP_${res.status}`, message: f.message || `เช็กสถานะไม่ได้ (HTTP ${res.status})` };
    // อ่านสถานะใน body ก่อน — เช่น 400 + {"status":"pending"} แปลว่ากำลังทำ ไม่ใช่ล้มเหลว
    const mapped = MAPPING_VERIFIED ? mapStatus(f.providerStatus) : 'unknown';
    if (mapped !== 'unknown') return { outcome: mapped, providerStatus: f.providerStatus, providerTxnId: f.providerTxnId ? String(f.providerTxnId) : undefined, message: f.message };
    // แจ้งว่ารายการซ้ำ = อาจทำไปแล้ว → ห้ามคืนเงิน
    if (/dup|ซ้ำ|exist/i.test(`${f.providerStatus || ''} ${f.message || ''}`)) {
      return { outcome: 'unknown', providerStatus: f.providerStatus || `HTTP_${res.status}`, message: f.message || 'ผู้ให้บริการแจ้งว่ารายการซ้ำ — ต้องตรวจสอบ' };
    }
    if (REJECT_HTTP_CODES.has(res.status)) {
      return { outcome: 'failed', providerStatus: f.providerStatus || `HTTP_${res.status}`, message: f.message || `ผู้ให้บริการปฏิเสธคำขอ (HTTP ${res.status})` };
    }
    return { outcome: 'unknown', providerStatus: f.providerStatus || `HTTP_${res.status}`, message: f.message || `ผู้ให้บริการตอบกลับ HTTP ${res.status} — ต้องตรวจสอบ` };
  }
  const f = readFields(res.json);
  if (!f) return { outcome: 'unknown', message: 'อ่านคำตอบจากผู้ให้บริการไม่ได้ (ไม่ใช่ JSON)' };
  const outcome = MAPPING_VERIFIED ? mapStatus(f.providerStatus) : 'unknown';
  return { outcome, providerStatus: f.providerStatus, providerTxnId: f.providerTxnId ? String(f.providerTxnId) : undefined, message: f.message };
}

async function submit(order) {
  const ready = configStatus();
  if (!ready.ready) {
    return { outcome: 'failed', notSent: true, providerStatus: 'NOT_CONFIGURED', message: 'ยังตั้งค่า WonDD API ไม่ครบ ระบบจึงไม่ได้ส่งคำขอ' };
  }
  const req = buildSubmit(order);
  const res = await httpCall({ provider: NAME, action: 'submit', orderRef: order.ref, url: cfg.baseUrl + req.path, form: req.form, timeoutMs: config.provider.timeoutMs });
  const result = interpret(res, 'submit');
  markOutcome(res.logId, result.outcome);
  return result;
}

async function checkStatus(order) {
  if (!configStatus().ready || !CAPABILITIES.statusCheck) return { outcome: 'unknown', message: 'ไม่รองรับการเช็กสถานะ' };
  const res = await httpCall({
    provider: NAME, action: 'status', orderRef: order.ref, url: cfg.baseUrl + ENDPOINTS.status,
    form: signedFields({ ref: order.ref }), timeoutMs: Math.min(config.provider.timeoutMs, 20000),
  });
  const result = interpret(res, 'status');
  markOutcome(res.logId, result.outcome);
  return result;
}

async function getBalance() {
  if (!cfg.baseUrl || !CAPABILITIES.balance) return { ok: false, message: 'ยังไม่ได้ตั้งค่า WONDD_API_URL' };
  const res = await httpCall({ provider: NAME, action: 'balance', url: cfg.baseUrl + ENDPOINTS.balance, form: signedFields({}), timeoutMs: 15000 });
  if (res.error || !res.ok) return { ok: false, message: res.error || `HTTP ${res.status}` };
  const f = readFields(res.json);
  const n = Number(f?.balance);
  if (!Number.isFinite(n)) return { ok: false, message: 'อ่านยอดเครดิตไม่ได้' };
  return { ok: true, balance: Math.round(n * 100) };
}

async function listProducts() {
  if (!configStatus().ready || !CAPABILITIES.products) return { ok: false, message: 'ยังไม่พร้อมดึงรายการสินค้า' };
  const res = await httpCall({ provider: NAME, action: 'products', url: cfg.baseUrl + ENDPOINTS.products, form: signedFields({}), timeoutMs: 20000 });
  if (res.error || !res.ok) return { ok: false, message: res.error || `HTTP ${res.status}` };
  return { ok: true, products: readProducts(res.json) };
}

const normalizeIp = (ip) => String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/**
 * รับ callback — ต้องผ่านการยืนยันอย่างน้อย 1 อย่าง ไม่อย่างนั้นปฏิเสธ (กันคนปลอม "ไม่สำเร็จ" เพื่อให้ระบบคืนเงิน):
 *   signed = ลายเซ็นถูกต้อง (ตั้ง WONDD_CALLBACK_SECRET)  → เชื่อผลได้ทันที
 *   ip     = มาจาก IP ใน WONDD_CALLBACK_IPS
 *   token  = มีรหัสลับ ?t=... ที่ระบบแนบไปใน callback_url
 * ถ้าไม่ใช่ signed ระบบจะ "เช็กสถานะกับ WonDD ซ้ำ" ก่อนขยับเงินเสมอ (ดู orders.applyCallback)
 */
function handleCallback({ rawBody, headers, query, body, ip, tokenOk }) {
  const cleanIp = normalizeIp(ip);
  if (cfg.callbackIps.length && !cfg.callbackIps.includes(cleanIp)) {
    return { ok: false, status: 403, body: 'forbidden', error: `IP ${cleanIp} ไม่อยู่ในรายการที่อนุญาต` };
  }
  const bodyData = body && typeof body === 'object' ? body : {};
  let data = { ...(query || {}), ...bodyData };
  let trust = null;
  if (cfg.callbackSecret) {
    // ลายเซ็นครอบคลุมเฉพาะ body → อ่านข้อมูลจาก body อย่างเดียว (ค่าใน query string ปลอมแทรกได้)
    if (!rawBody || !verifyCallbackSignature({ rawBody, headers, data: bodyData })) {
      return { ok: false, status: 401, body: 'invalid signature', error: 'ลายเซ็น callback ไม่ถูกต้อง' };
    }
    data = bodyData;
    trust = 'signed';
  } else if (cfg.callbackIps.length) {
    trust = 'ip';
  } else if (tokenOk) {
    trust = 'token';
  }
  if (!trust) {
    return { ok: false, status: 401, body: 'unauthorized', error: 'callback ไม่มีการยืนยันตัวตน (ไม่มีรหัส ?t= / ลายเซ็น / IP ที่อนุญาต)' };
  }
  const f = readFields(data);
  if (!f?.ref) return { ok: false, status: 400, body: 'missing ref', error: 'callback ไม่มีเลขอ้างอิง' };
  return {
    ok: true,
    updates: [{
      ref: String(f.ref),
      outcome: MAPPING_VERIFIED ? mapStatus(f.providerStatus) : 'unknown',
      providerStatus: f.providerStatus,
      providerTxnId: f.providerTxnId ? String(f.providerTxnId) : undefined,
      message: f.message,
      trust,
    }],
    // [MAP] 9) ข้อความที่ WonDD ต้องการให้ตอบกลับเมื่อรับ callback สำเร็จ
    response: { status: 200, body: 'OK' },
  };
}

module.exports = {
  name: NAME,
  label: 'WonDD (ใช้งานจริง)',
  shopName: 'WonDD',
  capabilities: CAPABILITIES,
  configStatus,
  submit,
  checkStatus,
  getBalance,
  listProducts,
  handleCallback,
  _internal: { mapStatus, interpret, readFields, MAPPING_VERIFIED },
};
