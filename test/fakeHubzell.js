'use strict';
/**
 * จำลอง HubZell Gateway ตามคู่มือ (https://shop.hubzell.com/docs) — ใช้ทดสอบเท่านั้น
 *  - ตรวจลายเซ็นจริง (X-Api-Key / X-Timestamp / X-Signature) → ถ้าเราเซ็นผิด จะได้ INVALID_SIGNATURE
 *  - client_ref ห้ามซ้ำ (DUPLICATE_REQUEST), ตัดเครดิต, สถานะ PENDING/SENT/SUCCESS/FAILED
 *  - พฤติกรรมพิเศษตาม 4 หลักท้ายของเบอร์ (ดู SCENARIOS)
 */
const http = require('node:http');
const crypto = require('node:crypto');

const SCENARIOS = {
  '0000': 'failed', // รับรายการแล้ว ผลไม่สำเร็จทันที (HubZell คืนเงินให้เราเอง)
  '7001': 'insufficient', // เครดิตไม่พอ (ไม่สร้างรายการ)
  '7002': 'maintenance', // ปิดปรับปรุง (ไม่สร้างรายการ)
  '7003': 'kyc', // KYC ยังไม่ผ่าน (ไม่สร้างรายการ)
  '7004': 'internal_created', // ตอบ 500 แต่จริงๆ สร้างรายการสำเร็จแล้ว
  '7005': 'timeout_created', // ตอบช้าเกินเวลารอ แต่สร้างรายการสำเร็จแล้ว
  '7006': 'pending_success', // PENDING แล้วสำเร็จภายหลัง
  '7007': 'pending_failed', // PENDING แล้วไม่สำเร็จภายหลัง
  '7008': 'validation', // ข้อมูลไม่ผ่าน (ไม่สร้างรายการ)
  '7009': 'rate_limited', // 429 (ไม่สร้างรายการ)
  '7010': 'hangup_created', // ตัดการเชื่อมต่อกลางทาง แต่สร้างรายการสำเร็จแล้ว
  '7011': 'duplicate', // ตอบ DUPLICATE_REQUEST (เคยรับรายการนี้ไปแล้ว และสำเร็จ)
};

const PRODUCTS = {
  HZ_AIS: {
    category: 'MOBILE_TOPUP', product_name: 'AIS เติมเงิน', currency: 'THB',
    inputs: [{ name: 'mobile', type: 'string', validation: '^0[0-9]{9}$', example: '0812345678' }],
    services: [{ id: 'HZ_AIS_20', price: 19.5, name: 'AIS 20 บาท' }, { id: 'HZ_AIS_50', price: 48.75, name: 'AIS 50 บาท' }, { id: 'HZ_AIS_100', price: 97.5, name: 'AIS 100 บาท' }],
  },
  HZ_TRUE: {
    category: 'MOBILE_TOPUP', product_name: 'TrueMove H เติมเงิน', currency: 'THB',
    inputs: [{ name: 'msisdn', type: 'string', validation: '^66[0-9]{9}$', example: '66812345678' }],
    services: [{ id: 'HZ_TRUE_50', price: 49, name: 'TRUE 50 บาท' }],
  },
  HZ_AIS_NET: {
    category: 'MOBILE_TOPUP', product_name: 'AIS แพ็กเกจเน็ต', currency: 'THB',
    inputs: [{ name: 'mobile', type: 'string', validation: '^0[0-9]{9}$', example: '0812345678' }],
    services: [{ id: 'HZ_AIS_NET_3GB', price: 15, name: 'เน็ต 3GB 1 วัน' }],
  },
  HZ_MULTI: {
    category: 'MOBILE_TOPUP', product_name: 'บริการที่ต้องกรอก 2 ช่อง', currency: 'THB',
    inputs: [{ name: 'mobile', type: 'string', validation: '' }, { name: 'pin', type: 'string', validation: '' }],
    services: [{ id: 'HZ_MULTI_1', price: 10, name: 'บริการ 10 บาท' }],
  },
};

