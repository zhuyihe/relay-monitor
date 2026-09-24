// 成本与利润页的数据整理：把 /api/analytics 与 /api/own/analytics 的响应整理成各面板要用的形状。
// 口径与旧页面一致：成本只算上游（非自营且计入利润），¥ 由接口按站点汇率折算；
// 缺记录的日子标成缺失，不补零。纯函数，不依赖 React。
import { formatMonthDay, isoDay, parseDay } from "../../../lib/format";
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

export const md = (iso: string | null | undefined) => {
  const d = iso ? parseDay(iso) : null;
  return d ? formatMonthDay(d) : "—";
};

// 连续日期合并成区间：9月1日至9月5日、9月8日
export function runsText(dates: string[], max = 3) {
  const runs: [string, string][] = [];
  for (const d of dates) {
    const last = runs[runs.length - 1];
    if (last && addDays(last[1], 1) === d) last[1] = d;
    else runs.push([d, d]);
  }
  const parts = runs.slice(0, max).map(([a, b]) => (a === b ? md(a) : `${md(a)}至${md(b)}`));
  return runs.length > max ? `${parts.join("、")}等` : parts.join("、");
}

// 缺口资源摘要：沿用旧页面"X 缺 N 天；另有 N 个"的写法
export function gapSummary(gaps: any[], unit = "个上游") {
  if (!gaps.length) return "";
  const labels = gaps.slice(0, 2).map((g) => {
    const name = g.stationName || g.stationId || "上游";
    const n = Number(g.missingDays);
    return Number.isFinite(n) && n > 0 ? `${name} 缺 ${n} 天` : `${name} 有采集缺口`;
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

const rateOf = (s: any) => (s && s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1);

export function derive(data: any, own: any) {
  const stations: any[] = Array.isArray(data?.stations) ? data.stations : [];
  const upstream = stations.filter((s) => !s.isOwn && s.includeInProfit !== false);
  const upIds = new Set(upstream.map((s) => s.id));
  const days = Math.max(1, Number(data.days) || 1);
  const dates = Array.from({ length: days }, (_, i) => addDays(data.start, i));
  const inWindow = new Set(dates);
  const coverage = data.coverage || null;
  const allGaps: any[] = Array.isArray(coverage?.stationGaps) ? coverage.stationGaps : [];

  // 每日用量成本，以及每天有哪些上游留下了日汇总记录
  const usageBy = new Map<string, number>();
  const seenBy = new Map<string, Set<string>>();
  const withRows = new Set<string>();
  for (const r of Array.isArray(data.daily) ? data.daily : []) {
    if (!upIds.has(r.stationId) || !inWindow.has(r.date)) continue;
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

  // 接口不返回资源类型，这里用"有日汇总记录或出现在覆盖缺口里"识别需要采集用量的上游；
  // 纯固定成本的上游两者都不满足，不会被误判为缺数据。
  const gapIds = new Set(allGaps.map((g) => g.stationId));
  const monitored = upstream.filter((s) => withRows.has(s.id) || gapIds.has(s.id));
  const upstreamGaps = allGaps.filter((g) => upIds.has(g.stationId));

  // 日收入：自营分析只给窗口总收入，按每日下游消费占比摊到天（与旧页面同一算法），
  // 保证收入合计与利润口径一致。
  let incomeBy: Map<string, number> | null = null;
  let incomeIssue: string | null = null;
  if (own && own.profit && !own.profit.error && Array.isArray(own.trend)) {
    const rate = own.station?.cnyPerUsd > 0 ? own.station.cnyPerUsd : 1;
    const trendTotal = own.trend.reduce((a: number, t: any) => a + (Number(t.cost) || 0), 0);
    if (trendTotal > 0) {
      const ratio = own.profit.incomeCny / (trendTotal * rate);
      incomeBy = new Map();
      for (const t of own.trend) {
        const key = isoDay(new Date(t.t));
        incomeBy.set(key, r2((incomeBy.get(key) || 0) + t.cost * rate * ratio));
      }
    } else if (!(Number(own.profit.incomeCny) > 0)) {
      // 下游没有消费时收入就是 0，照常显示
      incomeBy = new Map();
    } else {
      incomeIssue = "有收入但缺少逐日消费记录，无法按天分摊。";
    }
  } else if (own && own.profit?.error) {
    incomeIssue = String(own.profit.error);
  } else if (own && !Array.isArray(own.trend)) {
    incomeIssue = "自营站点没有返回逐日消费记录。";
  }

  const missingDates: string[] = [];
  const partialDates: string[] = [];
  const rows: TrendRow[] = dates.map((date) => {
    const n = seenBy.get(date)?.size || 0;
    const missing = monitored.length > 0 && n === 0;
    const partial = !missing && n < monitored.length;
    if (missing) missingDates.push(date);
    if (partial) partialDates.push(date);
    return {
      date,
      rev: incomeBy ? incomeBy.get(date) || 0 : null,
      cost: missing ? null : r2(usageBy.get(date) || 0),
      fixed: r2(fixedBy.get(date) || 0),
      today: date === data.end,
      partial,
      missing,
    };
  });

  const revenue = incomeBy ? r2(rows.reduce((a, r) => a + (r.rev || 0), 0)) : null;
  const usage = r2(rows.reduce((a, r) => a + (r.cost || 0), 0));
  const fixed = r2(rows.reduce((a, r) => a + r.fixed, 0));

  // 概况：只按有记录的日子算日均与峰值，缺失日不当作零成本拉低平均
  const covered = rows.filter((r) => !r.missing).map((r) => ({ date: r.date, cost: r2((r.cost || 0) + r.fixed), today: r.today }));
  const coveredTotal = covered.reduce((a, r) => a + r.cost, 0);
  const avg = r2(coveredTotal / Math.max(1, covered.length));
  const peak = covered.reduce<(typeof covered)[number] | null>((a, r) => (!a || r.cost > a.cost ? r : a), null);

  // 成本构成：按上游合计用量成本 + 固定成本；一条记录都没有的上游标成缺失而不是 0
  const gapById = new Map(upstreamGaps.map((g) => [g.stationId, g]));
  const mix: MixItem[] = upstream
    .map((s) => ({
      id: s.id,
      name: s.name,
      archived: !!s.archivedAt,
      usage: Number(s.totalCny) || 0,
      fixed: Number(s.fixedCny) || 0,
      unknown: gapIds.has(s.id) && !withRows.has(s.id),
      missingDays: Number(gapById.get(s.id)?.missingDays) || 0,
    }))
    .filter((m) => m.unknown || m.usage + m.fixed > 0)
    .sort((a, b) => Number(a.unknown) - Number(b.unknown) || b.usage + b.fixed - (a.usage + a.fixed));

  // 消耗时段：接口给的是窗口内每个"星期 × 小时"的合计（weekday 0 = 周一）
  const avail = data.heatmapAvailability;
  const heatAvailable = avail ? !!avail.available : days <= 30 && data.heatmapAvailable !== false;
  const heatReason: HeatReason = heatAvailable
    ? null
    : avail?.reason || (days > 30 ? "range-not-supported" : "incomplete-raw-history");
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  if (heatAvailable) {
    for (const h of Array.isArray(data.heatmap) ? data.heatmap : []) {
      const w = Number(h.weekday);
      const hr = Number(h.hour);
      if (w >= 0 && w < 7 && hr >= 0 && hr < 24) grid[w][hr] = r2(grid[w][hr] + (Number(h.cny) || 0));
    }
  }
  const heatEmpty = heatAvailable && !grid.some((row) => row.some((v) => v > 0));
  const heatGaps: any[] = Array.isArray(avail?.coverage?.stationGaps) ? avail.coverage.stationGaps : [];

  // 可用天数：沿用旧页面口径，全部资源里有预测值的都列出，最紧急的在最上面
  const runway = stations
    .filter((s) => s.runway && s.runway.etaDays != null)
    .map((s) => ({
      id: s.id,
      name: s.name,
      archived: !!s.archivedAt,
      isOwn: !!s.isOwn,
      days: Number(s.runway.etaDays),
      burnCny: Number(s.runway.burnPerDay) * rateOf(s),
      basis: s.runway.basis || null,
    }))
    .sort((a, b) => a.days - b.days);

  return {
    dates,
    rows,
    hasIncome: !!incomeBy,
    incomeIssue,
    revenue,
    usage,
    fixed,
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
    heat: { available: heatAvailable, reason: heatReason, grid, empty: heatEmpty, gaps: heatGaps },
    runway,
  };
}

export type Derived = ReturnType<typeof derive>;
