// หน้าต่างเลือกเบอร์ (ใช้ในหน้าเติมเงิน / แพ็กเกจ): เบอร์ที่เคยเติมล่าสุด + สมุดโทรศัพท์ — กดเลือกได้เลย ไม่ต้องพิมพ์
import { html, modal, phoneFmt, on, setHTML, toastError, timeAgo } from '../lib.js';
import { netTag, emptyState } from './ui.js';
import { recentNumbers, phonebookList, networkOf } from './state.js';

export async function pickFromPhonebook() {
  let book;
  let recent;
  try {
    [book, recent] = await Promise.all([phonebookList(true), recentNumbers(true)]);
  } catch (err) {
    toastError(err);
    return null;
  }
  const saved = new Set(book.map((e) => e.phone));
  const histOf = (phone) => recent.find((x) => x.phone === phone) || null;
  /** เครือข่ายในสมุดไม่ตรงกับที่เคยเติมสำเร็จล่าสุด (ข้อมูลในสมุดอาจเก่า เช่น ย้ายค่ายแล้ว) */
  const conflictOf = (e) => {
    const h = histOf(e.phone);
    return e.network && h?.network_confirmed && h.network !== e.network && networkOf(h.network) ? h : null;
  };
  // เบอร์ล่าสุดที่ยังไม่ได้บันทึกในสมุด (เบอร์ที่บันทึกแล้วแสดงในส่วนสมุดโทรศัพท์)
  const fresh = recent.filter((r) => !saved.has(r.phone));
  const total = book.length + fresh.length;
  const result = await modal({
    title: 'เลือกเบอร์',
    body: total
      ? html`${total > 6 ? html`<input class="input mb-2" data-search type="search" placeholder="ค้นหาชื่อหรือเบอร์" autocomplete="off" aria-label="ค้นหาชื่อหรือเบอร์">` : ''}<div class="pick-list" data-list></div>
        <p class="xsmall muted mt-2 mb-0">บันทึกเบอร์ที่เติมบ่อยพร้อมชื่อเรียกได้ที่ <a href="#/phonebook" data-close>สมุดโทรศัพท์</a></p>`
      : emptyState('book', 'ยังไม่มีเบอร์ให้เลือก', 'เบอร์ที่เคยเติมจะแสดงที่นี่อัตโนมัติ หรือบันทึกเบอร์ที่เติมบ่อยไว้ในสมุดโทรศัพท์',
        html`<a class="btn soft sm" href="#/phonebook" data-close>ไปที่สมุดโทรศัพท์</a>`),
    onMount: (dlg, close) => {
      if (!total) return;
      const listEl = dlg.querySelector('[data-list]');
      const search = dlg.querySelector('[data-search]');
      const match = (q, name, phone) => !q || String(name || '').toLowerCase().includes(q) || phone.includes(q);
      const render = () => {
        const q = (search?.value || '').trim().toLowerCase().replace(/[-\s]/g, '');
        const r = fresh.filter((e) => match(q, e.name, e.phone));
        const b = book.filter((e) => match(q, e.name, e.phone));
        setHTML(listEl, r.length || b.length
          ? html`${r.length ? html`<div class="pick-section">เบอร์ที่เคยเติมล่าสุด</div>${r.map((e) => html`<button type="button" class="pick-item" data-recent="${e.phone}">
              <span class="pick-avatar">${e.phone.slice(-2)}</span>
              <span class="grow"><span class="num bold d-block">${phoneFmt(e.phone)}</span><span class="muted xsmall">${timeAgo(e.last_at)} · ${e.count} รายการ${e.network_confirmed ? '' : ' · ยังไม่เคยสำเร็จ'}</span></span>
              ${e.network && e.network_confirmed ? netTag(e.network) : ''}
            </button>`)}` : ''}
            ${b.length ? html`<div class="pick-section">สมุดโทรศัพท์</div>${b.map((e) => {
              const c = conflictOf(e);
              return html`<button type="button" class="pick-item" data-id="${e.id}">
                <span class="pick-avatar">${e.name.charAt(0)}</span>
                <span class="grow"><span class="bold d-block">${e.name}</span><span class="num muted small">${phoneFmt(e.phone)}</span>
                  ${c ? html`<span class="xsmall text-warning d-block">บันทึกไว้เป็น ${networkOf(e.network)?.name || e.network} แต่เติม ${networkOf(c.network).name} สำเร็จล่าสุด</span>` : ''}</span>
                ${c ? netTag(c.network) : e.network ? netTag(e.network) : ''}
              </button>`;
            })}` : ''}`
          : html`<div class="muted small center p-2">ไม่พบเบอร์ที่ค้นหา</div>`);
      };
      search?.addEventListener('input', render);
      render();
      on(listEl, 'click', '[data-id]', (e, el) => {
        const entry = book.find((x) => String(x.id) === el.dataset.id);
        if (!entry) return;
        const hist = histOf(entry.phone);
        const c = conflictOf(entry);
        // เครือข่ายในสมุดขัดกับที่เคยเติมสำเร็จ → ใช้เครือข่ายที่สำเร็จ (บอกลูกค้าในหน้าเติมเงิน)
        if (c) close({ ...entry, network: c.network, network_confirmed: true, source: 'pick', saved_network: entry.network });
        // สมุดไม่ได้ระบุเครือข่าย → ใช้ข้อมูลเบอร์ล่าสุด (เลือกให้เฉพาะเครือข่ายที่เคยเติมสำเร็จ)
        else if (!entry.network && hist?.network) close({ ...entry, network: hist.network, network_confirmed: hist.network_confirmed, shop: hist.shop, source: 'recent' });
        else close({ ...entry, shop: hist?.shop || null, source: 'book' });
      });
      on(listEl, 'click', '[data-recent]', (e, el) => close({ ...fresh.find((x) => x.phone === el.dataset.recent), source: 'recent' }));
      if (search && window.matchMedia('(pointer: fine)').matches) search.focus();
    },
  });
  return result || null;
}
