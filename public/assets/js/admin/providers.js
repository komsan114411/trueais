// ผู้ให้บริการ & ร้าน: สถานะแต่ละเจ้า + การเลือก/สลับเจ้า, ราคาของแต่ละร้าน, จับคู่บริการ (ผู้ให้บริการแบบราคาคงที่ เช่น HubZell)
import {
  html, raw, api, baht, dateTimeSec, timeAgo, netBadge, modal, confirmDialog, toast, toastError, withLoading, on, qs, copyText,
  showFieldError, clearFieldErrors,
} from '../lib.js';
import { icon, setQuery, emptyRow, networkOptions, store } from './common.js';

const sw = (name, checked, label) => html`<label class="switch"><input type="checkbox" name="${name}" ${checked ? raw('checked') : ''}><span class="track"></span><span class="small">${label}</span></label>`;
const money = (satang) => (satang === null || satang === undefined ? '-' : baht(satang));
/** ราคาขายเติมเงินหลังส่วนลด (สูตรเดียวกับเซิร์ฟเวอร์) */
const afterDiscount = (satang, bp) => satang - Math.floor((satang * Math.max(0, bp)) / 10000);
const BAHT_RE = /^\d{1,7}(\.\d{1,2})?$/;

// ───────────── แท็บ: ผู้ให้บริการ ─────────────

function balanceHtml(b) {
  if (!b) return html`<span class="muted">ยังไม่ได้เช็ก</span>`;
  return html`${b.balance !== null && b.balance !== undefined ? html`<b>฿${baht(b.balance)}</b>` : '-'}
    ${b.checked_at ? html`<span class="muted small">(${timeAgo(b.checked_at)})</span>` : ''}
    ${b.error ? html`<div class="small text-danger">${b.error}</div>` : ''}`;
}

function providerCard(p) {
  const br = p.breaker || {};
  const mapped = p.capabilities?.catalog === 'mapped';
  const status = !p.config?.ready ? html`<span class="badge danger">ตั้งค่าไม่ครบ</span>`
    : br.open ? html`<span class="badge danger">พักชั่วคราว</span>`
      : p.enabled ? html`<span class="badge success">พร้อมรับรายการ</span>` : html`<span class="badge">ปิดใช้ชั่วคราว</span>`;
  return html`<section class="card" data-provider="${p.name}">
    <div class="card-head">
      <h3>${p.label} <span class="muted mono small">(${p.name})</span></h3>
      <span class="row wrap" style="--gap:6px">${p.live ? html`<span class="mode-badge live">ใช้งานจริง</span>` : html`<span class="mode-badge mock">โหมดทดสอบ</span>`}${status}</span>
    </div>
    <dl class="dl">
      <dt>ลำดับการเลือก</dt><dd>${p.enabled ? `ลำดับที่ ${p.priority + 1}` : html`<span class="muted">ไม่ถูกเลือก (ปิดใช้ชั่วคราวในการตั้งค่าด้านล่าง)</span>`}</dd>
      <dt>รายการที่ขาย</dt><dd class="small">${mapped ? 'จับคู่บริการเอง (1 ยอด/แพ็กเกจ = 1 บริการราคาคงที่)' : 'ใช้ยอดเติม/แพ็กเกจหลักของระบบ'}</dd>
      <dt>เครดิตคงเหลือ</dt><dd>${balanceHtml(p.balance)}</dd>
      ${p.mappings ? html`<dt>การจับคู่</dt><dd>เปิดใช้ ${p.mappings.enabled} / ${p.mappings.total} รายการ · <a href="#/providers?tab=map:${p.name}">จัดการการจับคู่</a></dd>` : ''}
      <dt>เชื่อมต่อล้มเหลวติดกัน</dt><dd>${br.consecutiveFailures || 0} ครั้ง${br.lastError ? html`<div class="small text-2">ล่าสุด: ${br.lastError}</div>` : ''}</dd>
    </dl>
    ${br.open ? html`<div class="alert danger mt-2"><span class="alert-icon">!</span><div><b>พักรับรายการชั่วคราว</b>${br.reason ? ` — ${br.reason}` : ''}
      <div class="small">จะเปิดรับเองเวลา ${dateTimeSec(br.openUntil)} · ระหว่างนี้รายการใหม่ไปเจ้าสำรอง (ถ้ามี)</div></div></div>` : ''}
    ${p.config && !p.config.ready ? html`<div class="alert danger mt-2"><span class="alert-icon">!</span><div><b>สิ่งที่ยังขาด:</b>
      <ul class="check-list small">${(p.config.missing || []).map((m) => html`<li>${m}</li>`)}</ul><div class="small mt-1">แก้ไฟล์ .env แล้วรีสตาร์ทระบบ</div></div></div>` : ''}
    ${p.callback_url ? html`<div class="mt-2"><div class="code-label">Callback URL</div>
      <div class="copy-field"><code style="white-space:normal;word-break:break-all">${p.callback_url}</code><button type="button" class="btn sm" data-copy="${p.callback_url}">${icon('copy')}คัดลอก</button></div>
      <div class="small text-danger mt-1">ให้นำ URL นี้ทั้งเส้นไปตั้งที่ผู้ให้บริการ (มีรหัสลับ ห้ามเผยแพร่)</div></div>` : ''}
    <div class="row wrap mt-2">
      ${p.capabilities?.balance ? html`<button type="button" class="btn sm" data-balance="${p.name}">${icon('refresh')}เช็กเครดิต</button>` : ''}
      <button type="button" class="btn sm" data-reset="${p.name}" ${br.open || br.consecutiveFailures ? '' : raw('disabled')}>${icon('bolt')}เปิดใช้อีกครั้ง / รีเซ็ตการพัก</button>
      ${mapped ? html`<a class="btn sm" href="#/providers?tab=map:${p.name}">${icon('table')}จับคู่บริการ</a>` : ''}
    </div>
    ${p.live ? '' : html`<form class="row mt-2" data-mock="${p.name}">
      <input class="input" name="amount" inputmode="decimal" placeholder="จำนวนบาท" value="10000" style="max-width:160px">
      <button class="btn sm" type="submit">${icon('plus')}เติมเครดิตจำลอง</button></form>`}
  </section>`;
}

