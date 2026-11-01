// สินค้า: ตั้งค่าเครือข่าย (เปิด/ปิด, ยอดเติม, ส่วนลด) + แพ็กเกจเน็ต (เพิ่ม/แก้/ลบ/ดึงจากผู้ให้บริการ)
import { html, raw, api, baht, numFmt, netBadge, modal, confirmDialog, toast, toastError, withLoading, on, qs, formData, showFieldError } from '../lib.js';
import { icon, emptyRow, networkOptions, setQuery, store, shortLabel } from './common.js';

const CATEGORIES = ['รายวัน', 'รายสัปดาห์', 'รายเดือน', 'โทร+เน็ต', 'เน็ต'];
const bpToPct = (bp) => String((Number(bp) || 0) / 100);
const afterDiscount = (satang, bp) => satang - Math.floor((satang * Math.max(0, bp)) / 10000);
const isColor = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || ''));

const sw = (name, checked, label) => html`<label class="switch"><input type="checkbox" name="${name}" ${checked ? raw('checked') : ''}><span class="track"></span><span class="small">${label}</span></label>`;

/**
 * ชื่อผู้ให้บริการสำหรับข้อความช่วยเหลือ (ไม่ผูกกับเจ้าใดเจ้าหนึ่ง)
 * primary = เจ้าที่ใช้ "รหัสสินค้า" ของระบบ (เช่น WonDD) · mapped = เจ้าที่ใช้การจับคู่บริการแทน (เช่น HubZell)
 */
let PROV = { primary: '', mapped: '' };
const codeHelp = () => `ตามคู่มือ${PROV.primary ? ` ${PROV.primary}` : 'ผู้ให้บริการ'}${PROV.mapped ? ` · ${PROV.mapped} ไม่ใช้รหัสนี้ (ใช้การจับคู่บริการแทน)` : ''}`;

// ข้อความยืนยันสวิตช์เครือข่าย (เปิด/ปิดมีผลกับลูกค้าทันที)
const TOGGLES = {
  enabled: {
    label: 'เครือข่าย',
    on: (n) => `เปิดให้บริการ ${n.name} — ลูกค้าเติมเงินและซื้อแพ็กเกจ ${n.name} ได้ทันที`,
    off: (n) => `ปิดให้บริการ ${n.name} ทั้งหมด — ลูกค้าจะเติมเงินและซื้อแพ็กเกจ ${n.name} ไม่ได้จนกว่าจะเปิดใหม่ (รายการที่ส่งไปแล้วยังทำงานต่อตามปกติ)`,
  },
  topup_enabled: {
    label: 'เติมเงิน',
    on: (n) => `เปิดเติมเงิน ${n.name} — ลูกค้าเติมเงินได้ทันที`,
    off: (n) => `ปิดเติมเงิน ${n.name} — ลูกค้าจะเติมเงิน ${n.name} ไม่ได้ (แพ็กเกจยังขายตามสวิตช์ของแพ็กเกจ)`,
  },
  package_enabled: {
    label: 'แพ็กเกจ',
    on: (n) => `เปิดขายแพ็กเกจ ${n.name} — ลูกค้าเห็นและซื้อแพ็กเกจที่เปิดขายได้ทันที`,
    off: (n) => `ปิดขายแพ็กเกจ ${n.name} ทั้งหมด — ลูกค้าจะซื้อแพ็กเกจ ${n.name} ไม่ได้`,
  },
  topup_allow_custom: {
    label: 'กรอกยอดเอง',
    on: (n) => `ให้ลูกค้ากรอกยอดเติม ${n.name} เองได้ (ตั้งแต่ ${baht(n.topup_min)} ถึง ${baht(n.topup_max)} บาท)`,
    off: (n) => `ลูกค้าเติม ${n.name} ได้เฉพาะปุ่มยอดที่ตั้งไว้ (${n.topup_presets.join(', ')} บาท)`,
  },
};

