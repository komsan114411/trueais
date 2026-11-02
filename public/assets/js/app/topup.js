// หน้าเติมเงินมือถือ: (1) กรอกเบอร์ + เครือข่าย → (2) เลือกร้าน → (3) เลือกจำนวน → สรุป → ยืนยัน
import { html, raw, on, setHTML, baht, bahtShort, percent, phoneFmt, navigate, debounce, toast } from '../lib.js';
import {
  state, networkOf, orderBlockReason, netVars, onChange, shopList, shopOf, shopNet, shopServes, shopOpen, lastShop, saveDraft, refreshUser,
} from './state.js';
import { icon } from './icons.js';
import { pageHead, netTag, mockTips, alertBox, priceAfter, initial, nudge } from './ui.js';
import { phoneFieldHtml, bindPhoneField } from './phonefield.js';
import { confirmAndOrder, depositSuggestion } from './confirm.js';
import { netChoice } from './netchoice.js';

export default async function topupPage(ctx) {
  const q = ctx.query;
  const shops = () => shopList();
  const st = {
    amount: /^\d{1,6}$/.test(q.amount || '') ? Number(q.amount) : null,
    phone: null,
    shop: null,
  };
  let shopTouched = false;
  let shopNotice = '';
  let quoting = false; // กำลังขอราคา (ก่อนหน้าต่างยืนยันเปิด) → แสดงสถานะบนปุ่ม แทนการกดแล้วเงียบ
  let lastNet = null;
  const qShop = q.shop ? shopOf(String(q.shop).toLowerCase()) : null;
  if (qShop) { st.shop = qShop.code; shopTouched = true; }
  if (state.user) refreshUser(); // ยอดเงินล่าสุด (อาจเพิ่งเติมเงินเข้ากระเป๋าจากแท็บ/อุปกรณ์อื่น)

  // เครือข่าย: ลิงก์ระบุมา (เช่น "เติมอีกครั้ง") = ใช้ตามนั้น · เบอร์ที่เคยเติมสำเร็จ = เลือกให้ · เบอร์ใหม่ = ให้ลูกค้าเลือกเอง
  const nc = netChoice({ ctx, kind: 'topup', network: q.network, phone: q.phone, retry: q.retry, onUpdate: () => onNetUpdate() });

  setHTML(ctx.view, html`
    ${pageHead('เติมเงินมือถือ', 'กรอกเบอร์ · เลือกเครือข่าย · เลือกจำนวน — เติมได้ทันทีตลอด 24 ชั่วโมง')}
    ${!state.catalog.mode.live ? mockTips() : ''}
    <div class="topup-layout">
      <div class="stack" style="--gap:14px">
        <section class="card" data-phone-card>
          <div class="step-title"><span class="step-no">1</span>เบอร์โทรศัพท์ที่จะเติม</div>
          ${phoneFieldHtml({ value: q.phone || '', recent: true })}
          <div class="net-step mt-1" data-nets></div>
          <div data-net-notice></div>
          <p class="xsmall muted mt-2 mb-0 row top" style="--gap:6px">${icon('info', 14)}<span>เบอร์ที่ย้ายค่าย (ใช้เบอร์เดิม) ให้เลือกเครือข่ายที่ใช้งานอยู่ปัจจุบัน ไม่ใช่เครือข่ายเดิม</span></p>
        </section>
        <section class="card" data-shop-card>
          <div class="step-title"><span class="step-no">2</span>เลือกร้าน</div>
          <div data-shops></div>
          <div data-shop-notice></div>
        </section>
        <section class="card" data-amount-card>
          <div class="step-title"><span class="step-no" data-amount-step>3</span>เลือกจำนวน</div>
          <div class="amount-grid" data-presets></div>
          <div class="small text-danger mt-1" data-amount-msg role="alert"></div>
          <div class="field mt-2" data-custom-wrap>
            <label for="amount">หรือระบุจำนวนเงินเอง (บาท)</label>
            <div class="input-affix"><span>฿</span><input class="input lg" id="amount" name="amount" inputmode="numeric" autocomplete="off" placeholder="0" maxlength="6"></div>
            <div class="help" data-amount-help></div>
            <div class="error-text" data-amount-error></div>
          </div>
        </section>
      </div>
      <aside class="summary card" data-summary aria-label="สรุปรายการ"></aside>
    </div>
    <div class="paybar" data-paybar></div>
    <div class="paybar-space" aria-hidden="true"></div>`);

  const view = ctx.view;
  const phoneCard = view.querySelector('[data-phone-card]');
  const netsEl = view.querySelector('[data-nets]');
  const noticeEl = view.querySelector('[data-net-notice]');
  const shopCard = view.querySelector('[data-shop-card]');
  const shopsEl = view.querySelector('[data-shops]');
  const shopNoticeEl = view.querySelector('[data-shop-notice]');
  const amountCard = view.querySelector('[data-amount-card]');
  const amountStepEl = view.querySelector('[data-amount-step]');
  const presetsEl = view.querySelector('[data-presets]');
  const amountMsg = view.querySelector('[data-amount-msg]');
  const customWrap = view.querySelector('[data-custom-wrap]');
  const amountInput = view.querySelector('#amount');
  const amountHelp = view.querySelector('[data-amount-help]');
  const amountErr = view.querySelector('[data-amount-error]');
  const summaryEl = view.querySelector('[data-summary]');
  const paybarEl = view.querySelector('[data-paybar]');

  const currentNet = () => networkOf(nc.code);
  const currentShop = () => shopOf(st.shop);
  const sNet = () => shopNet(currentShop(), nc.code); // null = ไม่มีร้านให้เลือก (ระบบเลือกให้)
  const fixedAmounts = () => (Array.isArray(sNet()?.amounts) ? sNet().amounts : null);
  const customOk = () => (sNet() ? Boolean(sNet().custom) : Boolean(currentNet()?.topup.allow_custom));
  const discountBp = () => (sNet() ? sNet().discount_bp || 0 : currentNet()?.topup.discount_bp || 0);
  /** ช่วงยอดของร้านที่เลือก (บาท) — ร้านบางร้านรับยอดแคบกว่าเครือข่าย เช่น wePAY dtac ไม่เกิน 800 */
  const shopRange = () => (sNet() && (sNet().min != null || sNet().max != null) ? { min: sNet().min ?? 0, max: sNet().max ?? Infinity } : null);
  const inShopRange = (a) => { const r = shopRange(); return !r || (a >= r.min && a <= r.max); };
  const amountChoices = () => fixedAmounts() || (currentNet()?.topup.presets || []).filter(inShopRange);
  /** ราคาที่จ่ายจริงที่ร้านนี้ (สตางค์) — สูตรเดียวกับเซิร์ฟเวอร์ */
  const payFor = (bahtAmount) => priceAfter(bahtAmount * 100, discountBp());

  /** เลือกร้านให้อัตโนมัติ: ร้านที่ใช้ล่าสุด (ถ้าเปิดและมีค่ายนี้) → ไม่งั้นร้านที่ส่วนลดค่ายนี้มากที่สุด */
  function autoShop() {
    const list = shops();
    if (!list.length) return null;
    if (list.length === 1) return list[0].code;
    const ok = list.filter((s) => shopOpen(s) && shopServes(s, nc.code));
    if (!ok.length) return null;
    const last = ok.find((s) => s.code === lastShop());
    if (last) return last.code;
    const bp = (s) => shopNet(s, nc.code)?.discount_bp || 0;
    return ok.reduce((best, s) => (bp(s) > bp(best) ? s : best), ok[0]).code;
  }
  /** หลังเปลี่ยนเครือข่าย / ข้อมูลร้านเปลี่ยน: ร้านที่ลูกค้าเลือกเองยังใช้ได้ → คงไว้ · ไม่ได้ → เลือกใหม่ + แจ้ง */
  function pickShop() {
    const s = currentShop();
    if (shopTouched && s && shopOpen(s) && shopServes(s, nc.code)) return;
    if (shopTouched && s && nc.code) {
      shopNotice = `${s.name} ${!shopOpen(s) ? 'ปิดชั่วคราว' : `ไม่มีบริการเติมเงิน ${currentNet()?.name || 'ค่ายนี้'}`} — เลือกร้านอื่นให้แล้ว กรุณาตรวจสอบ`;
    }
    if (shopTouched && !nc.code) return; // ยังไม่ได้เลือกเครือข่าย → คงร้านที่ลูกค้าเลือกไว้
    shopTouched = false;
    st.shop = autoShop();
  }

  /** เครือข่ายเปลี่ยน (เลือกเอง / ระบบเลือกตามประวัติ / เปลี่ยนเบอร์) → เลือกร้านใหม่ถ้าจำเป็น แล้ววาดใหม่ */
  function onNetUpdate() {
    if (nc.code !== lastNet) {
      lastNet = nc.code;
      // ระบบเลือกเครือข่ายตามประวัติ → ใช้ร้านเดิมของเบอร์นี้ด้วย (ถ้ายังเปิดและมีค่ายนี้ และลูกค้ายังไม่ได้เลือกร้านเอง)
      const prefer = nc.source === 'auto' && !shopTouched ? shopOf(nc.hist?.last?.shop) : null;
      if (prefer && shopOpen(prefer) && shopServes(prefer, nc.code)) st.shop = prefer.code;
      else pickShop();
    }
    renderAll();
  }

  function amountError() {
    const n = currentNet();
    if (!n || st.amount === null) return null;
    if (!Number.isInteger(st.amount) || st.amount <= 0) return 'ระบุเป็นจำนวนเต็มบาท';
    const fixed = fixedAmounts();
    if (fixed) {
      const name = currentShop()?.name || 'ร้านนี้';
      if (!fixed.length) return `${name} ไม่มีบริการเติมเงิน ${n.name}`;
      if (!fixed.includes(st.amount)) return `${name} มีเฉพาะยอด ${fixed.join(', ')} บาท สำหรับ ${n.name}`;
      return null;
    }
    if (st.amount * 100 < n.topup.min || st.amount * 100 > n.topup.max) return `เติม ${n.name} ได้ตั้งแต่ ${bahtShort(n.topup.min)} ถึง ${bahtShort(n.topup.max)} บาท`;
    if (!inShopRange(st.amount)) return `${currentShop()?.name || 'ร้านนี้'} รับยอดเติม ${n.name} ตั้งแต่ ${shopRange().min} ถึง ${shopRange().max} บาท`;
    if (!customOk() && !n.topup.presets.includes(st.amount)) return `${n.name} เติมได้เฉพาะ ${n.topup.presets.join(', ')} บาท`;
    return null;
  }
  function showAmountError(msg) {
    if (customOk() && currentNet()) {
      customWrap.classList.add('has-error');
      amountErr.textContent = msg;
    } else amountMsg.textContent = msg;
  }

  function renderNets() {
    setHTML(netsEl, html`${nc.label()}${nc.buttons()}`);
    const notes = nc.notices();
    setHTML(noticeEl, notes.length ? html`<div class="stack mt-2" style="--gap:8px">${notes}</div>` : '');
  }

  function shopCardHtml(s, n) {
    const sn = shopNet(s, nc.code);
    const closed = !shopOpen(s) || (n && !shopServes(s, nc.code));
    const on_ = s.code === st.shop;
    const sub = !shopOpen(s) ? 'ปิดชั่วคราว'
      : !n ? 'เลือกเครือข่ายก่อน'
        : !shopServes(s, nc.code) ? 'ไม่มีบริการค่ายนี้'
          : `${sn.discount_bp > 0 ? `ส่วนลด ${percent(sn.discount_bp)}` : 'ราคาปกติ'}${Array.isArray(sn.amounts) ? ' · เฉพาะบางยอด' : ''}`;
    return html`<button type="button" class="net-card ${on_ ? 'active' : ''} ${closed ? 'closed' : ''}" data-shop="${s.code}"
        style="${netVars(n?.color || '#4f46e5')}" aria-pressed="${on_ ? 'true' : 'false'}" ${closed ? raw('aria-disabled="true"') : ''}>
      <span class="net-check">${icon('check', 14)}</span>
      <span class="net-logo">${initial(s.name)}</span>
      <span class="net-name">${s.name}</span>
      <span class="net-sub">${sub}</span>
    </button>`;
  }

  function renderShops() {
    const list = shops();
    // ไม่มีข้อมูลร้าน → ระบบเลือกร้านให้เอง (ขั้นตอนนี้ไม่แสดง)
    shopCard.classList.toggle('hidden', !list.length);
    amountStepEl.textContent = list.length ? '3' : '2';
    if (!list.length) return;
    const n = currentNet();
    if (list.length === 1) {
      // มีร้านเดียว → เลือกให้เลย แสดงสั้นๆ
      const s = list[0];
      const sn = shopNet(s, nc.code);
      setHTML(shopsEl, html`<div class="row wrap" style="--gap:8px"><span class="bold">${s.name}</span>
        ${!shopOpen(s) ? html`<span class="badge danger">ปิดชั่วคราว</span>`
          : n && !shopServes(s, nc.code) ? html`<span class="badge danger">ไม่มีบริการค่ายนี้</span>`
            : sn?.discount_bp > 0 ? html`<span class="badge success plain">ส่วนลด ${percent(sn.discount_bp)}</span>` : ''}</div>`);
    } else {
      // 2 ร้าน = 2 คอลัมน์เต็มแถว (ชื่อร้านไม่ถูกบีบจนขึ้นบรรทัดใหม่บนจอเล็ก) / 3 ร้านขึ้นไป = 3 คอลัมน์
      setHTML(shopsEl, html`<div class="net-grid shop-grid" style="--cols:${Math.min(list.length, 3)}">${list.map((s) => shopCardHtml(s, n))}</div>`);
    }
    setHTML(shopNoticeEl, shopNotice ? html`<div class="mt-2">${alertBox('warning', shopNotice)}</div>` : '');
  }

  function renderPresets() {
    const n = currentNet();
    const s = currentShop();
    // มีร้านให้เลือกแต่ยังไม่ได้เลือก (เช่น ไม่มีร้านไหนให้บริการค่ายนี้) → ไม่แสดงยอด/ราคา ที่ยังไม่รู้ว่าร้านไหนขาย
    const needShop = shops().length > 0 && !s;
    const choices = n && !needShop ? amountChoices() : [];
    const empty = !n ? 'เลือกเครือข่ายก่อน แล้วจึงเลือกจำนวน'
      : needShop ? (shops().some((x) => shopOpen(x) && shopServes(x, nc.code)) ? 'เลือกร้านก่อน' : `ยังไม่มีร้านที่ให้บริการเติมเงิน ${n.name} ในขณะนี้`)
        : s ? `${s.name} ยังไม่มียอดให้เลือกสำหรับ ${n.name} — ลองเลือกร้านอื่น` : 'ยังไม่มียอดให้เลือก';
    setHTML(presetsEl, choices.length
      ? choices.map((v) => html`<button type="button" class="amount-btn ${st.amount === v ? 'active' : ''}" data-amount="${v}" aria-pressed="${st.amount === v ? 'true' : 'false'}">
          <span class="num">${v.toLocaleString('th-TH')}</span><small>จ่าย ฿${bahtShort(payFor(v))}</small></button>`)
      : html`<div class="small muted" style="grid-column:1/-1">${empty}</div>`);
    const custom = Boolean(n) && !needShop && customOk();
    customWrap.classList.toggle('hidden', !custom);
    let help = '';
    if (custom) { // custom = เลือกเครือข่ายแล้ว (n มีค่า) — ยังไม่เลือกเครือข่ายห้ามอ่าน n.topup
      const r = shopRange();
      const lo = r ? Math.max(r.min * 100, n.topup.min) : n.topup.min;
      const hi = r ? Math.min(r.max * 100, n.topup.max) : n.topup.max;
      help = `เติมได้ ${bahtShort(lo)} - ${bahtShort(hi)} บาท (จำนวนเต็ม)${r ? ` ที่ ${currentShop()?.name || 'ร้านนี้'}` : ''}`;
    }
    amountHelp.textContent = help;
    if (document.activeElement !== amountInput && !Number.isNaN(st.amount)) amountInput.value = st.amount ? String(st.amount) : '';
    const err = amountError();
    customWrap.classList.toggle('has-error', Boolean(err) && custom);
    amountErr.textContent = custom ? err || '' : '';
    amountMsg.textContent = custom ? '' : err || '';
  }

  /** เหตุที่ระบบ/เครือข่าย/ร้าน ยังรับรายการไม่ได้ (null = รับได้) */
  function blockReason() {
    const n = currentNet();
    const s = currentShop();
    return orderBlockReason()
      || (n && !n.topup.open ? n.notice || `${n.name} ปิดให้บริการเติมเงินชั่วคราว` : null)
      || (s && !shopOpen(s) ? `${s.name} ปิดชั่วคราว` : null);
  }

  /** ขั้นตอนแรกที่ยังไม่ครบ (ตามลำดับบนหน้า) → { short, go() } — go = เลื่อนไปที่ขั้นตอนนั้น + ไฮไลต์ + บอกว่าขาดอะไร */
  function missingStep() {
    const n = currentNet();
    if (!st.phone) {
      return { short: 'กรอกเบอร์มือถือ 10 หลัก', go: () => { phoneField.error('กรุณากรอกเบอร์มือถือให้ถูกต้อง 10 หลัก'); nudge(phoneCard); } };
    }
    if (!n) return { short: 'เลือกเครือข่ายของเบอร์นี้', go: () => { nc.ask(); nudge(netsEl); } };
    if (!n.topup.open) return { short: `${n.name} ปิดชั่วคราว — เลือกเครือข่ายอื่น`, go: () => nudge(netsEl) };
    const s = currentShop();
    if (shops().length && !s) {
      return { short: 'เลือกร้าน', go: () => { if (!shopNotice) shopNotice = 'กรุณาเลือกร้าน'; renderShops(); nudge(shopCard); } };
    }
    if (s && (!shopOpen(s) || !shopServes(s, nc.code))) {
      return { short: `${s.name} ใช้ไม่ได้ — เลือกร้านอื่น`, go: () => { renderShops(); nudge(shopCard); } };
    }
    if (!st.amount || amountError()) {
      const msg = amountError() || 'กรุณาเลือกจำนวนเงิน';
      return { short: amountError() ? 'ตรวจจำนวนเงิน' : 'เลือกจำนวนเงิน', go: () => { showAmountError(msg); nudge(amountCard); } };
    }
    return null;
  }

  function confirmButton(cls) {
    const u = state.user;
    return html`<button type="button" class="btn primary ${cls} ${quoting ? 'is-loading' : ''}" data-confirm ${quoting ? raw('aria-busy="true"') : ''}>
      ${quoting ? html`<span class="spinner"></span>กำลังตรวจสอบราคา...`
        : u ? html`${icon('shield', 20)} ตรวจสอบและยืนยัน` : html`${icon('lock', 20)} เข้าสู่ระบบเพื่อเติมเงิน`}
    </button>`;
  }

  function renderSummary() {
    const n = currentNet();
    const s = currentShop();
    const u = state.user;
    const aErr = amountError();
    const face = st.amount && !aErr ? st.amount * 100 : 0;
    const price = face && n ? priceAfter(face, discountBp()) : 0;
    const discount = face - price;
    const after = u ? u.balance - price : null;
    const needShop = shops().length > 0;
    const block = blockReason();
    const miss = missingStep();
    const short = Boolean(u && face && after < 0);
    setHTML(summaryEl, html`
      <h3 class="mb-2">สรุปรายการ</h3>
      <div class="sum-lines">
        <div class="sum-line"><span class="muted">เบอร์</span><span class="num bold">${st.phone ? phoneFmt(st.phone) : '-'}</span></div>
        <div class="sum-line"><span class="muted">เครือข่าย</span><span>${n ? netTag(n.code) : html`<span class="text-warning small">ยังไม่ได้เลือก</span>`}</span></div>
        ${needShop ? html`<div class="sum-line"><span class="muted">ร้าน</span><span class="bold">${s?.name || '-'}</span></div>` : ''}
        <div class="sum-line"><span class="muted">ยอดเติม</span><span class="num">${face ? `฿${baht(face)}` : '-'}</span></div>
        ${discount > 0 ? html`<div class="sum-line text-success"><span>ส่วนลด</span><span class="num">-฿${baht(discount)}</span></div>` : ''}
        <div class="sum-line total"><span>ชำระจริง</span><span class="num">฿${baht(price)}</span></div>
        ${u ? html`<div class="sum-line small"><span class="muted">ยอดในกระเป๋าหลังเติม</span>
          <span class="num ${after < 0 ? 'text-danger bold' : ''}">${after < 0 ? 'ไม่พอ' : `฿${baht(after)}`}</span></div>` : ''}
      </div>
      ${short ? html`<div class="mt-2" data-short>${alertBox('danger', html`ยอดเงินไม่พอ ขาดอีก ฿${baht(-after)}
        <div class="mt-1"><a class="btn sm primary" href="#/wallet?amount=${depositSuggestion(-after)}" data-save-draft>${icon('plus', 16)} เติมเงินเข้ากระเป๋า</a></div>
        <div class="xsmall muted mt-1">ระบบจำรายการนี้ไว้ให้ — เติมเงินเสร็จแล้วกด "ทำรายการต่อ" ได้เลย ไม่ต้องกรอกใหม่</div>`)}</div>` : ''}
      ${block ? html`<div class="mt-2">${alertBox('warning', block)}</div>` : ''}
      ${u && miss && !block ? html`<p class="small text-warning mt-2 mb-0 row" style="--gap:6px">${icon('info', 14)} ยังขาด: ${miss.short}</p>` : ''}
      ${confirmButton('lg block mt-2')}
      ${u ? html`<p class="xsmall muted center mt-1 mb-0">ระบบจะให้ตรวจสอบเบอร์อีกครั้งก่อนตัดเงิน</p>` : ''}`);

    // แถบชำระเงินด้านล่าง (มือถือ) — กดได้เสมอ: ขั้นตอนไหนยังไม่ครบ จะพาไปที่ขั้นตอนนั้น
    const ready = !miss && !block;
    setHTML(paybarEl, html`<div class="container paybar-inner">
      <div class="paybar-info">
        <span class="paybar-total num">฿${baht(price)}</span>
        <span class="paybar-sub ${ready && !short ? '' : 'text-warning'}">${!u ? 'เข้าสู่ระบบก่อนเติมเงิน'
          : block || (miss ? `ยังขาด: ${miss.short}` : short ? `ยอดเงินไม่พอ ขาด ฿${baht(-after)}` : html`<span class="num">${phoneFmt(st.phone)}</span> · ${n.name}`)}</span>
      </div>
      ${confirmButton('paybar-btn')}
    </div>`);
    syncUrl();
  }

  const renderAll = () => { renderNets(); renderShops(); renderPresets(); renderSummary(); };

  // ── URL ของหน้า = สิ่งที่เลือกไว้ (รีเฟรช / เซสชันหมดอายุแล้วเข้าสู่ระบบใหม่ → กลับมาพร้อมข้อมูลเดิม) ──
  const pathNow = () => {
    const p = new URLSearchParams();
    if (nc.code && nc.explicit) p.set('network', nc.code); // ที่ระบบเดาให้ไม่ใส่ (เปิดใหม่จะดูประวัติให้อีกครั้ง)
    else if (!nc.code && nc.retry) p.set('retry', nc.retry.network);
    if (st.phone) p.set('phone', st.phone);
    if (st.amount) p.set('amount', String(st.amount));
    if (st.shop && shopTouched) p.set('shop', st.shop);
    const s = p.toString();
    return `/topup${s ? `?${s}` : ''}`;
  };
  const syncUrl = debounce(() => {
    if (!ctx.alive()) return;
    const want = `#${pathNow()}`;
    if (location.hash !== want) {
      try { history.replaceState(history.state, '', want); } catch { /* เบราว์เซอร์จำกัดจำนวนครั้ง → ข้าม */ }
    }
  }, 400);

  const phoneField = bindPhoneField(view, {
    onChange: (phone) => {
      if (phone === st.phone) return;
      st.phone = phone;
      nc.setPhone(phone); // → onNetUpdate → วาดใหม่
    },
    onPick: (entry) => {
      // เบอร์ล่าสุด/สมุดโทรศัพท์: เครือข่ายที่เคยเติมสำเร็จ (หรือที่บันทึกไว้) — ยังไม่เคยสำเร็จ = ให้ลูกค้าเลือกเอง
      nc.pick(entry);
      // ร้านที่ใช้กับเบอร์นี้ครั้งก่อน (ถ้ายังเปิดและมีค่ายนี้)
      const s = entry.shop ? shopOf(entry.shop) : null;
      if (s && nc.code && shopOpen(s) && shopServes(s, nc.code) && !shopTouched && st.shop !== s.code) {
        st.shop = s.code;
        renderAll();
      }
    },
  });

  on(netsEl, 'click', '[data-net]', (e, el) => { nc.choose(el.dataset.net); });
  on(noticeEl, 'click', '[data-use-hist]', () => nc.useHistory());

  on(shopsEl, 'click', '[data-shop]', (e, el) => {
    const s = shopOf(el.dataset.shop);
    if (!s) return;
    if (!shopOpen(s)) shopNotice = `${s.name} ปิดชั่วคราว กรุณาเลือกร้านอื่น`;
    else if (!currentNet()) { shopNotice = 'กรุณาเลือกเครือข่ายก่อน'; nc.ask(); nudge(netsEl); }
    else if (!shopServes(s, nc.code)) shopNotice = `${s.name} ไม่มีบริการเติมเงิน ${currentNet().name} — กรุณาเลือกร้านอื่น`;
    else {
      st.shop = s.code;
      shopTouched = true;
      shopNotice = '';
    }
    renderShops();
    renderPresets();
    renderSummary();
  });

  on(presetsEl, 'click', '[data-amount]', (e, el) => {
    st.amount = Number(el.dataset.amount);
    amountInput.value = String(st.amount);
    renderPresets();
    renderSummary();
  });

  amountInput.addEventListener('input', () => {
    if (amountInput.value.includes('.')) {
      // มีทศนิยม → ไม่ตัดจุดทิ้งเอง (กัน "10.5" กลายเป็น 105 บาท) ให้ขึ้นข้อความ "ระบุเป็นจำนวนเต็มบาท"
      st.amount = NaN;
    } else {
      const digits = amountInput.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 6);
      if (digits !== amountInput.value) amountInput.value = digits;
      st.amount = digits ? Number(digits) : null;
    }
    renderPresets();
    renderSummary();
  });

  on(view, 'click', '[data-fill-phone]', (e, el) => {
    phoneField.set(el.dataset.fillPhone);
    view.querySelector('[data-phone-field]').scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  on(summaryEl, 'click', '[data-save-draft]', () => {
    const n = currentNet();
    if (st.phone && n && st.amount) saveDraft(pathNow(), `เติมเงิน ${n.name} ${st.amount.toLocaleString('th-TH')} บาท → ${phoneFmt(st.phone)}`);
  });

  const setQuoting = (v) => {
    if (quoting === v) return;
    quoting = v;
    if (ctx.alive()) renderSummary();
  };

  async function attemptConfirm() {
    if (quoting) return;
    const returnPath = pathNow();
    if (!state.user) {
      navigate(`/login?next=${encodeURIComponent(returnPath)}`);
      return;
    }
    const miss = missingStep();
    if (miss) { miss.go(); return; }
    const block = blockReason();
    if (block) {
      toast(block, 'warning', 5000);
      nudge(summaryEl);
      return;
    }
    if (state.user.balance < payFor(st.amount)) {
      // เงินไม่พอ → ชี้ไปที่ปุ่มเติมเงินเข้ากระเป๋า (และโหลดยอดล่าสุด เผื่อเพิ่งเติมจากที่อื่น)
      refreshUser();
      nudge(summaryEl.querySelector('[data-short]') || summaryEl);
      return;
    }
    setQuoting(true);
    try {
      await confirmAndOrder(
        { type: 'topup', network: nc.code, phone: st.phone, amount: st.amount, ...(st.shop ? { shop: st.shop } : {}) },
        {
          returnPath,
          onOpen: () => setQuoting(false),
          onFieldError: (err) => {
            if (err.details.field === 'phone') phoneField.error(err.message);
            else if (err.details.field === 'shop') { shopNotice = err.message; renderShops(); nudge(shopCard); }
            else if (err.details.field === 'amount') { showAmountError(err.message); nudge(amountCard); }
          },
        },
      );
    } finally {
      setQuoting(false);
    }
  }
  on(view, 'click', '[data-confirm]', () => { attemptConfirm(); });

  // ข้อมูลร้าน/ราคาเปลี่ยน (โหลดใหม่ เช่น หลังร้านปิดชั่วคราว หรือกลับมาที่แท็บนี้) → วาดใหม่ตามข้อมูลล่าสุด คงสิ่งที่ลูกค้าเลือกไว้
  // ยอดเงินเปลี่ยน → สรุปรายการใหม่ (ยอดหลังเติม / เงินไม่พอ)
  const off = onChange((what) => {
    if (!ctx.alive() || !state.catalog) return;
    if (what === 'catalog') {
      nc.catalogChanged();
      lastNet = nc.code;
      pickShop();
      renderAll();
    } else if (what === 'user') renderSummary();
  });
  ctx.onLeave(off);

  // แถบชำระเงินด้านล่างซ่อนเมื่อเห็นการ์ดสรุปอยู่แล้ว (ไม่ให้มีปุ่มยืนยันซ้ำสองที่)
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([entry]) => paybarEl.classList.toggle('is-off', entry.isIntersecting), { threshold: 0.25 });
    io.observe(summaryEl);
    ctx.onLeave(() => io.disconnect());
  }

  lastNet = nc.code;
  if (!st.shop || !shopTouched) st.shop = autoShop();
  else pickShop();
  st.phone = phoneField.value;
  nc.setPhone(st.phone);
  renderAll();
}