const ROUTING_KEYS = ['routing_mode', 'failover_enabled', 'provider_priority', 'providers_disabled'];

function routingForm(view, values, fields) {
  const f = Object.fromEntries(fields.filter((x) => ROUTING_KEYS.includes(x.key)).map((x) => [x.key, x]));
  const names = view.providers.map((p) => p.name).join(', ');
  const r = view.routing || {};
  return html`<form class="card stack" data-routing novalidate>
    <div class="card-head"><h3>การเลือกผู้ให้บริการ</h3>
      <span class="small muted">ตอนนี้: ${r.mode === 'cheapest' ? 'ต้นทุนต่ำสุดก่อน' : 'ตามลำดับ'} · สลับอัตโนมัติ ${r.failover ? 'เปิด' : 'ปิด'} · ลำดับ ${(r.order || []).join(' → ') || '-'}</span></div>
    <div class="form-grid">
      <div class="field"><label>${f.routing_mode?.label || 'วิธีเลือกผู้ให้บริการ'}</label>
        <select class="select" name="routing_mode">${(f.routing_mode?.options || [{ value: 'priority', label: 'ตามลำดับ' }, { value: 'cheapest', label: 'ต้นทุนต่ำสุดก่อน' }])
          .map((o) => html`<option value="${o.value}" ${values.routing_mode === o.value ? raw('selected') : ''}>${o.label}</option>`)}</select></div>
      <div class="field"><label>${f.failover_enabled?.label || 'สลับไปผู้ให้บริการสำรองอัตโนมัติ'}</label>
        ${sw('failover_enabled', values.failover_enabled, values.failover_enabled ? 'เปิด' : 'ปิด')}
        ${f.failover_enabled?.help ? html`<div class="help">${f.failover_enabled.help}</div>` : ''}</div>
      <div class="field"><label>${f.provider_priority?.label || 'ลำดับผู้ให้บริการ'}</label>
        <input class="input mono" name="provider_priority" value="${values.provider_priority || ''}" placeholder="${names}" maxlength="200">
        <div class="help">${f.provider_priority?.help || ''} · ชื่อที่ใช้ได้: ${names}</div><div class="error-text"></div></div>
      <div class="field"><label>${f.providers_disabled?.label || 'ปิดใช้ผู้ให้บริการชั่วคราว'}</label>
        <input class="input mono" name="providers_disabled" value="${values.providers_disabled || ''}" placeholder="เว้นว่าง = เปิดใช้ทุกเจ้า" maxlength="200">
        <div class="help">${f.providers_disabled?.help || ''}</div><div class="error-text"></div></div>
    </div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">บันทึกการเลือกผู้ให้บริการ</button></div>
  </form>`;
}

