// ═══════════════════════════════════════════════════════════════
//  ไลบรารีกลางของหน้าเว็บ (ใช้ร่วมกันทั้งหน้าลูกค้าและหน้าแอดมิน)
//  - api(): เรียก API พร้อม CSRF + แปลง error เป็นภาษาไทย
//  - html``: template ที่ escape ข้อมูลอัตโนมัติ (กัน XSS)
//  - ตัวจัดรูปแบบเงิน/เบอร์/วันที่, toast, modal, router
// ═══════════════════════════════════════════════════════════════

// ───────────── HTML ที่ปลอดภัย ─────────────
export class Raw {
  constructor(s) { this.s = String(s); }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(s ?? '');

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderVal(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderVal).join('');
  return esc(v);
}

/** html`<b>${userText}</b>` → escape ค่าทุกตัว ยกเว้นที่ห่อด้วย raw() หรือเป็นผลจาก html`` */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += renderVal(vals[i]) + strings[i + 1];
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** event delegation: on(root, 'click', '[data-act]', (e, el) => …) */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  });
}

export function setHTML(el, content) {
  el.innerHTML = renderVal(content);
  return el;
}

// ───────────── API ─────────────
export class ApiError extends Error {
  constructor(code, message, status = 0, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const session = { user: null, csrf: null };

/**
 * CSRF token ไม่ผ่าน (เช่น เซสชันถูกสร้างใหม่) → ขอ token ใหม่จาก /api/auth/me
 * ใช้ต่อได้เฉพาะเมื่อยังเป็นบัญชีเดิม — กันทำรายการผิดบัญชีเมื่อมีการเข้าสู่ระบบบัญชีอื่นจากแท็บอื่น
 * คืน 'ok' | 'changed' | 'expired' | 'error'
 */
async function renewCsrf() {
  const uid = session.user?.id;
  let d;
  try {
    const res = await fetch('/api/auth/me', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    d = (await res.json())?.data;
  } catch {
    return 'error';
  }
  if (!d?.user) {
    if (session.user) {
      session.user = null;
      session.csrf = null;
      window.dispatchEvent(new CustomEvent('session-expired'));
    }
    return 'expired';
  }
  if (uid === undefined || d.user.id !== uid || !d.csrf) return 'changed';
  session.csrf = d.csrf;
  return 'ok';
}

const httpMessage = (status) => (status >= 500
  ? `ระบบขัดข้องชั่วคราว (HTTP ${status}) กรุณาลองใหม่อีกครั้ง`
  : status === 429 ? 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่' : `เกิดข้อผิดพลาด (HTTP ${status})`);

const TIMEOUT_MESSAGE = 'เซิร์ฟเวอร์ตอบช้าเกินไป (หมดเวลารอ) กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';

/**
 * timeout (ms): เลิกรอเมื่อเกินเวลา → แจ้งเป็น NETWORK (ไม่รู้ผล) ให้ส่งซ้ำด้วย idempotency key เดิมได้
 * (หมดเวลา → err.details.timeout = true และข้อความบอกว่าหมดเวลารอ)
 */
export async function api(method, path, body, { signal, timeout, retried = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.csrf && method !== 'GET') headers['X-CSRF-Token'] = session.csrf;
  const ctrl = timeout ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  if (ctrl && signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  // หมดเวลาที่เราตั้งเอง (ไม่ใช่ผู้เรียกสั่งยกเลิก)
  const timedOut = () => Boolean(ctrl?.signal.aborted) && !signal?.aborted;
  let res;
  let json = null;
  try {
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', signal: ctrl ? ctrl.signal : signal });
    } catch (e) {
      if (e.name === 'AbortError' && signal?.aborted) throw e;
      if (timedOut()) throw new ApiError('NETWORK', TIMEOUT_MESSAGE, 0, { timeout: true });
      throw new ApiError('NETWORK', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
    }
    try { json = await res.json(); } catch { /* ไม่ใช่ JSON (หรือหมดเวลาระหว่างอ่าน) */ }
  } finally {
    if (timer) clearTimeout(timer);
  }
  // หมดเวลาระหว่างอ่านคำตอบ → ไม่รู้ผล (เหมือนเน็ตหลุด) ไม่ใช่ "HTTP 200 ผิดพลาด"
  if (!json && timedOut()) throw new ApiError('NETWORK', TIMEOUT_MESSAGE, res?.status || 0, { timeout: true });
  if (!res.ok || !json || json.ok === false) {
    const err = json?.error;
    // 401 ของขั้นตอนเข้าสู่ระบบ (รหัสผ่าน/รหัส 2 ชั้นผิด) ไม่ใช่เซสชันหมดอายุ
    if (res.status === 401 && session.user && !['INVALID_CREDENTIALS', 'INVALID_CODE', 'MFA_EXPIRED'].includes(err?.code)) {
      session.user = null;
      session.csrf = null;
      window.dispatchEvent(new CustomEvent('session-expired'));
    }
    // CSRF ไม่ผ่าน: เซิร์ฟเวอร์ปฏิเสธก่อนทำอะไร → ขอ token ใหม่แล้วลองซ้ำได้ 1 ครั้ง (บัญชีเดิมเท่านั้น)
    if (res.status === 403 && err?.code === 'CSRF_INVALID' && !retried && session.user) {
      const r = await renewCsrf();
      if (r === 'ok') return api(method, path, body, { signal, timeout, retried: true });
      if (r === 'changed') {
        throw new ApiError('SESSION_CHANGED', 'มีการเข้าสู่ระบบด้วยบัญชีอื่นในเบราว์เซอร์นี้ กรุณารีเฟรชหน้าเว็บแล้วตรวจสอบบัญชีก่อนทำรายการ (รายการนี้ยังไม่ถูกดำเนินการ)', 403);
      }
    }
    throw new ApiError(err?.code || `HTTP_${res.status}`, err?.message || httpMessage(res.status), res.status, err?.details);
  }
  if (json.data && typeof json.data === 'object' && 'csrf' in json.data && json.data.csrf) session.csrf = json.data.csrf;
  return json.data;
}
api.get = (p, o) => api('GET', p, undefined, o);
api.post = (p, b = {}, o) => api('POST', p, b, o);
api.put = (p, b = {}, o) => api('PUT', p, b, o);
api.del = (p, o) => api('DELETE', p, undefined, o);

export async function loadMe() {
  const d = await api.get('/api/auth/me');
  session.user = d.user;
  session.csrf = d.csrf;
  return d.user;
}

export function qs(params = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

// ───────────── รูปแบบข้อมูล ─────────────
const nf2 = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });

/** สตางค์ → "1,234.50" */
export const baht = (satang) => nf2.format((Number(satang) || 0) / 100);
/** สตางค์ → "1,234" หรือ "1,234.50" ถ้ามีเศษ */
export const bahtShort = (satang) => {
  const n = (Number(satang) || 0) / 100;
  return Number.isInteger(n) ? nf0.format(n) : nf2.format(n);
};
export const numFmt = (n) => nf0.format(Number(n) || 0);
export const percent = (bp) => `${((Number(bp) || 0) / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 })}%`;

export function normalizePhone(input) {
  let s = String(input ?? '').replace(/[\s\-().]/g, '');
  if (s.startsWith('+66')) s = `0${s.slice(3)}`;
  else if (s.startsWith('66') && s.length === 11) s = `0${s.slice(2)}`;
  return /^0[689]\d{8}$/.test(s) ? s : null;
}
export const phoneFmt = (p) => String(p ?? '').replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');

const dtf = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const dtfSec = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const df = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric' });
export const dateTime = (iso) => (iso ? dtf.format(new Date(iso)) : '-');
export const dateTimeSec = (iso) => (iso ? dtfSec.format(new Date(iso)) : '-');
export const dateOnly = (iso) => (iso ? df.format(new Date(iso)) : '-');
/** วันที่วันนี้ (เวลาไทย) YYYY-MM-DD สำหรับ <input type="date"> */
export const todayBkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);

export function timeAgo(iso) {
  if (!iso) return '-';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'เมื่อสักครู่';
  if (s < 3600) return `${Math.round(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.round(s / 3600)} ชั่วโมงที่แล้ว`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} วันที่แล้ว`;
  return dateOnly(iso);
}

// ───────────── สถานะ ─────────────
export const STATUS = {
  pending: { label: 'รอดำเนินการ', cls: 'warning pulse' },
  processing: { label: 'กำลังดำเนินการ', cls: 'warning pulse' },
  success: { label: 'สำเร็จ', cls: 'success' },
  failed: { label: 'ไม่สำเร็จ (คืนเงินแล้ว)', cls: 'danger' },
  refunded: { label: 'คืนเงินแล้ว', cls: 'danger' },
};
export const statusBadge = (status, label) => {
  const s = STATUS[status] || { label: status, cls: '' };
  return html`<span class="badge ${s.cls}">${label || s.label}</span>`;
};

export const NETWORK_COLORS = { AIS: '#5ba829', TRUE: '#e4002b', DTAC: '#0097d8' };
export const NETWORK_NAMES = { AIS: 'AIS', TRUE: 'True', DTAC: 'dtac' };

const inkCache = new Map();
const relLum = (rgb) => {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
/**
 * สีแบรนด์ที่เข้มขึ้นพอให้อ่านง่าย (WCAG AA): ใช้เป็นพื้นหลังของตัวอักษรสีขาว หรือเป็นสีตัวอักษรบนพื้นสีอ่อน
 * เช่น เขียว AIS (#5ba829) ตัวอักษรขาวบนพื้นนี้อ่านยาก (≈3:1) → ได้สีเขียวเข้มที่ ≥ 5:1
 */
export function inkOf(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return '#4b5263';
  const key = m[1].toLowerCase();
  if (inkCache.has(key)) return inkCache.get(key);
  let rgb = [0, 2, 4].map((i) => parseInt(key.slice(i, i + 2), 16));
  // เผื่อพื้นสีอ่อน (tint) ที่สว่างน้อยกว่าสีขาวเล็กน้อย → ตั้งเป้า 5.2:1 เทียบกับสีขาว
  for (let i = 0; i < 40 && 1.05 / (relLum(rgb) + 0.05) < 5.2; i++) rgb = rgb.map((c) => c * 0.93);
  const out = `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
  inkCache.set(key, out);
  return out;
}

export const netBadge = (code, name) => {
  const c = NETWORK_COLORS[code] || '#777777';
  return html`<span class="net-badge" style="--net:${raw(c)};--net-ink:${raw(inkOf(c))}">${name || NETWORK_NAMES[code] || code}</span>`;
};

// ───────────── Toast ─────────────
/**
 * ที่วาง toast: หน้าต่าง (<dialog>) ที่เปิดอยู่บนสุด — ถ้าวางไว้นอกหน้าต่าง ฉากหลังของหน้าต่างจะบังจนมองไม่เห็นข้อความ
 */
function toastHost() {
  const open = Array.from(document.querySelectorAll('dialog[open]')).filter((d) => {
    try { return d.matches(':modal'); } catch { return true; } // เบราว์เซอร์เก่าไม่รู้จัก :modal
  });
  return open.length ? open[open.length - 1] : document.body;
}
function toastRootIn(host) {
  let root = Array.from(host.children).find((c) => c.classList.contains('toasts'));
  if (!root) {
    root = document.createElement('div');
    root.className = 'toasts';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    host.appendChild(root);
  }
  return root;
}
/** หน้าต่างกำลังปิด → ย้าย toast ที่ยังแสดงอยู่ออกมาที่หน้าเว็บ (ไม่หายไปพร้อมหน้าต่าง) */
function rehomeToasts(dlg) {
  const inner = Array.from(dlg.children).find((c) => c.classList.contains('toasts'));
  if (!inner || !inner.childElementCount) return;
  const root = toastRootIn(toastHost());
  while (inner.firstChild) root.appendChild(inner.firstChild);
}
export function toast(message, type = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastRootIn(toastHost()).appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}
export const toastError = (err) => toast(err?.message || 'เกิดข้อผิดพลาด', 'error', 5200);

// ───────────── Modal ─────────────
/**
 * เปิด modal: modal({ title, body (html), foot (html), wide, onMount(dialog, close) })
 * คืน Promise ที่ resolve เมื่อปิด (ค่าที่ส่งให้ close(value))
 */
export function modal({ title, body, foot, wide = false, onMount, dismissible = true } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = `modal${wide ? ' wide' : ''}`;
    dlg.innerHTML = renderVal(html`
      <div class="modal-head"><h3>${title}</h3>${dismissible ? html`<button class="btn ghost sm icon" data-close aria-label="ปิด">✕</button>` : ''}</div>
      <div class="modal-body">${body}</div>
      ${foot ? html`<div class="modal-foot">${foot}</div>` : ''}`);
    document.body.appendChild(dlg);
    let result;
    let done = false;
    // จบหน้าต่างทันทีเมื่อปิด (ไม่รอ event "close" ของเบราว์เซอร์ ซึ่งบางสถานะ เช่น แท็บอยู่เบื้องหลัง อาจมาช้ามาก)
    const finish = () => {
      if (done) return;
      done = true;
      rehomeToasts(dlg); // ข้อความที่แจ้งก่อนปิดหน้าต่าง (เช่น error) ต้องยังเห็นต่อ
      dlg.remove();
      resolve(result);
    };
    const close = (value) => {
      if (done) return;
      result = value;
      if (dlg.open) dlg.close();
      finish();
    };
    dlg.addEventListener('close', finish); // ปิดด้วยปุ่ม Esc / วิธีอื่นของเบราว์เซอร์
    dlg.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) close(undefined);
      else if (dismissible && e.target === dlg) close(undefined);
    });
    dlg.showModal();
    onMount?.(dlg, close);
  });
}

