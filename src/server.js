'use strict';
// จุดเริ่มต้นของระบบ: เปิดฐานข้อมูล → สร้างแอดมินคนแรก → เปิดเว็บเซิร์ฟเวอร์ → เริ่มงานเบื้องหลัง
const http = require('node:http');
const config = require('./config');
const db = require('./db');
const logger = require('./lib/logger');
const { configWarnings } = require('./services/securityCheck');

async function start({ port = config.port, host = config.host } = {}) {
  db.open(config.dbFile);

  const providers = require('./providers');
  const orders = require('./services/orders');
  const users = require('./services/users');
  const worker = require('./services/worker');
  const { createQueue } = require('./services/queue');
  const { createApp } = require('./http/app');

  providers.configured(); // ตรวจว่า PROVIDER / PROVIDERS ถูกต้อง
  const queue = createQueue({
    handler: (id) => orders.dispatch(id),
    concurrency: config.provider.concurrency,
    minIntervalMs: config.provider.minIntervalMs,
  });
  orders.setEnqueue((id) => queue.push(id));
  await users.ensureAdmin();

  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  config.selfUrl = `http://127.0.0.1:${actualPort}`;

  worker.start();
  orders.recoverPending();

  logger.info('════════════════════════════════════════════════════');
  logger.info(` ระบบเติมเงินพร้อมใช้งาน`);
  logger.info(`   หน้าเว็บลูกค้า : ${config.publicUrl}/`);
  logger.info(`   หลังบ้านแอดมิน : ${config.publicUrl}/admin`);
  providers.configured().forEach((name, i) => {
    const p = providers.byName(name);
    const ready = p.configStatus();
    logger.info(`   ผู้ให้บริการ ${i + 1} : ${p.label}${ready.ready ? '' : ' — ยังตั้งค่าไม่ครบ (จะไม่ถูกเลือกส่งรายการ)'}`);
    if (!ready.ready) ready.missing.forEach((m) => logger.warn(`     - ขาด: ${m}`));
  });
  logger.info('════════════════════════════════════════════════════');
  for (const w of configWarnings()) logger.warn(`[ตรวจการตั้งค่า] ${w}`);

  async function close() {
    worker.stop();
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    let timer;
    // รอรายการที่กำลังส่งให้เสร็จก่อน (สูงสุด 30 วินาที) เพื่อไม่ให้ผลหาย
    await Promise.race([queue.idle(), new Promise((r) => { timer = setTimeout(r, 30000); })]);
    clearTimeout(timer);
    await Promise.race([closed, new Promise((r) => setTimeout(r, 2000).unref())]);
    server.closeAllConnections?.();
    db.close();
  }

  return { app, server, queue, port: actualPort, close };
}

if (require.main === module) {
  start()
    .then((instance) => {
      let closing = false;
      const shutdown = async (sig) => {
        if (closing) return;
        closing = true;
        logger.info(`ได้รับสัญญาณ ${sig} กำลังปิดระบบอย่างปลอดภัย (รอรายการที่กำลังส่งให้เสร็จ)...`);
        try {
          await instance.close();
        } finally {
          process.exit(0);
        }
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') logger.error(`พอร์ต ${config.port} ถูกใช้งานอยู่ กรุณาปิดโปรแกรมที่ใช้พอร์ตนี้ หรือเปลี่ยน PORT ใน .env`);
      else logger.error('เปิดระบบไม่สำเร็จ', err);
      process.exit(1);
    });
  process.on('unhandledRejection', (err) => logger.error('unhandledRejection', err));
}

module.exports = { start };
