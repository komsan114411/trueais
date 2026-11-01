'use strict';
/**
 * ════════════════════════════════════════════════════════════════════
 *  wePAY adapter  (www.wepay.in.th — บัญชีตัวแทน/ร้านค้า)
 * ════════════════════════════════════════════════════════════════════
 *  ⚠️ wePAY ไม่เผยแพร่คู่มือ API สาธารณะ — ไฟล์นี้ทำตามรูปแบบที่ใช้กันจริง (ณ พ.ย. 2569)
 *     ขอคู่มือ "wePAY API Document" จาก wePAY ตอนขอเปิด API แล้วเทียบกับจุดที่มีป้าย [CHECK]
 *     รายละเอียด/ขั้นตอนเปิดใช้: docs/WEPAY-INTEGRATION.md
 *
 *  - คำขอเดียว: POST JSON ไปที่ client_api.json.php เลือกคำสั่งด้วย type
 *      ยืนยันตัวตน: username + password_hash (= MD5 ของรหัสผ่าน) ในทุกคำขอ
 *  - ต้องแจ้ง IP ของเซิร์ฟเวอร์ให้ wePAY ก่อน (ไม่อย่างนั้นได้รหัส 20005 ทุกคำขอ)
 *  - dest_ref = เลขที่รายการของเรา (ไม่ซ้ำ, A-Z0-9 ไม่เกิน 20 ตัว) — ส่งซ้ำเลขเดิมได้รหัส 30016
 *  - รหัส 00000 + transaction_id = รับรายการแล้ว (ยังไม่เสร็จ) ผลจริงมาทาง callback (resp_url) ใน 1-5 นาที
 *    หรือเช็กด้วย get_output: status=2 สำเร็จ / status=4 ไม่สำเร็จ (wePAY คืนเงินเข้ากระเป๋า wePAY)
 *  - ต้นทุน = ยอดเติม - เงินคืน (%) ของบัญชี → ตั้งใน WEPAY_DISCOUNTS ให้ตรงกับหน้า "บริการ" ของ wePAY
 *    (ระบบบันทึกยอดที่ wePAY ตัดจริง total_amount ทุกรายการ และแจ้งเตือนถ้าสูงกว่าราคาขาย)
 *
 *  กันเติมซ้ำ 2 ร้าน: ถือว่า "wePAY ไม่ได้รับรายการ" (ส่งต่อร้านสำรองได้) เฉพาะคำตอบ JSON ที่มีรหัสปฏิเสธในตาราง REJECT
 *  และไม่มีเลขที่รายการ — คำตอบอื่นทั้งหมด (หมดเวลารอ, 5xx, ข้อความแปลก, รหัสไม่รู้จัก, 30016) = "ไม่รู้ผล"
 *  ห้ามคืนเงิน ห้ามส่งร้านอื่น ห้ามส่งซ้ำ (ไม่แน่ใจว่า wePAY กันเลขซ้ำได้ทุกกรณี) → รอ callback / เช็กสถานะ / ให้เจ้าหน้าที่ตรวจ
 *  ยังไม่รองรับแพ็กเกจเน็ต (wePAY ใช้ราคาแทนรหัสแพ็กเกจ — รอยืนยันจากคู่มือจริง) ร้านนี้จึงขายเฉพาะเติมเงิน
 * ════════════════════════════════════════════════════════════════════
 */
const crypto = require('node:crypto');
const config = require('../config');
const { httpCall, markOutcome, callbackUrl } = require('./base');
const { afterDiscount } = require('../lib/money');

const NAME = 'wepay';
const cfg = config.wepay;
const CAPABILITIES = { statusCheck: true, balance: true, products: false, callback: true, catalog: 'rates', packages: false };

// [CHECK] ช่วงยอดเติมที่ wePAY รับ (บาท) ตามหน้า "บริการ" — ยอดนอกช่วงไม่เสนอร้านนี้ให้ลูกค้า
const LIMITS = { AIS: { min: 10, max: 1500 }, DTAC: { min: 10, max: 800 }, TRUE: { min: 5, max: 1000 } };

