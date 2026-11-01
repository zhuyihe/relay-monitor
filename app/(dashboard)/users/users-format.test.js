// 用户运营页的纯函数（users-format.ts）：概览那一句话、四个数、用户表的筛选和排法、几处文字、补数据那一行。
// node 直接跑 .ts（去掉类型）；同目录不带后缀的导入（"./copy"）靠下面的 resolve 钩子补 .ts，写法同 reconciliation/profit-format.test.js。
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
    const path = fileURLToPath(new URL(specifier, context.parentURL));
    if (!existsSync(path) && existsSync(`${path}.ts`)) return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });

const { COPY } = await import("./copy.ts");
const {
  backfillEta, backfillLine, balanceWarmLine, bigLabel, bigTipText, defaultOrder, deltaText, filterCounts, filterRows, lastUsedText, money, overviewKpis, overviewSentence,
  parseOnly, parseTab, runwayText, seriesOf, sortValue, sparkValues, SOON_LINK,
} = await import("./users-format.ts");
const { EMPTY } = await import("../../../lib/format.js");
const { dayStartInTz } = await import("../../../lib/business-time.js");

const TZ = "Asia/Shanghai";
const NOW = dayStartInTz("2026-11-01", TZ) + 14.5 * 3600000; // 11-01 14:30 上海
const row = (over) => ({
  id: 1, username: "a", big: false, disabled: false, createdAtMs: null, isNew: false, week: 100, prevWeek: 100, today: 10, balanceUsd: 50,
  runwayState: "ok", days: 20, burnPerDay: 2.5, level: 0, status: null, lastUsed: null, spark: Array(14).fill(1), ...over,
});
const READY = { backfillDone: true, week: true, compare: true, inactive: true, down: true, balance: true, prepaidCompare: true };
const page = (over = {}) => ({
  asOf: NOW, syncedMs: NOW - 60000, tz: TZ, today: "2026-11-01", rate: 1, ownStationId: "own1", level1Days: 3, ready: READY, availableDays: 30, fresh: true,
  backfill: { done: true, days: 30, total: 30 }, big: { ready: true, ids: [], count: 0 },
  summary: { todayCost: 20, yesterdaySameTime: 10, weekCost: 1000, prevWeekCost: 1250, weekUsers: 8, prevWeekUsers: 10, prepaid: 500, prepaidAgo: 400 },
  trend: [], prevNewUsers: [], users: [], ...over,
});
const text = (parts) => parts.map((part) => part.text ?? part.name).join("");

test("比前 7 天：带正负号；前 7 天是 0、这 7 天才有写「新」；两边都是 0 写「—」；减号是 −", () => {
  assert.equal(deltaText(115.5, 100), "+15.5%");
  assert.equal(deltaText(77.1, 100), "−22.9%");
  assert.equal(deltaText(100, 100), "0.0%");
  assert.equal(deltaText(5, 0), COPY.users.newLabel);
  assert.equal(deltaText(0, 0), EMPTY);
  assert.equal(deltaText(0, 80), "−100.0%");
});

test("钱按汇率换算：没有数写「—」，不写 0", () => {
  assert.equal(money(10, 7.5), "¥75.00");
  assert.equal(money(null, 7.5), EMPTY);
  assert.equal(money(undefined, 1), EMPTY);
  assert.equal(money(0, 7.5), "¥0.00");
});

