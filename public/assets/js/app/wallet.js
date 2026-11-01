// กระเป๋าเงิน: ยอดคงเหลือ, เติมเงินเข้ากระเป๋า (พร้อมเพย์ / โอนบัญชี + แนบสลิป), ประวัติเติมเงิน, รายการเดินบัญชี
import { html, raw, api, on, setHTML, baht, dateTime, withLoading, toast, toastError, navigate, compressImage, copyText, confirmDialog } from '../lib.js';
import { state, refreshUser } from './state.js';
import { icon } from './icons.js';
import { pageHead, emptyState, pager, alertBox, bahtEmphasis } from './ui.js';

const DEP_STATUS = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: '',
};
const depBadge = (d) => html`<span class="badge ${DEP_STATUS[d.status] || ''}">${d.status === 'pending' && !d.has_slip ? 'รอแนบสลิป' : d.status_label}</span>`;
const methodLabel = (m) => (m === 'promptpay' ? 'พร้อมเพย์' : 'โอนบัญชี');

export async function walletPage(ctx) {
  const s = state.catalog.settings;
  const q = ctx.query;
  await refreshUser();
  if (!ctx.alive() || !state.user) return; // เซสชันหมดอายุ → ระบบพาไปหน้าเข้าสู่ระบบ
  const u = state.user;
  const methods = [];
  if (s.promptpay_enabled) methods.push({ v: 'promptpay', l: 'พร้อมเพย์', sub: 'สแกน QR ด้วยแอปธนาคาร', icon: 'qr' });
  if (s.bank_accounts) methods.push({ v: 'bank', l: 'โอนเข้าบัญชี', sub: 'โอนแล้วแนบสลิป', icon: 'bank' });
  const presets = [100, 300, 500, 1000].filter((v) => v >= s.deposit_min_baht && v <= s.deposit_max_baht);
  const wanted = /^\d+$/.test(q.amount || '') ? Math.min(Math.max(Number(q.amount), s.deposit_min_baht), s.deposit_max_baht) : null;
  const st = { amount: wanted, method: methods[0]?.v || null, tab: q.tab === 'ledger' ? 'ledger' : 'deposits', page: 1 };

  setHTML(ctx.view, html`
    ${pageHead('กระเป๋าเงิน', 'เติมเงินเข้ากระเป๋าครั้งเดียว ใช้เติมมือถือและซื้อแพ็กเกจได้ทันที')}
    <div class="wallet-layout">
      <section class="wallet-card">
        <div class="small wallet-muted">ยอดเงินคงเหลือ</div>
        <div class="wallet-amount num">฿${baht(u.balance)}</div>
        <div class="wallet-actions">
          <a class="btn sm wallet-btn" href="#/topup">${icon('bolt', 16)} เติมเงินมือถือ</a>
          <a class="btn sm wallet-btn" href="#/packages">${icon('wifi', 16)} แพ็กเกจเน็ต</a>
        </div>
      </section>
      <section class="card">
        <h3 class="mb-2">เติมเงินเข้ากระเป๋า</h3>
        ${wanted ? html`<div class="mb-2">${alertBox('warning', html`ยอดเงินไม่พอสำหรับรายการที่ทำ แนะนำให้เติมอย่างน้อย <b>฿${wanted.toLocaleString('th-TH')}</b>`)}</div>` : ''}
        ${!methods.length ? alertBox('danger', 'ร้านยังไม่ได้ตั้งค่าช่องทางรับเงิน กรุณาติดต่อผู้ดูแลระบบ') : html`
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
    const setAmount = (v) => {
      st.amount = v;
      form.querySelectorAll('[data-amount]').forEach((b) => b.classList.toggle('active', Number(b.dataset.amount) === v));
      form.querySelector('.field.has-error')?.classList.remove('has-error');
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
    on(form, 'change', 'input[name="method"]', (e, el) => {
      st.method = el.value;
      form.querySelectorAll('.method-card').forEach((c) => c.classList.toggle('active', c.contains(el)));
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
      const btn = form.querySelector('[type="submit"]');
      withLoading(btn, async () => {
        try {
          const d = await api.post('/api/deposits', { amount: st.amount, method: st.method, note: form.querySelector('#depNote').value.trim() || undefined });
          navigate(`/deposit/${d.deposit.id}`);
        } catch (er) {
          if (er.details?.field === 'amount') {
            field.classList.add('has-error');
            field.querySelector('.error-text').textContent = er.message;
          }
          toastError(er);
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
      if (ctx.alive()) setHTML(body, emptyState('alert', 'โหลดข้อมูลไม่สำเร็จ', err.message));
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
  await loadTab();
}

export async function depositPage(ctx) {
  const id = ctx.params.id;
  const s = state.catalog.settings;
  let timer = null;
  let slip = null;
  let lastStatus = null;
  // รอแอดมินตรวจอาจนานหลายชั่วโมง → เช็กอัตโนมัติไม่เกิน 30 นาที (และไม่เช็กตอนแท็บถูกซ่อน) จากนั้นกด "ตรวจสอบสถานะ" เอง
  const MAX_DEP_POLL_MS = 30 * 60 * 1000;
  let pollStarted = Date.now();
  ctx.onLeave(() => clearTimeout(timer));
  const schedule = (ms) => {
    clearTimeout(timer);
    if (Date.now() - pollStarted > MAX_DEP_POLL_MS) return;
    timer = setTimeout(() => (document.hidden ? schedule(ms) : load({ quiet: true })), ms);
  };

  async function load({ quiet = false } = {}) {
    let d;
    try {
      d = await api.get(`/api/deposits/${encodeURIComponent(id)}`);
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

  function render({ deposit: dep, qr }) {
    slip = null;
    const head = pageHead(`เติมเงินเข้ากระเป๋า #${dep.id}`, `สร้างเมื่อ ${dateTime(dep.created_at)} · ${methodLabel(dep.method)}`, depBadge(dep));
    if (dep.status === 'approved') {
      setHTML(ctx.view, html`${head}<section class="card status-card success"><div class="status-hero">
        <div class="status-icon success">${icon('check', 46)}</div>
        <h1 class="status-title">เติมเงินเข้ากระเป๋าสำเร็จ</h1>
        <div class="status-amount num">฿${baht(dep.credited_amount ?? dep.amount)}</div>
        <p class="status-sub">ตรวจสอบเมื่อ ${dateTime(dep.reviewed_at)}${dep.admin_note ? ` · ${dep.admin_note}` : ''}</p>
      </div><div class="status-actions"><a class="btn primary" href="#/topup">${icon('bolt', 18)} เติมเงินมือถือ</a><a class="btn" href="#/wallet">กลับไปกระเป๋าเงิน</a></div></section>`);
      return;
    }
    if (dep.status === 'rejected' || dep.status === 'cancelled') {
      setHTML(ctx.view, html`${head}<section class="card status-card failed"><div class="status-hero">
        <div class="status-icon failed">${icon('x', 46)}</div>
        <h1 class="status-title">${dep.status === 'rejected' ? 'ไม่อนุมัติรายการนี้' : 'ยกเลิกรายการแล้ว'}</h1>
        <div class="status-amount num">฿${baht(dep.amount)}</div>
        ${dep.admin_note ? html`<p class="status-sub">เหตุผล: ${dep.admin_note}</p>` : ''}
        ${dep.status === 'rejected' ? html`<p class="small muted">หากโอนเงินแล้วแต่ไม่ได้รับการอนุมัติ กรุณาติดต่อผู้ดูแล${s.support_line ? ` (LINE: ${s.support_line})` : ''}</p>` : ''}
      </div><div class="status-actions"><a class="btn primary" href="#/wallet">${icon('plus', 18)} สร้างรายการใหม่</a></div></section>`);
      return;
    }
    const amountText = (dep.amount / 100).toFixed(2);
    setHTML(ctx.view, html`${head}
      <div class="deposit-layout">
        <section class="card">
          <div class="step-title"><span class="step-no">1</span>โอนเงินตามยอดนี้ (ให้ตรงทุกสตางค์)</div>
          <div class="transfer-amount">
            <div class="small muted">ยอดที่ต้องโอน</div>
            <div class="amt">${bahtEmphasis(dep.amount)}</div>
            <button type="button" class="btn sm soft" data-copy="${amountText}">${icon('copy', 16)} คัดลอกยอด ${amountText}</button>
          </div>
          <p class="small text-2 mt-2 row top" style="--gap:6px">${icon('alert', 16)}<span>กรุณาโอน <b>${amountText} บาท</b> ให้ตรงทุกสตางค์ (รวมเศษสตางค์ .${String(dep.amount % 100).padStart(2, '0')}) เพื่อให้ตรวจสอบได้รวดเร็วและไม่สลับกับรายการของคนอื่น</span></p>
          ${dep.method === 'promptpay' && qr ? html`<div class="qr-box">
            <div class="qr-head">พร้อมเพย์ · PromptPay</div>
            <div class="qr-svg">${raw(qr.svg)}</div>
            ${qr.name ? html`<div class="bold">${qr.name}</div>` : ''}
            <div class="xsmall muted center">สแกนด้วยแอปธนาคารใดก็ได้ · ยอดถูกใส่ใน QR ให้แล้ว</div>
          </div>` : ''}
          ${(dep.method === 'bank' || !qr) && s.bank_accounts ? html`<div class="mt-2"><div class="label mb-1">บัญชีสำหรับโอน</div><div class="bank-text">${s.bank_accounts}</div></div>` : ''}
        </section>
        <section class="card">
          <div class="step-title"><span class="step-no">2</span>แนบสลิปการโอน</div>
          ${dep.has_slip ? html`<div class="mb-2">${alertBox('success', html`<b>ได้รับสลิปแล้ว</b> กำลังรอเจ้าหน้าที่ตรวจสอบ — หน้านี้จะอัปเดตอัตโนมัติเมื่ออนุมัติ<div class="xsmall muted mt-1">แนบสลิปใหม่ได้ถ้าส่งรูปผิด</div>
            <div class="mt-1"><button type="button" class="btn sm" data-dep-refresh>${icon('refresh', 16)} ตรวจสอบสถานะ</button></div>`)}</div>` : ''}
          <form data-slip-form novalidate>
            <label class="upload-drop">
              <input type="file" accept="image/png,image/jpeg,image/webp" data-file>
              <span class="upload-icon">${icon('upload', 26)}</span>
              <span class="bold">แตะเพื่อเลือกรูปสลิป</span>
              <span class="xsmall muted">JPG / PNG / WEBP — ระบบย่อรูปให้อัตโนมัติ</span>
            </label>
            <img class="slip-preview hidden" data-preview alt="ตัวอย่างสลิป">
            <div class="field mt-2">
              <label for="transferAt">เวลาที่โอน (ไม่บังคับ)</label>
              <input class="input" type="datetime-local" id="transferAt" name="transferAt">
            </div>
            <div data-slip-err></div>
            <button class="btn primary block mt-2" type="submit" data-send disabled data-loading-text="กำลังส่งสลิป...">${icon('upload', 18)} ส่งสลิปให้ตรวจสอบ</button>
          </form>
          <hr>
          ${dep.has_slip
            // แนบสลิปแล้ว = แจ้งว่าโอนแล้ว → ระบบไม่ให้ยกเลิกเอง (กันยกเลิกทั้งที่เงินเข้าบัญชีร้านแล้ว)
            ? html`<p class="xsmall muted center mb-0">แนบสลิปแล้ว ยกเลิกรายการเองไม่ได้ — หากแนบผิดหรือยังไม่ได้โอนเงิน กรุณาติดต่อผู้ดูแล${s.support_line ? ` (LINE: ${s.support_line})` : ''}</p>`
            : html`<button type="button" class="btn ghost block text-danger" data-cancel>${icon('x', 18)} ยกเลิกรายการนี้</button>`}
        </section>
      </div>`);

    const form = ctx.view.querySelector('[data-slip-form]');
    const file = form.querySelector('[data-file]');
    const preview = form.querySelector('[data-preview]');
    const send = form.querySelector('[data-send]');
    const slipErr = form.querySelector('[data-slip-err]');
    file.addEventListener('change', async () => {
      slip = null;
      send.disabled = true;
      setHTML(slipErr, '');
      const f = file.files?.[0];
      if (!f) { preview.classList.add('hidden'); return; }
      try {
        slip = await compressImage(f);
        preview.src = slip;
        preview.classList.remove('hidden');
        send.disabled = false;
      } catch (err) {
        toastError(err);
        file.value = '';
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!slip) { toast('กรุณาเลือกรูปสลิปก่อน', 'warning'); return; }
      const t = form.querySelector('#transferAt').value;
      setHTML(slipErr, '');
      withLoading(send, async () => {
        try {
          await api.post(`/api/deposits/${dep.id}/slip`, { image: slip, transferAt: t ? new Date(t).toISOString() : undefined });
          toast('ส่งสลิปแล้ว รอเจ้าหน้าที่ตรวจสอบ', 'success');
          clearTimeout(timer);
          pollStarted = Date.now();
          await load();
        } catch (err) {
          // เช่น SLIP_USED (สลิปนี้ใช้ไปแล้ว / แนบกับรายการอื่นอยู่) — แสดงค้างไว้ในฟอร์มให้อ่านชัด
          if (err.code === 'SLIP_USED' || err.details?.field) setHTML(slipErr, html`<div class="mt-2">${alertBox('danger', err.message)}</div>`);
          else toastError(err);
        }
      });
    });
  }

  on(ctx.view, 'click', '[data-copy]', (e, el) => copyText(el.dataset.copy));
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
        await api.post(`/api/deposits/${encodeURIComponent(id)}/cancel`);
        toast('ยกเลิกรายการแล้ว', 'success');
        clearTimeout(timer);
        await load();
      } catch (err) {
        toastError(err);
      }
    });
  });

  await load();
}
