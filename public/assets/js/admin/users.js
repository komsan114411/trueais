// ผู้ใช้: รายชื่อ, สร้างผู้ใช้, รายละเอียด + ปรับยอด/ระงับ/สิทธิ์/วงเงิน/รหัสผ่าน
import {
  html, api, baht, numFmt, dateTime, dateTimeSec, phoneFmt, statusBadge, netBadge, modal, confirmDialog, promptDialog,
  toast, toastError, withLoading, on, qs, formData, showFieldError, uuid, session,
} from '../lib.js';
import {
  icon, roleBadge, userStatusBadge, depositBadge, signedBaht, LEDGER_LABELS, pagerHtml, bindPager, setQuery, emptyRow, opt, registry, successRate,
  withReauth, bahtText,
} from './common.js';

const isSelf = (u) => Boolean(session.user && Number(u.id) === Number(session.user.id));
const who = (u) => `${u.name} (#${u.id}${u.role === 'admin' ? ' · แอดมิน' : ''})`;

// ตาราง = จอใหญ่ · การ์ด = มือถือ (cards-sm)
function usersTable(rows) {
  return html`<div class="table-wrap"><table class="table cards-sm">
    <thead><tr><th>#</th><th>ชื่อ</th><th>เบอร์ / อีเมล</th><th>สิทธิ์</th><th>สถานะ</th><th class="num">ยอดในกระเป๋า</th><th class="num">รายการ</th><th class="num">ใช้จ่ายรวม</th><th>เข้าระบบล่าสุด</th></tr></thead>
    <tbody>${rows.length ? rows.map((u) => html`<tr class="clickable" data-user="${u.id}">
      <td class="mono o5" data-label="เลขผู้ใช้">${u.id}</td>
      <td class="bold o1">${u.name}${isSelf(u) ? html` <span class="badge primary plain">คุณ</span>` : ''}</td>
      <td class="small o3">${u.phone ? phoneFmt(u.phone) : '-'}<span class="sub">${u.email || ''}</span></td>
      <td class="o6 r">${roleBadge(u.role)}</td>
      <td class="o4 r">${userStatusBadge(u)}${u.two_factor ? html` <span class="badge success plain" title="เปิดยืนยันตัวตน 2 ชั้นแล้ว">2FA</span>` : ''}</td>
      <td class="num o2 bold-sm">${baht(u.balance)}</td>
      <td class="num o7 left-sm" data-label="รายการ">${numFmt(u.order_count)}</td>
      <td class="num o8" data-label="ใช้จ่ายรวม">${baht(u.total_spent)}</td>
      <td class="small nowrap o9 full" data-label="เข้าระบบล่าสุด">${dateTime(u.last_login_at)}<span class="sub">${u.last_login_ip || ''}</span></td>
    </tr>`) : emptyRow(9, 'ไม่พบผู้ใช้')}</tbody></table></div>`;
}

