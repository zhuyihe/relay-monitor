// 日均花费的新算法（lib/upstream-spend.js + db/history.js predict）：近 7 个整天的平均为主，最近 24 小时（余额快照）花得更快时取大的
import assert from "node:assert/strict";
import test from "node:test";
import { History } from "../db/history.js";
import { UPSTREAM_SPEND, averageDailySpend, dailyBurn, spendReadable, spendView } from "./upstream-spend.js";
import { orderUpstreams } from "./upstream-order.js";
import { shiftDayLabel } from "./business-time.js";
import { basisText } from "./format.js";

const TODAY = "2026-10-24";
const day = (back) => shiftDayLabel(TODAY, -back);
const rows = (...values) => values.map((usd, index) => ({ day: day(values.length - index), usd })); // 最后一个是昨天

test("近 7 个整天的平均：不含今天，不满 7 天按有数的几天平均；开头还没花钱的天不算，中间的 0 照算", () => {
  assert.deepEqual(averageDailySpend(rows(10, 10, 10, 10, 10, 10, 10), TODAY), { average: 10, days: 7 });
  assert.deepEqual(averageDailySpend([...rows(10, 10, 10, 10, 10, 10, 10), { day: TODAY, usd: 999 }], TODAY), { average: 10, days: 7 }, "今天（没过完）不算");
  assert.deepEqual(averageDailySpend([{ day: day(10), usd: 500 }, ...rows(10, 10, 10, 10, 10, 10, 10)], TODAY), { average: 10, days: 7 }, "只看近 7 天");
  assert.deepEqual(averageDailySpend(rows(6, 9, 3), TODAY), { average: 6, days: 3 }, "上游才开了 3 天：按这 3 天平均，不是除以 7");
  assert.deepEqual(averageDailySpend(rows(0, 0, 0, 0, 6, 9, 3), TODAY), { average: 6, days: 3 }, "开头的 0 是上游还没开始花钱");
  assert.deepEqual(averageDailySpend(rows(6, 0, 0, 6), TODAY), { average: 3, days: 4 }, "中间停用的天算进平均");
  assert.deepEqual(averageDailySpend(rows(0, 0, 0, 0, 0, 0, 0), TODAY), { average: 0, days: 0 }, "读到了、一分钱没花");
  assert.equal(averageDailySpend([], TODAY), null);
  assert.equal(averageDailySpend([{ day: day(20), usd: 5 }], TODAY), null, "近 7 天里一天的数都没有（只有很早的）：当没数据，退回老办法");
});

test("日均花费 = max（近 7 天平均，最近 24 小时实际花费）", () => {
  const week = rows(10, 10, 10, 10, 10, 10, 10);
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 4 }), { burnPerDay: 10, basis: "7d", days: 7 });
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 25 }), { burnPerDay: 25, basis: "fast24h", days: 7 });
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 10 }), { burnPerDay: 10, basis: "7d", days: 7 }, "一样大取 7 天");
  assert.deepEqual(dailyBurn({ rows: rows(0, 0, 0, 0, 0, 0, 0), today: TODAY, last24h: 3 }), { burnPerDay: 3, basis: "fast24h", days: 0 });
  assert.equal(dailyBurn({ rows: [], today: TODAY, last24h: 3 }), null);
  assert.equal(dailyBurn({ rows: week, today: TODAY }).burnPerDay, 10, "没给 24 小时就只看 7 天");
});