// [CHECK] รหัสที่ wePAY ตอบตอนส่งรายการ = ปฏิเสธก่อนสร้างรายการแน่นอน (ไม่ตัดเงิน) → ส่งต่อร้านสำรองได้
//   trip = พักการส่งไป wePAY กี่วินาที (ปัญหาฝั่งบัญชี — ส่งต่อไปก็ไม่ผ่านเหมือนเดิม)
const REJECT = {
  20001: { reason: 'ชื่อผู้ใช้หรือรหัสผ่าน wePAY ไม่ถูกต้อง (WEPAY_USERNAME / WEPAY_PASSWORD)', trip: 1800 },
  20005: { reason: 'IP ของเซิร์ฟเวอร์ยังไม่ได้ลงทะเบียนกับ wePAY — แจ้ง IP ให้ wePAY เพิ่มก่อน', trip: 1800 },
  30005: { reason: 'wePAY ไม่รับที่อยู่สำหรับแจ้งผล (ตรวจ PUBLIC_URL ว่าเปิดจากอินเทอร์เน็ตได้)', trip: 1800 },
  30019: { reason: 'เครดิตในกระเป๋า wePAY ไม่พอ — กรุณาเติมเครดิต', trip: 600 },
  30001: { reason: 'wePAY ไม่รู้จักบริการนี้ (ตรวจรหัสใน WEPAY_COMPANIES)' },
  30017: { reason: 'wePAY ไม่รู้จักบริการนี้ (ตรวจรหัสใน WEPAY_COMPANIES)' },
  30007: { reason: 'wePAY ไม่รับยอดเงินนี้' },
  30018: { reason: 'wePAY ไม่รับยอดเงินนี้' },
  30009: { reason: 'wePAY ไม่รับเบอร์ปลายทางนี้' },
};
const OK = '00000';

const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const satang = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.round(n * 100) : null;
};
const baht = (s) => (s % 100 === 0 ? String(s / 100) : (s / 100).toFixed(2));
const companyOf = (networkCode) => cfg.companies[String(networkCode || '').toUpperCase()] || null;

