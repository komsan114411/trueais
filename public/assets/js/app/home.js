// หน้าแรก
import { html, api, on, setHTML, baht, bahtShort, phoneFmt } from '../lib.js';
import { state, netVars, shopList, shopNet, shopOpen, shopServes, networkOf, recentNumbers, refreshUser, openDeposits } from './state.js';
import { icon } from './icons.js';
import { orderItem, emptyState, draftBanner, netTag, depositBanner } from './ui.js';

/**
 * ทางลัด "เติมเบอร์เดิม": เปิดหน้าเติมเงิน/แพ็กเกจพร้อมข้อมูลเดิม (ยังต้องกดยืนยันตามปกติ)
 * เครือข่ายที่ยังไม่เคยเติมสำเร็จ → ไม่ส่งไปในลิงก์ (หน้าเติมเงินจะให้ลูกค้าเลือก/ตรวจเครือข่ายเอง)
 */
function repeatPath(r) {
  const p = new URLSearchParams();
  const ok = Boolean(r.network_confirmed && networkOf(r.network));
  if (ok) p.set('network', r.network);
  p.set('phone', r.phone);
  const pkg = r.last_topup_amount === null && r.last_package_id;
  if (pkg) {
    if (ok) p.set('product', String(r.last_package_id)); // แพ็กเกจผูกกับเครือข่าย → ใส่เฉพาะเมื่อรู้เครือข่ายแน่นอน
  } else if (r.last_topup_amount) {
    p.set('amount', String(r.last_topup_amount));
  }
  if (r.shop) p.set('shop', r.shop);
  return `#/${pkg ? 'packages' : 'topup'}?${p.toString()}`;
}

function repeatCard(r) {
  const ok = Boolean(r.network_confirmed);
  const n = networkOf(r.network);
  const what = r.last_topup_amount !== null ? `เติม ${Number(r.last_topup_amount).toLocaleString('th-TH')} บาท` : 'แพ็กเกจเดิม';
  return html`<a class="repeat-card" href="${repeatPath(r)}" style="${netVars(ok ? n?.color : null)}">
    <span class="repeat-main">
      <span class="num bold">${phoneFmt(r.phone)}</span>
      <span class="xsmall muted">${r.name || ''}${ok ? '' : html`${r.name ? ' · ' : ''}<span class="text-warning">ตรวจเครือข่ายอีกครั้ง</span>`}</span>
    </span>
    <span class="repeat-side">${ok && n ? netTag(n.code) : ''}<span class="repeat-btn">${icon('refresh', 14)} ${what}</span></span>
  </a>`;
}

function netCardLink(n) {
  const closed = !n.topup.open;
  // ส่วนลดตามร้านที่เปิดอยู่ (แต่ละร้านตั้งส่วนลดเองได้) — ไม่มีข้อมูลร้าน = ส่วนลดมาตรฐานของเครือข่าย
  const open = shopList().filter((s) => shopOpen(s) && shopServes(s, n.code));
  const bp = open.length ? Math.max(...open.map((s) => shopNet(s, n.code)?.discount_bp || 0)) : n.topup.discount_bp;
  const label = bp > 0 ? `${open.length > 1 ? 'ลดสูงสุด' : 'ลด'} ${bp / 100}%` : 'เติมเงิน';
  return html`<a class="net-card ${closed ? 'closed' : ''}" href="#/topup?network=${n.code}" style="${netVars(n.color)}">
    <span class="net-logo">${n.name}</span>
    <span class="net-name">${n.full_name}</span>
    <span class="net-sub">${closed ? n.notice || 'ปิดชั่วคราว' : label}</span>
  </a>`;
}

const QUICK = [
  { href: '#/topup', icon: 'bolt', label: 'เติมเงินมือถือ' },
  { href: '#/packages', icon: 'wifi', label: 'แพ็กเกจเน็ต' },
  { href: '#/bulk', icon: 'layers', label: 'เติมหลายเบอร์' },
  { href: '#/history', icon: 'clock', label: 'ประวัติ' },
  { href: '#/wallet', icon: 'wallet', label: 'กระเป๋าเงิน' },
  { href: '#/phonebook', icon: 'book', label: 'สมุดโทรศัพท์' },
];

function pickPopular(products) {
  // เลือกแพ็กเกจกระจายทุกเครือข่าย สูงสุด 6 รายการ
  const byNet = new Map();
  for (const p of products) {
    if (!byNet.has(p.network)) byNet.set(p.network, []);
    byNet.get(p.network).push(p);
  }
  const out = [];
  for (let i = 0; out.length < 6 && i < 10; i++) {
    for (const list of byNet.values()) if (list[i] && out.length < 6) out.push(list[i]);
  }
  return out;
}