async function providersTab(box, reload) {
  const [view, settings] = await Promise.all([api.get('/api/admin/providers'), api.get('/api/admin/settings')]);
  box.innerHTML = html`
    <div class="net-cards">${view.providers.map(providerCard)}</div>
    ${routingForm(view, settings.values, settings.schema.fields)}`.toString();

  const form = box.querySelector('[data-routing]');
  form.addEventListener('change', (e) => {
    if (e.target.name === 'failover_enabled') e.target.closest('.switch').querySelector('.small').textContent = e.target.checked ? 'เปิด' : 'ปิด';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    const next = {
      routing_mode: form.querySelector('[name="routing_mode"]').value,
      failover_enabled: form.querySelector('[name="failover_enabled"]').checked,
      provider_priority: form.querySelector('[name="provider_priority"]').value.trim().toLowerCase().replace(/\s+/g, ''),
      providers_disabled: form.querySelector('[name="providers_disabled"]').value.trim().toLowerCase().replace(/\s+/g, ''),
    };
    const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== (settings.values[k] ?? (typeof v === 'boolean' ? false : ''))));
    if (!Object.keys(changed).length) { toast('ยังไม่มีการแก้ไข', 'info'); return; }
    withLoading(form.querySelector('[type="submit"]'), async () => {
      try {
        // ปิดใช้บางเจ้า / ปิดการสลับอัตโนมัติ → ยืนยันก่อน (รายการใหม่จะไม่ไปเจ้านั้น / ไม่มีเจ้าสำรอง)
        if ('providers_disabled' in changed || changed.failover_enabled === false) {
          const ok = await confirmDialog({
            title: 'ยืนยันเปลี่ยนการเลือกผู้ให้บริการ',
            body: `${'providers_disabled' in changed ? `ปิดใช้ชั่วคราว: ${changed.providers_disabled || '(ไม่มี — เปิดใช้ทุกเจ้า)'} ` : ''}${changed.failover_enabled === false ? '· ปิดการสลับไปเจ้าสำรองอัตโนมัติ (ถ้าเจ้าที่เลือกไม่รับรายการ รายการจะไม่สำเร็จและคืนเงิน)' : ''} — มีผลกับรายการใหม่ทันที`,
            confirmText: 'บันทึก',
            danger: true,
          });
          if (!ok) return;
        }
        await api.put('/api/admin/settings', changed);
        toast('บันทึกการเลือกผู้ให้บริการแล้ว', 'success');
        store.refresh().catch(() => {});
        await reload();
      } catch (err) {
        if (!showFieldError(form, err)) toastError(err);
      }
    });
  });

  on(box, 'click', '[data-copy]', (e, b) => copyText(b.dataset.copy));
  on(box, 'click', '[data-balance]', (e, b) => withLoading(b, async () => {
    try {
      const r = await api.post(`/api/admin/providers/${encodeURIComponent(b.dataset.balance)}/refresh-balance`);
      if (r?.error) toast(`เช็กเครดิตไม่สำเร็จ: ${r.error}`, 'error', 6000);
      else toast(`เครดิตคงเหลือ ฿${money(r?.balance)}`, 'success');
      store.refresh().catch(() => {});
      await reload();
    } catch (err) { toastError(err); }
  }));
  on(box, 'click', '[data-reset]', async (e, b) => {
    const p = view.providers.find((x) => x.name === b.dataset.reset);
    if (!p) return;
    const ok = await confirmDialog({
      title: `เปิดรับรายการ ${p.label} อีกครั้ง`,
      body: `${p.breaker?.reason ? `เหตุที่พัก: ${p.breaker.reason}${p.breaker.lastError ? ` (${p.breaker.lastError})` : ''} — ` : ''}เปิดใช้เมื่อแก้ปัญหาแล้วเท่านั้น (เช่น เติมเครดิต / แก้ key / KYC / IP whitelist) ถ้ายังไม่ได้แก้ ระบบจะส่งรายการแล้วล้มเหลวซ้ำ และผู้ให้บริการอาจบล็อกการเชื่อมต่อ`,
      confirmText: 'เปิดรับรายการ',
      danger: true,
    });
    if (!ok) return;
    withLoading(b, async () => {
      try {
        await api.post(`/api/admin/providers/${encodeURIComponent(p.name)}/reset-breaker`);
        toast(`เปิดรับรายการ ${p.label} แล้ว`, 'success');
        store.refresh().catch(() => {});
        await reload();
      } catch (err) { toastError(err); }
    });
  });
  box.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-mock]');
    if (!f) return;
    e.preventDefault();
    const amount = f.querySelector('[name="amount"]').value.trim().replace(/,/g, '');
    if (!BAHT_RE.test(amount) || !(Number(amount) > 0)) { toast('จำนวนเงินไม่ถูกต้อง (ตัวเลขมากกว่า 0)', 'error'); return; }
    withLoading(f.querySelector('[type="submit"]'), async () => {
      try {
        const ok = await confirmDialog({ title: 'เติมเครดิตจำลอง', body: `เพิ่มเครดิตจำลองให้ ${f.dataset.mock} ${Number(amount).toLocaleString('th-TH', { maximumFractionDigits: 2 })} บาท? (โหมดทดสอบ ไม่มีผลกับเงินจริง)`, confirmText: 'เติมเครดิตจำลอง' });
        if (!ok) return;
        await api.post('/api/admin/provider/mock-credit', { amount, provider: f.dataset.mock });
        toast('เติมเครดิตจำลองแล้ว', 'success');
        await reload();
      } catch (err) { toastError(err); }
    });
  });
}

// ───────────── แท็บ: ราคาแต่ละร้าน ─────────────

function shopForm(s) {
  return html`<form class="card stack" data-shop="${s.code}" novalidate>
    <div class="card-head"><h3>${s.name} <span class="muted small">(${s.label})</span></h3>
      <span class="row wrap" style="--gap:6px">${s.visible ? html`<span class="badge success">ลูกค้าเห็นร้านนี้</span>` : html`<span class="badge">ลูกค้าไม่เห็น (ปิดใช้/ตั้งค่าไม่ครบ)</span>`}
      ${s.mapped ? html`<span class="badge warning plain">ขายเฉพาะยอดที่จับคู่</span>` : ''}</span></div>
    <div class="field"><label>ชื่อร้านที่ลูกค้าเห็น</label>
      <input class="input" name="display_name" maxlength="40" value="${s.display_name || ''}" placeholder="${s.default_name}">
      <div class="help">เว้นว่าง = ใช้ชื่อ "${s.default_name}"</div><div class="error-text"></div></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>เครือข่าย</th><th>ส่วนลดลูกค้า (%)</th><th>ใช้ค่ามาตรฐาน</th><th>สูงสุดที่ไม่ขาดทุน</th>${s.mapped ? html`<th>ยอดที่ขายได้ (บาท)</th>` : ''}</tr></thead>
      <tbody>${s.networks.map((n) => html`<tr data-net-row="${n.code}">
        <td>${netBadge(n.code, n.name)}</td>
        <td><input class="input" type="number" name="pct_${n.code}" min="0" max="100" step="0.01" value="${n.discount_percent}" ${n.custom ? '' : raw('disabled')} style="max-width:120px">
          <div class="small text-danger hidden" data-over="${n.code}">เกินสูงสุด ${n.max_percent}% — ระบบจะไม่ให้บันทึก (ขาดทุน)</div></td>
        <td><label class="check"><input type="checkbox" name="inherit_${n.code}" ${n.custom ? '' : raw('checked')}>มาตรฐาน (${n.default_percent}%)</label></td>
        <td class="small">${n.max_percent}%</td>
        ${s.mapped ? html`<td class="small">${n.amounts?.length ? n.amounts.join(', ') : html`<span class="text-danger">ยังไม่มี (จับคู่ + เปิดใช้ก่อน)</span>`}</td>` : ''}
      </tr>`)}</tbody>
    </table></div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">บันทึก ${s.name}</button></div>
  </form>`;
}

