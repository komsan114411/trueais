'use strict';
/**
 * สำรองฐานข้อมูลอัตโนมัติวันละครั้ง + สำรองทันทีจากหน้าแอดมิน
 *   SQLite     → ไฟล์ .db ทั้งก้อน (VACUUM INTO — สมบูรณ์แม้ระบบกำลังทำงาน) ใช้แทนไฟล์เดิมได้ทันที
 *   PostgreSQL → ไฟล์ .json.gz ทุกตารางจาก snapshot เดียวกัน (ระบบทำงานต่อได้ระหว่างสำรอง)
 *                กู้คืน: npm run admin -- restore <ไฟล์>
 * เก็บสำเนาล่าสุดของแต่ละวัน 14 วัน + สำเนาล่าสุด 10 ชุด (รวมที่กดสำรองเอง)
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const logger = require('../lib/logger');
const { bangkokDate } = require('../lib/time');

const KEEP_DAYS = 14;
const KEEP_RECENT = 10;
const NAME_RE = /^topup-\d{4}-\d{2}-\d{2}-\d{4}\.(?:db|json\.gz)$/;
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

let inFlight = null;

/** สำรองทันที — กดซ้ำระหว่างกำลังสำรองจะได้ผลของรอบเดียวกัน (ไม่สำรองซ้อน) */
function backupNow() {
  if (!inFlight) {
    inFlight = (async () => {
      fs.mkdirSync(dir(), { recursive: true });
      const bkk = new Date(Date.now() + 7 * 3600000).toISOString();
      const ext = db.isPostgres() ? 'json.gz' : 'db';
      const name = `topup-${bkk.slice(0, 10)}-${bkk.slice(11, 13)}${bkk.slice(14, 16)}.${ext}`;
      const file = path.join(dir(), name);
      fs.rmSync(file, { force: true });
      await db.backupTo(file);
      prune();
      const size = fs.statSync(file).size;
      logger.info(`สำรองฐานข้อมูลแล้ว: ${name}`);
      return { name, size };
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
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

async function dailyBackup() {
  const today = `topup-${bangkokDate()}-`;
  if (list().some((b) => b.name.startsWith(today))) return null;
  return backupNow();
}

module.exports = { list, backupNow, dailyBackup, filePath };