test("花费突然暴涨：最近 3 小时的速度超过（7 天平均、24 小时取大的）2 倍才按 3 小时算；2 倍以内、3 小时算不出（null）不看这一项", () => {
  const week = rows(10, 10, 10, 10, 10, 10, 10);
  assert.equal(UPSTREAM_SPEND.SURGE_FACTOR, 2);
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 4, rate3h: 15 }), { burnPerDay: 10, basis: "7d", days: 7 }, "忙时段 1.5 倍：不动");
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 4, rate3h: 20 }), { burnPerDay: 10, basis: "7d", days: 7 }, "正好 2 倍：不算超过");
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 4, rate3h: 100 }), { burnPerDay: 100, basis: "fast24h", days: 7 }, "10 倍：按 3 小时的");
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 21, rate3h: 50 }), { burnPerDay: 50, basis: "fast24h", days: 7 }, "和 24 小时取大的（21）比，不是和 7 天平均");
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 21, rate3h: 40 }), { burnPerDay: 21, basis: "fast24h", days: 7 }, "40 不到 21 的 2 倍：还是取 24 小时");
  assert.equal(dailyBurn({ rows: week, today: TODAY, last24h: 4, rate3h: null }).burnPerDay, 10, "3 小时的点不够：不看");
  assert.equal(dailyBurn({ rows: rows(0, 0, 0, 0, 0, 0, 0), today: TODAY, last24h: 0, rate3h: 5 }).burnPerDay, 5, "近 7 天一分钱没花、突然开始花");
});

test("日均旁边那句话（三处共用一张字表）：只有取的是最近 24 小时时写「最近花得比平时快」；7 天平均、退回老办法都不写", () => {
  assert.equal(basisText("fast24h"), "最近花得比平时快");
  assert.equal(basisText("7d"), "");
  assert.equal(basisText("fallback"), "");
  assert.equal(basisText(undefined), "");
  assert.equal(basisText(""), "");
  assert.equal(basisText("近3小时"), "", "老的写法也不再出字");
});

test("哪些上游读得了每天花费：上游的 New API、Sub2API；自营站点、固定成本、sk 密钥不读", () => {
  assert.equal(spendReadable({ type: "newapi" }), true);
  assert.equal(spendReadable({ type: "sub2api" }), true);
  assert.equal(spendReadable({ type: "sub2api-password" }), true);
  assert.equal(spendReadable({ type: "newapi", isOwn: true }), false);
  assert.equal(spendReadable({ type: "newapi-key" }), false);
  assert.equal(spendReadable({ type: "fixed" }), false);
});

test("给页面的近 30 天：读到了 ok、对方不给读 denied、还没读到 pending；今天和 30 天以前的不给", () => {
  const input = [{ day: day(40), usd: 1 }, { day: day(30), usd: 2 }, { day: day(1), usd: 3 }, { day: TODAY, usd: 9 }];
  assert.deepEqual(spendView(input, { today: TODAY }), { state: "ok", days: [{ day: day(30), usd: 2 }, { day: day(1), usd: 3 }] });
  assert.deepEqual(spendView([], { today: TODAY }), { state: "pending", days: [] });
  assert.deepEqual(spendView(undefined, { denied: true, today: TODAY }), { state: "denied", days: [] });
  assert.equal(UPSTREAM_SPEND.BACKFILL_DAYS, 30);
});

// ---- History.predict：日均花费只此一份 ----
const NOW = Date.parse("2026-10-24T02:00:00Z"); // 上海 10-24 10:00：今天是 10-24
const withClock = (fn) => () => { const real = Date.now; Date.now = () => NOW; try { fn(); } finally { Date.now = real; } };
const HOUR = 3600000;
// 最近 hours 小时每半小时一个快照，最近 24 小时（或读到的这么久）里共花 spent 美元，最后剩 balance
function snapshots(balance, spent, hours = 24) {
  const n = hours * 2;
  return Array.from({ length: n + 1 }, (_, i) => [NOW - (n - i) * HOUR / 2, balance + spent * ((n - i) / n), 0]);
}
const history = () => new History({ query: async () => [[]] });

test("预测：有每天花费时 7 天平均为主；最近 24 小时更快取大的，可用天数跟着变短", withClock(() => {
  const h = history();
  h.setDailySpend("a", rows(10, 10, 10, 10, 10, 10, 10));
  h.data.a = snapshots(100, 4);
  const steady = h.predict("a");
  assert.deepEqual([steady.burnPerDay, steady.etaDays, steady.basis], [10, 10, "7d"], "24 小时只花了 4，7 天平均 10");
  h.data.a = snapshots(100, 25);
  const surge = h.predict("a");
  assert.deepEqual([surge.burnPerDay, surge.etaDays, surge.basis], [25, 4, "fast24h"], "最近 24 小时花了 25，比 7 天平均快：可用天数 100 ÷ 25 = 4，不晚");
  assert.ok(surge.etaDays < steady.etaDays);
  assert.ok(surge.etaAt && new Date(surge.etaAt).getTime() < NOW + 4.01 * 24 * HOUR);
}));