async function shopsTab(box, reload) {
  const shops = await api.get('/api/admin/shops');
  box.innerHTML = html`<p class="small muted">ลูกค้าเลือกร้านได้เอง (1 ร้าน = ผู้ให้บริการ 1 เจ้า) · ตั้งส่วนลดให้ลูกค้าแยกตามเครือข่าย — ไม่ตั้ง = ใช้ส่วนลดมาตรฐานของเครือข่าย (หน้า สินค้า &amp; เครือข่าย) · ถ้าร้านที่ลูกค้าเลือกไม่รับรายการ ระบบส่งต่อร้านอื่นในราคาเดิม (เฉพาะร้านที่ไม่ขาดทุน)</p>
    ${shops.length ? html`<div class="stack">${shops.map(shopForm)}</div>` : html`<div class="card"><div class="empty">ยังไม่มีร้าน</div></div>`}`.toString();

  on(box, 'change', 'input[name^="inherit_"]', (e, cb) => {
    const form = cb.closest('[data-shop]');
    const s = shops.find((x) => x.code === form.dataset.shop);
    const code = cb.name.slice('inherit_'.length);
    const input = form.querySelector(`[name="pct_${CSS.escape(code)}"]`);
    input.disabled = cb.checked;
    if (cb.checked) input.value = s.networks.find((n) => n.code === code)?.default_percent ?? 0;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  on(box, 'input', 'input[name^="pct_"]', (e, input) => {
    const form = input.closest('[data-shop]');
    const s = shops.find((x) => x.code === form.dataset.shop);
    const code = input.name.slice('pct_'.length);
    const n = s.networks.find((x) => x.code === code);
    form.querySelector(`[data-over="${CSS.escape(code)}"]`)?.classList.toggle('hidden', input.disabled || !(Number(input.value) > n.max_percent));
  });

  box.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-shop]');
    if (!form) return;
    e.preventDefault();
    clearFieldErrors(form);
    const s = shops.find((x) => x.code === form.dataset.shop);
    const body = {};
    const lines = [];
    const display = form.querySelector('[name="display_name"]').value.trim();
    if (display !== (s.display_name || '')) { body.display_name = display; lines.push(`ชื่อร้าน: ${display || `(ใช้ชื่อเดิม ${s.default_name})`}`); }
    const networks = {};
    for (const n of s.networks) {
      const inherit = form.querySelector(`[name="inherit_${CSS.escape(n.code)}"]`).checked;
      const raw_ = form.querySelector(`[name="pct_${CSS.escape(n.code)}"]`).value.trim();
      if (inherit) {
        if (n.custom) { networks[n.code] = { inherit: true }; lines.push(`${n.name}: ใช้ค่ามาตรฐาน (${n.default_percent}%)`); }
        continue;
      }
      const pct = Number(raw_);
      if (raw_ === '' || !Number.isFinite(pct) || pct < 0 || pct > 100) { toast(`ส่วนลด ${n.name} ต้องเป็นตัวเลข 0 - 100`, 'error'); return; }
      if (!n.custom || pct !== n.discount_percent) { networks[n.code] = { discount_percent: pct }; lines.push(`${n.name}: ส่วนลด ${pct}%${pct > n.max_percent ? ' (เกินสูงสุด — จะขาดทุน)' : ''}`); }
    }
    if (Object.keys(networks).length) body.networks = networks;
    if (!lines.length) { toast('ยังไม่มีการแก้ไข', 'info'); return; }
    withLoading(form.querySelector('[type="submit"]'), async () => {
      try {
        const ok = await confirmDialog({ title: `บันทึกราคา ${s.name}`, body: `${lines.join(' · ')} — มีผลกับราคาที่ลูกค้าเห็นทันที`, confirmText: 'บันทึก' });
        if (!ok) return;
        await api.put(`/api/admin/shops/${encodeURIComponent(s.code)}`, body);
        toast(`บันทึก ${s.name} แล้ว`, 'success');
        await reload();
      } catch (err) {
        if (!showFieldError(form, err)) toastError(err);
      }
    });
  });
}

// ───────────── แท็บ: จับคู่บริการ (ผู้ให้บริการแบบราคาคงที่) ─────────────

const kindLabel = (k) => (k === 'package' ? 'แพ็กเกจ' : 'เติมเงิน');

