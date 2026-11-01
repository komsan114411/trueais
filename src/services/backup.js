'use strict';
// สำรองฐานข้อมูลอัตโนมัติวันละครั้ง (เก็บ 14 ชุดล่าสุด) + สำรองทันทีจากหน้าแอดมิน
// ใช้ VACUUM INTO ซึ่งได้ไฟล์ที่สมบูรณ์แม้ระบบกำลังทำงานอยู่
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const logger = require('../lib/logger');
const { bangkokDate } = require('../lib/time');

const KEEP = 14;
const dir = () => path.join(config.dataDir, 'backups');

function list() {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir())
    .filter((f) => /^topup-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const st = fs.statSync(path.join(dir(), f));
      return { name: f, size: st.size, created_at: st.mtime.toISOString() };
    });
}

function backupNow() {
  fs.mkdirSync(dir(), { recursive: true });
  const bkk = new Date(Date.now() + 7 * 3600000).toISOString();
  const name = `topup-${bkk.slice(0, 10)}-${bkk.slice(11, 13)}${bkk.slice(14, 16)}.db`;
  const file = path.join(dir(), name);
  fs.rmSync(file, { force: true });
  db.raw().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  for (const old of list().slice(KEEP)) fs.rmSync(path.join(dir(), old.name), { force: true });
  logger.info(`สำรองฐานข้อมูลแล้ว: ${name}`);
  return { name, size: fs.statSync(file).size };
}

function dailyBackup() {
  const today = `topup-${bangkokDate()}-`;
  if (list().some((b) => b.name.startsWith(today))) return null;
  return backupNow();
}

module.exports = { list, backupNow, dailyBackup };