test("预测：最近 24 小时只算余额下降的部分（充值不算），读到的不满 24 小时按读到的算、不放大", withClock(() => {
  const h = history();
  h.setDailySpend("a", rows(2, 2, 2, 2, 2, 2, 2));
  // 3 小时里花了 1 美元，中间充值 500：只算下降的 1 美元，不是 8 美元
  h.data.a = [[NOW - 3 * HOUR, 50, 0], [NOW - 2 * HOUR, 49.5, 0], [NOW - 1 * HOUR, 549.5, 0], [NOW, 549, 0]];
  const result = h.predict("a");
  assert.equal(result.burnPerDay, 2, "7 天平均 2；24 小时只有 1（不放大成 8）");
  assert.equal(result.basis, "7d");
  h.data.a = [[NOW - 3 * HOUR, 50, 0], [NOW - 2 * HOUR, 46, 0], [NOW - 1 * HOUR, 546, 0], [NOW, 545, 0]];
  assert.equal(h.predict("a").burnPerDay, 5, "下降 4 + 1 = 5，充值不算");
}));

test("预测：新上游有 30 天数据时马上有日均和可用天数（只有一个余额快照也行）；7 天不满按有数的算", withClock(() => {
  const h = history();
  h.setDailySpend("new", Array.from({ length: 30 }, (_, i) => ({ day: day(30 - i), usd: 6 })));
  h.data.new = [[NOW, 60, 0]];
  assert.equal(h.predictFromSnapshots("new"), null, "老办法这时什么也算不出");
  const result = h.predict("new");
  assert.deepEqual([result.burnPerDay, result.etaDays, result.basis], [6, 10, "7d"]);
  const young = history();
  young.setDailySpend("y", rows(2, 4)); // 才开了 2 天
  young.data.y = [[NOW, 30, 0]];
  assert.deepEqual([young.predict("y").burnPerDay, young.predict("y").etaDays], [3, 10]);
}));

test("预测：没有每天花费（不给读、新加的还没读到）退回余额快照的老办法，结果和以前一样", withClock(() => {
  const h = history();
  h.data.old = snapshots(100, 24, 3); // 3 小时花 24 → 每天 192（近 3 小时的老办法）
  const legacy = h.predict("old");
  assert.equal(legacy.basis, "fallback");
  assert.deepEqual(legacy, h.predictFromSnapshots("old"));
  h.setDailySpend("old", [], { denied: true });
  assert.deepEqual(h.predict("old"), legacy, "不给读：照老办法");
  h.setDailySpend("old", [{ day: day(30), usd: 1 }]); // 只有很早的、近 7 天没有一天的数：也退回
  assert.deepEqual(h.predict("old"), legacy);
  h.setDailySpend("old", []);
  assert.deepEqual(h.predict("old"), legacy);
  assert.equal(h.predict("nothing"), null);
}));

test("预测：近 7 天一分钱没花、最近 24 小时也没降 → 在花钱是假，不给可用天数；24 小时在降就按它算", withClock(() => {
  const h = history();
  h.setDailySpend("idle", rows(0, 0, 0, 0, 0, 0, 0));
  h.data.idle = snapshots(40, 0);
  const idle = h.predict("idle");
  assert.deepEqual([idle.burnPerDay, idle.etaDays], [0, null]);
  h.data.idle = snapshots(40, 8);
  assert.deepEqual([h.predict("idle").burnPerDay, h.predict("idle").etaDays], [8, 5], "每天花费读到的全是 0，但余额在降：24 小时那项兜住，提醒不晚");
}));

