import test from "node:test";
import assert from "node:assert/strict";
import { visibleInterval } from "./visible-interval.js";

// 假的文档和假的定时器：手动「走一拍」、手动切前后台
function fake() {
  const listeners = new Set(), ticks = [];
  const doc = { hidden: false, addEventListener: (type, fn) => type === "visibilitychange" && listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn) };
  const timers = { setInterval: (fn, ms) => { ticks.push({ fn, ms }); return ticks.length; }, clearInterval: (id) => { ticks[id - 1] = null; } };
  return { doc, timers, ticks, listeners, tick: () => ticks.forEach((t) => t?.fn()), show: () => { doc.hidden = false; listeners.forEach((fn) => fn()); }, hide: () => { doc.hidden = true; listeners.forEach((fn) => fn()); } };
}

test("前台每拍都刷；后台这一拍不发请求；切回前台立刻刷一次", () => {
  const f = fake();
  let calls = 0;
  visibleInterval(() => { calls += 1; }, 60000, { doc: f.doc, timers: f.timers });
  assert.equal(f.ticks[0].ms, 60000);
  f.tick(); f.tick();
  assert.equal(calls, 2);
  f.hide();
  assert.equal(calls, 2, "切去后台本身不刷");
  for (let i = 0; i < 100; i += 1) f.tick();
  assert.equal(calls, 2, "后台一百拍一个请求都不发");
  f.show();
  assert.equal(calls, 3, "切回来立刻刷一次");
  f.tick();
  assert.equal(calls, 4, "之后照常");
});

test("清理：定时器停掉、监听摘掉，之后切回前台也不刷", () => {
  const f = fake();
  let calls = 0;
  const stop = visibleInterval(() => { calls += 1; }, 1000, { doc: f.doc, timers: f.timers });
  stop();
  assert.equal(f.listeners.size, 0);
  f.tick(); f.hide(); f.show();
  assert.equal(calls, 0);
});
