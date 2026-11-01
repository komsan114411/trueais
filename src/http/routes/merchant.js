'use strict';
/**
 * /api/v1 — API สำหรับเว็บไซต์ร้านค้าที่ต้องการเชื่อมต่อแบบ server-to-server
 * ยืนยันตัวตนด้วย header:  Authorization: Bearer tk_xxxxxxxx
 * เงินในระบบนี้ใช้หน่วย "บาท" (ทศนิยม 2 ตำแหน่ง) — ดูรายละเอียดใน docs/API.md
 */
const express = require('express');
const orders = require('../../services/orders');
const catalog = require('../../services/catalog');
const webhooks = require('../../services/webhooks');
const users = require('../../services/users');
const { E } = require('../../lib/errors');
const { parseBaht } = require('../../lib/money');
const { validatePublicUrl } = require('../../lib/netguard');
const { ok, apiKeyAuth, notFoundApi } = require('../middleware');

const router = express.Router();
router.use(apiKeyAuth);

const view = (o) => webhooks.merchantOrder(o);

router.get('/balance', (req, res) => {
  const u = users.getById(req.user.id);
  ok(res, { balance: u.balance / 100, currency: 'THB' });
});

router.get('/products', (req, res) => {
  const c = catalog.publicCatalog();
  ok(res, {
    networks: c.networks.map((n) => ({
      code: n.code,
      name: n.full_name,
      topup: { available: n.topup.open, min: n.topup.min / 100, max: n.topup.max / 100, presets: n.topup.presets, allow_custom: n.topup.allow_custom, discount_percent: n.topup.discount_bp / 100 },
      package: { available: n.package.open },
      notice: n.notice,
    })),
    packages: c.products.map((p) => ({
      code: p.code, network: p.network, name: p.name, description: p.description, category: p.category,
      data: p.data_label, validity_days: p.validity_days, price: p.price / 100,
    })),
    // ร้านที่เลือกได้ (ส่ง shop ใน POST /orders) — ราคาเติมเงิน = ยอด - ส่วนลดของร้าน
    shops: c.shops.map((s) => ({
      code: s.code, name: s.name, available: !s.paused,
      topup: Object.fromEntries(Object.entries(s.networks).map(([n, v]) => [n, { discount_percent: v.discount_bp / 100, amounts: v.amounts, allow_custom: v.custom }])),
      package_codes: c.products.filter((p) => s.product_ids.includes(p.id)).map((p) => p.code),
    })),
  });
});

router.post('/orders', (req, res) => {
  const b = req.body || {};
  if (!b.reference) throw E.validation('กรุณาส่ง reference (เลขอ้างอิงฝั่งร้านค้า ห้ามซ้ำ) เพื่อป้องกันการเติมซ้ำ', { field: 'reference' });
  // ห้ามชี้ไป localhost / IP ภายใน (กันใช้ระบบเราเป็นทางผ่านเข้าเครือข่ายภายใน)
  const callbackUrl = b.callback_url ? validatePublicUrl(b.callback_url, 'callback_url', 'callback_url') : null;
  let expectedPrice;
  if (b.expected_price !== undefined && b.expected_price !== null && b.expected_price !== '') {
    expectedPrice = parseBaht(b.expected_price, 'expected_price');
  }
  const r = orders.createOrder(req.user, {
    type: b.type,
    network: b.network,
    phone: b.phone,
    amount: b.amount,
    productCode: b.product_code,
    idempotencyKey: b.reference,
    confirmDuplicate: b.allow_duplicate === true,
    expectedPrice,
    shop: b.shop,
  }, { source: 'api', ip: req.ip, apiKeyId: req.apiKey.id, callbackUrl });
  ok(res, { order: view(r.order), existing: r.existing }, r.existing ? 200 : 201);
});

router.get('/orders', (req, res) => {
  if (!req.query.reference) throw E.validation('กรุณาระบุ ?reference=');
  ok(res, { order: view(orders.getByReference(req.user.id, String(req.query.reference), req.apiKey.id)) });
});

router.get('/orders/:ref', (req, res) => {
  ok(res, { order: view(orders.getRowForUser(req.user.id, req.params.ref)) });
});

router.use(notFoundApi);

module.exports = router;