test("接口给页面：dailySpendView 读到了（ok）给近 30 天整天 + 今天；最后一个是今天", withClock(() => {
  const h = history();
  h.setDailySpend("a", [{ day: day(40), usd: 1 }, { day: day(2), usd: 2 }, { day: day(1), usd: 3 }]);
  h.data.a = [[NOW - 5 * 24 * HOUR, 50, 0], [NOW, 49, 0]];
  assert.deepEqual(h.dailySpendView("a", { usd: 1.5, estimate: true }), {
    state: "ok", source: "upstream", days: [{ day: day(2), usd: 2 }, { day: day(1), usd: 3 }, { day: TODAY, usd: 1.5 }], since: day(5), todayEstimate: true });
  assert.deepEqual(h.dailySpendView("a").days.map((d) => d.day), [day(2), day(1)], "没给今天就不放");
}));

test("接口给页面：不给读（denied）和读不到（pending）时每天的数用余额快照里每天下降的（充值不算、没快照的天不出现），since 是开始监控那天", withClock(() => {
  const h = history();
  // 4 天前开始监控：4 天前 50→48，3 天前 48→45（中间充值 +100 不算）、2 天前没快照、1 天前 145→141，今天 141→140
  h.data.d = [[NOW - 4 * 24 * HOUR + HOUR, 50, 0], [NOW - 4 * 24 * HOUR + 2 * HOUR, 48, 0], [NOW - 3 * 24 * HOUR, 45, 0], [NOW - 3 * 24 * HOUR + HOUR, 145, 0],
    [NOW - 1 * 24 * HOUR, 141, 0], [NOW - 1 * 24 * HOUR + HOUR, 141, 0], [NOW, 140, 0]];
  h.setDailySpend("d", [], { denied: true });
  const denied = h.dailySpendView("d", { usd: 1, estimate: true });
  assert.equal(denied.state, "denied");
  assert.equal(denied.source, "balance");
  assert.equal(denied.since, day(4));
  assert.deepEqual(denied.days, [{ day: day(4), usd: 2 }, { day: day(3), usd: 3 }, { day: day(1), usd: 4 }, { day: TODAY, usd: 1 }]);
  h.setDailySpend("d", []);
  assert.equal(h.dailySpendView("d").state, "pending", "没读到也没被拒：读不到");
  assert.deepEqual(h.dailySpendView("d").days.slice(0, 3), denied.days.slice(0, 3), "读不到时同样给余额快照算的");
  assert.deepEqual(h.dailySpendView("nothing"), { state: "pending", source: "balance", days: [], since: null, todayEstimate: false });
}));

// 最近 24 小时每半小时一个快照：前 21 小时共花 early、最近 3 小时共花 late，最后剩 balance
function surgeSnapshots(balance, early, late) {
  const drops = Array.from({ length: 48 }, (_, i) => (i < 42 ? early / 42 : late / 6)); // drops[i]：第 i 个点到第 i+1 个点之间的下降
  return Array.from({ length: 49 }, (_, i) => [NOW - (48 - i) * HOUR / 2, balance + drops.slice(i).reduce((sum, drop) => sum + drop, 0), 0]);
}