function mappingsTable(maps) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>ประเภท</th><th>เครือข่าย</th><th>ยอด / แพ็กเกจของเรา</th><th>บริการของผู้ให้บริการ</th><th class="num">ต้นทุน</th><th class="num">ราคาขาย</th><th class="num">กำไร</th><th>เปิดใช้</th><th></th></tr></thead>
    <tbody>${maps.length ? maps.map((m) => html`<tr class="${m.loss ? 'row-review' : ''}">
      <td class="small">${kindLabel(m.kind)}</td>
      <td>${netBadge(m.network_code, m.network_name)}</td>
      <td>${m.kind === 'topup' ? html`<b>${money(m.face_value)}</b> บาท` : html`${m.product_name || '-'} <span class="muted small">#${m.product_id}</span>`}</td>
      <td class="small"><span class="mono">${m.service_id}</span>${m.service_name ? html`<span class="sub">${m.service_product ? `${m.service_product} · ` : ''}${m.service_name}</span>` : ''}</td>
      <td class="num">${money(m.cost)}</td>
      <td class="num">${money(m.sell_price)}</td>
      <td class="num">${m.loss ? html`<span class="flag">ขาดทุน ${money(-m.profit)}</span>` : money(m.profit)}</td>
      <td><label class="switch" title="เปิด/ปิดการจับคู่นี้"><input type="checkbox" data-map-enable="${m.id}" ${m.enabled ? raw('checked') : ''}><span class="track"></span></label></td>
      <td class="actions"><button type="button" class="btn ghost sm icon" data-map-del="${m.id}" title="ลบการจับคู่" aria-label="ลบการจับคู่">${icon('trash')}</button></td>
    </tr>`) : emptyRow(9, 'ยังไม่มีการจับคู่ — เลือก "จับคู่" จากตารางบริการด้านล่าง')}</tbody></table></div>`;
}

function catalogRows(rows) {
  return rows.length ? rows.map((r) => html`<tr data-row="${r.service_id}">
    <td class="mono small">${r.service_id}</td>
    <td class="small"><b>${r.product_name || '-'}</b><span class="sub">${r.service_name || ''}</span></td>
    <td class="num">${money(r.price)}</td>
    <td class="small">${r.supported ? html`<span class="badge success plain">ใช้ได้</span>` : html`<span class="text-danger">${r.unsupported_reason || 'ใช้ไม่ได้'}</span>`}</td>
    <td class="small mono">${r.phone_format || '-'}</td>
    <td class="small">${r.mapping_ids?.length ? html`<span class="badge primary plain">จับคู่แล้ว ${r.mapping_ids.length}</span>` : html`<span class="muted">-</span>`}</td>
    <td class="actions">${r.supported ? html`<button type="button" class="btn sm" data-map="${r.service_id}">จับคู่</button>
      <button type="button" class="btn ghost sm" data-new-product="${r.service_id}">สร้างเป็นแพ็กเกจใหม่</button>` : ''}</td>
  </tr>`) : emptyRow(7, 'ไม่พบบริการ');
}

function gapsHtml(gaps) {
  if (!gaps?.length) return '';
  const by = {};
  for (const g of gaps) (by[g.network_code] ||= []).push(g.amount);
  return html`<div class="alert warning mt-2"><span class="alert-icon">!</span><div><b>ยอดที่ลูกค้าเลือกได้แต่ร้านนี้ยังไม่มีบริการ</b> (ร้านนี้จะขายยอดเหล่านี้ไม่ได้ จนกว่าจะจับคู่และเปิดใช้)
    <ul class="check-list small">${Object.entries(by).map(([code, list]) => html`<li>${code}: ${list.join(', ')} บาท</li>`)}</ul></div></div>`;
}

function syncSummary(r) {
  return html`<div class="alert ${r.disabled?.length ? 'danger' : 'success'} mt-2"><span class="alert-icon">${r.disabled?.length ? '!' : '✓'}</span><div class="grow">
    <b>ดึงรายการแล้ว</b> — บริการทั้งหมด ${r.services} · ใช้กับระบบได้ ${r.supported} · สินค้า ${r.products}
    ${r.disabled?.length ? html`<div class="mt-1"><b>ปิดการจับคู่อัตโนมัติ ${r.disabled.length} รายการ</b> (บริการหาย/ใช้ไม่ได้/ต้นทุนสูงกว่าราคาขาย) — ตรวจแล้วจับคู่ใหม่<ul class="check-list small">${r.disabled.map((x) => html`<li>${x}</li>`)}</ul></div>` : ''}
    ${r.cost_changed?.length ? html`<div class="mt-1"><b>ต้นทุนเปลี่ยน ${r.cost_changed.length} รายการ</b><ul class="check-list small">${r.cost_changed.map((x) => html`<li>${x}</li>`)}</ul></div>` : ''}
    ${r.errors?.length ? html`<div class="mt-1 text-danger"><b>ดึงรายละเอียดไม่สำเร็จ ${r.errors.length} รายการ</b><ul class="check-list small">${r.errors.map((x) => html`<li>${x}</li>`)}</ul></div>` : ''}
  </div></div>`;
}

/** หน้าต่างจับคู่บริการ 1 รายการ กับยอดเติม/แพ็กเกจของเรา */
function mapDialog(name, row, shop) {
  const sugg = row.suggestion || {};
  const discountBp = (code) => Math.round((shop?.networks.find((n) => n.code === code)?.discount_percent || 0) * 100);
  return modal({
    title: `จับคู่บริการ ${row.service_id}`,
    wide: true,
    body: html`<form class="stack" data-form novalidate>
      <div class="small">บริการ <b class="mono">${row.service_id}</b> · ${row.product_name || ''} / ${row.service_name || ''} · ต้นทุน <b>${money(row.price)}</b> บาท</div>
      <div class="small text-2">ระบบเดาจากชื่อบริการให้แล้ว — กรุณาตรวจให้ถูกต้องก่อนบันทึก (จับคู่ผิด = ลูกค้าได้ยอด/แพ็กเกจไม่ตรงที่จ่าย)</div>
      <div class="form-grid">
        <div class="field"><label>ประเภท</label><select class="select" name="kind">
          <option value="topup" ${sugg.kind !== 'package' ? raw('selected') : ''}>เติมเงิน</option>
          <option value="package" ${sugg.kind === 'package' ? raw('selected') : ''}>แพ็กเกจ</option></select><div class="error-text"></div></div>
        <div class="field"><label>เครือข่าย</label><select class="select" name="network_code">${networkOptions(sugg.network_code || 'AIS', { all: false })}</select><div class="error-text"></div></div>
      </div>
      <div class="field" data-topup><label>ยอดเติม (บาท)</label><input class="input" name="face_value_baht" inputmode="numeric" value="${sugg.face_value ? sugg.face_value / 100 : ''}" placeholder="เช่น 100"><div class="error-text"></div></div>
      <div class="field hidden" data-package><label>แพ็กเกจในระบบ</label><select class="select" name="product_id"><option value="">กำลังโหลด...</option></select><div class="error-text"></div></div>
      <div class="calc small" data-preview></div>
      ${sw('enabled', false, 'เปิดใช้ทันที (ตรวจต้นทุน/ยอดแล้ว)')}
    </form>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary" data-ok>บันทึกการจับคู่</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-form]');
      const kindEl = form.querySelector('[name="kind"]');
      const netEl = form.querySelector('[name="network_code"]');
      const faceEl = form.querySelector('[name="face_value_baht"]');
      const prodEl = form.querySelector('[name="product_id"]');
      const preview = form.querySelector('[data-preview]');
      let products = [];
      let seq = 0;
      const loadProducts = async () => {
        const my = ++seq;
        prodEl.innerHTML = '<option value="">กำลังโหลด...</option>';
        try {
          const list = await api.get(`/api/admin/products${qs({ network: netEl.value })}`);
          if (my !== seq) return;
          products = list;
          prodEl.innerHTML = html`<option value="">— เลือกแพ็กเกจ —</option>${list.map((p) => html`<option value="${p.id}">#${p.id} ${p.name} · ขาย ${baht(p.price)} บาท${p.enabled ? '' : ' (ปิดขาย)'}</option>`)}`.toString();
        } catch (err) { toastError(err); }
        updPreview();
      };
      const updPreview = () => {
        const cost = row.price;
        let sell = null;
        if (kindEl.value === 'topup') {
          const v = faceEl.value.trim();
          if (/^\d{1,6}$/.test(v) && Number(v) > 0) sell = afterDiscount(Number(v) * 100, discountBp(netEl.value));
        } else {
          sell = products.find((p) => String(p.id) === prodEl.value)?.price ?? null;
        }
        if (sell === null || cost === null || cost === undefined) { preview.textContent = 'ระบุยอด/แพ็กเกจเพื่อดูราคาขายและกำไร'; return; }
        const profit = sell - cost;
        preview.innerHTML = html`ราคาขายที่ร้านนี้ <b>${baht(sell)}</b> บาท · ต้นทุน ${baht(cost)} · กำไร <b class="${profit < 0 ? 'text-danger' : ''}">${baht(profit)}</b> บาท${profit < 0 ? ' — ขาดทุน! เปิดใช้ไม่ได้' : ''}`.toString();
      };
      const syncKind = () => {
        const pkg = kindEl.value === 'package';
        form.querySelector('[data-topup]').classList.toggle('hidden', pkg);
        form.querySelector('[data-package]').classList.toggle('hidden', !pkg);
        if (pkg) loadProducts(); else updPreview();
      };
      kindEl.addEventListener('change', syncKind);
      netEl.addEventListener('change', () => (kindEl.value === 'package' ? loadProducts() : updPreview()));
      faceEl.addEventListener('input', () => { faceEl.value = faceEl.value.replace(/\D/g, '').slice(0, 6); updPreview(); });
      prodEl.addEventListener('change', updPreview);
      syncKind();
      const btn = dlg.querySelector('[data-ok]');
      const submit = (e) => {
        e?.preventDefault();
        clearFieldErrors(form);
        const kind = kindEl.value;
        const body = { service_id: row.service_id, kind, network_code: netEl.value, enabled: form.querySelector('[name="enabled"]').checked };
        if (kind === 'topup') {
          if (!/^\d{1,6}$/.test(faceEl.value) || !(Number(faceEl.value) > 0)) { showFieldError(form, { message: 'กรุณาระบุยอดเติมเป็นจำนวนเต็มบาท', details: { field: 'face_value_baht' } }); return; }
          body.face_value_baht = faceEl.value;
        } else {
          if (!prodEl.value) { showFieldError(form, { message: 'กรุณาเลือกแพ็กเกจในระบบที่ตรงกับบริการนี้', details: { field: 'product_id' } }); return; }
          body.product_id = Number(prodEl.value);
        }
        withLoading(btn, async () => {
          try {
            const m = await api.post(`/api/admin/providers/${encodeURIComponent(name)}/mappings`, body);
            toast(`บันทึกการจับคู่แล้ว${m.enabled ? ' (เปิดใช้)' : ' (ปิดไว้ — เปิดใช้ได้ที่ตารางการจับคู่)'}`, 'success', 5000);
            close(true);
          } catch (err) {
            if (!showFieldError(form, err)) toastError(err); // 400 = ขาดทุน / ข้อมูลไม่ถูกต้อง
          }
        });
      };
      form.addEventListener('submit', submit);
      btn.addEventListener('click', submit);
    },
  });
}

/** สร้างแพ็กเกจใหม่ในระบบจากบริการนี้ (ปิดขาย + จับคู่ปิดไว้ก่อน) */
function newProductDialog(name, row) {
  const sugg = row.suggestion || {};
  return modal({
    title: 'สร้างเป็นแพ็กเกจใหม่',
    body: html`<form class="stack" data-form novalidate>
      <div class="small">จากบริการ <b class="mono">${row.service_id}</b> · ${row.product_name || ''} / ${row.service_name || ''} · ต้นทุน <b>${money(row.price)}</b> บาท</div>
      <div class="form-grid">
        <div class="field"><label>เครือข่าย</label><select class="select" name="network_code">${networkOptions(sugg.network_code || 'AIS', { all: false })}</select><div class="error-text"></div></div>
        <div class="field"><label>ราคาขาย (บาท)</label><input class="input" name="price_baht" inputmode="decimal" placeholder="0.00"><div class="help">ต้องไม่ต่ำกว่าต้นทุน ${money(row.price)} บาท</div><div class="error-text"></div></div>
      </div>
      <div class="field"><label>ชื่อแพ็กเกจ</label><input class="input" name="name" maxlength="120" value="${row.service_name || ''}"><div class="error-text"></div></div>
      <div class="form-grid">
        <div class="field"><label>หมวด</label><input class="input" name="category" maxlength="40" value="เน็ต"></div>
        <div class="field"><label>ปริมาณเน็ต (ข้อความสั้น)</label><input class="input" name="data_label" maxlength="40" placeholder="เช่น 15GB"></div>
        <div class="field"><label>ใช้ได้ (วัน)</label><input class="input" name="validity_days" type="number" min="0" max="3650"><div class="error-text"></div></div>
      </div>
      <p class="xsmall muted mb-0">แพ็กเกจใหม่จะ "ปิดขาย" ไว้ก่อน และจับคู่กับบริการนี้ให้ (ปิดไว้) — ตรวจราคาแล้วเปิดขายที่หน้า สินค้า &amp; เครือข่าย และเปิดการจับคู่ที่หน้านี้</p>
    </form>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary" data-ok>สร้างแพ็กเกจ (ปิดขายไว้)</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-form]');
      const btn = dlg.querySelector('[data-ok]');
      const val = (n) => form.querySelector(`[name="${n}"]`).value.trim();
      const submit = (e) => {
        e?.preventDefault();
        clearFieldErrors(form);
        const price = val('price_baht').replace(/,/g, '');
        if (!BAHT_RE.test(price) || !(Number(price) > 0)) { showFieldError(form, { message: 'ราคาขายไม่ถูกต้อง', details: { field: 'price_baht' } }); return; }
        if (row.price && Math.round(Number(price) * 100) < row.price) { showFieldError(form, { message: `ราคาขายต้องไม่ต่ำกว่าต้นทุน ${money(row.price)} บาท`, details: { field: 'price_baht' } }); return; }
        if (!val('name')) { showFieldError(form, { message: 'กรุณาตั้งชื่อแพ็กเกจ', details: { field: 'name' } }); return; }
        const body = { network_code: val('network_code'), price_baht: price, name: val('name') };
        if (val('category')) body.category = val('category');
        if (val('data_label')) body.data_label = val('data_label');
        if (val('validity_days') !== '') body.validity_days = Number(val('validity_days'));
        withLoading(btn, async () => {
          try {
            const r = await api.post(`/api/admin/providers/${encodeURIComponent(name)}/catalog/${encodeURIComponent(row.service_id)}/product`, body);
            toast(`สร้างแพ็กเกจ "${r.product?.name || body.name}" แล้ว (ปิดขายไว้) และจับคู่ให้แล้ว (ปิดไว้) — ตรวจราคาแล้วเปิดขายที่หน้า สินค้า & เครือข่าย และเปิดการจับคู่ที่นี่`, 'success', 9000);
            close(true);
          } catch (err) {
            if (!showFieldError(form, err)) toastError(err);
          }
        });
      };
      form.addEventListener('submit', submit);
      btn.addEventListener('click', submit);
    },
  });
}

