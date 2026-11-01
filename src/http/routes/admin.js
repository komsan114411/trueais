'use strict';
// /api/admin — หลังบ้านสำหรับแอดมิน
const express = require('express');
const db = require('../../db');
const config = require('../../config');
const { E } = require('../../lib/errors');
const { parseBaht } = require('../../lib/money');
const { sendCsv } = require('../../lib/csv');
const { bangkokDate } = require('../../lib/time');
const users = require('../../services/users');
const orders = require('../../services/orders');
const wallet = require('../../services/wallet');
const deposits = require('../../services/deposits');
const catalog = require('../../services/catalog');
const settings = require('../../services/settings');
const reports = require('../../services/reports');
const audit = require('../../services/audit');
const webhooks = require('../../services/webhooks');
const apikeys = require('../../services/apikeys');
const breaker = require('../../services/breaker');
const providerStatus = require('../../services/providerStatus');
const worker = require('../../services/worker');
const backup = require('../../services/backup');
const securityCheck = require('../../services/securityCheck');
const providerMap = require('../../services/providerMap');
const shops = require('../../services/shops');
const providers = require('../../providers');
const { callbackUrl } = require('../../providers/base');
const { ok, requireAdmin, csrf, notFoundApi } = require('../middleware');

const router = express.Router();
router.use(requireAdmin, csrf);

const body = (req) => req.body || {};

// ───────────── แดชบอร์ด ─────────────

router.get('/dashboard', (req, res) => ok(res, { ...reports.dashboard(), security: securityCheck.checklist(req.user) }));
router.get('/security', (req, res) => ok(res, { items: securityCheck.checklist(req.user) }));

// ───────────── รายการ ─────────────

router.get('/orders', (req, res) => ok(res, orders.listAdmin(req.query)));

router.get('/orders/export.csv', (req, res) => {
  const rows = orders.exportRows(req.query, { admin: true });
  sendCsv(res, `orders-admin-${bangkokDate()}.csv`, [
    { label: 'เลขที่รายการ', key: 'ref' },
    { label: 'วันที่ (เวลาไทย)', value: (r) => require('../../lib/time').bangkokDateTime(r.created_at) },
    { label: 'ลูกค้า', key: 'user_name' },
    { label: 'เบอร์ลูกค้า', key: 'user_phone' },
    { label: 'ช่องทาง', key: 'source' },
    { label: 'ประเภท', value: (r) => (r.type === 'topup' ? 'เติมเงิน' : 'แพ็กเกจ') },
    { label: 'เครือข่าย', key: 'network_code' },
    { label: 'รายการ', key: 'product_name' },
    { label: 'เบอร์ปลายทาง', key: 'phone' },
    { label: 'ยอด (บาท)', value: (r) => (r.face_value / 100).toFixed(2) },
    { label: 'ขาย (บาท)', value: (r) => (r.price / 100).toFixed(2) },
    { label: 'ทุน (บาท)', value: (r) => (r.cost / 100).toFixed(2) },
    { label: 'กำไร (บาท)', value: (r) => (r.status === 'success' ? ((r.price - r.cost) / 100).toFixed(2) : '0.00') },
    { label: 'สถานะ', value: (r) => orders.STATUS_LABELS[r.status] },
    { label: 'เลขที่ผู้ให้บริการ', key: 'provider_txn_id' },
    { label: 'ข้อความ', key: 'provider_message' },
  ], rows, { note: rows.truncated ? orders.EXPORT_NOTE : null });
});

router.get('/orders/:id', (req, res) => ok(res, orders.getAdmin(req.params.id)));

router.post('/orders/:id/recheck', async (req, res) => {
  const r = await orders.adminRecheck(req.params.id, req.user, req.ip);
  ok(res, { result: r.result, order: orders.adminOrder(r.order) });
});

