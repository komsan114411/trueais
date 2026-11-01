// โครงหน้าเว็บ: แถบบน, เมนูล่าง (มือถือ), แบนเนอร์สถานะระบบ, ส่วนท้าย
import { html, raw, $, setHTML, baht } from '../lib.js';
import { state } from './state.js';
import { icon } from './icons.js';
import { alertBox, initial } from './ui.js';

const DESKTOP_NAV = [
  { path: '/', label: 'หน้าแรก', icon: 'home' },
  { path: '/topup', label: 'เติมเงิน', icon: 'bolt' },
  { path: '/packages', label: 'แพ็กเกจเน็ต', icon: 'wifi' },
  { path: '/bulk', label: 'เติมหลายเบอร์', icon: 'layers' },
  { path: '/history', label: 'ประวัติ', icon: 'clock' },
  { path: '/wallet', label: 'กระเป๋าเงิน', icon: 'wallet' },
];

const TABS = [
  { path: '/', label: 'หน้าแรก', icon: 'home' },
  { path: '/topup', label: 'เติมเงิน', icon: 'bolt' },
  { path: '/packages', label: 'แพ็กเกจ', icon: 'wifi' },
  { path: '/history', label: 'ประวัติ', icon: 'clock' },
  { path: '/account', label: 'บัญชี', icon: 'user' },
];

function activeNav(path) {
  const p = path.startsWith('/order/') ? '/history' : path.startsWith('/deposit/') ? '/wallet' : path;
  const desktop = DESKTOP_NAV.some((n) => n.path === p) ? p : '';
  const tabMap = { '/': '/', '/topup': '/topup', '/bulk': '/topup', '/packages': '/packages', '/history': '/history' };
  const tab = tabMap[p] || (['/account', '/wallet', '/phonebook', '/login', '/register'].includes(p) ? '/account' : '');
  return { desktop, tab };
}

const currentPath = () => (location.hash.slice(1) || '/').split('?')[0] || '/';

export function renderShell() {
  const path = currentPath();
  const s = state.catalog?.settings || {};
  const u = state.user;
  const active = activeNav(path);

  setHTML($('#topbar'), html`<div class="container topbar-inner">
    <a class="brand" href="#/" aria-label="${s.site_name || 'หน้าแรก'}">
      <span class="brand-logo">${icon('bolt', 20)}</span>
      <span class="brand-text"><span class="brand-name">${s.site_name || 'TopUp'}</span><span class="brand-tag">${s.site_tagline || ''}</span></span>
    </a>
    <nav class="nav-links" aria-label="เมนูหลัก">
      ${DESKTOP_NAV.map((n) => html`<a href="#${n.path}" class="${active.desktop === n.path ? 'active' : ''}">${icon(n.icon, 18)}${n.label}</a>`)}
    </nav>
    <div class="topbar-right">
      ${u
        ? html`<a class="balance-chip" href="#/wallet" title="ยอดเงินในกระเป๋า">${icon('wallet', 18)}<span class="num">฿${baht(u.balance)}</span></a>
               <a class="avatar-btn ${path === '/account' ? 'active' : ''}" href="#/account" title="${u.name}">${initial(u.name)}</a>`
        : html`<a class="btn ghost sm" href="#/login">เข้าสู่ระบบ</a>
               ${s.registration_enabled !== false ? html`<a class="btn primary sm hide-sm" href="#/register">สมัครสมาชิก</a>` : ''}`}
    </div>
  </div>`);

  setHTML($('#tabbar'), TABS.map((t) => html`<a href="#${t.path}" class="${active.tab === t.path ? 'active' : ''}" ${active.tab === t.path ? raw('aria-current="page"') : ''}>${icon(t.icon, 23)}<span>${t.label}</span></a>`));
  renderBanners();
  renderFooter();
}

export function renderBanners() {
  const c = state.catalog;
  if (!c) return;
  const items = [];
  if (c.settings.maintenance_mode) {
    items.push(alertBox('danger', html`<b>ปิดปรับปรุงระบบชั่วคราว</b> — ${c.settings.maintenance_message || 'กรุณาลองใหม่ภายหลัง'}`));
  } else if (!c.mode.ready) {
    items.push(alertBox('warning', html`<b>ระบบเติมเงินยังไม่พร้อมให้บริการ</b> — ผู้ดูแลกำลังตั้งค่า ยังทำรายการไม่ได้ชั่วคราว`));
  } else if (c.mode.paused) {
    items.push(alertBox('warning', html`<b>ระบบผู้ให้บริการขัดข้องชั่วคราว</b> — หยุดรับรายการใหม่ชั่วคราวเพื่อความปลอดภัย กรุณาลองใหม่ในอีกสักครู่`));
  }
  if (!c.mode.live) {
    items.push(html`<div class="test-banner">${icon('flask', 16)}<span><b>โหมดทดสอบ</b> — ไม่มีการเติมเงินจริง ผลลัพธ์ทั้งหมดเป็นการจำลอง</span></div>`);
  }
  if (c.settings.announcement) items.push(alertBox('info', html`<span class="pre-line">${c.settings.announcement}</span>`));
  setHTML($('#banners'), items.length ? html`<div class="container banner-stack">${items}</div>` : '');
}

function renderFooter() {
  const s = state.catalog?.settings || {};
  setHTML($('#footer'), html`<div class="site-footer"><div class="container">
    <span>© ${new Date().getFullYear() + 543} ${s.site_name || ''} · เติมเงินมือถือ & แพ็กเกจเน็ต AIS • True • dtac</span>
    <span class="row wrap" style="--gap:14px">
      ${s.support_line ? html`<span class="row" style="--gap:6px">${icon('headset', 16)} LINE: ${s.support_line}</span>` : ''}
      ${s.support_phone ? html`<span class="row" style="--gap:6px">${icon('phone', 16)} โทร: ${s.support_phone}</span>` : ''}
    </span>
  </div></div>`);
}