test("筛选：只看重点用户和状态能叠着用；「快用完」含余额用完；搜索不分大小写", () => {
  const users = [
    row({ id: 1, username: "Orange", big: true, status: "soon", week: 300 }),
    row({ id: 2, username: "wu", big: true, status: "empty", week: 200 }),
    row({ id: 3, username: "kevin", big: false, status: "soon", week: 50 }),
    row({ id: 4, username: "sun", big: true, status: "down", week: 150 }),
    row({ id: 5, username: "newbie", status: "new", isNew: true, week: 1 }),
    row({ id: 6, username: "gone", status: "inactive", week: 0 }),
    row({ id: 7, username: "plain", status: null }),
  ];
  const ids = (list) => list.map((item) => item.id);
  assert.deepEqual(ids(filterRows(users, { big: false, only: "all", q: "" })), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ids(filterRows(users, { big: true, only: "all", q: "" })), [1, 2, 4]);
  assert.deepEqual(ids(filterRows(users, { big: false, only: "low", q: "" })), [1, 2, 3], "快用完含余额用完");
  assert.deepEqual(ids(filterRows(users, { big: true, only: "low", q: "" })), [1, 2], "从概览点「N 个重点用户快用完」过来的那一屏");
  assert.deepEqual(ids(filterRows(users, { big: false, only: "down", q: "" })), [4]);
  assert.deepEqual(ids(filterRows(users, { big: false, only: "new", q: "" })), [5]);
  assert.deepEqual(ids(filterRows(users, { big: false, only: "idle", q: "" })), [6]);
  assert.deepEqual(ids(filterRows(users, { big: false, only: "all", q: "  ORANGE " })), [1]);
  assert.deepEqual(filterCounts(page({ users }), true), { all: 3, low: 2, down: 1, new: 0, idle: 0 }, "勾上重点用户，个数只算重点用户");
  assert.deepEqual(filterCounts(page({ users }), false), { all: 7, low: 3, down: 1, new: 1, idle: 1 });
});

test("还判不了的类个数是 null（页面写「—」）：在下滑要补满 17 天、快用完要余额记满 24 小时、不活跃要补到 8 天；新用户不用等", () => {
  const users = [row({ id: 1, status: "new", isNew: true })];
  const counts = filterCounts(page({ users, ready: { ...READY, down: false, balance: false, inactive: false } }), false);
  assert.deepEqual(counts, { all: 1, low: null, down: null, new: 1, idle: null });
});

test("「只看重点用户 N」：名单还没算出来（近 7 天没补到）写「—」", () => {
  assert.equal(bigLabel(page({ big: { ready: true, ids: [1, 2, 3], count: 3 } })), COPY.users.onlyBig("3"));
  assert.equal(bigLabel(page({ big: { ready: false, ids: [], count: 0 } })), COPY.users.onlyBig(EMPTY));
});

test("「重点」小标签的提示：这位占近 7 天消费的百分之几、重点用户合起来占百分之几（取整）；没补到近 7 天或全站是 0 只写「重点用户」", () => {
  const users = [
    row({ id: 1, username: "a", big: true, week: 260 }), row({ id: 2, username: "b", big: true, week: 570 }),
    row({ id: 3, username: "c", big: false, week: 170 }),
  ];
  const p = page({ users, summary: { ...page().summary, weekCost: 1000 } });
  assert.equal(bigTipText(users[0], p), "重点用户：占近 7 天消费 26%。2 个重点用户合起来占 83%");
  assert.equal(bigTipText(users[1], p), "重点用户：占近 7 天消费 57%。2 个重点用户合起来占 83%");
  assert.equal(bigTipText(users[0], page({ users, ready: { ...READY, week: false } })), COPY.bigTipPlain);
  assert.equal(bigTipText(users[0], page({ users, summary: { ...page().summary, weekCost: 0 } })), COPY.bigTipPlain);
});

test("默认排法：近 7 天消费从高到低，一样多按今天，再按名字", () => {
  const order = defaultOrder([
    row({ id: 1, username: "b", week: 100, today: 5 }),
    row({ id: 2, username: "a", week: 100, today: 5 }),
    row({ id: 3, username: "c", week: 100, today: 9 }),
    row({ id: 4, username: "d", week: 300, today: 0 }),
  ]);
  assert.deepEqual(order.map((item) => item.id), [4, 3, 2, 1]);
});

