// ═══════════════════════════════════════════════════════════════
//  หลังบ้านแอดมิน — จุดเริ่มต้น: ตรวจสิทธิ์ → โครงหน้า → router
// ═══════════════════════════════════════════════════════════════
import { html, api, session, loadMe, createRouter, navigate, on, toast, toastError, withLoading, dateTimeSec, showFieldError, clearFieldErrors, verifyLoginMfa, confirmDialog } from './lib.js';
import { icon, store, shortLabel } from './admin/common.js';
import { render as dashboard } from './admin/dashboard.js';
import { renderOrders, renderReview } from './admin/orders.js';
import { render as deposits } from './admin/deposits.js';
import { render as users } from './admin/users.js';
import { render as catalog } from './admin/catalog.js';
import { render as reports } from './admin/reports.js';
import { render as logs } from './admin/logs.js';
import { render as apiKeys } from './admin/apikeys.js';
import { render as settingsPage } from './admin/settings.js';
import { render as providersPage } from './admin/providers.js';

const app = document.getElementById('app');

const PAGES = {
  '/': { title: 'แดชบอร์ด', icon: 'dashboard', render: dashboard },
  '/orders': { title: 'รายการทั้งหมด', icon: 'orders', render: renderOrders },
  '/review': { title: 'ต้องตรวจสอบ', icon: 'review', render: renderReview, count: 'review' },
  '/deposits': { title: 'เติมเงินเข้ากระเป๋า', icon: 'wallet', render: deposits, count: 'deposits' },
  '/users': { title: 'ผู้ใช้', icon: 'users', render: users },
  '/catalog': { title: 'สินค้า & เครือข่าย', icon: 'catalog', render: catalog },
  '/providers': { title: 'ผู้ให้บริการ & ร้าน', icon: 'store', render: providersPage },
  '/reports': { title: 'รายงานยอดขาย', icon: 'reports', render: reports },
  '/logs': { title: 'Log & ประวัติระบบ', icon: 'logs', render: logs },
  '/api-keys': { title: 'API ร้านค้า', icon: 'key', render: apiKeys },
  '/settings': { title: 'ตั้งค่าระบบ', icon: 'settings', render: settingsPage },
};
// ลิงก์ที่ไม่ใช่หน้าในหลังบ้าน: หน้า "บัญชีของฉัน" อยู่ในเว็บลูกค้า (บัญชีเดียวกัน) — ที่นั่นเปลี่ยนรหัสผ่าน / เปิดยืนยันตัวตน 2 ชั้น
const EXTERNAL = {
  account: { href: '/#/account', title: 'บัญชีของฉัน', sub: 'รหัสผ่าน / ยืนยันตัวตน 2 ชั้น', icon: 'shield' },
};
const NAV = [
  ['ภาพรวม', ['/', '/review']],
  ['งานประจำวัน', ['/orders', '/deposits', '/users']],
  ['จัดการร้าน', ['/catalog', '/providers', '/reports', '/api-keys']],
  ['ระบบ', ['/logs', '/settings', 'account']],
];
const POLL_MS = 30000;

let cleanup = null;
let pollTimer = null;
let router = null;
let unsubscribe = null;

// ───────────── เข้าสู่ระบบ ─────────────

