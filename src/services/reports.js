'use strict';
// สรุปยอดขาย / แดชบอร์ด / รายงาน
const db = require('../db');
const { E } = require('../lib/errors');
const { bangkokDayStart, bangkokMonthStart, bangkokDateRange, bangkokDate } = require('../lib/time');
const providerStatus = require('./providerStatus');

const SUM_COLS = `COUNT(*) AS orders,
  COALESCE(SUM(o.status = 'success'), 0) AS success,
  COALESCE(SUM(o.status IN ('failed','refunded')), 0) AS failed,
  COALESCE(SUM(o.status IN ('pending','processing')), 0) AS processing,
  COALESCE(SUM(CASE WHEN o.status = 'success' THEN o.price END), 0) AS revenue,
  COALESCE(SUM(CASE WHEN o.status = 'success' THEN o.cost END), 0) AS cost,
  COALESCE(SUM(CASE WHEN o.status = 'success' THEN o.price - o.cost END), 0) AS profit`;

const summary = (since) => db.get(`SELECT ${SUM_COLS} FROM orders o WHERE o.created_at >= ?`, since);

function dashboard() {
  const days = 14;
  const since = new Date(Date.parse(bangkokDayStart()) - (days - 1) * 86400000).toISOString();
  const rows = db.all(`SELECT date(o.created_at, '+7 hours') AS day, ${SUM_COLS} FROM orders o WHERE o.created_at >= ? GROUP BY day ORDER BY day`, since);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series = [];
  for (let i = 0; i < days; i++) {
    const day = bangkokDate(new Date(Date.parse(since) + i * 86400000 + 3600000));
    series.push(byDay.get(day) || { day, orders: 0, success: 0, failed: 0, processing: 0, revenue: 0, cost: 0, profit: 0 });
    series[i].day = day;
  }
  return {
    today: summary(bangkokDayStart()),
    month: summary(bangkokMonthStart()),
    series,
    by_network: db.all(`SELECT o.network_code AS network, ${SUM_COLS} FROM orders o WHERE o.created_at >= ? GROUP BY o.network_code ORDER BY revenue DESC`, bangkokMonthStart()),
    needs_review: db.get('SELECT COUNT(*) AS c FROM orders WHERE needs_review = 1').c,
    processing: db.get("SELECT COUNT(*) AS c FROM orders WHERE status IN ('pending','processing')").c,
    deposits_waiting: db.get("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS amount FROM deposits WHERE status = 'pending' AND slip_file IS NOT NULL"),
    customers: db.get("SELECT COUNT(*) AS c, COALESCE(SUM(balance), 0) AS wallet_total FROM users WHERE role = 'customer'"),
    webhooks_failed: db.get("SELECT COUNT(*) AS c FROM webhook_deliveries WHERE status = 'failed'").c,
    alerts: db.all("SELECT id, target_id AS key, detail, created_at FROM audit_logs WHERE action = 'system.alert' ORDER BY id DESC LIMIT 8")
      .map((a) => ({ ...a, detail: JSON.parse(a.detail || '{}') })),
    recent: db.all(`SELECT o.ref, o.type, o.network_code AS network, o.product_name, o.phone, o.price, o.status, o.needs_review, o.created_at, u.name AS user_name
                    FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 8`),
    provider: providerStatus.snapshot(),
  };
}

const GROUPS = {
  day: { key: "date(o.created_at, '+7 hours')", label: "date(o.created_at, '+7 hours')", order: 'k DESC' },
  month: { key: "strftime('%Y-%m', o.created_at, '+7 hours')", label: "strftime('%Y-%m', o.created_at, '+7 hours')", order: 'k DESC' },
  network: { key: 'o.network_code', label: 'o.network_code', order: 'revenue DESC' },
  type: { key: 'o.type', label: "CASE o.type WHEN 'topup' THEN 'เติมเงิน' ELSE 'แพ็กเกจ' END", order: 'revenue DESC' },
  product: { key: 'o.product_name', label: 'o.product_name', order: 'revenue DESC' },
  user: { key: 'o.user_id', label: "u.name || ' (' || COALESCE(u.phone, u.email, '') || ')'", order: 'revenue DESC' },
  source: { key: 'o.source', label: "CASE o.source WHEN 'web' THEN 'หน้าเว็บ' WHEN 'bulk' THEN 'เติมหลายรายการ' ELSE 'API ร้านค้า' END", order: 'revenue DESC' },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sales({ from, to, group = 'day' } = {}) {
  const g = Object.hasOwn(GROUPS, String(group)) ? GROUPS[group] : null;
  if (!g) throw E.validation('รูปแบบรายงานไม่ถูกต้อง');
  const defFrom = bangkokDate(new Date(Date.now() - 29 * 86400000));
  const validDate = (d) => typeof d === 'string' && DATE_RE.test(d) && require('../lib/time').isValidDay(d);
  if ((from && !validDate(from)) || (to && !validDate(to))) throw E.validation('วันที่ต้องอยู่ในรูปแบบ ปปปป-ดด-วว');
  from = from || defFrom;
  to = to || bangkokDate();
  if (from > to) throw E.validation('วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด');
  const range = bangkokDateRange(from, to);
  const rows = db.all(
    `SELECT ${g.key} AS k, ${g.label} AS label, ${SUM_COLS}
     FROM orders o JOIN users u ON u.id = o.user_id
     WHERE o.created_at >= ? AND o.created_at < ?
     GROUP BY k ORDER BY ${g.order} LIMIT 1000`,
    range.start, range.end,
  );
  const total = db.get(`SELECT ${SUM_COLS} FROM orders o WHERE o.created_at >= ? AND o.created_at < ?`, range.start, range.end);
  return { from, to, group, rows, total };
}

module.exports = { dashboard, sales, summary };