test("点表头排的值：比前 7 天没补满前是 null；前 7 天是 0 的排最前；可用天数只有快用完、够用的才有数", () => {
  assert.equal(sortValue(row({ week: 120, prevWeek: 100 }), "vs", false), null);
  assert.equal(sortValue(row({ week: 120, prevWeek: 100 }), "vs", true), 0.2);
  assert.equal(sortValue(row({ week: 5, prevWeek: 0 }), "vs", true), Infinity);
  assert.equal(sortValue(row({ week: 0, prevWeek: 0 }), "vs", true), null);
  assert.equal(sortValue(row({ runwayState: "empty", days: null }), "days", true), null);
  assert.equal(sortValue(row({ runwayState: "soon", days: 2 }), "days", true), 2);
  assert.equal(sortValue(row({ status: "soon" }), "status", true), 1);
  assert.equal(sortValue(row({ status: null }), "status", true), null);
  assert.equal(sortValue(row({ lastUsed: { ms: 5, precise: true } }), "last", true), 5);
});

test("可用天数那一格：约 13 天、近期没有消费、余额用完和算不出写「—」", () => {
  assert.equal(runwayText(row({ runwayState: "ok", days: 13 })), "约 13 天");
  assert.equal(runwayText(row({ runwayState: "soon", days: 0.4 })), "约 10 小时");
  assert.equal(runwayText(row({ runwayState: "none", days: null })), COPY.users.noSpend);
  assert.equal(runwayText(row({ runwayState: "empty", days: null })), EMPTY);
  assert.equal(runwayText(row({ runwayState: "warming", days: null })), EMPTY);
});

test("最近使用：今天 / 昨天 / 10月20日；抽屉里带那一小时的起点；还没用过的新用户写原话", () => {
  const p = page();
  const hour = (h, day = "2026-11-01") => dayStartInTz(day, TZ) + h * 3600000;
  assert.equal(lastUsedText(row({ lastUsed: { ms: hour(14), precise: true } }), p), COPY.users.today, "消费在 13:00–14:00 那一小时，结束是 14:00 整，还算今天");
  assert.equal(lastUsedText(row({ lastUsed: { ms: hour(14), precise: true } }), p, true), `${COPY.users.today} 13:00`);
  assert.equal(lastUsedText(row({ lastUsed: { ms: hour(24, "2026-10-31"), precise: true } }), p), COPY.users.yesterday, "昨天最后一小时（23:00–24:00），结束是今天 0 点，仍算昨天");
  assert.equal(lastUsedText(row({ lastUsed: { ms: hour(0, "2026-10-20"), precise: false } }), p), "10月20日");
  assert.equal(lastUsedText(row({ lastUsed: null, isNew: true }), p), COPY.users.notUsed);
  assert.equal(lastUsedText(row({ lastUsed: null }), p), EMPTY);
});

test("小趋势线：补数据还没补到的天是 null，从昨天往前数补到几天", () => {
  const r = row({ spark: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] });
  assert.deepEqual(sparkValues(r, 30), r.spark);
  assert.deepEqual(sparkValues(r, 3), [...Array(11).fill(null), 12, 13, 14]);
  assert.deepEqual(sparkValues(r, 0), Array(14).fill(null));
});

test("概览那一句（补满以后）：近 7 天、比前 7 天、涨得最多、在下滑、几个重点用户快用完", () => {
  const users = [
    row({ id: 1, username: "orange-lab", week: 400, prevWeek: 340 }),
    row({ id: 2, username: "wang-lab", week: 100, prevWeek: 300, status: "down" }),
    row({ id: 3, username: "kevin-ai", big: true, status: "soon", week: 200, prevWeek: 200 }),
    row({ id: 4, username: "sun", big: true, status: "empty", week: 100, prevWeek: 100 }),
    row({ id: 5, username: "small", status: "soon", week: 5, prevWeek: 5 }),
  ];
  const parts = overviewSentence(page({ users }));
  assert.equal(text(parts), "近 7 天用户消费 ¥1,000.00，比前 7 天少 20.0%；orange-lab 涨得最多（+¥60.00），wang-lab 在下滑；2 个重点用户快用完。");
  assert.deepEqual(parts.filter((part) => part.kind === "user").map((part) => [part.id, part.name]), [[1, "orange-lab"], [2, "wang-lab"]], "两个名字是链接，点了开抽屉");
  assert.equal(parts.filter((part) => part.kind === "soon").length, 1, "「N 个重点用户快用完」是链接");
  assert.equal(SOON_LINK, "/users?tab=users&big=1&only=low");
});

