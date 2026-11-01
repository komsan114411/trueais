'use strict';
// /api — หน้าเว็บลูกค้า: รายการสินค้า, สั่งเติมเงิน/แพ็กเกจ, ประวัติ, กระเป๋าเงิน, สมุดโทรศัพท์
const express = require('express');
const catalog = require('../../services/catalog');
const settings = require('../../services/settings');
const orders = require('../../services/orders');
const wallet = require('../../services/wallet');
const deposits = require('../../services/deposits');
const phonebook = require('../../services/phonebook');
const users = require('../../services/users');
const providers = require('../../providers');
const breaker = require('../../services/breaker');
const { sendCsv } = require('../../lib/csv');
const { bangkokDate } = require('../../lib/time');
const { ok, csrf, requireUser, rateLimit } = require('../middleware');

const router = express.Router();

// ───────────── สาธารณะ ─────────────

router.get('/catalog', (req, res) => {
  const names = providers.ordered();
  const ready = names.filter((n) => providers.byName(n).configStatus().ready);
  ok(res, {
    ...catalog.publicCatalog(),
    settings: settings.publicSettings(),
    // paused = ผู้ให้บริการทุกเจ้าที่พร้อมใช้ ถูกพักชั่วคราวอยู่ (ถ้ายังเหลือเจ้าสำรอง ลูกค้าทำรายการได้ตามปกติ)
    mode: { live: providers.isLive(), provider: providers.primary().name, ready: ready.length > 0, paused: ready.length > 0 && ready.every((n) => breaker.isOpen(n)) },
  });
});

// ───────────── ต้องเข้าสู่ระบบ ─────────────

router.use(requireUser, csrf);

const orderLimiter = rateLimit({ windowMs: 60000, max: 30, key: (req) => `u${req.user.id}` });
const quoteLimiter = rateLimit({ windowMs: 60000, max: 120, key: (req) => `q${req.user.id}` });

router.post('/orders/quote', quoteLimiter, (req, res) => {
  ok(res, orders.quote(req.user, req.body || {}));
});

router.post('/orders', orderLimiter, (req, res) => {
  const b = req.body || {};
  const r = orders.createOrder(req.user, {
    type: b.type, network: b.network, phone: b.phone, amount: b.amount, productId: b.productId,
    idempotencyKey: b.idempotencyKey, confirmDuplicate: b.confirmDuplicate === true, expectedPrice: b.expectedPrice, shop: b.shop,
  }, { source: 'web', ip: req.ip });
  ok(res, { order: orders.publicOrder(r.order), existing: r.existing }, r.existing ? 200 : 201);
});

router.post('/orders/bulk', orderLimiter, (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  const batchKey = b.batchKey ? String(b.batchKey).slice(0, 60) : null;
  // ยืนยันรายการซ้ำ "เป็นรายบรรทัด" ตามที่ลูกค้าเห็นบนจอเท่านั้น — บรรทัดซ้ำอื่นที่ลูกค้ายังไม่เห็น ระบบจะแจ้งกลับมาก่อนเสมอ
  const confirmed = new Set(Array.isArray(b.confirmDuplicateIndexes) ? b.confirmDuplicateIndexes.filter((x) => Number.isInteger(x)) : []);
  const inputs = items.map((it, i) => ({
    type: it?.type, network: it?.network, phone: it?.phone, amount: it?.amount, productId: it?.productId,
    idempotencyKey: batchKey ? `${batchKey}:${i}` : undefined,
    confirmDuplicate: confirmed.has(i),
    expectedPrice: it?.expectedPrice,
    shop: it?.shop ?? b.shop,
  }));
  const results = orders.createOrders(req.user, inputs, { source: 'bulk', ip: req.ip });
  const existing = results.every((r) => r.existing);
  ok(res, {
    batch_id: results[0]?.order.batch_id || null,
    orders: results.map((r) => orders.publicOrder(r.order)),
    existing,
  }, existing ? 200 : 201);
});

router.get('/orders', (req, res) => {
  ok(res, orders.listForUser(req.user.id, req.query));
});

router.get('/orders/export.csv', (req, res) => {
  const rows = orders.exportRows(req.query, { userId: req.user.id });
  sendCsv(res, `orders-${bangkokDate()}.csv`, [
    { label: 'เลขที่รายการ', key: 'ref' },
    { label: 'วันที่', value: (r) => new Date(r.created_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) },
    { label: 'ประเภท', value: (r) => (r.type === 'topup' ? 'เติมเงิน' : 'แพ็กเกจ') },
    { label: 'เครือข่าย', key: 'network_code' },
    { label: 'รายการ', key: 'product_name' },
    { label: 'เบอร์', key: 'phone' },
    { label: 'ยอด (บาท)', value: (r) => (r.face_value / 100).toFixed(2) },
    { label: 'ชำระ (บาท)', value: (r) => (r.price / 100).toFixed(2) },
    { label: 'สถานะ', value: (r) => orders.STATUS_LABELS[r.status] },
    { label: 'ข้อความ', key: 'provider_message' },
  ], rows);
});

router.get('/orders/:ref', (req, res) => {
  ok(res, orders.getForUser(req.user.id, req.params.ref));
});

// ───────────── กระเป๋าเงิน ─────────────

router.get('/wallet', (req, res) => {
  const u = users.getById(req.user.id);
  ok(res, { balance: u.balance, ledger: wallet.ledger({ userId: u.id, type: req.query.type, page: req.query.page, pageSize: req.query.pageSize }) });
});

router.get('/deposits', (req, res) => {
  ok(res, deposits.listForUser(req.user, req.query));
});

router.post('/deposits', rateLimit({ windowMs: 3600000, max: 20, key: (req) => `d${req.user.id}` }), async (req, res) => {
  const b = req.body || {};
  ok(res, await deposits.create(req.user, { amount: b.amount, method: b.method, note: b.note }), 201);
});

router.get('/deposits/:id', async (req, res) => {
  ok(res, await deposits.getForUser(req.user, req.params.id));
});

router.post('/deposits/:id/slip', (req, res) => {
  const b = req.body || {};
  ok(res, { deposit: deposits.attachSlip(req.user, req.params.id, { image: b.image, transferAt: b.transferAt }) });
});

router.post('/deposits/:id/cancel', (req, res) => {
  deposits.cancel(req.user, req.params.id);
  ok(res, { cancelled: true });
});

// ───────────── สมุดโทรศัพท์ ─────────────

router.get('/phonebook', (req, res) => ok(res, phonebook.list(req.user)));
router.post('/phonebook', (req, res) => ok(res, phonebook.add(req.user, req.body || {}), 201));
router.put('/phonebook/:id', (req, res) => ok(res, phonebook.update(req.user, req.params.id, req.body || {})));
router.delete('/phonebook/:id', (req, res) => {
  phonebook.remove(req.user, req.params.id);
  ok(res, { deleted: true });
});

module.exports = router;
