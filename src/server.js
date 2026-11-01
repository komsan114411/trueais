'use strict';
// จุดเริ่มต้นของระบบ: ตรวจค่าตั้ง → เปิดฐานข้อมูล → สร้างแอดมินคนแรก → เปิดเว็บเซิร์ฟเวอร์ → เริ่มงานเบื้องหลัง
const http = require('node:http');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const logger = require('./lib/logger');
const { configWarnings } = require('./services/securityCheck');

const { ConfigError } = config;

// ───────────── แปลงข้อผิดพลาดตอนเปิดระบบ → บอกเจ้าของร้านว่าต้องแก้ค่าไหนใน .env ─────────────

function dbOpenError(err) {
  const reason = err?.message || String(err);
  if (/not a database|malformed|corrupt/i.test(reason)) {
    return new Error(`ไฟล์ฐานข้อมูล ${config.dbFile} เสียหาย (${reason}) — กู้คืนจากไฟล์สำรองในโฟลเดอร์ ${path.join(config.dataDir, 'backups')} ตามคู่มือ README หัวข้อ "สำรองข้อมูล / กู้คืน"`, { cause: err });
  }
  const text = `เปิดฐานข้อมูล ${config.dbFile} ไม่ได้ (${reason}) — ตรวจว่าโฟลเดอร์นี้มีอยู่และเขียนไฟล์ได้`;
  return process.env.DATA_DIR ? new ConfigError('DATA_DIR', text, err) : new Error(text, { cause: err });
}

// ช่องข้อมูลแอดมินคนแรก (field ที่ users.js บอกมา) → ตัวแปรใน .env
const ADMIN_ENV = { password: 'ADMIN_PASSWORD', email: 'ADMIN_EMAIL', name: 'ADMIN_NAME' };

/** สร้างแอดมินคนแรกจาก .env ไม่ผ่าน (เช่น ADMIN_PASSWORD สั้นไป / เดาง่าย) */
function adminSetupError(err) {
  const envVar = ADMIN_ENV[err?.details?.field];
  if (!envVar || !err.expose) return err;
  let hint = '';
  if (envVar === 'ADMIN_PASSWORD') hint = ' (หรือเว้นว่างไว้ ให้ระบบสุ่มรหัสให้)';
  if (err.code === 'EMAIL_TAKEN') hint = ' — ใช้อีเมลอื่นที่ยังไม่มีในระบบ';
  return new ConfigError(envVar, `${err.message}${hint}`, err);
}

function listenError(err, port, host) {
  if (err?.code === 'EADDRINUSE') {
    return new ConfigError('PORT', `พอร์ต ${port} ถูกโปรแกรมอื่นใช้อยู่ — ถ้าเปิดระบบนี้ค้างไว้อีกหน้าต่าง ให้ปิดหน้าต่างนั้นก่อน หรือเปลี่ยนเป็นเลขอื่น เช่น PORT=8080`, err);
  }
  if (err?.code === 'EACCES') {
    return new ConfigError('PORT', `ไม่มีสิทธิ์เปิดพอร์ต ${port} (เครื่องสงวนพอร์ตนี้ไว้) — เปลี่ยนเป็นเลขอื่น เช่น PORT=8080`, err);
  }
  if (err?.code === 'EADDRNOTAVAIL' || err?.code === 'ENOTFOUND') {
    return new ConfigError('HOST', `เครื่องนี้ใช้ที่อยู่ ${host} ไม่ได้ — ลบบรรทัด HOST ออก (ค่าเริ่มต้น 0.0.0.0)`, err);
  }
  return err;
}

/** ข้อความบรรทัดเดียวสำหรับเจ้าของร้าน: ผิดอะไร + แก้ที่ไหน (stack แสดงเฉพาะ DEBUG=1) */
function startupErrorLine(err) {
  const msg = String(err?.message || err).split('\n')[0];
  if (err instanceof ConfigError) return `เปิดระบบไม่สำเร็จ: ${msg} → แก้ไฟล์ .env แล้วเปิด start.bat ใหม่`;
  if (err?.code === 'MODULE_NOT_FOUND') {
    return `เปิดระบบไม่สำเร็จ: ติดตั้งแพ็กเกจไม่ครบ (${msg}) → ลบโฟลเดอร์ node_modules แล้วเปิด start.bat ใหม่ (ระบบจะติดตั้งให้)`;
  }
  return `เปิดระบบไม่สำเร็จ: ${msg}${config.debug ? '' : ' (ตั้ง DEBUG=1 ใน .env แล้วเปิดใหม่ เพื่อดูรายละเอียด)'}`;
}