// expected_status = สถานะที่แอดมินเห็นบนหน้าจอ (ถ้าเปลี่ยนไปแล้ว เช่น แอดมินอีกคนกดไปก่อน → ปฏิเสธ)
const decision = (req) => {
  const b = body(req);
  return {
    note: String(b.note || '').slice(0, 300),
    expectedStatus: typeof b.expected_status === 'string' ? b.expected_status : undefined,
    confirmRecent: b.confirm_recent === true,
    skipReversal: b.skip_reversal === true,
  };
};

router.post('/orders/:id/mark-success', (req, res) => {
  const o = orders.adminMarkSuccess(req.params.id, req.user, decision(req), req.ip);
  ok(res, { order: orders.adminOrder(o) });
});

router.post('/orders/:id/mark-failed', (req, res) => {
  const o = orders.adminMarkFailed(req.params.id, req.user, decision(req), req.ip);
  ok(res, { order: orders.adminOrder(o), refunded: o.refunded_amount });
});

router.post('/orders/:id/clear-review', (req, res) => {
  const o = orders.adminClearReview(req.params.id, req.user, decision(req), req.ip);
  ok(res, { order: orders.adminOrder(o) });
});

// ───────────── ผู้ใช้ ─────────────

router.get('/users', (req, res) => ok(res, users.list(req.query)));

router.post('/users', async (req, res) => {
  const b = body(req);
  const u = await users.createUser({ name: b.name, phone: b.phone, email: b.email, password: b.password, role: b.role || 'customer' }, { requirePhone: b.role !== 'admin' });
  audit.log(req.user.id, 'user.create', 'user', u.id, { role: u.role }, req.ip);
  ok(res, { user: users.publicUser(u) }, 201);
});

router.get('/users/:id', (req, res) => {
  const d = users.detail(req.params.id);
  ok(res, {
    ...d,
    orders: orders.listAdmin({ userId: d.user.id, pageSize: 10 }).rows,
    ledger: wallet.ledger({ userId: d.user.id, pageSize: 10 }).rows,
    deposits: deposits.listAdmin({ userId: d.user.id, pageSize: 10 }).rows,
  });
});

router.get('/users/:id/ledger', (req, res) => ok(res, wallet.ledger({ userId: Number(req.params.id), type: req.query.type, page: req.query.page })));

router.post('/users/:id/adjust', (req, res) => {
  const b = body(req);
  const raw = String(b.amount ?? '').trim();
  const negative = raw.startsWith('-');
  const satang = parseBaht(negative ? raw.slice(1) : raw);
  // request_id: สร้างใหม่ทุกครั้งที่เปิดหน้าต่างปรับยอด — กดซ้ำ/ส่งซ้ำด้วยค่าเดิม = ไม่ปรับยอดซ้ำ
  const r = wallet.adjust(Number(req.params.id), negative ? -satang : satang, b.note, req.user, req.ip, b.request_id, { confirmLarge: b.confirm_large === true });
  ok(res, { balance: r.balance, existing: r.existing });
});

// การกระทำกับบัญชีแอดมิน: ส่ง actor_password (+ actor_code ถ้าเปิด 2 ชั้น) มาด้วย ไม่งั้นได้ REAUTH_REQUIRED
const reauth = (req) => ({ actor_password: body(req).actor_password, actor_code: body(req).actor_code });
const sess = (req) => ({ sessionId: req.session?.id });
router.post('/users/:id/status', async (req, res) => ok(res, { user: users.publicUser(await users.setStatus(req.params.id, body(req).status, req.user, req.ip, reauth(req), sess(req))) }));
router.post('/users/:id/role', async (req, res) => ok(res, { user: users.publicUser(await users.setRole(req.params.id, body(req).role, req.user, req.ip, reauth(req), sess(req))) }));
router.post('/users/:id/limit', (req, res) => ok(res, { user: users.publicUser(users.setDailyLimit(req.params.id, body(req).daily_limit_baht, req.user, req.ip)) }));
router.post('/users/:id/password', async (req, res) => {
  await users.resetPassword(req.params.id, body(req).password, req.user, req.ip, reauth(req), sess(req));
  ok(res, { changed: true });
});
router.post('/users/:id/2fa/reset', async (req, res) => ok(res, { user: users.publicUser(await users.adminResetTotp(req.params.id, req.user, req.ip, reauth(req), sess(req))) }));

