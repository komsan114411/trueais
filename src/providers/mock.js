'use strict';
/**
 * ผู้ให้บริการจำลอง (โหมดทดสอบ) — ทำงานเหมือนระบบจริง แต่ไม่มีการเติมเงินจริง
 * มี 2 ร้านจำลอง: mock (ร้านทดสอบ A) และ mock2 (ร้านทดสอบ B) ไว้ลอง "เลือกร้าน" และ "สลับร้านอัตโนมัติ"
 *   เปิด 2 ร้าน: PROVIDERS=mock,mock2
 *
 * เบอร์ทดสอบพิเศษ (ดูจาก 4 หลักท้าย):
 *   xxxxxx0000 → ผู้ให้บริการปฏิเสธทันที            → ไม่สำเร็จ + คืนเงินอัตโนมัติ
 *   xxxxxx1111 → เติมสำเร็จ แต่ตอบกลับไม่ทัน (timeout) → ระบบต้องเช็กสถานะเอง ห้ามคืนเงิน/ห้ามส่งซ้ำ
 *   xxxxxx2222 → ค้างสถานะตลอด                      → ส่งให้แอดมินตรวจสอบ
 *   xxxxxx3333 → รับเรื่องแล้ว ภายหลังแจ้งไม่สำเร็จ    → คืนเงินอัตโนมัติเมื่อได้ callback
 *   xxxxxx4444 → เชื่อมต่อไม่ได้ (คำขอไม่ถึง)          → ส่งต่อร้านอื่น หรือคืนเงินทันทีถ้าไม่มีร้านอื่น
 *   xxxxxx5555 → รับเรื่องแล้ว ภายหลังแจ้งสำเร็จ       → สำเร็จเมื่อได้ callback
 *   เบอร์อื่น  → สุ่มตามค่าที่ตั้งในหน้าแอดมิน (โหมดทดสอบ)
 */
const config = require('../config');
const db = require('../db');
const settings = require('../services/settings');
const logger = require('../lib/logger');
const { logCall } = require('./base');
const { hmacSha256, safeEqual, randomCode } = require('../lib/security');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPECIAL = {
  '0000': 'reject',
  '1111': 'timeout',
  '2222': 'stuck',
  '3333': 'async_fail',
  '4444': 'down',
  '5555': 'async_ok',
};

function scenarioFor(phone) {
  const special = SPECIAL[String(phone).slice(-4)];
  if (special) return special;
  const s = settings.all();
  if (Math.random() * 100 < s.mock_timeout_rate) return 'timeout';
  const ok = Math.random() * 100 < s.mock_success_rate;
  const async = Math.random() * 100 < s.mock_async_rate;
  if (ok) return async ? 'async_ok' : 'ok';
  return async ? 'async_fail' : 'reject';
}

