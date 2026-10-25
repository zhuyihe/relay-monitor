// B1 新旧对拍的比较本身：合并以后的写法和 tests/b-legacy.mjs 里原来那几份逐一对比，返回不同的地方。
// 常驻的 tests/b-parity.test.mjs（一小组代表）和一次性的 scripts/b-parity-sweep.mjs（全部时区、2025–2027 每一天）都用这一份。
// 每条不同记下 family（比的是哪一类）、tz、label（哪一天）和 involved（结果用到了哪几天的 0 点），由调用方判断是不是允许的不同。
// 计划 7c 和 b-legacy.mjs 一起删。
import { isDeepStrictEqual } from "node:util";
import * as legacy from "./b-legacy.mjs";
import {
  billDayOf, canonicalTimeZone, checkTimeZone, dayKeyInTz, dayStartInTz, isDayStartInTz, isValidTimeZone, shiftDayLabel, shiftedDayStartInTz,
  tzOffsetMs, wallTimeInTz, weekdayHourInTz, zonedParts,
} from "../lib/business-time.js";
import { completedBillingDayWindow, isCompletedBillingWindow, nextBillingEffectiveFrom, startOfBillingDay } from "../lib/reconciliation-scope-policy.js";
import { sameReconciliationWindow } from "../lib/reconciliation-contract.js";
import { isConfiguredRate, rateSnapshotOf, ratesFor, toCny } from "../lib/profit.js";
import { resolveReconciliationWindow } from "../server/reconciliation.js";
import { SETTLE_LOOKBACK_MS, isSettleableWindow, isSettledAt, settlementOutcome, settlementPrecheck } from "../lib/reconciliation-settlement.js";
import { LEDGER_DECIMAL_SCALE, ledgerDecimal, ledgerEntryFromRow, ledgerWriteDecision, sameLedgerContent } from "../lib/reconciliation-ledger.js";
import { isSettledConfirmedSource } from "../server/reconciliation-repository.js";
import { reportClock } from "../server/report.js";

const same = isDeepStrictEqual;

function outcome(fn) {
  try { return { value: fn() }; } catch (error) { return { error: error.code || error.name }; }
}

// 一个时刻：属于哪天（四份）、时区偏移、星期几和钟点、日报定时的钟点、自营分析的小时。哪个时区都不该不同
export function instantDiffs(tz, ms) {
  const diffs = [], push = (family, now, before) => { if (!same(now, before)) diffs.push({ family, tz, ms, now, before }); };
  const key = dayKeyInTz(ms, tz);
  push("dayKey.reconciliation", key, legacy.localDate(ms, tz));
  push("dayKey.snapshot", key, legacy.snapshotLocalDate(ms, tz));
  push("dayKey.providers", key, legacy.dateStrInTz(ms, tz));
  push("tzOffsetMs", tzOffsetMs(tz, ms), legacy.tzOffsetMs(tz, ms));
  push("weekdayHourInTz", weekdayHourInTz(ms, tz), legacy.weekdayHourInTz(ms, tz));
  push("reportClock", reportClock(ms, tz), legacy.reportClock(ms, tz));
  push("ownAnalyticsHour", zonedParts(ms, tz).hour, legacy.ownAnalyticsHourOf(ms, tz));
  return diffs;
}