router.get('/ledger', (req, res) => ok(res, wallet.ledger({ type: req.query.type, page: req.query.page, pageSize: req.query.pageSize })));
router.get('/reconcile', (req, res) => ok(res, { mismatches: wallet.reconcile(), orders: wallet.reconcileOrders() }));

// ───────────── เติมเงินเข้ากระเป๋า ─────────────

router.get('/deposits', (req, res) => ok(res, deposits.listAdmin(req.query)));

router.get('/deposits/:id/slip', (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(deposits.slipPath(req.params.id));
});

router.post('/deposits/:id/approve', (req, res) => {
  const b = body(req);
  ok(res, deposits.approve(req.params.id, req.user, {
    amount: b.amount, note: b.note, noSlip: b.no_slip === true, confirmOver: b.confirm_over === true,
    slipVer: typeof b.slip_ver === 'string' ? b.slip_ver : undefined, reopen: b.reopen === true,
  }, req.ip));
});
router.post('/deposits/:id/reject', (req, res) => ok(res, { deposit: deposits.reject(req.params.id, req.user, { note: body(req).note }, req.ip) }));

// ───────────── เครือข่าย / แพ็กเกจ ─────────────

router.get('/networks', (req, res) => ok(res, catalog.listNetworks().map(catalog.adminNetwork)));
router.put('/networks/:code', (req, res) => ok(res, catalog.updateNetwork(req.params.code, body(req), req.user, req.ip)));

router.get('/products', (req, res) => ok(res, catalog.listProducts({ network: req.query.network, q: req.query.q })));
router.post('/products', (req, res) => ok(res, catalog.createProduct(body(req), req.user, req.ip), 201));
router.post('/products/delete-demo', (req, res) => ok(res, { deleted: catalog.deleteDemoProducts(req.user, req.ip) }));
router.post('/products/sync', async (req, res) => ok(res, await catalog.syncProducts(req.user, req.ip)));
router.put('/products/:id', (req, res) => ok(res, catalog.updateProduct(req.params.id, body(req), req.user, req.ip)));
router.delete('/products/:id', (req, res) => {
  catalog.deleteProduct(req.params.id, req.user, req.ip);
  ok(res, { deleted: true });
});

// ───────────── ตั้งค่า ─────────────

router.get('/settings', (req, res) => ok(res, { values: settings.all(), schema: settings.adminSchema() }));
router.put('/settings', (req, res) => {
  const r = settings.update(body(req));
  audit.log(req.user.id, 'settings.update', 'settings', null, Object.fromEntries(r.changed.map((k) => [k, r.values[k]])), req.ip);
  ok(res, { values: r.values, changed: r.changed });
});

// ───────────── ผู้ให้บริการ / ระบบ ─────────────

// callback_url มีรหัสลับ ?t=... — ให้นำ URL นี้ทั้งเส้นไปตั้งที่ผู้ให้บริการ (callback ที่ไม่มีรหัสจะถูกปฏิเสธ)
const providerView = () => {
  const snap = providerStatus.snapshot();
  return {
    ...snap,
    providers: snap.providers.map((p) => ({ ...p, callback_url: callbackUrl(p.name) })),
    callback_url: callbackUrl(snap.name),
    public_url: config.publicUrl,
  };
};

router.get('/provider', (req, res) => ok(res, providerView()));
router.get('/providers', (req, res) => ok(res, providerView()));

router.post('/provider/refresh-balance', async (req, res) => {
  await providerStatus.refreshBalance();
  ok(res, providerView().balance);
});

router.post('/provider/reset-breaker', (req, res) => {
  breaker.reset();
  audit.log(req.user.id, 'provider.reset_breaker', 'provider', null, null, req.ip);
  ok(res, providerView().breaker);
});