function createFakeHubzell({ apiKey, secret }) {
  const state = {
    balance: 5000,
    orders: new Map(), // client_ref → order
    requests: [], // { method, path, body, code }
    forced: null, // [httpStatus, code] ตอบทุกคำขอแบบนี้ (เช่น จำลอง key ผิด)
    slowMs: 3000, // เวลาตอบของกรณี timeout_created
    products: JSON.parse(JSON.stringify(PRODUCTS)),
    // คำตอบพิเศษของคำขอสร้างรายการครั้งถัดไป (ใช้ทีละรายการ):
    //   { http, body (object | string | fn(reqBody)), create: สร้างรายการจริงด้วยไหม, createStatus, drop: ตัดการเชื่อมต่อ, delayMs }
    createOverrides: [],
    failProducts: new Map(), // product_id → [http, code] ตอบผิดพลาด 1 ครั้ง (จำลองดึงรายละเอียดไม่สำเร็จ)
  };
  let txn = 1000;
  const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest('hex');

  function reply(res, req, httpStatus, code, data = null) {
    const last = state.requests[state.requests.length - 1];
    if (last) last.code = code;
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(httpStatus, { 'Content-Type': 'application/json', 'X-Trace-Id': 'TRC-TEST' });
    res.end(JSON.stringify(code === 'SUCCESS'
      ? { status: 0, code, message: 'success', data }
      : { status: 1, code, message: code, data: null, trace_id: 'TRC-TEST' }));
  }

  const view = (o) => ({
    transaction_id: o.transaction_id, client_ref: o.client_ref, status: o.status, input: o.input, category: 'MOBILE_TOPUP',
    amount: o.amount, currency: 'THB', message: o.status === 'SUCCESS' ? 'Topup successful.' : null,
    failure_reason: o.status === 'FAILED' ? 'หมายเลขปลายทางไม่ถูกต้อง' : null, delivered_content: null,
    created_at: o.created_at, completed_at: ['SUCCESS', 'FAILED'].includes(o.status) ? new Date().toISOString() : null,
  });

  function createOrder(body, status) {
    const o = { transaction_id: String(txn++), client_ref: body.client_ref, status, input: body.input, service_id: body.service_id, amount: body.__price, created_at: new Date().toISOString() };
    state.orders.set(body.client_ref, o);
    if (status !== 'FAILED') state.balance = Math.round((state.balance - body.__price) * 100) / 100;
    return o;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://local');
      state.requests.push({ method: req.method, path: url.pathname, body: raw, code: null });
      const key = req.headers['x-api-key'];
      const ts = req.headers['x-timestamp'];
      const sig = req.headers['x-signature'];
      if (!key || !ts || !sig) return reply(res, req, 401, 'MISSING_CREDENTIALS');
      if (!/^\d+$/.test(ts)) return reply(res, req, 401, 'INVALID_TIMESTAMP_FORMAT');
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return reply(res, req, 401, 'EXPIRED_TIMESTAMP');
      const expected = hmac(secret, `${req.method}\n${url.pathname}\n${ts}\n${raw}`);
      if (key !== apiKey || String(sig).toLowerCase() !== expected) return reply(res, req, 401, 'INVALID_SIGNATURE');
      if (state.forced) return reply(res, req, state.forced[0], state.forced[1]);

      if (req.method === 'GET' && url.pathname === '/api/v1/balance') {
        return reply(res, req, 200, 'SUCCESS', { reseller: 'demo', currency: 'THB', available: state.balance, hold: 0, balances: [{ currency: 'THB', available: state.balance, hold: 0 }] });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/products') {
        if (state.balance <= 0) return reply(res, req, 400, 'INSUFFICIENT_BALANCE');
        const products = Object.entries(state.products).map(([id, p]) => ({ product_id: id, product_name: p.product_name, currency: p.currency }));
        return reply(res, req, 200, 'SUCCESS', { items: [{ category: 'MOBILE_TOPUP', currency: 'THB', products }] });
      }
      const pm = /^\/api\/v1\/products\/([A-Za-z0-9_]+)$/.exec(url.pathname);
      if (req.method === 'GET' && pm) {
        if (state.failProducts.has(pm[1])) {
          const [h, c] = state.failProducts.get(pm[1]);
          state.failProducts.delete(pm[1]);
          return reply(res, req, h, c);
        }
        const p = state.products[pm[1]];
        if (!p) return reply(res, req, 404, 'NOT_FOUND');
        return reply(res, req, 200, 'SUCCESS', { category: p.category, product_id: pm[1], product_name: p.product_name, currency: p.currency, inputs: p.inputs, services: p.services });
      }
      const rm = /^\/api\/v1\/orders\/by-reference\/([A-Za-z0-9]+)$/.exec(url.pathname);
      if (req.method === 'GET' && rm) {
        const o = state.orders.get(rm[1]);
        return o ? reply(res, req, 200, 'SUCCESS', view(o)) : reply(res, req, 404, 'NOT_FOUND');
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/orders/create') {
        let body;
        try { body = JSON.parse(raw); } catch { return reply(res, req, 400, 'VALIDATION_ERROR'); }
        if (!body || typeof body.service_id !== 'string' || !body.input || typeof body.input !== 'object' || !/^[A-Za-z0-9]{1,20}$/.test(String(body.client_ref || ''))) {
          return reply(res, req, 400, 'VALIDATION_ERROR');
        }
        const product = Object.values(state.products).find((p) => p.services.some((s) => s.id === body.service_id));
        const service = product?.services.find((s) => s.id === body.service_id);
        if (!service) return reply(res, req, 404, 'NOT_FOUND');
        for (const inp of product.inputs) {
          const v = body.input[inp.name];
          if (typeof v !== 'string' || (inp.validation && !new RegExp(inp.validation).test(v))) return reply(res, req, 400, 'VALIDATION_ERROR');
        }
        if (Object.keys(body.input).some((k) => !product.inputs.some((i) => i.name === k))) return reply(res, req, 400, 'VALIDATION_ERROR');
        if (state.createOverrides.length) {
          const ov = state.createOverrides.shift();
          if (ov.create && !state.orders.has(body.client_ref)) createOrder({ ...body, __price: service.price }, ov.createStatus || 'SUCCESS');
          const last = state.requests[state.requests.length - 1];
          if (last) last.code = ov.code || 'OVERRIDE';
          if (ov.drop) {
            req.socket.destroy();
            return undefined;
          }
          const send = () => {
            if (res.writableEnded || res.destroyed) return;
            const out = typeof ov.body === 'function' ? ov.body(body) : ov.body;
            res.writeHead(ov.http || 200, { 'Content-Type': typeof out === 'string' ? 'text/html' : 'application/json' });
            res.end(typeof out === 'string' ? out : JSON.stringify(out ?? {}));
          };
          if (ov.delayMs) setTimeout(send, ov.delayMs).unref();
          else send();
          return undefined;
        }
        const phone = String(Object.values(body.input)[0]);
        const scenario = SCENARIOS[phone.slice(-4)] || 'success';
        if (scenario === 'duplicate' && !state.orders.has(body.client_ref)) createOrder({ ...body, __price: service.price }, 'SUCCESS');
        if (state.orders.has(body.client_ref)) return reply(res, req, 409, 'DUPLICATE_REQUEST');
        if (scenario === 'insufficient' || state.balance < service.price) return reply(res, req, 403, 'INSUFFICIENT_BALANCE');
        if (scenario === 'maintenance') return reply(res, req, 503, 'MAINTENANCE_MODE');
        if (scenario === 'kyc') return reply(res, req, 403, 'KYC_NOT_APPROVED');
        if (scenario === 'validation') return reply(res, req, 400, 'VALIDATION_ERROR');
        if (scenario === 'rate_limited') return reply(res, req, 429, 'VALIDATION_ERROR');
        const b = { ...body, __price: service.price };
        if (scenario === 'internal_created') {
          createOrder(b, 'SUCCESS');
          return reply(res, req, 500, 'INTERNAL_ERROR');
        }
        if (scenario === 'hangup_created') {
          createOrder(b, 'SUCCESS');
          req.socket.destroy();
          return undefined;
        }
        const status = scenario === 'failed' ? 'FAILED' : scenario.startsWith('pending') ? 'PENDING' : 'SUCCESS';
        const o = createOrder(b, status);
        const data = { status, transaction_id: o.transaction_id, service_id: body.service_id, input: body.input, client_ref: body.client_ref, currency: 'THB', total_amount: service.price, balance: state.balance };
        if (scenario === 'timeout_created') {
          setTimeout(() => reply(res, req, 200, 'SUCCESS', data), state.slowMs).unref();
          return undefined;
        }
        return reply(res, req, 200, 'SUCCESS', data);
      }
      return reply(res, req, 404, 'NOT_FOUND');
    });
  });

  /** ให้รายการ PENDING จบผล แล้วส่ง callback ไปที่ระบบเรา (ลงลายเซ็นด้วย secret ตามคู่มือ) */
  async function finish(ref, status, callbackUrl, { badSignature = false, staleTs = false } = {}) {
    const o = state.orders.get(ref);
    if (!o) throw new Error(`fake: ไม่มีรายการ ${ref}`);
    o.status = status;
    if (status === 'FAILED') state.balance = Math.round((state.balance + o.amount) * 100) / 100;
    if (!callbackUrl) return null;
    const body = JSON.stringify(view(o));
    const ts = String(Math.floor(Date.now() / 1000) - (staleTs ? 1000 : 0));
    const signature = hmac(badSignature ? 'wrong-secret' : secret, `${ts}\n${body}`);
    const r = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Hubzell-Timestamp': ts, 'X-Hubzell-Signature': signature,
        'X-Hubzell-Event': status === 'SUCCESS' ? 'order.success' : 'order.failed', 'X-Hubzell-Delivery-Id': crypto.randomUUID(),
      },
      body,
    });
    return r.status;
  }

  const createCount = (ref) => state.requests.filter((r) => r.path === '/api/v1/orders/create' && (!ref || r.body.includes(`"client_ref":"${ref}"`))).length;

  return {
    server,
    state,
    finish,
    createCount,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

module.exports = { createFakeHubzell, SCENARIOS };