// 一天：某天 0 点（B、C 两套）、今天/昨天/近 7 天/本月的窗口、整天的窗口是哪天的账和过完没有、Sub2API 能不能按整天取账、
// 用量页把上游给的日期换成时间点（D）。involved 是结果用到了哪几天的 0 点：只有这几天里有某天的 0 点新旧算法不同，结果才可能不同
export function dayDiffs(tz, label) {
  const diffs = [], push = (family, involved, now, before) => { if (!same(now, before)) diffs.push({ family, tz, label, involved, now, before }); };
  const next = shiftDayLabel(label, 1), noon = wallTimeInTz(label, 12, tz), start = dayStartInTz(label, tz);
  push("startOfBillingDay", [label], startOfBillingDay(noon, tz), legacy.startOfBillingDay(noon, tz));
  push("nextBillingEffectiveFrom", [next], nextBillingEffectiveFrom(tz, noon), legacy.nextBillingEffectiveFrom(tz, noon));
  push("completedBillingDayWindow", [shiftDayLabel(label, -1), label], completedBillingDayWindow(tz, noon), legacy.completedBillingDayWindow(tz, noon));
  for (const days of [-6, -1, 0, 1]) push(`midnight(${days})`, [shiftDayLabel(label, days)], shiftedDayStartInTz(noon, days, tz), legacy.midnight(noon, tz, days));
  for (const now of [start, noon]) {
    for (const preset of ["today", "yesterday", "7d", "month"]) {
      push(`resolveWindow.${preset}`, [label, shiftDayLabel(label, -1), shiftDayLabel(label, -6), `${label.slice(0, 8)}01`],
        outcome(() => resolveReconciliationWindow({ preset, timezone: tz }, now)), outcome(() => legacy.resolveReconciliationWindow({ preset, timezone: tz }, now)));
    }
  }
  // 起点、终点分别取新旧几份算出来的 0 点（平常日子都一样，去重后只剩一个），再各差 1 毫秒
  const starts = new Set([start, legacy.startOfBillingDay(noon, tz), legacy.midnight(noon, tz)]);
  const ends = new Set([dayStartInTz(next, tz), legacy.nextBillingEffectiveFrom(tz, noon)]);
  for (const startMs of starts) {
    for (const endMs of ends) {
      for (const window of [{ startMs, endMs, timezone: tz }, { startMs: startMs + 1, endMs, timezone: tz }, { startMs, endMs: endMs - 1, timezone: tz }]) {
        const involved = [label, next];
        push("billDayOf", involved, billDayOf(window), legacy.billingDayOf(window));
        push("dayAligned", involved, isDayStartInTz(window.startMs, tz) && isDayStartInTz(window.endMs, tz), legacy.dayAligned(window));
        for (const at of [window.endMs - 1, window.endMs + 15 * 60000]) {
          push("isCompletedBillingWindow", [...involved, dayKeyInTz(at, tz)], isCompletedBillingWindow(window, at), legacy.isCompletedBillingWindow(window, at));
        }
        // Sub2API 账单「是不是整天」：原来看本地钟点是不是 00:00:00，现在用 isDayStartInTz（lib/providers.js queryKeyReconciliationStat）。
        // 取数时刻放在一天以后：截止点不是 0 点的都算「今天」截止点过旧，两份都拒绝
        const observedAt = window.endMs + 86400000;
        const now = isDayStartInTz(window.startMs, tz) && isDayStartInTz(window.endMs, tz)
          ? { value: { startDate: dayKeyInTz(window.startMs, tz), endDate: dayKeyInTz(window.endMs - 1, tz), live: false } }
          : { error: "UPSTREAM_WINDOW_UNSUPPORTED" };
        push("sub2NaturalDay", involved, now, outcome(() => legacy.sub2NaturalDayWindow(window.startMs, window.endMs, tz, observedAt)));
      }
    }
  }
  push("parseDateLabel", [label], dayStartInTz(label, tz), legacy.parseDateLabel(label, tz));
  return diffs;
}

// 某天 0 点新旧算法（A：business-time；B：scope-policy；C：reconciliation.js）不同的日子，即 B-T1
export function dayStartDiffers(tz, label) {
  const noon = wallTimeInTz(label, 12, tz), start = dayStartInTz(label, tz);
  return start !== legacy.startOfBillingDay(noon, tz) || start !== legacy.midnight(noon, tz);
}

