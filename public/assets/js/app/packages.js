// หน้าแพ็กเกจเน็ต: เบอร์ → เลือกเครือข่าย → เลือกร้าน → เลือกหมวด/แพ็กเกจ → ยืนยัน
import { html, raw, on, setHTML, bahtShort, navigate } from '../lib.js';
import { state, networkOf, orderBlockReason, safeColor, onChange, shopList, shopOf, shopOpen, lastShop } from './state.js';
import { icon } from './icons.js';
import { pageHead, netTag, mockTips, alertBox, emptyState } from './ui.js';
import { phoneFieldHtml, bindPhoneField } from './phonefield.js';
import { confirmAndOrder } from './confirm.js';

export default async function packagesPage(ctx) {
  const q = ctx.query;
  const cat = () => state.catalog;
  const nets = () => cat().networks;
  const shops = () => shopList();
  const preselect = q.product ? cat().products.find((p) => String(p.id) === String(q.product)) : null;
  const qNet = networkOf(preselect?.network || q.network);
  // ลิงก์ระบุเครือข่ายที่ไม่มีให้บริการแล้ว → ไม่สลับไปเครือข่ายอื่นเงียบๆ ให้ลูกค้าเลือกเอง
  let missingNet = !qNet && q.network ? String(q.network).slice(0, 20) : null;
  const st = {
    network: missingNet ? null : (qNet || nets().find((n) => n.package.open) || nets()[0])?.code,
    category: 'all',
    selected: preselect?.id || null,
    phone: null,
    shop: null,
  };
  let shopTouched = false;
  let shopNotice = '';

  setHTML(ctx.view, html`
    ${pageHead('แพ็กเกจเน็ต', 'สมัครแพ็กเกจเสริม เน็ต / โทร ใช้งานได้ทันที')}
    ${!cat().mode.live ? mockTips() : ''}
    <section class="card mb-2">
      <div class="step-title"><span class="step-no">1</span>เบอร์ที่จะสมัครแพ็กเกจ</div>
      ${phoneFieldHtml({ value: q.phone || '' })}
    </section>
    <section class="card">
      <div class="step-title"><span class="step-no">2</span>เลือกเครือข่าย ร้าน และแพ็กเกจ</div>
      <div class="segmented scroll net-tabs" data-tabs role="tablist"></div>
      <div data-notice></div>
      <div data-shops></div>
      <div data-shop-notice></div>
      <div class="chips mt-2" data-cats></div>
      <div class="pkg-grid mt-2" data-grid></div>
      <p class="xsmall muted mt-2 mb-0 row top" style="--gap:6px">${icon('info', 14)}<span>เบอร์ที่ย้ายค่าย ให้เลือกแพ็กเกจของเครือข่ายที่ใช้งานอยู่ปัจจุบัน · เงื่อนไขแพ็กเกจเป็นไปตามที่เครือข่ายกำหนด</span></p>
    </section>`);

  const view = ctx.view;
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
    const ok = list.filter((s) => shopOpen(s) && productsAt(s, st.network).length
      && (!preselect || preselect.network !== st.network || (s.product_ids || []).includes(preselect.id)));
    const pref = [q.shop ? String(q.shop).toLowerCase() : null, lastShop()].find((c) => c && ok.some((s) => s.code === c));
    return pref || ok[0]?.code || list.find(shopOpen)?.code || null;
  }
  function pickShop() {
    const s = shopOf(st.shop);
    if (shopTouched && s && shopOpen(s) && productsAt(s, st.network).length) return;
    if (shopTouched && s) shopNotice = `${s.name} ${!shopOpen(s) ? 'ปิดชั่วคราว' : 'ยังไม่มีแพ็กเกจของเครือข่ายนี้'} — เลือกร้านอื่นให้แล้ว`;
    shopTouched = false;
    st.shop = autoShop();
  }

  function renderTabs() {
    setHTML(tabsEl, nets().map((n) => html`<button type="button" role="tab" data-net="${n.code}" class="${n.code === st.network ? 'active' : ''}"
      aria-selected="${n.code === st.network ? 'true' : 'false'}"><span class="tab-dot" style="background:${raw(safeColor(n.color))}"></span>${n.name}
      <span class="tab-count">${cat().products.filter((p) => p.network === n.code).length}</span></button>`));
    const n = networkOf(st.network);
    let notice = '';
    if (!n && missingNet) notice = alertBox('warning', `เครือข่าย ${missingNet} ปิดให้บริการชั่วคราว — กรุณาเลือกเครือข่ายที่เบอร์นี้ใช้งานอยู่จริง`);
    else if (n && !n.package.open) notice = alertBox('warning', n.notice || `${n.name} ปิดรับสมัครแพ็กเกจชั่วคราว`);
    else if (n?.notice) notice = alertBox('info', n.notice);
    setHTML(noticeEl, notice ? html`<div class="mt-2">${notice}</div>` : '');
  }

  function renderShops() {
    const list = shops();
    if (list.length < 2) {
      // ร้านเดียว (เลือกให้แล้ว) หรือไม่มีข้อมูลร้าน → ไม่ต้องเลือก
      setHTML(shopsEl, list.length === 1 ? html`<div class="small muted mt-2">ร้าน: <b>${list[0].name}</b>${list[0].paused ? html` <span class="badge danger">ปิดชั่วคราว</span>` : ''}</div>` : '');
    } else {
      setHTML(shopsEl, html`<div class="label mt-2 mb-1">ร้าน</div><div class="chips">${list.map((s) => {
        const count = productsAt(s, st.network).length;
        return html`<button type="button" class="chip sm ${s.code === st.shop ? 'active' : ''}" data-shop="${s.code}" aria-pressed="${s.code === st.shop ? 'true' : 'false'}"
          ${!shopOpen(s) || !count ? raw('aria-disabled="true"') : ''}>${s.name} <span class="tab-count">${!shopOpen(s) ? 'ปิดชั่วคราว' : `${count} แพ็กเกจ`}</span></button>`;
      })}</div>`);
    }
    setHTML(shopNoticeEl, shopNotice ? html`<div class="mt-2">${alertBox('warning', shopNotice)}</div>` : '');
  }

  function renderCats() {
    const cats = [...new Set(productsOf(st.network).map((p) => p.category).filter(Boolean))];
    if (!cats.includes(st.category)) st.category = 'all';
    setHTML(catsEl, cats.length > 1
      ? [html`<button type="button" class="chip sm ${st.category === 'all' ? 'active' : ''}" data-cat="all">ทั้งหมด</button>`,
        ...cats.map((c) => html`<button type="button" class="chip sm ${st.category === c ? 'active' : ''}" data-cat="${c}">${c}</button>`)]
      : '');
  }

  function renderGrid() {
    const n = networkOf(st.network);
    const s = shopOf(st.shop);
    const list = productsOf(st.network).filter((p) => st.category === 'all' || p.category === st.category);
    if (!list.length) {
      const title = !n ? 'กรุณาเลือกเครือข่ายของเบอร์ที่จะสมัคร' : !n.package.open ? 'ปิดรับสมัครแพ็กเกจชั่วคราว'
        : s && shops().length > 1 ? `${s.name} ยังไม่มีแพ็กเกจของ ${n.name}` : 'ยังไม่มีแพ็กเกจในหมวดนี้';
      setHTML(gridEl, html`<div class="grid-span">${emptyState('wifi', title, shops().length > 1 ? 'ลองเลือกร้าน เครือข่าย หรือหมวดอื่น' : 'ลองเลือกเครือข่ายหรือหมวดอื่น')}</div>`);
      return;
    }
    const block = orderBlockReason() || (s && !shopOpen(s) ? `${s.name} ปิดชั่วคราว` : null);
    setHTML(gridEl, list.map((p) => html`<div class="pkg-card ${st.selected === p.id ? 'selected' : ''}" data-product="${p.id}" style="--net:${raw(safeColor(n?.color))}">
      <div class="pkg-top"><span class="pkg-cat">${p.category}</span>${netTag(p.network)}</div>
      <div class="pkg-data">${p.data_label || p.name}</div>
      <div class="pkg-name">${p.name}</div>
      ${p.validity_days ? html`<div class="pkg-days">${icon('calendar', 14)} ใช้ได้ ${p.validity_days} วัน</div>` : ''}
      ${p.description ? html`<div class="pkg-desc">${p.description}</div>` : ''}
      <div class="pkg-foot">
        <span class="pkg-price num">฿${bahtShort(p.price)}</span>
        <button type="button" class="btn primary sm" data-buy="${p.id}" ${block ? raw('disabled') : ''}>สมัคร</button>
      </div>
    </div>`));
  }

  const renderAll = () => { renderTabs(); renderShops(); renderCats(); renderGrid(); };

  const phoneField = bindPhoneField(view, {
    onChange: (phone) => { st.phone = phone; },
    onPick: (entry) => {
      // เบอร์ในสมุดระบุเครือข่ายไว้ → ใช้เครือข่ายนั้นเสมอ (ถ้าไม่มีให้บริการ ให้เลือกเอง) ไม่คงเครือข่ายเดิมที่อาจผิด
      const n = networkOf(entry.network);
      if (entry.network && (n?.code || null) !== st.network) {
        st.network = n?.code || null;
        missingNet = n ? null : String(entry.network).slice(0, 20);
        pickShop();
        renderAll();
      }
    },
  });

  on(tabsEl, 'click', '[data-net]', (e, el) => {
    st.network = el.dataset.net;
    missingNet = null;
    st.category = 'all';
    pickShop();
    renderAll();
  });
  on(shopsEl, 'click', '[data-shop]', (e, el) => {
    const s = shopOf(el.dataset.shop);
    if (!s) return;
    if (!shopOpen(s)) shopNotice = `${s.name} ปิดชั่วคราว กรุณาเลือกร้านอื่น`;
    else if (!productsAt(s, st.network).length) shopNotice = `${s.name} ยังไม่มีแพ็กเกจของเครือข่ายนี้ — กรุณาเลือกร้านอื่น`;
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
    if (!p) return;
    st.selected = p.id;
    gridEl.querySelectorAll('.pkg-card').forEach((card) => card.classList.toggle('selected', card.dataset.product === String(p.id)));
    const returnPath = `/packages?network=${p.network}&product=${p.id}${st.phone ? `&phone=${st.phone}` : ''}${st.shop ? `&shop=${encodeURIComponent(st.shop)}` : ''}`;
    if (!state.user) {
      navigate(`/login?next=${encodeURIComponent(returnPath)}`);
      return;
    }
    if (!st.phone) {
      phoneField.error('กรอกเบอร์ที่จะสมัครแพ็กเกจก่อน');
      return;
    }
    await confirmAndOrder(
      { type: 'package', network: p.network, phone: st.phone, productId: p.id, ...(st.shop ? { shop: st.shop } : {}) },
      {
        returnPath,
        onFieldError: (err) => {
          if (err.details.field === 'phone') phoneField.error(err.message);
          else if (err.details.field === 'shop' || err.details.field === 'productId') { shopNotice = err.message; renderShops(); }
        },
      },
    );
  });

  // ข้อมูลร้าน/แพ็กเกจเปลี่ยน (โหลดใหม่) → วาดใหม่ คงสิ่งที่ลูกค้าเลือกไว้ถ้ายังใช้ได้
  const off = onChange((what) => {
    if (what !== 'catalog' || !ctx.alive() || !state.catalog) return;
    pickShop();
    renderAll();
  });
  ctx.onLeave(off);

  st.shop = autoShop();
  st.phone = phoneField.value;
  renderAll();
  if (preselect) {
    const card = gridEl.querySelector(`[data-product="${preselect.id}"]`);
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