router.post('/provider/mock-credit', async (req, res) => {
  const name = ['mock', 'mock2'].includes(body(req).provider) ? body(req).provider : 'mock';
  if (!providers.configured().includes(name)) throw E.validation('ใช้ได้เฉพาะโหมดทดสอบเท่านั้น');
  providers.byName(name).addMockCredit(parseBaht(body(req).amount));
  ok(res, await providerStatus.refreshBalance(name));
});

// ───────────── ผู้ให้บริการแต่ละเจ้า (หลายเจ้า / สลับอัตโนมัติ / จับคู่บริการ) ─────────────

const providerName = (req) => {
  const name = String(req.params.name || '').toLowerCase();
  if (!providers.configured().includes(name)) throw E.notFound('ไม่พบผู้ให้บริการนี้ในระบบ');
  return name;
};

router.post('/providers/:name/refresh-balance', async (req, res) => ok(res, await providerStatus.refreshBalance(providerName(req))));

router.post('/providers/:name/reset-breaker', (req, res) => {
  const name = providerName(req);
  breaker.reset(name);
  audit.log(req.user.id, 'provider.reset_breaker', 'provider', name, null, req.ip);
  ok(res, breaker.snapshot(name));
});

router.post('/providers/:name/sync', async (req, res) => ok(res, await providerMap.syncCatalog(providerName(req), req.user, req.ip)));
router.get('/providers/:name/catalog', (req, res) => ok(res, providerMap.listCatalog(providerName(req))));
router.post('/providers/:name/mappings', (req, res) => ok(res, providerMap.upsertMapping(providerName(req), body(req), req.user, req.ip), 201));
router.put('/providers/:name/mappings/:id', (req, res) => {
  ok(res, providerMap.setEnabled(providerName(req), req.params.id, body(req).enabled === true, req.user, req.ip, { confirm: body(req).confirm === true }));
});
router.delete('/providers/:name/mappings/:id', (req, res) => {
  providerMap.removeMapping(providerName(req), req.params.id, req.user, req.ip);
  ok(res, { deleted: true });
});
// ───────────── ร้าน (ชื่อที่ลูกค้าเห็น + ส่วนลดแต่ละเครือข่าย) ─────────────
router.get('/shops', (req, res) => ok(res, shops.adminList(catalog.listNetworks())));
router.put('/shops/:code', (req, res) => ok(res, shops.update(req.params.code, body(req), req.user, req.ip, catalog.listNetworks())));

router.post('/providers/:name/catalog/:serviceId/product', (req, res) => {
  ok(res, providerMap.createProductFromService(providerName(req), req.params.serviceId, body(req), req.user, req.ip), 201);
});

router.post('/worker/run', async (req, res) => {
  await worker.runOnce();
  ok(res, { done: true });
});

// ทดสอบ QR พร้อมเพย์ 1 บาท — ให้เจ้าของร้านสแกนด้วยแอปธนาคารแล้วตรวจชื่อผู้รับก่อนเปิดรับเงินจริง (ไม่ต้องโอน)
router.post('/settings/promptpay-test', async (req, res) => {
  const { normalizePromptPayId, formatPromptPayId, promptPaySvg } = require('../../lib/promptpay');
  const raw = body(req).promptpay_id;
  let id;
  try {
    id = normalizePromptPayId(raw === undefined || raw === null || raw === '' ? settings.get('promptpay_id') : raw);
  } catch (err) {
    throw E.validation(err.message, { field: 'promptpay_id' });
  }
  if (!id) throw E.validation('ยังไม่ได้ใส่หมายเลขพร้อมเพย์', { field: 'promptpay_id' });
  const { svg } = await promptPaySvg(id, 100);
  ok(res, { qr_svg: svg, target: formatPromptPayId(id), amount: 100 });
});

