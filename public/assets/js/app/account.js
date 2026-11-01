// บัญชีผู้ใช้ / เข้าสู่ระบบ / สมัครสมาชิก
import {
  html, raw, api, on, setHTML, baht, dateOnly, dateTime, timeAgo, withLoading, toast, toastError, navigate, showFieldError, clearFieldErrors,
  confirmDialog, modal, copyText, normalizePhone, verifyLoginMfa,
} from '../lib.js';
import { state, setUser, refreshUser, safeNext } from './state.js';
import { icon } from './icons.js';
import { pageHead, alertBox, initial } from './ui.js';
import { formatPhoneTyping } from './phonefield.js';

/** หา input ในฟอร์มจากชื่อ (ไม่พึ่ง form.ชื่อ ซึ่งชนกับ property ของฟอร์มได้ เช่น form.name) */
const fld = (form, name) => form.elements.namedItem(name);

function pwRules(pw) {
  return [
    { ok: pw.length >= 8, label: 'อย่างน้อย 8 ตัวอักษร' },
    { ok: /[A-Za-z]/.test(pw), label: 'มีตัวอักษรภาษาอังกฤษ' },
    { ok: /\d/.test(pw), label: 'มีตัวเลข' },
  ];
}
const pwRulesHtml = (pw) => html`${pwRules(pw).map((r) => html`<span class="${r.ok ? 'ok' : ''}">${icon(r.ok ? 'check' : 'x', 13)} ${r.label}</span>`)}`;
const pwValid = (pw) => pwRules(pw).every((r) => r.ok);

function bindPwToggle(root) {
  on(root, 'click', '[data-toggle-pw]', (e, el) => {
    const input = el.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
    el.setAttribute('aria-pressed', input.type === 'text' ? 'true' : 'false');
  });
}
const pwInput = (id, name, autocomplete, placeholder = '') => html`<div class="pw-wrap">
  <input class="input" id="${id}" name="${name}" type="password" autocomplete="${autocomplete}" placeholder="${placeholder}" maxlength="128">
  <button type="button" class="btn ghost sm icon" data-toggle-pw aria-label="แสดงรหัสผ่าน" aria-pressed="false">${icon('eye', 18)}</button>
</div>`;

// ───────────── เข้าสู่ระบบ ─────────────

export async function loginPage(ctx) {
  const next = safeNext(ctx.query.next);
  if (state.user) { navigate(next); return; }
  const s = state.catalog.settings;
  setHTML(ctx.view, html`<div class="auth-wrap">
    <section class="card auth-card">
      <div class="auth-head"><span class="brand-logo">${icon('bolt', 26)}</span><h1>เข้าสู่ระบบ</h1><p class="muted mb-0">${s.site_name}</p></div>
      ${next !== '/' ? html`<div class="mb-2">${alertBox('info', 'กรุณาเข้าสู่ระบบเพื่อทำรายการต่อ')}</div>` : ''}
      <form class="stack" data-login novalidate>
        <div class="field"><label for="identifier">เบอร์โทรศัพท์ หรือ อีเมล</label>
          <input class="input" id="identifier" name="identifier" autocomplete="username" inputmode="email" placeholder="08X-XXX-XXXX หรือ you@email.com" maxlength="120"><div class="error-text"></div></div>
        <div class="field"><label for="password">รหัสผ่าน</label>${pwInput('password', 'password', 'current-password')}<div class="error-text"></div></div>
        <div data-err></div>
        <button class="btn primary lg block" type="submit" data-loading-text="กำลังเข้าสู่ระบบ...">เข้าสู่ระบบ</button>
      </form>
      ${s.registration_enabled !== false ? html`<p class="center small mt-3 mb-0">ยังไม่มีบัญชี? <a href="#/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}">สมัครสมาชิกฟรี</a></p>` : ''}
      <p class="center xsmall muted mt-2 mb-0">ลืมรหัสผ่าน? ติดต่อผู้ดูแล${s.support_line ? ` LINE: ${s.support_line}` : ''}${s.support_phone ? ` โทร: ${s.support_phone}` : ''}</p>
    </section>
  </div>`);
  const form = ctx.view.querySelector('[data-login]');
  bindPwToggle(form);
  const errBox = form.querySelector('[data-err]');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    setHTML(errBox, '');
    const identifier = fld(form, 'identifier').value.trim();
    const password = fld(form, 'password').value;
    if (!identifier) { showFieldError(form, { message: 'กรุณากรอกเบอร์โทรหรืออีเมล', details: { field: 'identifier' } }); return; }
    if (!password) { showFieldError(form, { message: 'กรุณากรอกรหัสผ่าน', details: { field: 'password' } }); return; }
    withLoading(form.querySelector('[type="submit"]'), async () => {
      try {
        let d = await api.post('/api/auth/login', { identifier, password });
        if (d.mfa_required) {
          // บัญชีเปิดยืนยันตัวตน 2 ชั้น → ขอรหัส 6 หลักก่อน (ยังไม่ได้เข้าสู่ระบบจนกว่ารหัสถูก)
          d = await verifyLoginMfa(d.mfa_token);
          if (!d) { fld(form, 'password').value = ''; return; }
        }
        setUser(d.user);
        toast(`ยินดีต้อนรับ คุณ${d.user.name}`, 'success');
        navigate(next);
      } catch (err) {
        if (!showFieldError(form, err)) setHTML(errBox, alertBox('danger', err.message));
        fld(form, 'password').value = '';
      }
    });
  });
  if (window.matchMedia('(pointer: fine)').matches) fld(form, 'identifier').focus();
}