/** กล่องยืนยัน: await confirmDialog({ title, body, confirmText, danger }) → true/false */
export function confirmDialog({ title = 'ยืนยัน', body = '', confirmText = 'ยืนยัน', cancelText = 'ยกเลิก', danger = false } = {}) {
  return modal({
    title,
    body: typeof body === 'string' ? html`<p class="mb-0">${body}</p>` : body,
    foot: html`<button class="btn" data-close>${cancelText}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${confirmText}</button>`,
    onMount: (dlg, close) => {
      const okBtn = dlg.querySelector('[data-ok]');
      okBtn.addEventListener('click', () => close(true));
      okBtn.focus();
    },
  }).then((v) => v === true);
}

/** กล่องกรอกข้อความ: await promptDialog({ title, label, placeholder, required }) → string | null */
export function promptDialog({ title = 'กรอกข้อมูล', label = '', placeholder = '', value = '', confirmText = 'ตกลง', required = false, multiline = false, danger = false } = {}) {
  return modal({
    title,
    body: html`<div class="field"><label>${label}</label>${multiline
      ? html`<textarea class="textarea" data-input placeholder="${placeholder}">${value}</textarea>`
      : html`<input class="input" data-input placeholder="${placeholder}" value="${value}">`}<div class="error-text">กรุณากรอกข้อมูล</div></div>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${confirmText}</button>`,
    onMount: (dlg, close) => {
      const input = dlg.querySelector('[data-input]');
      const submit = () => {
        const v = input.value.trim();
        if (required && !v) { input.closest('.field').classList.add('has-error'); input.focus(); return; }
        close(v);
      };
      dlg.querySelector('[data-ok]').addEventListener('click', submit);
      if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      input.focus();
    },
  }).then((v) => (typeof v === 'string' ? v : null));
}