function renderLogin(message = '') {
  stopPolling();
  if (cleanup) {
    try { cleanup(); } catch { /* ignore */ }
    cleanup = null;
  }
  unsubscribe?.();
  unsubscribe = null;
  document.querySelectorAll('dialog.modal[open]').forEach((d) => d.close());
  app.innerHTML = html`<div class="adm-login">
    <form class="card stack" data-login autocomplete="on" style="--gap:14px">
      <div><div class="logo">TP</div><h1 class="mb-0">หลังบ้านระบบเติมเงิน</h1><p class="muted small mb-0">สำหรับผู้ดูแลระบบเท่านั้น</p></div>
      ${message ? html`<div class="alert warning"><span class="alert-icon">!</span><div>${message}</div></div>` : ''}
      <div class="alert danger hidden" data-err><span class="alert-icon">!</span><div data-err-text></div></div>
      <div class="field"><label for="lg-id">อีเมลหรือเบอร์โทร</label><input class="input" id="lg-id" name="identifier" autocomplete="username" required><div class="error-text"></div></div>
      <div class="field"><label for="lg-pw">รหัสผ่าน</label><input class="input" id="lg-pw" name="password" type="password" autocomplete="current-password" required><div class="error-text"></div></div>
      <button class="btn primary lg block" type="submit" data-loading-text="กำลังเข้าสู่ระบบ...">เข้าสู่ระบบ</button>
      <a class="small center" href="/">← ไปหน้าเว็บลูกค้า</a>
    </form>
  </div>`.toString();
  const form = app.querySelector('[data-login]');
  const errBox = form.querySelector('[data-err]');
  form.querySelector('[name="identifier"]').focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    errBox.classList.add('hidden');
    const btn = form.querySelector('button[type="submit"]');
    withLoading(btn, async () => {
      try {
        let d = await api.post('/api/auth/login', {
          identifier: form.querySelector('[name="identifier"]').value.trim(),
          password: form.querySelector('[name="password"]').value,
        });
        if (d.mfa_required) {
          // เปิดยืนยันตัวตน 2 ชั้น → ขอรหัส 6 หลักก่อน
          d = await verifyLoginMfa(d.mfa_token);
          if (!d) return;
        }
        session.user = d.user;
        if (d.user.role !== 'admin') {
          form.querySelector('[data-err-text]').textContent = 'บัญชีนี้ไม่มีสิทธิ์แอดมิน';
          errBox.classList.remove('hidden');
          return;
        }
        startApp();
      } catch (err) {
        if (!showFieldError(form, err)) {
          form.querySelector('[data-err-text]').textContent = err.message;
          errBox.classList.remove('hidden');
        }
      }
    });
  });
}

// ───────────── โครงหน้า ─────────────

function navHtml() {
  return NAV.map(([group, paths]) => html`<div class="nav-group">${group}</div>${paths.map((p) => {
    const ext = EXTERNAL[p];
    if (ext) {
      return html`<a href="${ext.href}" target="_blank" rel="noopener" class="nav-ext" title="เปิดในแท็บใหม่ (หน้าเว็บลูกค้า บัญชีเดียวกับที่ใช้อยู่)">${icon(ext.icon)}<span class="nav-txt">${ext.title}<span class="nav-sub">${ext.sub}</span></span>${icon('external', 'ico ext')}</a>`;
    }
    const pg = PAGES[p];
    return html`<a href="#${p}" data-path="${p}">${icon(pg.icon)}<span class="nav-txt">${pg.title}</span>${pg.count ? html`<span class="count hidden" data-count="${pg.count}"></span>` : ''}</a>`;
  })}`);
}

