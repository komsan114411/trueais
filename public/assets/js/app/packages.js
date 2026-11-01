// หน้าแพ็กเกจเน็ต: เบอร์ → เลือกเครือข่าย → เลือกร้าน → เลือกหมวด/แพ็กเกจ → ยืนยัน
import { html, raw, on, setHTML, bahtShort, navigate, debounce, toast } from '../lib.js';
import { state, networkOf, orderBlockReason, netVars, onChange, shopList, shopOf, shopOpen, lastShop, refreshUser } from './state.js';
import { icon } from './icons.js';
import { pageHead, netTag, mockTips, emptyState, alertBox, nudge } from './ui.js';
import { phoneFieldHtml, bindPhoneField } from './phonefield.js';
import { confirmAndOrder } from './confirm.js';
import { netChoice } from './netchoice.js';

export default async function packagesPage(ctx) {
  const q = ctx.query;
  const cat = () => state.catalog;
  const shops = () => shopList();
  const preselect = q.product ? cat().products.find((p) => String(p.id) === String(q.product)) : null;
  const st = {
    category: 'all',
    selected: preselect?.id || null,
    phone: null,
    shop: null,
  };
  let shopTouched = Boolean(q.shop && shopOf(String(q.shop).toLowerCase()));
  let shopNotice = '';
  let quotingId = null; // แพ็กเกจที่กำลังขอราคา (แสดงสถานะบนปุ่ม แทนการกดแล้วเงียบ)
  let lastNet = null;
  if (state.user) refreshUser(); // ยอดเงินล่าสุด

  // เครือข่าย: แพ็กเกจ/ลิงก์ระบุมา = ใช้ตามนั้น · เบอร์ที่เคยเติมสำเร็จ = เลือกให้ · เบอร์ใหม่ = ให้ลูกค้าเลือกเอง
  const nc = netChoice({ ctx, kind: 'package', network: preselect?.network || q.network, phone: q.phone, retry: q.retry, onUpdate: () => onNetUpdate() });

  setHTML(ctx.view, html`
    ${pageHead('แพ็กเกจเน็ต', 'สมัครแพ็กเกจเสริม เน็ต / โทร ใช้งานได้ทันที')}
    ${!cat().mode.live ? mockTips() : ''}
    <section class="card mb-2" data-phone-card>
      <div class="step-title"><span class="step-no">1</span>เบอร์ที่จะสมัครแพ็กเกจ</div>
      ${phoneFieldHtml({ value: q.phone || '', recent: true })}
    </section>
    <section class="card">
      <div class="step-title"><span class="step-no">2</span>เลือกเครือข่าย ร้าน และแพ็กเกจ</div>
      <div class="net-step" data-tabs></div>
      <div data-notice></div>
      <div data-shops></div>
      <div data-shop-notice></div>
      <div class="chips mt-2" data-cats></div>
      <div class="pkg-grid mt-2" data-grid></div>
      <p class="xsmall muted mt-2 mb-0 row top" style="--gap:6px">${icon('info', 14)}<span>เบอร์ที่ย้ายค่าย ให้เลือกแพ็กเกจของเครือข่ายที่ใช้งานอยู่ปัจจุบัน · เงื่อนไขแพ็กเกจเป็นไปตามที่เครือข่ายกำหนด</span></p>
    </section>`);

  const view = ctx.view;
  const phoneCard = view.querySelector('[data-phone-card]');
  const tabsEl = view.querySelector('[data-tabs]');
  const noticeEl = view.querySelector('[data-notice]');
  const shopsEl = view.querySelector('[data-shops]');
  const shopNoticeEl = view.querySelector('[data-shop-notice]');
  const catsEl = view.querySelector('[data-cats]');
  const gridEl = view.querySelector('[data-grid]');

  /** แพ็กเกจของเครือข่ายนี้ที่ร้านนี้ขาย (ไม่มีข้อมูลร้าน = ทุกแพ็กเกจ ระบบเลือกร้านให้) */
  const productsAt = (shop, netCode) => cat().products.filter((p) => p.network === netCode
    && (!shops().length || !shop || (shop.product_ids || []).includes(p.id)));
  const productsOf = (netCode) => productsAt(shopOf(st.shop), netCode);

  /** ร้านเริ่มต้น: ร้านใน URL / ร้านที่ใช้ล่าสุด (ถ้าเปิดและมีแพ็กเกจค่ายนี้) → ไม่งั้นร้านแรกที่มีแพ็กเกจค่ายนี้ */
  function autoShop() {
    const list = shops();
    if (!list.length) return null;
    if (list.length === 1) return list[0].code;
    const ok = list.filter((s) => shopOpen(s) && productsAt(s, nc.code).length
      && (!preselect || preselect.network !== nc.code || (s.product_ids || []).includes(preselect.id)));
    const pref = [q.shop ? String(q.shop).toLowerCase() : null, lastShop()].find((c) => c && ok.some((s) => s.code === c));
    return pref || ok[0]?.code || list.find(shopOpen)?.code || null;
  }
  function pickShop() {
    const s = shopOf(st.shop);
    if (shopTouched && s && shopOpen(s) && productsAt(s, nc.code).length) return;
    if (shopTouched && s && nc.code) shopNotice = `${s.name} ${!shopOpen(s) ? 'ปิดชั่วคราว' : 'ยังไม่มีแพ็กเกจของเครือข่ายนี้'} — เลือกร้านอื่นให้แล้ว`;
    if (shopTouched && !nc.code) return; // ยังไม่ได้เลือกเครือข่าย → คงร้านที่ลูกค้าเลือกไว้
    shopTouched = false;
    st.shop = autoShop();
  }

  /** เครือข่ายเปลี่ยน → ล้างหมวด/แพ็กเกจที่เลือกของเครือข่ายเดิม + เลือกร้านใหม่ถ้าจำเป็น */
  function onNetUpdate() {
    if (nc.code !== lastNet) {
      lastNet = nc.code;
      st.category = 'all';
      const sel = cat().products.find((p) => p.id === st.selected);
      if (sel && sel.network !== nc.code) st.selected = null;
      pickShop();
    }
    renderAll();
  }

  function renderTabs() {
    const count = (n) => cat().products.filter((p) => p.network === n.code).length;
    setHTML(tabsEl, html`${nc.label()}${nc.buttons({ sub: (n) => `${count(n)} แพ็กเกจ` })}`);
    const notes = nc.notices();
    setHTML(noticeEl, notes.length ? html`<div class="stack mt-2" style="--gap:8px">${notes}</div>` : '');
  }

  function renderShops() {
    const list = shops();
    if (list.length < 2) {
      // ร้านเดียว (เลือกให้แล้ว) หรือไม่มีข้อมูลร้าน → ไม่ต้องเลือก
      setHTML(shopsEl, list.length === 1 ? html`<div class="small muted mt-2">ร้าน: <b>${list[0].name}</b>${list[0].paused ? html` <span class="badge danger">ปิดชั่วคราว</span>` : ''}</div>` : '');
    } else if (!nc.code) {
      setHTML(shopsEl, '');
    } else {
      setHTML(shopsEl, html`<div class="label mt-2 mb-1">ร้าน</div><div class="chips">${list.map((s) => {
        const n = productsAt(s, nc.code).length;
        return html`<button type="button" class="chip sm ${s.code === st.shop ? 'active' : ''}" data-shop="${s.code}" aria-pressed="${s.code === st.shop ? 'true' : 'false'}"
          ${!shopOpen(s) || !n ? raw('aria-disabled="true"') : ''}>${s.name} <span class="tab-count">${!shopOpen(s) ? 'ปิดชั่วคราว' : `${n} แพ็กเกจ`}</span></button>`;
      })}</div>`);
    }
    setHTML(shopNoticeEl, shopNotice ? html`<div class="mt-2">${alertBox('warning', shopNotice)}</div>` : '');
  }

  function renderCats() {
    const cats = nc.code ? [...new Set(productsOf(nc.code).map((p) => p.category).filter(Boolean))] : [];
    if (!cats.includes(st.category)) st.category = 'all';
    setHTML(catsEl, cats.length > 1
      ? [html`<button type="button" class="chip sm ${st.category === 'all' ? 'active' : ''}" data-cat="all" aria-pressed="${st.category === 'all' ? 'true' : 'false'}">ทั้งหมด</button>`,
        ...cats.map((c) => html`<button type="button" class="chip sm ${st.category === c ? 'active' : ''}" data-cat="${c}" aria-pressed="${st.category === c ? 'true' : 'false'}">${c}</button>`)]
      : '');
    catsEl.classList.toggle('hidden', cats.length < 2);
  }

  function renderGrid() {
    const n = networkOf(nc.code);
    const s = shopOf(st.shop);
    if (!n) {
      setHTML(gridEl, html`<div class="grid-span">${emptyState('wifi', 'เลือกเครือข่ายของเบอร์นี้ก่อน', 'แล้วจะแสดงแพ็กเกจของเครือข่ายนั้น (เบอร์ที่เคยเติมสำเร็จ ระบบเลือกให้อัตโนมัติ)')}</div>`);
      return;
    }
    const list = productsOf(n.code).filter((p) => st.category === 'all' || p.category === st.category);
    if (!list.length) {
      const title = !n.package.open ? 'ปิดรับสมัครแพ็กเกจชั่วคราว'
        : s && shops().length > 1 ? `${s.name} ยังไม่มีแพ็กเกจของ ${n.name}` : 'ยังไม่มีแพ็กเกจในหมวดนี้';
      setHTML(gridEl, html`<div class="grid-span">${emptyState('wifi', title, shops().length > 1 ? 'ลองเลือกร้าน เครือข่าย หรือหมวดอื่น' : 'ลองเลือกเครือข่ายหรือหมวดอื่น')}</div>`);
      return;
    }
    setHTML(gridEl, list.map((p) => {
      const busy = quotingId === p.id;
      return html`<div class="pkg-card ${st.selected === p.id ? 'selected' : ''}" data-product="${p.id}" style="${netVars(n.color)}">
        <div class="pkg-top"><span class="pkg-cat">${p.category}</span>${netTag(p.network)}</div>
        <div class="pkg-data">${p.data_label || p.name}</div>
        <div class="pkg-name">${p.name}</div>
        ${p.validity_days ? html`<div class="pkg-days">${icon('calendar', 14)} ใช้ได้ ${p.validity_days} วัน</div>` : ''}
        ${p.description ? html`<div class="pkg-desc">${p.description}</div>` : ''}
        <div class="pkg-foot">
          <span class="pkg-price num">฿${bahtShort(p.price)}</span>
          <button type="button" class="btn primary sm ${busy ? 'is-loading' : ''}" data-buy="${p.id}" ${busy ? raw('aria-busy="true"') : ''}>${busy ? html`<span class="spinner"></span>กำลังตรวจสอบ` : 'สมัคร'}</button>
        </div>
      </div>`;
    }));
  }

  const renderAll = () => { renderTabs(); renderShops(); renderCats(); renderGrid(); syncUrl(); };

  // ── URL ของหน้า = สิ่งที่เลือกไว้ (รีเฟรช / เซสชันหมดอายุ → กลับมาพร้อมข้อมูลเดิม) ──
  const pathNow = (productId = st.selected) => {
    const p = new URLSearchParams();
    const sel = productId ? cat().products.find((x) => x.id === productId) : null;
    if (sel) p.set('network', sel.network);
    else if (nc.code && nc.explicit) p.set('network', nc.code);
    else if (!nc.code && nc.retry) p.set('retry', nc.retry.network);
    if (st.phone) p.set('phone', st.phone);
    if (sel) p.set('product', String(sel.id));
    if (st.shop && shopTouched) p.set('shop', st.shop);
    const s = p.toString();
    return `/packages${s ? `?${s}` : ''}`;
  };
  const syncUrl = debounce(() => {
    if (!ctx.alive()) return;
    const want = `#${pathNow()}`;
    if (location.hash !== want) {
      try { history.replaceState(history.state, '', want); } catch { /* ignore */ }
    }
  }, 400);

  const phoneField = bindPhoneField(view, {
    onChange: (phone) => {
      if (phone === st.phone) return;
      st.phone = phone;
      nc.setPhone(phone); // → เลือกเครือข่ายที่เคยเติมสำเร็จให้ / ล้างที่ระบบเลือกไว้ของเบอร์เดิม
      syncUrl();
    },
    onPick: (entry) => nc.pick(entry),
  });

  on(tabsEl, 'click', '[data-net]', (e, el) => { nc.choose(el.dataset.net); });
  on(noticeEl, 'click', '[data-use-hist]', () => nc.useHistory());
  on(shopsEl, 'click', '[data-shop]', (e, el) => {
    const s = shopOf(el.dataset.shop);
    if (!s) return;
    if (!shopOpen(s)) shopNotice = `${s.name} ปิดชั่วคราว กรุณาเลือกร้านอื่น`;
    else if (!productsAt(s, nc.code).length) shopNotice = `${s.name} ยังไม่มีแพ็กเกจของเครือข่ายนี้ — กรุณาเลือกร้านอื่น`;
    else {
      st.shop = s.code;
      shopTouched = true;
      shopNotice = '';
    }
    renderAll();
  });
  on(catsEl, 'click', '[data-cat]', (e, el) => {
    st.category = el.dataset.cat;
    renderCats();
    renderGrid();
  });
  on(view, 'click', '[data-fill-phone]', (e, el) => phoneField.set(el.dataset.fillPhone));

  on(gridEl, 'click', '[data-buy]', async (e, el) => {
    const p = cat().products.find((x) => String(x.id) === el.dataset.buy);
    if (!p || quotingId) return;
    st.selected = p.id;
    gridEl.querySelectorAll('.pkg-card').forEach((card) => card.classList.toggle('selected', card.dataset.product === String(p.id)));
    const returnPath = pathNow(p.id);
    syncUrl();
    if (!state.user) {
      navigate(`/login?next=${encodeURIComponent(returnPath)}`);
      return;
    }
    if (!st.phone) {
      phoneField.error('กรอกเบอร์ที่จะสมัครแพ็กเกจก่อน');
      nudge(phoneCard);
      return;
    }
    const s = shopOf(st.shop);
    const block = orderBlockReason() || (s && !shopOpen(s) ? `${s.name} ปิดชั่วคราว — กรุณาเลือกร้านอื่น` : null)
      || (!networkOf(p.network)?.package.open ? `${networkOf(p.network)?.name || p.network} ปิดรับสมัครแพ็กเกจชั่วคราว` : null);
    if (block) {
      toast(block, 'warning', 5000);
      return;
    }
    quotingId = p.id;
    renderGrid();
    try {
      await confirmAndOrder(
        { type: 'package', network: p.network, phone: st.phone, productId: p.id, ...(st.shop ? { shop: st.shop } : {}) },
        {
          returnPath,
          onOpen: () => { quotingId = null; if (ctx.alive()) renderGrid(); },
          onFieldError: (err) => {
            if (err.details.field === 'phone') phoneField.error(err.message);
            else if (err.details.field === 'shop' || err.details.field === 'productId') { shopNotice = err.message; renderShops(); }
          },
        },
      );
    } finally {
      if (quotingId) { quotingId = null; if (ctx.alive()) renderGrid(); }
    }
  });

  // ข้อมูลร้าน/แพ็กเกจเปลี่ยน (โหลดใหม่) → วาดใหม่ คงสิ่งที่ลูกค้าเลือกไว้ถ้ายังใช้ได้
  const off = onChange((what) => {
    if (what !== 'catalog' || !ctx.alive() || !state.catalog) return;
    nc.catalogChanged();
    lastNet = nc.code;
    pickShop();
    renderAll();
  });
  ctx.onLeave(off);

  lastNet = nc.code;
  st.shop = autoShop();
  shopTouched = Boolean(q.shop) && st.shop === String(q.shop).toLowerCase(); // ร้านจากลิงก์ที่ยังใช้ได้ = ลูกค้าเลือกไว้
  st.phone = phoneField.value;
  nc.setPhone(st.phone);
  renderAll();
  if (preselect) {
    const card = gridEl.querySelector(`[data-product="${preselect.id}"]`);
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
