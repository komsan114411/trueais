// หน้าต่างเลือกเบอร์จากสมุดโทรศัพท์ (ใช้ในหน้าเติมเงิน / แพ็กเกจ)
import { html, api, modal, phoneFmt, on, setHTML, toastError } from '../lib.js';
import { netTag, emptyState } from './ui.js';

export async function pickFromPhonebook() {
  let list;
  try {
    list = await api.get('/api/phonebook');
  } catch (err) {
    toastError(err);
    return null;
  }
  const result = await modal({
    title: 'เลือกจากสมุดโทรศัพท์',
    body: list.length
      ? html`<input class="input mb-2" data-search placeholder="ค้นหาชื่อหรือเบอร์" autocomplete="off"><div class="pick-list" data-list></div>`
      : emptyState('book', 'ยังไม่มีเบอร์ในสมุดโทรศัพท์', 'บันทึกเบอร์ที่เติมบ่อยไว้ เพื่อเลือกได้รวดเร็วและไม่พิมพ์ผิด',
        html`<a class="btn soft sm" href="#/phonebook" data-close>ไปที่สมุดโทรศัพท์</a>`),
    onMount: (dlg, close) => {
      if (!list.length) return;
      const listEl = dlg.querySelector('[data-list]');
      const search = dlg.querySelector('[data-search]');
      const render = () => {
        const q = search.value.trim().toLowerCase().replace(/[-\s]/g, '');
        const items = list.filter((e) => !q || e.name.toLowerCase().includes(q) || e.phone.includes(q));
        setHTML(listEl, items.length
          ? items.map((e) => html`<button type="button" class="pick-item" data-id="${e.id}">
              <span class="pick-avatar">${e.name.charAt(0)}</span>
              <span class="grow"><span class="bold d-block">${e.name}</span><span class="num muted small">${phoneFmt(e.phone)}</span></span>
              ${e.network ? netTag(e.network) : ''}
            </button>`)
          : html`<div class="muted small center p-2">ไม่พบเบอร์ที่ค้นหา</div>`);
      };
      search.addEventListener('input', render);
      render();
      on(listEl, 'click', '[data-id]', (e, el) => close(list.find((x) => String(x.id) === el.dataset.id)));
      if (window.matchMedia('(pointer: fine)').matches) search.focus();
    },
  });
  return result || null;
}
