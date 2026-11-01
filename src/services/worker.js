'use strict';
// งานเบื้องหลังที่ทำงานตลอดเวลา: เช็กสถานะรายการ, กู้รายการค้าง, ส่ง webhook, เช็กเครดิต, ล้างข้อมูลเก่า
const config = require('../config');
const db = require('../db');
const logger = require('../lib/logger');
const settings = require('./settings');
const orders = require('./orders');
const webhooks = require('./webhooks');
const deposits = require('./deposits');
const providerStatus = require('./providerStatus');
const backup = require('./backup');

function cleanup() {
  const now = db.nowIso();
  const keepDays = settings.get('log_retention_days');
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
  db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  db.run('DELETE FROM provider_logs WHERE created_at < ?', cutoff);
  db.run("DELETE FROM webhook_deliveries WHERE status = 'delivered' AND created_at < ?", cutoff);
  db.run('DELETE FROM mock_txns WHERE created_at < ?', new Date(Date.now() - 30 * 86400000).toISOString());
}

const tick = config.workerTickMs;
const JOBS = [
  { name: 'ตรวจสถานะรายการ', every: tick, fn: () => orders.pollDue() },
  { name: 'กู้รายการค้าง', every: tick * 3, fn: () => orders.recoverPending() },
  { name: 'ส่ง webhook', every: tick * 2, fn: () => webhooks.deliverDue() },
  { name: 'แจ้งรายการค้างนาน', every: 60000, fn: () => orders.escalateStale() },
  { name: 'เช็กเครดิตผู้ให้บริการ', every: 5 * 60000, fn: () => providerStatus.refreshBalance(), atStart: true },
  { name: 'ยกเลิกรายการเติมเงินหมดเวลา', every: 3600000, fn: () => deposits.expireStale(), atStart: true },
  { name: 'ล้างข้อมูลเก่า', every: 3600000, fn: cleanup, atStart: true },
  { name: 'สำรองฐานข้อมูลรายวัน', every: 3600000, fn: () => backup.dailyBackup(), atStart: true },
];

const timers = [];
const running = new Map(); // ชื่องาน → promise ที่กำลังทำ (งานเดียวกันห้ามทำซ้อนกัน)

function exclusive(name, fn) {
  // เรียก fn ใน microtask ถัดไป (error แบบ synchronous จะกลายเป็น promise ที่ reject)
  // และลบชื่องานออกเฉพาะเมื่อเป็นรอบของตัวเอง — กันชื่องานค้างจนงานนั้นไม่ถูกรันอีกเลย
  const p = Promise.resolve().then(fn).finally(() => {
    if (running.get(name) === p) running.delete(name);
  });
  running.set(name, p);
  return p;
}

/** งานตามรอบเวลา: ถ้ารอบก่อนยังไม่เสร็จ ข้ามรอบนี้ไป */
async function runJob(job) {
  if (running.has(job.name)) return;
  try {
    await exclusive(job.name, job.fn);
  } catch (err) {
    logger.error(`งานเบื้องหลัง "${job.name}" ผิดพลาด`, err);
  }
}

/** สั่งรันทันที: ถ้างานเดียวกันกำลังทำอยู่ รอให้เสร็จก่อนแล้วค่อยรัน (ไม่ทำซ้อน) */
async function runNow(name, fn) {
  // รอรอบที่กำลังทำ (มีขอบเขต — ไม่วนรอไม่รู้จบ)
  for (let i = 0; i < 20 && running.has(name); i++) await running.get(name).catch(() => {});
  return exclusive(name, fn);
}

function start() {
  if (config.disableWorker || timers.length) return;
  for (const job of JOBS) {
    const t = setInterval(() => runJob(job), job.every);
    t.unref?.();
    timers.push(t);
    if (job.atStart) {
      const s = setTimeout(() => runJob(job), 2000);
      s.unref?.();
      timers.push(s);
    }
  }
  logger.info(`เริ่มงานเบื้องหลัง ${JOBS.length} งาน`);
}

function stop() {
  while (timers.length) clearInterval(timers.pop());
}

/** รันทุกงานหลัก 1 รอบ (ใช้ในการทดสอบ / ปุ่ม "รันตอนนี้" ในหน้าแอดมิน) */
async function runOnce() {
  await runNow('กู้รายการค้าง', () => orders.recoverPending());
  await runNow('ตรวจสถานะรายการ', () => orders.pollDue(100));
  await runNow('แจ้งรายการค้างนาน', () => orders.escalateStale());
  await runNow('ส่ง webhook', () => webhooks.deliverDue(100));
}

module.exports = { start, stop, runOnce, cleanup };
