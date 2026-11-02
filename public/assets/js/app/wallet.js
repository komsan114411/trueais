// กระเป๋าเงิน: ยอดคงเหลือ, เติมเงินเข้ากระเป๋า (พร้อมเพย์ / โอนบัญชี + แนบสลิป), ประวัติเติมเงิน, รายการเดินบัญชี
import { html, raw, api, on, setHTML, baht, dateTime, withLoading, toast, toastError, navigate, compressImage, copyText, confirmDialog } from '../lib.js';
import { state, refreshUser, getDraft, openDeposits, sellsPackages } from './state.js';
import { icon } from './icons.js';
import { pageHead, emptyState, pager, alertBox, bahtEmphasis, supportLinks, draftBanner, depositBanner } from './ui.js';

const DEP_STATUS = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: '',
};
const depBadge = (d) => html`<span class="badge ${DEP_STATUS[d.status] || ''}">${d.status === 'pending' && !d.has_slip ? 'รอแนบสลิป' : d.status_label}</span>`;
const methodLabel = (m) => (m === 'promptpay' ? 'พร้อมเพย์' : 'โอนบัญชี');

/** เวลารอคำตอบ: สร้างรายการเติมเงิน / ส่งสลิป (รูปอาจใหญ่ เน็ตมือถือช้า) */
const CREATE_TIMEOUT_MS = 20000;
const SLIP_TIMEOUT_MS = 60000;

