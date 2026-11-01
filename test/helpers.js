'use strict';
// ตัวช่วยสำหรับการทดสอบ: เปิดเซิร์ฟเวอร์ด้วยฐานข้อมูลชั่วคราว + HTTP client ที่จำ cookie/CSRF
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// รหัสผ่านสำหรับทดสอบ (ต้องผ่านกฎรหัสผ่าน: ไม่ใช่รหัสยอดนิยมที่เดาง่าย)
const ADMIN_PASSWORD = 'Adm1n-Test-Pass9';
const CUSTOMER_PASSWORD = 'Cust0mer-Pass7';

function setupEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topup-test-'));
  Object.assign(process.env, {
    ENV_FILE: 'none',
    NODE_ENV: 'test',
    DATA_DIR: dir,
    DISABLE_WORKER: '1',
    ADMIN_EMAIL: 'admin@test.local',
    ADMIN_PASSWORD,
    WEBHOOK_ALLOW_PRIVATE: '1',
    PROVIDER: 'mock',
    PROVIDER_MIN_INTERVAL_MS: '0',
    PROVIDER_CONCURRENCY: '4',
    REGISTER_LIMIT_PER_HOUR: '1000',
    LOGIN_LIMIT_PER_MINUTE: '1000',
    API_LIMIT_PER_MINUTE: '100000',
    ...extra,
  });
  return dir;
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.csrf = null;
  }

  async req(method, url, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.csrf) h['X-CSRF-Token'] = this.csrf;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(this.base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /sid=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `sid=${m[1]}` : '';
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    if (json?.data?.csrf) this.csrf = json.data.csrf;
    return { status: res.status, body: json, text, headers: res.headers };
  }

  get(url, headers) { return this.req('GET', url, undefined, headers); }
  post(url, body = {}, headers) { return this.req('POST', url, body, headers); }
  put(url, body = {}, headers) { return this.req('PUT', url, body, headers); }
  del(url, headers) { return this.req('DELETE', url, undefined, headers); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

module.exports = { setupEnv, Client, sleep, waitFor, ADMIN_PASSWORD, CUSTOMER_PASSWORD };