// ───────────── ฟอร์ม ─────────────
/** แสดง error ที่ช่องที่เกี่ยวข้อง (จาก err.details.field) และคืน true ถ้าแสดงได้ */
export function showFieldError(form, err) {
  clearFieldErrors(form);
  const field = err?.details?.field;
  if (!field) return false;
  const input = form.querySelector(`[name="${CSS.escape(field)}"]`);
  const wrap = input?.closest('.field');
  if (!wrap) return false;
  wrap.classList.add('has-error');
  let t = wrap.querySelector('.error-text');
  if (!t) {
    t = document.createElement('div');
    t.className = 'error-text';
    wrap.appendChild(t);
  }
  t.textContent = err.message;
  input.focus();
  return true;
}
export function clearFieldErrors(form) {
  form.querySelectorAll('.field.has-error').forEach((f) => f.classList.remove('has-error'));
}
export const formData = (form) => Object.fromEntries(new FormData(form).entries());

/** ปุ่มกำลังโหลด: await withLoading(btn, async () => …) — กันกดซ้ำ */
export async function withLoading(btn, fn) {
  if (!btn || btn.classList.contains('is-loading')) return undefined;
  const prev = btn.innerHTML;
  btn.classList.add('is-loading');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${btn.dataset.loadingText ? esc(btn.dataset.loadingText) : prev}`;
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
    btn.innerHTML = prev;
  }
}

/**
 * เข้าสู่ระบบบัญชีที่เปิดยืนยันตัวตน 2 ชั้น: ถามรหัส 6 หลักจากแอป แล้วยืนยันที่ /api/auth/login/verify
 * คืน { user, csrf } หรือ null ถ้ายกเลิก / หมดเวลา / ถูกล็อก (แจ้งข้อความแล้ว — ต้องเข้าสู่ระบบใหม่)
 */
export function verifyLoginMfa(mfaToken) {
  return modal({
    title: 'ยืนยันตัวตน 2 ชั้น',
    body: html`<form class="stack" data-mfa novalidate>
      <p class="small mb-0">ใส่รหัส 6 หลักจากแอปยืนยันตัวตน (Authenticator) ในโทรศัพท์ของคุณ</p>
      <div class="field"><label for="mfaCode">รหัสยืนยัน</label>
        <input class="input lg" id="mfaCode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
        <div class="error-text"></div></div>
    </form>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary" data-ok>ยืนยัน</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-mfa]');
      const input = form.querySelector('[name="code"]');
      const btn = dlg.querySelector('[data-ok]');
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
      const submit = (e) => {
        e?.preventDefault();
        const code = input.value;
        if (!/^\d{6}$/.test(code)) {
          showFieldError(form, { message: 'กรุณาใส่รหัส 6 หลัก', details: { field: 'code' } });
          return;
        }
        withLoading(btn, async () => {
          try {
            close(await api.post('/api/auth/login/verify', { mfa_token: mfaToken, code }));
          } catch (err) {
            if (err.code === 'INVALID_CODE') { input.value = ''; showFieldError(form, err); return; } // ใส่ใหม่ได้
            toastError(err); // หมดเวลา / ผิดหลายครั้ง / ถูกล็อก → ต้องเข้าสู่ระบบใหม่
            close(null);
          }
        });
      };
      form.addEventListener('submit', submit);
      btn.addEventListener('click', submit);
      input.focus();
    },
  }).then((r) => (r?.user ? r : null));
}