export async function walletPage(ctx) {
  const s = state.catalog.settings;
  const q = ctx.query;
  const [, openList] = await Promise.all([refreshUser(), openDeposits().catch(() => [])]);
  if (!ctx.alive() || !state.user) return; // เซสชันหมดอายุ → ระบบพาไปหน้าเข้าสู่ระบบ
  const u = state.user;
  const methods = [];
  if (s.promptpay_enabled) methods.push({ v: 'promptpay', l: 'พร้อมเพย์', sub: 'สแกน QR ด้วยแอปธนาคาร', icon: 'qr' });
  if (s.bank_accounts) methods.push({ v: 'bank', l: 'โอนเข้าบัญชี', sub: 'โอนแล้วแนบสลิป', icon: 'bank' });
  const presets = [100, 300, 500, 1000].filter((v) => v >= s.deposit_min_baht && v <= s.deposit_max_baht);
  const wanted = /^\d+$/.test(q.amount || '') ? Math.min(Math.max(Number(q.amount), s.deposit_min_baht), s.deposit_max_baht) : null;
  const st = { amount: wanted, method: methods[0]?.v || null, tab: q.tab === 'ledger' ? 'ledger' : 'deposits', page: 1 };

  setHTML(ctx.view, html`
    ${pageHead('กระเป๋าเงิน', sellsPackages() ? 'เติมเงินเข้ากระเป๋าครั้งเดียว ใช้เติมมือถือและซื้อแพ็กเกจได้ทันที' : 'เติมเงินเข้ากระเป๋าครั้งเดียว ใช้เติมเงินมือถือได้ทันที')}
    ${openList.length ? html`<div class="mb-2">${depositBanner(openList)}</div>` : ''}
    ${draftBanner() ? html`<div class="mb-2">${draftBanner()}</div>` : ''}
    <div class="wallet-layout">
      <section class="wallet-card">
        <div class="small wallet-muted">ยอดเงินคงเหลือ</div>
        <div class="wallet-amount num">฿${baht(u.balance)}</div>
        <div class="wallet-actions">
          <a class="btn sm wallet-btn" href="#/topup">${icon('bolt', 16)} เติมเงินมือถือ</a>
          ${sellsPackages() ? html`<a class="btn sm wallet-btn" href="#/packages">${icon('wifi', 16)} แพ็กเกจเน็ต</a>` : ''}
        </div>
      </section>
      <section class="card">
        <h3 class="mb-2">เติมเงินเข้ากระเป๋า</h3>
        ${wanted ? html`<div class="mb-2">${alertBox('warning', html`ยอดเงินไม่พอสำหรับรายการที่ทำ แนะนำให้เติมอย่างน้อย <b>฿${wanted.toLocaleString('th-TH')}</b>${getDraft() ? ' — เติมเงินเสร็จแล้วกลับไปทำรายการเดิมต่อได้ทันที (ระบบจำไว้ให้)' : ''}`)}</div>` : ''}
        ${!methods.length ? alertBox('danger', html`ร้านยังไม่ได้ตั้งค่าช่องทางรับเงิน กรุณาติดต่อผู้ดูแลระบบ${supportLinks(s) ? html` (${supportLinks(s)})` : ''}`) : html`
        <form data-dep-form novalidate>
          <div class="amount-grid dep-presets" data-presets>
            ${presets.map((v) => html`<button type="button" class="amount-btn ${st.amount === v ? 'active' : ''}" data-amount="${v}"><span class="num">${v.toLocaleString('th-TH')}</span><small>บาท</small></button>`)}
          </div>
          <div class="field mt-2">
            <label for="depAmount">จำนวนเงิน (บาท)</label>
            <div class="input-affix"><span>฿</span><input class="input lg" id="depAmount" name="amount" inputmode="numeric" maxlength="7" autocomplete="off" value="${st.amount || ''}" placeholder="0"></div>
            <div class="help">ขั้นต่ำ ${s.deposit_min_baht.toLocaleString('th-TH')} บาท · สูงสุด ${s.deposit_max_baht.toLocaleString('th-TH')} บาทต่อครั้ง · กรอกเป็นจำนวนเต็มบาท (ระบบอาจเพิ่มเศษสตางค์ให้ เพื่อตรวจยอดโอนได้ถูกต้อง)</div>
            <div class="error-text"></div>
          </div>
          <div class="field mt-2">
            <span class="label">ช่องทาง</span>
            <div class="method-grid">
              ${methods.map((m) => html`<label class="method-card ${st.method === m.v ? 'active' : ''}">
                <input type="radio" name="method" value="${m.v}" ${st.method === m.v ? 'checked' : ''}>
                <span class="method-icon">${icon(m.icon, 22)}</span><span><span class="bold d-block">${m.l}</span><span class="xsmall muted">${m.sub}</span></span>
              </label>`)}
            </div>
          </div>
          <div class="field mt-2">
            <label for="depNote">หมายเหตุ (ไม่บังคับ)</label>
            <input class="input" id="depNote" name="note" maxlength="200" placeholder="เช่น ชื่อบัญชีที่โอน">
          </div>
          <div data-dep-err></div>
          <button class="btn primary lg block mt-2" type="submit" data-loading-text="กำลังสร้างรายการ...">${icon('arrowRight', 20)} ถัดไป: ดูวิธีชำระเงิน</button>
        </form>`}
      </section>
    </div>
    <section class="card flush mt-3">
      <div class="tabs-head">
        <div class="segmented" data-tabs>
          <button type="button" data-tab="deposits" class="${st.tab === 'deposits' ? 'active' : ''}">ประวัติเติมเงิน</button>
          <button type="button" data-tab="ledger" class="${st.tab === 'ledger' ? 'active' : ''}">รายการเดินบัญชี</button>
        </div>
      </div>
      <div data-tab-body></div>
    </section>`);

  const view = ctx.view;
  const form = view.querySelector('[data-dep-form]');
  const body = view.querySelector('[data-tab-body]');

  if (form) {
    const amountInput = form.querySelector('#depAmount');
    const depErr = form.querySelector('[data-dep-err]');
    const setAmount = (v) => {
      st.amount = v;
      form.querySelectorAll('[data-amount]').forEach((b) => b.classList.toggle('active', Number(b.dataset.amount) === v));
      form.querySelector('.field.has-error')?.classList.remove('has-error');
    };
    const setMethod = (v) => {
      st.method = v;
      form.querySelectorAll('input[name="method"]').forEach((r) => { r.checked = r.value === v; });
      form.querySelectorAll('.method-card').forEach((c) => c.classList.toggle('active', Boolean(c.querySelector(`input[value="${v}"]`))));
    };
    on(form, 'click', '[data-amount]', (e, el) => {
      setAmount(Number(el.dataset.amount));
      amountInput.value = el.dataset.amount;
    });
    amountInput.addEventListener('input', () => {
      // มีทศนิยม → ไม่ตัดจุดทิ้งเอง (กัน "100.50" กลายเป็น 10,050 บาท) แจ้งให้กรอกจำนวนเต็มบาท
      if (amountInput.value.includes('.')) { setAmount(NaN); return; }
      const d = amountInput.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 7);
      if (d !== amountInput.value) amountInput.value = d;
      setAmount(d ? Number(d) : null);
    });
    on(form, 'change', 'input[name="method"]', (e, el) => { setMethod(el.value); setHTML(depErr, ''); });
    // พร้อมเพย์ใช้ไม่ได้ → เปลี่ยนเป็นโอนเข้าบัญชีในแตะเดียว
    on(form, 'click', '[data-use-bank]', () => {
      setMethod('bank');
      setHTML(depErr, '');
      form.querySelector('[type="submit"]').focus();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const field = amountInput.closest('.field');
      const err = Number.isNaN(st.amount) ? 'ระบุเป็นจำนวนเต็มบาท (ไม่ต้องใส่ทศนิยม)'
        : !st.amount ? 'กรุณาระบุจำนวนเงิน'
        : st.amount < s.deposit_min_baht ? `เติมขั้นต่ำ ${s.deposit_min_baht} บาท`
          : st.amount > s.deposit_max_baht ? `เติมได้สูงสุด ${s.deposit_max_baht.toLocaleString('th-TH')} บาท` : null;
      if (err) {
        field.classList.add('has-error');
        field.querySelector('.error-text').textContent = err;
        amountInput.focus();
        return;
      }
      setHTML(depErr, '');
      const btn = form.querySelector('[type="submit"]');
      withLoading(btn, async () => {
        try {
          const d = await api.post('/api/deposits', { amount: st.amount, method: st.method, note: form.querySelector('#depNote').value.trim() || undefined }, { timeout: CREATE_TIMEOUT_MS });
          navigate(`/deposit/${d.deposit.id}`);
        } catch (er) {
          if (!ctx.alive()) return;
          if (er.details?.field === 'amount') {
            field.classList.add('has-error');
            field.querySelector('.error-text').textContent = er.message;
          }
          const box = (content) => setHTML(depErr, html`<div class="mt-2">${content}</div>`);
          if (er.code === 'PROMPTPAY_NOT_READY') {
            // QR พร้อมเพย์ของร้านใช้ไม่ได้ (ยังไม่ได้สร้างรายการ) → แนะนำโอนเข้าบัญชี / ติดต่อร้าน
            box(alertBox('warning', html`<div class="bold">พร้อมเพย์ของร้านใช้งานไม่ได้ชั่วคราว</div><div class="small">${er.message}</div>
              ${methods.some((m) => m.v === 'bank') ? html`<button type="button" class="btn sm primary mt-1" data-use-bank>${icon('bank', 16)} เปลี่ยนเป็นโอนเข้าบัญชี</button>` : ''}
              ${supportLinks(s) ? html`<div class="small mt-1">ติดต่อร้าน: ${supportLinks(s)}</div>` : ''}`));
          } else if (er.code === 'DEPOSIT_OPEN_LIMIT') {
            // มีรายการค้างหลายรายการ → พาไปทำต่อ/ยกเลิกรายการเดิม
            const ids = (Array.isArray(er.details?.open) ? er.details.open : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 10);
            box(alertBox('warning', html`<div class="bold">มีรายการเติมเงินที่ยังไม่เสร็จ</div><div class="small">${er.message}</div>
              ${ids.length ? html`<div class="row wrap mt-1" style="--gap:6px">${ids.map((id) => html`<a class="btn sm" href="#/deposit/${id}">ทำต่อ / ยกเลิก #${id}</a>`)}</div>` : ''}`));
          } else if (er.code === 'NETWORK') {
            // ไม่รู้ว่าสร้างรายการแล้วหรือยัง → ให้ดูประวัติก่อน (ไม่สร้างซ้ำ)
            box(alertBox('warning', html`<div class="bold">${er.details?.timeout ? 'เซิร์ฟเวอร์ตอบช้า' : 'การเชื่อมต่อขัดข้อง'} — ยังไม่แน่ใจว่าสร้างรายการแล้วหรือยัง</div>
              <div class="small">ดูที่ "ประวัติเติมเงิน" ด้านล่างก่อน ถ้ามีรายการใหม่แล้ว ให้กดเข้าไปทำต่อ (ไม่ต้องสร้างซ้ำ)</div>`));
            if (st.tab === 'deposits') { st.page = 1; loadTab(); }
          } else if (er.details?.field !== 'amount') {
            box(alertBox('danger', er.message));
          }
          // แสดงไว้ในฟอร์มแล้ว (ไม่ต้องมี toast ซ้ำ) — เลื่อนให้เห็นข้อความ
          depErr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    });
  }

  async function loadTab() {
    setHTML(body, html`<div class="p-3 stack">${[1, 2, 3].map(() => html`<div class="skeleton" style="height:46px"></div>`)}</div>`);
    try {
      if (st.tab === 'deposits') {
        const d = await api.get(`/api/deposits?page=${st.page}&pageSize=10`);
        if (!ctx.alive()) return;
        setHTML(body, d.rows.length ? html`<div class="dep-list">
          ${d.rows.map((x) => html`<a class="dep-item" href="#/deposit/${x.id}">
            <span class="dep-icon">${icon(x.method === 'promptpay' ? 'qr' : 'bank', 20)}</span>
            <span class="grow"><span class="bold num d-block">฿${baht(x.amount)}</span><span class="xsmall muted">#${x.id} · ${methodLabel(x.method)} · ${dateTime(x.created_at)}</span></span>
            ${depBadge(x)}
          </a>`)}</div>${pager(d)}`
          : emptyState('wallet', 'ยังไม่มีประวัติเติมเงินเข้ากระเป๋า', 'เริ่มเติมเงินเข้ากระเป๋าได้จากแบบฟอร์มด้านบน'));
      } else {
        const d = await api.get(`/api/wallet?page=${st.page}&pageSize=15`);
        if (!ctx.alive()) return;
        setHTML(body, d.ledger.rows.length ? html`<div class="table-wrap"><table class="table ledger-table">
          <thead><tr><th>วันที่</th><th>รายการ</th><th class="num">จำนวน</th><th class="num">คงเหลือ</th></tr></thead>
          <tbody>${d.ledger.rows.map((l) => html`<tr>
            <td class="nowrap small">${dateTime(l.created_at)}</td>
            <td><div class="bold small">${l.type_label}</div><div class="xsmall muted">${l.order_ref ? html`<a href="#/order/${l.order_ref}">${l.order_ref}</a> · ` : ''}${l.note || ''}</div></td>
            <td class="num nowrap ${l.amount >= 0 ? 'text-success' : 'text-danger'} bold">${l.amount >= 0 ? '+' : '-'}฿${baht(Math.abs(l.amount))}</td>
            <td class="num nowrap">฿${baht(l.balance_after)}</td>
          </tr>`)}</tbody></table></div>${pager(d.ledger)}`
          : emptyState('wallet', 'ยังไม่มีรายการเดินบัญชี'));
      }
    } catch (err) {
      if (ctx.alive()) setHTML(body, emptyState('alert', 'โหลดข้อมูลไม่สำเร็จ', err.message, html`<button type="button" class="btn sm" data-tab-retry>${icon('refresh', 16)} ลองใหม่</button>`));
    }
  }

  on(view.querySelector('[data-tabs]'), 'click', '[data-tab]', (e, el) => {
    st.tab = el.dataset.tab;
    st.page = 1;
    view.querySelectorAll('[data-tabs] [data-tab]').forEach((b) => b.classList.toggle('active', b === el));
    history.replaceState(null, '', `#/wallet${st.tab === 'ledger' ? '?tab=ledger' : ''}`);
    loadTab();
  });
  on(body, 'click', '[data-page]', (e, el) => {
    st.page = Math.max(1, Number(el.dataset.page));
    loadTab();
  });
  on(body, 'click', '[data-tab-retry]', () => loadTab());
  await loadTab();
}

// ───────────── QR พร้อมเพย์ → รูปภาพ (บันทึกลงเครื่อง แล้วเลือกรูปในแอปธนาคาร — จ่ายจากมือถือเครื่องเดียวกันได้) ─────────────

const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function fitText(g, text, maxWidth) {
  let t = String(text || '');
  if (g.measureText(t).width <= maxWidth) return t;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** วาด QR (SVG จากเซิร์ฟเวอร์) ลง canvas พร้อมยอดเงิน/ชื่อบัญชี → ไฟล์ PNG */
async function qrImageFile(svgText, { amountText, name, depositId }) {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('QR_IMAGE'));
      i.src = url;
    });
    try { await document.fonts?.ready; } catch { /* ignore */ }
    const W = 720;
    const QR = 560;
    const H = 90 + 30 + QR + (name ? 150 : 110) + 60;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    const font = (w, px) => `${w} ${px}px "IBM Plex Sans Thai", "Noto Sans Thai", Tahoma, sans-serif`;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#133b6b';
    g.fillRect(0, 0, W, 90);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = font(700, 34);
    g.fillText('พร้อมเพย์ · PromptPay', W / 2, 46);
    g.imageSmoothingEnabled = false;
    g.drawImage(img, (W - QR) / 2, 120, QR, QR);
    let y = 120 + QR + 55;
    g.fillStyle = '#111827';
    g.font = font(800, 52);
    g.fillText(`฿${amountText}`, W / 2, y);
    if (name) {
      y += 52;
      g.fillStyle = '#374151';
      g.font = font(600, 28);
      g.fillText(fitText(g, name, W - 60), W / 2, y);
    }
    g.fillStyle = '#6b7280';
    g.font = font(400, 24);
    g.fillText('สแกนด้วยแอปธนาคาร · ยอดเงินอยู่ใน QR แล้ว', W / 2, H - 40);
    const blob = await new Promise((resolve, reject) => {
      try { canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('QR_BLOB'))), 'image/png'); } catch (e) { reject(e); }
    });
    return new File([blob], `promptpay-${depositId}-${amountText.replace(/[^\d.]/g, '')}.png`, { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** เลขบัญชีในข้อความบัญชีธนาคาร (สำหรับปุ่มคัดลอก) */
function accountNumbers(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\d[\d -]{7,}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15 && !out.some((x) => x.digits === digits)) out.push({ shown: m[0].trim(), digits });
  }
  return out.slice(0, 4);
}