test("概览那一句：不是重点用户的快用完不提；没有快用完的重点用户写原话、不加链接；没有在下滑的不写那半句；三个以上在下滑只写个数", () => {
  const base = [row({ id: 1, username: "a", week: 130, prevWeek: 100 }), row({ id: 2, username: "b", status: "soon", week: 5, prevWeek: 5 })];
  const none = overviewSentence(page({ users: base }));
  assert.match(text(none), /；没有快用完的重点用户。$/);
  assert.ok(!text(none).includes("在下滑"));
  assert.ok(!text(none).includes("b"), "不是重点用户的快用完，这句话不提");
  assert.equal(none.filter((part) => part.kind === "soon").length, 0);
  const downs = ["d1", "d2", "d3"].map((name, index) => row({ id: 10 + index, username: name, status: "down", week: 10, prevWeek: 100 + index }));
  assert.match(text(overviewSentence(page({ users: downs }))), /3 个用户在下滑/);
  const two = text(overviewSentence(page({ users: downs.slice(0, 2) })));
  assert.match(two, /d2、d1 在下滑|d1、d2 在下滑/);
});

test("概览那一句：前 7 天没有消费、持平、涨了；名单没算出来（近 7 天没补到）或余额没记满时不提重点用户", () => {
  const flat = overviewSentence(page({ summary: { ...page().summary, weekCost: 100, prevWeekCost: 100 }, users: [] }));
  assert.match(text(flat), /和前 7 天一样/);
  const first = overviewSentence(page({ summary: { ...page().summary, weekCost: 100, prevWeekCost: 0 }, users: [] }));
  assert.match(text(first), /前 7 天没有消费/);
  const up = overviewSentence(page({ summary: { ...page().summary, weekCost: 150, prevWeekCost: 100 }, users: [] }));
  assert.match(text(up), /比前 7 天多 50.0%/);
  const noBig = text(overviewSentence(page({ big: { ready: false, ids: [], count: 0 }, users: [] })));
  assert.ok(!noBig.includes("重点用户"));
  const warming = text(overviewSentence(page({ ready: { ...READY, balance: false }, users: [] })));
  assert.ok(!warming.includes("重点用户"), "余额没记满 24 小时不判快用完，也就不说「没有快用完的重点用户」");
});

test("概览那一句（补数据中）：只说近 7 天消费，后面写「补满以后再说谁在涨、谁在掉」，不点名、不提快用完", () => {
  const filling = overviewSentence(page({ ready: { ...READY, compare: false, down: false, inactive: false, balance: false, backfillDone: false }, backfill: { done: false, days: 9, total: 30 }, users: [row({ status: "soon", big: true })] }));
  assert.equal(text(filling), `近 7 天用户消费 ¥1,000.00。${COPY.overview.afterFill}`);
  assert.ok(filling.every((part) => part.kind === "text"));
  const early = overviewSentence(page({ ready: { ...READY, week: false, compare: false } }));
  assert.equal(text(early), COPY.overview.sentenceWait, "近 7 天都没补到：一个数也不说");
});

