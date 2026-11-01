// กราฟแท่งแนวตั้ง (SVG วาดเอง) — ตามหลัก dataviz:
//  - แกนเดียวต่อกราฟ (ยอดขาย กับ จำนวนรายการ แยกเป็น 2 กราฟ)
//  - แท่งกว้างไม่เกิน 24px ปลายมน 4px ฐานเหลี่ยม, ช่องว่าง 2px สีพื้นระหว่างชั้น
//  - เส้นกริดบาง สีจาง, ป้ายตัวเลขเฉพาะจุดสำคัญ (สูงสุด + ล่าสุด)
//  - hover/focus แสดง tooltip (ใส่ข้อความด้วย textContent), มีตารางคู่กันเสมอ
import { html } from '../lib.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const dayShort = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLong = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const fmtDayShort = (d) => dayShort.format(new Date(`${d}T00:00:00Z`));
export const fmtDayLong = (d) => dayLong.format(new Date(`${d}T00:00:00Z`));

function trimNum(n) {
  return Number(n.toFixed(1)).toString();
}
/** ตัวเลขแกน: 0 / 500 / 1K / 2.5K / 1M */
export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${trimNum(n / 1e6)}M`;
  if (a >= 1e3) return `${trimNum(n / 1e3)}K`;
  return String(Math.round(n));
}

function niceTicks(max, count = 4, integer = false) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function topRounded(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}L${x},${y + rr}Q${x},${y} ${x + rr},${y}L${x + w - rr},${y}Q${x + w},${y} ${x + w},${y + rr}L${x + w},${y + h}Z`;
}

/**
 * สร้างกราฟแท่ง
 * cfg = {
 *   ariaLabel, integer,
 *   layers: [{ key, cls, label, value: (row) => number, keyColor: css var }],   // ชั้นล่าง → บน
 *   labelValue: (row) => number,  ค่าที่ใช้แสดงป้ายเหนือแท่ง
 *   formatValue: (n) => string,   รูปแบบตัวเลขในป้าย/tooltip
 *   tooltipRows: (row) => [{ label, value, color }]
 * }
 * คืน { update(rows), destroy() }
 */