async function mapTab(box, name, reload, lastSync) {
  const [d, shops] = await Promise.all([
    api.get(`/api/admin/providers/${encodeURIComponent(name)}/catalog`),
    api.get('/api/admin/shops').catch(() => []),
  ]);
  const shop = shops.find((s) => s.code === name) || null;
  const label = d.provider?.label || name;
  box.innerHTML = html`
    <section class="card">
      <div class="card-head"><h3>จับคู่บริการ ${label}</h3><button type="button" class="btn primary sm" data-sync>${icon('refresh')}ดึงรายการ</button></div>
      <p class="small text-2 mb-0">${label} ขายเป็น "บริการราคาคงที่" — ยอดเติม/แพ็กเกจของเราต้องจับคู่กับบริการก่อน จึงจะขายผ่านร้านนี้ได้ (การจับคู่เริ่มต้นปิดไว้เสมอ ตรวจยอดและต้นทุนแล้วจึงเปิดใช้)
        · ดึงรายการล่าสุด: ${d.synced_at ? dateTimeSec(d.synced_at) : html`<b class="text-danger">ยังไม่เคยดึง</b>`}</p>
      <div data-sync-result>${lastSync ? syncSummary(lastSync) : ''}</div>
      ${gapsHtml(d.topup_gaps)}
    </section>
    <section class="card flush"><div class="card-head" style="padding:16px 18px 0"><h3>การจับคู่ (${d.mappings.length})</h3></div>${mappingsTable(d.mappings)}</section>
    <section class="card flush">
      <div class="card-head" style="padding:16px 18px 0"><h3>บริการจาก ${label} (${d.catalog.length})</h3>
        <input class="input" data-filter placeholder="ค้นหา service id / ชื่อ" style="max-width:260px;min-height:38px"></div>
      <div class="table-wrap mt-1"><table class="table">
        <thead><tr><th>Service ID</th><th>สินค้า / บริการ</th><th class="num">ต้นทุน</th><th>ใช้กับระบบ</th><th>รูปแบบเบอร์</th><th>จับคู่</th><th></th></tr></thead>
        <tbody data-catalog>${catalogRows(d.catalog)}</tbody></table></div>
    </section>`.toString();

  const tbody = box.querySelector('[data-catalog]');
  box.querySelector('[data-filter]').addEventListener('input', (e) => {
    const t = e.target.value.trim().toLowerCase();
    tbody.innerHTML = catalogRows(t ? d.catalog.filter((r) => `${r.service_id} ${r.product_name || ''} ${r.service_name || ''}`.toLowerCase().includes(t)) : d.catalog).toString();
  });
  box.querySelector('[data-sync]').addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    try {
      const r = await api.post(`/api/admin/providers/${encodeURIComponent(name)}/sync`);
      if (r.disabled?.length) toast(`ปิดการจับคู่อัตโนมัติ ${r.disabled.length} รายการ — ดูรายละเอียดด้านบน`, 'warning', 7000);
      else toast('ดึงรายการแล้ว', 'success');
      await reload(r);
    } catch (err) { toast(err.message, 'error', 7000); }
  }));
  const rowOf = (id) => d.catalog.find((r) => String(r.service_id) === String(id));
  on(box, 'click', '[data-map]', async (e, b) => {
    const row = rowOf(b.dataset.map);
    if (row && (await mapDialog(name, row, shop))) await reload();
  });
  on(box, 'click', '[data-new-product]', async (e, b) => {
    const row = rowOf(b.dataset.newProduct);
    if (row && (await newProductDialog(name, row))) await reload();
  });
  on(box, 'change', '[data-map-enable]', async (e, input) => {
    const m = d.mappings.find((x) => String(x.id) === input.dataset.mapEnable);
    if (!m) return;
    const want = input.checked;
    if (want && m.loss) { input.checked = false; toast('ต้นทุนสูงกว่าราคาขาย — เปิดใช้ไม่ได้ (จะขาดทุน)', 'error'); return; }
    input.disabled = true;
    try {
      await api.put(`/api/admin/providers/${encodeURIComponent(name)}/mappings/${m.id}`, { enabled: want });
      toast(want ? 'เปิดใช้การจับคู่แล้ว — ลูกค้าเลือกยอด/แพ็กเกจนี้ที่ร้านนี้ได้' : 'ปิดการจับคู่แล้ว', 'success');
      await reload();
    } catch (err) {
      input.checked = !want;
      input.disabled = false;
      toastError(err); // 400 = จะขาดทุน / บริการใช้ไม่ได้แล้ว
    }
  });
  on(box, 'click', '[data-map-del]', async (e, b) => {
    const m = d.mappings.find((x) => String(x.id) === b.dataset.mapDel);
    if (!m) return;
    const ok = await confirmDialog({
      title: 'ลบการจับคู่',
      body: `ลบการจับคู่ ${kindLabel(m.kind)} ${m.network_code} ${m.kind === 'topup' ? `${money(m.face_value)} บาท` : m.product_name || `#${m.product_id}`} ↔ บริการ ${m.service_id}? ร้านนี้จะขายรายการนี้ไม่ได้จนกว่าจะจับคู่ใหม่`,
      confirmText: 'ลบ',
      danger: true,
    });
    if (!ok) return;
    withLoading(b, async () => {
      try {
        await api.del(`/api/admin/providers/${encodeURIComponent(name)}/mappings/${m.id}`);
        toast('ลบการจับคู่แล้ว', 'success');
        await reload();
      } catch (err) { toastError(err); }
    });
  });
}