function renderShell() {
  const u = session.user;
  app.innerHTML = html`<div class="adm" data-shell>
    <aside class="adm-side" aria-label="เมนูหลัก">
      <div class="adm-brand"><div class="logo">TP</div><div><div class="t1" data-site>หลังบ้าน</div><div class="t2">ระบบเติมเงิน & แพ็กเกจเน็ต</div></div></div>
      <nav class="adm-nav">${navHtml()}</nav>
      <div class="adm-side-foot">
        <a class="btn ghost sm" href="/" target="_blank" rel="noopener">${icon('external')}เปิดหน้าเว็บลูกค้า</a>
        <div class="adm-user"><div class="avatar">${(u.name || 'A').slice(0, 1)}</div><div class="grow"><div class="name truncate">${u.name}</div><div class="mail truncate">${u.email || u.phone || ''}</div></div>
          <button class="btn ghost sm icon" data-logout title="ออกจากระบบ" aria-label="ออกจากระบบ">${icon('logout')}</button></div>
      </div>
    </aside>
    <div class="adm-overlay" data-overlay></div>
    <div class="adm-main">
      <header class="adm-top">
        <button class="btn ghost icon menu-btn" data-menu aria-label="เปิดเมนู" aria-expanded="false">${icon('menu')}</button>
        <h1 data-title>แดชบอร์ด</h1>
        <span class="grow"></span>
        <span class="top-mode" data-mode></span>
        <span class="top-user small muted">${u.name}</span>
      </header>
      <div class="adm-banners" data-banners></div>
      <main class="adm-content" id="page" tabindex="-1"></main>
    </div>
  </div>`.toString();

  const shell = app.querySelector('[data-shell]');
  const menuBtn = app.querySelector('[data-menu]');
  const setNav = (open) => {
    shell.classList.toggle('nav-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  const closeNav = () => setNav(false);
  menuBtn.addEventListener('click', () => setNav(!shell.classList.contains('nav-open')));
  app.querySelector('[data-overlay]').addEventListener('click', closeNav);
  shell.addEventListener('keydown', (e) => { if (e.key === 'Escape' && shell.classList.contains('nav-open')) closeNav(); });
  on(app, 'click', '.adm-nav a', closeNav);
  app.querySelector('[data-logout]').addEventListener('click', async () => {
    try { await api.post('/api/auth/logout'); } catch { /* ไม่เป็นไร */ }
    session.user = null;
    session.csrf = null;
    renderLogin('ออกจากระบบแล้ว');
  });
  on(app.querySelector('[data-banners]'), 'click', '[data-reset-breaker]', async (e, b) => {
    const name = b.dataset.resetBreaker;
    const p = store.dash?.provider?.providers?.find((x) => x.name === name);
    // เปิดรับทันทีทั้งที่ยังไม่ได้แก้ปัญหา (เช่น KYC / IP / key) อาจโดนผู้ให้บริการบล็อก → ยืนยันก่อน
    const ok = await confirmDialog({
      title: `เปิดรับรายการ${p ? ` ${p.label}` : ''} ทันที`,
      body: `${p?.breaker?.reason ? `เหตุที่พัก: ${p.breaker.reason} — ` : ''}เปิดใช้เมื่อแก้ปัญหาแล้วเท่านั้น ถ้ายังไม่ได้แก้ ระบบจะส่งรายการแล้วล้มเหลวซ้ำ`,
      confirmText: 'เปิดรับรายการ',
      danger: true,
    });
    if (!ok) return;
    withLoading(b, async () => {
      try {
        await api.post(name ? `/api/admin/providers/${encodeURIComponent(name)}/reset-breaker` : '/api/admin/provider/reset-breaker');
        toast('เปิดรับรายการแล้ว', 'success');
        await store.refresh();
      } catch (err) { toastError(err); }
    });
  });
}

function updateStatus(d, catalog) {
  if (!d) return;
  const setCount = (key, n, cls) => {
    const el = app.querySelector(`[data-count="${key}"]`);
    if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.className = `count ${cls}${n > 0 ? '' : ' hidden'}`;
  };
  setCount('review', d.needs_review, 'danger');
  setCount('deposits', d.deposits_waiting?.c || 0, 'warning');

  const p = d.provider;
  // หลายเจ้า: ดูทุกเจ้าที่เปิดใช้ (ระบบยังรับรายการได้ ถ้ายังเหลือเจ้าที่พร้อม)
  const all = Array.isArray(p?.providers) && p.providers.length ? p.providers : null;
  const enabled = all ? all.filter((x) => x.enabled) : [];
  const ready = enabled.filter((x) => x.config?.ready);
  const mode = app.querySelector('[data-mode]');
  if (mode && p) {
    const liveNames = enabled.filter((x) => x.live).map((x) => shortLabel(x)).join(' + ');
    const long = p.live ? `ใช้งานจริง (${liveNames || shortLabel(p)})` : 'โหมดทดสอบ (MOCK)';
    // จอแคบ: แสดงข้อความสั้น (ชื่อเจ้าเต็มอยู่ใน title และหน้าผู้ให้บริการ)
    mode.innerHTML = html`<a class="mode-badge ${p.live ? 'live' : 'mock'}" href="#/providers" title="${long}"><span class="mb-long">${long}</span><span class="mb-short">${p.live ? 'ใช้งานจริง' : 'ทดสอบ'}</span></a>`.toString();
  }
  const site = app.querySelector('[data-site]');
  if (site && catalog?.settings?.site_name) site.textContent = catalog.settings.site_name;

  const banners = [];
  const resetBtn = (x) => html`<button class="btn sm danger" data-reset-breaker="${x.name}">เปิดรับ ${x.label} ทันที</button>`;
  if (all) {
    const notReady = enabled.filter((x) => !x.config?.ready);
    if (!ready.length) {
      banners.push(html`<div class="alert danger"><span class="alert-icon">!</span><div><b>ไม่มีผู้ให้บริการที่ตั้งค่าครบ — ระบบไม่รับรายการใหม่ (ยังไม่ตัดเงินลูกค้า)</b>
        <ul class="check-list small">${notReady.flatMap((x) => (x.config?.missing || []).map((m) => html`<li>${x.label}: ${m}</li>`))}</ul><a class="small" href="#/providers">ดูหน้าผู้ให้บริการ</a></div></div>`);
    } else if (notReady.length) {
      banners.push(html`<div class="alert warning"><span class="alert-icon">!</span><div>${notReady.map((x) => x.label).join(', ')} ตั้งค่าไม่ครบ — ระบบใช้เจ้าอื่นแทน · <a href="#/providers">ดูรายละเอียด</a></div></div>`);
    }
    const paused = ready.filter((x) => x.breaker?.open);
    if (paused.length && paused.length === ready.length) {
      banners.push(html`<div class="alert danger"><span class="alert-icon">!</span><div class="grow"><b>หยุดรับรายการชั่วคราว</b> — ผู้ให้บริการทุกเจ้าถูกพัก
        <ul class="check-list small">${paused.map((x) => html`<li>${x.label}: ${x.breaker.reason || x.breaker.lastError || '-'} (เปิดรับเองเวลา ${dateTimeSec(x.breaker.openUntil)})</li>`)}</ul></div>
        <div class="row wrap">${paused.map(resetBtn)}</div></div>`);
    } else if (paused.length) {
      banners.push(html`<div class="alert warning"><span class="alert-icon">!</span><div class="grow">พัก ${paused.map((x) => x.label).join(', ')} ชั่วคราว (${paused.map((x) => x.breaker.reason || x.breaker.lastError || '-').join(' / ')}) — รายการใหม่ไปเจ้าสำรอง</div>
        <div class="row wrap">${paused.map(resetBtn)}</div></div>`);
    }
  } else {
    if (p && !p.config.ready) {
      banners.push(html`<div class="alert danger"><span class="alert-icon">!</span><div><b>ผู้ให้บริการยังตั้งค่าไม่ครบ — ระบบไม่รับรายการใหม่ (ยังไม่ตัดเงินลูกค้า)</b>
        <ul class="check-list small">${p.config.missing.map((m) => html`<li>${m}</li>`)}</ul><a class="small" href="#/settings">ดูหน้าตั้งค่า</a></div></div>`);
    }
    if (p?.breaker?.open) {
      banners.push(html`<div class="alert danger"><span class="alert-icon">!</span><div class="grow"><b>หยุดรับรายการชั่วคราว</b> — เชื่อมต่อผู้ให้บริการล้มเหลวติดกัน ${p.breaker.consecutiveFailures} ครั้ง (ล่าสุด: ${p.breaker.lastError || '-'}) จะเปิดรับเองเวลา ${dateTimeSec(p.breaker.openUntil)}</div>
        <button class="btn sm danger" data-reset-breaker="">เปิดรับรายการทันที</button></div>`);
    }
  }
  if (catalog?.settings?.maintenance_mode) {
    banners.push(html`<div class="alert warning"><span class="alert-icon">!</span><div><b>ระบบอยู่ในโหมดปิดปรับปรุง</b> — ลูกค้าทำรายการใหม่ไม่ได้ · <a href="#/settings">ปิดโหมดนี้ที่หน้าตั้งค่า</a></div></div>`);
  }
  const bannerBox = app.querySelector('[data-banners]');
  if (bannerBox) bannerBox.innerHTML = html`${banners}`.toString();
}

// เซสชันในเบราว์เซอร์ถูกแทนด้วยบัญชีที่ไม่ใช่แอดมิน (เช่น เข้าสู่ระบบหน้าเว็บลูกค้าจากแท็บอื่น) → กลับไปหน้าเข้าสู่ระบบ
async function checkStillAdmin(err) {
  if (err?.status !== 403 || err.code !== 'FORBIDDEN' || !session.user) return;
  try {
    const u = await loadMe();
    if (!u || u.role !== 'admin') renderLogin('บัญชีที่เข้าสู่ระบบในเบราว์เซอร์นี้เปลี่ยนไปแล้ว (ไม่ใช่แอดมิน) กรุณาเข้าสู่ระบบด้วยบัญชีแอดมิน');
  } catch { /* เชื่อมต่อไม่ได้ → ลองรอบหน้า */ }
}

// รีเฟรชอัตโนมัติ = โหลดแบบเบื้องหลัง (X-Background: 1) ไม่นับเป็นการใช้งาน — เซสชันที่ไม่มีคนใช้จึงหมดอายุตามกำหนด
const backgroundRefresh = () => store.refresh({ background: true }).catch(checkStillAdmin);
// กลับมาที่แท็บนี้หลังจากไปที่อื่นนานกว่ารอบรีเฟรช → อัปเดตตัวเลขทันที (ไม่ต้องรอรอบถัดไป)
const onVisible = () => {
  if (document.visibilityState === 'visible' && session.user && Date.now() - store.lastAt > POLL_MS) backgroundRefresh();
};

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') backgroundRefresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', onVisible);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  document.removeEventListener('visibilitychange', onVisible);
}

