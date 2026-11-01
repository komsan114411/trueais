'use strict';
/**
 * PostgreSQL สำหรับระบบ (ใช้เมื่อตั้ง DATABASE_URL)
 *
 * ทำไมยังเป็นแบบ synchronous: โค้ดส่วนเงินทั้งหมด (ตัดเงิน / คืนเงิน / อนุมัติสลิป / เปลี่ยนสถานะรายการ)
 * เขียนบนหลัก "transaction ทำงานรวดเดียว ไม่มีคำขออื่นแทรกกลาง" และผ่านการตรวจ/ทดสอบมาแล้ว
 * ชั้นนี้คงหลักเดิมไว้: ส่งคำสั่งไปเธรดเบื้องหลัง (pg-worker.js) แล้วรอคำตอบด้วย Atomics.wait
 *   - ใช้การเชื่อมต่อเดียว (เหมือน SQLite) — คำสั่งไม่มีทางแทรกกันกลาง transaction
 *   - ทุก transaction ถือล็อก advisory (เทียบเท่า BEGIN IMMEDIATE) กันโปรแกรมอื่น เช่น npm run admin เขียนแทรก
 *   - ข้อแลกเปลี่ยน: ระหว่างรอคำตอบเธรดหลักทำงานอื่นไม่ได้ → ฐานข้อมูลควรอยู่เครือข่ายเดียวกัน
 *     (เช่น Railway private network ~1ms ต่อคำสั่ง) คำสั่งของระบบเล็กและเร็วอยู่แล้ว
 *   - เธรดเบื้องหลังค้าง/ตาย (ไม่มีชีพจร) หรือรอนานเกิน → ยกเลิกคำสั่งนั้น แล้วเริ่มเธรดใหม่ในคำสั่งถัดไป
 *
 * ปรับ SQL ให้อัตโนมัติ: ? → $1.. , LIKE → ILIKE (SQLite ไม่สนตัวพิมพ์เล็ก/ใหญ่และไม่มีตัว escape),
 * INSERT ลงตารางที่มี id อัตโนมัติ → RETURNING id (ได้ lastInsertRowid เหมือน SQLite)
 */
const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { MIGRATIONS, IDENTITY_TABLES, TABLES } = require('./schema-postgres');

const WAIT_SLICE_MS = 500;
const HEARTBEAT_LOSS_MS = 10000;
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const INSERT_RE = /^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i;
const IDENTITY = new Set(IDENTITY_TABLES);

const dbError = (code, message) => Object.assign(new Error(message), { code });

function toError(e, sql) {
  const err = new Error(e.message || 'database error');
  err.name = 'DatabaseError';
  for (const k of ['code', 'detail', 'constraint', 'table', 'column', 'hint', 'severity']) if (e[k] != null) err[k] = e[k];
  if (sql) err.sql = sql.length > 300 ? `${sql.slice(0, 300)}…` : sql;
  return err;
}

function cleanParams(params) {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number') {
      // SQLite เทียบค่าแบบนี้แล้วแค่ "ไม่พบ" — PostgreSQL จะ error ทั้งคำสั่ง จึงส่งเป็น NULL (ไม่ตรงกับแถวใด)
      if (!Number.isFinite(p) || (Number.isInteger(p) && !Number.isSafeInteger(p))) return null;
      return p;
    }
    if (typeof p === 'bigint') return p.toString();
    // PostgreSQL เก็บอักขระ NUL ในข้อความไม่ได้
    if (typeof p === 'string' && p.includes('\u0000')) return p.replace(/\u0000/g, '');
    return p;
  });
}