function calcLine(n, face = 10000) {
  const price = afterDiscount(face, n.customer_discount_bp);
  const cost = afterDiscount(face, n.provider_discount_bp);
  return html`ตัวอย่างเติม ${baht(face)} บาท → ลูกค้าจ่าย <b>${baht(price)}</b> · ทุน <b>${baht(cost)}</b> · กำไร <b>${baht(price - cost)}</b> บาท`;
}

function networkCard(n) {
  const color = isColor(n.color) ? n.color : '#777777';
  return html`<form class="card net-card" data-net="${n.code}" style="--net:${color}">
    <div class="card-head">
      <h3>${netBadge(n.code, n.name)} ${n.full_name}</h3>
      ${n.enabled ? html`<span class="badge success">เปิดให้บริการ</span>` : html`<span class="badge danger">ปิดอยู่</span>`}
    </div>
    <div class="toggles" data-toggles>
      ${sw('enabled', n.enabled, 'เปิดเครือข่ายนี้')}
      ${sw('topup_enabled', n.topup_enabled, 'เติมเงิน')}
      ${sw('package_enabled', n.package_enabled, 'แพ็กเกจเน็ต')}
      ${sw('topup_allow_custom', n.topup_allow_custom, 'ให้กรอกยอดเองได้')}
    </div>
    <p class="xsmall muted mb-2">สวิตช์ด้านบนบันทึกทันทีหลังกดยืนยัน · ช่องอื่นกด "บันทึก"</p>
    <div class="stack">
      <div class="field"><label>ข้อความแจ้งลูกค้า (เช่น ปิดปรับปรุง 22:00-23:00)</label><input class="input" name="notice" value="${n.notice || ''}" maxlength="200" placeholder="เว้นว่าง = ไม่แสดง"></div>
      <div class="form-grid">
        <div class="field"><label>ยอดเติมขั้นต่ำ (บาท)</label><input class="input" name="topup_min" type="number" min="1" step="1" value="${n.topup_min / 100}"></div>
        <div class="field"><label>ยอดเติมสูงสุด (บาท)</label><input class="input" name="topup_max" type="number" min="1" step="1" value="${n.topup_max / 100}"></div>
      </div>
      <div class="field"><label>ปุ่มยอดเติม (บาท คั่นด้วย ,)</label><input class="input" name="topup_presets" value="${n.topup_presets.join(', ')}"></div>
      <div class="form-grid">
        <div class="field"><label>ส่วนลดให้ลูกค้า (%)</label><input class="input" name="customer_discount" type="number" min="0" max="100" step="0.01" value="${bpToPct(n.customer_discount_bp)}"><div class="help">ต้องไม่เกินส่วนลดที่ได้จากผู้ให้บริการ</div></div>
        <div class="field"><label>ส่วนลดที่ได้จากผู้ให้บริการ: เติมเงิน (%)</label><input class="input" name="provider_discount" type="number" min="0" max="100" step="0.01" value="${bpToPct(n.provider_discount_bp)}"></div>
        <div class="field"><label>ส่วนลดจากผู้ให้บริการ: แพ็กเกจ (%)</label><input class="input" name="package_provider_discount" type="number" min="0" max="100" step="0.01" value="${bpToPct(n.package_provider_discount_bp)}"><div class="help">ใช้คำนวณต้นทุนตอนดึงแพ็กเกจ</div></div>
        <div class="field"><label>รหัสบริการเติมเงินที่ผู้ให้บริการ</label><input class="input mono" name="provider_topup_code" value="${n.provider_topup_code}"><div class="help">${codeHelp()}</div></div>
      </div>
      <details><summary class="small muted" style="cursor:pointer">ชื่อ / สีที่แสดง</summary>
        <div class="form-grid mt-2">
          <div class="field"><label>ชื่อสั้น</label><input class="input" name="name" value="${n.name}" maxlength="30"></div>
          <div class="field"><label>ชื่อเต็ม</label><input class="input" name="full_name" value="${n.full_name}" maxlength="60"></div>
          <div class="field"><label>สี</label><input class="input" name="color" type="color" value="${color}" style="padding:4px;height:44px"></div>
        </div>
      </details>
      <div class="calc" data-calc>${calcLine(n)}</div>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">บันทึก</button></div>
    </div>
  </form>`;
}

