'use strict';
// สำรองฐานข้อมูลอัตโนมัติวันละครั้ง (เก็บ 14 ชุดล่าสุด) + สำรองทันทีจากหน้าแอดมิน
// ใช้ VACUUM INTO ซึ่งได้ไฟล์ที่สมบูรณ์แม้ระบบกำลังทำงานอยู่
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const logger = require('../lib/logger');
const { bangkokDate } = require('../lib/time');

const KEEP_DAYS = 14; // เก็บสำเนาล่าสุดของแต่ละวัน 14 วัน
const KEEP_RECENT = 10; // + สำเนาล่าสุด 10 ชุด (รวมที่กดสำรองเอง)
const NAME_RE = /^topup-\d{4}-\d{2}-\d{2}-\d{4}\.db$/;
const dir = () => path.join(config.dataDir, 'backups');

function list() {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir())
    .filter((f) => NAME_RE.test(f))
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
  prune();
  logger.info(`สำรองฐานข้อมูลแล้ว: ${name}`);
  return { name, size: fs.statSync(file).size };
}

function prune() {
  const all = list(); // ใหม่สุดก่อน
  const keep = new Set(all.slice(0, KEEP_RECENT).map((b) => b.name));
  const days = new Set();
  for (const b of all) {
    const day = b.name.slice(6, 16);
    if (!days.has(day) && days.size < KEEP_DAYS) {
      days.add(day);
      keep.add(b.name);
    }
  }
  for (const b of all) if (!keep.has(b.name)) fs.rmSync(path.join(dir(), b.name), { force: true });
}

/** ที่อยู่ไฟล์สำรองสำหรับดาวน์โหลด (ชื่อต้องตรงรูปแบบและมีอยู่จริง กันอ่านไฟล์อื่นในเครื่อง) */
function filePath(name) {
  const n = String(name || '');
  if (!NAME_RE.test(n)) return null;
  const file = path.join(dir(), n);
  return fs.existsSync(file) ? file : null;
}

function dailyBackup() {
  const today = `topup-${bangkokDate()}-`;
  if (list().some((b) => b.name.startsWith(today))) return null;
  return backupNow();
}

module.exports = { list, backupNow, dailyBackup, filePath };
