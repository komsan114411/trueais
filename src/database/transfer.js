'use strict';
/**
 * ย้าย/กู้คืนข้อมูลเข้า PostgreSQL (ใช้ผ่าน npm run admin)
 *   restoreBackup(file)  กู้จากไฟล์สำรอง .json.gz — แทนที่ข้อมูลทั้งหมดในฐานข้อมูลปลายทาง
 *   importSqlite(file)   คัดลอกข้อมูลทั้งหมดจากไฟล์ SQLite เดิม (เช่น data/topup.db)
 * ทั้งสองอย่างทำใน transaction เดียว — ผิดพลาดกลางทาง = ไม่มีอะไรเปลี่ยน
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const db = require('../db');
const { TABLES, IDENTITY_TABLES } = require('./schema-postgres');

const BATCH_ROWS = 200;
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

function requirePostgres() {
  if (!db.isPostgres()) throw new Error('คำสั่งนี้ใช้กับ PostgreSQL เท่านั้น — ตั้ง DATABASE_URL ก่อน');
}

/** ฐานข้อมูลปลายทางมีข้อมูลการใช้งานแล้วหรือยัง (ข้อมูลตั้งต้นเครือข่าย/แพ็กเกจตัวอย่างไม่นับ) */
function usage() {
  const n = (t) => db.get(`SELECT COUNT(*) AS c FROM ${q(t)}`).c;
  return { users: n('users'), orders: n('orders'), deposits: n('deposits'), wallet_ledger: n('wallet_ledger') };
}
const hasUsage = () => Object.values(usage()).some((v) => v > 0);

const pgColumns = (table) => db.all(
  'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position',
  table,
).map((r) => r.c);

/** ลบข้อมูลทุกตารางแล้วใส่ข้อมูลจาก source(table) → { columns, rows: [[...], ...] } */
function replaceAll(source) {
  const counts = {};
  db.tx(() => {
    db.run(`TRUNCATE ${TABLES.map(q).join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      const target = new Set(pgColumns(t));
      const { columns, rows } = source(t) || { columns: [], rows: [] };
      const keep = columns.map((c, i) => [c, i]).filter(([c]) => target.has(c));
      counts[t] = rows.length;
      if (!rows.length) continue;
      if (!keep.length) throw new Error(`ตาราง ${t}: ไม่มีคอลัมน์ที่ตรงกัน`);
      const cols = keep.map(([c]) => q(c)).join(', ');
      const one = `(${keep.map(() => '?').join(', ')})`;
      for (let i = 0; i < rows.length; i += BATCH_ROWS) {
        const chunk = rows.slice(i, i + BATCH_ROWS);
        const params = [];
        for (const r of chunk) for (const [, idx] of keep) params.push(r[idx]);
        db.run(`INSERT INTO ${q(t)} (${cols}) VALUES ${chunk.map(() => one).join(', ')}`, ...params);
      }
    }
    // ตัวนับเลขที่ (id) ต่อจากค่าสูงสุดที่ใส่เข้าไป
    for (const t of IDENTITY_TABLES) {
      db.get(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${q(t)}), 0) + 1, false) AS v`);
    }
  });
  return counts;
}

/** อ่านไฟล์สำรอง .json.gz พร้อมตรวจว่าไฟล์ครบ (มีส่วนท้าย และจำนวนแถวตรงทุกตาราง) */
function readBackup(file) {
  let text;
  try {
    text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  } catch (e) {
    throw new Error(`อ่านไฟล์สำรอง ${file} ไม่ได้ (${e.code || e.message}) — ต้องเป็นไฟล์ .json.gz ที่ระบบสร้าง`);
  }
  const lines = text.split('\n');
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    header = null;
  }
  if (!header || header.format !== 'topup-backup') throw new Error('ไฟล์นี้ไม่ใช่ไฟล์สำรองของระบบ');
  const tables = new Map();
  let cur = null;
  let end = null;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const v = JSON.parse(lines[i]);
    if (Array.isArray(v)) {
      if (!cur) throw new Error('ไฟล์สำรองเสียหาย (ข้อมูลไม่มีชื่อตาราง)');
      cur.rows.push(v);
    } else if (v.table) {
      cur = { columns: v.columns, rows: [] };
      tables.set(v.table, cur);
    } else if (v.end) {
      end = v;
    }
  }
  if (!end) throw new Error('ไฟล์สำรองไม่สมบูรณ์ (ไม่มีส่วนท้าย) — อาจถูกตัดระหว่างคัดลอก ใช้ไฟล์อื่น');
  for (const [t, n] of Object.entries(end.counts || {})) {
    if ((tables.get(t)?.rows.length || 0) !== n) throw new Error(`ไฟล์สำรองไม่สมบูรณ์: ตาราง ${t} ควรมี ${n} แถว`);
  }
  return { header, tables, counts: end.counts };
}

function restoreBackup(file) {
  requirePostgres();
  const b = readBackup(file);
  const current = db.schemaVersion();
  if (b.header.schema_version !== current) {
    throw new Error(`ไฟล์สำรองเป็นโครงสร้างเวอร์ชัน ${b.header.schema_version} แต่ฐานข้อมูลนี้เป็นเวอร์ชัน ${current} — ใช้โปรแกรมเวอร์ชันเดียวกับตอนสำรอง`);
  }
  const counts = replaceAll((t) => b.tables.get(t));
  return { counts, created_at: b.header.created_at };
}

function importSqlite(file) {
  requirePostgres();
  if (!fs.existsSync(file)) throw new Error(`ไม่พบไฟล์ ${file}`);
  const { DatabaseSync } = require('node:sqlite');
  const { createSqlite } = require('./sqlite');
  // ทำสำเนาก่อน (ไม่แตะไฟล์ต้นฉบับ) แล้วปรับโครงสร้างสำเนาให้เป็นเวอร์ชันล่าสุด
  const tmp = path.join(os.tmpdir(), `topup-import-${process.pid}-${Date.now()}.db`);
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  const s = createSqlite(tmp);
  try {
    s.migrate();
    return replaceAll((t) => {
      const cols = s.all(`SELECT name FROM pragma_table_info('${t}')`, []).map((r) => r.name);
      if (!cols.length) return null;
      const rows = s.all(`SELECT ${cols.map(q).join(', ')} FROM ${q(t)}`, []).map((r) => cols.map((c) => r[c]));
      return { columns: cols, rows };
    });
  } finally {
    s.close();
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  }
}

module.exports = { restoreBackup, importSqlite, readBackup, usage, hasUsage };