export function createColumnChart(box, cfg) {
  let rows = [];
  let lastWidth = 0;
  box.classList.add('chart-box');
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.setAttribute('role', 'status');

  function showTip(i, anchor) {
    const row = rows[i];
    if (!row) return;
    tip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'tip-title';
    title.textContent = fmtDayLong(row.day);
    tip.appendChild(title);
    for (const r of cfg.tooltipRows(row)) {
      const line = document.createElement('div');
      line.className = 'tip-row';
      const key = document.createElement('span');
      key.className = 'lk';
      if (r.color) key.style.background = r.color;
      else key.style.visibility = 'hidden';
      const label = document.createElement('span');
      label.textContent = r.label;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = r.value;
      line.append(key, label, v);
      tip.appendChild(line);
    }
    box.querySelectorAll('.col-group.is-hover').forEach((g) => g.classList.remove('is-hover'));
    box.querySelector(`.col-group[data-i="${i}"]`)?.classList.add('is-hover');
    tip.classList.add('show');
    const bb = box.getBoundingClientRect();
    const ab = anchor.getBoundingClientRect();
    const tw = tip.offsetWidth;
    let left = ab.left - bb.left + ab.width / 2 + 10;
    if (left + tw > bb.width) left = ab.left - bb.left + ab.width / 2 - tw - 10;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = '8px';
  }

  function hideTip() {
    tip.classList.remove('show');
    box.querySelectorAll('.col-group.is-hover').forEach((g) => g.classList.remove('is-hover'));
  }

  function draw() {
    const width = Math.max(280, Math.round(box.clientWidth || 600));
    lastWidth = width;
    const plotH = 180;
    const padT = 20;
    const padB = 26;
    const padL = 42;
    const padR = 6;
    const totalH = padT + plotH + padB;
    const plotW = width - padL - padR;
    const n = Math.max(rows.length, 1);
    const band = plotW / n;
    const barW = Math.max(6, Math.min(24, band * 0.6));
    const totals = rows.map((r) => cfg.layers.reduce((s, l) => s + Math.max(0, l.value(r) || 0), 0));
    const ticks = niceTicks(Math.max(...totals, 0), 4, cfg.integer);
    const top = ticks[ticks.length - 1] || 1;
    const y = (v) => padT + plotH - (v / top) * plotH;
    const base = padT + plotH;

    // ป้ายตัวเลขเฉพาะ: ค่าสูงสุด + วันล่าสุด
    const labelVals = rows.map((r) => cfg.labelValue(r));
    let maxIdx = -1;
    labelVals.forEach((v, i) => { if (v > 0 && (maxIdx < 0 || v > labelVals[maxIdx])) maxIdx = i; });
    const labelIdx = new Set([maxIdx, rows.length - 1].filter((i) => i >= 0 && labelVals[i] > 0));
    const every = band < 22 ? 3 : band < 36 ? 2 : 1;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${totalH}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(totalH));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', cfg.ariaLabel);

    const parts = [];
    for (const t of ticks) {
      const ty = y(t);
      if (t > 0) parts.push(`<line class="gridline" x1="${padL}" x2="${width - padR}" y1="${ty}" y2="${ty}"/>`);
      parts.push(`<text class="tick" x="${padL - 8}" y="${ty + 4}" text-anchor="end">${compact(t)}</text>`);
    }
    parts.push(`<line class="baseline" x1="${padL}" x2="${width - padR}" y1="${base}" y2="${base}"/>`);

    rows.forEach((r, i) => {
      const cx = padL + band * i + band / 2;
      const x = cx - barW / 2;
      const g = [`<g class="col-group" data-i="${i}">`];
      g.push(`<rect class="col-hover" x="${cx - band / 2 + 1}" y="${padT}" width="${Math.max(0, band - 2)}" height="${plotH}" rx="6"/>`);
      let acc = 0;
      const vals = cfg.layers.map((l) => Math.max(0, l.value(r) || 0));
      const lastLayer = vals.reduce((last, v, k) => (v > 0 ? k : last), -1);
      cfg.layers.forEach((l, k) => {
        const v = vals[k];
        if (v <= 0) return;
        const y0 = y(acc);
        const y1 = y(acc + v);
        acc += v;
        let h = y0 - y1;
        // ช่องว่าง 2px สีพื้นระหว่างชั้น: ตัดจากด้านบนของชั้นล่าง
        if (k !== lastLayer) h = Math.max(1, h - 2);
        const segTop = y0 - h;
        if (k === lastLayer) g.push(`<path class="mark ${l.cls}" d="${topRounded(x, segTop, barW, h, 4)}"/>`);
        else g.push(`<rect class="mark ${l.cls}" x="${x}" y="${segTop}" width="${barW}" height="${h}"/>`);
      });
      if (labelIdx.has(i)) {
        g.push(`<text class="val-label" x="${cx}" y="${y(totals[i]) - 6}" text-anchor="middle">${cfg.formatValue(labelVals[i])}</text>`);
      }
      if (i % every === (rows.length - 1) % every) {
        g.push(`<text class="tick" x="${cx}" y="${base + 17}" text-anchor="middle">${fmtDayShort(r.day)}</text>`);
      }
      g.push(`<rect class="col-hit" data-i="${i}" x="${cx - band / 2}" y="${padT - 12}" width="${band}" height="${plotH + 12}" tabindex="0"/>`);
      g.push('</g>');
      parts.push(g.join(''));
    });
    // ข้อความในแท็ก SVG ทั้งหมดมาจากตัวเลข/วันที่ที่ระบบสร้างเอง (ไม่มีข้อความจากผู้ใช้)
    svg.innerHTML = parts.join('');
    svg.querySelectorAll('.col-hit').forEach((hit) => {
      const i = Number(hit.dataset.i);
      const r = rows[i];
      hit.setAttribute('aria-label', `${fmtDayLong(r.day)}: ${cfg.tooltipRows(r).map((t) => `${t.label} ${t.value}`).join(', ')}`);
      hit.addEventListener('pointerenter', () => showTip(i, hit));
      hit.addEventListener('pointermove', () => showTip(i, hit));
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('focus', () => showTip(i, hit));
      hit.addEventListener('blur', hideTip);
    });
    box.replaceChildren(svg, tip);
  }

  const ro = new ResizeObserver(() => {
    const w = Math.round(box.clientWidth);
    if (w && Math.abs(w - lastWidth) > 4) draw();
  });
  ro.observe(box);

  return {
    update(next) {
      rows = Array.isArray(next) ? next : [];
      draw();
    },
    destroy() {
      ro.disconnect();
    },
  };
}

/** ตารางคู่กับกราฟ (เข้าถึงข้อมูลได้โดยไม่ต้อง hover) */
export function chartTable(rows, columns) {
  return html`<div class="table-wrap viz-table"><table class="table">
    <thead><tr><th>วันที่</th>${columns.map((c) => html`<th class="num">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr><td>${fmtDayLong(r.day)}</td>${columns.map((c) => html`<td class="num">${c.value(r)}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}
