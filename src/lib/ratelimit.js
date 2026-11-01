'use strict';
// จำกัดจำนวนคำขอในหน่วยความจำ (เหมาะกับเซิร์ฟเวอร์เครื่องเดียว)

// จำนวน key สูงสุดที่จำไว้ (กันหน่วยความจำบวมเมื่อมีคนยิงจาก IP จำนวนมาก)
const MAX_KEYS = 50000;

class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(Math.max(windowMs, 30000), 300000));
    this.timer.unref();
  }

  hit(key, cost = 1) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      if (this.hits.size >= MAX_KEYS) {
        this.sweep();
        // ยังเต็ม → ทิ้ง key ที่เก่าที่สุด (Map เรียงตามลำดับที่ใส่)
        while (this.hits.size >= MAX_KEYS) this.hits.delete(this.hits.keys().next().value);
      }
      entry = { count: 0, reset: now + this.windowMs };
      this.hits.delete(key);
      this.hits.set(key, entry);
    }
    entry.count += cost;
    const allowed = entry.count <= this.max;
    return { allowed, remaining: Math.max(0, this.max - entry.count), retryAfterSec: Math.ceil((entry.reset - now) / 1000) };
  }

  reset(key) {
    this.hits.delete(key);
  }

  sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
}

module.exports = { RateLimiter };