// 时区名：校验、规范写法，以及 providers、接入预览、页面、用量接口各自那份
export function timeZoneNameDiffs(name) {
  const diffs = [], push = (family, now, before) => { if (!same(now, before)) diffs.push({ family, name: String(name), now, before }); };
  push("checkTimeZone", outcome(() => checkTimeZone(name)), outcome(() => legacy.validateTimezone(name)));
  push("canonicalTimeZone", outcome(() => canonicalTimeZone(name)), outcome(() => legacy.canonicalTimezone(name)));
  // providers 的 reconciliationTimezone：外面那层 UPSTREAM_WINDOW_UNSUPPORTED 的包装没变，只换了里面那一句
  push("providers.reconciliationTimezone",
    outcome(() => { try { return canonicalTimeZone(name); } catch { throw Object.assign(new Error(), { code: "UPSTREAM_WINDOW_UNSUPPORTED" }); } }),
    outcome(() => legacy.reconciliationTimezone(name)));
  // 接入预览：合法的结果一样；不合法的原来抛没有码的 RangeError，现在抛 TIMEZONE_INVALID（接口直接传错时区才碰得到，界面不传），只比抛没抛
  const onboarding = outcome(() => canonicalTimeZone(name)), before = outcome(() => legacy.onboardingTimezone(name, null));
  push("onboarding", [onboarding.value, !onboarding.error], [before.value, !before.error]);
  // 页面链接里的时区（lib/client.ts）：先挡掉了空的
  if (typeof name === "string" && name) push("client", isValidTimeZone(name), legacy.clientTimezoneValid(name));
  push("usageRoute", isValidTimeZone(String(name || "")) ? String(name || "") : Intl.DateTimeFormat().resolvedOptions().timeZone, legacy.usageRouteTimezone(name));
  return diffs;
}

// 两段窗口：每个调用方传的选项和它原来那份比较
export function windowPairDiffs(a, b) {
  const diffs = [], push = (family, now, before) => { if (now !== before) diffs.push({ family, a, b, now, before }); };
  push("view/cache asRequested", sameReconciliationWindow(a, b, { asRequested: true, timezone: false }), legacy.viewSameReconciliationWindow(a, b));
  push("sameAbsoluteWindow", sameReconciliationWindow(a, b, { timezone: false }), legacy.sameAbsoluteWindow(a, b));
  if (b) {
    // 两个仓库：账本最新一版的行（库里读出来是字符串）、读出来的那一版
    const row = a && { timezone: a.timezone, window_start_ms: String(a.startMs), window_end_ms: String(a.endMs) };
    push("ledger row", !!row && sameReconciliationWindow({ timezone: row.timezone, startMs: Number(row.window_start_ms), endMs: Number(row.window_end_ms) }, b),
      !!legacy.ledgerRowSameWindow(row, b));
    push("ledger entry", !!a && sameReconciliationWindow(a, b), !!legacy.ledgerEntrySameWindow(a, b));
  }
  // 两边有一边没有窗口的，页面和账单比较都碰不到（commonWindow 先滤掉空的，账单一侧总带窗口）；原来那份两边都没有时说「相同」
  if (!a || !b) return diffs;
  push("page sameWindow", sameReconciliationWindow(a, b), legacy.pageSameWindow(a, b));
  push("page sameRequestedWindow", sameReconciliationWindow(a, b) || sameReconciliationWindow(a, b, { asRequested: true }), legacy.pageSameRequestedWindow(a, b));
  // 账单窗口总带时区；没写时区时原来按进程时区补，碰不到
  if (a.timezone && b.timezone) push("windowsMatch canonical", sameReconciliationWindow(a, b, { timezone: "canonical" }), legacy.windowsMatch(a, b));
  return diffs;
}

export function windowSet({ presets = ["today", "7d", "month", "yesterday", "custom", undefined],
  timezones = ["Asia/Shanghai", "asia/shanghai", "UTC", undefined], ends = [0, -1, 1000] } = {}) {
  const start = Date.parse("2026-10-08T16:00:00Z"), end = start + 86400000, list = [];
  for (const preset of presets) {
    for (const startMs of [start, start + 1]) {
      for (const delta of ends) for (const timezone of timezones) list.push({ preset, startMs, endMs: end + delta, timezone });
    }
  }
  return list;
}

