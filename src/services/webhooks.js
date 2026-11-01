'use strict';
/**
 * Webhook ขาออก: แจ้งผลรายการไปยังเว็บไซต์ร้านค้าที่เชื่อมผ่าน API (/api/v1)
 * - เซ็นด้วย HMAC-SHA256: header X-Webhook-Signature: sha256=<hmac(secret, timestamp + "." + body)>
 * - ส่งไม่สำเร็จจะลองใหม่อัตโนมัติ: 30 วิ, 2 นาที, 10 นาที, 30 นาที, 2 ชม., 6 ชม.
 */
const db = require('../db');
const logger = require('../lib/logger');
const { hmacSha256 } = require('../lib/security');
const { addSeconds } = require('../lib/time');
const { safePost } = require('../lib/netguard');

const RETRY_SEC = [30, 120, 600, 1800, 7200, 21600];
const STATUS_LABELS = { pending: 'รอดำเนินการ', processing: 'กำลังดำเนินการ', success: 'สำเร็จ', failed: 'ไม่สำเร็จ', refunded: 'คืนเงินแล้ว' };

let kickTimer = null;
let deliveringNow = false;

/**
 * ข้อมูลรายการที่ส่งให้ร้านค้า (รูปแบบเดียวกับ GET /api/v1/orders/:ref)
 * version เพิ่มขึ้นทุกครั้งที่รายการเปลี่ยน — ร้านค้าควรเชื่อข้อมูลที่ version มากที่สุดเสมอ
 * (webhook ที่ส่งซ้ำ/ส่งช้าอาจมาถึงทีหลังได้)
 */
function merchantOrder(o) {
  const version = db.get('SELECT COALESCE(MAX(id), 0) AS v FROM order_events WHERE order_id = ?', o.id).v;
  return {
    ref: o.ref,
    reference: o.idempotency_key,
    type: o.type,
    network: o.network_code,
    product_code: o.type === 'package' ? o.product_code : null,
    product_name: o.product_name,
    phone: o.phone,
    amount: o.face_value / 100,
    price: o.price / 100,
    shop: o.shop || null,
    status: o.status,
    status_label: STATUS_LABELS[o.status],
    final: ['success', 'failed', 'refunded'].includes(o.status),
    message: require('./orderText').customerMessage(o),
    created_at: o.created_at,
    completed_at: o.completed_at,
    updated_at: o.updated_at,
    version,
  };
}

const buildPayload = (o) => JSON.stringify({ event: 'order.updated', sent_at: new Date().toISOString(), data: merchantOrder(o) });

function enqueueForOrder(orderId) {
  const o = db.get('SELECT o.*, k.webhook_url AS key_webhook_url FROM orders o LEFT JOIN api_keys k ON k.id = o.api_key_id WHERE o.id = ?', orderId);
  if (!o) return null;
  const url = o.callback_url || o.key_webhook_url;
  if (!url) return null;
  const payload = buildPayload(o);
  const r = db.run(
    `INSERT INTO webhook_deliveries (order_id, api_key_id, url, event, payload, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, 'order.updated', ?, 'pending', 0, ?, ?)`,
    o.id, o.api_key_id, url, payload, db.nowIso(), db.nowIso(),
  );
  kick();
  return Number(r.lastInsertRowid);
}

function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    deliverDue().catch((e) => logger.error('ส่ง webhook ผิดพลาด', e));
  }, 50);
  kickTimer.unref?.();
}

async function deliver(row) {
  const key = row.api_key_id ? db.get('SELECT webhook_secret FROM api_keys WHERE id = ?', row.api_key_id) : null;
  const ts = Math.floor(Date.now() / 1000);
  // สร้างข้อมูลจากสถานะ "ปัจจุบัน" ของรายการทุกครั้งที่ส่ง — การส่งซ้ำของรอบเก่าจึงไม่พาสถานะเก่ากลับมาทับของใหม่
  const order = db.get('SELECT * FROM orders WHERE id = ?', row.order_id);
  if (order) {
    row.payload = buildPayload(order);
    db.run('UPDATE webhook_deliveries SET payload = ? WHERE id = ?', row.payload, row.id);
  }
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'TopupWebhook/1.0',
    'X-Webhook-Event': row.event,
    'X-Webhook-Id': String(row.id),
    'X-Webhook-Timestamp': String(ts),
  };
  if (key) headers['X-Webhook-Signature'] = `sha256=${hmacSha256(key.webhook_secret, `${ts}.${row.payload}`)}`;
  // safePost: ไม่ตาม redirect, ห้ามส่งเข้า IP ภายใน (ตรวจตอนเชื่อมต่อจริง), หมดเวลา 10 วินาที
  const res = await safePost(row.url, { headers, body: row.payload, timeoutMs: 10000 });
  const httpStatus = res.status;
  const error = res.ok ? null : res.error || 'ส่งไม่สำเร็จ';
  const attempts = row.attempts + 1;
  if (!error) {
    db.run("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_http_status = ?, last_error = NULL, delivered_at = ?, next_attempt_at = NULL WHERE id = ?", attempts, httpStatus, db.nowIso(), row.id);
    return true;
  }
  const done = attempts > RETRY_SEC.length;
  db.run(
    'UPDATE webhook_deliveries SET status = ?, attempts = ?, last_http_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
    done ? 'failed' : 'pending', attempts, httpStatus, String(error).slice(0, 300), done ? null : addSeconds(RETRY_SEC[attempts - 1]), row.id,
  );
  return false;
}

async function deliverDue(limit = 20) {
  if (deliveringNow) return 0;
  deliveringNow = true;
  try {
    const rows = db.all("SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?", db.nowIso(), limit);
    for (const row of rows) await deliver(row);
    return rows.length;
  } finally {
    deliveringNow = false;
  }
}

function retryNow(id) {
  const r = db.run("UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ? WHERE id = ? AND status != 'delivered'", db.nowIso(), id);
  kick();
  return r.changes === 1;
}

function list({ status, page, pageSize } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('w.status = ?'); params.push(status); }
  return db.paged({
    select: 'w.id, w.order_id, o.ref AS order_ref, w.url, w.event, w.status, w.attempts, w.next_attempt_at, w.last_http_status, w.last_error, w.created_at, w.delivered_at',
    from: 'webhook_deliveries w JOIN orders o ON o.id = w.order_id',
    where, params, order: 'w.id DESC', page, pageSize,
  });
}

module.exports = { enqueueForOrder, deliverDue, retryNow, list, merchantOrder };