async function showPage(path, params, query) {
  const page = PAGES[path] || PAGES['/'];
  const old = document.getElementById('page');
  if (!old || !session.user) return; // อยู่หน้าเข้าสู่ระบบ
  // สร้างกล่องเนื้อหาใหม่ทุกครั้ง เพื่อไม่ให้ event listener ของหน้าเก่าค้างอยู่
  const el = old.cloneNode(false);
  old.replaceWith(el);
  if (cleanup) {
    try { cleanup(); } catch { /* ignore */ }
    cleanup = null;
  }
  app.querySelectorAll('.adm-nav a').forEach((a) => a.classList.toggle('active', a.dataset.path === path));
  const title = app.querySelector('[data-title]');
  if (title) title.textContent = page.title;
  document.title = `${page.title} - หลังบ้าน`;
  el.innerHTML = '';
  try {
    const result = await page.render(el, params, query);
    if (typeof result === 'function') cleanup = result;
  } catch (err) {
    el.innerHTML = html`<div class="alert danger"><span class="alert-icon">!</span><div>${err.message || 'เกิดข้อผิดพลาด'}</div></div>`.toString();
  }
}

function startApp() {
  renderShell();
  unsubscribe?.();
  unsubscribe = store.subscribe(updateStatus);
  store.refresh().catch((err) => { toastError(err); checkStillAdmin(err); });
  startPolling();
  const routes = {};
  for (const path of Object.keys(PAGES)) routes[path] = (params, query) => showPage(path, params, query);
  if (!router) {
    router = createRouter(routes, { notFound: () => navigate('/') });
  }
  router.start();
}