export async function depositPage(ctx) {
  const id = ctx.params.id;
  const s = state.catalog.settings;
  let timer = null;
  let slip = null;
  let lastStatus = null;
  let qrFile = null; // รูป QR ที่เตรียมไว้ (ต้องพร้อมก่อนกด เพราะเมนูแชร์ของ iPhone ต้องเปิดทันทีที่กด)
  let qrUrl = null;
  let qrWork = null;
  // รอแอดมินตรวจอาจนานหลายชั่วโมง → เช็กอัตโนมัติไม่เกิน 30 นาที (และไม่เช็กตอนแท็บถูกซ่อน) จากนั้นกด "ตรวจสอบสถานะ" เอง
  const MAX_DEP_POLL_MS = 30 * 60 * 1000;
  let pollStarted = Date.now();
  const dropQr = () => {
    if (qrUrl) URL.revokeObjectURL(qrUrl);
    qrUrl = null;
    qrFile = null;
    qrWork = null;
  };
  ctx.onLeave(() => { clearTimeout(timer); dropQr(); });
  const schedule = (ms) => {
    clearTimeout(timer);
    if (Date.now() - pollStarted > MAX_DEP_POLL_MS) return;
    timer = setTimeout(() => (document.hidden ? schedule(ms) : load({ quiet: true })), ms);
  };

  async function load({ quiet = false } = {}) {
    let d;
    try {
      d = await api.get(`/api/deposits/${encodeURIComponent(id)}`, { timeout: 20000 });
    } catch (err) {
      if (!ctx.alive()) return false;
      if (quiet) { schedule(15000); return false; }
      setHTML(ctx.view, emptyState('alert', err.code === 'NOT_FOUND' ? 'ไม่พบรายการเติมเงินนี้' : 'โหลดข้อมูลไม่สำเร็จ', err.message, html`<a class="btn sm" href="#/wallet">กลับไปกระเป๋าเงิน</a>`));
      return false;
    }
    if (!ctx.alive()) return false;
    const dep = d.deposit;
    const sig = `${dep.status}|${dep.has_slip}`;
    if (!quiet || sig !== lastStatus) {
      if (quiet && dep.status === 'approved') { toast(`เติมเงินเข้ากระเป๋าสำเร็จ ฿${baht(dep.credited_amount ?? dep.amount)}`, 'success'); refreshUser(); }
      lastStatus = sig;
      render(d);
    }
    if (dep.status === 'pending' && dep.has_slip) schedule(10000);
    return true;
  }

  function render({ deposit: dep, qr, pay_to: payToRaw }) {
    slip = null;
    const payTo = payToRaw || {};
    const head = pageHead(`เติมเงินเข้ากระเป๋า #${dep.id}`, `สร้างเมื่อ ${dateTime(dep.created_at)} · ${methodLabel(dep.method)}`, depBadge(dep));
    if (dep.status === 'approved') {
      dropQr();
      setHTML(ctx.view, html`${head}<section class="card status-card success"><div class="status-hero">
        <div class="status-icon success">${icon('check', 46)}</div>
        <h1 class="status-title">เติมเงินเข้ากระเป๋าสำเร็จ</h1>
        <div class="status-amount num">฿${baht(dep.credited_amount ?? dep.amount)}</div>
        <p class="status-sub">ตรวจสอบเมื่อ ${dateTime(dep.reviewed_at)}${dep.admin_note ? ` · ${dep.admin_note}` : ''}</p>
      </div>${getDraft() ? html`<div class="status-actions"><a class="btn primary" href="#${getDraft().path}">${icon('bolt', 18)} ทำรายการที่ค้างไว้ต่อ</a><a class="btn" href="#/wallet">กลับไปกระเป๋าเงิน</a></div>
      <p class="small muted center mt-1 mb-0 px-3">${getDraft().label}</p>`
      : html`<div class="status-actions"><a class="btn primary" href="#/topup">${icon('bolt', 18)} เติมเงินมือถือ</a><a class="btn" href="#/wallet">กลับไปกระเป๋าเงิน</a></div>`}</section>`);
      return;
    }
    if (dep.status === 'rejected' || dep.status === 'cancelled') {
      dropQr();
      setHTML(ctx.view, html`${head}<section class="card status-card failed"><div class="status-hero">
        <div class="status-icon failed">${icon('x', 46)}</div>
        <h1 class="status-title">${dep.status === 'rejected' ? 'ไม่อนุมัติรายการนี้' : 'ยกเลิกรายการแล้ว'}</h1>
        <div class="status-amount num">฿${baht(dep.amount)}</div>
        ${dep.admin_note ? html`<p class="status-sub">เหตุผล: ${dep.admin_note}</p>` : ''}
        ${dep.status === 'rejected' ? html`<p class="small muted">หากโอนเงินแล้วแต่ไม่ได้รับการอนุมัติ กรุณาติดต่อผู้ดูแล${supportLinks(s) ? html` (${supportLinks(s)})` : ''}</p>` : ''}
      </div><div class="status-actions"><a class="btn primary" href="#/wallet">${icon('plus', 18)} สร้างรายการใหม่</a></div></section>`);
      return;
    }
    const amountText = (dep.amount / 100).toFixed(2);
    const ppId = payTo.promptpay_id || null;
    const ppName = payTo.promptpay_name || qr?.name || null;
    const bankText = payTo.bank_accounts ?? s.bank_accounts ?? '';
    const accounts = accountNumbers(bankText);
    const showBank = (dep.method === 'bank' || !qr) && bankText;
    setHTML(ctx.view, html`${head}
      <div class="deposit-layout">
        <section class="card">
          <div class="step-title"><span class="step-no">1</span>โอนเงินตามยอดนี้ (ให้ตรงทุกสตางค์)</div>
          <div class="transfer-amount">
            <div class="small muted">ยอดที่ต้องโอน</div>
            <div class="amt">${bahtEmphasis(dep.amount)}</div>
            <button type="button" class="btn sm soft" data-copy="${amountText}" data-copy-msg="คัดลอกยอด ${amountText} แล้ว">${icon('copy', 16)} คัดลอกยอด ${amountText}</button>
          </div>
          <p class="small text-2 mt-2 row top" style="--gap:6px">${icon('alert', 16)}<span>กรุณาโอน <b>${amountText} บาท</b> ให้ตรงทุกสตางค์ (รวมเศษสตางค์ .${String(dep.amount % 100).padStart(2, '0')}) เพื่อให้ตรวจสอบได้รวดเร็วและไม่สลับกับรายการของคนอื่น</span></p>
          ${dep.method === 'promptpay' && qr ? html`<div class="qr-box">
            <div class="qr-head">พร้อมเพย์ · PromptPay</div>
            <div class="qr-svg">${raw(qr.svg)}</div>
            ${ppName ? html`<div class="bold center">${ppName}</div>` : ''}
            <div class="xsmall muted center">สแกนด้วยแอปธนาคารใดก็ได้ · ยอดถูกใส่ใน QR ให้แล้ว</div>
          </div>
          <div class="qr-save">
            <button type="button" class="btn primary block" data-save-qr>${icon('download', 18)} บันทึก QR เป็นรูป</button>
            <ol class="qr-steps" aria-label="จ่ายจากมือถือเครื่องนี้">
              <li><span class="qs-no">1</span>เปิดแอปธนาคาร</li>
              <li><span class="qs-no">2</span>กด "สแกน"</li>
              <li><span class="qs-no">3</span>เลือกรูป QR จากอัลบั้ม</li>
            </ol>
            <p class="xsmall muted center mb-0">บันทึกรูปไม่ได้? แคปหน้าจอ QR นี้แทนได้</p>
          </div>` : ''}
          ${dep.method === 'promptpay' && ppId ? html`<div class="pay-to mt-2">
            <div class="label mb-1">หรือโอนเข้าพร้อมเพย์ (กรอกเลขเอง)</div>
            <div class="pay-row"><span class="grow"><span class="num bold pay-id">${ppId}</span>${ppName ? html`<span class="d-block small muted">${ppName}</span>` : ''}</span>
              <button type="button" class="btn sm soft" data-copy="${ppId.replace(/[^\d]/g, '')}" data-copy-msg="คัดลอกเลขพร้อมเพย์แล้ว">${icon('copy', 16)} คัดลอก</button></div>
          </div>` : ''}
          ${dep.method === 'promptpay' && !qr ? html`<div class="mt-2">${alertBox('warning', html`QR พร้อมเพย์แสดงไม่ได้ในขณะนี้${ppId ? ' — โอนเข้าเลขพร้อมเพย์ด้านบนแทนได้' : ''}${bankText ? ' หรือโอนเข้าบัญชีด้านล่าง' : ''}${supportLinks(s) ? html` · ติดต่อร้าน: ${supportLinks(s)}` : ''}`)}</div>` : ''}
          ${showBank ? html`<div class="mt-2 pay-to"><div class="label mb-1">บัญชีสำหรับโอน</div><div class="bank-text">${bankText}</div>
            <div class="row wrap mt-1" style="--gap:6px">
              ${accounts.map((a) => html`<button type="button" class="btn sm soft" data-copy="${a.digits}" data-copy-msg="คัดลอกเลขบัญชีแล้ว">${icon('copy', 16)} คัดลอกเลขบัญชี ${a.shown}</button>`)}
              ${accounts.length !== 1 ? html`<button type="button" class="btn sm ghost" data-copy="${bankText}" data-copy-msg="คัดลอกข้อมูลบัญชีแล้ว">${icon('copy', 16)} คัดลอกทั้งหมด</button>` : ''}
            </div></div>` : ''}
        </section>
        <section class="card">
          <div class="step-title"><span class="step-no">2</span>แนบสลิปการโอน</div>
          ${dep.has_slip ? html`<div class="mb-2">${alertBox('success', html`<b>ได้รับสลิปแล้ว</b> กำลังรอเจ้าหน้าที่ตรวจสอบ — หน้านี้จะอัปเดตอัตโนมัติเมื่ออนุมัติ<div class="xsmall muted mt-1">แนบสลิปใหม่ได้ถ้าส่งรูปผิด</div>
            <div class="mt-1"><button type="button" class="btn sm" data-dep-refresh>${icon('refresh', 16)} ตรวจสอบสถานะ</button></div>`)}</div>` : ''}
          <div class="slip-amount">${icon('info', 16)}<span>สลิปต้องเป็นยอด <b class="num">฿${baht(dep.amount)}</b> (ตรงทุกสตางค์)</span></div>
          <form data-slip-form novalidate>
            <label class="upload-drop">
              <input type="file" accept="image/png,image/jpeg,image/webp" data-file>
              <span class="upload-icon">${icon('upload', 26)}</span>
              <span class="bold">แตะเพื่อเลือกรูปสลิป</span>
              <span class="xsmall muted">JPG / PNG / WEBP — ระบบย่อรูปให้อัตโนมัติ</span>
            </label>
            <img class="slip-preview hidden" data-preview alt="ตัวอย่างสลิป">
            <p class="xsmall text-2 center mt-1 mb-0 hidden" data-preview-note>ตรวจว่าสลิปเป็นยอด ฿${baht(dep.amount)} ก่อนกดส่ง</p>
            <div class="field mt-2">
              <label for="transferAt">เวลาที่โอน (ไม่บังคับ)</label>
              <input class="input" type="datetime-local" id="transferAt" name="transferAt">
            </div>
            <div data-slip-err></div>
            <button class="btn primary block mt-2" type="submit" data-send data-loading-text="กำลังส่งสลิป...">${icon('upload', 18)} ส่งสลิปให้ตรวจสอบ</button>
          </form>
          <hr>
          ${dep.has_slip
            // แนบสลิปแล้ว = แจ้งว่าโอนแล้ว → ระบบไม่ให้ยกเลิกเอง (กันยกเลิกทั้งที่เงินเข้าบัญชีร้านแล้ว)
            ? html`<p class="xsmall muted center mb-0">แนบสลิปแล้ว ยกเลิกรายการเองไม่ได้ — หากแนบผิดหรือยังไม่ได้โอนเงิน กรุณาติดต่อผู้ดูแล${supportLinks(s) ? html` (${supportLinks(s)})` : ''}</p>`
            : html`<button type="button" class="btn ghost block text-danger" data-cancel>${icon('x', 18)} ยกเลิกรายการนี้</button>`}
        </section>
      </div>`);

    // เตรียมรูป QR ไว้ล่วงหน้า (กดบันทึกแล้วได้ทันที)
    if (dep.method === 'promptpay' && qr?.svg && !qrWork) {
      qrWork = qrImageFile(qr.svg, { amountText, name: ppName, depositId: dep.id })
        .then((f) => {
          if (!ctx.alive()) return null;
          qrFile = f;
          qrUrl = URL.createObjectURL(f);
          return f;
        })
        .catch(() => null);
    }

    const form = ctx.view.querySelector('[data-slip-form]');
    const file = form.querySelector('[data-file]');
    const preview = form.querySelector('[data-preview]');
    const previewNote = form.querySelector('[data-preview-note]');
    const send = form.querySelector('[data-send]');
    const slipErr = form.querySelector('[data-slip-err]');
    file.addEventListener('change', async () => {
      slip = null;
      setHTML(slipErr, '');
      const f = file.files?.[0];
      if (!f) { preview.classList.add('hidden'); previewNote.classList.add('hidden'); return; }
      try {
        slip = await compressImage(f);
        preview.src = slip;
        preview.classList.remove('hidden');
        previewNote.classList.remove('hidden');
      } catch (err) {
        toastError(err);
        file.value = '';
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!slip) {
        setHTML(slipErr, html`<div class="mt-2">${alertBox('warning', 'กรุณาเลือกรูปสลิปก่อน — แตะกรอบด้านบนเพื่อเลือกรูปจากอัลบั้ม')}</div>`);
        form.querySelector('.upload-drop').classList.add('attention');
        setTimeout(() => form.querySelector('.upload-drop')?.classList.remove('attention'), 1800);
        return;
      }
      const t = form.querySelector('#transferAt').value;
      setHTML(slipErr, '');
      withLoading(send, async () => {
        try {
          await api.post(`/api/deposits/${dep.id}/slip`, { image: slip, transferAt: t ? new Date(t).toISOString() : undefined }, { timeout: SLIP_TIMEOUT_MS });
          toast('ส่งสลิปแล้ว รอเจ้าหน้าที่ตรวจสอบ', 'success');
          clearTimeout(timer);
          pollStarted = Date.now();
          await load();
        } catch (err) {
          if (!ctx.alive()) return;
          if (err.code === 'NETWORK') {
            // ไม่รู้ว่าสลิปถึงระบบหรือยัง — ส่งซ้ำได้ (แนบใหม่แทนรูปเดิม ไม่ทำให้เติมเงินซ้ำ) และเช็กสถานะให้
            setHTML(slipErr, html`<div class="mt-2">${alertBox('warning', html`<div class="bold">${err.details?.timeout ? 'ส่งสลิปช้าเกินไป (หมดเวลารอ)' : 'ส่งสลิปไม่สำเร็จ — การเชื่อมต่อขัดข้อง'}</div>
              <div class="small">ตรวจสอบอินเทอร์เน็ตแล้วกด "ส่งสลิปให้ตรวจสอบ" อีกครั้งได้เลย — ส่งซ้ำได้ ไม่ทำให้เติมเงินซ้ำ</div>`)}</div>`);
            load({ quiet: true });
          } else if (err.code === 'SLIP_USED' || err.details?.field) {
            // เช่น SLIP_USED (สลิปนี้ใช้ไปแล้ว / แนบกับรายการอื่นอยู่) — แสดงค้างไว้ในฟอร์มให้อ่านชัด
            setHTML(slipErr, html`<div class="mt-2">${alertBox('danger', err.message)}</div>`);
          } else toastError(err);
        }
      });
    });
  }

  on(ctx.view, 'click', '[data-copy]', (e, el) => copyText(el.dataset.copy, el.dataset.copyMsg || undefined));
  on(ctx.view, 'click', '[data-save-qr]', async (e, el) => {
    // iPhone: เมนูแชร์ → "บันทึกรูปภาพ" (ลงอัลบั้ม) · Android/คอมพิวเตอร์: ดาวน์โหลดรูป
    const f = qrFile || (await withLoading(el, () => qrWork));
    if (!f || !qrUrl) {
      toast('บันทึกรูปในเบราว์เซอร์นี้ไม่ได้ — แคปหน้าจอ QR แทน แล้วเลือกรูปนั้นในแอปธนาคาร', 'warning', 7000);
      return;
    }
    if (isIOS() && navigator.canShare?.({ files: [f] })) {
      try {
        await navigator.share({ files: [f], title: 'QR พร้อมเพย์' });
        toast('เลือก "บันทึกรูปภาพ" แล้วเปิดแอปธนาคาร › สแกน › เลือกรูปจากอัลบั้ม', 'info', 6000);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = qrUrl;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('บันทึกรูป QR แล้ว — เปิดแอปธนาคาร › สแกน › เลือกรูปจากอัลบั้ม', 'success', 6000);
  });
  on(ctx.view, 'click', '[data-dep-refresh]', (e, el) => {
    pollStarted = Date.now(); // เริ่มนับเวลาเช็กอัตโนมัติใหม่
    clearTimeout(timer);
    const before = lastStatus;
    withLoading(el, async () => {
      const ok = await load({ quiet: true });
      if (!ctx.alive()) return;
      if (!ok) toast('ตรวจสอบสถานะไม่สำเร็จ กรุณาลองใหม่', 'error');
      else if (lastStatus === before) toast('ยังรอเจ้าหน้าที่ตรวจสอบสลิป', 'info');
    });
  });
  on(ctx.view, 'click', '[data-cancel]', async (e, el) => {
    const yes = await confirmDialog({ title: 'ยกเลิกรายการเติมเงิน?', body: 'ถ้าโอนเงินไปแล้ว ห้ามยกเลิก ให้แนบสลิปแทน', confirmText: 'ยกเลิกรายการ', cancelText: 'ไม่ยกเลิก', danger: true });
    if (!yes) return;
    withLoading(el, async () => {
      try {
        await api.post(`/api/deposits/${encodeURIComponent(id)}/cancel`, {}, { timeout: CREATE_TIMEOUT_MS });
        toast('ยกเลิกรายการแล้ว', 'success');
        clearTimeout(timer);
        await load();
      } catch (err) {
        toastError(err);
        if (err.code === 'NETWORK') load({ quiet: true });
      }
    });
  });

  await load();
}