// ส่งข้อความทดสอบไป LINE / Telegram ตามที่ตั้งไว้ใน .env — รู้ผลทันทีว่าส่งถึงไหม
router.post('/notify/test', async (req, res) => {
  const r = await require('../../lib/notify').sendTest();
  audit.log(req.user.id, 'system.notify_test', 'notify', null, { configured: r.configured, channels: r.channels.map((c) => `${c.name}:${c.ok ? 'ok' : 'fail'}`) }, req.ip);
  ok(res, r);
});

router.get('/backups', (req, res) => ok(res, backup.list()));
// ดาวน์โหลดไฟล์สำรอง (เก็บไว้นอกเครื่องนี้ — เครื่องเสีย/หายข้อมูลยังอยู่)
router.get('/backups/:name/download', (req, res) => {
  const file = backup.filePath(req.params.name);
  if (!file) throw E.notFound('ไม่พบไฟล์สำรองนี้');
  audit.log(req.user.id, 'system.backup_download', 'backup', req.params.name, null, req.ip);
  settings.setInternal('_last_backup_download', db.nowIso());
  res.download(file, req.params.name);
});
router.post('/backups', async (req, res) => {
  const r = await backup.backupNow();
  audit.log(req.user.id, 'system.backup', 'backup', r.name, { size: r.size }, req.ip);
  ok(res, r, 201);
});

// ───────────── รายงาน ─────────────

router.get('/reports/sales', (req, res) => ok(res, reports.sales(req.query)));
router.get('/reports/sales.csv', (req, res) => {
  const r = reports.sales(req.query);
  sendCsv(res, `sales-${r.group}-${r.from}-${r.to}.csv`, [
    { label: 'กลุ่ม', key: 'label' },
    { label: 'จำนวนรายการ', key: 'orders' },
    { label: 'สำเร็จ', key: 'success' },
    { label: 'ไม่สำเร็จ', key: 'failed' },
    { label: 'ยอดขาย (บาท)', value: (x) => (x.revenue / 100).toFixed(2) },
    { label: 'ต้นทุน (บาท)', value: (x) => (x.cost / 100).toFixed(2) },
    { label: 'กำไร (บาท)', value: (x) => (x.profit / 100).toFixed(2) },
  ], r.rows);
});

// ───────────── Log ─────────────

router.get('/logs/provider', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.ref) { where.push('order_ref = ?'); params.push(String(req.query.ref).toUpperCase()); }
  if (req.query.action) { where.push('action = ?'); params.push(String(req.query.action)); }
  if (req.query.errors === '1') where.push("(error IS NOT NULL OR outcome = 'unknown')");
  ok(res, db.paged({ select: '*', from: 'provider_logs', where, params, order: 'id DESC', page: req.query.page, pageSize: req.query.pageSize }));
});

router.get('/logs/audit', (req, res) => ok(res, audit.list(req.query)));

router.get('/webhooks', (req, res) => ok(res, webhooks.list(req.query)));
router.post('/webhooks/:id/retry', (req, res) => {
  if (!webhooks.retryNow(Number(req.params.id))) throw E.validation('รายการนี้ส่งสำเร็จแล้วหรือไม่มีอยู่');
  ok(res, { queued: true });
});

// ───────────── API key ร้านค้า ─────────────

router.get('/api-keys', (req, res) => ok(res, apikeys.list()));
router.post('/api-keys', (req, res) => {
  const b = body(req);
  ok(res, apikeys.create({ userId: b.user_id, name: b.name, webhookUrl: b.webhook_url, ipAllowlist: b.ip_allowlist }, req.user, req.ip), 201);
});
router.put('/api-keys/:id', (req, res) => {
  const b = body(req);
  ok(res, apikeys.update(req.params.id, { name: b.name, webhookUrl: b.webhook_url, ipAllowlist: b.ip_allowlist }, req.user, req.ip));
});
router.post('/api-keys/:id/revoke', (req, res) => {
  apikeys.revoke(req.params.id, req.user, req.ip);
  ok(res, { revoked: true });
});

router.use(notFoundApi);

module.exports = router;
