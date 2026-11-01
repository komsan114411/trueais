'use strict';
// คิวส่งรายการไปยังผู้ให้บริการ: จำกัดจำนวนพร้อมกัน + เว้นระยะ (กันโดน rate limit จากผู้ให้บริการ)
const logger = require('../lib/logger');

function createQueue({ handler, concurrency = 2, minIntervalMs = 0 }) {
  const items = [];
  const known = new Set();
  let running = 0;
  let lastStart = 0;
  let timer = null;
  let idleWaiters = [];

  function checkIdle() {
    if (running === 0 && items.length === 0) {
      const w = idleWaiters;
      idleWaiters = [];
      w.forEach((fn) => fn());
    }
  }

  function pump() {
    while (running < concurrency && items.length) {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) {
        if (!timer) timer = setTimeout(() => { timer = null; pump(); }, wait);
        return;
      }
      const id = items.shift();
      running++;
      lastStart = Date.now();
      Promise.resolve()
        .then(() => handler(id))
        .catch((err) => logger.error(`คิวส่งรายการ #${id} ผิดพลาด`, err))
        .finally(() => {
          running--;
          known.delete(id);
          pump();
          checkIdle();
        });
    }
    checkIdle();
  }

  return {
    push(id) {
      if (known.has(id)) return false;
      known.add(id);
      items.push(id);
      pump();
      return true;
    },
    has: (id) => known.has(id),
    size: () => items.length + running,
    idle: () => new Promise((resolve) => {
      if (running === 0 && items.length === 0) resolve();
      else idleWaiters.push(resolve);
    }),
  };
}

module.exports = { createQueue };