test("四个数：补满以后每个带对比；补数据中「比前 7 天」写补满后再比，预收写上线满 7 天后再比，今天照常比", () => {
  const full = overviewKpis(page());
  assert.deepEqual(full.map((kpi) => kpi.key), ["today", "week", "users", "prepaid"]);
  assert.deepEqual(full.map((kpi) => kpi.value), ["¥20.00", "¥1,000.00", "8 个", "¥500.00"]);
  assert.deepEqual(full.map((kpi) => kpi.sub), [
    "比昨天同一时段 +100.0%", "比前 7 天 −20.0%", "比前 7 天 −2 个", "比 7 天前 +25.0%",
  ]);
  const filling = overviewKpis(page({ ready: { ...READY, week: false, compare: false, prepaidCompare: false } }));
  assert.deepEqual(filling.map((kpi) => kpi.value), ["¥20.00", EMPTY, EMPTY, "¥500.00"], "今天、预收照常，近 7 天的数补满前写「—」");
  assert.deepEqual(filling.map((kpi) => kpi.sub), ["比昨天同一时段 +100.0%", COPY.overview.afterFillCompare, COPY.overview.afterFillCompare, COPY.overview.afterWeekCompare]);
  assert.equal(overviewKpis(page({ summary: null })).length, 0);
  const noYesterday = overviewKpis(page({ summary: { ...page().summary, yesterdaySameTime: 0 } }));
  assert.equal(noYesterday[0].sub, `${COPY.overview.vsYesterday} ${COPY.users.newLabel}`, "昨天同一时段没有消费、今天有：写「新」");
});

test("补数据那一行：数字跟着走；补完了余额还没记满 24 小时是另一句；两件事都好了就没有", () => {
  const filling = page({ backfill: { done: false, days: 12, total: 30 }, ready: { ...READY, backfillDone: false } });
  assert.equal(backfillLine(filling, true), COPY.backfill(12, 30, "1 小时", true));
  assert.match(backfillLine(filling, true), /趋势图先画补好的 12 天/);
  assert.ok(!backfillLine(filling, false).includes("趋势图"), "用户页签那一句不提趋势图");
  assert.equal(backfillLine(page(), true), null);
  assert.equal(balanceWarmLine(page({ ready: { ...READY, balance: false } })), COPY.balanceWarm);
  assert.equal(balanceWarmLine(page()), null);
  assert.equal(balanceWarmLine(filling), null, "补数据没补完时用上面那一句");
});

test("补数据预计还要多久：每 10 分钟补 3 天；不到 1 小时写分钟，按小时四舍五入、至少 1 小时", () => {
  assert.equal(backfillEta(0, 30), "2 小时", "刚开始：10 轮 × 10 分钟 = 100 分钟，约 2 小时");
  assert.equal(backfillEta(21, 30), "30 分钟");
  assert.equal(backfillEta(29, 30), "10 分钟");
  assert.equal(backfillEta(27, 30), "10 分钟");
  assert.equal(backfillEta(12, 30), "1 小时");
});

test("图的数：消费、有消费的用户没补到的天是 null；新用户不受影响", () => {
  const trend = [
    { day: "2026-10-30", available: false, cost: 0, users: 0, newUsers: 2, top: [] },
    { day: "2026-10-31", available: true, cost: 5, users: 3, newUsers: 1, top: [] },
  ];
  assert.deepEqual(seriesOf(trend, "cost"), [null, 5]);
  assert.deepEqual(seriesOf(trend, "users"), [null, 3]);
  assert.deepEqual(seriesOf(trend, "fresh"), [2, 1], "新用户看注册时间，补数据没补到的天也有");
});

test("地址栏：不认识的页签回到概览，不认识的筛选回到「全部」", () => {
  assert.equal(parseTab("users"), "users");
  assert.equal(parseTab("churn"), "overview", "流失、需求还不能点，地址里写了也回到概览");
  assert.equal(parseTab(null), "overview");
  assert.equal(parseOnly("low"), "low");
  assert.equal(parseOnly("bogus"), "all");
  assert.equal(parseOnly(null), "all");
});
