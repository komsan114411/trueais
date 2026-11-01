// เลือกเครือข่ายให้ตรงกับเบอร์ (ใช้ในหน้าเติมเงิน / แพ็กเกจ) — กันเติมผิดเครือข่าย
// กติกา:
//  - เบอร์ที่ไม่เคยเติม → ไม่เลือกให้ ให้ลูกค้าเลือกเอง ("เลือกเครือข่ายของเบอร์นี้")
//  - เบอร์ที่เคยเติมสำเร็จ → เลือกเครือข่ายที่ "สำเร็จ" ล่าสุดให้ พร้อมบอกที่มา (ไม่ใช้รายการล่าสุดที่อาจไม่สำเร็จ)
//  - เปลี่ยนเบอร์ → ล้างเครือข่ายที่ระบบเลือกให้ · ที่ลูกค้าเลือกเองใช้ได้เฉพาะกับเบอร์ที่เลือกไว้
//  - เครือข่ายที่เลือกไม่ตรงกับที่เคยเติมสำเร็จ → เตือน + ปุ่มเปลี่ยนในแตะเดียว (ไม่สลับให้เงียบๆ)
import { html, raw, normalizePhone } from '../lib.js';
import { state, networkOf, netVars, phoneHistory } from './state.js';
import { alertBox, shortDate } from './ui.js';
import { icon } from './icons.js';

/**
 * @param {object} o
 * @param {object} o.ctx           บริบทหน้า (alive)
 * @param {'topup'|'package'} o.kind
 * @param {string} [o.network]     เครือข่ายจากลิงก์ (เช่น "เติมอีกครั้ง") — ลิงก์ระบุมา = ไม่สลับเอง
 * @param {string} [o.phone]       เบอร์จากลิงก์ (เครือข่ายในลิงก์ใช้กับเบอร์นี้)
 * @param {string} [o.retry]       เครือข่ายของรายการที่ไม่สำเร็จ (ลองใหม่ → ให้เลือกเครือข่ายใหม่ ไม่เลือกให้)
 * @param {(why: string) => void} o.onUpdate  เรียกเมื่อเครือข่าย/ข้อความแนะนำเปลี่ยน → หน้าวาดใหม่
 */
