'use strict';
/**
 * เธรดเบื้องหลังที่คุยกับ PostgreSQL แทนเธรดหลัก (เปิดโดย database/postgres.js)
 *
 * เธรดหลักส่งคำสั่งมาแล้ว "รอ" จนได้คำตอบ (Atomics.wait) → โค้ดของระบบใช้ฐานข้อมูลแบบ synchronous
 * ได้เหมือน SQLite: transaction ทั้งก้อนทำงานรวดเดียว ไม่มีคำขออื่นแทรกกลาง
 *
 * ช่องทางสื่อสาร
 *   syncPort   คำสั่งที่เธรดหลักรอคำตอบ: connect / query / exec / begin / commit / rollback / close
 *   asyncPort  งานยาวที่เธรดหลักไม่ต้องรอ (สำรองข้อมูล) — ใช้การเชื่อมต่อแยกของตัวเอง
 *   signal[0]  ตั้งเป็น 1 แล้ว notify ทุกครั้งที่ตอบ syncPort
 *   signal[1]  ชีพจร (+1 ทุก 250ms) ให้เธรดหลักรู้ว่าเธรดนี้ยังไม่ค้าง/ไม่ตาย
 */
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { finished } = require('node:stream/promises');
const pg = require('pg');

// ตัวเลขจาก PostgreSQL → Number (เงินเป็นสตางค์ ไม่มีทางเกิน 2^53) และ boolean → 1/0 แบบ SQLite
pg.types.setTypeParser(20, (v) => Number(v)); // int8: BIGINT, COUNT(*)
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric: SUM() ของ BIGINT
pg.types.setTypeParser(16, (v) => (v === 't' ? 1 : 0)); // boolean

const { syncPort, asyncPort, shared, url, schema, timeouts } = workerData;
const signal = new Int32Array(shared);
const WRITE_LOCK = 7425301; // ล็อก advisory ของทุก transaction เขียน (เทียบเท่า BEGIN IMMEDIATE ของ SQLite)
const RECONNECT_COOLDOWN_MS = 2000;

setInterval(() => Atomics.add(signal, 1, 1), 250);

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

function clientConfig() {
  const c = {
    connectionString: url,
    connectionTimeoutMillis: timeouts.connectMs,
    keepAlive: true,
    application_name: 'topup',
  };
  if (timeouts.statementMs) c.statement_timeout = timeouts.statementMs;
  if (timeouts.queryMs) c.query_timeout = timeouts.queryMs;
  if (timeouts.idleTxMs) c.idle_in_transaction_session_timeout = timeouts.idleTxMs;
  return c;
}

async function setupSession(c, { create = true } = {}) {
  if (!schema) return;
  await c.query(`${create ? `CREATE SCHEMA IF NOT EXISTS ${ident(schema)}; ` : ''}SET search_path TO ${ident(schema)}`);
}

// ข้อผิดพลาดจากเซิร์ฟเวอร์ (มีรหัส SQLSTATE) ไม่ทำให้การเชื่อมต่อเสีย ยกเว้นกลุ่ม 08 (การเชื่อมต่อ) และ 57P0x (เซิร์ฟเวอร์ปิด)
const isConnectionError = (e) => !(e instanceof pg.DatabaseError) || /^08|^57P0[1-3]$/.test(e.code || '');

function serializeError(e) {
  const out = { message: (e && e.message) || String(e) };
  for (const k of ['code', 'detail', 'constraint', 'table', 'column', 'hint', 'severity']) {
    if (e && e[k] != null) out[k] = String(e[k]);
  }
  return out;
}

const dbError = (code, message) => Object.assign(new Error(message), { code });

// ───────────── การเชื่อมต่อหลัก (คำสั่งที่เธรดหลักรอ) ─────────────
let client = null;
let downUntil = 0;
let lastConnectError = null;
let txState = null; // null = ไม่ได้อยู่ใน transaction | { failed, broken }

function dropClient() {
  const c = client;
  client = null;
  if (txState) txState.broken = true;
  if (c) c.end().catch(() => {});
}

async function connection() {
  if (client) return client;
  if (txState) throw dbError('DB_TX_LOST', 'การเชื่อมต่อฐานข้อมูลหลุดระหว่างทำรายการ — รายการนี้ถูกยกเลิกทั้งหมด ลองใหม่อีกครั้ง');
  if (Date.now() < downUntil && lastConnectError) throw lastConnectError;
  const c = new pg.Client(clientConfig());
  c.on('error', () => { if (client === c) dropClient(); });
  try {
    await c.connect();
    await setupSession(c);
  } catch (e) {
    c.end().catch(() => {});
    lastConnectError = e;
    downUntil = Date.now() + RECONNECT_COOLDOWN_MS;
    throw e;
  }
  client = c;
  lastConnectError = null;
  return c;
}

async function runQuery(text, values, { simple = false } = {}) {
  if (txState?.broken) throw dbError('DB_TX_LOST', 'การเชื่อมต่อฐานข้อมูลหลุดระหว่างทำรายการ — รายการนี้ถูกยกเลิกทั้งหมด ลองใหม่อีกครั้ง');
  const c = await connection();
  try {
    return simple ? await c.query(text) : await c.query(text, values);
  } catch (e) {
    if (txState) txState.failed = true; // PostgreSQL ยกเลิก transaction ทั้งก้อนเมื่อมีคำสั่งผิดพลาด
    if (isConnectionError(e)) dropClient();
    throw e;
  }
}