// ───────────── หน้า ─────────────

export async function render(el, params, query) {
  el.innerHTML = html`<div data-tabs></div><div data-box class="stack"><div class="card"><span class="spinner"></span></div></div>`.toString();
  const view = await api.get('/api/admin/providers');
  const mapped = view.providers.filter((p) => p.capabilities?.catalog === 'mapped');
  const TABS = [['providers', 'ผู้ให้บริการ'], ['shops', 'ราคาแต่ละร้าน'], ...mapped.map((p) => [`map:${p.name}`, `จับคู่บริการ ${p.label}`])];
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'providers';
  el.querySelector('[data-tabs]').innerHTML = html`<div class="tabs" role="tablist">${TABS.map(([k, l]) => html`<button class="${k === tab ? 'active' : ''}" data-tab="${k}" role="tab" aria-selected="${k === tab}">${l}</button>`)}</div>`.toString();
  on(el.querySelector('[data-tabs]'), 'click', '[data-tab]', (e, b) => setQuery('/providers', { tab: b.dataset.tab }));

  // แต่ละแท็บวาดใหม่ทั้งกล่องทุกครั้ง (เปลี่ยนกล่องใหม่ เพื่อไม่ให้ event ของรอบก่อนค้าง)
  let box = el.querySelector('[data-box]');
  const fresh = () => {
    const nb = box.cloneNode(false);
    box.replaceWith(nb);
    box = nb;
    return nb;
  };
  const show = async (fn) => {
    try {
      await fn(fresh());
    } catch (err) {
      box.innerHTML = html`<div class="alert danger"><span class="alert-icon">!</span><div>${err.message}</div></div>`.toString();
    }
  };
  if (tab === 'providers') {
    const reload = () => show((b) => providersTab(b, reload));
    await reload();
  } else if (tab === 'shops') {
    const reload = () => show((b) => shopsTab(b, reload));
    await reload();
  } else {
    const name = tab.slice('map:'.length);
    const reload = (lastSync) => show((b) => mapTab(b, name, reload, lastSync));
    await reload();
  }
}