// ───────────── Router (hash) ─────────────
/**
 * const r = createRouter({ '/': fn, '/order/:ref': fn }, { notFound })
 * handler(params, query) — เปลี่ยนหน้าด้วย navigate('/history')
 */
export function createRouter(routes, { notFound, before } = {}) {
  const compiled = Object.entries(routes).map(([pattern, handler]) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
    return { re, keys, handler, pattern };
  });
  // ลิงก์ที่ถูกตัด/เข้ารหัสผิด (เช่น %E0%B) ต้องไม่ทำให้ทั้งหน้าค้าง
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  async function resolve() {
    const hash = location.hash.slice(1) || '/';
    const [path, search = ''] = hash.split('?');
    const query = Object.fromEntries(new URLSearchParams(search));
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (m) {
        const params = Object.fromEntries(r.keys.map((k, i) => [k, dec(m[i + 1])]));
        if (before && (await before({ path, pattern: r.pattern, params, query })) === false) return;
        await r.handler(params, query, { path, pattern: r.pattern });
        return;
      }
    }
    notFound?.(path);
  }
  window.addEventListener('hashchange', resolve);
  return { start: resolve, resolve };
}
export const navigate = (path) => {
  if (location.hash === `#${path}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = path;
};

// ───────────── อื่นๆ ─────────────
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ย่อรูปก่อนอัปโหลด (สลิป) ให้ไม่เกินขนาดที่กำหนด → data URL (JPEG) */
export async function compressImage(file, { maxDim = 1600, quality = 0.85 } = {}) {
  if (!file || !/^image\/(png|jpe?g|webp)$/.test(file.type)) throw new ApiError('VALIDATION_ERROR', 'กรุณาเลือกไฟล์รูปภาพ (JPG, PNG, WEBP)');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new ApiError('VALIDATION_ERROR', 'เปิดไฟล์รูปไม่ได้'));
      i.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** คัดลอกข้อความ (เว็บที่ไม่ได้เปิดผ่าน https / เบราว์เซอร์เก่า ใช้วิธีสำรอง) → คืน true ถ้าสำเร็จ */
export async function copyText(text, okMessage = 'คัดลอกแล้ว') {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const prev = document.activeElement;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      toastHost().appendChild(ta); // ในหน้าต่างที่เปิดอยู่ (นอกหน้าต่างเลือกข้อความไม่ได้)
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
      ta.remove();
    } catch {
      ok = false;
    }
    try { prev?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  }
  if (ok) toast(okMessage, 'success', 2200);
  else toast('คัดลอกไม่สำเร็จ', 'error');
  return ok;
}

/** หน่วงการ poll สถานะรายการ: เร็วช่วงแรก แล้วค่อยๆ ช้าลง */
export const pollDelay = (attempt) => (attempt < 5 ? 1500 : attempt < 15 ? 3000 : 6000);
