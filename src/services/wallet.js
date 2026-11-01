'use strict';
/**
 * กระเป๋าเงิน (wallet) — ทุกการเปลี่ยนยอดต้องผ่านไฟล์นี้เท่านั้น
 *   - ตัดเงินด้วย UPDATE ... WHERE balance >= จำนวน (ยอดติดลบไม่ได้ + ฐานข้อมูลมี CHECK balance >= 0)
 *   - ทุกครั้งมีบันทึกในสมุดบัญชี (wallet_ledger) พร้อมยอดคงเหลือหลังทำรายการ
 *   - คืนเงิน/ตัดเงินของรายการเดียวกันทำได้ครั้งเดียว (unique index ux_ledger_once)
 */
const db = require('../db');
const { E } = require('../lib/errors');
const audit = require('./audit');

const TYPE_LABELS = {
  deposit: 'เติมเงินเข้ากระเป๋า',
  order: 'ชำระค่ารายการ',
  refund: 'คืนเงิน',
  reversal: 'ยกเลิกการคืนเงิน',
  adjust: 'ปรับยอดโดยแอดมิน',
};

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`จำนวนเงินไม่ถูกต้อง: ${amount}`);
}

function insertLedger(userId, type, amount, balanceAfter, { refType = null, refId = null, note = null, actorId = null, seq = 0, requestId = null }) {
  db.run(
    `INSERT INTO wallet_ledger (user_id, type, amount, balance_after, ref_type, ref_id, note, actor_id, seq, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, type, amount, balanceAfter, refType, refId, note ? String(note).slice(0, 300) : null, actorId, seq, requestId, db.nowIso(),
  );
}

/** เพิ่มเงิน — คืนยอดคงเหลือใหม่ */
function credit(userId, amount, opts) {
  assertAmount(amount);
  return db.tx(() => {
    const r = db.run('UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?', amount, db.nowIso(), userId);
    if (r.changes !== 1) throw E.notFound('ไม่พบผู้ใช้');
    const { balance } = db.get('SELECT balance FROM users WHERE id = ?', userId);
    insertLedger(userId, opts.type, amount, balance, opts);
    return balance;
  });
}

/** ตัดเงิน — ถ้ายอดไม่พอจะ throw INSUFFICIENT_BALANCE และไม่มีอะไรเปลี่ยน */
function debit(userId, amount, opts) {
  assertAmount(amount);
  return db.tx(() => {
    const r = db.run('UPDATE users SET balance = balance - ?, updated_at = ? WHERE id = ? AND balance >= ?', amount, db.nowIso(), userId, amount);
    if (r.changes !== 1) {
      const u = db.get('SELECT balance FROM users WHERE id = ?', userId);
      if (!u) throw E.notFound('ไม่พบผู้ใช้');
      throw E.insufficientBalance(amount, u.balance);
    }
    const { balance } = db.get('SELECT balance FROM users WHERE id = ?', userId);
    insertLedger(userId, opts.type, -amount, balance, opts);
    return balance;
  });
}

/**
 * แอดมินปรับยอด (+ เพิ่ม / - ลด) ต้องระบุเหตุผล
 * requestId (สร้างจากหน้าจอครั้งละ 1 ค่าต่อการกด) กันกดซ้ำ/เน็ตหลุดแล้วส่งใหม่จนปรับยอดสองรอบ
 */
function adjust(userId, amountSigned, note, actor, ip, requestId = null) {
  if (!Number.isSafeInteger(amountSigned) || amountSigned === 0) throw E.validation('จำนวนเงินไม่ถูกต้อง');
  const reason = String(note ?? '').trim();
  if (reason.length < 3) throw E.validation('กรุณาระบุเหตุผลการปรับยอด (อย่างน้อย 3 ตัวอักษร)', { field: 'note' });
  let rid = null;
  if (requestId !== null && requestId !== undefined && requestId !== '') {
    rid = String(requestId);
    if (!/^[A-Za-z0-9_\-:.]{8,100}$/.test(rid)) throw E.validation('รหัสคำขอไม่ถูกต้อง');
  }
  return db.tx(() => {
    if (rid) {
      const ex = db.get('SELECT * FROM wallet_ledger WHERE request_id = ?', rid);
      if (ex) {
        if (ex.user_id !== Number(userId) || ex.amount !== amountSigned) throw E.conflict('REQUEST_MISMATCH', 'รหัสคำขอนี้ถูกใช้กับการปรับยอดอื่นไปแล้ว');
        return { balance: db.get('SELECT balance FROM users WHERE id = ?', ex.user_id).balance, existing: true };
      }
    }
    const opts = { type: 'adjust', refType: 'admin', refId: actor.id, note: reason, actorId: actor.id, requestId: rid };
    const balance = amountSigned > 0 ? credit(userId, amountSigned, opts) : debit(userId, -amountSigned, opts);
    audit.log(actor.id, 'wallet.adjust', 'user', userId, { amount: amountSigned, note: reason, balance }, ip);
    return { balance, existing: false };
  });
}

/** ยอดสุทธิในสมุดบัญชีของรายการสั่งซื้อ 1 รายการ (ตัดเงิน -ราคา, คืนเงิน +ราคา, ดึงคืน -ราคา) */
const orderNet = (orderId) => db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_ledger WHERE ref_type = 'order' AND ref_id = ?", orderId).s;
const nextSeq = (type, orderId) => db.get("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM wallet_ledger WHERE type = ? AND ref_type = 'order' AND ref_id = ?", type, orderId).n;

function ledger({ userId, type, page, pageSize } = {}) {
  const where = [];
  const params = [];
  if (userId) { where.push('l.user_id = ?'); params.push(userId); }
  if (type) { where.push('l.type = ?'); params.push(type); }
  const res = db.paged({
    select: `l.*, u.name AS user_name, u.phone AS user_phone, o.ref AS order_ref, a.name AS actor_name`,
    from: `wallet_ledger l JOIN users u ON u.id = l.user_id
           LEFT JOIN orders o ON l.ref_type = 'order' AND o.id = l.ref_id
           LEFT JOIN users a ON a.id = l.actor_id`,
    where, params, order: 'l.id DESC', page, pageSize,
  });
  res.rows = res.rows.map((r) => ({ ...r, type_label: TYPE_LABELS[r.type] || r.type }));
  return res;
}

/** ตรวจความถูกต้อง: ยอดในกระเป๋าต้องเท่ากับผลรวมสมุดบัญชี */
function reconcile() {
  return db.all(
    `SELECT u.id, u.name, u.balance, COALESCE(SUM(l.amount), 0) AS ledger_sum
     FROM users u LEFT JOIN wallet_ledger l ON l.user_id = u.id
     GROUP BY u.id HAVING u.balance != COALESCE(SUM(l.amount), 0)`,
  );
}

/**
 * ตรวจรายรายการ: เงินที่เก็บจริงต้องตรงกับสถานะ
 *   สำเร็จ / กำลังดำเนินการ / รอส่ง → ต้องถูกตัดเงินสุทธิ = ราคา
 *   ไม่สำเร็จ / คืนเงินแล้ว         → ต้องคืนครบ (สุทธิ = 0)
 * รายการที่แอดมินยืนยัน "สำเร็จโดยไม่ดึงเงินคืน" จะขึ้นในนี้ด้วย (ต้องตามเก็บเงินลูกค้า)
 */
function reconcileOrders(limit = 200) {
  return db.all(
    `SELECT o.id, o.ref, o.status, o.price, o.user_id, u.name AS user_name, COALESCE(SUM(l.amount), 0) AS net
     FROM orders o JOIN users u ON u.id = o.user_id
     LEFT JOIN wallet_ledger l ON l.ref_type = 'order' AND l.ref_id = o.id
     GROUP BY o.id
     HAVING (o.status IN ('pending','processing','success') AND net != -o.price)
         OR (o.status IN ('failed','refunded') AND net != 0)
     ORDER BY o.id DESC LIMIT ?`,
    limit,
  );
}

module.exports = { credit, debit, adjust, ledger, reconcile, reconcileOrders, orderNet, nextSeq, TYPE_LABELS };
