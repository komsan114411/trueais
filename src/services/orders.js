'use strict';
/**
 * หัวใจของระบบ: สร้างรายการ → ตัดเงิน → ส่งผู้ให้บริการ → รับผล → คืนเงินถ้าไม่สำเร็จ
 *
 *   pending ──ส่ง──▶ processing ──▶ success ──(แอดมินคืนเงิน)──▶ refunded
 *      │                  │
 *      └──────────────────┴──▶ failed (คืนเงินอัตโนมัติ ครั้งเดียว)
 *
 * กฎกันความผิดพลาด
 *   1. ตัดเงินใน transaction เดียวกับการสร้างรายการ — ไม่มีรายการไหนถูกส่งโดยยังไม่ตัดเงิน
 *   2. เปลี่ยนเป็น processing "ก่อน" ส่งเสมอ → pending = ยังไม่เคยส่งแน่นอน (กู้คืนได้ปลอดภัยหลังเครื่องดับ)
 *   3. ไม่รู้ผล (เช่น timeout หลังส่ง) → ห้ามคืนเงิน ห้ามส่งซ้ำ → เช็กสถานะอัตโนมัติ แล้วส่งให้แอดมินตรวจ
 *   4. คืนเงินได้ครั้งเดียวต่อรายการ (unique index ในสมุดบัญชี)
 *   5. ผลที่ขัดกับสถานะสุดท้าย (เช่น คืนเงินแล้วแต่ภายหลังแจ้งว่าสำเร็จ) → แจ้งแอดมินทันที ไม่ขยับเงินเอง
 *   6. Idempotency key กันกดซ้ำ/เน็ตหลุดแล้วส่งใหม่ + กันเบอร์เดียวกันยอดเดียวกันในเวลาใกล้กัน
 */
const config = require('../config');
const db = require('../db');
const { E, AppError } = require('../lib/errors');
const { normalizePhone, formatPhone } = require('../lib/phone');
const { parseBaht, fmt } = require('../lib/money');
const { orderRef, randomCode } = require('../lib/security');
const { bangkokDayStart, bangkokDateRange, addSeconds } = require('../lib/time');
const { alertAdmin } = require('../lib/notify');
const logger = require('../lib/logger');
const settings = require('./settings');
const catalog = require('./catalog');
const wallet = require('./wallet');
const breaker = require('./breaker');
const webhooks = require('./webhooks');
const audit = require('./audit');
const providers = require('../providers');
const router = require('./router');
const shops = require('./shops');
const { customerMessage, customerEventMessage } = require('./orderText');

const STATUS_LABELS = {
  pending: 'รอดำเนินการ',
  processing: 'กำลังดำเนินการ',
  success: 'สำเร็จ',
  failed: 'ไม่สำเร็จ (คืนเงินแล้ว)',
  refunded: 'คืนเงินแล้ว',
};
const SOURCE_LABELS = {
  system: 'ระบบ',
  submit: 'ผู้ให้บริการ',
  callback: 'ผู้ให้บริการแจ้งผล',
  status: 'ตรวจสอบสถานะอัตโนมัติ',
  'admin-check': 'เจ้าหน้าที่ตรวจสอบสถานะ',
  admin: 'เจ้าหน้าที่',
  worker: 'ระบบอัตโนมัติ',
};
const FINAL = new Set(['success', 'failed', 'refunded']);
const ATTEMPT_LABELS = {
  sending: 'กำลังส่ง',
  accepted: 'รับรายการแล้ว รอผล',
  rejected: 'ปฏิเสธ (ไม่ได้ทำรายการ) → ส่งต่อเจ้าอื่น',
  unknown: 'ยังไม่ทราบผล',
  success: 'สำเร็จ',
  failed: 'ไม่สำเร็จ',
};
const ACTIVE = "('pending','processing','success')";
const CHECK_SCHEDULE_SEC = [10, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];
const MAX_AUTO_CHECK_MS = 48 * 3600 * 1000;
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

let enqueue = () => {};
const setEnqueue = (fn) => { enqueue = fn; };

function addEvent(orderId, status, source, message, data = null) {
  db.run(
    'INSERT INTO order_events (order_id, status, source, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    orderId, status, source, String(message).slice(0, 500), data ? JSON.stringify(data).slice(0, 2000) : null, db.nowIso(),
  );
}

// ───────────────────────── ตรวจสอบก่อนสร้างรายการ ─────────────────────────

function assertSystemOpen() {
  const s = settings.all();
  if (s.maintenance_mode) throw E.maintenance(s.maintenance_message);
}

/**
 * เลือกผู้ให้บริการสำหรับรายการนี้ก่อนตัดเงิน — ถ้าไม่มีเจ้าไหนทำได้ ปฏิเสธพร้อมเหตุผล (ไม่ตัดเงิน)
 * (เจ้าที่ใช้จริงอาจเปลี่ยนตอนส่ง ถ้าเจ้าแรกไม่พร้อม — ดู dispatch)
 */
function planRoute(it) {
  const r = router.plan({ type: it.type, network: it.network, faceValue: it.faceValue, price: it.price, product: it.product || null, shop: it.shop || null });
  if (r.pick) return r.pick;
  if (r.reason === 'NOT_READY') throw new AppError('PROVIDER_NOT_READY', 'ระบบเติมเงินยังไม่พร้อมให้บริการ (ผู้ดูแลกำลังตั้งค่า) — ยังไม่ได้ตัดเงิน', 503);
  if (r.reason === 'PAUSED') throw E.providerUnavailable();
  throw new AppError('NO_PROVIDER', it.type === 'topup'
    ? `ยอด ${fmt(it.faceValue)} บาท ของ ${it.network.name} ยังเติมไม่ได้ในขณะนี้ กรุณาเลือกยอดอื่น — ยังไม่ได้ตัดเงิน`
    : 'แพ็กเกจนี้ยังสมัครไม่ได้ในขณะนี้ กรุณาเลือกแพ็กเกจอื่น — ยังไม่ได้ตัดเงิน', 503, { field: it.type === 'topup' ? 'amount' : 'productId' });
}

function assertNetworkOpen(net, type) {
  const open = net.enabled && (type === 'topup' ? net.topup_enabled : net.package_enabled);
  if (!open) {
    throw new AppError('NETWORK_CLOSED', net.notice || `${net.name} ปิดให้บริการ${type === 'topup' ? 'เติมเงิน' : 'สมัครแพ็กเกจ'}ชั่วคราว`, 503);
  }
}

function normalizeKey(k) {
  if (k === undefined || k === null || k === '') return null;
  const s = String(k).trim();
  if (!/^[A-Za-z0-9_\-:.]{8,100}$/.test(s)) {
    throw E.validation('รหัสอ้างอิง (idempotencyKey/reference) ใช้ได้เฉพาะ A-Z a-z 0-9 _ - : . ยาว 8-100 ตัว', { field: 'idempotencyKey' });
  }
  return s;
}

/** ตรวจข้อมูล 1 รายการ แล้วคืนราคา/ต้นทุน (ยังไม่แตะเงิน) */
const SCALAR_FIELDS = ['phone', 'network', 'amount', 'productId', 'productCode', 'shop'];
const isScalar = (v) => v === undefined || v === null || typeof v === 'string' || typeof v === 'number';

function prepareItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw E.validation('ข้อมูลรายการไม่ถูกต้อง');
  const type = typeof input.type === 'string' ? input.type.trim().toLowerCase() : input.type;
  if (type !== 'topup' && type !== 'package') throw E.validation('กรุณาเลือกประเภทรายการ (topup = เติมเงิน หรือ package = แพ็กเกจ)', { field: 'type' });
  // ค่าต้องเป็นข้อความ/ตัวเลขเท่านั้น (กันส่ง array / object / true มาหลอกระบบ)
  for (const f of SCALAR_FIELDS) if (!isScalar(input[f])) throw E.validation('ข้อมูลรายการไม่ถูกต้อง', { field: f });
  if (input.productId !== undefined && input.productId !== null && input.productId !== '' && !/^\d{1,12}$/.test(String(input.productId))) {
    throw new AppError('PRODUCT_NOT_FOUND', 'ไม่พบแพ็กเกจที่เลือก', 404, { field: 'productId' });
  }
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError('INVALID_PHONE', 'เบอร์โทรศัพท์ไม่ถูกต้อง ต้องเป็นเบอร์มือถือ 10 หลัก ขึ้นต้นด้วย 06, 08 หรือ 09', 400, { field: 'phone' });

  // ร้านที่ลูกค้าเลือก (null = ให้ระบบเลือก) — ราคาเป็นของร้านนั้น
  const shop = shops.resolve(input.shop);

  if (type === 'topup') {
    const net = catalog.getNetwork(input.network);
    if (!net) throw E.validation('กรุณาเลือกเครือข่าย', { field: 'network' });
    assertNetworkOpen(net, 'topup');
    const face = parseBaht(input.amount);
    const mapped = shop && providers.byName(shop).capabilities.catalog === 'mapped';
    const q = catalog.quoteTopup(net, face, { discountBp: shops.discountBp(shop, net), skipPresets: mapped });
    const blocked = shop ? shops.topupBlocked(shop, net, face) : null;
    if (blocked) throw new AppError('AMOUNT_NOT_AT_SHOP', blocked, 400, { field: 'amount' });
    return { type, phone, network: net, shop, ...q };
  }

  let product = null;
  if (input.productId !== undefined && input.productId !== null && input.productId !== '') product = catalog.getProduct(Number(input.productId));
  else if (input.productCode) {
    if (!input.network) throw E.validation('สั่งแพ็กเกจด้วยรหัสสินค้า ต้องระบุเครือข่าย (network) ด้วย', { field: 'network' });
    product = catalog.getProductByCode(String(input.network).toUpperCase(), String(input.productCode).trim());
  }
  if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'ไม่พบแพ็กเกจที่เลือก', 404, { field: 'productId' });
  if (input.network && String(input.network).toUpperCase() !== product.network_code) {
    throw E.validation('แพ็กเกจนี้ไม่ใช่ของเครือข่ายที่เลือก', { field: 'network' });
  }
  const net = catalog.getNetwork(product.network_code);
  assertNetworkOpen(net, 'package');
  // ต้นทุนสูงกว่าราคาขาย (เช่น ผู้ให้บริการขึ้นราคา) → ไม่ขาย กันขาดทุน
  if (!product.enabled || product.cost > product.price) throw new AppError('PRODUCT_DISABLED', 'แพ็กเกจนี้ปิดการขายชั่วคราว', 400, { field: 'productId' });
  if (product.is_demo && providers.isLive()) {
    throw new AppError('PRODUCT_DEMO', 'แพ็กเกจนี้เป็นข้อมูลตัวอย่าง ยังเปิดขายจริงไม่ได้', 400, { field: 'productId' });
  }
  if (shop && !shops.sellsPackage(shop, product)) {
    throw new AppError('PRODUCT_NOT_AT_SHOP', `${shops.displayName(shop)} ไม่มีแพ็กเกจนี้ — กรุณาเลือกร้านอื่น`, 400, { field: 'productId' });
  }
  return { type, phone, network: net, product, shop, ...catalog.quotePackage(product, net) };
}