/** แปลง SQL แบบ SQLite (ที่ระบบใช้) → PostgreSQL — ข้ามข้อความในเครื่องหมายคำพูดและคอมเมนต์ */
function translate(sql) {
  let out = '';
  let n = 0;
  const len = sql.length;
  for (let i = 0; i < len; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (; j < len; j++) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j++; continue; }
          break;
        }
      }
      out += sql.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const e = j < 0 ? len : j;
      out += sql.slice(i, e);
      i = e - 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const e = j < 0 ? len : j + 2;
      out += sql.slice(i, e);
      i = e - 1;
      continue;
    }
    if (ch === '?') {
      out += `$${++n}`;
      continue;
    }
    if ((ch === 'L' || ch === 'l') && /^like\b/i.test(sql.slice(i, i + 5)) && !/[A-Za-z0-9_]/.test(sql[i - 1] || '')) {
      let j = i + 4;
      while (j < len && /\s/.test(sql[j])) j++;
      if (sql[j] === '?') {
        out += `ILIKE $${++n} ESCAPE ''`;
        i = j;
      } else {
        out += 'ILIKE';
        i += 3;
      }
      continue;
    }
    out += ch;
  }
  const m = INSERT_RE.exec(sql);
  if (m && IDENTITY.has(m[1].toLowerCase()) && !/\bRETURNING\b/i.test(sql)) out += ' RETURNING id';
  return out;
}

