'use strict';
/**
 * ฐานข้อมูลของระบบ — เลือกให้อัตโนมัติ
 *   - ตั้ง DATABASE_URL=postgres://...  → PostgreSQL (แนะนำเมื่อขึ้นคลาวด์ เช่น Railway)
 *   - ไม่ตั้ง                         → SQLite ไฟล์เดียวในเครื่อง (data/topup.db) แบบเดิม
 * ทั้งสองแบบใช้คำสั่งชุดเดียวกัน (SQL ที่ใช้ได้ทั้งคู่) และทำงานแบบ synchronous เหมือนกัน
 * (เหตุผลอยู่ใน database/postgres.js) — เงินทุกจำนวนเก็บเป็น "สตางค์" (จำนวนเต็ม)
 */
const crypto = require('node:crypto');
const { seed } = require('./database/seed');

let impl = null;

const nowIso = () => new Date().toISOString();

function need() {
  if (!impl) throw new Error('ฐานข้อมูลยังไม่ได้เปิด (เรียก db.open ก่อน)');
  return impl;
}

const get = (sql, ...params) => need().get(sql, params);
const all = (sql, ...params) => need().all(sql, params);
const run = (sql, ...params) => need().run(sql, params);

/** ทำงานใน transaction (ล็อกการเขียนทันที กันการตัดเงินซ้อนกัน) — fn ต้องเป็นฟังก์ชัน synchronous เท่านั้น */
const tx = (fn) => need().tx(fn);

const databaseUrl = () => String(process.env.DATABASE_URL || '').trim();
const isPostgres = () => (impl ? impl.dialect === 'postgres' : Boolean(databaseUrl()));

/**
 * schema ของ PostgreSQL ที่ใช้ (ค่าเริ่มต้น = public)
 * ตอนรันทดสอบ แต่ละโปรเซสได้ schema ใหม่ของตัวเอง (ข้อมูลไม่ปนกัน) และส่งต่อให้โปรเซสลูกผ่าน PG_SCHEMA
 */
function pgSchema() {
  const s = String(process.env.PG_SCHEMA || '').trim();
  if (s) return s;
  if (process.env.NODE_ENV === 'test') {
    const prefix = /^[a-z][a-z0-9]{0,20}$/.test(process.env.PG_SCHEMA_PREFIX || '') ? process.env.PG_SCHEMA_PREFIX : 't';
    const gen = `${prefix}_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
    process.env.PG_SCHEMA = gen;
    return gen;
  }
  return null;
}

function open(file) {
  if (impl) return impl.raw();
  const url = databaseUrl();
  let d;
  if (url) {
    const { createPostgres } = require('./database/postgres');
    d = createPostgres({ url, schema: pgSchema() });
  } else {
    const { createSqlite } = require('./database/sqlite');
    d = createSqlite(file);
  }
  try {
    if (d.connect) d.connect();
    d.migrate();
    impl = d;
    tx(() => seed(module.exports, nowIso()));
  } catch (err) {
    impl = null;
    try {
      d.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return impl.raw();
}

function close() {
  if (!impl) return;
  const d = impl;
  impl = null;
  d.close();
}

/** แบ่งหน้า: คืน { rows, total, page, pageSize, pages } */
function paged({ select, from, where = [], params = [], order, page = 1, pageSize = 20, selectParams = [] }) {
  const size = Math.min(Math.max(Number.parseInt(pageSize, 10) || 20, 1), 200);
  // จำกัดเลขหน้า (เลขใหญ่เกินจะทำให้ OFFSET ผิดชนิดข้อมูล)
  const p = Math.min(Math.max(Number.parseInt(page, 10) || 1, 1), 100000);
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS c FROM ${from}${whereSql}`, ...params).c;
  // selectParams = ค่าสำหรับ ? ในส่วน SELECT (มาก่อน params ของ WHERE)
  const rows = all(`SELECT ${select} FROM ${from}${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...selectParams, ...params, size, (p - 1) * size);
  return { rows, total, page: p, pageSize: size, pages: Math.max(1, Math.ceil(total / size)) };
}

/**
 * SQL ที่ต่างกันระหว่างสองฐานข้อมูล (คอลัมน์เวลาเก็บเป็นข้อความ ISO เวลา UTC)
 * เวลาไทย = UTC+7 ตลอดปี (ไม่มีเวลาออมแสง)
 */
const sql = {
  /** วันที่ตามเวลาไทย YYYY-MM-DD */
  bkkDay: (col) => (isPostgres()
    ? `to_char(((${col})::timestamptz AT TIME ZONE 'UTC') + interval '7 hours', 'YYYY-MM-DD')`
    : `date(${col}, '+7 hours')`),
  /** เดือนตามเวลาไทย YYYY-MM */
  bkkMonth: (col) => (isPostgres()
    ? `to_char(((${col})::timestamptz AT TIME ZONE 'UTC') + interval '7 hours', 'YYYY-MM')`
    : `strftime('%Y-%m', ${col}, '+7 hours')`),
};

/** ข้อผิดพลาดจากค่าซ้ำใน unique index (ทั้งสองฐานข้อมูล) */
const isUniqueViolation = (err) => err?.code === '23505' || /UNIQUE constraint failed/i.test(String(err?.message || ''));

/** สำรองฐานข้อมูลลงไฟล์ (SQLite = ไฟล์ .db ทั้งก้อน, PostgreSQL = .json.gz) — คืน Promise */
async function backupTo(file, header) {
  return need().backupTo(file, header);
}

module.exports = {
  open,
  close,
  get,
  all,
  run,
  tx,
  paged,
  nowIso,
  sql,
  isPostgres,
  isUniqueViolation,
  backupTo,
  dialect: () => (impl ? impl.dialect : isPostgres() ? 'postgres' : 'sqlite'),
  schemaVersion: () => need().schemaVersion(),
  inTx: () => Boolean(impl && impl.inTx()),
  isOpen: () => Boolean(impl),
  raw: () => (impl ? impl.raw() : null),
};