/** ตรวจราคาที่ลูกค้าเห็นตอนยืนยัน (expectedPrice) — ถ้าราคาเปลี่ยนระหว่างนั้น ไม่ตัดเงิน ให้ลูกค้ายืนยันใหม่ */
function prepareChecked(input) {
  const it = prepareItem(input);
  it.route = planRoute(it);
  const exp = input?.expectedPrice;
  if (exp !== undefined && exp !== null && exp !== '') {
    const n = Number(exp);
    if (!Number.isSafeInteger(n) || n !== it.price) {
      throw new AppError('PRICE_CHANGED', `ราคาเปลี่ยนเป็น ${fmt(it.price)} บาท กรุณาตรวจสอบแล้วยืนยันอีกครั้ง (ยังไม่ได้ตัดเงิน)`, 409, { price: it.price, expected: Number.isFinite(n) ? n : null, field: 'price' });
    }
  }
  return it;
}

/** คำขอเดิม (รหัสอ้างอิงเดิม + ข้อมูลเดิม) หรือไม่ — ใช้คืนรายการเดิมโดยไม่ต้องตรวจเงื่อนไขอื่นซ้ำ */
function sameRequest(ex, input) {
  if (!input || String(input.type || '').trim().toLowerCase() !== ex.type) return false;
  if (normalizePhone(input.phone) !== ex.phone) return false;
  const s0 = typeof input.shop === 'string' ? input.shop.trim().toLowerCase() : '';
  const shop = s0 && s0 !== 'auto' ? s0 : null;
  if (shop !== (ex.shop || null)) return false;
  if (input.network && String(input.network).toUpperCase() !== ex.network_code) return false;
  if (ex.type === 'topup') {
    try { return parseBaht(input.amount) === ex.face_value; } catch { return false; }
  }
  if (input.productId !== undefined && input.productId !== null && input.productId !== '') return Number(input.productId) === ex.product_id;
  if (input.productCode) return String(input.productCode) === ex.product_code;
  return false;
}

/**
 * ส่งคำขอเดิมซ้ำ (เน็ตหลุด/กดซ้ำ) → คืนรายการเดิมทันที
 * ทำก่อนตรวจอย่างอื่น เพื่อให้ได้ผลเดิมแม้ตอนนี้ระบบปิดปรับปรุง หรือสินค้าถูกปิดขายไปแล้ว
 */
// รหัสอ้างอิงแยกกันตาม API key (ร้านค้า 2 เว็บของเจ้าของเดียวกันใช้เลขซ้ำกันได้) — หน้าเว็บ/เติมหลายรายการ = 0
const findByKey = (userId, apiKeyId, k) => db.get(
  'SELECT * FROM orders WHERE user_id = ? AND COALESCE(api_key_id, 0) = ? AND idempotency_key = ?', userId, Number(apiKeyId) || 0, k,
);

function findExisting(user, inputs, ctx = {}) {
  const out = [];
  for (const input of inputs) {
    let k;
    try { k = normalizeKey(input?.idempotencyKey); } catch { return null; }
    if (!k) return null;
    const ex = findByKey(user.id, ctx.apiKeyId, k);
    if (!ex || !sameRequest(ex, input)) return null;
    out.push({ order: ex, existing: true });
  }
  return out;
}

function duplicateError(it, dup) {
  const what = it.type === 'topup' ? `เติมเงิน ${fmt(it.faceValue)} บาท` : it.productName;
  if (!dup) {
    return E.conflict('DUPLICATE_IN_BATCH', `เบอร์ ${formatPhone(it.phone)} (${what}) ซ้ำกันในรายการที่ส่ง`, { index: it.index, phone: it.phone });
  }
  const ago = Math.max(1, Math.round((Date.now() - Date.parse(dup.created_at)) / 1000));
  if (dup.status === 'pending' || dup.status === 'processing') {
    return E.conflict(
      'DUPLICATE_RECENT',
      `เบอร์ ${formatPhone(it.phone)} มีรายการ ${what} ที่ยังรอผลอยู่ (เลขที่ ${dup.ref}) — ถ้าทำซ้ำตอนนี้ อาจได้รับ 2 ครั้งเมื่อรายการเดิมสำเร็จ หากต้องการทำซ้ำจริง กรุณากดยืนยันอีกครั้ง`,
      { index: it.index, ref: dup.ref, phone: it.phone, secondsAgo: ago, waiting: true },
    );
  }
  return E.conflict(
    'DUPLICATE_RECENT',
    `เบอร์ ${formatPhone(it.phone)} เพิ่งทำรายการ ${what} ไปเมื่อ ${ago} วินาทีที่แล้ว (เลขที่ ${dup.ref}) หากต้องการทำซ้ำจริง กรุณากดยืนยันอีกครั้ง`,
    { index: it.index, ref: dup.ref, phone: it.phone, secondsAgo: ago },
  );
}

function newRef() {
  for (let i = 0; i < 10; i++) {
    const ref = orderRef(config.orderRefPrefix);
    if (!db.get('SELECT 1 AS x FROM orders WHERE ref = ?', ref)) return ref;
  }
  throw new Error('สร้างเลขที่รายการไม่สำเร็จ');
}

// ───────────────────────── สร้างรายการ ─────────────────────────

/**
 * สร้างรายการ (1 หรือหลายรายการ) แบบ all-or-nothing
 * @returns {Array<{order, existing:boolean}>} existing = เคยสร้างแล้วด้วย idempotency key เดิม (ไม่ตัดเงินซ้ำ)
 */