function createPostgres({ url, schema = null, timeouts = {} }) {
  if (schema && !SCHEMA_RE.test(schema)) throw dbError('DB_CONFIG', 'PG_SCHEMA ต้องเป็นตัวอักษร a-z ตัวเลข หรือ _ เท่านั้น');
  const t = {
    connectMs: 10000,
    statementMs: 30000,
    queryMs: 35000,
    idleTxMs: 120000,
    ...timeouts,
  };
  const callTimeoutMs = Math.max(t.queryMs || 0, t.connectMs || 0) + 10000;
  const cache = new Map();
  let w = null;
  let gen = 0;
  let txDepth = 0;
  let txGen = 0;
  let asyncSeq = 0;
  const waiting = new Map();

  function spawn() {
    const sync = new MessageChannel();
    const side = new MessageChannel();
    const shared = new SharedArrayBuffer(8);
    const worker = new Worker(path.join(__dirname, 'pg-worker.js'), {
      workerData: { syncPort: sync.port2, asyncPort: side.port2, shared, url, schema, timeouts: t },
      transferList: [sync.port2, side.port2],
    });
    worker.unref();
    worker.on('error', () => {}); // เธรดหลักรู้จากชีพจรที่หยุด (กำลังรอ Atomics.wait อยู่จึงรับ event ไม่ได้)
    const me = { worker, port: sync.port1, side: side.port1, signal: new Int32Array(shared), seq: 0, gen: ++gen };
    side.port1.on('message', (m) => {
      const p = waiting.get(m.id);
      if (!p) return;
      waiting.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(toError(m.error));
    });
    side.port1.unref();
    worker.on('exit', () => {
      if (w === me) w = null;
      for (const [id, p] of waiting) {
        if (p.gen === me.gen) {
          waiting.delete(id);
          p.reject(dbError('DB_WORKER_DEAD', 'การเชื่อมต่อฐานข้อมูลหยุดทำงาน'));
        }
      }
    });
    w = me;
    return me;
  }

  function kill(me) {
    if (w === me) w = null;
    me.worker.terminate().catch(() => {});
  }

  /** ส่งคำสั่งแล้วรอคำตอบ (บล็อกเธรดหลักจนได้ผล — ดูคำอธิบายด้านบน) */
  function call(msg) {
    if (txDepth > 0 && (!w || w.gen !== txGen)) {
      throw dbError('DB_TX_LOST', 'การเชื่อมต่อฐานข้อมูลหลุดระหว่างทำรายการ — รายการนี้ถูกยกเลิกทั้งหมด ลองใหม่อีกครั้ง');
    }
    const me = w || spawn();
    const id = ++me.seq;
    Atomics.store(me.signal, 0, 0);
    me.port.postMessage({ ...msg, id });
    const started = Date.now();
    let beat = Atomics.load(me.signal, 1);
    let beatAt = started;
    for (;;) {
      Atomics.wait(me.signal, 0, 0, WAIT_SLICE_MS);
      const got = receiveMessageOnPort(me.port);
      if (got) {
        const m = got.message;
        if (m.id === id) {
          if (m.ok) return m.result;
          throw toError(m.error, msg.sql);
        }
        Atomics.store(me.signal, 0, 0); // คำตอบเก่าที่ค้าง (ไม่ควรเกิด) — ข้ามแล้วรอคำตอบของคำสั่งนี้ต่อ
        continue;
      }
      const now = Date.now();
      const b = Atomics.load(me.signal, 1);
      if (b !== beat) {
        beat = b;
        beatAt = now;
      }
      if (now - beatAt > HEARTBEAT_LOSS_MS) {
        kill(me);
        throw dbError('DB_WORKER_DEAD', 'การเชื่อมต่อฐานข้อมูลหยุดตอบสนอง — ระบบจะเชื่อมต่อใหม่ในคำสั่งถัดไป');
      }
      if (now - started > callTimeoutMs) {
        kill(me);
        throw dbError('DB_TIMEOUT', 'ฐานข้อมูลตอบช้าเกินกำหนด — ระบบจะเชื่อมต่อใหม่ในคำสั่งถัดไป');
      }
    }
  }

  function query(sql, params) {
    let text = cache.get(sql);
    if (text === undefined) {
      text = translate(sql);
      cache.set(sql, text);
    }
    return call({ op: 'query', sql: text, params: cleanParams(params) });
  }

  const get = (sql, params) => query(sql, params).rows[0];
  const all = (sql, params) => query(sql, params).rows;
  const run = (sql, params) => {
    const r = query(sql, params);
    return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id };
  };
  const exec = (sql) => {
    call({ op: 'exec', sql });
  };

  function tx(fn) {
    if (txDepth > 0) {
      const sp = `sp_${txDepth}`;
      exec(`SAVEPOINT ${sp}`);
      txDepth++;
      try {
        const r = fn();
        if (r && typeof r.then === 'function') throw new Error('tx callback must be synchronous');
        exec(`RELEASE SAVEPOINT ${sp}`);
        return r;
      } catch (e) {
        try {
          exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          exec(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          /* transaction ชั้นนอกจะล้มเหลวเอง */
        }
        throw e;
      } finally {
        txDepth--;
      }
    }
    call({ op: 'begin' });
    txDepth = 1;
    txGen = w.gen;
    try {
      const r = fn();
      if (r && typeof r.then === 'function') throw new Error('tx callback must be synchronous');
      call({ op: 'commit' });
      return r;
    } catch (e) {
      try {
        if (w && w.gen === txGen) call({ op: 'rollback' });
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      txDepth = 0;
    }
  }

  function migrate() {
    tx(() => {
      exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      let row = get('SELECT version FROM schema_version', []);
      if (!row) {
        run('INSERT INTO schema_version (version) VALUES (0)', []);
        row = { version: 0 };
      }
      if (row.version > MIGRATIONS.length) {
        throw dbError('DB_SCHEMA_NEWER', `ฐานข้อมูลเป็นเวอร์ชัน ${row.version} ใหม่กว่าโปรแกรมนี้ (${MIGRATIONS.length}) — อัปเดตโปรแกรมก่อน`);
      }
      for (let v = row.version; v < MIGRATIONS.length; v++) {
        exec(MIGRATIONS[v]);
        run('UPDATE schema_version SET version = ?', [v + 1]);
      }
    });
  }

  const schemaVersion = () => get('SELECT version FROM schema_version', [])?.version || 0;

  /** สำรองข้อมูลทั้งหมดเป็นไฟล์ .json.gz (ทำในเธรดเบื้องหลังด้วยการเชื่อมต่อแยก — ระบบทำงานต่อได้ระหว่างสำรอง) */
  function backupTo(file, header = {}) {
    const me = w || spawn();
    const id = ++asyncSeq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, gen: me.gen });
      me.side.postMessage({ id, op: 'backup', file, tables: TABLES, header: { format: 'topup-backup', version: 1, dialect: 'postgres', created_at: new Date().toISOString(), ...header } });
    });
  }

  function connect() {
    return call({ op: 'connect' });
  }

  function close() {
    const me = w;
    if (!me) return;
    try {
      call({ op: 'close' });
    } catch {
      /* ignore */
    }
    kill(me);
  }

  const api = {
    dialect: 'postgres',
    get, all, run, exec, tx, migrate, schemaVersion, backupTo, connect, close,
    inTx: () => txDepth > 0,
  };
  api.raw = () => api;
  return api;
}

module.exports = { createPostgres, translate };
