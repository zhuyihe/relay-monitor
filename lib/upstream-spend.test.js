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
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 4 }), { burnPerDay: 10, basis: "近7天", days: 7 });
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 25 }), { burnPerDay: 25, basis: "近24小时", days: 7 });
  assert.deepEqual(dailyBurn({ rows: week, today: TODAY, last24h: 10 }), { burnPerDay: 10, basis: "近7天", days: 7 }, "一样大取 7 天");
  assert.deepEqual(dailyBurn({ rows: rows(0, 0, 0, 0, 0, 0, 0), today: TODAY, last24h: 3 }), { burnPerDay: 3, basis: "近24小时", days: 0 });
  assert.equal(dailyBurn({ rows: [], today: TODAY, last24h: 3 }), null);
  assert.equal(dailyBurn({ rows: week, today: TODAY }).burnPerDay, 10, "没给 24 小时就只看 7 天");
});

test("页面上「按什么估的」：近7天、近24小时各有一句话", () => {
  assert.equal(basisText("近7天"), "按近 7 天的花费估算");
  assert.equal(basisText("近24小时"), "按近 24 小时的花费估算");
  assert.equal(basisText("近3小时"), "按近 3 小时的花费估算", "老办法不变");
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
  assert.deepEqual([steady.burnPerDay, steady.etaDays, steady.basis], [10, 10, "近7天"], "24 小时只花了 4，7 天平均 10");
  h.data.a = snapshots(100, 25);
  const surge = h.predict("a");
  assert.deepEqual([surge.burnPerDay, surge.etaDays, surge.basis], [25, 4, "近24小时"], "最近 24 小时花了 25，比 7 天平均快：可用天数 100 ÷ 25 = 4，不晚");
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
  assert.equal(result.basis, "近7天");
  h.data.a = [[NOW - 3 * HOUR, 50, 0], [NOW - 2 * HOUR, 46, 0], [NOW - 1 * HOUR, 546, 0], [NOW, 545, 0]];
  assert.equal(h.predict("a").burnPerDay, 5, "下降 4 + 1 = 5，充值不算");
}));

test("预测：新上游有 30 天数据时马上有日均和可用天数（只有一个余额快照也行）；7 天不满按有数的算", withClock(() => {
  const h = history();
  h.setDailySpend("new", Array.from({ length: 30 }, (_, i) => ({ day: day(30 - i), usd: 6 })));
  h.data.new = [[NOW, 60, 0]];
  assert.equal(h.predictFromSnapshots("new"), null, "老办法这时什么也算不出");
  const result = h.predict("new");
  assert.deepEqual([result.burnPerDay, result.etaDays, result.basis], [6, 10, "近7天"]);
  const young = history();
  young.setDailySpend("y", rows(2, 4)); // 才开了 2 天
  young.data.y = [[NOW, 30, 0]];
  assert.deepEqual([young.predict("y").burnPerDay, young.predict("y").etaDays], [3, 10]);
}));

test("预测：没有每天花费（不给读、新加的还没读到）退回余额快照的老办法，结果和以前一样", withClock(() => {
  const h = history();
  h.data.old = snapshots(100, 24, 3); // 3 小时花 24 → 每天 192（近 3 小时的老办法）
  const legacy = h.predict("old");
  assert.equal(legacy.basis, "近3小时");
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

test("接口给页面：dailySpendView 近 30 天；彻底删除后清空", withClock(() => {
  const h = history();
  h.setDailySpend("a", [{ day: day(40), usd: 1 }, { day: day(2), usd: 2 }, { day: day(1), usd: 3 }]);
  assert.deepEqual(h.dailySpendView("a"), { state: "ok", days: [{ day: day(2), usd: 2 }, { day: day(1), usd: 3 }] });
  assert.equal(h.dailySpendView("none").state, "pending");
  h.setDailySpend("d", [], { denied: true });
  assert.equal(h.dailySpendView("d").state, "denied");
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
  // 白天近 3 小时花得多：日均不跟着乱跳
  h.data.a = snapshots(100, 4, 3);
  h.data.b = snapshots(150, 3, 3);
  assert.equal(h.predictFromSnapshots("a").burnPerDay, 32, "老办法白天：近 3 小时花 4 → 日均 32");
  assert.deepEqual(items().map((item) => item.burnPerDay), [10, 20], "新办法白天：日均不跟着乱跳");
  assert.deepEqual(order(items()), ["b", "a"], "白天排序不变");
}));