test("预测：花费突然暴涨（最近 3 小时的速度超过 2 倍）马上按 3 小时的速度算，可用天数立刻变短；忙闲交替不动；暴跌有 7 天平均托着", withClock(() => {
  const h = history();
  h.setDailySpend("a", rows(10, 10, 10, 10, 10, 10, 10));
  // 平时每天 10：前 21 小时花 1.5，最近 3 小时花 12.5（按每天 100 的速度在烧）；24 小时那项只有 14
  h.data.a = surgeSnapshots(100, 1.5, 12.5);
  assert.equal(h.burnRate("a", 24, 1, 5).burnPerDay, 14, "24 小时那项只折到 14");
  const surge = h.predict("a");
  assert.deepEqual([surge.burnPerDay, surge.etaDays, surge.basis], [100, 1, "fast24h"], "按 3 小时的速度：可用 1 天，不是 24 小时那项的 7.1 天");
  // 忙时段：最近 3 小时是全天平均的 1.2 倍、1.9 倍：日均不动
  for (const late of [1.5, 2.375]) {
    h.data.a = surgeSnapshots(100, 1.5, late);
    const busy = h.predict("a");
    assert.deepEqual([busy.burnPerDay, busy.etaDays, busy.basis], [10, 10, "7d"], `3 小时速度 ${late * 8}/天（≤ 2 倍）：不动`);
  }
  // 暴跌：最近 3 小时一分钱没花，7 天平均托着
  h.data.a = surgeSnapshots(100, 6, 0);
  const crash = h.predict("a");
  assert.deepEqual([crash.burnPerDay, crash.etaDays, crash.basis], [10, 10, "7d"]);
  // 3 小时的点不够（4 个）：不看这一项
  h.data.a = [[NOW - 3 * HOUR, 120, 0], [NOW - 2 * HOUR, 112, 0], [NOW - 1 * HOUR, 106, 0], [NOW, 100, 0]];
  assert.deepEqual([h.predict("a").burnPerDay, h.predict("a").basis], [20, "fast24h"], "点不够时只看 24 小时那项（花了 20）");
}));

test("接口给页面：读失败会再试的上游是 failed，和新上游正在读（pending）分开；读到了就是 ok", withClock(() => {
  const h = history();
  h.setDailySpend("f", [], { failed: true });
  assert.equal(h.dailySpendView("f").state, "failed");
  assert.equal(h.dailySpendView("new").state, "pending");
  h.setDailySpend("f", [], { denied: true, failed: true });
  assert.equal(h.dailySpendView("f").state, "denied", "不给读比读失败说得准");
  h.setDailySpend("f", rows(1, 2, 3), { failed: true });
  assert.equal(h.dailySpendView("f").state, "ok", "有读到的天就是 ok");
}));

test("排序：新上游按真实花费排；夜里（近 3 小时没动静）不会掉到后面", withClock(() => {
  const h = history();
  // 两个上游：A 余额 100、每天真花 10（10 天）；B 余额 150、每天真花 20（7.5 天）。夜里近 3 小时两个都没花钱
  for (const [id, balance, perDay] of [["a", 100, 10], ["b", 150, 20]]) {
    h.data[id] = [[NOW - 20 * HOUR, balance + perDay * 20 / 24, 0], [NOW - 4 * HOUR, balance + perDay * 4 / 24, 0], ...Array.from({ length: 8 }, (_, i) => [NOW - (7 - i) * HOUR / 2, balance, 0])];
  }
  const items = () => ["a", "b"].map((id) => ({ id, name: id, remaining: h.data[id].at(-1)[1], burnPerDay: h.predict(id)?.burnPerDay }));
  // 老办法：近 3 小时一点没降 → 都是「最近没在花钱」
  assert.deepEqual(items().map((item) => item.burnPerDay), [0, 0], "老办法夜里：两个都像没花钱");
  h.setDailySpend("a", rows(10, 10, 10, 10, 10, 10, 10));
  h.setDailySpend("b", rows(20, 20, 20, 20, 20, 20, 20));
  const order = (list) => orderUpstreams(list, NOW).map((item) => item.id);
  const night = items();
  assert.deepEqual(night.map((item) => item.burnPerDay), [10, 20], "夜里也是真实的日均");
  assert.deepEqual(order(night), ["b", "a"], "B 只能撑 7.5 天、A 10 天：B 在前");
  // 白天近 3 小时花得多（忙时段，全天平均的 1.2 倍、1.6 倍）：日均不跟着乱跳
  h.data.a = snapshots(100, 1.5, 3);
  h.data.b = snapshots(150, 4, 3);
  assert.equal(h.predictFromSnapshots("a").burnPerDay, 12, "老办法白天：近 3 小时花 1.5 → 日均 12");
  assert.equal(h.predictFromSnapshots("b").burnPerDay, 32);
  assert.deepEqual(items().map((item) => item.burnPerDay), [10, 20], "新办法白天：忙闲交替（2 倍以内）日均不跟着乱跳");
  assert.deepEqual(order(items()), ["b", "a"], "白天排序不变");
}));
