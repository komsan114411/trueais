'use strict';
/**
 * รันชุดทดสอบทั้งหมดกับ PostgreSQL (npm run test:pg)
 *   - ไม่ตั้ง TEST_DATABASE_URL → เปิด PostgreSQL จำลองในหน่วยความจำ (PGlite) ให้เอง ไม่ต้องติดตั้งอะไรเพิ่ม
 *   - ตั้ง TEST_DATABASE_URL=postgres://... → ใช้ฐานข้อมูลนั้น (แต่ละไฟล์ทดสอบได้ schema ของตัวเอง แล้วลบทิ้งตอนจบ)
 * ห้ามชี้ไปที่ฐานข้อมูลที่ใช้งานจริง
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

async function startPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const pglite = await PGlite.create();
  const server = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1', maxConnections: 8 });
  await server.start();
  const addr = server.server?.address?.() || null;
  const port = addr?.port || server.port;
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop().catch(() => {});
      await pglite.close().catch(() => {});
    },
  };
}

async function dropRunSchemas(url, prefix) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT nspname FROM pg_namespace WHERE nspname LIKE $1', [`${prefix}%`]);
    for (const r of rows) await c.query(`DROP SCHEMA "${r.nspname.replace(/"/g, '""')}" CASCADE`);
  } finally {
    await c.end();
  }
}

async function main() {
  const external = String(process.env.TEST_DATABASE_URL || '').trim();
  const db = external ? { url: external, stop: async () => {} } : await startPglite();
  const run = `t${crypto.randomBytes(3).toString('hex')}`;
  const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test/*.test.js'];
  const env = { ...process.env, DATABASE_URL: db.url, PG_SCHEMA_PREFIX: run };
  delete env.PG_SCHEMA;
  console.log(`ทดสอบกับ PostgreSQL: ${external ? 'TEST_DATABASE_URL' : 'PGlite (จำลองในหน่วยความจำ)'}`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', ...files], {
      cwd: path.join(__dirname, '..'),
      env,
      stdio: 'inherit',
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  if (external) await dropRunSchemas(db.url, `${run}_`).catch((e) => console.error('ลบ schema ทดสอบไม่สำเร็จ:', e.message));
  await db.stop();
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
