'use strict';
// ฐานข้อมูล SQLite (มีในตัว Node.js) — ไฟล์เดียวในเครื่อง ใช้เมื่อไม่ได้ตั้ง DATABASE_URL
const fs = require('node:fs');
const path = require('node:path');
const { MIGRATIONS } = require('./schema-sqlite');

function clean(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

function createSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // synchronous = FULL: บันทึกลงดิสก์จริงทุกครั้งที่ commit — ไฟดับ/เครื่องค้างก็ไม่ทำให้รายการที่ "จองส่งแล้ว" ย้อนกลับ
  // (ถ้าย้อนกลับเป็น pending ระบบอาจส่งรายการเดิมซ้ำ) ช้าลงเล็กน้อยแต่ปลอดภัยกว่าสำหรับระบบที่เกี่ยวกับเงิน
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');

  const stmtCache = new Map();
  let txDepth = 0;

  function prep(sql) {
    let s = stmtCache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmtCache.set(sql, s);
    }
    return s;
  }

  const get = (sql, params) => prep(sql).get(...clean(params));
  const all = (sql, params) => prep(sql).all(...clean(params));
  const run = (sql, params) => {
    const r = prep(sql).run(...clean(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  };

  /** transaction (BEGIN IMMEDIATE = ล็อกการเขียนทันที กันการตัดเงินซ้อนกัน) — fn ต้องเป็น synchronous */
  function tx(fn) {
    if (txDepth > 0) {
      const sp = `sp_${txDepth}`;
      db.exec(`SAVEPOINT ${sp}`);
      txDepth++;
      try {
        const r = fn();
        if (r && typeof r.then === 'function') throw new Error('tx callback must be synchronous');
        db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        txDepth--;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    txDepth = 1;
    try {
      const r = fn();
      if (r && typeof r.then === 'function') throw new Error('tx callback must be synchronous');
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      txDepth = 0;
    }
  }

  function migrate() {
    const current = db.prepare('PRAGMA user_version').get().user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      tx(() => {
        db.exec(MIGRATIONS[v]);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  const schemaVersion = () => db.prepare('PRAGMA user_version').get().user_version;

  /** สำเนาฐานข้อมูลทั้งไฟล์ (สมบูรณ์แม้ระบบกำลังทำงาน) */
  function backupTo(target) {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return { size: fs.statSync(target).size };
  }

  function close() {
    stmtCache.clear();
    db.close();
  }

  return {
    dialect: 'sqlite',
    get, all, run, tx, migrate, schemaVersion, backupTo, close,
    exec: (sql) => db.exec(sql),
    inTx: () => txDepth > 0,
    raw: () => db,
  };
}

module.exports = { createSqlite };
