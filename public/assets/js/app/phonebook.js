// สมุดโทรศัพท์: เพิ่ม / แก้ไข / ลบ เบอร์ที่เติมบ่อย
import { html, raw, api, on, setHTML, phoneFmt, modal, withLoading, toast, toastError, confirmDialog, showFieldError, normalizePhone } from '../lib.js';
import { state, networkOf, safeColor } from './state.js';
import { icon } from './icons.js';
import { pageHead, netTag, emptyState } from './ui.js';
import { formatPhoneTyping } from './phonefield.js';

const fld = (form, name) => form.elements.namedItem(name);

function entryForm(entry) {
  entry = entry || {};
  const nets = state.catalog.networks;
  return html`<form class="stack" data-pb-form novalidate>
    <div class="field">
      <label for="pbName">ชื่อเรียก</label>
      <input class="input" id="pbName" name="name" maxlength="60" placeholder="เช่น แม่, ร้านค้า, เบอร์ตัวเอง" value="${entry.name || ''}" autocomplete="off">
      <div class="error-text"></div>
    </div>
    <div class="field">
      <label for="pbPhone">เบอร์มือถือ</label>
      <input class="input" id="pbPhone" name="phone" type="tel" inputmode="numeric" maxlength="16" placeholder="08X-XXX-XXXX" value="${formatPhoneTyping(entry.phone || '')}">
      <div class="error-text"></div>
    </div>
    <div class="field">
      <label for="pbNet">เครือข่าย (ไม่บังคับ)</label>
      <select class="select" id="pbNet" name="network">
        <option value="">ไม่ระบุ</option>
        ${nets.map((n) => html`<option value="${n.code}" ${entry.network === n.code ? 'selected' : ''}>${n.full_name}</option>`)}
      </select>
      <div class="help">ระบุไว้เพื่อเลือกเครือข่ายให้อัตโนมัติตอนเติมเงิน</div>
    </div>
  </form>`;
}

async function openForm(entry) {
  return modal({
    title: entry ? 'แก้ไขรายชื่อ' : 'เพิ่มเบอร์ในสมุดโทรศัพท์',
    body: entryForm(entry),
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary" data-save>${icon('check', 18)} บันทึก</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-pb-form]');
      const phone = form.querySelector('#pbPhone');
      phone.addEventListener('input', () => { phone.value = formatPhoneTyping(phone.value); });
      const save = dlg.querySelector('[data-save]');
      const submit = () => withLoading(save, async () => {
        const body = { name: fld(form, 'name').value.trim(), phone: fld(form, 'phone').value, network: fld(form, 'network').value || undefined };
        if (!body.name) { showFieldError(form, { message: 'กรุณาตั้งชื่อเรียก', details: { field: 'name' } }); return; }
        if (!normalizePhone(body.phone)) { showFieldError(form, { message: 'เบอร์มือถือไม่ถูกต้อง (10 หลัก ขึ้นต้น 06/08/09)', details: { field: 'phone' } }); return; }
        try {
          const r = entry ? await api.put(`/api/phonebook/${entry.id}`, body) : await api.post('/api/phonebook', body);
          close(r);
        } catch (err) {
          if (!showFieldError(form, err)) toastError(err);
        }
      });
      save.addEventListener('click', submit);
      form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      if (window.matchMedia('(pointer: fine)').matches) fld(form, 'name').focus();
    },
  });
}

export default async function phonebookPage(ctx) {
  let list = [];

  function render() {
    setHTML(ctx.view, html`
      ${pageHead('สมุดโทรศัพท์', 'บันทึกเบอร์ที่เติมบ่อย เลือกใช้ได้ทันที ลดโอกาสพิมพ์เบอร์ผิด', html`<button class="btn primary" data-add>${icon('plus', 18)} เพิ่มเบอร์</button>`)}
      <div class="card flush">
        ${list.length ? html`<div class="pb-list">${list.map((e) => {
          const n = networkOf(e.network);
          return html`<div class="pb-item">
            <span class="pb-avatar" style="--net:${raw(safeColor(n?.color || '#4f46e5'))}">${e.name.charAt(0)}</span>
            <span class="grow pb-main"><span class="bold d-block truncate">${e.name}</span><span class="num muted small">${phoneFmt(e.phone)}</span></span>
            ${e.network ? netTag(e.network) : ''}
            <span class="pb-actions">
              <a class="btn sm soft" href="#/topup?phone=${e.phone}${e.network ? `&network=${e.network}` : ''}">${icon('bolt', 16)}<span class="hide-xs">เติมเงิน</span></a>
              <a class="btn sm ghost icon" href="#/packages?phone=${e.phone}${e.network ? `&network=${e.network}` : ''}" title="สมัครแพ็กเกจ">${icon('wifi', 16)}</a>
              <button class="btn sm ghost icon" data-edit="${e.id}" title="แก้ไข">${icon('edit', 16)}</button>
              <button class="btn sm ghost icon" data-del="${e.id}" title="ลบ">${icon('trash', 16)}</button>
            </span>
          </div>`;
        })}</div>`
          : emptyState('book', 'ยังไม่มีเบอร์ในสมุดโทรศัพท์', 'เพิ่มเบอร์ของคุณ ครอบครัว หรือลูกค้าที่เติมบ่อย', html`<button class="btn primary sm" data-add>${icon('plus', 16)} เพิ่มเบอร์แรก</button>`)}
      </div>`);
  }

  async function load() {
    list = await api.get('/api/phonebook');
    if (ctx.alive()) render();
  }

  on(ctx.view, 'click', '[data-add]', async () => {
    const r = await openForm(null);
    if (r) { toast('บันทึกเบอร์แล้ว', 'success'); await load(); }
  });
  on(ctx.view, 'click', '[data-edit]', async (e, el) => {
    const entry = list.find((x) => String(x.id) === el.dataset.edit);
    if (!entry) return;
    const r = await openForm(entry);
    if (r) { toast('แก้ไขแล้ว', 'success'); await load(); }
  });
  on(ctx.view, 'click', '[data-del]', async (e, el) => {
    const entry = list.find((x) => String(x.id) === el.dataset.del);
    if (!entry) return;
    const yes = await confirmDialog({ title: 'ลบรายชื่อ?', body: `ลบ "${entry.name}" (${phoneFmt(entry.phone)}) ออกจากสมุดโทรศัพท์`, confirmText: 'ลบ', danger: true });
    if (!yes) return;
    try {
      await api.del(`/api/phonebook/${entry.id}`);
      toast('ลบแล้ว', 'success');
      await load();
    } catch (err) {
      toastError(err);
    }
  });

  await load();
}