/** WEPAY_API_URL ใช้ได้ไหม — คืนข้อความปัญหา หรือ null (http ได้เฉพาะเครื่องตัวเองตอนทดสอบ) */
function apiUrlProblem() {
  let u;
  try { u = new URL(cfg.apiUrl); } catch { return 'WEPAY_API_URL ไม่ใช่ URL ที่ถูกต้อง (เช่น https://www.wepay.in.th/client_api.json.php)'; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return 'WEPAY_API_URL ต้องขึ้นต้นด้วย https://';
  if (u.username || u.password || u.hash) return 'WEPAY_API_URL ต้องไม่มีชื่อผู้ใช้หรือ # ในลิงก์';
  return null;
}

function configStatus() {
  const missing = [];
  if (!cfg.username) missing.push('WEPAY_USERNAME (ชื่อผู้ใช้ที่ wePAY เปิด API ให้)');
  if (!cfg.password) missing.push('WEPAY_PASSWORD');
  const bad = apiUrlProblem();
  if (bad) missing.push(bad);
  return { ready: missing.length === 0, missing };
}

/** ต้นทุนของร้านนี้ต่อเครือข่าย (basis point ของเงินคืน) — ใช้คำนวณส่วนลดลูกค้าสูงสุดที่ไม่ขาดทุน */
const costDiscountBp = (networkCode) => (companyOf(networkCode) ? cfg.discountBp[String(networkCode).toUpperCase()] ?? 0 : 0);

const auth = () => ({ username: cfg.username, password_hash: md5(cfg.password) });

async function call(type, fields, { action, orderRef, timeoutMs }) {
  return httpCall({
    provider: NAME,
    action,
    orderRef,
    url: cfg.apiUrl,
    body: { ...auth(), type, ...fields },
    timeoutMs,
  });
}

/** รหัสผลของ wePAY (เก็บเป็นข้อความ 5 หลัก เช่น "00000") */
const codeOf = (j) => (j && typeof j === 'object' && j.code !== undefined && j.code !== null ? String(j.code).trim() : null);
const descOf = (j) => String(j?.desc ?? j?.message ?? j?.msg ?? '').slice(0, 200);

// ───────────── ใช้โดยตัวเลือกร้าน (router) ─────────────

/** ยอดที่ wePAY รับ (สตางค์) ของเครือข่ายนี้ — null = ร้านนี้ไม่มีเครือข่ายนี้ */
function topupLimits(networkCode) {
  const l = LIMITS[String(networkCode || '').toUpperCase()];
  return l && companyOf(networkCode) ? { min: l.min * 100, max: l.max * 100 } : null;
}

/** ต้นทุน + รหัสบริการของรายการนี้ที่ wePAY (null = wePAY ทำรายการนี้ไม่ได้) */
function quote(item) {
  if (item.type !== 'topup') return null; // แพ็กเกจยังไม่รองรับ
  const code = item.network?.code;
  const company = companyOf(code);
  const lim = topupLimits(code);
  const face = item.faceValue;
  if (!company || !lim || !Number.isSafeInteger(face) || face % 100 !== 0) return null;
  if (face < lim.min || face > lim.max) return null;
  if (face < item.network.topup_min || face > item.network.topup_max) return null;
  const bp = cfg.discountBp[String(code).toUpperCase()] ?? 0;
  return { cost: afterDiscount(face, bp), code: company };
}

// ───────────── แปลงคำตอบ ─────────────

/** คำตอบตอนส่งรายการ → ผลลัพธ์กลาง (ดูกฎกันเติมซ้ำด้านบน) */
function interpretSubmit(res) {
  if (res.error) return { outcome: 'unknown', notSent: Boolean(res.notSent), transport: true, message: res.error };
  const j = res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? res.json : null;
  if (!j) {
    return {
      outcome: 'unknown',
      transport: true,
      providerStatus: `HTTP_${res.status}`,
      message: `อ่านคำตอบจาก wePAY ไม่ได้ (HTTP ${res.status}${res.text ? `: ${String(res.text).slice(0, 80)}` : ''}) — ยังไม่แน่ใจว่ารับรายการหรือไม่ ระบบจะตรวจสอบต่อ`,
    };
  }
  const code = codeOf(j);
  const txn = j.transaction_id ?? j.bill_id;
  if (code === OK && res.status >= 200 && res.status < 300 && txn !== undefined && txn !== null && String(txn).trim() !== '') {
    return {
      outcome: 'processing',
      providerStatus: 'ACCEPTED',
      providerTxnId: String(j.transaction_id ?? j.bill_id).slice(0, 100),
      message: 'wePAY รับรายการแล้ว กำลังดำเนินการ',
      chargedAmount: satang(j.total_amount) ?? undefined,
    };
  }
  const rule = Object.hasOwn(REJECT, code || '') ? REJECT[code] : null;
  // ปฏิเสธแน่นอน = รหัสในตาราง + ไม่มีเลขที่รายการ + ไม่ใช่ 5xx
  if (rule && (txn === undefined || txn === null || String(txn).trim() === '') && res.status < 500) {
    return {
      outcome: 'failed',
      retryable: true,
      providerStatus: code,
      message: `${rule.reason}${descOf(j) ? ` — ${descOf(j)}` : ''}`,
      ...(rule.trip ? { trip: { seconds: rule.trip, reason: rule.reason } } : {}),
    };
  }
  if (code === '30016') {
    return {
      outcome: 'unknown',
      providerStatus: code,
      message: 'wePAY แจ้งว่าเลขที่รายการนี้มีอยู่แล้ว — อาจรับรายการไปแล้ว ห้ามส่งซ้ำ',
      review: 'wePAY แจ้งว่าเลขที่รายการนี้เคยส่งแล้ว (30016) — กรุณาตรวจในหน้า wePAY ว่ามีรายการนี้หรือไม่ ก่อนยืนยันผล',
    };
  }
  return {
    outcome: 'unknown',
    transport: res.status >= 500,
    providerStatus: code || `HTTP_${res.status}`,
    message: `wePAY ตอบ ${code || 'ไม่มีรหัส'} (HTTP ${res.status})${descOf(j) ? `: ${descOf(j)}` : ''} — ยังไม่แน่ใจว่ารับรายการหรือไม่ ระบบจะตรวจสอบต่อ`,
  };
}

// [CHECK] สถานะใน get_output / callback: 2 = สำเร็จ, 4 = ไม่สำเร็จ (wePAY คืนเงินให้ร้านแล้ว), อื่นๆ = ยังไม่เสร็จ
function mapStatus(s) {
  const v = String(s ?? '').trim();
  if (v === '2') return 'success';
  if (v === '4') return 'failed';
  return v ? 'processing' : 'unknown';
}

/** output ของ get_output เป็นข้อความแบบ query string เช่น "dest_ref=TP...&status=2" */
function parseOutput(output) {
  if (output && typeof output === 'object') return output;
  try {
    return Object.fromEntries(new URLSearchParams(String(output || '')));
  } catch {
    return {};
  }
}

// ───────────── คำสั่งหลัก ─────────────

async function submit(order) {
  if (!configStatus().ready) {
    return { outcome: 'failed', retryable: true, local: true, notSent: true, providerStatus: 'NOT_CONFIGURED', message: 'ยังตั้งค่า wePAY ไม่ครบ ระบบจึงไม่ได้ส่งคำขอ' };
  }
  const company = order.route?.code || companyOf(order.network_code);
  if (order.type !== 'topup' || !company) {
    return { outcome: 'failed', retryable: true, local: true, notSent: true, providerStatus: 'NOT_SUPPORTED', message: 'wePAY ยังไม่รองรับรายการประเภทนี้ — ไม่ได้ส่งคำขอ' };
  }
  if (!/^[A-Z0-9]{1,20}$/.test(String(order.ref))) {
    return { outcome: 'failed', retryable: true, local: true, notSent: true, providerStatus: 'BAD_REF', message: 'เลขที่รายการยาวเกินที่ wePAY รับ (ไม่เกิน 20 ตัว) — ไม่ได้ส่งคำขอ' };
  }
  const res = await call('mtopup', {
    pay_to_company: company,
    pay_to_amount: baht(order.face_value),
    pay_to_ref1: order.phone,
    dest_ref: order.ref,
    // มีรหัสลับ ?t=... ต่อท้าย — callback ที่ไม่มีรหัสนี้ถูกปฏิเสธ (wePAY ไม่มีลายเซ็น)
    resp_url: callbackUrl(NAME),
  }, { action: 'submit', orderRef: order.ref, timeoutMs: config.provider.timeoutMs });
  const result = interpretSubmit(res);
  markOutcome(res.logId, result.outcome);
  return result;
}

/** เช็กสถานะด้วยเลขที่รายการของ wePAY (ได้ตอนส่ง หรือจาก callback) — ไม่มีเลข = รอ callback */
async function checkStatus(order, { attempt } = {}) {
  if (!configStatus().ready) return { outcome: 'unknown', message: 'ยังตั้งค่า wePAY ไม่ครบ' };
  const txn = attempt?.provider_txn_id || order.provider_txn_id;
  if (!txn) {
    return { outcome: 'unknown', providerStatus: 'NO_TXN', message: 'ยังไม่มีเลขที่รายการจาก wePAY (คำขอส่งหมดเวลารอ) — รอ wePAY แจ้งผลกลับ หรือให้เจ้าหน้าที่ตรวจในหน้า wePAY' };
  }
  const res = await call('get_output', { transaction_id: String(txn) }, { action: 'status', orderRef: order.ref, timeoutMs: Math.min(config.provider.timeoutMs, 20000) });
  let result;
  const j = res.json && typeof res.json === 'object' ? res.json : null;
  if (res.error || !j) {
    result = { outcome: 'unknown', providerStatus: res.error ? 'NETWORK' : `HTTP_${res.status}`, message: res.error || `เช็กสถานะกับ wePAY ไม่ได้ (HTTP ${res.status})` };
  } else if (codeOf(j) !== OK) {
    const rule = Object.hasOwn(REJECT, codeOf(j) || '') ? REJECT[codeOf(j)] : null;
    result = {
      outcome: 'unknown',
      providerStatus: codeOf(j) || `HTTP_${res.status}`,
      message: `เช็กสถานะกับ wePAY ไม่ได้: ${rule?.reason || descOf(j) || codeOf(j) || 'ไม่ทราบสาเหตุ'}`,
      ...(rule?.trip && codeOf(j) !== '30019' ? { trip: { seconds: rule.trip, reason: rule.reason } } : {}),
    };
  } else {
    const out = parseOutput(j.output);
    if (out.dest_ref && String(out.dest_ref).toUpperCase() !== String(order.ref).toUpperCase()) {
      result = {
        outcome: 'unknown',
        providerStatus: 'REF_MISMATCH',
        message: `wePAY ตอบข้อมูลของรายการอื่น (${String(out.dest_ref).slice(0, 30)}) — ไม่นำมาใช้`,
        review: 'เลขที่รายการที่ wePAY ตอบไม่ตรงกับรายการนี้ — กรุณาตรวจในหน้า wePAY',
      };
    } else {
      const outcome = mapStatus(out.status);
      result = {
        outcome,
        providerStatus: out.status !== undefined ? `STATUS_${String(out.status).slice(0, 20)}` : undefined,
        providerTxnId: String(txn),
        message: outcome === 'success' ? 'เติมเงินสำเร็จ' : outcome === 'failed' ? `wePAY แจ้งว่าไม่สำเร็จ${out.sms ? `: ${String(out.sms).slice(0, 150)}` : ''}` : 'wePAY กำลังดำเนินการ',
      };
    }
  }
  markOutcome(res.logId, result.outcome);
  return result;
}

async function getBalance() {
  if (!configStatus().ready) return { ok: false, message: 'ยังตั้งค่า wePAY ไม่ครบ' };
  const res = await call('balance_inquiry', {}, { action: 'balance', timeoutMs: 15000 });
  if (res.error) return { ok: false, message: res.error };
  const j = res.json && typeof res.json === 'object' ? res.json : null;
  if (!j) return { ok: false, message: `อ่านคำตอบจาก wePAY ไม่ได้ (HTTP ${res.status})` };
  if (codeOf(j) !== OK) {
    const rule = Object.hasOwn(REJECT, codeOf(j) || '') ? REJECT[codeOf(j)] : null;
    // ปัญหาบัญชี (รหัสผ่านผิด / IP ยังไม่ลงทะเบียน) → พักร้านนี้ไว้ รายการใหม่ไปร้านสำรอง
    const trip = rule?.trip && ['20001', '20005'].includes(codeOf(j)) ? { seconds: rule.trip, reason: rule.reason } : null;
    return { ok: false, code: codeOf(j), message: rule?.reason || `wePAY ตอบ ${codeOf(j) || '-'} ${descOf(j)}`.trim(), ...(trip ? { trip } : {}) };
  }
  const n = satang(j.available_balance ?? j.ledger_balance);
  if (n === null) return { ok: false, message: 'อ่านยอดเครดิต wePAY ไม่ได้' };
  return { ok: true, balance: n };
}

const normalizeIp = (ip) => String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/**
 * รับผลจาก wePAY (POST แบบฟอร์ม: dest_ref, transaction_id, status, sms, operator_trxnsid)
 * wePAY ไม่มีลายเซ็น → ต้องมีรหัสลับ ?t=... ที่แนบไปใน resp_url หรือมาจาก IP ใน WEPAY_CALLBACK_IPS
 * ระบบไม่เชื่อผลจาก callback ทันที: เช็กสถานะกับ wePAY ซ้ำก่อนขยับเงินเสมอ (orders.applyCallback)
 * ตอบ "SUCCEED|ORDER_ID=<เลขที่รายการ>" เมื่อรับไว้แล้ว — ตอบอย่างอื่น wePAY จะส่งซ้ำ
 */
function handleCallback({ query, body, ip, tokenOk }) {
  const cleanIp = normalizeIp(ip);
  const byIp = cfg.callbackIps.length > 0 && cfg.callbackIps.includes(cleanIp);
  if (cfg.callbackIps.length && !byIp) {
    return { ok: false, status: 403, body: 'ERROR|forbidden', error: `IP ${cleanIp} ไม่อยู่ใน WEPAY_CALLBACK_IPS` };
  }
  if (!tokenOk && !byIp) {
    return { ok: false, status: 401, body: 'ERROR|unauthorized', error: 'callback ไม่มีรหัสยืนยัน (?t=) ที่ถูกต้อง' };
  }
  const data = { ...(query || {}), ...(body && typeof body === 'object' ? body : {}) };
  const ref = String(data.dest_ref || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,40}$/.test(ref)) return { ok: false, status: 400, body: 'ERROR|missing dest_ref', error: 'callback ไม่มี dest_ref' };
  const txn = String(data.transaction_id || '').trim().slice(0, 100);
  return {
    ok: true,
    updates: [{
      ref,
      outcome: mapStatus(data.status),
      providerStatus: data.status !== undefined ? `STATUS_${String(data.status).slice(0, 20)}` : undefined,
      providerTxnId: txn || undefined,
      message: data.sms ? String(data.sms).slice(0, 200) : undefined,
      trust: byIp ? 'ip' : 'token',
    }],
    response: { status: 200, body: `SUCCEED|ORDER_ID=${ref}` },
    errorResponse: { status: 200, body: `ERROR|ORDER_ID=${ref}` },
  };
}

module.exports = {
  name: NAME,
  label: 'wePAY (ใช้งานจริง)',
  shopName: 'wePAY',
  capabilities: CAPABILITIES,
  configStatus,
  quote,
  topupLimits,
  costDiscountBp,
  submit,
  checkStatus,
  getBalance,
  handleCallback,
  _internal: { interpretSubmit, mapStatus, parseOutput, md5, LIMITS, REJECT },
};