function createOrders(user, inputs, ctx = {}) {
  if (!user || user.status !== 'active') throw E.forbidden('บัญชีถูกระงับการใช้งาน');
  if (!Array.isArray(inputs) || !inputs.length) throw E.validation('ไม่มีรายการที่จะทำ');
  const source = ctx.source || 'web';
  const s = settings.all();
  if (source === 'bulk' && inputs.length > s.max_bulk_items) throw E.validation(`เติมหลายรายการได้สูงสุด ${s.max_bulk_items} เบอร์ต่อครั้ง`);
  if (source !== 'bulk' && inputs.length > 1) throw E.validation('ทำได้ครั้งละ 1 รายการ');

  const again = findExisting(user, inputs, ctx);
  if (again) return again;
  assertSystemOpen();

  // 1) ตรวจทุกรายการก่อน — ถ้ามีรายการผิดแม้แต่รายการเดียว จะไม่ตัดเงินเลย
  const items = [];
  if (inputs.length === 1) {
    items.push({ ...prepareChecked(inputs[0]), key: normalizeKey(inputs[0].idempotencyKey), confirmDuplicate: Boolean(inputs[0].confirmDuplicate), index: 0 });
  } else {
    const errors = [];
    inputs.forEach((input, index) => {
      try {
        items.push({ ...prepareChecked(input), key: normalizeKey(input.idempotencyKey), confirmDuplicate: Boolean(input.confirmDuplicate), index });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        errors.push({ index, code: err.code, message: err.message, field: err.details?.field });
      }
    });
    if (errors.length) throw E.validation(`มีข้อมูลไม่ถูกต้อง ${errors.length} รายการ กรุณาแก้ไขก่อน (ยังไม่ได้ตัดเงิน)`, { errors });
  }

  const batchId = source === 'bulk' ? `B${randomCode(9)}` : null;
  const now = Date.now();
  const results = db.tx(() => {
    const out = [];
    const fresh = [];

    // 2) idempotency — คีย์เดิม = คืนรายการเดิม ไม่ตัดเงินซ้ำ
    for (const it of items) {
      if (it.key) {
        const ex = findByKey(user.id, ctx.apiKeyId, it.key);
        if (ex) {
          const same = ex.phone === it.phone && ex.type === it.type && ex.network_code === it.network.code
            && ex.face_value === it.faceValue && (ex.product_id || null) === (it.productId || null) && (ex.shop || null) === (it.shop || null);
          if (!same) throw E.conflict('IDEMPOTENCY_MISMATCH', 'รหัสอ้างอิงนี้ถูกใช้กับรายการอื่นไปแล้ว', { index: it.index, ref: ex.ref });
          out[it.index] = { order: ex, existing: true };
          continue;
        }
      }
      fresh.push(it);
    }
    if (!fresh.length) return out;

    // 3) จำกัดความถี่ — หน้าเว็บ + เติมหลายรายการนับรวมกัน (API ร้านค้ามีโควตาแยก)
    //    เติมหลายรายการ 1 ชุดเต็มจำนวนสูงสุดได้เสมอ แต่ส่งชุดใหม่รัวๆ เพื่อเลี่ยงการจำกัดไม่ได้
    const since = new Date(now - 60000).toISOString();
    if (source === 'api') {
      const recent = db.get("SELECT COUNT(*) AS c FROM orders WHERE user_id = ? AND source = 'api' AND created_at >= ?", user.id, since).c;
      if (recent + fresh.length > s.api_rate_per_min) throw E.rateLimited(60);
    } else {
      const recent = db.get("SELECT COUNT(*) AS c FROM orders WHERE user_id = ? AND source != 'api' AND created_at >= ?", user.id, since).c;
      const cap = source === 'bulk' ? Math.max(s.order_rate_per_min, s.max_bulk_items) : s.order_rate_per_min;
      if (recent + fresh.length > cap) throw E.rateLimited(60);
    }

    // 4) วงเงินต่อวัน
    const adding = fresh.reduce((sum, it) => sum + it.price, 0);
    assertDailyLimit(user, adding, s);

    // 5) กันทำรายการซ้ำ (เบอร์ + ยอด/แพ็กเกจเดียวกัน ในเวลาใกล้กัน หรือรายการเดิมยังรอผลอยู่)
    //    รวบรวม "ทุก" รายการที่อาจซ้ำ แล้วแจ้งพร้อมกัน — ลูกค้าเห็นครบก่อนกดยืนยัน (ไม่ใช่เห็นแค่รายการแรก)
    {
      const since = new Date(now - Math.max(0, s.duplicate_window_sec) * 1000).toISOString();
      const seen = new Set();
      const dups = [];
      for (const it of fresh) {
        const sig = `${it.phone}|${it.type}|${it.productId || it.faceValue}`;
        const inBatch = seen.has(sig);
        seen.add(sig);
        if (it.confirmDuplicate) continue;
        if (inBatch) { dups.push({ it, dup: null }); continue; }
        const dup = findDuplicate(user.id, it, since);
        if (dup) dups.push({ it, dup });
      }
      if (dups.length) {
        const first = duplicateError(dups[0].it, dups[0].dup);
        const duplicates = dups.map((d) => ({ index: d.it.index, phone: d.it.phone, ref: d.dup?.ref || null, in_batch: !d.dup }));
        if (dups.length === 1) {
          first.details = { ...first.details, duplicates };
          throw first;
        }
        throw E.conflict(first.code, `พบรายการที่อาจซ้ำ ${dups.length} รายการ เช่น ${first.message}`, { ...first.details, duplicates });
      }
    }

    // 6) ยอดเงินพอไหม (เช็กรวมก่อน เพื่อแจ้งยอดที่ต้องใช้ได้ชัดเจน)
    const { balance } = db.get('SELECT balance FROM users WHERE id = ?', user.id);
    if (balance < adding) throw E.insufficientBalance(adding, balance);

    // 7) สร้างรายการ + ตัดเงิน
    const nowIso = new Date(now).toISOString();
    for (const it of fresh) {
      const r = db.run(
        `INSERT INTO orders (ref, user_id, source, batch_id, type, network_code, product_id, product_code, product_name, phone,
           face_value, price, cost, status, provider, shop, idempotency_key, callback_url, api_key_id, ip, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        // product_code = รหัสสินค้าของเรา (ร้านค้าใช้อ้างอิง/ส่งซ้ำ) — รหัสของผู้ให้บริการแต่ละเจ้าอยู่ใน order_attempts.code
        newRef(), user.id, source, batchId, it.type, it.network.code, it.productId, it.productCode || null, it.productName, it.phone,
        it.faceValue, it.price, it.route.cost, it.route.name, it.shop || null, it.key, ctx.callbackUrl || null, ctx.apiKeyId || null, ctx.ip || null, nowIso, nowIso,
      );
      const id = Number(r.lastInsertRowid);
      wallet.debit(user.id, it.price, { type: 'order', refType: 'order', refId: id, note: `${it.productName} → ${formatPhone(it.phone)}` });
      addEvent(id, 'pending', 'system', `สร้างรายการและตัดเงิน ${fmt(it.price)} บาท`);
      out[it.index] = { order: db.get('SELECT * FROM orders WHERE id = ?', id), existing: false };
    }
    return out;
  });

  for (const r of results) if (r && !r.existing) enqueue(r.order.id);
  return results;
}

const createOrder = (user, input, ctx) => createOrders(user, [input], ctx)[0];

/**
 * รายการเดิมที่อาจซ้ำ: เบอร์ + ยอด/แพ็กเกจเดียวกัน ที่ทำภายในช่วงเวลาที่ตั้งไว้ (สำเร็จ/รอผล)
 * หรือรายการที่ "ยังรอผลอยู่" ไม่ว่าจะนานแค่ไหน (ทำซ้ำตอนนี้ = เสี่ยงได้ 2 ครั้งเมื่อรายการเดิมสำเร็จ)
 */
function findDuplicate(userId, it, since) {
  const recent = `(status IN ('pending','processing') OR (status = 'success' AND created_at >= ?))`;
  return it.productId
    ? db.get(`SELECT ref, created_at, status FROM orders WHERE user_id = ? AND phone = ? AND type = 'package' AND product_id = ? AND ${recent} ORDER BY id DESC LIMIT 1`, userId, it.phone, it.productId, since)
    : db.get(`SELECT ref, created_at, status FROM orders WHERE user_id = ? AND phone = ? AND type = 'topup' AND face_value = ? AND ${recent} ORDER BY id DESC LIMIT 1`, userId, it.phone, it.faceValue, since);
}

/** วงเงินต่อวัน (ใช้ทั้งตอนขอราคาและตอนสั่ง — ลูกค้ารู้ตั้งแต่หน้ายืนยัน) */
function assertDailyLimit(user, adding, s = settings.all()) {
  const limit = user.daily_limit !== null && user.daily_limit !== undefined ? user.daily_limit : Math.round(s.daily_limit_baht * 100);
  if (!(limit > 0)) return;
  const used = db.get(`SELECT COALESCE(SUM(price), 0) AS s FROM orders WHERE user_id = ? AND status IN ${ACTIVE} AND created_at >= ?`, user.id, bangkokDayStart()).s;
  if (used + adding > limit) {
    throw new AppError('DAILY_LIMIT', `เกินวงเงินต่อวัน ${fmt(limit)} บาท (วันนี้ใช้ไปแล้ว ${fmt(used)} บาท)`, 403, { limit, used });
  }
}

/** ขอราคาก่อนยืนยัน (ไม่แตะเงิน) + เตือนล่วงหน้าถ้าเพิ่งทำรายการเดียวกัน / รายการเดิมยังรอผล */
function quote(user, input) {
  assertSystemOpen();
  const it = prepareItem(input);
  planRoute(it); // แจ้งตั้งแต่หน้ายืนยันถ้ายังไม่มีผู้ให้บริการที่ทำรายการนี้ได้
  const s = settings.all();
  assertDailyLimit(db.get('SELECT * FROM users WHERE id = ?', user.id) || user, it.price, s);
  let warning = null;
  const dup = findDuplicate(user.id, it, new Date(Date.now() - Math.max(0, s.duplicate_window_sec) * 1000).toISOString());
  if (dup) {
    const err = duplicateError({ ...it, index: 0 }, dup);
    warning = { code: err.code, message: err.message, ref: dup.ref, waiting: Boolean(err.details?.waiting) };
  }
  const balance = db.get('SELECT balance FROM users WHERE id = ?', user.id).balance;
  return {
    type: it.type,
    shop: it.shop || null,
    shop_name: it.shop ? shops.displayName(it.shop) : null,
    network: it.network.code,
    network_name: it.network.name,
    phone: it.phone,
    product_id: it.productId,
    product_name: it.productName,
    face_value: it.faceValue,
    price: it.price,
    discount: it.faceValue - it.price,
    balance,
    enough_balance: balance >= it.price,
    warning,
  };
}

// ───────────────────────── ส่งไปผู้ให้บริการ ─────────────────────────

/** ผู้ให้บริการที่ "ปฏิเสธรายการนี้แน่นอน" แล้ว (ห้ามส่งซ้ำไปเจ้านั้นอีก) */
const rejectedBy = (orderId) => db.all("SELECT DISTINCT provider FROM order_attempts WHERE order_id = ? AND state = 'rejected'", orderId).map((r) => r.provider);

/**
 * ส่งรายการไปผู้ให้บริการ (เลือกเจ้าตอนส่งจริง + สลับเจ้าอัตโนมัติ)
 *
 * กฎกันเติมซ้ำ 2 เจ้า:
 *   - ส่งต่อเจ้าถัดไปได้ "เฉพาะ" เมื่อเจ้าก่อนหน้ายืนยันได้ว่าไม่ได้ทำรายการ
 *     (ต่อไม่ติด = notSent หรือปฏิเสธก่อนสร้างรายการ = retryable) — ถ้าไม่รู้ผล (เช่น หมดเวลารอ) ห้ามส่งเจ้าอื่นเด็ดขาด
 *   - ทุกครั้งที่ส่งมีบันทึกใน order_attempts (เจ้าไหน ครั้งที่เท่าไร ผลอะไร)
 *   - จองสิทธิ์ (pending → processing) ก่อนส่งทุกครั้ง: pending = ไม่มีผู้ให้บริการเจ้าไหนกำลังทำรายการนี้อยู่
 */
async function dispatch(orderId) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order || order.status !== 'pending') return;

  const tried = rejectedBy(order.id);
  const item = router.itemFromOrder(order);
  const pick = router.candidates(item, { exclude: tried })[0];
  if (!pick) {
    // มีเจ้าที่ทำได้แต่ถูกพักชั่วคราว → รอ (งานกู้คืนจะลองใหม่ หรือคืนเงินเมื่อค้างเกิน 10 นาที)
    if (router.candidates(item, { exclude: tried, ignoreBreaker: true }).length) return;
    failPending(order.id, tried.length
      ? `ผู้ให้บริการทุกเจ้าไม่รับรายการนี้ (${tried.map((n) => shops.displayName(n)).join(', ')})`
      : 'ไม่มีผู้ให้บริการที่ทำรายการนี้ได้ในขณะนี้');
    return;
  }

  // จองสิทธิ์ส่ง + บันทึกครั้งที่ส่ง (ใน transaction เดียวกัน)
  // เช็กสถานะครั้งแรกหลังหมดเวลารอคำตอบ — ไม่เช็กซ้อนระหว่างที่คำขอส่งยังไม่จบ
  const now = db.nowIso();
  const attemptNo = order.attempts + 1;
  const firstCheck = addSeconds(Math.ceil(config.provider.timeoutMs / 1000) + CHECK_SCHEDULE_SEC[0]);
  let claimed = false;
  db.tx(() => {
    const r = db.run(
      `UPDATE orders SET status = 'processing', provider = ?, cost = ?, attempts = ?, submitted_at = ?, next_check_at = ?, check_attempts = 0, updated_at = ?
       WHERE id = ? AND status = 'pending' AND attempts = ?`,
      pick.name, pick.cost, attemptNo, now, firstCheck, now, order.id, order.attempts,
    );
    if (r.changes !== 1) return;
    db.run(
      `INSERT INTO order_attempts (order_id, provider, attempt_no, code, cost, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)`,
      order.id, pick.name, attemptNo, pick.code, pick.cost, now, now,
    );
    addEvent(order.id, 'processing', 'system', attemptNo === 1 ? 'ส่งคำขอไปยังผู้ให้บริการ' : 'ส่งคำขอไปยังผู้ให้บริการสำรอง');
    addEvent(order.id, 'processing', 'system', `ส่งไป ${pick.provider.label} (ครั้งที่ ${attemptNo}) ต้นทุน ${fmt(pick.cost)} บาท`, { internal: true, provider: pick.name });
    claimed = true;
  });
  if (!claimed) return;

  inFlight.add(orderId);
  try {
    let result;
    try {
      result = await pick.provider.submit({
        ...order, status: 'processing', provider: pick.name, cost: pick.cost, product_code: pick.code,
        provider_topup_code: pick.code, submitted_at: now, attempts: attemptNo, route: pick,
      });
    } catch (err) {
      logger.error(`ส่งรายการ ${order.ref} ไป ${pick.name} ผิดพลาด`, err);
      result = { outcome: 'unknown', message: `เกิดข้อผิดพลาดระหว่างส่ง: ${err.message}` };
    }
    breaker.record(pick.name, result);
    recordActualCost(order, attemptNo, pick, result);
    if (result.outcome === 'unknown' && result.notSent) {
      // มั่นใจว่าคำขอไม่ถึงผู้ให้บริการ → ไม่ได้ทำรายการแน่นอน
      result = { ...result, outcome: 'failed', retryable: true, message: result.message || 'ส่งคำขอไม่ถึงผู้ให้บริการ' };
    }
    if (result.outcome === 'failed' && result.retryable) {
      const r = reroute(order.id, attemptNo, pick, result);
      if (r === 'rerouted') {
        // ส่งต่อเจ้าถัดไปทันทีในรอบเดียวกัน (หรือคืนเงินถ้าไม่มีเจ้าไหนทำได้)
        // — ไม่ใส่คิวใหม่ เพราะคิวกันรายการซ้ำที่กำลังทำอยู่ จะทำให้รายการค้าง; จำนวนรอบมีจำกัดเพราะเจ้าที่ปฏิเสธถูกตัดออกทุกครั้ง
        await dispatch(order.id);
        return;
      }
      if (r === 'conflict') {
        // ระหว่างรอคำตอบ มีผลอื่นของเจ้านี้เข้ามาแล้ว (เช่น แจ้งว่ารับรายการ) แต่คำตอบตอนส่งบอกว่าปฏิเสธ → ห้ามคืนเงินเอง
        result = {
          ...result,
          outcome: 'unknown',
          review: `${pick.provider.label} ตอบตอนส่งว่าไม่รับรายการ แต่มีผลอื่นของรายการนี้เข้ามาก่อน — ผลขัดแย้ง กรุณาตรวจกับผู้ให้บริการ`,
        };
      }
    }
    applyResult(orderId, result, 'submit', { provider: pick.name });
  } finally {
    inFlight.delete(orderId);
  }
}

/**
 * เจ้าที่เลือกปฏิเสธรายการ (ยืนยันได้ว่ายังไม่ได้ทำรายการ) → บันทึกว่าเจ้านี้ปฏิเสธ แล้วคืนรายการกลับเป็น pending ให้เลือกเจ้าใหม่
 * ทำเฉพาะเมื่อเปิด "สลับอัตโนมัติ" และสถานะยังเป็นของครั้งนี้จริง (ไม่มีผลอื่นแทรกเข้ามาระหว่างรอ)
 * คืน 'rerouted' = ส่งต่อได้, 'no-failover' = ปิดสลับอัตโนมัติ (สรุปว่าไม่สำเร็จ), 'conflict' = มีผลอื่นเข้ามาก่อน (ห้ามสรุปเอง)
 */
function reroute(orderId, attemptNo, pick, result) {
  let ok = 'no-failover';
  db.tx(() => {
    const now = db.nowIso();
    // เปลี่ยนเป็น "ปฏิเสธ" ได้เฉพาะครั้งที่ยังรอคำตอบอยู่จริง — ถ้ามีผลอื่นเข้ามาก่อน (เช่น callback แจ้งว่ารับ/สำเร็จ) ห้ามทับ
    const a = db.run(
      "UPDATE order_attempts SET state = 'rejected', provider_status = ?, message = ?, updated_at = ? WHERE order_id = ? AND attempt_no = ? AND state = 'sending'",
      result.providerStatus ? String(result.providerStatus).slice(0, 60) : null, result.message ? String(result.message).slice(0, 500) : null, now, orderId, attemptNo,
    );
    if (a.changes !== 1) {
      ok = 'conflict';
      return;
    }
    if (!settings.get('failover_enabled')) return;
    const r = db.run(
      "UPDATE orders SET status = 'pending', next_check_at = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND provider = ? AND attempts = ?",
      now, orderId, pick.name, attemptNo,
    );
    if (r.changes !== 1) return;
    addEvent(orderId, 'pending', 'system', `${pick.provider.label} ไม่รับรายการ (${result.message || result.providerStatus || 'ปฏิเสธ'}) — ยังไม่ได้ทำรายการ ส่งต่อผู้ให้บริการสำรองอัตโนมัติ`, { internal: true, provider: pick.name, providerStatus: result.providerStatus || null });
    ok = 'rerouted';
  });
  return ok;
}

/**
 * ต้นทุนจริงที่ผู้ให้บริการตัด (เช่น total_amount ของ HubZell) ต่างจากที่คาดไว้ → บันทึกต้นทุนจริง
 * ถ้าสูงกว่าราคาขาย = ผู้ให้บริการขึ้นราคา → ปิดการจับคู่นั้นทันที + แจ้งแอดมิน (รายการต่อไปจะไม่ขาดทุนซ้ำ)
 */
function recordActualCost(order, attemptNo, pick, result) {
  const charged = result.chargedAmount;
  // 0 หรือติดลบ = ข้อมูลผิดปกติ (ไม่มีบริการไหนฟรี) — ไม่บันทึก กันต้นทุนเพี้ยนจนระบบกันขาดทุนใช้ไม่ได้
  if (!Number.isSafeInteger(charged) || charged <= 0 || charged === pick.cost || result.outcome === 'failed') return;
  const now = db.nowIso();
  db.tx(() => {
    db.run('UPDATE orders SET cost = ?, updated_at = ? WHERE id = ? AND attempts = ?', charged, now, order.id, attemptNo);
    db.run('UPDATE order_attempts SET cost = ?, updated_at = ? WHERE order_id = ? AND attempt_no = ?', charged, now, order.id, attemptNo);
    if (pick.mapId) db.run('UPDATE provider_map SET cost = ?, updated_at = ? WHERE id = ?', charged, now, pick.mapId);
    addEvent(order.id, 'processing', 'system', `ต้นทุนจริงที่ ${pick.provider.label} ตัด ${fmt(charged)} บาท (คาดไว้ ${fmt(pick.cost)} บาท)`, { internal: true });
    if (charged > order.price && pick.mapId) {
      db.run('UPDATE provider_map SET enabled = 0, updated_at = ? WHERE id = ?', now, pick.mapId);
      alertAdmin(`cost-up-${pick.mapId}`, `${pick.provider.label} ขึ้นราคา: รายการ ${order.ref} ต้นทุนจริง ${fmt(charged)} บาท สูงกว่าราคาขาย ${fmt(order.price)} บาท — ระบบปิดการจับคู่บริการ ${pick.code} แล้ว กรุณาปรับราคา/ดึงรายการใหม่`, { cooldownSec: 60 });
    } else if (charged > order.price) {
      // ร้านที่คิดต้นทุนจากอัตราเงินคืน (เช่น wePAY) — อัตราที่ตั้งไว้สูงกว่าที่ได้จริง
      alertAdmin(`cost-up-${pick.name}-${order.network_code}`, `${pick.provider.label} ตัดเงินรายการ ${order.ref} ${fmt(charged)} บาท สูงกว่าราคาขาย ${fmt(order.price)} บาท — ตรวจอัตราเงินคืนที่ตั้งไว้ (เช่น WEPAY_DISCOUNTS) และส่วนลดลูกค้าของร้านนี้`, { cooldownSec: 600 });
    }
  });
}

/**
 * อัปเดตบันทึกการส่งของผู้ให้บริการที่ทำรายการนี้อยู่ตามผลที่ได้
 * (1 รายการส่งไปแต่ละเจ้าได้ครั้งเดียว — เจ้าที่ปฏิเสธถูกตัดออก จึงหาบันทึกจากชื่อเจ้าได้แน่นอน)
 */
function markAttempt(o, state, txnId, pStatus, msg) {
  if (!o.attempts) return;
  db.run(
    `UPDATE order_attempts SET state = ?, provider_txn_id = COALESCE(?, provider_txn_id), provider_status = COALESCE(?, provider_status),
       message = COALESCE(?, message), updated_at = ?
     WHERE order_id = ? AND provider = ? AND state != 'rejected' AND NOT (? = 'unknown' AND state IN ('accepted','success','failed'))`,
    state, txnId || null, pStatus || null, msg || null, db.nowIso(), o.id, o.provider, state,
  );
}

// รายการที่กำลังรอคำตอบจากผู้ให้บริการอยู่ตอนนี้ (แอดมินห้ามสรุปผลเองระหว่างนี้)
const inFlight = new Set();

// ───────────────────────── รับผล ─────────────────────────

function refundOnce(o, note) {
  const done = db.get("SELECT id FROM wallet_ledger WHERE type = 'refund' AND ref_type = 'order' AND ref_id = ?", o.id);
  if (done) return false;
  wallet.credit(o.user_id, o.price, { type: 'refund', refType: 'order', refId: o.id, note });
  return true;
}

/**
 * ส่งรายการให้เจ้าหน้าที่ตรวจ
 *   sticky = ผลจากผู้ให้บริการล้างธงนี้เองไม่ได้ (เช่น อาจเติมซ้ำ 2 เจ้า) — เจ้าหน้าที่เท่านั้นที่ล้างได้
 *   ถ้ามีธงแบบ sticky อยู่แล้ว เหตุผลเดิมไม่ถูกทับ (ต่อท้ายเหตุผลใหม่แทน)
 */
function flagReview(o, reason, { notify = true, sticky = false } = {}) {
  const cur = db.get('SELECT review_sticky, review_reason FROM orders WHERE id = ?', o.id);
  const text = cur?.review_sticky && cur.review_reason && !cur.review_reason.includes(reason)
    ? `${cur.review_reason} · ${reason}`
    : cur?.review_sticky && cur.review_reason ? cur.review_reason : reason;
  db.run(
    'UPDATE orders SET needs_review = 1, review_reason = ?, review_sticky = CASE WHEN ? = 1 THEN 1 ELSE review_sticky END, updated_at = ? WHERE id = ?',
    text.slice(0, 300), sticky ? 1 : 0, db.nowIso(), o.id,
  );
  addEvent(o.id, o.status, 'system', `ส่งให้เจ้าหน้าที่ตรวจสอบ: ${reason}`, { internal: true, ...(sticky ? { locked: true } : {}) });
  if (notify) alertAdmin(`review-${o.id}`, `รายการ ${o.ref} (${o.product_name} → ${formatPhone(o.phone)}) ต้องตรวจสอบ\nเหตุผล: ${reason}`);
}

function nextCheckAt(o, attempts) {
  const provider = providers.byName(o.provider);
  if (!provider?.capabilities?.statusCheck) return null;
  if (Date.now() - Date.parse(o.submitted_at || o.created_at) > MAX_AUTO_CHECK_MS) return null;
  return addSeconds(CHECK_SCHEDULE_SEC[Math.min(attempts, CHECK_SCHEDULE_SEC.length - 1)]);
}

// ผลสุดท้ายล้างธง "ต้องตรวจสอบ" ได้ ยกเว้นธงแบบ sticky (เช่น อาจเติมซ้ำ 2 เจ้า) ที่เจ้าหน้าที่ต้องล้างเอง
const KEEP_STICKY_REVIEW = 'needs_review = review_sticky, review_reason = CASE WHEN review_sticky = 1 THEN review_reason ELSE NULL END';

/**
 * นำผลจากผู้ให้บริการ (ตอนส่ง / callback / เช็กสถานะ) มาอัปเดตรายการ
 * ปลอดภัยต่อการเรียกซ้ำ: ผลเดิมซ้ำกี่ครั้งก็ไม่คืนเงินซ้ำ
 * tag.provider = ผู้ให้บริการที่ให้ผลนี้ → ต้องเป็นเจ้าที่ทำรายการนี้อยู่ตอนนี้ (ผลที่มาช้าจากเจ้าก่อนหน้าไม่ถูกนำมาใช้)
 * result.review = ส่งให้เจ้าหน้าที่ตรวจ, result.stopChecks = หยุดเช็กสถานะอัตโนมัติ
 */
function applyResult(orderId, result, source, tag = {}) {
  const outcome = result?.outcome;
  let becameFinal = false;
  db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o) return;
    const now = db.nowIso();
    const txnId = result.providerTxnId ? String(result.providerTxnId).slice(0, 100) : o.provider_txn_id;
    const pStatus = result.providerStatus ? String(result.providerStatus).slice(0, 60) : o.provider_status;
    const msg = result.message ? String(result.message).slice(0, 500) : o.provider_message;

    if (tag.provider && o.provider !== tag.provider) {
      addEvent(o.id, o.status, source, `ได้รับผล "${outcome}" จาก ${tag.provider} ซึ่งไม่ได้ทำรายการนี้แล้ว — ไม่นำมาใช้`, { internal: true, provider: tag.provider, providerStatus: result.providerStatus || null });
      return;
    }

    // pending = ยังไม่เคยส่ง (ระบบเปลี่ยนเป็น processing ก่อนส่งเสมอ) → ผลใดๆ ที่เข้ามาตอนนี้ไม่ใช่ของรายการนี้แน่นอน
    if (o.status === 'pending') {
      addEvent(o.id, 'pending', source, `ได้รับผล "${outcome}" ทั้งที่รายการยังไม่ได้ส่ง — ไม่นำมาใช้`, { internal: true, providerStatus: pStatus });
      return;
    }

    if (FINAL.has(o.status)) {
      const conflict = (o.status === 'success' && outcome === 'failed') || (o.status !== 'success' && outcome === 'success');
      if (conflict) {
        flagReview(o, `ผลขัดแย้ง: ระบบบันทึกว่า "${STATUS_LABELS[o.status]}" แต่ผู้ให้บริการแจ้งว่า "${outcome === 'success' ? 'สำเร็จ' : 'ไม่สำเร็จ'}" (${SOURCE_LABELS[source] || source})`);
        addEvent(o.id, o.status, source, `ผู้ให้บริการแจ้งผล "${outcome}" หลังรายการปิดแล้ว: ${msg || '-'}`, { internal: true, providerStatus: pStatus });
      } else if (result.review) {
        flagReview(o, result.review);
      }
      return;
    }

    if (outcome === 'success') {
      db.run(
        `UPDATE orders SET status = 'success', provider_txn_id = ?, provider_status = ?, provider_message = ?, completed_at = ?,
           next_check_at = NULL, ${KEEP_STICKY_REVIEW}, updated_at = ? WHERE id = ?`,
        txnId, pStatus, msg, now, now, o.id,
      );
      addEvent(o.id, 'success', source, result.message || 'ทำรายการสำเร็จ', pStatus ? { providerStatus: pStatus } : null);
      markAttempt(o, 'success', txnId, pStatus, msg);
      becameFinal = true;
      return;
    }

    if (outcome === 'failed') {
      db.run(
        `UPDATE orders SET status = 'failed', provider_txn_id = ?, provider_status = ?, provider_message = ?, completed_at = ?,
           next_check_at = NULL, ${KEEP_STICKY_REVIEW}, updated_at = ? WHERE id = ?`,
        txnId, pStatus, msg, now, now, o.id,
      );
      addEvent(o.id, 'failed', source, `ไม่สำเร็จ: ${result.message || 'ผู้ให้บริการแจ้งว่าทำรายการไม่สำเร็จ'}`, pStatus ? { providerStatus: pStatus } : null);
      if (refundOnce(o, `คืนเงินรายการ ${o.ref} (ไม่สำเร็จ)`)) addEvent(o.id, 'failed', 'system', `คืนเงิน ${fmt(o.price)} บาท เข้ากระเป๋าแล้ว`);
      markAttempt(o, 'failed', txnId, pStatus, msg);
      becameFinal = true;
      return;
    }

    // processing / unknown — ยังไม่รู้ผลสุดท้าย
    const attempts = source === 'status' ? o.check_attempts + 1 : o.check_attempts;
    db.run(
      "UPDATE orders SET status = 'processing', provider_txn_id = ?, provider_status = ?, provider_message = ?, check_attempts = ?, next_check_at = ?, updated_at = ? WHERE id = ?",
      txnId, pStatus, msg, attempts, result.stopChecks ? null : nextCheckAt(o, attempts), now, o.id,
    );
    markAttempt(o, outcome === 'processing' ? 'accepted' : 'unknown', txnId, pStatus, msg);
    if (source === 'submit') {
      addEvent(o.id, 'processing', source, outcome === 'unknown'
        ? `ยังไม่ทราบผล (${result.message || 'ไม่ได้รับคำตอบ'}) — ระบบจะตรวจสอบสถานะให้อัตโนมัติ และจะไม่ส่งซ้ำ`
        : 'ผู้ให้บริการรับรายการแล้ว กำลังดำเนินการ');
    } else if (source !== 'status' || pStatus !== o.provider_status) {
      addEvent(o.id, 'processing', source, result.message || 'ยังอยู่ระหว่างดำเนินการ', { internal: source === 'status', providerStatus: pStatus });
    }
    if (result.review) {
      flagReview(o, result.review);
    } else if (source === 'status' && attempts >= settings.get('max_status_checks') && !o.needs_review) {
      flagReview(o, `ตรวจสอบสถานะครบ ${attempts} ครั้งแล้วยังไม่ทราบผล`);
    }
  });
  if (becameFinal) afterFinal(orderId);
}

function afterFinal(orderId) {
  try { webhooks.enqueueForOrder(orderId); } catch (e) { logger.error('สร้าง webhook ไม่สำเร็จ', e); }
}

function failPending(orderId, reason) {
  let changed = false;
  db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o || o.status !== 'pending') return;
    const now = db.nowIso();
    db.run("UPDATE orders SET status = 'failed', provider_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'", reason, now, now, o.id);
    addEvent(o.id, 'failed', 'worker', `ไม่สำเร็จ: ${reason}`);
    if (refundOnce(o, `คืนเงินรายการ ${o.ref} (ไม่ได้ส่ง)`)) addEvent(o.id, 'failed', 'system', `คืนเงิน ${fmt(o.price)} บาท เข้ากระเป๋าแล้ว`);
    changed = true;
  });
  if (changed) afterFinal(orderId);
}

/**
 * เช็กสถานะกับผู้ให้บริการ 1 ครั้ง (ไม่บันทึกผล — ผู้เรียกนำไปใช้ผ่าน applyResult พร้อมชื่อเจ้า)
 * ส่งบันทึกการส่งของเจ้านั้นไปด้วย (เช่น HubZell ใช้ตัดสินว่าต้องส่งซ้ำด้วยเลขเดิม หรือค้นผล)
 * ปัญหาบัญชี/การตั้งค่าที่เจอตอนเช็ก → พักเจ้านั้นเหมือนตอนส่ง
 */
async function runCheck(o, providerName = o.provider) {
  const provider = providers.byName(providerName);
  const attempt = db.get('SELECT * FROM order_attempts WHERE order_id = ? AND provider = ? ORDER BY attempt_no DESC LIMIT 1', o.id, providerName) || null;
  let result;
  try {
    result = await provider.checkStatus(o, { attempt });
  } catch (err) {
    result = { outcome: 'unknown', message: `เช็กสถานะผิดพลาด: ${err.message}` };
  }
  if (!result || typeof result !== 'object') result = { outcome: 'unknown', message: 'ผู้ให้บริการไม่ตอบผลการเช็กสถานะ' };
  if (result.trip) breaker.record(providerName, { trip: result.trip, message: result.message });
  return result;
}

/** เช็กสถานะกับผู้ให้บริการทันที 1 ครั้ง (ใช้ยืนยันผลจาก callback ที่ไม่มีลายเซ็น) */
async function checkNow(orderId, source = 'callback') {
  const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o || o.status === 'pending') return null;
  const provider = providers.byName(o.provider);
  if (!provider?.capabilities?.statusCheck) return null;
  if (inFlight.has(o.id)) return null; // กำลังรอคำตอบตอนส่งอยู่ — ผลตอนส่งจะอัปเดตรายการเอง
  const result = await runCheck(o);
  applyResult(o.id, result, source, { provider: o.provider });
  return result;
}

/**
 * ผู้ให้บริการที่ระบบบันทึกว่า "ปฏิเสธรายการนี้" (จึงส่งต่อเจ้าอื่น/รอส่งต่อ) แจ้งภายหลังว่ารับรายการ/สำเร็จ
 *   = เจ้านั้นทำรายการไปแล้วจริง
 *   - รายการยังรอส่งต่อ (pending) → ให้เจ้านั้นทำรายการต่อ (ไม่ส่งเจ้าอื่น ไม่คืนเงิน)
 *   - ส่งต่อเจ้าอื่นไปแล้ว / ปิดรายการแล้ว → อาจเติมซ้ำ 2 เจ้า หรือคืนเงินทั้งที่เติมสำเร็จ
 *     → ล็อกธง "ต้องตรวจสอบ" ที่ผลจากเจ้าอื่นล้างเองไม่ได้ (เจ้าหน้าที่ต้องตรวจกับทั้งสองเจ้า)
 */
function lateReportFromRejected(orderId, providerName, update, source) {
  let revived = false;
  db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    const att = db.get("SELECT * FROM order_attempts WHERE order_id = ? AND provider = ? AND state = 'rejected' ORDER BY attempt_no DESC LIMIT 1", orderId, providerName);
    if (!o || !att) return;
    const now = db.nowIso();
    const label = providers.byName(providerName)?.label || providerName;
    const said = update.outcome === 'success' ? 'ทำรายการสำเร็จ' : 'รับรายการแล้ว';
    db.run(
      `UPDATE order_attempts SET state = ?, provider_status = COALESCE(?, provider_status), provider_txn_id = COALESCE(?, provider_txn_id), message = ?, updated_at = ?
       WHERE id = ?`,
      update.outcome === 'success' ? 'success' : 'accepted', update.providerStatus ? String(update.providerStatus).slice(0, 60) : null,
      update.providerTxnId ? String(update.providerTxnId).slice(0, 100) : null, `${label} แจ้งภายหลังว่า${said} (ตอนส่งตอบว่าปฏิเสธ)`, now, att.id,
    );
    if (o.status === 'pending') {
      const r = db.run(
        "UPDATE orders SET status = 'processing', provider = ?, cost = ?, check_attempts = 0, next_check_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        providerName, att.cost ?? o.cost, nextCheckAt({ ...o, provider: providerName }, 0), now, o.id,
      );
      if (r.changes === 1) {
        addEvent(o.id, 'processing', source, `${label} แจ้งว่า${said} (ก่อนหน้านี้ตอบว่าไม่รับ) — ให้ ${label} ทำรายการนี้ต่อ ไม่ส่งเจ้าอื่น`, { internal: true, provider: providerName });
        revived = true;
        return;
      }
    }
    const handler = providers.byName(o.provider)?.label || o.provider;
    const where = o.provider === providerName ? '' : ` ขณะที่ระบบส่งรายการนี้ไป ${handler} แล้ว`;
    flagReview(o, `${label} แจ้งว่า${said} ทั้งที่ตอนส่งตอบว่าปฏิเสธ${where} (สถานะในระบบ: ${STATUS_LABELS[o.status]}) — อาจเติมซ้ำ 2 ครั้ง หรือคืนเงินทั้งที่เติมสำเร็จ กรุณาตรวจกับผู้ให้บริการ${o.provider === providerName ? '' : 'ทั้งสองเจ้า'}`, { sticky: true });
    addEvent(o.id, o.status, source, `ได้รับผล "${update.outcome}" จาก ${label} (เจ้าที่เคยปฏิเสธ)`, { internal: true, provider: providerName, providerStatus: update.providerStatus || null });
  });
  if (revived) {
    applyResult(orderId, update, source, { provider: providerName });
    const o = db.get('SELECT ref FROM orders WHERE id = ?', orderId);
    alertAdmin(`late-accept-${orderId}`, `รายการ ${o?.ref}: ${providers.byName(providerName)?.label || providerName} ตอบตอนส่งว่าไม่รับ แต่ภายหลังแจ้งว่ารับ/สำเร็จ — ระบบให้เจ้านั้นทำต่อ (ไม่ได้ส่งเจ้าอื่น) โปรดตรวจว่ารหัสข้อผิดพลาดของผู้ให้บริการยังตรงกับคู่มือ`, { cooldownSec: 600 });
  }
}

/** ผลจาก callback ที่ไม่มีลายเซ็น ของเจ้าที่เคยปฏิเสธ → เช็กสถานะกับเจ้านั้นก่อนเชื่อ */
async function verifyLateReport(orderId, providerName) {
  const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  const p = providers.byName(providerName);
  if (!o || !p) return;
  if (!p.capabilities?.statusCheck) {
    flagReview(o, `${p.label} แจ้งผลรายการนี้ภายหลัง (ผ่าน callback ที่ไม่มีลายเซ็น) ทั้งที่ตอนส่งตอบว่าปฏิเสธ — ตรวจสอบอัตโนมัติไม่ได้ กรุณาตรวจกับผู้ให้บริการ`, { sticky: true });
    return;
  }
  const r = await runCheck(o, providerName);
  if (r.outcome === 'success' || r.outcome === 'processing') lateReportFromRejected(orderId, providerName, r, 'callback');
  else addEvent(orderId, o.status, 'callback', `ตรวจกับ ${p.label} แล้ว: ไม่พบว่ารับรายการนี้ (${r.providerStatus || r.outcome}) — ไม่นำผลจาก callback มาใช้`, { internal: true, provider: providerName });
}

/**
 * callback จากผู้ให้บริการ: หารายการจากเลขอ้างอิง แล้วอัปเดต
 * - callback ที่มีลายเซ็นถูกต้อง (trust = signed) → ใช้ผลได้เลย
 * - callback ที่ยืนยันได้แค่ IP/รหัสใน URL → ไม่เชื่อเนื้อหา แต่ "เช็กสถานะกับผู้ให้บริการ" ทันทีแล้วใช้ผลจากการเช็กแทน
 *   (กันการปลอม callback "ไม่สำเร็จ" เพื่อให้ระบบคืนเงินทั้งที่เติมสำเร็จแล้ว)
 */
function applyCallback(providerName, update) {
  const o = db.get('SELECT id, status, provider FROM orders WHERE ref = ?', String(update.ref || '').toUpperCase());
  if (!o) return { ok: false, reason: 'ไม่พบรายการ' };
  // ผลจากเจ้าที่ระบบบันทึกว่า "ปฏิเสธ" รายการนี้ (แม้รายการยังรอส่งต่อ หรือเจ้านั้นยังเป็นเจ้าล่าสุดในรายการ)
  const rejected = db.get("SELECT 1 AS x FROM order_attempts WHERE order_id = ? AND provider = ? AND state = 'rejected'", o.id, providerName);
  if (rejected) {
    if (update.outcome !== 'success' && update.outcome !== 'processing') return { ok: true, ignored: true }; // ไม่สำเร็จ = ตรงกับที่ปฏิเสธไว้
    if (update.trust === 'signed') {
      lateReportFromRejected(o.id, providerName, update, 'callback');
      return { ok: true, review: true };
    }
    setImmediate(() => { verifyLateReport(o.id, providerName).catch((e) => logger.error(`ตรวจผลภายหลังของ ${update.ref} ไม่สำเร็จ`, e)); });
    return { ok: true, verifying: true };
  }
  if (o.provider !== providerName) return { ok: false, reason: 'ผู้ให้บริการไม่ตรงกับรายการ' };
  if (o.status === 'pending') return { ok: false, reason: 'รายการยังไม่ได้ส่ง' };
  const provider = providers.byName(providerName);
  if (update.trust !== 'signed') {
    if (provider?.capabilities?.statusCheck) {
      // เก็บเลขที่รายการฝั่งผู้ให้บริการจาก callback ไว้ใช้เช็กสถานะ (เช่น wePAY: คำขอส่งหมดเวลารอ จึงยังไม่มีเลข)
      // ยังไม่ขยับเงิน — ผลที่เช็กได้ต้องมีเลขที่รายการของเราตรงกันถึงจะนำมาใช้
      if (update.providerTxnId) {
        db.run(
          "UPDATE order_attempts SET provider_txn_id = ?, updated_at = ? WHERE order_id = ? AND provider = ? AND state != 'rejected' AND provider_txn_id IS NULL",
          String(update.providerTxnId).slice(0, 100), db.nowIso(), o.id, providerName,
        );
      }
      addEvent(o.id, o.status, 'callback', `ผู้ให้บริการแจ้งผล "${update.outcome}" — กำลังเช็กสถานะยืนยันอีกครั้งก่อนบันทึกผล`, { internal: true, providerStatus: update.providerStatus || null });
      setImmediate(() => { checkNow(o.id, 'callback').catch((e) => logger.error(`ยืนยันผล callback ${update.ref} ไม่สำเร็จ`, e)); });
      return { ok: true, verifying: true };
    }
    // เช็กสถานะยืนยันไม่ได้ → ไม่ขยับเงินจาก callback ที่ไม่มีลายเซ็น ให้เจ้าหน้าที่ตรวจแทน
    if (update.outcome === 'success' || update.outcome === 'failed') {
      const full = db.get('SELECT * FROM orders WHERE id = ?', o.id);
      flagReview(full, `ผู้ให้บริการแจ้งผล "${update.outcome === 'success' ? 'สำเร็จ' : 'ไม่สำเร็จ'}" ผ่าน callback ที่ไม่มีลายเซ็น — ระบบไม่บันทึกผลเอง กรุณาตรวจกับผู้ให้บริการ`);
    }
    return { ok: true, review: true };
  }
  applyResult(o.id, update, 'callback', { provider: providerName });
  return { ok: true };
}

// ───────────────────────── งานเบื้องหลัง (worker) ─────────────────────────

/** รายการ pending ค้าง (เช่น เครื่องดับก่อนส่ง) → ส่งใหม่ หรือคืนเงินถ้าเกิน 10 นาที (ปลอดภัยเพราะยังไม่เคยส่ง) */
function recoverPending() {
  const rows = db.all("SELECT id, created_at FROM orders WHERE status = 'pending' AND created_at < ? ORDER BY id LIMIT 100", new Date(Date.now() - 20000).toISOString());
  for (const r of rows) {
    if (Date.now() - Date.parse(r.created_at) > PENDING_MAX_AGE_MS) failPending(r.id, 'ส่งรายการไปยังผู้ให้บริการไม่ได้ภายในเวลาที่กำหนด');
    else enqueue(r.id);
  }
  return rows.length;
}

/** เช็กสถานะรายการที่ยังไม่รู้ผล ตามตารางเวลาแบบถอยห่าง (10 วิ, 20 วิ, ... 1 ชม.) */
async function pollDue(limit = 20) {
  const rows = db.all(
    "SELECT * FROM orders WHERE status = 'processing' AND next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at LIMIT ?",
    db.nowIso(), limit,
  );
  if (!rows.length) return 0;
  // จองทุกรายการที่ดึงมาก่อนเริ่มเช็ก กันงานอีกรอบ (เช่น ปุ่ม "รันตอนนี้") หยิบรายการเดียวกันไปเช็กซ้อน
  const hold = addSeconds(120);
  db.tx(() => { for (const o of rows) db.run('UPDATE orders SET next_check_at = ? WHERE id = ?', hold, o.id); });
  for (const o of rows) {
    const provider = providers.byName(o.provider);
    if (!provider?.capabilities?.statusCheck) {
      db.run('UPDATE orders SET next_check_at = NULL WHERE id = ?', o.id);
      continue;
    }
    if (inFlight.has(o.id)) {
      // คำขอส่งรายการยังไม่จบ (เช่น รอคิวนาน) → ยังไม่เช็กซ้อน เลื่อนไปรอบหน้า
      db.run('UPDATE orders SET next_check_at = ? WHERE id = ? AND status = ?', addSeconds(CHECK_SCHEDULE_SEC[0]), o.id, 'processing');
      continue;
    }
    const result = await runCheck(o);
    applyResult(o.id, result, 'status', { provider: o.provider });
  }
  return rows.length;
}

/** รายการค้าง "กำลังดำเนินการ" นานเกินกำหนด → แจ้งแอดมิน */
function escalateStale() {
  const mins = settings.get('review_after_min');
  const rows = db.all(
    "SELECT * FROM orders WHERE status = 'processing' AND needs_review = 0 AND submitted_at < ?",
    new Date(Date.now() - mins * 60000).toISOString(),
  );
  // หลายรายการพร้อมกัน (เช่น ผู้ให้บริการล่ม) → แจ้งแอดมินรวมครั้งเดียว ไม่ส่งข้อความรัวๆ
  const notifyEach = rows.length <= 3;
  for (const o of rows) flagReview(o, `ค้างสถานะ "กำลังดำเนินการ" เกิน ${mins} นาที`, { notify: notifyEach });
  if (!notifyEach) {
    alertAdmin('stale-batch', `มีรายการค้างสถานะ "กำลังดำเนินการ" เกิน ${mins} นาที ${rows.length} รายการ กรุณาตรวจสอบที่หน้า "ต้องตรวจสอบ"`, { cooldownSec: 300 });
  }
  return rows.length;
}

// ───────────────────────── แอดมินจัดการรายการ ─────────────────────────

function getOrderOrThrow(idOrRef) {
  const o = /^\d+$/.test(String(idOrRef))
    ? db.get('SELECT * FROM orders WHERE id = ?', Number(idOrRef))
    : db.get('SELECT * FROM orders WHERE ref = ?', String(idOrRef).toUpperCase());
  if (!o) throw E.notFound('ไม่พบรายการ');
  return o;
}

async function adminRecheck(idOrRef, actor, ip) {
  const o = getOrderOrThrow(idOrRef);
  if (o.status === 'pending') throw E.validation('รายการนี้ยังไม่ได้ส่งไปยังผู้ให้บริการ');
  const provider = providers.byName(o.provider);
  if (!provider?.capabilities?.statusCheck) throw E.validation('ผู้ให้บริการนี้ไม่รองรับการเช็กสถานะ กรุณาตรวจสอบกับผู้ให้บริการโดยตรง');
  if (inFlight.has(o.id)) {
    throw E.conflict('ORDER_IN_FLIGHT', 'ระบบกำลังรอคำตอบจากผู้ให้บริการสำหรับรายการนี้อยู่ กรุณารอสักครู่แล้วลองใหม่');
  }
  const result = await runCheck(o);
  applyResult(o.id, result, 'admin-check', { provider: o.provider });
  audit.log(actor.id, 'order.recheck', 'order', o.ref, { outcome: result.outcome, providerStatus: result.providerStatus }, ip);
  return { result, order: db.get('SELECT * FROM orders WHERE id = ?', o.id) };
}

// แอดมินสรุปผลเองได้ต่อเมื่อ: สถานะไม่เปลี่ยนไปจากที่เห็นบนหน้าจอ และไม่ได้กำลังรอคำตอบจากผู้ให้บริการอยู่
const RECENT_SUBMIT_MS = 2 * 60000;
const adminOpts = (o) => (typeof o === 'string' ? { note: o } : o || {});
const LEDGER_MISMATCH = 'ยอดเงินในสมุดบัญชีของรายการนี้ไม่ตรงกับสถานะ กรุณาตรวจสมุดบัญชีของลูกค้าแล้วปรับยอดด้วยตนเอง';

function assertAdminCanDecide(o, opts) {
  if (opts.expectedStatus && opts.expectedStatus !== o.status) {
    throw E.conflict('STATUS_CHANGED', `สถานะรายการเปลี่ยนไปแล้ว (ตอนนี้: ${STATUS_LABELS[o.status]}) กรุณารีเฟรชหน้าแล้วตรวจสอบอีกครั้ง`, { status: o.status });
  }
  if (inFlight.has(o.id)) {
    throw E.conflict('ORDER_IN_FLIGHT', 'ระบบกำลังรอคำตอบจากผู้ให้บริการสำหรับรายการนี้อยู่ กรุณารอสักครู่แล้วลองใหม่');
  }
}

function adminMarkSuccess(idOrRef, actor, options, ip) {
  const opts = adminOpts(options);
  const note = String(opts.note || '').trim().slice(0, 300);
  const o0 = getOrderOrThrow(idOrRef);
  let skipped = false;
  db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', o0.id);
    assertAdminCanDecide(o, opts);
    if (o.status === 'success') throw E.validation('รายการนี้สำเร็จอยู่แล้ว');
    if (o.status === 'pending') throw E.validation('รายการนี้ยังไม่ได้ส่งไปยังผู้ให้บริการ ยืนยันสำเร็จไม่ได้');
    const net = wallet.orderNet(o.id);
    if ((o.status === 'failed' || o.status === 'refunded') && net === 0) {
      // เคยคืนเงินไปแล้ว → ดึงเงินคืน (ยกเลิกการคืนเงิน)
      if (opts.skipReversal) {
        if (note.length < 3) throw E.validation('กรุณาระบุเหตุผลที่ไม่ดึงเงินคืนจากลูกค้า', { field: 'note' });
        skipped = true;
        addEvent(o.id, 'success', 'admin', `บันทึกว่าสำเร็จโดยไม่ดึงเงิน ${fmt(o.price)} บาท คืนจากกระเป๋าลูกค้า (ต้องติดตามเก็บเงินเอง)`, { internal: true, note });
      } else {
        try {
          wallet.debit(o.user_id, o.price, {
            type: 'reversal', refType: 'order', refId: o.id, seq: wallet.nextSeq('reversal', o.id), note: `ยกเลิกการคืนเงิน: ยืนยันว่า ${o.ref} สำเร็จ`, actorId: actor.id,
          });
        } catch (err) {
          if (err.code === 'INSUFFICIENT_BALANCE') {
            throw new AppError('INSUFFICIENT_BALANCE', 'ยอดเงินในกระเป๋าลูกค้าไม่พอสำหรับดึงเงินคืน — เลือก "บันทึกว่าสำเร็จโดยไม่ดึงเงินคืน" (ต้องระบุเหตุผล) แล้วติดตามเก็บเงินลูกค้าเอง', 409, { canSkipReversal: true });
          }
          throw err;
        }
        addEvent(o.id, 'success', 'admin', `ดึงเงินที่คืนไปแล้ว ${fmt(o.price)} บาท กลับ (ยกเลิกการคืนเงิน)`);
      }
    } else if (net !== -o.price) {
      throw E.validation(LEDGER_MISMATCH);
    }
    const now = db.nowIso();
    db.run("UPDATE orders SET status = 'success', completed_at = COALESCE(completed_at, ?), needs_review = 0, review_reason = NULL, review_sticky = 0, next_check_at = NULL, updated_at = ? WHERE id = ?", now, now, o.id);
    addEvent(o.id, 'success', 'admin', 'เจ้าหน้าที่ยืนยันว่ารายการสำเร็จ', { note, actor: actor.id, internalNote: true });
  });
  audit.log(actor.id, 'order.mark_success', 'order', o0.ref, { from: o0.status, note, ...(skipped ? { skipped_reversal: true } : {}) }, ip);
  afterFinal(o0.id);
  return db.get('SELECT * FROM orders WHERE id = ?', o0.id);
}

function adminMarkFailed(idOrRef, actor, options, ip) {
  const opts = adminOpts(options);
  const note = String(opts.note || '').trim().slice(0, 300);
  const o0 = getOrderOrThrow(idOrRef);
  let refundedAmount = 0;
  db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', o0.id);
    assertAdminCanDecide(o, opts);
    if (o.status === 'failed' || o.status === 'refunded') throw E.validation('รายการนี้คืนเงินไปแล้ว');
    // เพิ่งส่งไปไม่นาน ผู้ให้บริการอาจยังทำสำเร็จได้ → ต้องยืนยันซ้ำ (กันคืนเงินทั้งที่เติมสำเร็จ)
    if (o.status === 'processing' && !opts.confirmRecent && Date.now() - Date.parse(o.submitted_at || o.created_at) < RECENT_SUBMIT_MS) {
      throw E.conflict('ORDER_RECENT', 'รายการนี้เพิ่งส่งไปไม่ถึง 2 นาที ผู้ให้บริการอาจยังทำรายการสำเร็จได้ — แนะนำให้กด "เช็กสถานะ" ก่อน ถ้าตรวจกับผู้ให้บริการแล้วว่าไม่สำเร็จจริง ให้กดยืนยันอีกครั้ง');
    }
    const next = o.status === 'success' ? 'refunded' : 'failed';
    const net = wallet.orderNet(o.id);
    if (net !== -o.price && net !== 0) throw E.validation(LEDGER_MISMATCH);
    const now = db.nowIso();
    db.run('UPDATE orders SET status = ?, completed_at = ?, needs_review = 0, review_reason = NULL, review_sticky = 0, next_check_at = NULL, updated_at = ? WHERE id = ?', next, now, now, o.id);
    addEvent(o.id, next, 'admin', next === 'refunded' ? 'เจ้าหน้าที่คืนเงินรายการนี้' : 'เจ้าหน้าที่ยืนยันว่ารายการไม่สำเร็จ', { note, actor: actor.id, internalNote: true });
    if (net === -o.price) {
      wallet.credit(o.user_id, o.price, {
        type: 'refund', refType: 'order', refId: o.id, seq: wallet.nextSeq('refund', o.id), note: `คืนเงินรายการ ${o.ref} (โดยเจ้าหน้าที่)`, actorId: actor.id,
      });
      refundedAmount = o.price;
      addEvent(o.id, next, 'system', `คืนเงิน ${fmt(o.price)} บาท เข้ากระเป๋าแล้ว`);
    } else {
      // เคยบันทึกว่าสำเร็จโดยไม่ดึงเงินคืน → ลูกค้าไม่ได้ถูกเก็บเงินอยู่แล้ว ไม่ต้องคืนซ้ำ
      addEvent(o.id, next, 'system', 'ไม่ต้องคืนเงิน (ลูกค้าไม่ได้ถูกเก็บเงินสำหรับรายการนี้อยู่แล้ว)', { internal: true });
    }
  });
  audit.log(actor.id, 'order.mark_failed', 'order', o0.ref, { from: o0.status, note, refunded: refundedAmount }, ip);
  afterFinal(o0.id);
  const row = db.get('SELECT * FROM orders WHERE id = ?', o0.id);
  row.refunded_amount = refundedAmount; // ยอดที่คืนจริงในครั้งนี้ (0 = ไม่ต้องคืน)
  return row;
}

function adminClearReview(idOrRef, actor, options, ip) {
  const opts = adminOpts(options);
  const note = String(opts.note || '').trim().slice(0, 300);
  const o = getOrderOrThrow(idOrRef);
  assertAdminCanDecide(o, opts);
  if (!o.needs_review) throw E.validation('รายการนี้ไม่ได้อยู่ในรายการรอตรวจสอบ');
  if (!FINAL.has(o.status)) {
    throw E.validation('รายการยังไม่ทราบผล กรุณากด "เช็กสถานะ" หรือยืนยันว่าสำเร็จ/ไม่สำเร็จ หลังตรวจกับผู้ให้บริการแล้ว');
  }
  db.run('UPDATE orders SET needs_review = 0, review_reason = NULL, review_sticky = 0, updated_at = ? WHERE id = ?', db.nowIso(), o.id);
  addEvent(o.id, o.status, 'admin', 'เจ้าหน้าที่ตรวจสอบแล้ว', { note, internal: true });
  audit.log(actor.id, 'order.clear_review', 'order', o.ref, { note }, ip);
  return db.get('SELECT * FROM orders WHERE id = ?', o.id);
}

// ───────────────────────── ค้นหา / แสดงผล ─────────────────────────

function publicOrder(o) {
  if (!o) return null;
  return {
    ref: o.ref,
    type: o.type,
    source: o.source,
    batch_id: o.batch_id,
    network: o.network_code,
    product_id: o.product_id,
    product_name: o.product_name,
    phone: o.phone,
    face_value: o.face_value,
    price: o.price,
    status: o.status,
    status_label: STATUS_LABELS[o.status],
    final: FINAL.has(o.status),
    // ร้านที่ลูกค้าเลือก และร้านที่ทำรายการจริง (ต่างกันเมื่อระบบส่งต่อร้านสำรองให้อัตโนมัติ)
    shop: o.shop || null,
    shop_name: o.shop ? shops.displayName(o.shop) : null,
    handled_by: o.attempts ? shops.displayName(o.provider) : null,
    message: customerMessage(o),
    provider_txn_id: o.provider_txn_id,
    reference: o.idempotency_key,
    created_at: o.created_at,
    submitted_at: o.submitted_at,
    completed_at: o.completed_at,
  };
}

function adminOrder(o) {
  return {
    ...publicOrder(o),
    id: o.id,
    user_id: o.user_id,
    user_name: o.user_name,
    user_phone: o.user_phone,
    cost: o.cost,
    profit: o.status === 'success' ? o.price - o.cost : 0,
    provider: o.provider,
    provider_label: providers.byName(o.provider)?.label || o.provider,
    attempts: o.attempts,
    provider_status: o.provider_status,
    // แอดมินเห็นข้อความเต็มจากผู้ให้บริการ
    message: o.provider_message,
    provider_message: o.provider_message,
    product_code: o.product_code,
    needs_review: Boolean(o.needs_review),
    review_reason: o.review_reason,
    review_locked: Boolean(o.review_sticky),
    check_attempts: o.check_attempts,
    next_check_at: o.next_check_at,
    ip: o.ip,
    callback_url: o.callback_url,
    api_key_id: o.api_key_id,
  };
}

function buildFilters(f = {}, { admin = false } = {}) {
  const where = [];
  const params = [];
  if (f.status === 'review') where.push('o.needs_review = 1');
  else if (f.status === 'active') where.push("o.status IN ('pending','processing')");
  else if (f.status && STATUS_LABELS[f.status]) { where.push('o.status = ?'); params.push(f.status); }
  if (f.type === 'topup' || f.type === 'package') { where.push('o.type = ?'); params.push(f.type); }
  if (f.network) { where.push('o.network_code = ?'); params.push(String(f.network).toUpperCase()); }
  if (['web', 'bulk', 'api'].includes(f.source)) { where.push('o.source = ?'); params.push(f.source); }
  if (f.batch) { where.push('o.batch_id = ?'); params.push(String(f.batch)); }
  if (f.q) {
    const q = String(f.q).trim().slice(0, 100);
    const digits = q.replace(/\D/g, '');
    where.push('(o.ref LIKE ? OR o.phone LIKE ? OR o.idempotency_key = ? OR o.provider_txn_id = ?)');
    params.push(`%${q.toUpperCase().replace(/[%_]/g, '')}%`, digits.length >= 3 ? `%${digits}%` : '__none__', q, q);
  }
  const range = bangkokDateRange(f.from, f.to);
  if (range.start) { where.push('o.created_at >= ?'); params.push(range.start); }
  if (range.end) { where.push('o.created_at < ?'); params.push(range.end); }
  if (admin && f.userId) { where.push('o.user_id = ?'); params.push(Number(f.userId)); }
  return { where, params };
}

function listForUser(userId, f = {}) {
  const { where, params } = buildFilters(f);
  where.unshift('o.user_id = ?');
  params.unshift(userId);
  const res = db.paged({ select: 'o.*', from: 'orders o', where, params, order: 'o.id DESC', page: f.page, pageSize: f.pageSize });
  res.rows = res.rows.map(publicOrder);
  return res;
}

function eventsFor(orderId, { admin = false } = {}) {
  return db.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', orderId)
    .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }))
    .filter((e) => admin || !e.data?.internal)
    .map((e) => ({
      status: e.status,
      source: e.source,
      source_label: SOURCE_LABELS[e.source] || e.source,
      message: admin ? e.message : customerEventMessage(e),
      created_at: e.created_at,
      ...(admin ? { data: e.data } : {}),
    }));
}

function getRowForUser(userId, ref) {
  const o = db.get('SELECT * FROM orders WHERE ref = ? AND user_id = ?', String(ref || '').toUpperCase(), userId);
  if (!o) throw E.notFound('ไม่พบรายการ');
  return o;
}

function getForUser(userId, ref) {
  const o = getRowForUser(userId, ref);
  return { order: publicOrder(o), events: eventsFor(o.id) };
}

function getByReference(userId, reference, apiKeyId = 0) {
  const o = findByKey(userId, apiKeyId, String(reference || '').trim());
  if (!o) throw E.notFound('ไม่พบรายการ');
  return o;
}

function listAdmin(f = {}) {
  const { where, params } = buildFilters(f, { admin: true });
  const res = db.paged({
    select: 'o.*, u.name AS user_name, u.phone AS user_phone',
    from: 'orders o JOIN users u ON u.id = o.user_id',
    where, params, order: 'o.id DESC', page: f.page, pageSize: f.pageSize,
  });
  res.rows = res.rows.map(adminOrder);
  const sum = db.get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN o.status = 'success' THEN o.price END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN o.status = 'success' THEN o.price - o.cost END), 0) AS profit
     FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    ...params,
  );
  res.summary = sum;
  return res;
}

function getAdmin(idOrRef) {
  const o0 = getOrderOrThrow(idOrRef);
  const o = db.get('SELECT o.*, u.name AS user_name, u.phone AS user_phone FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?', o0.id);
  return {
    order: adminOrder(o),
    events: eventsFor(o.id, { admin: true }),
    provider_logs: db.all('SELECT * FROM provider_logs WHERE order_ref = ? ORDER BY id', o.ref),
    ledger: db.all("SELECT * FROM wallet_ledger WHERE ref_type = 'order' AND ref_id = ? ORDER BY id", o.id)
      .map((l) => ({ ...l, type_label: wallet.TYPE_LABELS[l.type] || l.type })),
    webhooks: db.all('SELECT id, url, event, status, attempts, last_http_status, last_error, created_at, delivered_at FROM webhook_deliveries WHERE order_id = ? ORDER BY id', o.id),
    // ส่งไปผู้ให้บริการเจ้าไหนบ้าง ครั้งที่เท่าไร ผลอะไร (เจ้าที่ปฏิเสธ = ยืนยันแล้วว่าไม่ได้ทำรายการ)
    attempts: db.all(
      'SELECT provider, attempt_no, code, cost, state, provider_status, provider_txn_id, message, resends, not_found, created_at, updated_at FROM order_attempts WHERE order_id = ? ORDER BY attempt_no',
      o.id,
    ).map((a) => ({ ...a, provider_label: providers.byName(a.provider)?.label || a.provider, state_label: ATTEMPT_LABELS[a.state] || a.state })),
  };
}

const EXPORT_MAX = 20000;
const EXPORT_NOTE = `(แสดง ${EXPORT_MAX.toLocaleString('en-US')} รายการล่าสุด — เลือกช่วงวันที่ให้แคบลงเพื่อดาวน์โหลดส่วนที่เหลือ)`;

function exportRows(f = {}, { admin = false, userId = null } = {}) {
  const { where, params } = buildFilters(f, { admin });
  if (userId) { where.unshift('o.user_id = ?'); params.unshift(userId); }
  const rows = db.all(
    `SELECT o.*, u.name AS user_name, u.phone AS user_phone FROM orders o JOIN users u ON u.id = o.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT ${EXPORT_MAX + 1}`,
    ...params,
  );
  // เกินจำนวนสูงสุด → ส่งเท่าที่กำหนด + บอกในไฟล์ว่าไม่ครบ (ไม่ตัดทิ้งเงียบๆ)
  if (rows.length > EXPORT_MAX) {
    rows.length = EXPORT_MAX;
    rows.truncated = true;
  }
  return rows;
}

module.exports = {
  EXPORT_NOTE, STATUS_LABELS, FINAL, setEnqueue, createOrder, createOrders, quote, dispatch, applyResult, applyCallback, checkNow,
  recoverPending, pollDue, escalateStale, failPending,
  adminRecheck, adminMarkSuccess, adminMarkFailed, adminClearReview,
  publicOrder, adminOrder, listForUser, getForUser, getRowForUser, getByReference, listAdmin, getAdmin, exportRows, eventsFor,
};