// 汇率：设没设、账本存下的、一条绑定两侧的、折人民币
export function rateDiffs(values = [null, undefined, "", 0, -1, "7.2", 7.2, "abc", 0.5]) {
  const diffs = [], push = (family, input, now, before) => { if (!same(now, before)) diffs.push({ family, input, now, before }); };
  const stations = values.map((cnyPerUsd, index) => ({ id: `s${index}`, cnyPerUsd }));
  for (const station of stations) {
    const rate = rateSnapshotOf(station);
    push("isConfiguredRate/station", station, isConfiguredRate(rate), legacy.stationRateConfigured(station));
    push("isConfiguredRate/view", station, isConfiguredRate(rate), legacy.viewConfigured(rate));
    push("isConfiguredRate/row", station, isConfiguredRate(rate), legacy.rowRateConfigured(rate));
    push("configuredRate", station, isConfiguredRate(rate) ? rate.cnyPerUsd : null, legacy.configuredRate(rate));
    for (const usd of [1.234, 2, "3", "x", null]) push("toCny", [usd, station], toCny(usd, rate), legacy.toCny(usd, rate));
  }
  // 账本里存下的汇率是 DECIMAL(12,6) 读回来的正数：原来只看 source，现在还要求是正数，可达的值上结论相同
  for (const saved of [7.2, 0.000001, 6.5]) {
    const rate = { cnyPerUsd: saved, source: "configured" };
    push("isConfiguredRate/saved row", saved, isConfiguredRate(rate), legacy.rowRateConfigured(rate));
    push("isConfiguredRate/saved view", saved, isConfiguredRate(rate), legacy.viewConfigured(rate));
  }
  const fixed = { id: "fixed", cnyPerUsd: 7, fixedPurchases: [{ amount: 1, days: 1 }] };
  const byId = new Map([...stations, fixed].map((station) => [station.id, station]));
  const stationOf = (id) => byId.get(id);
  for (const own of [...stations, null]) {
    for (const upstream of [...stations, fixed, null]) push("ratesFor/inspectScope", [own, upstream], ratesFor({ own, upstream }), legacy.financialSnapshotOf(own, upstream));
  }
  // factsFor：已固定（账本存了汇率）、未固定、账本没存汇率、站点已删除；成本计法依次取账本、结果、现在。这里照 server/reconciliation.js 的写法拼
  const ledgers = [null, { rates: { income: 7.1, cost: 6.9 }, costBasis: "usage" }, { rates: { income: null, cost: null }, costBasis: null },
    { rates: { income: 7.1, cost: null }, costBasis: "fixed" }];
  for (const ownStationId of [...stations.map((station) => station.id), "gone"]) {
    for (const upstreamStationId of ["s6", "s0", "fixed", "gone"]) {
      for (const costBasis of [undefined, "usage", "fixed"]) {
        for (const ledger of ledgers) {
          const result = { rule: { ownStationId, upstreamStationId }, costBasis };
          const { income, cost, costBasis: basis } = ratesFor({ own: stationOf(ownStationId), upstream: stationOf(upstreamStationId), saved: ledger, costBasis });
          push("ratesFor/factsFor", { ownStationId, upstreamStationId, costBasis, ledger },
            { income: { stationId: ownStationId, ...income }, cost: { stationId: upstreamStationId, ...cost }, costBasis: basis }, legacy.factsRates(result, ledger, stationOf));
        }
      }
    }
  }
  return diffs;
}

// ---- B2 ----

const SETTLE_DELAY_MS = 15 * 60000;