function createUserDialog() {
  return modal({
    title: 'เพิ่มผู้ใช้',
    body: html`<form class="stack" data-form autocomplete="off">
      <div class="field"><label>ชื่อ</label><input class="input" name="name" required><div class="error-text"></div></div>
      <div class="form-grid">
        <div class="field"><label>เบอร์มือถือ</label><input class="input" name="phone" inputmode="tel" placeholder="08xxxxxxxx"><div class="help">ลูกค้าต้องมีเบอร์ (แอดมินใช้อีเมลอย่างเดียวได้)</div><div class="error-text"></div></div>
        <div class="field"><label>อีเมล</label><input class="input" name="email" type="email"><div class="error-text"></div></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>รหัสผ่าน</label><input class="input" name="password" type="text" minlength="8" placeholder="อย่างน้อย 8 ตัว มีตัวอักษร+ตัวเลข"><div class="error-text"></div></div>
        <div class="field"><label>สิทธิ์</label><select class="select" name="role">${opt('customer', 'ลูกค้า', 'customer')}${opt('admin', 'แอดมิน', '')}</select></div>
      </div>
    </form>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary" data-ok>${icon('plus')}สร้างผู้ใช้</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-form]');
      const btn = dlg.querySelector('[data-ok]');
      const submit = (e) => {
        e?.preventDefault();
        withLoading(btn, async () => {
          try {
            const body = formData(form);
            if (body.role === 'admin' && !(await confirmDialog({
              title: 'สร้างบัญชีแอดมิน',
              body: `ให้ "${body.name || '-'}" เป็นแอดมิน? จะเข้าหลังบ้านและจัดการเงิน/ผู้ใช้ได้ทั้งหมด`,
              confirmText: 'สร้างแอดมิน',
              danger: true,
            }))) return;
            // สร้างแอดมินใหม่ = ให้สิทธิ์แอดมิน → เซิร์ฟเวอร์อาจขอให้ยืนยันรหัสผ่านของคุณ
            const r = await withReauth((extra) => api.post('/api/admin/users', { ...body, ...extra }), { what: `สร้างบัญชี${body.role === 'admin' ? 'แอดมิน' : 'ผู้ใช้'} "${body.name || '-'}"` });
            if (r === null) return; // ยกเลิกการยืนยันตัวตน
            toast('สร้างผู้ใช้แล้ว', 'success');
            close(r.user);
          } catch (err) {
            if (!showFieldError(form, err)) toastError(err);
          }
        });
      };
      form.addEventListener('submit', submit);
      btn.addEventListener('click', submit);
      form.querySelector('[name="name"]').focus();
    },
  });
}

const LARGE_ADJUST_SATANG = 1000000; // 10,000 บาท — ตรงกับเซิร์ฟเวอร์ (ยอดสูงต้องยืนยันอีกชั้น)

/** ยืนยันชั้นที่ 2 สำหรับยอดสูง: ทวนจำนวนเงินทั้งตัวเลขและตัวอักษร (กันพิมพ์ศูนย์เกิน เช่น 100000 แทน 1000) */
function confirmLargeAdjust({ u, sign, satang, after, message }) {
  const verb = sign === '-' ? 'หักเงิน' : 'เพิ่มเงิน';
  return confirmDialog({
    title: `ยืนยันยอดสูง: ${verb} ${baht(satang)} บาท`,
    body: html`<div class="stack">
      ${message ? html`<div class="alert warning"><span class="alert-icon">!</span><div>${message}</div></div>` : ''}
      <div class="big-amount ${sign === '-' ? 'neg' : 'pos'}"><span class="num">${sign === '-' ? '−' : '+'}฿${baht(satang)}</span><span class="words">(${bahtText(satang)})</span></div>
      <p class="mb-0">${verb}${sign === '-' ? 'จาก' : 'เข้า'}กระเป๋าของ <b>${u.name}</b> (#${u.id}) · ยอดหลังปรับ <b class="num">${baht(after)}</b> บาท</p>
      <p class="small text-danger mb-0">อ่านตัวเลขทวนอีกครั้ง — ถ้าจำนวนไม่ตรงที่ตั้งใจ กด "ยกเลิก" แล้วแก้ตัวเลข</p>
    </div>`,
    confirmText: `ถูกต้อง — ${verb} ${baht(satang)} บาท`,
    cancelText: 'ยกเลิก (กลับไปแก้)',
    danger: true,
  });
}

async function adjustDialog(u) {
  if (isSelf(u)) {
    toast('ปรับยอดกระเป๋าของบัญชีตัวเองไม่ได้ — ให้แอดมินคนอื่นทำ', 'error', 6000);
    return false;
  }
  return modal({
    title: `ปรับยอดเงิน — ${u.name}`,
    body: html`<form class="stack" data-form novalidate>
      <p class="mb-0 small text-2">ยอดปัจจุบัน <b class="num">${baht(u.balance)}</b> บาท · ทุกการปรับยอดถูกบันทึกในสมุดบัญชีพร้อมชื่อแอดมินและเหตุผล</p>
      <div class="segmented" data-sign role="group" aria-label="เพิ่มหรือหักเงิน"><button type="button" class="active" data-v="+" aria-pressed="true">+ เพิ่มเงิน</button><button type="button" data-v="-" aria-pressed="false">− หักเงิน</button></div>
      <div class="field"><label for="adj-amount">จำนวนเงิน (บาท)</label><input class="input lg" id="adj-amount" name="amount" inputmode="decimal" placeholder="0.00" autocomplete="off">
        <div class="help" data-words></div><div class="error-text"></div></div>
      <div class="field"><label for="adj-note">เหตุผล (ลูกค้าไม่เห็น)</label><input class="input" id="adj-note" name="note" maxlength="300" placeholder="เช่น ชดเชยรายการผิดพลาด / รับเงินสดหน้าร้าน">
        <div class="help">บันทึกภายในสำหรับตรวจย้อนหลัง — ลูกค้าเห็นแค่ "ปรับยอดโดยผู้ดูแลระบบ"</div><div class="error-text"></div></div>
      <div class="alert danger hidden" data-form-error><span class="alert-icon">!</span><div data-form-error-text></div></div>
    </form>`,
    foot: html`<button class="btn" data-close>ยกเลิก</button><button class="btn primary" data-ok>บันทึก</button>`,
    onMount: (dlg, close) => {
      const form = dlg.querySelector('[data-form]');
      const errBox = form.querySelector('[data-form-error]');
      const words = form.querySelector('[data-words]');
      let sign = '+';
      const btn = dlg.querySelector('[data-ok]');
      const amountInput = form.querySelector('[name="amount"]');
      const noteInput = form.querySelector('[name="note"]');
      const parse = (amount) => {
        const [whole, frac = ''] = amount.split('.');
        return Number(whole) * 100 + Number(`${frac}00`.slice(0, 2));
      };
      // ทวนยอดเป็นตัวอักษรใต้ช่อง (อ่านแล้วรู้ทันทีถ้าพิมพ์ศูนย์เกิน)
      const updWords = () => {
        const a = amountInput.value.trim().replace(/,/g, '');
        if (!/^\d{1,7}(\.\d{1,2})?$/.test(a) || !(Number(a) > 0)) { words.textContent = ''; return; }
        const satang = parse(a);
        const over = sign === '-' && satang > u.balance;
        words.textContent = `${sign === '-' ? 'หัก' : 'เพิ่ม'} ${bahtText(satang)} · ยอดหลังปรับ ${over ? `ติดลบ — หักได้สูงสุด ${baht(u.balance)}` : baht(u.balance + (sign === '-' ? -satang : satang))} บาท${satang >= LARGE_ADJUST_SATANG ? ' · ยอดสูง: ต้องยืนยัน 2 ครั้ง' : ''}`;
        words.classList.toggle('text-danger', over || satang >= LARGE_ADJUST_SATANG);
      };
      on(dlg, 'click', '[data-sign] button', (e, b) => {
        sign = b.dataset.v;
        dlg.querySelectorAll('[data-sign] button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
        updWords();
      });
      amountInput.addEventListener('input', updWords);
      const fail = (field, message) => showFieldError(form, { message, details: { field } });
      const showErr = (message) => {
        form.querySelector('[data-form-error-text]').textContent = message;
        errBox.classList.remove('hidden');
      };
      // 1 หน้าต่าง = 1 คำขอ: ส่งซ้ำ (เน็ตหลุด/กดซ้ำ) ใช้ request_id เดิม → เซิร์ฟเวอร์ไม่ปรับยอดซ้ำ · เปิดหน้าต่างใหม่ = id ใหม่
      const requestId = uuid();
      const submit = (e) => {
        e?.preventDefault();
        errBox.classList.add('hidden');
        withLoading(btn, async () => {
          const amount = amountInput.value.trim().replace(/,/g, '');
          const note = noteInput.value.trim();
          // ตัวเลขบวกเท่านั้น (ทิศทางเลือกจากปุ่ม +/−) — กันพิมพ์ "-100" ตอนเลือก "เพิ่มเงิน" แล้วกลายเป็นหักเงิน
          if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount) || !(Number(amount) > 0)) { fail('amount', 'จำนวนเงินไม่ถูกต้อง (ตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง ไม่ต้องใส่เครื่องหมาย)'); return; }
          if (note.length < 3) { fail('note', 'กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร'); return; }
          const satang = parse(amount);
          // หักเกินยอดที่มี → แจ้งทันที (เซิร์ฟเวอร์ตรวจซ้ำด้วยยอดล่าสุดอีกครั้ง)
          if (sign === '-' && satang > u.balance) { fail('amount', `หักได้สูงสุด ${baht(u.balance)} บาท (ยอดคงเหลือของลูกค้า)`); return; }
          const after = u.balance + (sign === '-' ? -satang : satang);
          const body = { amount: `${sign === '-' ? '-' : ''}${amount}`, note, request_id: requestId };
          try {
            const ok = await confirmDialog({
              title: sign === '-' ? 'ยืนยันหักเงิน' : 'ยืนยันเพิ่มเงิน',
              body: html`<p class="mb-0">${sign === '-' ? 'หักเงิน' : 'เพิ่มเงิน'} <b class="num">${baht(satang)} บาท</b> (${bahtText(satang)}) ${sign === '-' ? 'จาก' : 'เข้า'}กระเป๋าของ <b>${u.name}</b> (#${u.id})<br>
                ยอดปัจจุบัน ${baht(u.balance)} → <b class="num">${baht(after)}</b> บาท · เหตุผล (ภายใน): ${note}</p>`,
              confirmText: `${sign === '-' ? 'หักเงิน' : 'เพิ่มเงิน'} ${baht(satang)} บาท`,
              danger: true,
            });
            if (!ok) return;
            let r;
            try {
              r = await api.post(`/api/admin/users/${u.id}/adjust`, body);
            } catch (err) {
              if (err.code !== 'LARGE_ADJUST') throw err;
              // ยอดสูง (≥ 10,000 บาท) → ยืนยันอีกชั้นด้วยตัวอักษร แล้วส่งคำขอเดิม (request_id เดิม) พร้อม confirm_large
              if (!(await confirmLargeAdjust({ u, sign, satang, after, message: err.message }))) return;
              r = await api.post(`/api/admin/users/${u.id}/adjust`, { ...body, confirm_large: true });
            }
            if (r.existing) toast(`รายการนี้ถูกปรับไปแล้ว (ไม่ได้ปรับซ้ำ) — ยอดคงเหลือ ${baht(r.balance)} บาท`, 'warning', 7000);
            else toast(`บันทึกแล้ว ยอดคงเหลือ ${baht(r.balance)} บาท`, 'success');
            close(true);
          } catch (err) {
            if (err.code === 'REQUEST_MISMATCH') {
              // คำขอนี้ (หน้าต่างนี้) เคยปรับยอดด้วยจำนวนอื่นไปแล้ว → ห้ามส่งต่อ ให้ตรวจสมุดบัญชีก่อนเปิดหน้าต่างใหม่
              toast(`${err.message} — การปรับยอดครั้งก่อนจากหน้าต่างนี้สำเร็จแล้ว กรุณาตรวจสมุดบัญชีก่อนปรับใหม่`, 'error', 9000);
              close(true);
              return;
            }
            if (err.code === 'INSUFFICIENT_BALANCE') {
              fail('amount', `ยอดคงเหลือของลูกค้าไม่พอ — หักได้สูงสุด ${baht(err.details?.have ?? u.balance)} บาท`);
              return;
            }
            // ข้อความชัดเจนจากเซิร์ฟเวอร์ (เช่น หักเกินยอด / ปรับยอดตัวเอง) — แสดงในหน้าต่างเลย ไม่หายไปเอง
            if (!showFieldError(form, err)) showErr(err.message || 'บันทึกไม่สำเร็จ');
          }
        });
      };
      form.addEventListener('submit', submit);
      btn.addEventListener('click', submit);
      amountInput.focus();
    },
  });
}

function detailBody(d) {
  const u = d.user;
  const s = d.stats;
  const locked = u.locked_until && Date.parse(u.locked_until) > Date.now();
  return html`<div class="adm-detail stack" style="--gap:14px">
    <div class="detail-head">
      <span class="ref" style="font-family:inherit">${u.name}</span>${roleBadge(u.role)}${userStatusBadge(u)}${u.two_factor ? html`<span class="badge success plain">2FA</span>` : ''}
      <span class="muted small">#${u.id} · สมัครเมื่อ ${dateTime(u.created_at)}</span>
    </div>
    <div class="kpis">
      <div class="stat"><div class="stat-label">ยอดในกระเป๋า</div><div class="stat-value">฿${baht(u.balance)}</div></div>
      <div class="stat"><div class="stat-label">ใช้จ่ายสำเร็จรวม</div><div class="stat-value">฿${baht(s.spent)}</div><div class="stat-sub">กำไรจากลูกค้านี้ ฿${baht(s.profit)}</div></div>
      <div class="stat"><div class="stat-label">รายการทั้งหมด</div><div class="stat-value">${numFmt(s.orders)}</div><div class="stat-sub">อัตราสำเร็จ ${successRate(s)}</div></div>
    </div>
    ${isSelf(u)
      // บัญชีตัวเอง: ปรับยอด/ระงับ/เปลี่ยนสิทธิ์ตัวเองไม่ได้ · รหัสผ่านและยืนยัน 2 ชั้นของตัวเอง แก้ที่หน้าบัญชีของฉัน
      ? html`<div class="action-bar">
          <span class="small text-2 grow">นี่คือบัญชีของคุณ — ปรับยอดกระเป๋า / ระงับ / เปลี่ยนสิทธิ์บัญชีตัวเองไม่ได้ (ให้แอดมินคนอื่นทำ)</span>
          <a class="btn sm primary" href="/#/account" target="_blank" rel="noopener">${icon('shield')}รหัสผ่าน / ยืนยันตัวตน 2 ชั้น ${icon('external')}</a>
          <button class="btn sm" data-act="limit">ตั้งวงเงินต่อวัน</button>
          <a class="btn sm ghost" href="#/orders?userId=${u.id}" data-nav>ดูรายการทั้งหมด</a>
        </div>`
      : html`<div class="action-bar">
      <button class="btn sm primary" data-act="adjust">${icon('wallet')}ปรับยอดเงิน</button>
      ${u.status === 'active'
        ? html`<button class="btn sm danger" data-act="suspend">${icon('x')}ระงับบัญชี</button>`
        : html`<button class="btn sm success" data-act="activate">${icon('check')}เปิดใช้งาน</button>`}
      ${locked ? html`<button class="btn sm" data-act="activate">ปลดล็อก</button>` : ''}
      <button class="btn sm" data-act="limit">ตั้งวงเงินต่อวัน</button>
      <button class="btn sm" data-act="password">ตั้งรหัสผ่านใหม่</button>
      ${u.two_factor ? html`<button class="btn sm danger" data-act="reset2fa">รีเซ็ตการยืนยัน 2 ชั้น</button>` : ''}
      <button class="btn sm" data-act="role">${u.role === 'admin' ? 'เปลี่ยนเป็นลูกค้า' : 'ตั้งเป็นแอดมิน'}</button>
      <a class="btn sm ghost" href="#/orders?userId=${u.id}" data-nav>ดูรายการทั้งหมด</a>
      <a class="btn sm ghost" href="#/api-keys?user=${u.id}" data-nav>${icon('key')}API key</a>
      ${u.role === 'admin' ? html`<div class="small text-2 w-100">${icon('shield')} บัญชีแอดมิน: ตั้งรหัสผ่านใหม่ / รีเซ็ต 2 ชั้น / ระงับ / เปลี่ยนสิทธิ์ ต้องยืนยันรหัสผ่านของคุณอีกครั้ง</div>` : ''}
    </div>`}
    <div class="detail-section"><dl class="dl">
      <dt>เบอร์</dt><dd>${u.phone ? phoneFmt(u.phone) : '-'}</dd>
      <dt>อีเมล</dt><dd>${u.email || '-'}</dd>
      <dt>ยืนยันตัวตน 2 ชั้น</dt><dd>${u.two_factor ? html`<span class="text-success">เปิดใช้อยู่</span>` : html`<span class="muted">ยังไม่เปิด</span>`}</dd>
      <dt>วงเงินต่อวัน</dt><dd>${u.daily_limit === null || u.daily_limit === undefined ? 'ตามค่าเริ่มต้นของระบบ' : u.daily_limit === 0 ? 'ไม่จำกัด' : `${baht(u.daily_limit)} บาท`}</dd>
      <dt>เข้าระบบล่าสุด</dt><dd>${dateTimeSec(u.last_login_at)} ${u.last_login_ip ? html`<span class="muted">(${u.last_login_ip})</span>` : ''}</dd>
      ${locked ? html`<dt>ล็อกถึง</dt><dd class="text-danger">${dateTimeSec(u.locked_until)} (ใส่รหัสผิดเกินกำหนด)</dd>` : ''}
    </dl></div>
    <div class="detail-section"><h4>รายการล่าสุด</h4><div class="table-wrap"><table class="table">
      <thead><tr><th>เวลา</th><th>รายการ</th><th>เบอร์</th><th class="num">ราคา</th><th>สถานะ</th></tr></thead>
      <tbody>${d.orders.length ? d.orders.map((o) => html`<tr class="clickable" data-ref="${o.ref}">
        <td class="small nowrap">${dateTime(o.created_at)}</td>
        <td><div class="item">${netBadge(o.network)}<span class="truncate" style="max-width:220px">${o.product_name}</span></div></td>
        <td class="num nowrap">${phoneFmt(o.phone)}</td><td class="num">${baht(o.price)}</td><td>${statusBadge(o.status, o.status_label)}</td>
      </tr>`) : emptyRow(5, 'ยังไม่มีรายการ')}</tbody></table></div></div>
    <div class="detail-section"><h4>สมุดบัญชี (ล่าสุด)</h4><div data-ledger></div></div>
    <div class="detail-section"><h4>เติมเงินเข้ากระเป๋า (ล่าสุด)</h4><div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>เวลา</th><th class="num">ยอด</th><th>สถานะ</th><th>หมายเหตุ</th></tr></thead>
      <tbody>${d.deposits.length ? d.deposits.map((x) => html`<tr>
        <td class="mono">${x.id}</td><td class="small nowrap">${dateTime(x.created_at)}</td><td class="num">${baht(x.amount)}</td>
        <td>${depositBadge(x.status, x.status_label)}</td><td class="small">${x.admin_note || x.note || ''}</td>
      </tr>`) : emptyRow(5, 'ยังไม่มีรายการ')}</tbody></table></div></div>
  </div>`;
}

function ledgerTable(res) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>เวลา</th><th>ประเภท</th><th class="num">จำนวน</th><th class="num">คงเหลือ</th><th>อ้างอิง / หมายเหตุ</th></tr></thead>
    <tbody>${res.rows.length ? res.rows.map((l) => html`<tr>
      <td class="small nowrap">${dateTimeSec(l.created_at)}</td>
      <td>${l.type_label || LEDGER_LABELS[l.type] || l.type}</td>
      <td class="num">${signedBaht(l.amount)}</td>
      <td class="num">${baht(l.balance_after)}</td>
      <td class="small">${l.order_ref ? html`<span class="mono">${l.order_ref}</span> ` : ''}${l.note || ''}${l.actor_name ? html`<span class="sub">โดย ${l.actor_name}</span>` : ''}</td>
    </tr>`) : emptyRow(5, 'ยังไม่มีการเคลื่อนไหว')}</tbody></table></div>${pagerHtml(res)}`;
}

async function userAction(act, u) {
  const base = `/api/admin/users/${u.id}`;
  // คำสั่งที่มีผลกับบัญชีแอดมิน / ให้สิทธิ์แอดมิน → เซิร์ฟเวอร์ขอรหัสผ่านของผู้ทำรายการ (REAUTH_REQUIRED) แล้วส่งซ้ำให้อัตโนมัติ
  const post = (path, body, what) => withReauth((extra) => api.post(`${base}${path}`, { ...body, ...extra }), { what });
  if (act === 'adjust') return adjustDialog(u);
  if (act === 'suspend') {
    if (!(await confirmDialog({ title: 'ระงับบัญชี', body: `${who(u)} จะเข้าสู่ระบบและทำรายการไม่ได้ (ออกจากระบบทุกอุปกรณ์ทันที) — ยอดเงินในกระเป๋ายังอยู่`, confirmText: 'ระงับบัญชี', danger: true }))) return false;
    if ((await post('/status', { status: 'suspended' }, `ระงับบัญชี ${who(u)}`)) === null) return false;
    toast('ระงับบัญชีแล้ว', 'success');
    return true;
  }
  if (act === 'activate') {
    const suspended = u.status === 'suspended';
    if (!(await confirmDialog({
      title: suspended ? 'เปิดใช้งานบัญชี' : 'ปลดล็อกบัญชี',
      body: `${suspended ? 'เปิดใช้งานบัญชี' : 'ปลดล็อกการเข้าสู่ระบบของ'} ${who(u)}? ผู้ใช้จะเข้าสู่ระบบและทำรายการได้ทันที`,
      confirmText: suspended ? 'เปิดใช้งาน' : 'ปลดล็อก',
    }))) return false;
    if ((await post('/status', { status: 'active' }, `${suspended ? 'เปิดใช้งาน' : 'ปลดล็อก'}บัญชี ${who(u)}`)) === null) return false;
    toast('เปิดใช้งาน/ปลดล็อกแล้ว', 'success');
    return true;
  }
  if (act === 'limit') {
    const v = await promptDialog({
      title: 'วงเงินใช้จ่ายต่อวัน',
      label: `${u.name} — จำนวนบาทต่อวัน (เว้นว่าง = ใช้ค่าเริ่มต้นของระบบ, 0 = ไม่จำกัด)`,
      value: u.daily_limit === null || u.daily_limit === undefined ? '' : String(u.daily_limit / 100),
      placeholder: 'เช่น 5000',
      confirmText: 'บันทึก',
    });
    if (v === null) return false;
    const num = v.replace(/,/g, '');
    // ตัวเลขไม่ถูกต้อง (เช่น "5,000 บาท") ห้ามส่ง — เดิมจะกลายเป็น null = กลับไปใช้ค่าเริ่มต้นโดยไม่รู้ตัว
    if (num !== '' && !/^\d{1,9}(\.\d{1,2})?$/.test(num)) {
      toast('วงเงินไม่ถูกต้อง — กรอกเป็นตัวเลข (บาท) เว้นว่าง หรือ 0', 'error');
      return false;
    }
    await api.post(`${base}/limit`, { daily_limit_baht: num === '' ? null : Number(num) });
    toast('บันทึกวงเงินแล้ว', 'success');
    return true;
  }
  if (act === 'password') {
    const pw = await promptDialog({ title: 'ตั้งรหัสผ่านใหม่', label: `รหัสผ่านใหม่ของ ${who(u)} (อย่างน้อย 8 ตัว มีตัวอักษรและตัวเลข) — ผู้ใช้จะถูกออกจากระบบทุกอุปกรณ์`, confirmText: 'ตั้งรหัสผ่าน', required: true });
    if (pw === null) return false;
    if ((await post('/password', { password: pw }, `ตั้งรหัสผ่านใหม่ให้ ${who(u)}`)) === null) return false;
    toast('ตั้งรหัสผ่านใหม่แล้ว แจ้งผู้ใช้ทางช่องทางที่ปลอดภัย', 'success', 5000);
    return true;
  }
  if (act === 'reset2fa') {
    const ok = await confirmDialog({
      title: 'รีเซ็ตการยืนยันตัวตน 2 ชั้น',
      body: `ปิดการยืนยันตัวตน 2 ชั้นของ ${who(u)}? ใช้เมื่อผู้ใช้ทำโทรศัพท์หาย/ลบแอป และยืนยันตัวตนเจ้าของบัญชีแล้วเท่านั้น — ผู้ใช้จะถูกออกจากระบบทุกอุปกรณ์ทันที และเข้าสู่ระบบได้ด้วยรหัสผ่านอย่างเดียวจนกว่าจะเปิดใหม่`,
      confirmText: 'รีเซ็ตและออกจากระบบทุกอุปกรณ์',
      danger: true,
    });
    if (!ok) return false;
    if ((await post('/2fa/reset', {}, `รีเซ็ตการยืนยันตัวตน 2 ชั้นของ ${who(u)}`)) === null) return false;
    toast('รีเซ็ตการยืนยันตัวตน 2 ชั้นแล้ว — ผู้ใช้ถูกออกจากระบบทุกอุปกรณ์', 'success', 6000);
    return true;
  }
  if (act === 'role') {
    const next = u.role === 'admin' ? 'customer' : 'admin';
    const ok = await confirmDialog({
      title: 'เปลี่ยนสิทธิ์',
      body: next === 'admin' ? `ให้ ${who(u)} เป็นแอดมิน? จะเข้าหลังบ้านและจัดการเงิน/ผู้ใช้ได้ทั้งหมด` : `เปลี่ยน ${who(u)} เป็นลูกค้า? จะเข้าหลังบ้านไม่ได้อีก`,
      confirmText: next === 'admin' ? 'ตั้งเป็นแอดมิน' : 'เปลี่ยนเป็นลูกค้า',
      danger: true,
    });
    if (!ok) return false;
    if ((await post('/role', { role: next }, next === 'admin' ? `ตั้ง ${who(u)} เป็นแอดมิน` : `ปลด ${who(u)} จากแอดมิน`)) === null) return false;
    toast('เปลี่ยนสิทธิ์แล้ว', 'success');
    return true;
  }
  return false;
}

export function openUserDetail(id, { onChange } = {}) {
  return modal({
    title: 'ข้อมูลผู้ใช้',
    wide: true,
    body: html`<div data-detail><div class="row"><span class="spinner"></span><span class="muted">กำลังโหลด...</span></div></div>`,
    onMount: (dlg, close) => {
      const box = dlg.querySelector('[data-detail]');
      let current = null;
      let ledgerPage = 1;
      const loadLedger = async () => {
        const res = await api.get(`/api/admin/users/${id}/ledger${qs({ page: ledgerPage })}`);
        const lb = box.querySelector('[data-ledger]');
        if (lb) lb.innerHTML = ledgerTable(res).toString();
      };
      const load = async () => {
        try {
          current = await api.get(`/api/admin/users/${id}`);
          box.innerHTML = detailBody(current).toString();
          await loadLedger();
        } catch (err) {
          box.innerHTML = html`<div class="alert danger">${err.message}</div>`.toString();
        }
      };
      let acting = false; // ทำได้ทีละคำสั่ง (กันกดซ้ำระหว่างรอผล)
      on(box, 'click', '[data-act]', async (e, b) => {
        if (!current || acting) return;
        acting = true;
        try {
          const changed = await userAction(b.dataset.act, current.user);
          if (changed) { await load(); onChange?.(); }
        } catch (err) { toastError(err); } finally { acting = false; }
      });
      on(box, 'click', 'tr[data-ref]', (e, tr) => {
        close();
        registry.openOrder(tr.dataset.ref);
      });
      on(box, 'click', '[data-nav]', () => close());
      on(box, 'click', '[data-ledger] [data-page]', (e, b) => {
        e.stopPropagation();
        ledgerPage = Number(b.dataset.page) || 1;
        loadLedger().catch(toastError);
      });
      load();
    },
  });
}
registry.openUser = (id, opts) => openUserDetail(id, opts);

export async function render(el, params, query) {
  const q = { q: query.q || '', role: query.role || '', status: query.status || '', page: query.page || 1 };
  el.innerHTML = html`
    <form class="card filter-card toolbar" data-filter>
      <div class="field grow"><label>ค้นหา</label><input class="input" name="q" value="${q.q}" placeholder="ชื่อ, เบอร์, อีเมล หรือเลขผู้ใช้"></div>
      <div class="field"><label>สิทธิ์</label><select class="select" name="role">${opt('', 'ทั้งหมด', q.role)}${opt('customer', 'ลูกค้า', q.role)}${opt('admin', 'แอดมิน', q.role)}</select></div>
      <div class="field"><label>สถานะ</label><select class="select" name="status">${opt('', 'ทั้งหมด', q.status)}${opt('active', 'ใช้งาน', q.status)}${opt('suspended', 'ระงับ', q.status)}</select></div>
      <div class="row"><button class="btn primary" type="submit">${icon('search')}ค้นหา</button><button class="btn" type="button" data-create>${icon('plus')}เพิ่มผู้ใช้</button></div>
    </form>
    <section class="card flush" data-list><div class="empty"><span class="spinner"></span></div></section>`.toString();

  const form = el.querySelector('[data-filter]');
  const load = async () => {
    try {
      const res = await api.get(`/api/admin/users${qs({ ...q, pageSize: 25 })}`);
      el.querySelector('[data-list]').innerHTML = html`${usersTable(res.rows)}${pagerHtml(res)}`.toString();
    } catch (err) {
      el.querySelector('[data-list]').innerHTML = html`<div class="empty"><div class="alert danger">${err.message}</div></div>`.toString();
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setQuery('/users', Object.fromEntries(Object.entries(formData(form)).filter(([, v]) => v)));
  });
  el.querySelector('[data-create]').addEventListener('click', async () => {
    const u = await createUserDialog();
    if (u) { await load(); openUserDetail(u.id, { onChange: load }); }
  });
  on(el, 'click', 'tr[data-user]', (e, tr) => openUserDetail(Number(tr.dataset.user), { onChange: load }));
  bindPager(el.querySelector('[data-list]'), (p) => setQuery('/users', { ...q, page: p }));
  await load();
}
