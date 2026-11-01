// หน้าเว็บลูกค้า — จุดเริ่มต้น: โหลดข้อมูล → ตั้ง router → แสดงหน้า
import { $, html, setHTML, createRouter, navigate, loadMe, qs, toast, on } from './lib.js';
import { state, loadCatalog, setUser, onChange } from './app/state.js';
import { renderShell } from './app/shell.js';
import { skeletonPage, errorView } from './app/ui.js';
import { icon } from './app/icons.js';
import homePage from './app/home.js';
import topupPage from './app/topup.js';
import packagesPage from './app/packages.js';
import bulkPage from './app/bulk.js';
import historyPage from './app/history.js';
import orderPage from './app/order.js';
import { walletPage, depositPage } from './app/wallet.js';
import phonebookPage from './app/phonebook.js';
import { accountPage, loginPage, registerPage } from './app/account.js';

const TITLES = {
  '/': 'หน้าแรก',
  '/topup': 'เติมเงินมือถือ',
  '/packages': 'แพ็กเกจเน็ต',
  '/bulk': 'เติมหลายเบอร์',
  '/history': 'ประวัติการทำรายการ',
  '/order/:ref': 'สถานะรายการ',
  '/wallet': 'กระเป๋าเงิน',
  '/deposit/:id': 'เติมเงินเข้ากระเป๋า',
  '/phonebook': 'สมุดโทรศัพท์',
  '/account': 'บัญชีของฉัน',
  '/login': 'เข้าสู่ระบบ',
  '/register': 'สมัครสมาชิก',
};
const NEED_LOGIN = new Set(['/bulk', '/history', '/order/:ref', '/wallet', '/deposit/:id', '/phonebook', '/account']);

let navId = 0;
let cleanups = [];

/** ห่อหน้าแต่ละหน้า: สร้างพื้นที่ใหม่ทุกครั้ง (event ของหน้าเก่าไม่ค้าง) + ล้าง timer ของหน้าเก่า */
function page(fn) {
  return async (params, query, info) => {
    cleanups.splice(0).forEach((f) => { try { f(); } catch { /* ignore */ } });
    const id = ++navId;
    const main = $('#view');
    const view = document.createElement('div');
    view.className = 'page';
    main.replaceChildren(view);
    const ctx = {
      view, params, query, path: info.path, pattern: info.pattern,
      alive: () => id === navId,
      onLeave: (f) => cleanups.push(f),
    };
    document.title = `${TITLES[info.pattern] || ''} · ${state.catalog?.settings.site_name || 'TopUp'}`;
    renderShell();
    setHTML(view, skeletonPage());
    window.scrollTo(0, 0);
    // ข้อมูลเก่ากว่า 30 วินาที → โหลดใหม่ก่อนแสดงหน้า (สถานะปิดปรับปรุง / เครือข่ายปิด / ราคา)
    if (Date.now() - state.catalogAt > 30000) {
      try { await loadCatalog(true); } catch { /* ออฟไลน์ → ใช้ข้อมูลเดิม */ }
      if (!ctx.alive()) return;
    }
    try {
      await fn(ctx);
    } catch (err) {
      console.error(err);
      if (ctx.alive()) setHTML(view, errorView(err));
    }
  };
}

function bootError(err) {
  setHTML($('#view'), html`<div class="empty">
    <div class="empty-icon">${icon('alert', 40)}</div>
    <div class="bold text-2">เชื่อมต่อระบบไม่ได้</div>
    <div class="small mt-1">${err?.message || 'กรุณาลองใหม่อีกครั้ง'}</div>
    <div class="mt-2"><button class="btn primary" data-reload>${icon('refresh', 18)} ลองใหม่</button></div>
  </div>`);
}

async function boot() {
  on(document.body, 'click', '[data-reload]', () => location.reload());
  try {
    const [, user] = await Promise.all([loadCatalog(true), loadMe()]);
    state.user = user;
  } catch (err) {
    bootError(err);
    return;
  }

  const router = createRouter({
    '/': page(homePage),
    '/topup': page(topupPage),
    '/packages': page(packagesPage),
    '/bulk': page(bulkPage),
    '/history': page(historyPage),
    '/order/:ref': page(orderPage),
    '/wallet': page(walletPage),
    '/deposit/:id': page(depositPage),
    '/phonebook': page(phonebookPage),
    '/account': page(accountPage),
    '/login': page(loginPage),
    '/register': page(registerPage),
  }, {
    notFound: () => navigate('/'),
    before: ({ pattern, path, query }) => {
      if (NEED_LOGIN.has(pattern) && !state.user) {
        navigate(`/login?next=${encodeURIComponent(path + qs(query))}`);
        return false;
      }
      return true;
    },
  });

  onChange(() => renderShell());
  let expiredAt = 0;
  window.addEventListener('session-expired', () => {
    setUser(null);
    if (Date.now() - expiredAt < 3000) return; // หลายคำขอได้ 401 พร้อมกัน → แจ้ง/พาไปหน้าเข้าสู่ระบบครั้งเดียว
    expiredAt = Date.now();
    // ปิดหน้าต่างที่ค้างอยู่ (เช่น หน้าต่างยืนยันรายการ) — ทำรายการต่อไม่ได้แล้วจนกว่าจะเข้าสู่ระบบใหม่
    document.querySelectorAll('dialog.modal[open]').forEach((d) => d.close());
    toast('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'warning', 5000);
    const here = location.hash.slice(1) || '/';
    if (!here.startsWith('/login')) navigate(`/login?next=${encodeURIComponent(here)}`);
  });
  // กลับมาที่แท็บนี้ → อัปเดตยอดเงิน/สถานะระบบ
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadCatalog(true).catch(() => {});
      if (state.user) {
        loadMe()
          .then((u) => {
            if (u) setUser(u);
            else window.dispatchEvent(new CustomEvent('session-expired'));
          })
          .catch(() => {});
      }
    }
  });

  await router.start();
}

boot();
