// 成本估算页的数据整理：把 /api/analytics 与 /api/own/analytics 的响应整理成各面板要用的形状。
// 算法与「自营业务」一致（lib/profit.js）：成本只算上游（非自营且计入利润），¥ 由接口按各上游的汇率换算；
// 上游成本只算按用量计费的上游，配了固定付费的上游只按天平摊（costBasis = fixed），不重复算余额下降。
// 日期按接口返回的业务时区划分，与浏览器时区无关。缺记录的日子标成缺失，不补零。纯函数，不依赖 React。
// 导入带 .js 后缀，单元测试（tests/analytics-derive.test.mjs）可以直接用 node 跑这个文件
import { dayKeyInTz } from "../../../lib/business-time.js";
import { EMPTY, formatDayKey, isoDay, parseDay } from "../../../lib/format.js";
import { stationDisplayName } from "../../../lib/overview-actions.js";
import { countsInProfit, rateSnapshotOf, splitByCumulative } from "../../../lib/profit.js";
import type { TrendRow } from "../../components/trend-panel";

export const r2 = (v: number) => Math.round(v * 100) / 100;

export function addDays(iso: string, n: number) {
  const d = parseDay(iso) || new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

// 按日历日相减，避免夏令时的 23/25 小时影响天数
export function dayDiff(from: string, to: string) {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return 0;
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}

// parseDay 会把 2 月 31 日滚到 3 月，这里要求往返一致才算合法日期
export function validDay(s: string | null | undefined): s is string {
  const d = s ? parseDay(s) : null;
  return !!d && isoDay(d) === s;
}

// 接口按天给的日期「2026-10-09」：今年写「10月9日」，往年带年份；tz 只用来判断「今年」
export const md = (iso: string | null | undefined, tz?: string) => (iso ? formatDayKey(iso, tz) : EMPTY);

// 连续日期合并成区间：9月1日–9月5日、9月8日
export function runsText(dates: string[], tz?: string, max = 3) {
  const runs: [string, string][] = [];
  for (const d of dates) {
    const last = runs[runs.length - 1];
    if (last && addDays(last[1], 1) === d) last[1] = d;
    else runs.push([d, d]);
  }
  const parts = runs.slice(0, max).map(([a, b]) => (a === b ? md(a, tz) : `${md(a, tz)}–${md(b, tz)}`));
  return runs.length > max ? `${parts.join("、")}等` : parts.join("、");
}

// 缺记录的上游点名：「A 缺 3 天、B 缺 1 天，另有 2 个上游」
export function gapSummary(gaps: any[], unit = "个上游") {
  if (!gaps.length) return "";
  const labels = gaps.slice(0, 2).map((g) => {
    const name = stationDisplayName({ name: g.stationName });
    const n = Number(g.missingDays);
    return Number.isFinite(n) && n > 0 ? `${name} 缺 ${n} 天` : `${name} 有几段没有记录`;
  });
  const rest = gaps.length - labels.length;
  return `${labels.join("、")}${rest > 0 ? `，另有 ${rest} ${unit}` : ""}`;
}

export type OwnStatus = "available" | "missing" | "error" | "not-applicable";

export type MixItem = {
  id: string;
  name: string;
  archived: boolean;
  usage: number;
  fixed: number;
  // 该上游在窗口内一条用量记录都没有：用量未知
  unknown: boolean;
  // 部分日子缺记录
  missingDays: number;
};

export type HeatReason = "range-not-supported" | "no-cost-stations" | "incomplete-raw-history" | null;

export function derive(data: any, own: any) {
  const stations: any[] = Array.isArray(data?.stations) ? data.stations : [];
  const upstream = stations.filter(countsInProfit);
  const upIds = new Set(upstream.map((s) => s.id));
  // 按用量计成本的上游；固定付费上游的余额下降不算成本
  const usageUp = upstream.filter((s) => s.costBasis !== "fixed");
  const usageIds = new Set(usageUp.map((s) => s.id));
  const days = Math.max(1, Number(data.days) || 1);
  const dates = Array.from({ length: days }, (_, i) => addDays(data.start, i));
  const inWindow = new Set(dates);
  const coverage = data.coverage || null;
  const allGaps: any[] = Array.isArray(coverage?.stationGaps) ? coverage.stationGaps : [];

  // 每日上游成本，以及每天有哪些按量上游留下了日汇总记录
  const usageBy = new Map<string, number>();
  const seenBy = new Map<string, Set<string>>();
  const withRows = new Set<string>();
  for (const r of Array.isArray(data.daily) ? data.daily : []) {
    if (!usageIds.has(r.stationId) || !inWindow.has(r.date)) continue;
    usageBy.set(r.date, (usageBy.get(r.date) || 0) + (Number(r.cny) || 0));
    if (!seenBy.has(r.date)) seenBy.set(r.date, new Set());
    seenBy.get(r.date).add(r.stationId);
    withRows.add(r.stationId);
  }
  const fixedBy = new Map<string, number>();
  for (const r of Array.isArray(data.fixedDaily) ? data.fixedDaily : []) {
    if (!upIds.has(r.stationId) || !inWindow.has(r.date)) continue;
    fixedBy.set(r.date, (fixedBy.get(r.date) || 0) + (Number(r.cny) || 0));
  }
  // 固定成本合计取各上游整段按天平摊的合计（与「自营业务」同一算法），不用逐日舍入后的值相加；
  // 再按逐日平摊的累计占比分回每天，趋势表合计、累计图终点与等式里的固定成本分毫不差。
  const fixed = r2(upstream.reduce((a, s) => a + (Number(s.fixedCny) || 0), 0));
  const fixedCount = upstream.filter((s) => Number(s.fixedCny) > 0).length;
  const fixedRows = splitByCumulative(dates.map((date) => fixedBy.get(date) || 0), fixed);

  // 用"有日汇总记录或出现在缺记录名单里"识别要记用量的上游；纯固定成本的上游两者都不满足，
  // 配了固定付费的上游已按 costBasis 排除，都不会被误判为缺数据。
  const gapIds = new Set(allGaps.map((g) => g.stationId));
  const monitored = usageUp.filter((s) => withRows.has(s.id) || gapIds.has(s.id));
  const upstreamGaps = allGaps.filter((g) => usageIds.has(g.stationId));

  // 新接口给真实分日收入；旧接口只有模型趋势时明确标估算，并保证分日金额合计守恒。
  let incomeBy: Map<string, number> | null = null;
  let incomeEstimated = false;
  let incomeIssue: string | null = null;
  // 自营站点算收入时报的错：{ code, message }，页面按码归类（noteOf），原文只进「查看详细原因」
  let incomeError: { code: any; message: string } | null = null;
  // 自营站点没设置售价时按 1 美元额度 = 1 元算，收入只是估算；汇率和别处同一个来源（rateSnapshotOf）
  const ownRate = rateSnapshotOf(own?.station);
  const ownNoRate = !!own && ownRate.source !== "configured";
  const hasIncomeDaily = Array.isArray(own?.incomeDaily);
  if (own?.profit && !own.profit.error && hasIncomeDaily) {
    incomeBy = new Map();
    for (const row of own.incomeDaily) incomeBy.set(row.date, (incomeBy.get(row.date) || 0) + Number(row.incomeCny || 0));
    incomeEstimated = own.incomeDailyApprox === true;
  } else if (own && own.profit && !own.profit.error && Array.isArray(own.trend)) {
    incomeEstimated = true;
    const weights = new Map<string, number>();
    const tz = own.tz || data.tz;
    for (const row of own.trend) {
      const date = dayKeyInTz(row.t, tz);
      weights.set(date, (weights.get(date) || 0) + (Number(row.cost) || 0));
    }
    const entries = [...weights].sort(([a], [b]) => a.localeCompare(b));
    const trendTotal = entries.reduce((a, [, cost]) => a + cost, 0);
    if (trendTotal > 0) {
      const parts = splitByCumulative(entries.map(([, cost]) => cost), own.profit.incomeCny);
      incomeBy = new Map(entries.map(([date], i) => [date, parts[i]]));
    } else if (!(Number(own.profit.incomeCny) > 0)) {
      // 下游没有消费时收入就是 0，照常显示
      incomeBy = new Map();
    } else {
      incomeIssue = "有收入，但没有每天的消费记录，没法分到每天。";
    }
  } else if (own && own.profit?.error) {
    incomeError = { code: own.profit.errorCode, message: String(own.profit.error) };
  } else if (own && !Array.isArray(own.trend)) {
    incomeIssue = "自营站点没有给出每天的消费记录。";
  }

  const missingDates: string[] = [];
  const partialDates: string[] = [];
  const rows: TrendRow[] = dates.map((date, i) => {
    const n = seenBy.get(date)?.size || 0;
    const missing = monitored.length > 0 && n === 0;
    const partial = !missing && n < monitored.length;
    if (missing) missingDates.push(date);
    if (partial) partialDates.push(date);
    return {
      date,
      rev: incomeBy ? incomeBy.get(date) || 0 : null,
      cost: missing ? null : r2(usageBy.get(date) || 0),
      fixed: fixedRows[i],
      today: date === data.end,
      partial,
      missing,
    };
  });

  const revenue = incomeBy ? r2(rows.reduce((a, r) => a + (r.rev || 0), 0)) : null;
  // 旧接口的自定义范围取估算后的一部分；有真实分日收入时，截取日子不会降低准确度。
  const ownDays = days <= 7 ? 7 : 30;
  const revenueSplit = !!incomeBy && !hasIncomeDaily && days !== ownDays;
  const usage = r2(rows.reduce((a, r) => a + (r.cost || 0), 0));

  // 概况：只按有记录的日子算日均与峰值，缺失日不当作零成本拉低平均
  const covered = rows.filter((r) => !r.missing).map((r) => ({ date: r.date, cost: r2((r.cost || 0) + r.fixed), today: r.today }));
  const coveredTotal = covered.reduce((a, r) => a + r.cost, 0);
  const avg = r2(coveredTotal / Math.max(1, covered.length));
  const peak = covered.reduce<(typeof covered)[number] | null>((a, r) => (!a || r.cost > a.cost ? r : a), null);

  // 成本构成：每个按量上游的上游成本 + 固定成本；一条记录都没有的上游标成缺失而不是 0
  const gapById = new Map(upstreamGaps.map((g) => [g.stationId, g]));
  const mix: MixItem[] = upstream
    .map((s) => ({
      id: s.id,
      name: stationDisplayName(s),
      archived: !!s.archivedAt,
      usage: usageIds.has(s.id) ? Number(s.totalCny) || 0 : 0,
      fixed: Number(s.fixedCny) || 0,
      unknown: usageIds.has(s.id) && gapIds.has(s.id) && !withRows.has(s.id),
      missingDays: Number(gapById.get(s.id)?.missingDays) || 0,
    }))
    .filter((m) => m.unknown || m.usage + m.fixed > 0)
    .sort((a, b) => Number(a.unknown) - Number(b.unknown) || b.usage + b.fixed - (a.usage + a.fixed));

  // 可用天数：和运营总览的可用天数同一算法，只列上游（不含自营站点），最紧急的在最上面
  const runway = stations
    .filter((s) => !s.isOwn && s.runway && s.runway.etaDays != null)
    .map((s) => ({
      id: s.id,
      name: stationDisplayName(s),
      archived: !!s.archivedAt,
      days: Number(s.runway.etaDays),
      burnCny: Number(s.runway.burnPerDay) * rateSnapshotOf(s).cnyPerUsd,
      basis: s.runway.basis || null,
    }))
    .sort((a, b) => a.days - b.days);

  return {
    tz: (data?.tz as string | undefined) || undefined,
    dates,
    rows,
    hasIncome: !!incomeBy,
    incomeIssue,
    incomeError,
    revenue,
    revenueApprox: !!incomeBy && (ownNoRate || incomeEstimated),
    incomeEstimated,
    ownNoRate,
    revenueSplit,
    ownDays,
    usage,
    fixed,
    fixedCount,
    usageApprox: missingDates.length > 0 || partialDates.length > 0,
    missingDates,
    partialDates,
    monitoredCount: monitored.length,
    upstreamCount: upstream.length,
    upstreamGaps,
    allGaps,
    coverage,
    kpi: {
      total: r2(usage + fixed),
      avg,
      peak,
      monthly: r2(avg * 30),
      coveredDays: covered.length,
    },
    mix,
    heat: deriveHeat(data),
    runway,
  };
}

// 花费时段：接口给的是所选时间内每个"星期 × 小时"的合计（weekday 0 = 周一）
export function deriveHeat(data: any) {
  const days = Math.max(1, Number(data.days) || 1);
  const avail = data.heatmapAvailability;
  const available = avail ? !!avail.available : days <= 30 && data.heatmapAvailable !== false;
  const reason: HeatReason = available ? null : avail?.reason || (days > 30 ? "range-not-supported" : "incomplete-raw-history");
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  if (available) {
    for (const h of Array.isArray(data.heatmap) ? data.heatmap : []) {
      const w = Number(h.weekday);
      const hr = Number(h.hour);
      if (w >= 0 && w < 7 && hr >= 0 && hr < 24) grid[w][hr] = r2(grid[w][hr] + (Number(h.cny) || 0));
    }
  }
  const empty = available && !grid.some((row) => row.some((v) => v > 0));
  const gaps: any[] = Array.isArray(avail?.coverage?.stationGaps) ? avail.coverage.stationGaps : [];
  return { available, reason, grid, empty, gaps, days };
}

export type Derived = ReturnType<typeof derive>;