export default async function homePage(ctx) {
  const c = state.catalog;
  const s = c.settings;
  let numbers = [];
  let deposits = [];
  if (state.user) {
    // ยอดเงินล่าสุด + เบอร์ที่เคยเติม + เติมเงินเข้ากระเป๋าที่ยังค้าง (โหลดพร้อมกัน)
    [, numbers, deposits] = await Promise.all([
      refreshUser(),
      recentNumbers().catch(() => []),
      openDeposits().catch(() => []),
    ]);
  }
  if (!ctx.alive()) return;
  const u = state.user;
  const popular = pickPopular(c.products);

  setHTML(ctx.view, html`
    <section class="hero">
      <div class="hero-text">
        <div class="hero-kicker">${u ? `สวัสดี คุณ${u.name}` : `ยินดีต้อนรับสู่ ${s.site_name}`}</div>
        <h1>${s.site_tagline || 'เติมเงินมือถือ & แพ็กเกจเน็ต'}</h1>
        <p>เติมได้ตลอด 24 ชั่วโมง · ไม่สำเร็จคืนเงินอัตโนมัติ · ตรวจสอบสถานะได้ทุกรายการ</p>
      </div>
      ${u
        ? html`<a class="hero-balance" href="#/wallet">
            <span class="small hero-muted">ยอดเงินในกระเป๋า</span>
            <span class="hero-amount num">฿${baht(u.balance)}</span>
            <span class="hero-pill">${icon('plus', 16)} เติมเงินเข้ากระเป๋า</span>
          </a>`
        : html`<div class="hero-cta">
            ${s.registration_enabled !== false ? html`<a class="btn lg hero-btn-solid" href="#/register">สมัครสมาชิกฟรี</a>` : ''}
            <a class="btn lg hero-btn-ghost" href="#/login">เข้าสู่ระบบ</a>
          </div>`}
    </section>

    ${u && deposits.length ? html`<div class="mt-2">${depositBanner(deposits)}</div>` : ''}
    ${u && draftBanner() ? html`<div class="mt-2">${draftBanner()}</div>` : ''}

    ${numbers.length ? html`<section class="mt-3">
      <div class="section-h"><h2>เติมเบอร์เดิม</h2><a href="#/phonebook">สมุดโทรศัพท์ ${icon('chevronRight', 16)}</a></div>
      <div class="repeat-grid">${numbers.slice(0, 4).map(repeatCard)}</div>
    </section>` : ''}

    <section class="mt-3">
      <div class="section-h"><h2>เติมเงินมือถือ</h2><a href="#/topup">ทั้งหมด ${icon('chevronRight', 16)}</a></div>
      <div class="net-grid">${c.networks.map(netCardLink)}</div>
    </section>

    <section class="mt-3">
      <div class="quick-grid">
        ${QUICK.map((q) => html`<a class="quick" href="${q.href}"><span class="q-icon">${icon(q.icon, 22)}</span><span>${q.label}</span></a>`)}
      </div>
    </section>

    ${popular.length ? html`<section class="mt-3">
      <div class="section-h"><h2>แพ็กเกจเน็ตยอดนิยม</h2><a href="#/packages">ดูทั้งหมด ${icon('chevronRight', 16)}</a></div>
      <div class="pkg-grid">
        ${popular.map((p) => {
          const n = c.networks.find((x) => x.code === p.network);
          return html`<a class="pkg-card pkg-link" href="#/packages?network=${p.network}&product=${p.id}" style="${netVars(n?.color)}">
            <div class="pkg-top"><span class="pkg-cat">${p.category}</span>${netTag(p.network)}</div>
            <div class="pkg-data">${p.data_label || p.name}</div>
            <div class="pkg-name">${p.name}</div>
            <div class="pkg-foot"><span class="pkg-price num">฿${bahtShort(p.price)}</span>${p.validity_days ? html`<span class="pkg-days">${icon('calendar', 14)} ${p.validity_days} วัน</span>` : ''}</div>
          </a>`;
        })}
      </div>
    </section>` : ''}

    ${u ? html`<section class="mt-3">
      <div class="section-h"><h2>รายการล่าสุด</h2><a href="#/history">ดูทั้งหมด ${icon('chevronRight', 16)}</a></div>
      <div class="card flush" data-recent-orders><div class="p-3 stack">${[1, 2, 3].map(() => html`<div class="skeleton" style="height:52px"></div>`)}</div></div>
    </section>` : ''}

    <section class="trust mt-3">
      <div class="trust-item"><span class="t-icon">${icon('shield', 20)}</span><div><div class="bold">ไม่ตัดเงินซ้ำ</div><div class="small muted">กันกดซ้ำ กันเน็ตหลุด ทุกรายการมีเลขอ้างอิง</div></div></div>
      <div class="trust-item"><span class="t-icon">${icon('refresh', 20)}</span><div><div class="bold">ไม่สำเร็จคืนเงินอัตโนมัติ</div><div class="small muted">คืนเข้ากระเป๋าทันทีเมื่อผู้ให้บริการแจ้งไม่สำเร็จ</div></div></div>
      <div class="trust-item"><span class="t-icon">${icon('clock', 20)}</span><div><div class="bold">ตรวจสอบสถานะได้ตลอด</div><div class="small muted">ดูความคืบหน้าทุกขั้นตอนในประวัติ</div></div></div>
    </section>`);

  // รายการล่าสุด: โหลดแยก — โหลดไม่สำเร็จต้องบอกว่าโหลดไม่ได้ (ไม่ใช่ขึ้นว่า "ยังไม่มีรายการ")
  const box = ctx.view.querySelector('[data-recent-orders]');
  async function loadRecent() {
    if (!box) return;
    let rows;
    try {
      rows = (await api.get('/api/orders?pageSize=5', { timeout: 20000 })).rows || [];
    } catch (err) {
      if (ctx.alive()) {
        setHTML(box, emptyState('alert', 'โหลดรายการล่าสุดไม่สำเร็จ', err.message, html`<button type="button" class="btn sm" data-retry-recent>${icon('refresh', 16)} ลองใหม่</button>`));
      }
      return;
    }
    if (!ctx.alive()) return;
    setHTML(box, rows.length ? html`<div class="order-list">${rows.map((o) => orderItem(o))}</div>`
      : emptyState('clock', 'ยังไม่มีรายการ', 'เริ่มเติมเงินหรือสมัครแพ็กเกจได้เลย', html`<a class="btn primary sm" href="#/topup">เติมเงินมือถือ</a>`));
  }
  if (box) {
    on(box, 'click', '[data-retry-recent]', (e, el) => {
      el.disabled = true;
      loadRecent();
    });
    loadRecent();
  }
}