window.addEventListener('session-expired', (e) => {
  // ข้อความจากเซิร์ฟเวอร์ (เช่น ไม่มีการใช้งานนานเกินกำหนด) — ข้อความทั่วไป "กรุณาเข้าสู่ระบบ" ใช้ข้อความเดิมที่อธิบายมากกว่า
  const why = String(e?.detail?.message || '').trim();
  const generic = 'เซสชันหมดอายุ (หรือไม่มีการใช้งานนานเกินกำหนด) กรุณาเข้าสู่ระบบใหม่';
  renderLogin(!why || why === 'กรุณาเข้าสู่ระบบ' ? generic : /เข้าสู่ระบบ/.test(why) ? why : `${why} — กรุณาเข้าสู่ระบบใหม่`);
});

// กันตัวเลขเปลี่ยนเองตอนเลื่อนหน้าจอด้วยล้อเมาส์ขณะเคอร์เซอร์อยู่ในช่องตัวเลข (เช่น ส่วนลด / ยอดเงิน)
document.addEventListener('wheel', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type === 'number' && document.activeElement === t) t.blur();
}, { passive: true });

(async function boot() {
  try {
    const user = await loadMe();
    if (user && user.role === 'admin') startApp();
    else renderLogin(user ? 'บัญชีที่เข้าสู่ระบบอยู่ไม่มีสิทธิ์แอดมิน กรุณาเข้าสู่ระบบด้วยบัญชีแอดมิน' : '');
  } catch (err) {
    app.innerHTML = html`<div class="container mt-4"><div class="alert danger"><span class="alert-icon">!</span><div>${err.message} <a href="/admin">ลองใหม่</a></div></div></div>`.toString();
  }
}());
