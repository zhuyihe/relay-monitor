// 上游每天花费的后台（server/upstream-spend.js）：第一次读余额成功后补 30 天、每天读昨天、不给读不反复试、读失败退避、
// 一个补完再补下一个、上游断路或额度快到限流就不读、重启接着、只读上游
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { History } from "../db/history.js";
import { dayStartInTz, shiftDayLabel } from "../lib/business-time.js";
import { noteOwnRequest, resetOwnRequestBudget } from "../lib/own-request-budget.js";
import { UPSTREAM_SPEND } from "../lib/upstream-spend.js";
import { createUpstreamSpend, forgetUpstreamSpend } from "./upstream-spend.js";
import { MemoryUpstreamSpendStore } from "./test-support/upstream-spend-memory-store.js";

const TZ = "Asia/Shanghai";
const at = (iso) => Date.parse(`${iso}+08:00`);
const MIN = 60000;
beforeEach(() => resetOwnRequestBudget());

const station = (id, extra = {}) => ({ id, name: id, type: "newapi", baseUrl: `https://${id}.test`, accessToken: "t", userId: "1", monitorEnabled: true, balance: { ok: true, remaining: 100 }, ...extra });

// read 默认：范围里每天 2 美元；记下每次调用的范围，并检查同一时刻只有一个读在跑
function harness(t, { stations, start = "2026-10-24T10:00:00", read = null, store = new MemoryUpstreamSpendStore() }) {
  const clock = { now: at(start) };
  t.mock.method(Date, "now", () => clock.now); // History.predict、页面上的近 30 天都读 Date.now，和这里的假时钟对齐
  const calls = [], sleeps = [], saves = [];
  let inflight = 0, overlap = false;
  const defaultRead = async (st, { startMs, endMs }) => {
    const days = [];
    for (let label = new Date(startMs + 8 * 3600000).toISOString().slice(0, 10); dayStartInTz(label, TZ) < endMs; label = shiftDayLabel(label, 1)) days.push({ day: label, usd: 2 });
    return { days, source: "dashboard" };
  };
  const rt = { pool: {}, store: { list: () => stations, get: (id) => stations.find((item) => item.id === id), save: async () => { saves.push(1); } }, history: new History({ query: async () => [[]] }) };
  const spend = createUpstreamSpend(rt, {
    store, now: () => clock.now, sleep: async (ms) => { sleeps.push(ms); },
    read: async (st, options) => {
      inflight += 1; if (inflight > 1) overlap = true;
      calls.push({ id: st.id, startMs: options.startMs, endMs: options.endMs, from: new Date(options.startMs + 8 * 3600000).toISOString().slice(0, 10), to: new Date(options.endMs - 1 + 8 * 3600000).toISOString().slice(0, 10) });
      try { return await (read || defaultRead)(st, options, calls.length); } finally { inflight -= 1; }
    },
  });
  return { spend, store, rt, clock, calls, sleeps, saves, overlapped: () => overlap };
}

test("新上游：第一次读余额成功之后才读，一次读过去 30 个整天（到昨天为止），存库、推给预测；之后没有要读的就不发请求", async (t) => {
  const s = station("a", { balance: null });
  const h = harness(t, { stations: [s] });
  await h.spend.load();
  assert.deepEqual(await h.spend.tick(), []);
  assert.equal(h.calls.length, 0, "余额还没读成功：不读");
  s.balance = { ok: false, error: "x" };
  assert.deepEqual(await h.spend.tick(), []);
  s.balance = { ok: true, remaining: 100 };
  const done = await h.spend.tick();
  assert.deepEqual(done.map((item) => [item.id, item.outcome]), [["a", "read"]]);
  assert.equal(h.calls.length, 1, "一个请求读 30 天");
  assert.deepEqual([h.calls[0].from, h.calls[0].to], ["2026-09-24", "2026-10-23"], "10-24 是今天：读 30 个整天，到昨天");
  assert.equal(h.calls[0].endMs - h.calls[0].startMs, 30 * 86400000);
  assert.equal(h.store.days.size, 30);
  assert.deepEqual(h.store.states.get("a"), { stationId: "a", status: "ok", source: "dashboard", readThrough: "2026-10-23", deniedCode: null, checkedAt: h.clock.now });
  assert.equal(h.rt.history.dailySpendView("a").state, "ok");
  assert.equal(h.rt.history.dailySpendView("a").days.length, 30);
  h.rt.history.data.a = [[h.clock.now, 40, 0]];
  assert.equal(h.rt.history.predict("a").burnPerDay, 2, "新上游马上有日均");
  await h.spend.tick(); await h.spend.tick();
  assert.equal(h.calls.length, 1, "没有要读的：不发请求");
});