// ───────────── สมัครสมาชิก ─────────────

export async function registerPage(ctx) {
  const next = safeNext(ctx.query.next);
  if (state.user) { navigate(next); return; }
  const s = state.catalog.settings;
  if (s.registration_enabled === false) {
    setHTML(ctx.view, html`<div class="auth-wrap"><section class="card auth-card">${alertBox('warning', 'ขณะนี้ปิดรับสมัครสมาชิกใหม่ชั่วคราว')}<a class="btn block mt-2" href="#/login">เข้าสู่ระบบ</a></section></div>`);
    return;
  }
  setHTML(ctx.view, html`<div class="auth-wrap">
    <section class="card auth-card">
      <div class="auth-head"><span class="brand-logo">${icon('user', 26)}</span><h1>สมัครสมาชิก</h1><p class="muted mb-0">ฟรี ใช้เวลาไม่ถึง 1 นาที</p></div>
      <form class="stack" data-register novalidate>
        <div class="field"><label for="name">ชื่อ - นามสกุล</label><input class="input" id="name" name="name" autocomplete="name" maxlength="60" placeholder="ชื่อที่ใช้ติดต่อ"><div class="error-text"></div></div>
        <div class="field"><label for="phone">เบอร์มือถือ (ใช้เข้าสู่ระบบ)</label><input class="input" id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="16" placeholder="08X-XXX-XXXX"><div class="error-text"></div></div>
        <div class="field"><label for="email">อีเมล (ไม่บังคับ)</label><input class="input" id="email" name="email" type="email" autocomplete="email" maxlength="120" placeholder="you@email.com"><div class="error-text"></div></div>
        <div class="field"><label for="password">ตั้งรหัสผ่าน</label>${pwInput('password', 'password', 'new-password')}
          <div class="pw-rules" data-rules>${pwRulesHtml('')}</div><div class="error-text"></div></div>
        <div class="field"><label for="password2">ยืนยันรหัสผ่าน</label>${pwInput('password2', 'password2', 'new-password')}<div class="error-text"></div></div>
        <div data-err></div>
        <button class="btn primary lg block" type="submit" data-loading-text="กำลังสมัคร...">สมัครสมาชิก</button>
      </form>
      <p class="center small mt-3 mb-0">มีบัญชีแล้ว? <a href="#/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}">เข้าสู่ระบบ</a></p>
    </section>
  </div>`);
  const form = ctx.view.querySelector('[data-register]');
  bindPwToggle(form);
  const rules = form.querySelector('[data-rules]');
  const errBox = form.querySelector('[data-err]');
  fld(form, 'phone').addEventListener('input', () => { fld(form, 'phone').value = formatPhoneTyping(fld(form, 'phone').value); });
  fld(form, 'password').addEventListener('input', () => setHTML(rules, pwRulesHtml(fld(form, 'password').value)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    setHTML(errBox, '');
    const body = { name: fld(form, 'name').value.trim(), phone: fld(form, 'phone').value, email: fld(form, 'email').value.trim() || undefined, password: fld(form, 'password').value };
    const fail = (field, message) => showFieldError(form, { message, details: { field } });
    if (body.name.length < 2) return fail('name', 'กรุณากรอกชื่ออย่างน้อย 2 ตัวอักษร');
    if (!normalizePhone(body.phone)) return fail('phone', 'เบอร์มือถือไม่ถูกต้อง (10 หลัก ขึ้นต้น 06/08/09)');
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return fail('email', 'อีเมลไม่ถูกต้อง');
    if (!pwValid(body.password)) return fail('password', 'รหัสผ่านยังไม่ตรงตามเงื่อนไข');
    if (body.password !== fld(form, 'password2').value) return fail('password2', 'รหัสผ่านทั้งสองช่องไม่ตรงกัน');
    withLoading(form.querySelector('[type="submit"]'), async () => {
      try {
        const d = await api.post('/api/auth/register', body);
        setUser(d.user);
        toast('สมัครสมาชิกสำเร็จ', 'success');
        navigate(next !== '/' ? next : '/wallet');
      } catch (err) {
        if (!showFieldError(form, err)) setHTML(errBox, alertBox('danger', err.message));
      }
    });
    return undefined;
  });
  if (window.matchMedia('(pointer: fine)').matches) fld(form, 'name').focus();
}

