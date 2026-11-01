// สมุดโทรศัพท์: เพิ่ม / แก้ไข / ลบ เบอร์ที่เติมบ่อย
import { html, api, on, setHTML, phoneFmt, modal, withLoading, toast, toastError, confirmDialog, showFieldError, normalizePhone } from '../lib.js';
import { state, networkOf, netVars, phonebookList, forgetPhonebook, recentNumbers } from './state.js';
import { icon } from './icons.js';
import { pageHead, netTag, emptyState } from './ui.js';
import { formatPhoneTyping, bindPhoneFormat } from './phonefield.js';

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
      <div class="help">ระบุไว้เพื่อเลือกเครือข่ายให้อัตโนมัติตอนเติมเงิน (ถ้าเบอร์ย้ายค่าย อย่าลืมแก้ที่นี่)</div>
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
      bindPhoneFormat(form.querySelector('#pbPhone')); // จัดรูปแบบโดยไม่ให้เคอร์เซอร์กระโดด
      const save = dlg.querySelector('[data-save]');
      const submit = () => withLoading(save, async () => {
        const body = { name: fld(form, 'name').value.trim(), phone: fld(form, 'phone').value, network: fld(form, 'network').value || undefined };
        if (!body.name) { showFieldError(form, { message: 'กรุณาตั้งชื่อเรียก', details: { field: 'name' } }); return; }
        if (!normalizePhone(body.phone)) { showFieldError(form, { message: 'เบอร์มือถือไม่ถูกต้อง (10 หลัก ขึ้นต้น 06/08/09)', details: { field: 'phone' } }); return; }
        try {
          const r = entry ? await api.put(`/api/phonebook/${entry.id}`, body) : await api.post('/api/phonebook', body);
          forgetPhonebook();
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
  let recent = [];

  /**
   * เครือข่ายสำหรับลิงก์เติมเงิน: เครือข่ายที่เคยเติมสำเร็จล่าสุดมาก่อนเครือข่ายที่บันทึกไว้
   * (ข้อมูลในสมุดอาจเก่า เช่น ย้ายค่ายแล้ว) — ไม่มีทั้งสองอย่าง = ให้หน้าเติมเงินถามเอง
   */
  const netFor = (e) => {
    const ok = recent.find((r) => r.phone === e.phone && r.network_confirmed && networkOf(r.network));
    return { code: ok?.network || e.network || null, conflict: Boolean(ok && e.network && ok.network !== e.network) };
  };
  const linkFor = (page, e) => {
    const n = netFor(e).code;
    return `#/${page}?phone=${encodeURIComponent(e.phone)}${n ? `&network=${encodeURIComponent(n)}` : ''}`;
  };

  function render() {
    setHTML(ctx.view, html`
      ${pageHead('สมุดโทรศัพท์', 'บันทึกเบอร์ที่เติมบ่อย เลือกใช้ได้ทันที ลดโอกาสพิมพ์เบอร์ผิด', html`<button class="btn primary" data-add>${icon('plus', 18)} เพิ่มเบอร์</button>`)}
      <div class="card flush">
        ${list.length ? html`<div class="pb-list">${list.map((e) => {
          const nf = netFor(e);
          const n = networkOf(nf.code);
          return html`<div class="pb-item">
            <a class="pb-link" href="${linkFor('topup', e)}" title="เติมเงินเบอร์นี้">
              <span class="pb-avatar" style="${netVars(n?.color || '#4f46e5')}">${e.name.charAt(0)}</span>
              <span class="grow pb-main"><span class="bold d-block truncate">${e.name}</span><span class="num muted small">${phoneFmt(e.phone)}</span>
                ${nf.conflict ? html`<span class="xsmall text-warning d-block">บันทึกไว้เป็น ${networkOf(e.network)?.name || e.network} แต่เติม ${n?.name || nf.code} สำเร็จล่าสุด</span>` : ''}</span>
              ${nf.code ? netTag(nf.code) : ''}
            </a>
            <span class="pb-actions">
              <a class="btn sm soft pb-wide" href="${linkFor('topup', e)}">${icon('bolt', 16)}<span>เติมเงิน</span></a>
              <a class="btn sm ghost icon pb-wide" href="${linkFor('packages', e)}" title="สมัครแพ็กเกจ" aria-label="สมัครแพ็กเกจ ${e.name}">${icon('wifi', 16)}</a>
              <button type="button" class="btn sm ghost icon pb-wide" data-edit="${e.id}" title="แก้ไข" aria-label="แก้ไข ${e.name}">${icon('edit', 16)}</button>
              <button type="button" class="btn sm ghost icon pb-wide" data-del="${e.id}" title="ลบ" aria-label="ลบ ${e.name}">${icon('trash', 16)}</button>
              <button type="button" class="btn sm ghost icon pb-more" data-more="${e.id}" aria-label="ตัวเลือกของ ${e.name}" title="ตัวเลือก">${icon('more', 18)}</button>
            </span>
          </div>`;
        })}</div>`
          : emptyState('book', 'ยังไม่มีเบอร์ในสมุดโทรศัพท์', 'เพิ่มเบอร์ของคุณ ครอบครัว หรือลูกค้าที่เติมบ่อย', html`<button class="btn primary sm" data-add>${icon('plus', 16)} เพิ่มเบอร์แรก</button>`)}
      </div>
      ${list.length ? html`<p class="xsmall muted mt-2 mb-0">แตะที่ชื่อเพื่อเติมเงินเบอร์นั้นได้ทันที (ยังต้องกดยืนยันก่อนตัดเงินทุกครั้ง)</p>` : ''}`);
  }

  async function load() {
    [list, recent] = await Promise.all([phonebookList(true), recentNumbers().catch(() => [])]);
    if (ctx.alive()) render();
  }

  async function editEntry(entry) {
    const r = await openForm(entry);
    if (r) { toast('แก้ไขแล้ว', 'success'); await load(); }
  }
  async function deleteEntry(entry) {
    const yes = await confirmDialog({ title: 'ลบรายชื่อ?', body: `ลบ "${entry.name}" (${phoneFmt(entry.phone)}) ออกจากสมุดโทรศัพท์`, confirmText: 'ลบ', danger: true });
    if (!yes) return;
    try {
      await api.del(`/api/phonebook/${entry.id}`);
      forgetPhonebook();
      toast('ลบแล้ว', 'success');
      await load();
    } catch (err) {
      toastError(err);
    }
  }

  on(ctx.view, 'click', '[data-add]', async () => {
    const r = await openForm(null);
    if (r) { toast('บันทึกเบอร์แล้ว', 'success'); await load(); }
  });
  on(ctx.view, 'click', '[data-edit]', (e, el) => {
    const entry = list.find((x) => String(x.id) === el.dataset.edit);
    if (entry) editEntry(entry);
  });
  on(ctx.view, 'click', '[data-del]', (e, el) => {
    const entry = list.find((x) => String(x.id) === el.dataset.del);
    if (entry) deleteEntry(entry);
  });
  // จอแคบ: ปุ่มทั้งหมดรวมไว้ในเมนู "⋯" (ชื่อไม่ถูกบีบจนอ่านไม่ออก)
  on(ctx.view, 'click', '[data-more]', async (e, el) => {
    const entry = list.find((x) => String(x.id) === el.dataset.more);
    if (!entry) return;
    const act = await modal({
      title: entry.name,
      body: html`<div class="num muted mb-2">${phoneFmt(entry.phone)}</div>
        <div class="action-list">
          <a class="btn block" href="${linkFor('topup', entry)}" data-close>${icon('bolt', 18)} เติมเงิน</a>
          <a class="btn block" href="${linkFor('packages', entry)}" data-close>${icon('wifi', 18)} สมัครแพ็กเกจ</a>
          <button type="button" class="btn block" data-act="edit">${icon('edit', 18)} แก้ไข</button>
          <button type="button" class="btn block text-danger" data-act="del">${icon('trash', 18)} ลบ</button>
        </div>`,
      onMount: (dlg, close) => on(dlg, 'click', '[data-act]', (ev, b) => close(b.dataset.act)),
    });
    if (act === 'edit') editEntry(entry);
    else if (act === 'del') deleteEntry(entry);
  });

  await load();
}