function productDialog(p, networks) {
  const isNew = !p;
  const v = p || { network_code: networks[0]?.code || 'AIS', provider_code: '', name: '', description: '', category: 'รายวัน', data_label: '', validity_days: '', price: '', cost: '', enabled: true, sort: 0 };
  return modal({
    title: isNew ? 'เพิ่มแพ็กเกจ' : `แก้ไขแพ็กเกจ #${p.id}`,
    body: html`<form class="stack" data-form>
      ${p?.is_demo ? html`<div class="alert warning"><span class="alert-icon">!</span><div>นี่คือ <b>แพ็กเกจตัวอย่าง</b> (ใช้ได้เฉพาะโหมดทดสอบ) — แก้ "รหัสแพ็กเกจ" ให้ตรงกับรหัสจริงของ${PROV.primary ? ` ${PROV.primary}` : 'ผู้ให้บริการ'} เพื่อเปิดขายจริง</div></div>` : ''}
      <div class="form-grid">
        <div class="field"><label>เครือข่าย</label><select class="select" name="network_code">${networkOptions(v.network_code, { all: false })}</select></div>
        <div class="field"><label>รหัสแพ็กเกจที่ผู้ให้บริการ</label><input class="input mono" name="provider_code" value="${v.provider_code}" placeholder="${codeHelp().split(' · ')[0]}">${PROV.mapped ? html`<div class="help">ขายผ่าน ${PROV.mapped}: จับคู่บริการที่หน้า "ผู้ให้บริการ &amp; ร้าน"</div>` : ''}<div class="error-text"></div></div>
      </div>
      <div class="field"><label>ชื่อแพ็กเกจ</label><input class="input" name="name" value="${v.name}" maxlength="120" placeholder="เช่น เน็ต 15GB ใช้ได้ 30 วัน"><div class="error-text"></div></div>
      <div class="field"><label>รายละเอียด (ไม่บังคับ)</label><textarea class="textarea" name="description" maxlength="500" style="min-height:70px">${v.description || ''}</textarea></div>
      <div class="form-grid">
        <div class="field"><label>หมวด</label><input class="input" name="category" value="${v.category}" list="pkg-cats" maxlength="40"><datalist id="pkg-cats">${CATEGORIES.map((c) => html`<option value="${c}">`)}</datalist></div>
        <div class="field"><label>ปริมาณเน็ต (ข้อความสั้น)</label><input class="input" name="data_label" value="${v.data_label || ''}" maxlength="40" placeholder="เช่น 15GB / ไม่อั้น 4Mbps"></div>
        <div class="field"><label>ใช้ได้ (วัน)</label><input class="input" name="validity_days" type="number" min="0" max="3650" value="${v.validity_days ?? ''}"><div class="error-text"></div></div>
        <div class="field"><label>ลำดับการแสดง</label><input class="input" name="sort" type="number" value="${v.sort ?? 0}"></div>
        <div class="field"><label>ราคาขาย (บาท)</label><input class="input" name="price_baht" type="number" min="0.01" step="0.01" value="${v.price === '' ? '' : v.price / 100}"><div class="error-text"></div></div>
        <div class="field"><label>ต้นทุน (บาท)</label><input class="input" name="cost_baht" type="number" min="0" step="0.01" value="${v.cost === '' ? '' : v.cost / 100}"><div class="error-text"></div></div>
      </div>
      <div class="calc small" data-margin></div>
      ${sw('enabled', v.enabled, 'เปิดขาย')}
    </form>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary" data-ok>${isNew ? 'เพิ่มแพ็กเกจ' : 'บันทึก'}</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-form]');
      const margin = dlg.querySelector('[data-margin]');
      const updMargin = () => {
        const price = Math.round(Number(form.querySelector('[name="price_baht"]').value) * 100);
        const cost = Math.round(Number(form.querySelector('[name="cost_baht"]').value) * 100);
        if (!(price > 0)) { margin.textContent = 'กรอกราคาขายและต้นทุนเพื่อดูกำไร'; return; }
        const m = price - cost;
        margin.innerHTML = html`กำไรต่อรายการ <b class="${m < 0 ? 'text-danger' : ''}">${baht(m)}</b> บาท (${((m / price) * 100).toFixed(2)}%)${m < 0 ? ' — ขาดทุน! ระบบจะไม่ให้บันทึก' : ''}`.toString();
      };
      form.addEventListener('input', updMargin);
      updMargin();
      const btn = dlg.querySelector('[data-ok]');
      const submit = (e) => {
        e?.preventDefault();
        withLoading(btn, async () => {
          const f = formData(form);
          const body = { ...f, enabled: form.querySelector('[name="enabled"]').checked };
          try {
            const r = isNew ? await api.post('/api/admin/products', body) : await api.put(`/api/admin/products/${p.id}`, body);
            toast(isNew ? 'เพิ่มแพ็กเกจแล้ว' : 'บันทึกแล้ว', 'success');
            close(r);
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

function productsTable(rows) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>เครือข่าย</th><th>รหัส</th><th>ชื่อแพ็กเกจ</th><th>หมวด</th><th class="num">วัน</th><th class="num">ราคาขาย</th><th class="num">ทุน</th><th class="num">กำไร</th><th class="num">ขายแล้ว</th><th>เปิดขาย</th><th></th></tr></thead>
    <tbody>${rows.length ? rows.map((p) => html`<tr>
      <td>${netBadge(p.network_code)}</td>
      <td class="mono small">${p.provider_code}${p.is_demo ? html` <span class="badge warning plain">ตัวอย่าง</span>` : ''}</td>
      <td><span class="bold">${p.name}</span>${p.data_label ? html`<span class="sub">${p.data_label}</span>` : ''}</td>
      <td class="small">${p.category}</td>
      <td class="num">${p.validity_days ?? '-'}</td>
      <td class="num">${baht(p.price)}</td>
      <td class="num">${baht(p.cost)}</td>
      <td class="num">${baht(p.price - p.cost)}</td>
      <td class="num">${numFmt(p.sold)}</td>
      <td><label class="switch" title="เปิด/ปิดการขาย"><input type="checkbox" data-enable="${p.id}" ${p.enabled ? raw('checked') : ''}><span class="track"></span></label></td>
      <td class="actions"><button class="btn ghost sm icon" data-edit="${p.id}" title="แก้ไข" aria-label="แก้ไข">${icon('edit')}</button><button class="btn ghost sm icon" data-del="${p.id}" title="ลบ" aria-label="ลบ">${icon('trash')}</button></td>
    </tr>`) : emptyRow(11, 'ยังไม่มีแพ็กเกจ')}</tbody></table></div>`;
}

export async function render(el, params, query) {
  const fNet = query.network || '';
  const fQ = query.q || '';
  el.innerHTML = html`
    <section class="stack">
      <div class="page-head"><div><h2 class="mb-0">เครือข่ายและการเติมเงิน</h2><p class="desc">เปิด/ปิดบริการรายเครือข่าย, ยอดเติม, ส่วนลด และข้อความแจ้งลูกค้า</p></div></div>
      <div class="net-cards" data-nets><div class="card"><span class="spinner"></span></div></div>
    </section>
    <section class="stack mt-2">
      <div class="page-head">
        <div><h2 class="mb-0">แพ็กเกจเน็ต</h2><p class="desc">รหัสแพ็กเกจต้องตรงกับผู้ให้บริการ · แพ็กเกจ "ตัวอย่าง" ขายได้เฉพาะโหมดทดสอบ</p></div>
        <div class="row wrap">
          <button class="btn" data-sync>${icon('refresh')}ดึงรายการจากผู้ให้บริการ</button>
          <button class="btn" data-del-demo>${icon('trash')}ลบแพ็กเกจตัวอย่าง</button>
          <button class="btn primary" data-add>${icon('plus')}เพิ่มแพ็กเกจ</button>
        </div>
      </div>
      <form class="card filter-card toolbar" data-filter>
        <div class="field"><label>เครือข่าย</label><select class="select" name="network">${networkOptions(fNet)}</select></div>
        <div class="field grow"><label>ค้นหา</label><input class="input" name="q" value="${fQ}" placeholder="ชื่อหรือรหัสแพ็กเกจ"></div>
        <div class="row"><button class="btn" type="submit">${icon('search')}ค้นหา</button></div>
      </form>
      <section class="card flush" data-products><div class="empty"><span class="spinner"></span></div></section>
    </section>`.toString();

  let networks = [];
  let products = [];

  // ชื่อผู้ให้บริการสำหรับข้อความช่วยเหลือ (โหลดไม่ได้ = ใช้คำกลางๆ "ผู้ให้บริการ")
  const provReady = api.get('/api/admin/providers').then((view) => {
    const list = view.providers || [];
    const names = (arr) => [...new Set(arr.map(shortLabel))].join(' / ');
    PROV = {
      primary: names(list.filter((p) => (p.capabilities?.catalog || 'primary') === 'primary' && p.live)),
      mapped: names(list.filter((p) => p.capabilities?.catalog === 'mapped')),
    };
  }).catch(() => { PROV = { primary: '', mapped: '' }; });

  const loadNetworks = async () => {
    const [list] = await Promise.all([api.get('/api/admin/networks'), provReady]);
    networks = list;
    el.querySelector('[data-nets]').innerHTML = html`${networks.map(networkCard)}`.toString();
  };
  /** วาดการ์ดเครือข่ายใหม่ใบเดียว (การ์ดอื่นที่กำลังแก้ค้างไว้ไม่หาย) */
  const redrawNetwork = (n) => {
    networks = networks.map((x) => (x.code === n.code ? n : x));
    const old = netForm(n.code);
    if (!old) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = networkCard(n).toString();
    old.replaceWith(tmp.firstElementChild);
  };
  const loadProducts = async () => {
    try {
      products = await api.get(`/api/admin/products${qs({ network: fNet, q: fQ })}`);
      el.querySelector('[data-products]').innerHTML = productsTable(products).toString();
    } catch (err) {
      el.querySelector('[data-products]').innerHTML = html`<div class="empty"><div class="alert danger">${err.message}</div></div>`.toString();
    }
  };

  const netForm = (code) => el.querySelector(`form[data-net="${CSS.escape(code)}"]`);
  /**
   * บันทึกเครือข่าย — ถ้ากระทบร้าน/ยอดที่ขายอยู่ (409 NETWORK_IMPACT) แสดงรายการผลกระทบให้ยืนยันก่อนส่งซ้ำ
   * คืน network ที่บันทึกแล้ว หรือ null (ยกเลิก/ผิดพลาด — ข้อมูลที่กรอกค้างไว้ยังอยู่)
   */
  const saveNetwork = async (code, body, msg) => {
    const url = `/api/admin/networks/${encodeURIComponent(code)}`;
    const n = networks.find((x) => x.code === code);
    try {
      let saved;
      try {
        saved = await api.put(url, body);
      } catch (err) {
        if (err.code !== 'NETWORK_IMPACT') throw err;
        const impacts = Array.isArray(err.details?.impacts) ? err.details.impacts : [];
        const ok = await confirmDialog({
          title: `การแก้ไข ${n?.name || code} มีผลกับร้าน/ยอดที่ขายอยู่`,
          body: html`<div class="stack">
            <p class="mb-0">${err.message}</p>
            ${impacts.length ? html`<ul class="check-list small text-danger">${impacts.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
            <p class="small mb-0">ถ้าไม่แน่ใจ ให้กด "ยกเลิก" แล้วปรับส่วนลดของร้านที่หน้า <a href="#/providers?tab=shops" data-close>ผู้ให้บริการ &amp; ร้าน → ราคาแต่ละร้าน</a> ก่อน</p>
          </div>`,
          confirmText: 'ยืนยันบันทึก (ยอมรับผลกระทบ)',
          danger: true,
        });
        if (!ok) return null;
        saved = await api.put(url, { ...body, confirm_impact: true });
      }
      toast(msg || 'บันทึกแล้ว', 'success');
      store.refresh().catch(() => {});
      return saved && saved.code ? saved : null;
    } catch (err) {
      toastError(err);
      return null;
    }
  };

  // สวิตช์: ยืนยันก่อนทุกครั้ง (มีผลกับลูกค้าทันที) — ยกเลิก/ผิดพลาด = คืนสวิตช์ตำแหน่งเดิม
  on(el, 'change', '[data-net] [data-toggles] input', async (e, input) => {
    const form = input.closest('[data-net]');
    const n = networks.find((x) => x.code === form.dataset.net);
    const t = TOGGLES[input.name];
    if (!n || !t) { input.checked = !input.checked; return; }
    const want = input.checked;
    const ok = await confirmDialog({
      title: `${want ? 'เปิด' : 'ปิด'}${t.label} ${n.name}`,
      body: want ? t.on(n) : t.off(n),
      confirmText: `${want ? 'เปิด' : 'ปิด'}${t.label}`,
      danger: !want,
    });
    if (!ok) { input.checked = !want; return; }
    input.disabled = true;
    const saved = await saveNetwork(n.code, { [input.name]: want }, `${t.label} ${n.name}: ${want ? 'เปิด' : 'ปิด'} แล้ว`);
    input.disabled = false;
    if (!saved) { input.checked = !want; return; }
    // อัปเดตเฉพาะสวิตช์/ป้ายสถานะ (ช่องอื่นในการ์ดที่แก้ค้างไว้ยังอยู่)
    networks = networks.map((x) => (x.code === saved.code ? saved : x));
    for (const k of Object.keys(TOGGLES)) {
      const cb = form.querySelector(`[data-toggles] [name="${k}"]`);
      if (cb) cb.checked = Boolean(saved[k]);
    }
    const badge = form.querySelector('.card-head .badge');
    if (badge) badge.outerHTML = (saved.enabled ? html`<span class="badge success">เปิดให้บริการ</span>` : html`<span class="badge danger">ปิดอยู่</span>`).toString();
  });
  // คำนวณตัวอย่างราคาสด
  on(el, 'input', '[data-net]', (e, form) => {
    const n = networks.find((x) => x.code === form.dataset.net);
    if (!n) return;
    const cd = Math.round(Number(form.querySelector('[name="customer_discount"]').value) * 100);
    const pd = Math.round(Number(form.querySelector('[name="provider_discount"]').value) * 100);
    form.querySelector('[data-calc]').innerHTML = calcLine({ ...n, customer_discount_bp: cd || 0, provider_discount_bp: pd || 0 }).toString();
  });
  el.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-net]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const f = formData(form);
    const body = {
      notice: f.notice,
      topup_min: Number(f.topup_min),
      topup_max: Number(f.topup_max),
      topup_presets: f.topup_presets,
      customer_discount: f.customer_discount,
      provider_discount: f.provider_discount,
      package_provider_discount: f.package_provider_discount,
      provider_topup_code: f.provider_topup_code,
      name: f.name,
      full_name: f.full_name,
      color: f.color,
    };
    withLoading(btn, async () => {
      const saved = await saveNetwork(form.dataset.net, body, 'บันทึกการตั้งค่าเครือข่ายแล้ว');
      if (saved) redrawNetwork(saved); // บันทึกสำเร็จ → แสดงค่าที่ระบบเก็บจริง · ไม่สำเร็จ = ค่าที่กรอกยังอยู่ให้แก้ต่อ
    });
  });

  el.querySelector('[data-filter]').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = formData(e.target);
    setQuery('/catalog', Object.fromEntries(Object.entries(f).filter(([, v]) => v)));
  });
  el.querySelector('[data-add]').addEventListener('click', async () => {
    if (await productDialog(null, networks)) loadProducts();
  });
  on(el, 'click', '[data-edit]', async (e, b) => {
    const p = products.find((x) => String(x.id) === b.dataset.edit);
    if (p && (await productDialog(p, networks))) loadProducts();
  });
  on(el, 'click', '[data-del]', (e, b) => withLoading(b, async () => {
    const p = products.find((x) => String(x.id) === b.dataset.del);
    if (!p) return;
    const ok = await confirmDialog({ title: 'ลบแพ็กเกจ', body: `ลบ ${p.network_code} "${p.name}" (${p.provider_code}) ราคา ${baht(p.price)} บาท? ประวัติรายการเดิมยังอยู่ครบ — ถ้าแค่ต้องการหยุดขายชั่วคราว ให้ปิดสวิตช์ "เปิดขาย" แทน`, confirmText: 'ลบ', danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/admin/products/${p.id}`);
      toast('ลบแล้ว', 'success');
      loadProducts();
    } catch (err) { toastError(err); }
  }));
  on(el, 'change', '[data-enable]', async (e, input) => {
    const want = input.checked;
    const p = products.find((x) => String(x.id) === input.dataset.enable);
    // เปิดขาย = ลูกค้าซื้อได้ทันที → ยืนยันรหัส/ราคาก่อน (ปิดขายทำได้ทันที เป็นทางที่ปลอดภัย)
    if (want && p) {
      const ok = await confirmDialog({
        title: 'เปิดขายแพ็กเกจ',
        body: html`<p class="mb-0">${netBadge(p.network_code)} <b>${p.name}</b> · รหัส <span class="mono">${p.provider_code}</span><br>
          ขาย <b>${baht(p.price)}</b> · ทุน ${baht(p.cost)} · กำไร <b class="${p.price - p.cost < 0 ? 'text-danger' : ''}">${baht(p.price - p.cost)}</b> บาท</p>
          <p class="small text-2 mb-0 mt-1">ลูกค้าจะเห็นและซื้อได้ทันที — ตรวจว่ารหัสแพ็กเกจตรงกับผู้ให้บริการ (รหัสผิด = ลูกค้าได้แพ็กเกจไม่ตรงที่จ่าย)</p>`,
        confirmText: 'เปิดขาย',
      });
      if (!ok) { input.checked = false; return; }
    }
    input.disabled = true;
    try {
      const r = await api.put(`/api/admin/products/${input.dataset.enable}`, { enabled: want });
      if (p) Object.assign(p, r && r.id ? r : { enabled: want });
      toast(want ? 'เปิดขายแล้ว' : 'ปิดขายแล้ว', 'success');
    } catch (err) {
      input.checked = !want;
      toastError(err);
    } finally {
      input.disabled = false;
    }
  });
  el.querySelector('[data-del-demo]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const n = products.filter((p) => p.is_demo).length;
    const ok = await confirmDialog({ title: 'ลบแพ็กเกจตัวอย่างทั้งหมด', body: `ลบแพ็กเกจที่ติดป้าย "ตัวอย่าง" ทั้งหมด${n ? ` (${n} รายการในหน้านี้)` : ''} — ทำเมื่อพร้อมเปิดขายจริงและเพิ่มแพ็กเกจจริงแล้ว`, confirmText: 'ลบทั้งหมด', danger: true });
    if (!ok) return;
    withLoading(btn, async () => {
      try {
        const r = await api.post('/api/admin/products/delete-demo');
        toast(`ลบแพ็กเกจตัวอย่าง ${r.deleted} รายการแล้ว`, 'success');
        loadProducts();
      } catch (err) { toastError(err); }
    });
  });
  el.querySelector('[data-sync]').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    withLoading(btn, async () => {
      try {
        const r = await api.post('/api/admin/products/sync');
        toast(`ดึงรายการแล้ว: เพิ่มใหม่ ${r.added} (ปิดขายไว้ก่อน ตรวจราคาแล้วค่อยเปิด) · อัปเดต ${r.updated} · ข้าม ${r.skipped}`, 'success', 7000);
        loadProducts();
      } catch (err) {
        toast(err.message, 'error', 7000);
      }
    });
  });

  await Promise.all([loadNetworks().catch((err) => { el.querySelector('[data-nets]').innerHTML = html`<div class="alert danger">${err.message}</div>`.toString(); }), loadProducts()]);
}