function createMock(NAME, label, shopName) {
  // แต่ละร้านจำลองเก็บรายการ/เครดิตแยกกัน (ร้านแรกใช้ชื่อเดิมเพื่อเข้ากับข้อมูลเก่า)
  const txKey = (ref) => (NAME === 'mock' ? ref : `${NAME}:${ref}`);
  const balanceKey = NAME === 'mock' ? '_mock_balance' : `_${NAME}_balance`;
  const getBalanceSatang = () => settings.getInternal(balanceKey, 1000000);
  const setBalanceSatang = (v) => settings.setInternal(balanceKey, Math.max(0, Math.round(v)));

  function record(ref, txnId, finalStatus, message, finalizeAtMs) {
    db.run(
      'INSERT INTO mock_txns (ref, txn_id, final_status, message, finalize_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      txKey(ref), txnId, finalStatus, message, new Date(finalizeAtMs).toISOString(), db.nowIso(),
    );
  }

  function statusOf(t) {
    if (t.final_status === 'processing' || Date.parse(t.finalize_at) > Date.now()) {
      return { outcome: 'processing', providerStatus: 'PENDING', providerTxnId: t.txn_id, message: 'ผู้ให้บริการกำลังดำเนินการ [จำลอง]' };
    }
    return {
      outcome: t.final_status,
      providerStatus: t.final_status === 'success' ? 'SUCCESS' : 'FAILED',
      providerTxnId: t.txn_id,
      message: t.message,
    };
  }

  async function sendCallback(ref) {
    const t = db.get('SELECT * FROM mock_txns WHERE ref = ?', txKey(ref));
    if (!t || t.callback_sent) return;
    const body = JSON.stringify({ ref, status: t.final_status, txn_id: t.txn_id, message: t.message });
    const base = config.selfUrl || `http://127.0.0.1:${config.port}`;
    try {
      const res = await fetch(`${base}/api/provider/callback/${NAME}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Mock-Signature': hmacSha256(settings.appSecret(), body) },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) db.run('UPDATE mock_txns SET callback_sent = 1 WHERE ref = ?', txKey(ref));
    } catch (e) {
      logger.warn(`[${NAME}] ส่ง callback ไม่สำเร็จ ${ref}: ${e.message} (ระบบจะเช็กสถานะเองภายหลัง)`);
    }
  }

  function scheduleCallback(ref, delayMs) {
    const timer = setTimeout(() => { sendCallback(ref).catch(() => {}); }, delayMs);
    timer.unref?.();
  }

  async function submit(order) {
    const started = Date.now();
    await sleep(config.isTest ? 5 : 150 + Math.random() * 450);
    const request = { ref: order.ref, type: order.type, network: order.network_code, mobile: order.phone, amount: order.face_value / 100, product: order.product_code };
    const done = (result, httpStatus = 200) => {
      logCall({
        provider: NAME, action: 'submit', orderRef: order.ref, method: 'POST', url: `${NAME}://topup`, request,
        httpStatus: result.notSent ? null : httpStatus,
        response: result.notSent || result.outcome === 'unknown' ? null : JSON.stringify(result),
        outcome: result.outcome, error: result.outcome === 'unknown' ? result.message : null, durationMs: Date.now() - started,
      });
      return result;
    };

    // ส่งเลขอ้างอิงเดิมซ้ำ → ตอบสถานะเดิม (ระบบจริงที่ดีควรทำแบบนี้)
    const existing = db.get('SELECT * FROM mock_txns WHERE ref = ?', txKey(order.ref));
    if (existing) return done(statusOf(existing));

    const scenario = scenarioFor(order.phone);
    const txnId = `MK${randomCode(10)}`;
    const delayMs = Math.max(0, settings.get('mock_callback_delay_sec')) * 1000;
    const now = Date.now();
    const enoughCredit = getBalanceSatang() >= order.cost;

    if (scenario === 'down') {
      return done({ outcome: 'unknown', notSent: true, transport: true, message: 'เชื่อมต่อผู้ให้บริการไม่ได้ (ECONNREFUSED) [จำลอง]' });
    }
    if (!enoughCredit && scenario !== 'reject') {
      // ปฏิเสธก่อนทำรายการ (ไม่ได้รับรายการไว้) → ระบบส่งต่อร้านอื่นได้
      return done({ outcome: 'failed', retryable: true, providerStatus: 'INSUFFICIENT_CREDIT', message: 'เครดิตที่ผู้ให้บริการไม่พอ [จำลอง]' });
    }
    switch (scenario) {
      case 'reject':
        record(order.ref, txnId, 'failed', 'หมายเลขปลายทางไม่ถูกต้องหรือไม่รองรับบริการนี้ [จำลอง]', now);
        return done({ outcome: 'failed', providerStatus: 'REJECTED', providerTxnId: txnId, message: 'หมายเลขปลายทางไม่ถูกต้องหรือไม่รองรับบริการนี้ [จำลอง]' });
      case 'ok':
        setBalanceSatang(getBalanceSatang() - order.cost);
        record(order.ref, txnId, 'success', 'เติมเงินสำเร็จ [จำลอง]', now);
        return done({ outcome: 'success', providerStatus: 'SUCCESS', providerTxnId: txnId, message: 'เติมเงินสำเร็จ [จำลอง]' });
      case 'timeout':
        // เติมสำเร็จจริงที่ฝั่งผู้ให้บริการ แต่ไม่ได้ตอบกลับ
        setBalanceSatang(getBalanceSatang() - order.cost);
        record(order.ref, txnId, 'success', 'เติมเงินสำเร็จ [จำลอง]', now);
        if (!config.isTest) await sleep(1500);
        return done({ outcome: 'unknown', notSent: false, transport: true, message: 'หมดเวลารอผลจากผู้ให้บริการ (timeout) [จำลอง]' });
      case 'stuck':
        record(order.ref, txnId, 'processing', null, now);
        return done({ outcome: 'processing', providerStatus: 'PENDING', providerTxnId: txnId, message: 'ผู้ให้บริการรับรายการแล้ว [จำลอง]' });
      case 'async_ok':
        setBalanceSatang(getBalanceSatang() - order.cost);
        record(order.ref, txnId, 'success', 'เติมเงินสำเร็จ [จำลอง]', now + delayMs);
        scheduleCallback(order.ref, delayMs + 200);
        return done({ outcome: 'processing', providerStatus: 'PENDING', providerTxnId: txnId, message: 'ผู้ให้บริการรับรายการแล้ว [จำลอง]' });
      case 'async_fail':
      default:
        record(order.ref, txnId, 'failed', 'ผู้ให้บริการแจ้งว่าทำรายการไม่สำเร็จ [จำลอง]', now + delayMs);
        scheduleCallback(order.ref, delayMs + 200);
        return done({ outcome: 'processing', providerStatus: 'PENDING', providerTxnId: txnId, message: 'ผู้ให้บริการรับรายการแล้ว [จำลอง]' });
    }
  }

  async function checkStatus(order) {
    const started = Date.now();
    const t = db.get('SELECT * FROM mock_txns WHERE ref = ?', txKey(order.ref));
    const result = t ? statusOf(t) : { outcome: 'unknown', providerStatus: 'NOT_FOUND', message: 'ไม่พบรายการนี้ที่ผู้ให้บริการ [จำลอง]' };
    logCall({
      provider: NAME, action: 'status', orderRef: order.ref, method: 'POST', url: `${NAME}://status`, request: { ref: order.ref },
      httpStatus: 200, response: JSON.stringify(result), outcome: result.outcome, durationMs: Date.now() - started,
    });
    return result;
  }

  async function getBalance() {
    return { ok: true, balance: getBalanceSatang() };
  }

  function handleCallback({ rawBody, headers }) {
    const expected = hmacSha256(settings.appSecret(), rawBody || '');
    if (!safeEqual(headers['x-mock-signature'], expected)) return { ok: false, status: 401, body: 'invalid signature', error: 'ลายเซ็น callback ไม่ถูกต้อง' };
    let data;
    try { data = JSON.parse(rawBody); } catch { return { ok: false, status: 400, body: 'bad json', error: 'ข้อมูล callback ไม่ใช่ JSON' }; }
    const outcome = ['success', 'failed', 'processing'].includes(data.status) ? data.status : 'unknown';
    return {
      ok: true,
      updates: [{ ref: data.ref, outcome, providerTxnId: data.txn_id, providerStatus: String(data.status).toUpperCase(), message: data.message, trust: 'signed' }],
      response: { status: 200, body: 'OK' },
    };
  }

  return {
    name: NAME,
    label,
    shopName,
    capabilities: { statusCheck: true, balance: true, products: false, callback: true, catalog: 'primary' },
    configStatus: () => ({ ready: true, missing: [] }),
    submit,
    checkStatus,
    getBalance,
    handleCallback,
    // สำหรับแอดมิน: เติมเครดิตจำลอง
    addMockCredit: (satang) => setBalanceSatang(getBalanceSatang() + satang),
  };
}

const mock = createMock('mock', 'โหมดทดสอบ (จำลอง) A', 'ร้านทดสอบ A');
const mock2 = createMock('mock2', 'โหมดทดสอบ (จำลอง) B', 'ร้านทดสอบ B');

module.exports = mock;
module.exports.mock2 = mock2;
module.exports.createMock = createMock;