export function netChoice({ ctx, kind, network, phone, retry, onUpdate }) {
  const openOf = (n) => Boolean(n && (kind === 'package' ? n.package.open : n.topup.open));
  const closedText = (n) => n.notice || (kind === 'package' ? `${n.name} ปิดรับสมัครแพ็กเกจชั่วคราว` : `${n.name} ปิดให้บริการเติมเงินชั่วคราว`);
  const linkPhone = normalizePhone(phone);
  const qNet = network ? networkOf(network) : null;

  const self = {
    code: qNet?.code || null,
    // ที่มาของเครือข่ายที่เลือก: link (จากลิงก์) | user (ลูกค้าแตะเลือก) | pick (เบอร์ล่าสุดที่เคยสำเร็จ) | book (สมุดโทรศัพท์) | auto (ระบบเลือกจากประวัติ)
    source: qNet ? 'link' : null,
    bound: qNet ? linkPhone : null, // เบอร์ที่เลือกเครือข่ายนี้ไว้ (null = ใช้กับเบอร์แรกที่กรอกครบ)
    phone: null,
    hist: undefined, // ประวัติของเบอร์ปัจจุบัน (undefined = ยังไม่รู้)
    missing: network && !qNet ? String(network).slice(0, 20) : null, // เครือข่ายในลิงก์ที่ไม่มีให้บริการแล้ว
    retry: retry && !qNet ? { network: String(retry).toUpperCase().slice(0, 20), phone: linkPhone } : null,
    saved: null, // เครือข่ายในสมุดโทรศัพท์ที่ไม่ตรงกับที่เคยเติมสำเร็จ (เปลี่ยนให้แล้ว)
    unconfirmed: null, // เลือกเบอร์ล่าสุดที่ยังไม่เคยสำเร็จ: เครือข่ายของครั้งก่อน (ไม่เลือกให้)
    flash: null, // ข้อความชั่วคราว (เช่น แตะเครือข่ายที่ปิดอยู่)
    attention: false, // ไฮไลต์ "เลือกเครือข่ายของเบอร์นี้" (กดยืนยันโดยยังไม่เลือก)

    /** ลูกค้าเลือกเอง (ไม่ได้มาจากการเดาของระบบ) → ใส่ใน URL ได้ */
    get explicit() { return Boolean(self.code) && self.source !== 'auto'; },

    setPhone(p) {
      if (p === self.phone) return;
      self.phone = p;
      self.hist = undefined;
      self.flash = null;
      self.unconfirmed = null;
      if (p && self.retry?.phone && self.retry.phone !== p) self.retry = null; // เปลี่ยนเป็นเบอร์อื่นแล้ว
      if (self.source === 'auto') {
        // ระบบเลือกให้ตามประวัติของเบอร์เดิม → เบอร์เปลี่ยน ต้องดูใหม่
        self.code = null;
        self.source = null;
        self.bound = null;
        self.saved = null;
      } else if (self.source && p) {
        if (!self.bound) self.bound = p; // เลือกไว้ก่อนกรอกเบอร์ → ใช้กับเบอร์นี้
        else if (self.bound !== p) { self.code = null; self.source = null; self.bound = null; self.saved = null; } // เลือกไว้สำหรับเบอร์อื่น
      }
      if (p) self.attention = false;
      onUpdate('phone');
      if (p) lookup(p);
    },

    /** ลูกค้าแตะเลือกเครือข่าย */
    choose(code) {
      const n = networkOf(code);
      if (!n) return false;
      if (!openOf(n)) {
        self.flash = { type: 'warning', text: closedText(n) };
        onUpdate('closed');
        return false;
      }
      self.code = n.code;
      self.source = 'user';
      self.bound = self.phone;
      self.missing = null;
      self.saved = null;
      self.flash = null;
      self.attention = false;
      onUpdate('choose');
      return true;
    },

    /** เลือกเบอร์จากเบอร์ล่าสุด / สมุดโทรศัพท์ (เรียกหลัง setPhone) */
    pick(entry) {
      if (!entry) return;
      const n = entry.network ? networkOf(entry.network) : null;
      self.flash = null;
      self.saved = entry.saved_network && entry.saved_network !== entry.network ? entry.saved_network : null;
      self.unconfirmed = null;
      if (entry.source === 'recent' && !entry.network_confirmed) {
        // ยังไม่เคยเติมสำเร็จ → ไม่เลือกให้ (ครั้งก่อนอาจเลือกผิดเครือข่าย) — คงไว้เฉพาะที่ลูกค้าเลือกเองสำหรับเบอร์นี้
        self.unconfirmed = entry.network || null;
        if (!(self.source === 'user' && self.bound === self.phone)) { self.code = null; self.source = null; self.bound = null; }
      } else if (n) {
        self.code = n.code;
        self.source = entry.source === 'recent' ? 'pick' : 'book';
        self.bound = self.phone;
        self.missing = null;
      } else if (entry.network) {
        // เครือข่ายของเบอร์นี้ไม่มีให้บริการแล้ว → ไม่สลับไปเครือข่ายอื่นเงียบๆ
        self.code = null;
        self.source = null;
        self.missing = String(entry.network).slice(0, 20);
      }
      self.attention = false;
      onUpdate('pick');
    },

    /** ปุ่ม "เปลี่ยนเป็น …" ในข้อความเตือน → ใช้เครือข่ายที่เคยเติมสำเร็จ */
    useHistory() {
      const n = self.hist?.confirmed ? networkOf(self.hist.network) : null;
      if (n) self.choose(n.code);
    },

    /** กดยืนยันโดยยังไม่เลือกเครือข่าย → ไฮไลต์ข้อความให้เลือก */
    ask() {
      self.attention = true;
      onUpdate('ask');
    },

    /** ข้อมูลเครือข่ายโหลดใหม่ → เครือข่ายที่เลือกไว้หายไป ให้ลูกค้าเลือกใหม่ (ไม่สลับเอง) */
    catalogChanged() {
      if (self.code && !networkOf(self.code)) {
        self.missing = self.code;
        self.code = null;
        self.source = null;
      }
    },

    /** หัวข้อเหนือปุ่มเครือข่าย */
    label() {
      return self.code
        ? html`<div class="label net-label">เครือข่ายของเบอร์นี้</div>`
        : html`<div class="label net-label net-ask ${self.attention ? 'is-alert' : ''}" role="${self.attention ? 'alert' : 'note'}">${icon('alert', 16)} เลือกเครือข่ายของเบอร์นี้</div>`;
    },

    /** ปุ่มเลือกเครือข่าย (ใหญ่ สีตามแบรนด์ + ชื่อ) — sub(n) = ข้อความใต้ชื่อ (เช่น จำนวนแพ็กเกจ) */
    buttons({ sub } = {}) {
      const nets = state.catalog?.networks || [];
      const okNet = self.hist?.confirmed ? self.hist.network : null;
      return html`<div class="net-pick" style="--cols:${Math.max(1, Math.min(nets.length, 3))}" role="group" aria-label="เครือข่าย">
        ${nets.map((n) => {
          const on = n.code === self.code;
          const open = openOf(n);
          const note = !open ? 'ปิดชั่วคราว' : okNet === n.code ? html`${icon('check', 12)} เคยเติมสำเร็จ` : sub ? sub(n) : '';
          return html`<button type="button" class="net-opt ${on ? 'active' : ''} ${open ? '' : 'closed'}" data-net="${n.code}" style="${netVars(n.color)}"
              aria-pressed="${on ? 'true' : 'false'}" ${open ? '' : raw('aria-disabled="true"')}>
            <span class="net-opt-check" aria-hidden="true">${icon('check', 13)}</span>
            <span class="net-opt-logo">${n.name}</span>
            ${n.full_name && n.full_name !== n.name ? html`<span class="net-opt-name">${n.full_name}</span>` : ''}
            ${note ? html`<span class="net-opt-sub">${note}</span>` : ''}
          </button>`;
        })}
      </div>`;
    },

    /** ข้อความแนะนำ/เตือนใต้ปุ่มเครือข่าย (เรียงตามความสำคัญ) */
    notices() {
      const out = [];
      const n = networkOf(self.code);
      const h = self.hist;
      const hn = h ? networkOf(h.network) : null;
      const when = h?.at ? ` ${shortDate(h.at)}` : '';
      if (self.flash) out.push(alertBox(self.flash.type, self.flash.text));
      if (!n && self.missing) out.push(alertBox('warning', `เครือข่าย ${self.missing} ปิดให้บริการชั่วคราว — กรุณาเลือกเครือข่ายที่เบอร์นี้ใช้งานอยู่จริง`));
      if (n && !openOf(n)) out.push(alertBox('warning', closedText(n)));
      else if (n?.notice) out.push(alertBox('info', n.notice));

      if (h?.confirmed && hn) {
        if (n && n.code !== hn.code) {
          out.push(alertBox('warning', html`<div><b>เบอร์นี้เติม ${hn.name} สำเร็จล่าสุด${when}</b> แต่ตอนนี้เลือก ${n.name} — ถ้าเบอร์ยังไม่ได้ย้ายค่าย ให้เปลี่ยนเป็น ${hn.name}</div>
            ${openOf(hn) ? html`<button type="button" class="btn sm mt-1" data-use-hist>${icon('repeat', 16)} เปลี่ยนเป็น ${hn.name}</button>` : ''}`));
        } else if (!n) {
          out.push(alertBox('info', html`<div>เบอร์นี้เติม <b>${hn.name}</b> สำเร็จล่าสุด${when}</div>
            ${openOf(hn) ? html`<button type="button" class="btn sm mt-1" data-use-hist>${icon('check', 16)} ใช้ ${hn.name}</button>` : ''}`));
        } else if (self.saved) {
          out.push(alertBox('info', `สมุดโทรศัพท์บันทึกเบอร์นี้เป็น ${networkOf(self.saved)?.name || self.saved} แต่เติม ${n.name} สำเร็จล่าสุด${when} — เลือก ${n.name} ให้แล้ว (ถ้าย้ายค่ายแล้ว เลือกใหม่ได้)`));
        } else if (self.source === 'auto' || self.source === 'pick') {
          out.push(alertBox('success', html`เลือก <b>${n.name}</b> ให้แล้ว — เติม ${n.name} สำเร็จล่าสุด${when} · ถ้าย้ายค่ายแล้ว เลือกใหม่ได้`));
        }
      } else if (h && hn && !h.confirmed) {
        out.push(alertBox('warning', n
          ? (n.code === hn.code ? `เบอร์นี้ยังไม่เคยเติมสำเร็จ — กรุณาตรวจว่าเป็นเครือข่าย ${n.name} จริง` : `เบอร์นี้ยังไม่เคยเติมสำเร็จ (ครั้งก่อนเลือก ${hn.name}) — ตรวจให้แน่ใจว่าเป็น ${n.name}`)
          : `ครั้งก่อนเลือก ${hn.name} แต่ยังไม่เคยเติมสำเร็จ — กรุณาเลือกเครือข่ายที่เบอร์นี้ใช้อยู่จริง`));
      } else if (self.unconfirmed && h === undefined) {
        const un = networkOf(self.unconfirmed);
        out.push(alertBox('warning', `ครั้งก่อนเลือก ${un?.name || self.unconfirmed} แต่ยังไม่เคยเติมสำเร็จ — กรุณาเลือกเครือข่ายที่เบอร์นี้ใช้อยู่จริง`));
      }

      if (self.retry) {
        const rn = networkOf(self.retry.network);
        const rName = rn?.name || self.retry.network;
        if (!n) out.push(alertBox('warning', `รายการก่อนหน้าเติม ${rName} ไม่สำเร็จ — กรุณาเลือกเครือข่ายที่เบอร์นี้ใช้อยู่จริง (เบอร์ที่ย้ายค่ายให้เลือกค่ายปัจจุบัน)`));
        else if (n.code === self.retry.network) out.push(alertBox('warning', `รายการก่อนหน้าเติม ${rName} ไม่สำเร็จ — ตรวจให้แน่ใจว่าเบอร์นี้ใช้ ${rName} อยู่จริง`));
      }

      // มีรายการของเบอร์นี้ที่ยังไม่รู้ผล → บอกให้รอ (กันกดซ้ำเพราะคิดว่ายังไม่ได้ทำ)
      if (h?.last && !h.last.final) {
        out.push(alertBox('info', html`เบอร์นี้มีรายการที่กำลังดำเนินการอยู่ — <a href="#/order/${h.last.ref}">ดูสถานะ</a> ก่อนทำรายการใหม่ (ไม่ต้องทำซ้ำ ถ้าไม่สำเร็จระบบคืนเงินอัตโนมัติ)`));
      }
      return out;
    },
  };

  let seq = 0;
  async function lookup(p) {
    const my = ++seq;
    const h = await phoneHistory(p).catch(() => undefined);
    if (my !== seq || p !== self.phone || !ctx.alive()) return;
    self.hist = h;
    const n = h?.confirmed ? networkOf(h.network) : null;
    if (n && openOf(n) && !self.code && !self.missing && !self.retry) {
      // เบอร์ที่เคยเติมสำเร็จ → เลือกเครือข่ายที่สำเร็จล่าสุดให้
      self.code = n.code;
      self.source = 'auto';
      self.bound = p;
    } else if (n && openOf(n) && self.source === 'book' && self.code !== n.code) {
      // สมุดโทรศัพท์บันทึกไว้ไม่ตรงกับที่เคยเติมสำเร็จ (ข้อมูลในสมุดอาจเก่า) → ใช้เครือข่ายที่สำเร็จ + บอกให้รู้
      self.saved = self.code;
      self.code = n.code;
      self.source = 'auto';
      self.bound = p;
    }
    onUpdate('history');
  }

  return self;
}
