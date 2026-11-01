'use strict';
/**
 * จำลอง wePAY (client_api.json.php) — ใช้ทดสอบเท่านั้น
 *  - ตรวจ username + password_hash (MD5) ทุกคำขอ → ผิด = 20001
 *  - dest_ref ห้ามซ้ำ (30016), เงินคืนตามเครือข่าย, สถานะ 1 = กำลังทำ / 2 = สำเร็จ / 4 = ไม่สำเร็จ
 *  - พฤติกรรมพิเศษตาม 4 หลักท้ายของเบอร์ (ดู SCENARIOS)
 */
const http = require('node:http');
const crypto = require('node:crypto');

const SCENARIOS = {
  9001: 'insufficient', // 30019 เครดิตไม่พอ (ไม่สร้างรายการ)
  9002: 'bad_amount', // HTTP 400 + 30018 (ไม่สร้างรายการ)
  9003: 'timeout_created', // ตอบช้าเกินเวลารอ แต่สร้างรายการแล้ว
  9004: 'html_500', // HTTP 500 หน้า HTML (ไม่รู้ผล)
  9005: 'accepted_failed', // รับรายการ แล้วผลสุดท้ายไม่สำเร็จ
  9006: 'duplicate', // ตอบ 30016 (เลขซ้ำ)
  9007: 'no_txn', // 00000 แต่ไม่มี transaction_id
  9008: 'text_error', // ตอบข้อความ ERROR|... (ไม่ใช่ JSON)
  9009: 'ip_blocked', // 20005 IP ยังไม่ลงทะเบียน
};
const CASHBACK = { '12CALL': 0.01, HAPPY: 0.03, TRMV: 0.03 };

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function createFakeWepay({ username, password, slowMs = 1500 }) {
  const state = { requests: [], txns: new Map(), byTxn: new Map(), balance: 5000, seq: 1000, slowMs };

  const send = (res, status, body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let b = null;
      try { b = JSON.parse(raw); } catch { b = null; }
      state.requests.push({ path: req.url, body: b, raw });
      if (req.method !== 'POST' || req.url !== '/client_api.json.php') return send(res, 404, 'not found');
      if (!b || typeof b !== 'object') return send(res, 400, { code: '10001', desc: 'invalid json' });
      if (b.username !== username || b.password_hash !== md5(password)) return send(res, 200, { code: '20001', desc: 'Invalid username or password' });

      if (b.type === 'balance_inquiry') {
        return send(res, 200, { code: '00000', ledger_balance: state.balance.toFixed(2), available_balance: state.balance });
      }

      if (b.type === 'get_output') {
        const t = state.byTxn.get(String(b.transaction_id));
        if (!t) return send(res, 200, { code: '30010', desc: 'transaction not found' });
        return send(res, 200, { code: '00000', output: `dest_ref=${t.ref}&status=${t.status}&operator_trxnsid=${t.operator || ''}` });
      }

      if (b.type === 'mtopup') {
        const phone = String(b.pay_to_ref1 || '');
        const scenario = SCENARIOS[phone.slice(-4)] || 'ok';
        if (scenario === 'ip_blocked') return send(res, 200, { code: '20005', desc: 'IP not allowed' });
        if (!CASHBACK[b.pay_to_company]) return send(res, 200, { code: '30017', desc: 'company not found' });
        if (!b.resp_url || !/^https?:\/\//.test(b.resp_url)) return send(res, 200, { code: '30005', desc: 'invalid resp_url' });
        if (scenario === 'insufficient') return send(res, 200, { code: '30019', desc: 'Insufficient balance' });
        if (scenario === 'bad_amount') return send(res, 400, { code: '30018', desc: 'invalid amount' });
        if (scenario === 'html_500') return send(res, 500, '<html><body>502 Bad Gateway</body></html>');
        if (scenario === 'text_error') return send(res, 200, 'ERROR|system busy');
        if (scenario === 'duplicate' || state.txns.has(b.dest_ref)) return send(res, 200, { code: '30016', desc: 'duplicate dest_ref' });
        if (scenario === 'no_txn') return send(res, 200, { code: '00000' });
        const amount = Number(b.pay_to_amount);
        const total = Math.round(amount * (1 - CASHBACK[b.pay_to_company]) * 100) / 100;
        const txn = String(++state.seq);
        const t = { ref: b.dest_ref, txn, amount, total, status: 1, resp_url: b.resp_url, scenario, phone };
        state.txns.set(b.dest_ref, t);
        state.byTxn.set(txn, t);
        state.balance = Math.round((state.balance - total) * 100) / 100;
        const body = { code: '00000', bill_id: `B${txn}`, transaction_id: txn, queue_id: `Q${txn}`, total_amount: total };
        if (scenario === 'timeout_created') {
          setTimeout(() => send(res, 200, body), state.slowMs).unref();
          return undefined;
        }
        return send(res, 200, body);
      }
      return send(res, 200, { code: '10002', desc: 'unknown type' });
    });
  });

  /** ให้รายการจบผล (2 = สำเร็จ / 4 = ไม่สำเร็จ) แล้วส่ง callback ไปตาม resp_url (แบบฟอร์ม) */
  async function finish(ref, status, { url, sendCallback = true, txnOverride } = {}) {
    const t = state.txns.get(ref);
    if (!t) throw new Error(`fake: ไม่มีรายการ ${ref}`);
    t.status = status;
    t.operator = status === 2 ? `OP${t.txn}` : '';
    if (status === 4) state.balance = Math.round((state.balance + t.total) * 100) / 100;
    if (!sendCallback) return null;
    const form = new URLSearchParams({
      dest_ref: ref, transaction_id: txnOverride || t.txn, status: String(status), sms: status === 2 ? 'เติมเงินสำเร็จ' : 'ทำรายการไม่สำเร็จ', operator_trxnsid: t.operator,
    });
    const r = await fetch(url || t.resp_url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    return { status: r.status, text: await r.text() };
  }

  const submits = (ref) => state.requests.filter((r) => r.body?.type === 'mtopup' && (!ref || r.body.dest_ref === ref)).length;

  return {
    server,
    state,
    finish,
    submits,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

module.exports = { createFakeWepay, SCENARIOS };