async function handleSync(m) {
  switch (m.op) {
    case 'connect': {
      const r = await runQuery('SELECT current_setting(\'server_version\') AS v', []);
      return { version: r.rows[0].v };
    }
    case 'query': {
      const r = await runQuery(m.sql, m.params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    }
    case 'exec': {
      await runQuery(m.sql, null, { simple: true });
      // ย้อนกลับไปจุด SAVEPOINT สำเร็จ = transaction กลับมาใช้ต่อได้ (เหมือนก่อนเกิดข้อผิดพลาด)
      if (txState && /^\s*ROLLBACK\s+TO\b/i.test(m.sql)) txState.failed = false;
      return null;
    }
    case 'begin': {
      if (txState) throw dbError('DB_TX_NESTED', 'transaction ซ้อนกันผิดลำดับ');
      await connection();
      txState = { failed: false, broken: false };
      try {
        await runQuery(`BEGIN; SELECT pg_advisory_xact_lock(${WRITE_LOCK})`, null, { simple: true });
      } catch (e) {
        await rollbackQuietly();
        throw e;
      }
      return null;
    }
    case 'commit': {
      if (!txState) throw dbError('DB_NO_TX', 'ไม่มี transaction ที่เปิดอยู่');
      if (txState.broken) {
        txState = null;
        throw dbError('DB_TX_LOST', 'การเชื่อมต่อฐานข้อมูลหลุดระหว่างทำรายการ — รายการนี้ถูกยกเลิกทั้งหมด ลองใหม่อีกครั้ง');
      }
      if (txState.failed) {
        await rollbackQuietly();
        throw dbError('DB_TX_ABORTED', 'คำสั่งฐานข้อมูลผิดพลาดระหว่างทำรายการ — รายการนี้ถูกยกเลิกทั้งหมด');
      }
      let r;
      try {
        r = await runQuery('COMMIT', null, { simple: true });
      } catch (e) {
        txState = null;
        throw e;
      }
      txState = null;
      if (r.command !== 'COMMIT') throw dbError('DB_TX_ABORTED', 'ฐานข้อมูลยกเลิกรายการนี้ (ไม่ได้บันทึก)');
      return null;
    }
    case 'rollback':
      await rollbackQuietly();
      return null;
    case 'close':
      txState = null;
      if (client) {
        const c = client;
        client = null;
        await c.end().catch(() => {});
      }
      return null;
    default:
      throw new Error(`unknown op ${m.op}`);
  }
}

async function rollbackQuietly() {
  const st = txState;
  txState = null;
  if (st && !st.broken && client) {
    try {
      await client.query('ROLLBACK');
    } catch {
      dropClient();
    }
  }
}

function replySync(id, ok, payload) {
  try {
    syncPort.postMessage(ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload });
  } catch (e) {
    syncPort.postMessage({ id, ok: false, error: serializeError(e) });
  }
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

let chain = Promise.resolve();
syncPort.on('message', (m) => {
  chain = chain
    .then(() => handleSync(m))
    .then((result) => replySync(m.id, true, result), (err) => replySync(m.id, false, serializeError(err)));
});

// ───────────── งานยาวแบบไม่ต้องรอ (สำรองข้อมูล) — ใช้การเชื่อมต่อแยก ─────────────

/**
 * สำรองทุกตารางเป็นไฟล์ JSON ทีละบรรทัด (บีบอัด gzip) จาก snapshot เดียวกันทั้งไฟล์
 * (REPEATABLE READ READ ONLY = เห็นข้อมูล ณ วินาทีเริ่มสำรอง ไม่ขวางการทำงานของระบบ)
 */
async function backup({ file, tables, header }) {
  const c = new pg.Client({ ...clientConfig(), statement_timeout: 0, query_timeout: 0, idle_in_transaction_session_timeout: 0 });
  c.on('error', () => {});
  const tmp = `${file}.tmp`;
  let out = null;
  try {
    await c.connect();
    await setupSession(c, { create: false });
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const gz = zlib.createGzip();
    out = fs.createWriteStream(tmp);
    gz.pipe(out);
    const write = (text) => (gz.write(text) ? null : new Promise((resolve) => gz.once('drain', resolve)));
    const version = (await c.query('SELECT version FROM schema_version')).rows[0]?.version || 0;
    await write(`${JSON.stringify({ ...header, schema_version: version })}\n`);
    const counts = {};
    for (const t of tables) {
      const cols = (await c.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position',
        [t],
      )).rows.map((r) => r.column_name);
      await write(`${JSON.stringify({ table: t, columns: cols })}\n`);
      await c.query(`DECLARE bk NO SCROLL CURSOR FOR SELECT ${cols.map(ident).join(', ')} FROM ${ident(t)}`);
      let n = 0;
      for (;;) {
        const r = await c.query({ text: 'FETCH FORWARD 1000 FROM bk', rowMode: 'array' });
        if (!r.rows.length) break;
        n += r.rows.length;
        await write(`${r.rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      }
      await c.query('CLOSE bk');
      counts[t] = n;
    }
    await write(`${JSON.stringify({ end: true, counts })}\n`);
    await c.query('COMMIT');
    gz.end();
    await finished(out);
    fs.renameSync(tmp, file);
    return { size: fs.statSync(file).size, counts };
  } catch (e) {
    if (out) out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    await c.end().catch(() => {});
  }
}

asyncPort.on('message', async (m) => {
  try {
    if (m.op !== 'backup') throw new Error(`unknown op ${m.op}`);
    const result = await backup(m);
    asyncPort.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    asyncPort.postMessage({ id: m.id, ok: false, error: serializeError(e) });
  }
});

// ไม่ให้ข้อผิดพลาดหลุดแล้วเธรดตาย (เธรดหลักจะรอจนหมดเวลา) — ตัดการเชื่อมต่อทิ้งแล้วเริ่มใหม่ในคำสั่งถัดไป
process.on('uncaughtException', () => dropClient());
process.on('unhandledRejection', () => {});
