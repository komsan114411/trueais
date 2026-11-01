// หน้าเติมเงินมือถือ: (1) กรอกเบอร์ + เครือข่าย → (2) เลือกร้าน → (3) เลือกจำนวน → สรุป → ยืนยัน
import { html, raw, api, on, setHTML, baht, bahtShort, percent, phoneFmt, navigate, qs } from '../lib.js';
import {
  state, networkOf, orderBlockReason, safeColor, onChange, shopList, shopOf, shopNet, shopServes, shopOpen, lastShop,
} from './state.js';
import { icon } from './icons.js';
import { pageHead, netTag, mockTips, alertBox, priceAfter, initial } from './ui.js';
import { phoneFieldHtml, bindPhoneField } from './phonefield.js';
import { confirmAndOrder, depositSuggestion } from './confirm.js';

export default async function topupPage(ctx) {
  const q = ctx.query;
  const nets = () => state.catalog.networks;
  const shops = () => shopList();
  const qNet = networkOf(q.network);
  // ลิงก์ระบุเครือข่ายมา (เช่น "เติมอีกครั้ง" / สมุดโทรศัพท์) → ห้ามสลับไปเครือข่ายอื่นเงียบๆ แม้เครือข่ายนั้นปิดอยู่
  // (เบอร์เป็นของเครือข่ายเดิม เติมผิดเครือข่ายอาจเสียเงิน) — ถ้าไม่พบเครือข่าย ให้ลูกค้าเลือกเอง
  const st = {
    network: q.network ? qNet?.code || null : (nets().find((n) => n.topup.open) || nets()[0])?.code,
    amount: /^\d{1,6}$/.test(q.amount || '') ? Number(q.amount) : null,
    phone: null,
    shop: null,
  };
  let missingNet = q.network && !qNet ? String(q.network).slice(0, 20) : null;
  let netTouched = Boolean(q.network); // ลูกค้าเลือก/ระบุเครือข่ายเองแล้ว → ระบบไม่เปลี่ยนให้
  let netHint = '';
  let shopTouched = false;
  let shopNotice = '';
  const qShop = q.shop ? shopOf(String(q.shop).toLowerCase()) : null;
  if (qShop) { st.shop = qShop.code; shopTouched = true; }

  setHTML(ctx.view, html`
    ${pageHead('เติมเงินมือถือ', 'กรอกเบอร์ · เลือกร้าน · เลือกจำนวน — เติมได้ทันทีตลอด 24 ชั่วโมง')}
    ${!state.catalog.mode.live ? mockTips() : ''}
    <div class="topup-layout">
      <div class="stack" style="--gap:14px">
        <section class="card">
          <div class="step-title"><span class="step-no">1</span>เบอร์โทรศัพท์ที่จะเติม</div>
          ${phoneFieldHtml({ value: q.phone || '' })}
          <div class="label mt-1 mb-1">เครือข่ายของเบอร์นี้</div>
          <div class="segmented scroll net-tabs" data-nets role="tablist" aria-label="เครือข่าย"></div>
          <div data-net-notice></div>
          <p class="xsmall muted mt-2 mb-0 row top" style="--gap:6px">${icon('info', 14)}<span>เบอร์ที่ย้ายค่าย (ใช้เบอร์เดิม) ให้เลือกเครือข่ายที่ใช้งานอยู่ปัจจุบัน ไม่ใช่เครือข่ายเดิม</span></p>
        </section>
        <section class="card" data-shop-card>
          <div class="step-title"><span class="step-no">2</span>เลือกร้าน</div>
          <div data-shops></div>
          <div data-shop-notice></div>
        </section>
        <section class="card">
          <div class="step-title"><span class="step-no" data-amount-step>3</span>เลือกจำนวน</div>
          <div class="amount-grid" data-presets></div>
          <div class="small text-danger mt-1" data-amount-msg></div>
          <div class="field mt-2" data-custom-wrap>
            <label for="amount">หรือระบุจำนวนเงินเอง (บาท)</label>
            <div class="input-affix"><span>฿</span><input class="input lg" id="amount" name="amount" inputmode="numeric" autocomplete="off" placeholder="0" maxlength="6"></div>
            <div class="help" data-amount-help></div>
            <div class="error-text" data-amount-error></div>
          </div>
        </section>
      </div>
      <aside class="summary card" data-summary></aside>
    </div>`);

  const view = ctx.view;
  const netsEl = view.querySelector('[data-nets]');
  const noticeEl = view.querySelector('[data-net-notice]');
  const shopCard = view.querySelector('[data-shop-card]');
  const shopsEl = view.querySelector('[data-shops]');
  const shopNoticeEl = view.querySelector('[data-shop-notice]');
  const amountStepEl = view.querySelector('[data-amount-step]');
  const presetsEl = view.querySelector('[data-presets]');
  const amountMsg = view.querySelector('[data-amount-msg]');
  const customWrap = view.querySelector('[data-custom-wrap]');
  const amountInput = view.querySelector('#amount');
  const amountHelp = view.querySelector('[data-amount-help]');
  const amountErr = view.querySelector('[data-amount-error]');
  const summaryEl = view.querySelector('[data-summary]');

  const currentNet = () => networkOf(st.network);
  const currentShop = () => shopOf(st.shop);
  const sNet = () => shopNet(currentShop(), st.network); // null = ไม่มีร้านให้เลือก (ระบบเลือกให้)
  const fixedAmounts = () => (Array.isArray(sNet()?.amounts) ? sNet().amounts : null);
  const customOk = () => (sNet() ? Boolean(sNet().custom) : Boolean(currentNet()?.topup.allow_custom));
  const discountBp = () => (sNet() ? sNet().discount_bp || 0 : currentNet()?.topup.discount_bp || 0);
  const amountChoices = () => fixedAmounts() || currentNet()?.topup.presets || [];
  /** ราคาที่จ่ายจริงที่ร้านนี้ (สตางค์) — สูตรเดียวกับเซิร์ฟเวอร์ */
  const payFor = (bahtAmount) => priceAfter(bahtAmount * 100, discountBp());

  /** เลือกร้านให้อัตโนมัติ: ร้านที่ใช้ล่าสุด (ถ้าเปิดและมีค่ายนี้) → ไม่งั้นร้านที่ส่วนลดค่ายนี้มากที่สุด */
  function autoShop() {
    const list = shops();
    if (!list.length) return null;
    if (list.length === 1) return list[0].code;
    const ok = list.filter((s) => shopOpen(s) && shopServes(s, st.network));
    if (!ok.length) return null;
    const last = ok.find((s) => s.code === lastShop());
    if (last) return last.code;
    const bp = (s) => shopNet(s, st.network)?.discount_bp || 0;
    return ok.reduce((best, s) => (bp(s) > bp(best) ? s : best), ok[0]).code;
  }
  /** หลังเปลี่ยนเครือข่าย / ข้อมูลร้านเปลี่ยน: ร้านที่ลูกค้าเลือกเองยังใช้ได้ → คงไว้ · ไม่ได้ → เลือกใหม่ + แจ้ง */
  function pickShop() {
    const s = currentShop();
    if (shopTouched && s && shopOpen(s) && shopServes(s, st.network)) return;
    if (shopTouched && s) {
      shopNotice = `${s.name} ${!shopOpen(s) ? 'ปิดชั่วคราว' : `ไม่มีบริการเติมเงิน ${currentNet()?.name || 'ค่ายนี้'}`} — เลือกร้านอื่นให้แล้ว กรุณาตรวจสอบ`;
    }
    shopTouched = false;
    st.shop = autoShop();
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
    if (!customOk() && !n.topup.presets.includes(st.amount)) return `${n.name} เติมได้เฉพาะ ${n.topup.presets.join(', ')} บาท`;
    return null;
  }

  function renderNets() {
    setHTML(netsEl, nets().map((n) => {
      const on_ = n.code === st.network;
      return html`<button type="button" role="tab" data-net="${n.code}" class="${on_ ? 'active' : ''}" aria-selected="${on_ ? 'true' : 'false'}"
        ${n.topup.open ? '' : raw('aria-disabled="true"')}><span class="tab-dot" style="background:${raw(safeColor(n.color))}"></span>${n.name}${n.topup.open ? '' : html`<span class="tab-count">ปิด</span>`}</button>`;
    }));
    const n = currentNet();
    let notice = '';
    if (!n && missingNet) notice = alertBox('warning', `เครือข่าย ${missingNet} ปิดให้บริการชั่วคราว — กรุณาเลือกเครือข่ายที่เบอร์นี้ใช้งานอยู่จริง`);
    else if (n && !n.topup.open) notice = alertBox('warning', n.notice || `${n.name} ปิดให้บริการเติมเงินชั่วคราว`);
    else if (n?.notice) notice = alertBox('info', n.notice);
    else if (netHint) notice = alertBox('info', netHint);
    setHTML(noticeEl, notice ? html`<div class="mt-2">${notice}</div>` : '');
  }

  function shopCardHtml(s, n) {
    const sn = shopNet(s, st.network);
    const closed = !shopOpen(s) || (n && !shopServes(s, st.network));
    const on_ = s.code === st.shop;
    const sub = !shopOpen(s) ? 'ปิดชั่วคราว'
      : !n ? 'เลือกเครือข่ายก่อน'
        : !shopServes(s, st.network) ? 'ไม่มีบริการค่ายนี้'
          : `${sn.discount_bp > 0 ? `ส่วนลด ${percent(sn.discount_bp)}` : 'ราคาปกติ'}${Array.isArray(sn.amounts) ? ' · เฉพาะบางยอด' : ''}`;
    return html`<button type="button" class="net-card ${on_ ? 'active' : ''} ${closed ? 'closed' : ''}" data-shop="${s.code}"
        style="--net:${raw(safeColor(n?.color || '#4f46e5'))}" aria-pressed="${on_ ? 'true' : 'false'}" ${closed ? raw('aria-disabled="true"') : ''}>
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
      const sn = shopNet(s, st.network);
      setHTML(shopsEl, html`<div class="row wrap" style="--gap:8px"><span class="bold">${s.name}</span>
        ${!shopOpen(s) ? html`<span class="badge danger">ปิดชั่วคราว</span>`
          : n && !shopServes(s, st.network) ? html`<span class="badge danger">ไม่มีบริการค่ายนี้</span>`
            : sn?.discount_bp > 0 ? html`<span class="badge success plain">ส่วนลด ${percent(sn.discount_bp)}</span>` : ''}</div>`);
    } else {
      setHTML(shopsEl, html`<div class="net-grid">${list.map((s) => shopCardHtml(s, n))}</div>`);
    }
    setHTML(shopNoticeEl, shopNotice ? html`<div class="mt-2">${alertBox('warning', shopNotice)}</div>` : '');
  }

  function renderPresets() {
    const n = currentNet();
    const s = currentShop();
    // มีร้านให้เลือกแต่ยังไม่ได้เลือก (เช่น ไม่มีร้านไหนให้บริการค่ายนี้) → ไม่แสดงยอด/ราคา ที่ยังไม่รู้ว่าร้านไหนขาย
    const needShop = shops().length > 0 && !s;
    const choices = n && !needShop ? amountChoices() : [];
    const empty = !n ? 'เลือกเครือข่ายก่อน'
      : needShop ? (shops().some((x) => shopOpen(x) && shopServes(x, st.network)) ? 'เลือกร้านก่อน' : `ยังไม่มีร้านที่ให้บริการเติมเงิน ${n.name} ในขณะนี้`)
        : s ? `${s.name} ยังไม่มียอดให้เลือกสำหรับ ${n.name} — ลองเลือกร้านอื่น` : 'ยังไม่มียอดให้เลือก';
    setHTML(presetsEl, choices.length
      ? choices.map((v) => html`<button type="button" class="amount-btn ${st.amount === v ? 'active' : ''}" data-amount="${v}">
          <span class="num">${v.toLocaleString('th-TH')}</span><small>จ่าย ฿${bahtShort(payFor(v))}</small></button>`)
      : html`<div class="small muted" style="grid-column:1/-1">${empty}</div>`);
    const custom = Boolean(n) && !needShop && customOk();
    customWrap.classList.toggle('hidden', !custom);
    amountHelp.textContent = custom ? `เติมได้ ${bahtShort(n.topup.min)} - ${bahtShort(n.topup.max)} บาท (จำนวนเต็ม)` : '';
    if (document.activeElement !== amountInput && !Number.isNaN(st.amount)) amountInput.value = st.amount ? String(st.amount) : '';
    const err = amountError();
    customWrap.classList.toggle('has-error', Boolean(err) && custom);
    amountErr.textContent = custom ? err || '' : '';
    amountMsg.textContent = custom ? '' : err || '';
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
    const shopOk = !needShop || (s && shopServes(s, st.network));
    const block = orderBlockReason()
      || (n && !n.topup.open ? n.notice || `${n.name} ปิดให้บริการเติมเงินชั่วคราว` : null)
      || (s && !shopOpen(s) ? `${s.name} ปิดชั่วคราว` : null);
    const ready = !block && n && shopOk && st.phone && face && (!u || after >= 0);
    setHTML(summaryEl, html`
      <h3 class="mb-2">สรุปรายการ</h3>
      <div class="sum-lines">
        <div class="sum-line"><span class="muted">เบอร์</span><span class="num bold">${st.phone ? phoneFmt(st.phone) : '-'}</span></div>
        <div class="sum-line"><span class="muted">เครือข่าย</span><span>${n ? netTag(n.code) : '-'}</span></div>
        ${needShop ? html`<div class="sum-line"><span class="muted">ร้าน</span><span class="bold">${s?.name || '-'}</span></div>` : ''}
        <div class="sum-line"><span class="muted">ยอดเติม</span><span class="num">${face ? `฿${baht(face)}` : '-'}</span></div>
        ${discount > 0 ? html`<div class="sum-line text-success"><span>ส่วนลด</span><span class="num">-฿${baht(discount)}</span></div>` : ''}
        <div class="sum-line total"><span>ชำระจริง</span><span class="num">฿${baht(price)}</span></div>
        ${u ? html`<div class="sum-line small"><span class="muted">ยอดในกระเป๋าหลังเติม</span>
          <span class="num ${after < 0 ? 'text-danger bold' : ''}">${after < 0 ? 'ไม่พอ' : `฿${baht(after)}`}</span></div>` : ''}
      </div>
      ${u && face && after < 0 ? html`<div class="mt-2">${alertBox('danger', html`ยอดเงินไม่พอ ขาดอีก ฿${baht(-after)}
        <div class="mt-1"><a class="btn sm primary" href="#/wallet?amount=${depositSuggestion(-after)}">${icon('plus', 16)} เติมเงินเข้ากระเป๋า</a></div>`)}</div>` : ''}
      ${block ? html`<div class="mt-2">${alertBox('warning', block)}</div>` : ''}
      <button class="btn primary lg block mt-2" data-confirm ${u && !ready ? raw('disabled') : ''}>
        ${u ? html`${icon('shield', 20)} ตรวจสอบและยืนยัน` : html`${icon('lock', 20)} เข้าสู่ระบบเพื่อเติมเงิน`}
      </button>
      ${u ? html`<p class="xsmall muted center mt-1 mb-0">ระบบจะให้ตรวจสอบเบอร์อีกครั้งก่อนตัดเงิน</p>` : ''}`);
  }

  const renderAll = () => { renderNets(); renderShops(); renderPresets(); renderSummary(); };

  // เบอร์นี้เคยเติมไปแล้ว → ใช้เครือข่าย (และร้าน) ของรายการล่าสุดเป็นค่าเริ่มต้น — ลูกค้าเลือกเองแล้วจะไม่เปลี่ยนให้
  let lookupSeq = 0;
  async function guessFromHistory(phone) {
    if (!phone || !state.user || netTouched) return;
    const my = ++lookupSeq;
    let rows = [];
    try { rows = (await api.get(`/api/orders${qs({ q: phone, pageSize: 5 })}`)).rows || []; } catch { return; }
    if (my !== lookupSeq || !ctx.alive() || netTouched || st.phone !== phone) return;
    const last = rows.find((o) => o.phone === phone);
    if (!last) return;
    const n = networkOf(last.network);
    if (n && n.code !== st.network) {
      st.network = n.code;
      missingNet = null;
      netHint = `เลือกเครือข่าย ${n.name} ให้ตามรายการล่าสุดของเบอร์นี้ — ถ้าย้ายค่ายแล้ว เลือกเครือข่ายใหม่ได้`;
    }
    const s = !shopTouched && last.shop ? shopOf(last.shop) : null;
    if (s && shopOpen(s) && shopServes(s, st.network)) st.shop = s.code;
    else pickShop();
    renderAll();
  }

  const phoneField = bindPhoneField(view, {
    onChange: (phone) => {
      const changed = phone !== st.phone;
      st.phone = phone;
      renderSummary();
      if (phone && changed) guessFromHistory(phone);
    },
    onPick: (entry) => {
      // เบอร์ในสมุดระบุเครือข่ายไว้ → ใช้เครือข่ายนั้นเสมอ (แม้ปิดอยู่ จะแสดงว่าปิด) ไม่คงเครือข่ายเดิมที่อาจผิด
      if (entry.network) {
        const n = networkOf(entry.network);
        st.network = n?.code || null;
        missingNet = n ? null : String(entry.network).slice(0, 20);
        netTouched = true;
        netHint = '';
        pickShop();
      }
      renderAll();
    },
  });

  on(netsEl, 'click', '[data-net]', (e, el) => {
    const n = networkOf(el.dataset.net);
    if (!n || !n.topup.open) {
      if (n) setHTML(noticeEl, html`<div class="mt-2">${alertBox('warning', n.notice || `${n.name} ปิดให้บริการเติมเงินชั่วคราว`)}</div>`);
      return;
    }
    st.network = n.code;
    missingNet = null;
    netTouched = true;
    netHint = '';
    pickShop();
    renderAll();
  });

  on(shopsEl, 'click', '[data-shop]', (e, el) => {
    const s = shopOf(el.dataset.shop);
    if (!s) return;
    if (!shopOpen(s)) shopNotice = `${s.name} ปิดชั่วคราว กรุณาเลือกร้านอื่น`;
    else if (!currentNet()) shopNotice = 'กรุณาเลือกเครือข่ายก่อน';
    else if (!shopServes(s, st.network)) shopNotice = `${s.name} ไม่มีบริการเติมเงิน ${currentNet().name} — กรุณาเลือกร้านอื่น`;
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

  on(summaryEl, 'click', '[data-confirm]', async () => {
    const returnPath = `/topup?network=${encodeURIComponent(st.network || q.network || '')}${st.phone ? `&phone=${st.phone}` : ''}${st.amount ? `&amount=${st.amount}` : ''}${st.shop ? `&shop=${encodeURIComponent(st.shop)}` : ''}`;
    if (!state.user) {
      navigate(`/login?next=${encodeURIComponent(returnPath)}`);
      return;
    }
    if (!st.phone) { phoneField.error('กรุณากรอกเบอร์มือถือให้ถูกต้อง 10 หลัก'); return; }
    if (!currentNet()) {
      setHTML(noticeEl, html`<div class="mt-2">${alertBox('warning', 'กรุณาเลือกเครือข่ายของเบอร์ที่จะเติม')}</div>`);
      netsEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (shops().length && !currentShop()) {
      shopNotice = 'กรุณาเลือกร้าน';
      renderShops();
      shopCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (!st.amount || amountError()) {
      customWrap.classList.add('has-error');
      const msg = amountError() || 'กรุณาเลือกจำนวนเงิน';
      if (customOk()) amountErr.textContent = msg;
      else amountMsg.textContent = msg;
      presetsEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    await confirmAndOrder(
      { type: 'topup', network: st.network, phone: st.phone, amount: st.amount, ...(st.shop ? { shop: st.shop } : {}) },
      {
        returnPath,
        onFieldError: (err) => {
          if (err.details.field === 'phone') phoneField.error(err.message);
          else if (err.details.field === 'shop') { shopNotice = err.message; renderShops(); }
          else if (err.details.field === 'amount') {
            if (customOk()) { customWrap.classList.add('has-error'); amountErr.textContent = err.message; } else amountMsg.textContent = err.message;
          }
        },
      },
    );
  });

  // ข้อมูลร้าน/ราคาเปลี่ยน (โหลดใหม่ เช่น หลังร้านปิดชั่วคราว หรือกลับมาที่แท็บนี้) → วาดใหม่ตามข้อมูลล่าสุด คงสิ่งที่ลูกค้าเลือกไว้
  const off = onChange((what) => {
    if (what !== 'catalog' || !ctx.alive() || !state.catalog) return;
    if (st.network && !networkOf(st.network)) { missingNet = st.network; st.network = null; }
    pickShop();
    renderAll();
  });
  ctx.onLeave(off);

  if (!st.shop || !shopTouched) st.shop = autoShop();
  else pickShop();
  st.phone = phoneField.value;
  renderAll();
}
