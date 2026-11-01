// 用户运营页的纯函数（users-format.ts）：概览那一句话、五个数、地址栏、几处文字、补数据那一行。
// 用户表的筛选、排序、分页在服务端，测在 lib/user-ops-view.test.js。
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
  backfillEta, backfillLine, balanceWarmLine, bigLabel, bigTipText, deltaText, freshNote, lastUsedText, listQueryString, money, overviewKpis, overviewSentence,
  parseGroups, parseOnly, parsePageNo, parseScope, parseSort, parseTab, prevSeriesOf, runwayText, seriesOf, sparkValues, BIG_LINK, SOON_LINK,
} = await import("./users-format.ts");
const { EMPTY } = await import("../../../lib/format.js");
const { dayStartInTz } = await import("../../../lib/business-time.js");

const TZ = "Asia/Shanghai";
const NOW = dayStartInTz("2026-11-01", TZ) + 14.5 * 3600000; // 11-01 14:30 上海
const row = (over) => ({
  id: 1, username: "a", big: false, disabled: false, group: "default", createdAtMs: null, usedUsd: null, isNew: false, week: 100, prevWeek: 100, today: 10, balanceUsd: 50,
  runwayState: "ok", days: 20, burnPerDay: 2.5, level: 0, status: null, lastUsed: null, spark: Array(14).fill(1), ...over,
});
const READY = { backfillDone: true, week: true, compare: true, churn: true, down: true, balance: true, prepaidCompare: true };
const SUMMARY = {
  todayCost: 20, yesterdaySameTime: 10, weekCost: 1000, prevWeekCost: 1250, weekUsers: 8, prevWeekUsers: 10, weekNewUsers: 3, prevWeekNewUsers: 3,
  newUsers30: 6, prevNewUsers30: 5, prepaid: 500, prepaidAgo: 400, bigWeek: 820,
};
const FACTS = { riser: { id: 1, username: "orange-lab", delta: 60 }, down: [{ id: 2, username: "wang-lab" }], soonBig: 2 };
const list = (over = {}) => ({ rows: [], total: 0, page: 1, pages: 1, pageSize: 50, totals: { count: 0, week: 0, prevWeek: 0, today: 0, balance: 0 }, counts: { scope: { active30: 0, all: 0 }, big: 0, only: { all: 0, soon: 0, down: 0, new: 0, churned: 0 } }, groups: [], ...over });
const page = (over = {}) => ({
  asOf: NOW, syncedMs: NOW - 60000, tz: TZ, today: "2026-11-01", rate: 1, ownStationId: "own1", level1Days: 3, ready: READY, availableDays: 30, fresh: true,
  backfill: { done: true, core: true, days: 90, total: 90 }, big: { ready: true, ids: [], count: 5 }, summary: SUMMARY, facts: FACTS, trend: [], prevTrend: [], list: list(), ...over,
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

test("「只看重点用户 N」：个数跟着当前范围走；名单还没算出来（近 7 天没补到）写「—」", () => {
  assert.equal(bigLabel(page({ big: { ready: true, ids: [1, 2, 3], count: 3 } })), COPY.users.onlyBig("3"));
  assert.equal(bigLabel(page(), 2), COPY.users.onlyBig("2"), "切到「近 30 天有消费」，只数这个范围里的重点用户");
  assert.equal(bigLabel(page({ big: { ready: false, ids: [], count: 0 } })), COPY.users.onlyBig(EMPTY));
});

test("「重点」小标签的提示：这位占近 7 天消费的百分之几、重点用户合起来占百分之几（取整）；没补到近 7 天或全站是 0 只写「重点用户」", () => {
  const p = page({ big: { ready: true, ids: [1, 2], count: 2 }, summary: { ...SUMMARY, weekCost: 1000, bigWeek: 830 } });
  assert.equal(bigTipText(row({ week: 260 }), p), "重点用户：占近 7 天消费 26%。2 个重点用户合起来占 83%");
  assert.equal(bigTipText(row({ week: 570 }), p), "重点用户：占近 7 天消费 57%。2 个重点用户合起来占 83%");
  assert.equal(bigTipText(row({ week: 260 }), page({ ready: { ...READY, week: false } })), COPY.bigTipPlain);
  assert.equal(bigTipText(row({ week: 260 }), page({ summary: { ...SUMMARY, weekCost: 0 } })), COPY.bigTipPlain);
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

test("概览那一句（补满以后）：近 7 天、比前 7 天、几个重点用户占多少、涨得最多、在下滑、几个重点用户快用完", () => {
  const parts = overviewSentence(page());
  assert.equal(text(parts), "近 7 天用户消费 ¥1,000.00，比前 7 天少 20.0%，5 个重点用户占 82%；orange-lab 涨得最多（+¥60.00），wang-lab 在下滑；2 个重点用户快用完。");
  assert.deepEqual(parts.filter((part) => part.kind === "user").map((part) => [part.id, part.name]), [[1, "orange-lab"], [2, "wang-lab"]], "两个名字是链接，点了开抽屉");
  assert.equal(parts.filter((part) => part.kind === "soon").length, 1, "「N 个重点用户快用完」是链接");
  assert.deepEqual(parts.filter((part) => part.kind === "big").map((part) => part.text), ["5 个重点用户"], "「5 个重点用户」是链接，到用户页签勾上只看重点用户");
  assert.equal(SOON_LINK, "/users?tab=users&big=1&only=soon");
  assert.equal(BIG_LINK, "/users?tab=users&big=1");
});

test("概览那一句：没有快用完的重点用户写原话、不加链接；没有在下滑的不写那半句；三个以上在下滑只写个数；没有重点用户不写集中度", () => {
  const none = overviewSentence(page({ facts: { riser: { id: 1, username: "a", delta: 30 }, down: [], soonBig: 0 } }));
  assert.match(text(none), /；没有快用完的重点用户。$/);
  assert.ok(!text(none).includes("在下滑"));
  assert.equal(none.filter((part) => part.kind === "soon").length, 0);
  assert.match(text(overviewSentence(page({ facts: { riser: null, down: ["d1", "d2", "d3"].map((name, i) => ({ id: 10 + i, username: name })), soonBig: 0 } }))), /；3 个用户在下滑/);
  assert.match(text(overviewSentence(page({ facts: { riser: null, down: [{ id: 1, username: "d1" }, { id: 2, username: "d2" }], soonBig: 0 } }))), /；d1、d2 在下滑/);
  assert.ok(!text(overviewSentence(page({ big: { ready: true, ids: [], count: 0 } }))).includes("个重点用户占"), "还没有重点用户：不写集中度");
  assert.ok(!text(overviewSentence(page({ summary: { ...SUMMARY, weekCost: 0, prevWeekCost: 0, bigWeek: 0 } }))).includes("个重点用户占"), "全站是 0：不写占百分之几");
});

test("概览那一句：前 7 天没有消费、持平、涨了；名单没算出来（近 7 天没补到）或余额没记满时不提重点用户快用完", () => {
  assert.match(text(overviewSentence(page({ summary: { ...SUMMARY, weekCost: 100, prevWeekCost: 100, bigWeek: 80 } }))), /和前 7 天一样/);
  assert.match(text(overviewSentence(page({ summary: { ...SUMMARY, weekCost: 100, prevWeekCost: 0, bigWeek: 80 } }))), /前 7 天没有消费/);
  assert.match(text(overviewSentence(page({ summary: { ...SUMMARY, weekCost: 150, prevWeekCost: 100, bigWeek: 80 } }))), /比前 7 天多 50.0%/);
  const noBig = text(overviewSentence(page({ big: { ready: false, ids: [], count: 0 } })));
  assert.ok(!noBig.includes("重点用户"));
  const warming = text(overviewSentence(page({ ready: { ...READY, balance: false } })));
  assert.ok(!warming.includes("快用完"), "余额没记满 24 小时不判快用完，也就不说「没有快用完的重点用户」");
});

test("概览那一句（补数据中）：只说近 7 天消费，后面写「补满以后再说谁在涨、谁在掉」，不点名、不提快用完", () => {
  const filling = overviewSentence(page({ ready: { ...READY, compare: false, down: false, churn: false, balance: false, backfillDone: false }, backfill: { done: false, days: 9, total: 90 } }));
  assert.equal(text(filling), `近 7 天用户消费 ¥1,000.00。${COPY.overview.afterFill}`);
  assert.ok(filling.every((part) => part.kind === "text"));
  const early = overviewSentence(page({ ready: { ...READY, week: false, compare: false } }));
  assert.equal(text(early), COPY.overview.sentenceWait, "近 7 天都没补到：一个数也不说");
});

test("五个数：补满以后每个带对比；人数一样多写「和前 7 天一样多」；补数据中「比前 7 天」写补满后再比，预收写上线满 7 天后再比，今天照常比", () => {
  const full = overviewKpis(page());
  assert.deepEqual(full.map((kpi) => kpi.key), ["today", "week", "users", "fresh", "prepaid"]);
  assert.deepEqual(full.map((kpi) => kpi.title), ["今天消费", "近 7 天消费", "活跃用户", "新消费用户", "预收"]);
  assert.deepEqual(full.map((kpi) => kpi.value), ["¥20.00", "¥1,000.00", "8 个", "3 个", "¥500.00"]);
  assert.deepEqual(full.map((kpi) => kpi.sub), [
    "比昨天同一时段 +100.0%", "比前 7 天 −20.0%", "比前 7 天 −2 个", "和前 7 天一样多", "比 7 天前 +25.0%",
  ]);
  assert.equal(full[3].titleHint, "近 7 天第一次花钱的用户");
  const more = overviewKpis(page({ summary: { ...SUMMARY, weekNewUsers: 5, prevWeekNewUsers: 2 } }));
  assert.equal(more[3].sub, "比前 7 天 +3 个");
  const filling = overviewKpis(page({ ready: { ...READY, week: false, compare: false, prepaidCompare: false } }));
  assert.deepEqual(filling.map((kpi) => kpi.value), ["¥20.00", EMPTY, EMPTY, EMPTY, "¥500.00"], "今天、预收照常，近 7 天的数补满前写「—」");
  assert.deepEqual(filling.map((kpi) => kpi.sub), ["比昨天同一时段 +100.0%", COPY.overview.afterFillCompare, COPY.overview.afterFillCompare, COPY.overview.afterFillCompare, COPY.overview.afterWeekCompare]);
  assert.equal(overviewKpis(page({ summary: null })).length, 0);
  const noYesterday = overviewKpis(page({ summary: { ...SUMMARY, yesterdaySameTime: 0 } }));
  assert.equal(noYesterday[0].sub, `${COPY.overview.vsYesterday} ${COPY.users.newLabel}`, "昨天同一时段没有消费、今天有：写「新」");
});

test("补数据那一行：数字跟着走；前 60 天补到了、再往前补的那段写另一句；补完了余额还没记满 24 小时是另一句；两件事都好了就没有", () => {
  const filling = page({ backfill: { done: false, core: false, days: 12, total: 90 }, ready: { ...READY, backfillDone: false } });
  assert.equal(backfillLine(filling, true), COPY.backfill(12, 90, "4 小时", true));
  assert.match(backfillLine(filling, true), /趋势图先画补好的 12 天/);
  assert.ok(!backfillLine(filling, false).includes("趋势图"), "用户页签那一句不提趋势图");
  const more = page({ backfill: { done: false, core: true, days: 66, total: 90 } });
  assert.equal(backfillLine(more, true), COPY.backfillMore(66, 90, "1 小时"));
  assert.ok(!backfillLine(more, true).includes("补满再算"), "前 60 天已经补到：比前 7 天这些已经能算，不再说补满再算");
  assert.equal(backfillLine(page(), true), null);
  assert.equal(balanceWarmLine(page({ ready: { ...READY, balance: false } })), COPY.balanceWarm);
  assert.equal(balanceWarmLine(page()), null);
  assert.equal(balanceWarmLine(filling), null, "补数据没补完时用上面那一句");
});

test("补数据预计还要多久：每 10 分钟补 3 天；不到 1 小时写分钟，按小时四舍五入、至少 1 小时", () => {
  assert.equal(backfillEta(0, 30), "2 小时", "刚开始：10 轮 × 10 分钟 = 100 分钟，约 2 小时");
  assert.equal(backfillEta(0, 90), "5 小时", "90 天：30 轮 × 10 分钟");
  assert.equal(backfillEta(21, 30), "30 分钟");
  assert.equal(backfillEta(29, 30), "10 分钟");
  assert.equal(backfillEta(27, 30), "10 分钟");
  assert.equal(backfillEta(12, 30), "1 小时");
});

test("图的数：消费、活跃用户、新消费用户没补到的天都是 null", () => {
  const trend = [
    { day: "2026-10-30", available: false, cost: 0, users: 0, newUsers: 2, newTop: [], top: [] },
    { day: "2026-10-31", available: true, cost: 5, users: 3, newUsers: 1, newTop: [], top: [] },
  ];
  assert.deepEqual(seriesOf(trend, "cost"), [null, 5]);
  assert.deepEqual(seriesOf(trend, "users"), [null, 3]);
  assert.deepEqual(seriesOf(trend, "fresh"), [null, 1], "第一次花钱靠用量判断，没补到的天也判不了");
});

test("前 30 天的虚线：消费、活跃用户要补完回补才画，没补到的天是 null；新消费用户是柱子，不画虚线", () => {
  const prevTrend = [{ day: "a", available: true, cost: 4, users: 2, newUsers: 1 }, { day: "b", available: false, cost: 0, users: 0, newUsers: 0 }];
  const p = page({ prevTrend });
  assert.deepEqual(prevSeriesOf(p, "cost"), [4, null]);
  assert.deepEqual(prevSeriesOf(p, "users"), [2, null]);
  assert.equal(prevSeriesOf(p, "fresh"), null);
  const filling = page({ prevTrend, backfill: { done: false, days: 12, total: 90 } });
  assert.equal(prevSeriesOf(filling, "cost"), null, "补数据中不画虚线、不出图例");
  assert.equal(prevSeriesOf(filling, "users"), null);
});

test("新消费用户图旁边那行小字：近 30 天共几个、前 30 天几个；前 30 天没补全只写近 30 天；近 30 天没补全不写", () => {
  const day = (available) => ({ day: "d", available, cost: 0, users: 0, newUsers: 0, newTop: [], top: [] });
  const prev = (available) => ({ day: "d", available, cost: 0, users: 0, newUsers: 0 });
  assert.equal(freshNote(page({ trend: [day(true)], prevTrend: [prev(true)] })), "近 30 天共 6 个，前 30 天 5 个");
  assert.equal(freshNote(page({ trend: [day(true)], prevTrend: [prev(false)] })), "近 30 天共 6 个");
  assert.equal(freshNote(page({ trend: [day(false)], prevTrend: [prev(false)] })), null);
  assert.equal(freshNote(page({ summary: null })), null);
});

test("地址栏：不认识的页签回到概览，不认识的筛选、范围、排法回到默认；分组可以多个", () => {
  assert.equal(parseTab("users"), "users");
  assert.equal(parseTab("churn"), "overview", "流失、需求还不能点，地址里写了也回到概览");
  assert.equal(parseTab(null), "overview");
  assert.equal(parseOnly("soon"), "soon");
  assert.equal(parseOnly("churned"), "churned");
  assert.equal(parseOnly("low"), "all", "旧链接里的 low、idle 不再认识");
  assert.equal(parseOnly(null), "all");
  assert.equal(parseScope("all"), "all");
  assert.equal(parseScope("bogus"), "active30");
  assert.deepEqual(parseSort("balance", "asc"), { key: "balance", dir: "asc" });
  assert.deepEqual(parseSort("balance", "x"), { key: "balance", dir: "desc" });
  assert.deepEqual(parseSort("vs", "asc"), { key: "week", dir: "desc" });
  assert.deepEqual(parseGroups("vip, default,"), ["vip", "default"]);
  assert.deepEqual(parseGroups(null), []);
  assert.deepEqual([parsePageNo("3"), parsePageNo("0"), parsePageNo("x"), parsePageNo(null)], [3, 1, 1, 1]);
});

test("用户表的查询串：默认值不写，和接口、地址栏同一套写法", () => {
  const base = { scope: "active30", big: false, only: "all", groups: [], sort: "week", dir: "desc", page: 1, q: "" };
  assert.equal(listQueryString(base), "");
  assert.equal(listQueryString({ ...base, scope: "all", big: true, only: "soon", groups: ["vip", "default"], sort: "user", dir: "asc", page: 2, q: " ali " }), "scope=all&big=1&only=soon&group=vip%2Cdefault&sort=user&dir=asc&page=2&q=ali");
  assert.equal(listQueryString({ ...base, sort: "week", dir: "asc" }), "sort=week&dir=asc", "近 7 天消费从低到高也要写出来");
});