// 结账判定：一段窗口在某个时刻。只比原来真会传进来的窗口：轮询、读已固定的账、迁移只拿整天的窗口；
// 原来「旧记录算不算结账」（isSettledRecord）只在读侧门槛放行以后才问。
// 允许的不同只有 B-S1：仓库挑旧确认记录时，生成在结束到结束满等待期之间的（或没有生成时刻、现在落在这段里），原来认、现在不认
// C2a 起「轮询要不要结」看状态表（settlementPrecheck 的 state），重试间隔按退避表：有状态行时的判断是有意改的新行为，单测在
// lib/reconciliation-settlement.test.js、server/reconciliation.test.js 的 C2a 用例里，不和 B2 以前的写法对拍；
// 没有状态行、账本里也没这天、结束在 7 天以内的那一小部分，新旧语义一样，下面照原来的写法对拍（C2b 恢复，审核 C2a 低-6）。
export function settlementDiffs({ window, now, rules = [], generatedAts = [null] }) {
  const diffs = [], push = (family, now_, before, extra = {}) => { if (!same(now_, before)) diffs.push({ family, window, now, ...extra, now_: now_, before }); };
  const wholeDay = !!billDayOf(window), gate = legacy.readSettledGate(window, now, false);
  push("isSettleableWindow", isSettleableWindow(window, now), legacy.serverIsSettleableWindow(window, now));
  for (const resettle of [false, true]) push("readSettled", settlementPrecheck({ window, now, resettle }).readSettled, legacy.readSettledGate(window, now, resettle));
  // 没有状态行、账本里也没这天、结束在 7 天以内：要不要结，新旧一样（有状态行时的判断是有意改的，单测在别处）
  if (wholeDay && now - window.endMs < SETTLE_LOOKBACK_MS) {
    for (const rule of rules) push("due", settlementPrecheck({ rule, window, now, state: null, ledgerHasDay: false }).due, legacy.settlementWindowDue(rule, window, now) !== null, { rule });
  }
  if (gate) push("settledRecord", false, legacy.isSettledRecord(null, window));
  for (const generatedAt of generatedAts) {
    if (wholeDay) push("migration", isSettledAt(window, generatedAt), legacy.migrationSettled(window.endMs, generatedAt), { generatedAt });
    if (gate) push("settledRecord", isSettledAt(window, generatedAt), legacy.isSettledRecord({ generatedAt }, window), { generatedAt });
    const source = { window: { ...window, startMs: String(window.startMs), endMs: String(window.endMs) }, resultGeneratedAt: generatedAt };
    const repoNow = isSettledConfirmedSource(source, source.window, now), repoBefore = legacy.repositoryIsSettledConfirmedSource(source, source.window, now);
    if (repoNow !== repoBefore) {
      const at = Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : now;
      diffs.push({ family: !repoNow && at >= window.endMs && at < window.endMs + SETTLE_DELAY_MS ? "B-S1" : "repository confirmed source", window, now, generatedAt, now_: repoNow, before: repoBefore });
    }
  }
  for (const profitUsd of [null, 0, 1.5]) {
    for (const notEffective of [false, true]) {
      const result = { window, calculation: { profitUsd }, scope: notEffective ? { notEffective } : {} };
      const { settled, ledger, confirmedSnapshot } = settlementOutcome({ window, result, now });
      const before = legacy.persistSettlement(result, now);
      push("outcome", [settled, ledger, ["observation", ...(confirmedSnapshot ? ["confirmed"] : [])]], [before.settled, before.ledgerDay, before.snapshots]);
    }
  }
  // 页面「还在读取」：整天的判断、开始时刻是不是 0 点。页面上的窗口来自服务端结果，总写着时区；
  // 没写时区时原来按上海算、billDayOf 不算整天，碰不到
  if (window.timezone) {
    push("view whole day", wholeDay, legacy.viewIsWholeDay(window));
    push("view midnight", isDayStartInTz(window.startMs, window.timezone), legacy.viewIsMidnight(window.startMs, window.timezone));
  }
  return diffs;
}

// 账本写不写：latest 是库里最新一版的行（DECIMAL 读出来是定点字符串）。
// 允许的不同只有 B-L1：重结、窗口相同、内容（按存进表的小数位）也相同，原来写下一版、现在不写
export function ledgerDiffs(row, entry, resettle) {
  const now = ledgerWriteDecision(row && ledgerEntryFromRow(row), entry, { resettle }), before = legacy.ledgerWrite(row, entry, resettle);
  // 原来只决定写不写、第几版、source；settledAt 是 B2 新带回的，不比
  const pick = ({ write, revision, source }) => write ? { write, revision, source } : { write: false };
  if (same(pick(now), before)) return [];
  const allowed = resettle && !now.write && before.write && sameLedgerContent(ledgerEntryFromRow(row), entry);
  return [{ family: allowed ? "B-L1" : "ledger write", row, entry, resettle, now, before }];
}

// 内存仓库模拟 DECIMAL：原来用 toFixed（按二进制近似值舍），现在和 MySQL 一样按十进制写法四舍五入。只在正好落在舍入中点上的值不同
export function decimalDiffs(values) {
  const diffs = [];
  for (const value of values) {
    for (const scale of new Set(Object.values(LEDGER_DECIMAL_SCALE))) {
      const now = ledgerDecimal(value, scale), before = legacy.memoryDecimal(value, scale);
      if (now !== before) diffs.push({ value, scale, now, before });
    }
  }
  return diffs;
}