test("已有的上游上线后补 30 天：一个补完再补下一个，中间隔开，同一时刻只有一个请求在跑", async (t) => {
  const h = harness(t, { stations: [station("a"), station("b"), station("c")] });
  await h.spend.load();
  const done = await h.spend.tick();
  assert.deepEqual(done.map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(h.sleeps, [UPSTREAM_SPEND.BACKFILL_GAP_MS, UPSTREAM_SPEND.BACKFILL_GAP_MS], "三个上游之间隔 2 次");
  assert.equal(h.overlapped(), false);
  assert.equal(h.calls.length, 3, "总共 3 个请求（每个上游 1 个）");
});

test("每天业务时区过了零点读昨天：每个上游 1 个请求；零点后等一会儿（对方看板定时写）；错过的几天一起补", async (t) => {
  const h = harness(t, { stations: [station("a")] });
  await h.spend.load();
  await h.spend.tick(); // 10-24 10:00 补到 10-23
  h.calls.length = 0;
  h.clock.now = at("2026-10-24T23:59:00"); await h.spend.tick();
  h.clock.now = at("2026-10-25T00:05:00"); await h.spend.tick();
  assert.equal(h.calls.length, 0, "零点刚过 5 分钟：昨天还没写全，先不读");
  h.clock.now = at("2026-10-25T00:25:00");
  const done = await h.spend.tick();
  assert.deepEqual(done.map((item) => item.outcome), ["read"]);
  assert.equal(h.calls.length, 1, "每天 1 个请求");
  assert.deepEqual([h.calls[0].from, h.calls[0].to], ["2026-10-24", "2026-10-24"], "只读昨天一天");
  assert.equal(h.store.states.get("a").readThrough, "2026-10-24");
  await h.spend.tick();
  assert.equal(h.calls.length, 1, "同一天不重复读");
  h.clock.now = at("2026-10-28T09:00:00"); // 控制台停了几天
  await h.spend.tick();
  assert.equal(h.calls.length, 2);
  assert.deepEqual([h.calls[1].from, h.calls[1].to], ["2026-10-25", "2026-10-27"], "错过的 3 天一个请求补上");
  assert.equal(h.rt.history.dailySpendView("a").days.at(-1).day, "2026-10-27");
});

test("刚过零点就补 30 天的新上游：先读到前天，昨天等一会儿再读（不把没写全的昨天存进去）", async (t) => {
  const h = harness(t, { stations: [station("a")], start: "2026-10-24T00:05:00" });
  await h.spend.load();
  await h.spend.tick();
  assert.deepEqual([h.calls[0].from, h.calls[0].to], ["2026-09-24", "2026-10-22"]);
  h.clock.now = at("2026-10-24T00:30:00");
  await h.spend.tick();
  assert.deepEqual([h.calls[1].from, h.calls[1].to], ["2026-10-23", "2026-10-23"]);
});

test("对方不给读：记下「不给读」，不反复试（隔一周最多问一次），这期间照余额快照的老办法；页面拿到 denied", async (t) => {
  const h = harness(t, { stations: [station("a")], read: async () => { throw Object.assign(new Error("off"), { code: "UPSTREAM_FEATURE_UNSUPPORTED" }); } });
  await h.spend.load();
  assert.deepEqual((await h.spend.tick()).map((item) => item.outcome), ["denied"]);
  assert.deepEqual(h.store.states.get("a"), { stationId: "a", status: "denied", source: null, readThrough: null, deniedCode: "UPSTREAM_FEATURE_UNSUPPORTED", checkedAt: h.clock.now });
  assert.equal(h.rt.history.dailySpendView("a").state, "denied");
  for (let i = 0; i < 5; i += 1) { h.clock.now += 6 * 3600000; await h.spend.tick(); }
  assert.equal(h.calls.length, 1, "一天多里 5 次看都没再问");
  h.rt.history.data.a = Array.from({ length: 7 }, (_, i) => [h.clock.now - (6 - i) * 1800000, 100 - i, 0]);
  assert.equal(h.rt.history.predict("a").basis, "fallback", "老办法");
  h.clock.now = at("2026-10-31T11:00:00");
  await h.spend.tick();
  assert.equal(h.calls.length, 2, "一周以后再问一次");
});

test("一周后再问时对方开放了：从 denied 变成 ok，读到 30 天", async (t) => {
  let open = false;
  const h = harness(t, { stations: [station("a")], read: async (st, options, n) => { if (!open) throw Object.assign(new Error("off"), { code: "UPSTREAM_STAT_UNAVAILABLE" }); return { days: [{ day: "2026-10-30", usd: 5 }], source: "stat" }; } });
  await h.spend.load();
  await h.spend.tick();
  open = true;
  h.clock.now += UPSTREAM_SPEND.DENIED_RETRY_MS + MIN;
  await h.spend.tick();
  assert.equal(h.store.states.get("a").status, "ok");
  assert.equal(h.store.states.get("a").source, "stat");
});

test("读失败（连不上、超时、对方繁忙）：不当成「不给读」，隔一会儿再读，每次翻倍、最长 6 小时", async (t) => {
  const h = harness(t, { stations: [station("a")], read: async () => { throw Object.assign(new Error("net"), { code: "NETWORK_UNREACHABLE" }); } });
  await h.spend.load();
  assert.deepEqual((await h.spend.tick()).map((item) => item.outcome), ["failed"]);
  assert.equal(h.store.states.has("a"), false, "没写「不给读」");
  h.clock.now += 9 * MIN; await h.spend.tick();
  assert.equal(h.calls.length, 1, "10 分钟内不再读");
  h.clock.now += 1 * MIN; await h.spend.tick();
  assert.equal(h.calls.length, 2);
  h.clock.now += 19 * MIN; await h.spend.tick();
  assert.equal(h.calls.length, 2, "第二次失败后隔 20 分钟");
  h.clock.now += 1 * MIN; await h.spend.tick();
  assert.equal(h.calls.length, 3);
  for (let i = 0; i < 12; i += 1) { h.clock.now += 6 * 3600000 + MIN; await h.spend.tick(); }
  assert.equal(h.calls.length, 3 + 12, "最长隔 6 小时：每 6 小时多一点读一次");
  assert.equal(h.spend.stateOf("a"), null);
});

test("已经读成功过的上游，偶尔读到「不给读」一类的错（多半是临时的）只退避重试，不改成 denied、旧的天数照用", async (t) => {
  let fail = false;
  const h = harness(t, { stations: [station("a")], read: async (st, options) => {
    if (fail) throw Object.assign(new Error("403"), { code: "UPSTREAM_AUTH_DENIED" });
    return { days: [{ day: "2026-10-23", usd: 9 }], source: "dashboard" };
  } });
  await h.spend.load();
  await h.spend.tick();
  fail = true;
  h.clock.now = at("2026-10-25T01:00:00");
  assert.deepEqual((await h.spend.tick()).map((item) => item.outcome), ["failed"]);
  assert.equal(h.store.states.get("a").status, "ok");
  assert.equal(h.rt.history.dailySpendView("a").state, "ok");
});

test("上游断路、或最近 180 秒请求已经多得快到限流：这轮不读，不发请求；断路过去以后接着读", async (t) => {
  const h = harness(t, { stations: [station("a")] });
  await h.spend.load();
  noteOwnRequest("https://a.test/api/x", { status: 500, now: h.clock.now });
  assert.deepEqual((await h.spend.tick()).map((item) => item.outcome), ["skipped"]);
  assert.equal(h.calls.length, 0);
  h.clock.now += 61000;
  assert.deepEqual((await h.spend.tick()).map((item) => item.outcome), ["read"]);
  resetOwnRequestBudget();
  const busy = harness(t, { stations: [station("b")] });
  for (let i = 0; i < 250; i += 1) noteOwnRequest("https://b.test/api/x", { status: 200, now: busy.clock.now });
  assert.deepEqual((await busy.spend.tick()).map((item) => item.outcome), ["skipped"], "额度快用完（留给别的读取）");
  assert.equal(busy.calls.length, 0);
});

test("不读：自营站点、固定成本、sk 密钥、归档的、监控关着的", async (t) => {
  const h = harness(t, { stations: [station("own", { isOwn: true }), station("fx", { type: "fixed" }), station("key", { type: "newapi-key" }), station("old", { archivedAt: "2026-10-01" }), station("off", { monitorEnabled: false })] });
  await h.spend.load();
  assert.deepEqual(await h.spend.tick(), []);
  assert.equal(h.calls.length, 0);
});

test("重启接着：库里的状态和天数读回来推给预测，已经读到昨天的不再读；今天走过零点才读昨天，只读这一天", async (t) => {
  const store = new MemoryUpstreamSpendStore();
  const first = harness(t, { stations: [station("a")], store });
  await first.spend.load(); await first.spend.tick();
  const writes = store.calls.putDays;
  const again = harness(t, { stations: [station("a")], store });
  await again.spend.load();
  assert.equal(again.rt.history.dailySpendView("a").days.length, 30, "天数读回来了");
  assert.equal(again.spend.stateOf("a").readThrough, "2026-10-23");
  assert.deepEqual(await again.spend.tick(), []);
  assert.equal(again.calls.length, 0);
  assert.equal(store.calls.putDays, writes, "重启不写库");
  again.clock.now = at("2026-10-25T00:30:00");
  await again.spend.tick();
  assert.deepEqual([again.calls[0].from, again.calls[0].to], ["2026-10-24", "2026-10-24"]);
});

test("库里留 40 天：读完以后删掉更早的", async (t) => {
  const store = new MemoryUpstreamSpendStore();
  await store.putDays("a", [{ day: "2026-08-01", usd: 1 }, { day: "2026-09-10", usd: 1 }]);
  const h = harness(t, { stations: [station("a")], store });
  await h.spend.load();
  await h.spend.tick();
  const days = [...store.days.values()].map((row) => row.day).sort();
  assert.equal(days.includes("2026-08-01"), false, "40 天以前的删掉");
  assert.equal(days.includes("2026-09-10"), false, "2026-10-24 往前 40 天是 09-14，09-10 也删掉");
  assert.equal(days.at(0), "2026-09-24");
});

test("新上游加进来、刷新余额第一次成功时：noteBalanceOk 马上安排一次读（不等 5 分钟的轮询）；已经读过的不再安排", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = station("a");
  const h = harness(t, { stations: [s] });
  await h.spend.load();
  h.spend.noteBalanceOk(s);
  t.mock.timers.tick(2000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  h.spend.noteBalanceOk(s);
  t.mock.timers.tick(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  h.spend.noteBalanceOk(station("own2", { isOwn: true }));
  t.mock.timers.tick(5000);
  assert.equal(h.calls.length, 1);
});

test("Sub2API 密码模式读完把可能换了的令牌存下来；New API 不用存", async (t) => {
  const sub = harness(t, { stations: [station("s", { type: "sub2api-password", baseUrl: "https://s.test" })] });
  await sub.spend.load(); await sub.spend.tick();
  assert.equal(sub.saves.length, 1);
  const api = harness(t, { stations: [station("n")] });
  await api.spend.load(); await api.spend.tick();
  assert.equal(api.saves.length, 0);
});

test("站点彻底删除（或上游换了地址）：天数、状态、预测里的都清掉，之后重新补 30 天", async (t) => {
  const s = station("a");
  const h = harness(t, { stations: [s] });
  await h.spend.load(); await h.spend.tick();
  h.rt._upstreamSpendStore = h.store;
  h.rt.upstreamSpend = h.spend;
  await forgetUpstreamSpend(h.rt, "a");
  assert.equal(h.store.days.size, 0);
  assert.equal(h.store.states.size, 0);
  assert.equal(h.rt.history.dailySpendView("a").state, "pending");
  assert.equal(h.spend.stateOf("a"), null);
  await h.spend.tick();
  assert.equal(h.calls.length, 2, "重新补 30 天");
});

// ---- 接口：/api/stations 和 /api/stations/:id/history 带近 30 天每天的花费 ----
test("接口字段 dailySpend：{ state: ok | pending | denied | none, days: [{ day, usd }] }，/api/stations 和 history 同一份；预测里的日均也来自它", async (t) => {
  const { redact } = await import("./stations.js");
  const h = harness(t, { stations: [] });
  const upstream = station("a"), fresh = station("b"), closed = station("c"), own = station("own", { isOwn: true }), fixed = station("fx", { type: "fixed" }), sk = station("k", { type: "newapi-key" });
  h.rt.history.setDailySpend("a", Array.from({ length: 35 }, (_, i) => ({ day: shiftDayLabel("2026-10-23", -i), usd: 3 })).reverse());
  h.rt.history.setDailySpend("c", [], { denied: true });
  h.rt.history.data.a = [[h.clock.now, 30, 0]];
  const view = (s) => redact(h.rt, s);
  assert.equal(view(upstream).dailySpend.state, "ok");
  assert.equal(view(upstream).dailySpend.days.length, 31, "近 30 个整天 + 今天（到现在），按日期升序");
  assert.deepEqual([view(upstream).dailySpend.days[0].day, view(upstream).dailySpend.days.at(-2).day, view(upstream).dailySpend.days.at(-1).day], ["2026-09-24", "2026-10-23", "2026-10-24"]);
  assert.deepEqual(view(upstream).dailySpend.days[0], { day: "2026-09-24", usd: 3 });
  assert.deepEqual([view(upstream).dailySpend.source, view(upstream).dailySpend.todayEstimate], ["upstream", true], "今天按余额快照推的（没有站点仪表盘的数）");
  assert.deepEqual(view({ ...upstream, balance: { ok: true, remaining: 30, todayUsed: 7.5 } }).dailySpend.days.at(-1), { day: "2026-10-24", usd: 7.5 }, "今天取站点仪表盘的数");
  assert.equal(view({ ...upstream, balance: { ok: true, remaining: 30, todayUsed: 7.5 } }).dailySpend.todayEstimate, false);
  assert.equal(view(upstream).prediction.burnPerDay, 3);
  assert.equal(view(upstream).prediction.etaDays, 10);
  assert.equal(view(fresh).dailySpend.state, "pending");
  assert.equal(view(closed).dailySpend.state, "denied", "对方不给读以前的用量");
  for (const s of [own, fixed, sk]) assert.deepEqual(view(s).dailySpend, { state: "none", source: null, days: [], since: null, todayEstimate: false });
  // history 接口给同一份
  const { registerHooks } = await import("node:module");
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true, source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
    return nextLoad(url, context);
  } });
  let GET;
  try { ({ GET } = await import("../app/api/stations/[id]/history/route.js")); } finally { hook.deregister(); }
  const rt = { ...h.rt, store: { get: (id) => [upstream, fresh, closed].find((s) => s.id === id) } };
  const body = await (await GET(new Request("https://local.test/api/stations/a/history"), rt, { id: "a" })).json();
  assert.deepEqual(body.dailySpend, view(upstream).dailySpend);
  assert.equal(body.prediction.burnPerDay, 3);
  assert.equal((await (await GET(new Request("https://local.test/api/stations/c/history"), rt, { id: "c" })).json()).dailySpend.state, "denied");
});

test("读失败：页面上和新上游正在读一样是 pending（后台再试），柱子先用余额快照的数；下次读成功就是 ok", async (t) => {
  let fail = true;
  const h = harness(t, { stations: [station("a")], read: async () => {
    if (fail) throw Object.assign(new Error("net"), { code: "NETWORK_UNREACHABLE" });
    return { days: [{ day: "2026-10-23", usd: 4 }], source: "dashboard" };
  } });
  await h.spend.load();
  await h.spend.tick();
  assert.equal(h.rt.history.dailySpendView("a").state, "pending");
  assert.equal(h.rt.history.dailySpendView("a").source, "balance");
  fail = false;
  h.clock.now += 10 * MIN;
  await h.spend.tick();
  assert.equal(h.rt.history.dailySpendView("a").state, "ok");
});