/** PUBLIC_URL ชี้เครื่องนี้แต่คนละพอร์ตกับที่เปิดจริง (มักเกิดตอนเปลี่ยน PORT แล้วลืมแก้ PUBLIC_URL) */
function publicUrlWarnings(actualPort) {
  let u;
  try {
    u = new URL(config.publicUrl);
  } catch {
    return [];
  }
  const urlPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || urlPort === actualPort) return [];
  return [`PUBLIC_URL=${config.publicUrl} ใช้พอร์ต ${urlPort} แต่ระบบเปิดที่พอร์ต ${actualPort} — แก้เป็น PUBLIC_URL=http://localhost:${actualPort}`];
}

async function start({ port = config.port, host = config.host } = {}) {
  // ค่าใน .env ผิดร้ายแรง (เช่น PORT ไม่ใช่ตัวเลข) → ไม่เปิดระบบ
  if (config.errors.length) throw config.errors[0];
  try {
    db.open(config.dbFile);
  } catch (err) {
    throw dbOpenError(err);
  }

  const providers = require('./providers');
  const orders = require('./services/orders');
  const users = require('./services/users');
  const worker = require('./services/worker');
  const { createQueue } = require('./services/queue');
  const { createApp } = require('./http/app');

  try {
    providers.configured(); // ตรวจว่า PROVIDER / PROVIDERS ถูกต้อง
  } catch (err) {
    throw new ConfigError(process.env.PROVIDERS ? 'PROVIDERS' : 'PROVIDER', err.message, err);
  }
  const queue = createQueue({
    handler: (id) => orders.dispatch(id),
    concurrency: config.provider.concurrency,
    minIntervalMs: config.provider.minIntervalMs,
  });
  orders.setEnqueue((id) => queue.push(id));
  try {
    await users.ensureAdmin();
  } catch (err) {
    throw adminSetupError(err);
  }

  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000;
  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(listenError(err, port, host)));
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  config.selfUrl = `http://127.0.0.1:${actualPort}`;

  worker.start();
  orders.recoverPending();

  const localUrl = `http://localhost:${actualPort}`;
  logger.info('════════════════════════════════════════════════════');
  logger.info(` ระบบเติมเงินพร้อมใช้งาน`);
  logger.info(`   หน้าเว็บลูกค้า : ${config.publicUrl}/`);
  logger.info(`   หลังบ้านแอดมิน : ${config.publicUrl}/admin`);
  if (config.publicUrl !== localUrl) logger.info(`   เปิดจากเครื่องนี้ : ${localUrl}/`);
  providers.configured().forEach((name, i) => {
    const p = providers.byName(name);
    const ready = p.configStatus();
    logger.info(`   ผู้ให้บริการ ${i + 1} : ${p.label}${ready.ready ? '' : ' — ยังตั้งค่าไม่ครบ (จะไม่ถูกเลือกส่งรายการ)'}`);
    if (!ready.ready) ready.missing.forEach((m) => logger.warn(`     - ขาด: ${m}`));
  });
  logger.info('════════════════════════════════════════════════════');
  for (const w of [...config.warnings, ...publicUrlWarnings(actualPort)]) logger.warn(`[ตรวจไฟล์ .env] ${w}`);
  // configWarnings รวมคำเตือนจากไฟล์ .env ไว้แล้ว (สำหรับหน้าแดชบอร์ด) — ตอนเปิดระบบแสดงแค่ส่วนที่ไม่ซ้ำ
  for (const w of configWarnings().filter((x) => !x.startsWith('ไฟล์ .env: '))) logger.warn(`[ตรวจการตั้งค่า] ${w}`);

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
      // เจ้าของร้านเห็นบรรทัดเดียวว่าผิดอะไร แก้ที่ไหน — รายละเอียดทางเทคนิคเฉพาะเมื่อตั้ง DEBUG=1
      logger.error(startupErrorLine(err));
      if (config.debug) logger.error('รายละเอียดสำหรับผู้พัฒนา (DEBUG=1):', err?.cause instanceof Error ? err.cause : err);
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 1000).unref(); // เผื่อมีงานค้างที่ทำให้โปรแกรมไม่ปิดเอง
    });
  process.on('unhandledRejection', (err) => logger.error('unhandledRejection', err));
}

module.exports = { start, startupErrorLine };