// ───────────── ยืนยันตัวตน 2 ชั้น / อุปกรณ์ที่เข้าสู่ระบบ ─────────────

const fieldErr = (field, message) => Object.assign(new Error(message), { details: { field } });
const digitsOnly = (input) => input?.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
const codeInput = (id) => html`<input class="input lg num" id="${id}" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">`;
/** รหัสลับแบ่งทีละ 4 ตัว อ่าน/พิมพ์ตามง่าย */
const groupSecret = (s) => String(s || '').replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');

/**
 * หน้าต่างฟอร์ม: กดยืนยัน → onSubmit(form)
 * คืนค่า = ปิดหน้าต่างพร้อมค่านั้น · throw = แสดงข้อผิดพลาดที่ช่อง (details.field) หรือด้านล่าง แล้วแก้ไขต่อได้
 */
function formModal({ title, body, confirmText, danger = false, onSubmit, onMount }) {
  return modal({
    title,
    body: html`<form class="stack" data-fm novalidate>${body}<div data-err></div></form>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${confirmText}</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-fm]');
      const errBox = form.querySelector('[data-err]');
      const btn = dlg.querySelector('[data-ok]');
      bindPwToggle(form);
      const submit = (e) => {
        e?.preventDefault();
        clearFieldErrors(form);
        setHTML(errBox, '');
        withLoading(btn, async () => {
          try {
            close(await onSubmit(form));
          } catch (err) {
            if (!showFieldError(form, err)) setHTML(errBox, alertBox('danger', err.message));
          }
        });
      };
      form.addEventListener('submit', submit);
      btn.addEventListener('click', submit);
      onMount?.(dlg);
      form.querySelector('input:not([type="hidden"])')?.focus();
    },
  });
}

/** เปิดใช้: ยืนยันรหัสผ่าน → สแกน QR / พิมพ์รหัสลับในแอป → ใส่รหัส 6 หลักเพื่อยืนยัน */
async function enableTwoFactor() {
  const setup = await formModal({
    title: 'เปิดใช้การยืนยันตัวตน 2 ชั้น',
    body: html`<p class="small mb-0">ขั้นที่ 1/2 — ยืนยันรหัสผ่านปัจจุบันของคุณ</p>
      <div class="field"><label for="tfPw">รหัสผ่านปัจจุบัน</label>${pwInput('tfPw', 'password', 'current-password')}<div class="error-text"></div></div>`,
    confirmText: 'ถัดไป',
    onSubmit: async (form) => {
      const password = fld(form, 'password').value;
      if (!password) throw fieldErr('password', 'กรุณากรอกรหัสผ่าน');
      return api.post('/api/auth/2fa/setup', { password });
    },
  });
  if (!setup?.secret) return null;
  return formModal({
    title: 'สแกน QR ด้วยแอปยืนยันตัวตน',
    body: html`<p class="small mb-0">ขั้นที่ 2/2 — ใช้แอป Google Authenticator / Microsoft Authenticator ในโทรศัพท์ สแกน QR นี้</p>
      <div class="qr-box">
        <div class="qr-head">ยืนยันตัวตน 2 ชั้น</div>
        <div class="qr-svg">${raw(setup.qr_svg)}</div>
      </div>
      <div><span class="label">สแกนไม่ได้? พิมพ์รหัสลับนี้ในแอปแทน</span>
        <div class="row mt-1"><code class="mono grow" style="word-break:break-all">${groupSecret(setup.secret)}</code>
          <button type="button" class="btn sm soft" data-copy="${setup.secret}">${icon('copy', 16)} คัดลอก</button></div>
        <div class="xsmall muted mt-1">ห้ามส่งรหัสลับหรือ QR นี้ให้ผู้อื่น</div></div>
      <div class="field"><label for="tfCode">รหัส 6 หลักจากแอป</label>${codeInput('tfCode')}<div class="error-text"></div></div>
      <p class="xsmall muted mb-0">เปิดใช้แล้ว อุปกรณ์อื่นที่เข้าสู่ระบบอยู่จะถูกออกจากระบบ · ถ้าโทรศัพท์หาย ติดต่อผู้ดูแลเพื่อรีเซ็ต</p>`,
    confirmText: 'เปิดใช้งาน',
    onMount: (dlg) => {
      on(dlg, 'click', '[data-copy]', (e, b) => copyText(b.dataset.copy));
      digitsOnly(dlg.querySelector('[name="code"]'));
    },
    onSubmit: async (form) => {
      const code = fld(form, 'code').value;
      if (!/^\d{6}$/.test(code)) throw fieldErr('code', 'กรุณาใส่รหัส 6 หลักจากแอป');
      return api.post('/api/auth/2fa/enable', { code });
    },
  });
}

function disableTwoFactor() {
  return formModal({
    title: 'ปิดการยืนยันตัวตน 2 ชั้น',
    danger: true,
    body: html`${alertBox('warning', 'ปิดแล้ว การเข้าสู่ระบบจะเหลือรหัสผ่านชั้นเดียว — ถ้ามีคนรู้รหัสผ่านจะเข้าบัญชีและใช้เงินในกระเป๋าได้')}
      <div class="field"><label for="tfPw2">รหัสผ่านปัจจุบัน</label>${pwInput('tfPw2', 'password', 'current-password')}<div class="error-text"></div></div>
      <div class="field"><label for="tfCode2">รหัส 6 หลักจากแอป</label>${codeInput('tfCode2')}<div class="error-text"></div></div>`,
    confirmText: 'ปิดการยืนยัน 2 ชั้น',
    onMount: (dlg) => digitsOnly(dlg.querySelector('[name="code"]')),
    onSubmit: async (form) => {
      const password = fld(form, 'password').value;
      const code = fld(form, 'code').value;
      if (!password) throw fieldErr('password', 'กรุณากรอกรหัสผ่าน');
      if (!/^\d{6}$/.test(code)) throw fieldErr('code', 'กรุณาใส่รหัส 6 หลักจากแอป');
      return api.post('/api/auth/2fa/disable', { password, code });
    },
  });
}

function twoFactorCard(u) {
  return html`<div class="card-head"><h3>ยืนยันตัวตน 2 ชั้น</h3>${u.two_factor
    ? html`<span class="badge success">เปิดใช้อยู่</span>` : html`<span class="badge warning">ยังไม่เปิด</span>`}</div>
    <p class="small text-2">${u.two_factor
      ? 'เข้าสู่ระบบต้องใส่รหัส 6 หลักจากแอปในโทรศัพท์ทุกครั้ง แม้มีคนรู้รหัสผ่านก็เข้าบัญชีไม่ได้'
      : 'เพิ่มความปลอดภัยให้บัญชีและเงินในกระเป๋า: นอกจากรหัสผ่าน ต้องใส่รหัส 6 หลักจากแอปในโทรศัพท์ด้วย (ใช้แอป Google Authenticator / Microsoft Authenticator)'}</p>
    ${u.two_factor
      ? html`<button type="button" class="btn danger" data-2fa-off>${icon('lock', 18)} ปิดการยืนยันตัวตน 2 ชั้น</button>`
      : html`<button type="button" class="btn primary" data-2fa-on>${icon('shield', 18)} เปิดใช้การยืนยันตัวตน 2 ชั้น</button>`}`;
}

/** เดาชื่อเบราว์เซอร์ / ระบบปฏิบัติการจาก user agent แบบสั้นๆ */
function deviceName(ua) {
  const s = String(ua || '');
  const browser = /Edg(A|iOS)?\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /\bLine\//.test(s) ? 'LINE' : /FBAN|FBAV/.test(s) ? 'Facebook' : /Chrome\/|CriOS/.test(s) ? 'Chrome'
      : /Firefox\/|FxiOS/.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '';
  const os = /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ') || 'อุปกรณ์ไม่ทราบชนิด';
}

function sessionsCard(list) {
  const others = list.filter((x) => !x.current).length;
  return html`<div class="card-head"><h3>อุปกรณ์ที่เข้าสู่ระบบ</h3>${others
    ? html`<button type="button" class="btn sm" data-revoke-others>ออกจากระบบเครื่องอื่นทั้งหมด</button>` : ''}</div>
    ${list.length ? html`<div class="pb-list">${list.map((x) => html`<div class="pb-item">
      <span class="q-icon">${icon('phone', 18)}</span>
      <span class="grow"><span class="bold d-block truncate" title="${x.user_agent || ''}">${deviceName(x.user_agent)}${x.current ? html` <span class="badge success plain">เครื่องนี้</span>` : ''}</span>
        <span class="xsmall muted">IP ${x.ip || '-'} · ใช้ล่าสุด ${timeAgo(x.last_seen_at || x.created_at)} · เข้าสู่ระบบเมื่อ ${dateTime(x.created_at)}</span></span>
      ${x.current ? '' : html`<button type="button" class="btn sm ghost text-danger" data-revoke="${x.id}">ออกจากระบบ</button>`}
    </div>`)}</div>` : html`<p class="small muted mb-0">ไม่พบอุปกรณ์</p>`}
    <p class="xsmall muted mt-2 mb-0">ไม่รู้จักอุปกรณ์ไหน ให้กดออกจากระบบเครื่องนั้น แล้วเปลี่ยนรหัสผ่านทันที</p>`;
}

// ───────────── บัญชีของฉัน ─────────────

export async function accountPage(ctx) {
  await refreshUser();
  if (!ctx.alive() || !state.user) return; // เซสชันหมดอายุ → ระบบพาไปหน้าเข้าสู่ระบบ
  const u = state.user;
  const s = state.catalog.settings;
  setHTML(ctx.view, html`
    ${pageHead('บัญชีของฉัน')}
    <section class="card profile-card">
      <span class="profile-avatar">${initial(u.name)}</span>
      <div class="grow">
        <div class="bold profile-name">${u.name}</div>
        <div class="small muted">${u.phone ? html`<span class="num">${formatPhoneTyping(u.phone)}</span>` : ''}${u.email ? ` · ${u.email}` : ''}</div>
        <div class="xsmall muted">สมาชิกตั้งแต่ ${dateOnly(u.created_at)}</div>
      </div>
      <a class="balance-chip" href="#/wallet">${icon('wallet', 18)}<span class="num">฿${baht(u.balance)}</span></a>
    </section>

    <div class="menu-grid mt-2">
      <a class="menu-item" href="#/wallet"><span class="q-icon">${icon('wallet', 20)}</span><span class="grow"><span class="bold d-block">กระเป๋าเงิน</span><span class="xsmall muted">เติมเงินเข้ากระเป๋า · รายการเดินบัญชี</span></span>${icon('chevronRight', 18)}</a>
      <a class="menu-item" href="#/history"><span class="q-icon">${icon('clock', 20)}</span><span class="grow"><span class="bold d-block">ประวัติการทำรายการ</span><span class="xsmall muted">สถานะและรายละเอียดทุกรายการ</span></span>${icon('chevronRight', 18)}</a>
      <a class="menu-item" href="#/phonebook"><span class="q-icon">${icon('book', 20)}</span><span class="grow"><span class="bold d-block">สมุดโทรศัพท์</span><span class="xsmall muted">เบอร์ที่เติมบ่อย</span></span>${icon('chevronRight', 18)}</a>
      <a class="menu-item" href="#/bulk"><span class="q-icon">${icon('layers', 20)}</span><span class="grow"><span class="bold d-block">เติมหลายเบอร์</span><span class="xsmall muted">เติมทีละหลายเบอร์ในครั้งเดียว</span></span>${icon('chevronRight', 18)}</a>
    </div>

    <div class="grid cols-2 mt-2">
      <section class="card">
        <h3 class="mb-2">แก้ไขข้อมูลส่วนตัว</h3>
        <form class="stack" data-profile novalidate>
          <div class="field"><label for="pName">ชื่อ</label><input class="input" id="pName" name="name" maxlength="60" value="${u.name}"><div class="error-text"></div></div>
          <div class="field"><label for="pEmail">อีเมล</label><input class="input" id="pEmail" name="email" type="email" maxlength="120" value="${u.email || ''}" placeholder="ไม่บังคับ"><div class="error-text"></div></div>
          <div class="field"><label>เบอร์มือถือ (ใช้เข้าสู่ระบบ)</label><input class="input num" value="${u.phone ? formatPhoneTyping(u.phone) : '-'}" readonly><div class="help">ต้องการเปลี่ยนเบอร์ กรุณาติดต่อผู้ดูแล</div></div>
          <button class="btn primary" type="submit">บันทึกข้อมูล</button>
        </form>
      </section>
      <section class="card">
        <h3 class="mb-2">เปลี่ยนรหัสผ่าน</h3>
        <form class="stack" data-password novalidate>
          <div class="field"><label for="currentPassword">รหัสผ่านปัจจุบัน</label>${pwInput('currentPassword', 'currentPassword', 'current-password')}<div class="error-text"></div></div>
          <div class="field"><label for="newPassword">รหัสผ่านใหม่</label>${pwInput('newPassword', 'newPassword', 'new-password')}<div class="pw-rules" data-rules>${pwRulesHtml('')}</div><div class="error-text"></div></div>
          <div class="field"><label for="newPassword2">ยืนยันรหัสผ่านใหม่</label>${pwInput('newPassword2', 'newPassword2', 'new-password')}<div class="error-text"></div></div>
          <button class="btn primary" type="submit">เปลี่ยนรหัสผ่าน</button>
          <p class="xsmall muted mb-0">เปลี่ยนรหัสผ่านแล้ว อุปกรณ์อื่นที่ล็อกอินไว้จะถูกออกจากระบบ</p>
        </form>
      </section>
    </div>

    <div class="grid cols-2 mt-2">
      <section class="card" data-2fa>${twoFactorCard(u)}</section>
      <section class="card" data-sessions><div class="skeleton" style="height:46px"></div></section>
    </div>

    ${s.support_line || s.support_phone ? html`<section class="card mt-2 row wrap">
      <span class="q-icon">${icon('headset', 20)}</span>
      <div class="grow"><div class="bold">ติดต่อผู้ดูแล</div><div class="small muted">${s.support_line ? `LINE: ${s.support_line}` : ''}${s.support_line && s.support_phone ? ' · ' : ''}${s.support_phone ? `โทร: ${s.support_phone}` : ''}</div></div>
    </section>` : ''}

    <button class="btn block mt-3 text-danger" data-logout>${icon('logout', 18)} ออกจากระบบ</button>`);

  const view = ctx.view;
  bindPwToggle(view);
  const pf = view.querySelector('[data-profile]');
  pf.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFieldErrors(pf);
    withLoading(pf.querySelector('[type="submit"]'), async () => {
      try {
        const d = await api.put('/api/auth/profile', { name: fld(pf, 'name').value.trim(), email: fld(pf, 'email').value.trim() });
        setUser(d.user);
        toast('บันทึกข้อมูลแล้ว', 'success');
      } catch (err) {
        if (!showFieldError(pf, err)) toastError(err);
      }
    });
  });

  const pw = view.querySelector('[data-password]');
  const rules = pw.querySelector('[data-rules]');
  fld(pw, 'newPassword').addEventListener('input', () => setHTML(rules, pwRulesHtml(fld(pw, 'newPassword').value)));
  pw.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFieldErrors(pw);
    const fail = (field, message) => showFieldError(pw, { message, details: { field } });
    if (!fld(pw, 'currentPassword').value) return fail('currentPassword', 'กรุณากรอกรหัสผ่านปัจจุบัน');
    if (!pwValid(fld(pw, 'newPassword').value)) return fail('newPassword', 'รหัสผ่านใหม่ยังไม่ตรงตามเงื่อนไข');
    if (fld(pw, 'newPassword').value !== fld(pw, 'newPassword2').value) return fail('newPassword2', 'รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
    withLoading(pw.querySelector('[type="submit"]'), async () => {
      try {
        await api.post('/api/auth/change-password', { currentPassword: fld(pw, 'currentPassword').value, newPassword: fld(pw, 'newPassword').value });
        pw.reset();
        setHTML(rules, pwRulesHtml(''));
        toast('เปลี่ยนรหัสผ่านแล้ว', 'success');
        loadSessions(); // อุปกรณ์อื่นถูกออกจากระบบแล้ว
      } catch (err) {
        if (!showFieldError(pw, err)) toastError(err);
      }
    });
    return undefined;
  });

  on(view, 'click', '[data-logout]', async (e, el) => {
    const yes = await confirmDialog({ title: 'ออกจากระบบ?', body: 'คุณต้องการออกจากระบบใช่หรือไม่', confirmText: 'ออกจากระบบ' });
    if (!yes) return;
    withLoading(el, async () => {
      try { await api.post('/api/auth/logout'); } catch { /* ออกจากระบบฝั่งหน้าเว็บต่อ */ }
      setUser(null);
      toast('ออกจากระบบแล้ว', 'success');
      navigate('/');
    });
  });

  // ── ยืนยันตัวตน 2 ชั้น ──
  const tfBox = view.querySelector('[data-2fa]');
  on(tfBox, 'click', '[data-2fa-on]', (e, el) => withLoading(el, async () => {
    const d = await enableTwoFactor();
    if (!d?.user || !ctx.alive()) return;
    setUser(d.user);
    setHTML(tfBox, twoFactorCard(d.user));
    toast('เปิดใช้การยืนยันตัวตน 2 ชั้นแล้ว — อุปกรณ์อื่นที่เข้าสู่ระบบอยู่ถูกออกจากระบบแล้ว', 'success', 6000);
    loadSessions();
  }));
  on(tfBox, 'click', '[data-2fa-off]', (e, el) => withLoading(el, async () => {
    const d = await disableTwoFactor();
    if (!d?.user || !ctx.alive()) return;
    setUser(d.user);
    setHTML(tfBox, twoFactorCard(d.user));
    toast('ปิดการยืนยันตัวตน 2 ชั้นแล้ว', 'warning', 5000);
  }));

  // ── อุปกรณ์ที่เข้าสู่ระบบ ──
  const sessBox = view.querySelector('[data-sessions]');
  let sessions = [];
  async function loadSessions() {
    try {
      sessions = (await api.get('/api/auth/sessions')).sessions || [];
      if (ctx.alive()) setHTML(sessBox, sessionsCard(sessions));
    } catch (err) {
      if (ctx.alive()) setHTML(sessBox, html`<h3 class="mb-2">อุปกรณ์ที่เข้าสู่ระบบ</h3>${alertBox('danger', err.message)}`);
    }
  }
  on(sessBox, 'click', '[data-revoke]', async (e, el) => {
    const s = sessions.find((x) => x.id === el.dataset.revoke);
    if (!s) return;
    const yes = await confirmDialog({
      title: 'ออกจากระบบอุปกรณ์นี้?',
      body: `${deviceName(s.user_agent)} (IP ${s.ip || '-'}) ใช้ล่าสุด ${timeAgo(s.last_seen_at || s.created_at)} — อุปกรณ์นี้จะต้องเข้าสู่ระบบใหม่`,
      confirmText: 'ออกจากระบบอุปกรณ์นี้',
      danger: true,
    });
    if (!yes) return;
    withLoading(el, async () => {
      try {
        await api.del(`/api/auth/sessions/${encodeURIComponent(s.id)}`);
        toast('ออกจากระบบอุปกรณ์นั้นแล้ว', 'success');
      } catch (err) { toastError(err); }
      await loadSessions();
    });
  });
  on(sessBox, 'click', '[data-revoke-others]', async (e, el) => {
    const n = sessions.filter((x) => !x.current).length;
    const yes = await confirmDialog({
      title: 'ออกจากระบบเครื่องอื่นทั้งหมด?',
      body: `อุปกรณ์อื่น ${n} เครื่องจะถูกออกจากระบบทันที (เครื่องนี้ยังใช้งานต่อได้)`,
      confirmText: 'ออกจากระบบเครื่องอื่นทั้งหมด',
      danger: true,
    });
    if (!yes) return;
    withLoading(el, async () => {
      try {
        const r = await api.post('/api/auth/sessions/revoke-others');
        toast(`ออกจากระบบเครื่องอื่นแล้ว ${r.revoked ?? n} เครื่อง`, 'success');
      } catch (err) { toastError(err); }
      await loadSessions();
    });
  });
  loadSessions();
}
