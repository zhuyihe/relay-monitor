"use client";
// 用量分析：按上游、模型和时段查看 Token 用量。
// 合计的算法沿用 v1（renderUsageBody）：时间档位、上游筛选、合计、读不到的上游、趋势/各模型图、模型明细。
// 新增"按上游"分组：各上游的 Token 堆叠柱，颜色跟随上游而不是排名。
// 只在本页出现的话都在同目录的 copy.ts 里；时间范围名、Token 说明、汇率和售价说明、报错的说法从共用的地方取（design/ui-copy-spec.md §12）
import "../../styles/pages/usage.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Grid, Select } from "antd";
import { Bar, Column } from "@ant-design/plots";
import { api } from "../../../lib/client";
import { dayKeyInTz } from "../../../lib/business-time";
import { failureSentence } from "../../../lib/error-copy";
import { EMPTY, formatCompact, formatInt, formatUnitPrice, formatZonedDate, formatZonedTime, RANGE_TEXT, SELL_PRICE_UNSET, TOKEN_NOTE } from "../../../lib/format";
import { stationDisplayName } from "../../../lib/overview-actions";
import { rateSnapshotOf } from "../../../lib/profit";
import { palette, SERIES_KEYS } from "../../../lib/design-tokens";
import { useThemeMode } from "../../providers";
import ChartBox from "../chart-box";
import { Panel } from "../../components/panel";
import { EmptyState, ErrorState, PanelSkeleton, RefreshFailedBanner } from "../../components/data-state";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import { Sym } from "../../components/icons";
import { RangePicker } from "../../components/range-picker";
import { Seg } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { useUrlState } from "../../components/use-url-state";
import { COPY } from "./copy";


// 时间档位（照抄 v1 USAGE_RANGES）。今天 / 近 7 天 / 近 30 天与总览、自营一致；
// 用量有小时粒度，所以多一个和余额趋势弹窗同款的「近 24 小时」，从现在往前推 24 小时
const USAGE_RANGES = [
  { value: "today", label: RANGE_TEXT.today },
  { value: "24h", label: RANGE_TEXT["24h"] },
  { value: "7d", label: RANGE_TEXT["7d"] },
  { value: "30d", label: RANGE_TEXT["30d"] },
];
const RANGE_KEYS = ["today", "24h", "7d", "30d"] as const;
type Range = (typeof RANGE_KEYS)[number];
const GROUP_KEYS = ["total", "upstream"] as const;
type Group = (typeof GROUP_KEYS)[number];

// "按上游"最多单独显示 8 个，其余合并
const MAX_SERIES = SERIES_KEYS.length;
const OTHER_KEY = "__other__";

// CJK 按 2 个单位计宽的标签截断（同 v1 truncateLabel）
function truncateLabel(s: any, units = 14): string {
  let u = 0,
    out = "";
  for (const ch of String(s)) {
    u += /[⺀-꓏가-힣豈-﫿︰-﹏＀-￯]/.test(ch) ? 2 : 1;
    if (u > units) return out + "…";
    out += ch;
  }
  return String(s);
}

// 图表本体固定高度，保证同排两图等高
const CHART_H = 300;

type Series = { key: string; name: string; slot: number | null };

// 图表配色与坐标轴全部取自设计令牌；画布拿不到 CSS 变量，所以用令牌的实际色值
function chartKit(dark: boolean) {
  const p = palette[dark ? "dark" : "light"];
  const axisBase = { title: false, labelFill: p["ink-3"], labelOpacity: 1, labelFontSize: 12 };
  return {
    p,
    theme: { type: dark ? "classicDark" : "classic", view: { viewFill: "transparent" } },
    xAxis: { ...axisBase, line: true, lineStroke: p.rule, lineStrokeOpacity: 1, lineLineWidth: 1, tick: false, grid: false },
    yAxis: {
      ...axisBase,
      line: false,
      tick: false,
      grid: true,
      gridStroke: p["rule-soft"],
      gridStrokeOpacity: 1,
      gridLineWidth: 1,
      gridLineDash: [0, 0],
    },
    interaction: {
      tooltip: {
        css: {
          ".g2-tooltip": { background: p.sheet, color: p.ink, "box-shadow": p.shadow, "border-radius": "8px", opacity: 1 },
          ".g2-tooltip-title": { color: p.ink },
          ".g2-tooltip-list-item-name-label": { color: p["ink-2"] },
          ".g2-tooltip-list-item-value": { color: p.ink },
        },
      },
    },
  };
}

function seriesVar(s: Series) {
  return s.slot == null ? "var(--jy-ink-dis)" : `var(--jy-${SERIES_KEYS[s.slot]})`;
}

// 一个上游读不到用量：接口给了 code 和原文，按 §8.2 归类成那一句，原文进「查看详细原因」
const stationErrorOf = (s: any) => noteOf({ code: s.code, message: s.error });

export default function UsagePage() {
  const { dark } = useThemeMode();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const uid = useId();
  const [range, setRange] = useUrlState<Range>("range", "today", RANGE_KEYS);
  const [station, setStation] = useUrlState<string>("station", "all");
  const [group, setGroup] = useUrlState<Group>("group", "total", GROUP_KEYS);
  const [trendView, setTrendView] = useState<"chart" | "table">("chart");
  const [stations, setStations] = useState<any[]>([]); // 筛选用的上游列表（/api/stations）
  const [data, setData] = useState<any>(null); // /api/usage 响应
  // 错误记下所属档位，切换档位时旧错误不会串到新档位
  const [err, setErr] = useState<{ range: string; error: Error } | null>(null);
  // 与 v1 loadUsage 相同的 30 秒前端缓存（单槽，按 range 记）
  const cacheRef = useRef<{ range: string; at: number; data: any } | null>(null);
  const rangeRef = useRef<string>(range);
  rangeRef.current = range;

  // 上游筛选：同 v1 用列表接口的 stations（排除固定成本条目）；失败时只保留"全部"
  useEffect(() => {
    api("/api/stations")
      .then((r) => setStations((r.stations || []).filter((s: any) => s.type !== "fixed")))
      .catch(() => {});
  }, []);

  // 拉取用量：force 跳过缓存；tz 传浏览器时区（同 v1 api.usage）。
  // 返回这次的报错（成功、用了缓存或档位已切走时返回 null），顶栏刷新按钮原样往外抛，由外壳按码归类
  const load = useCallback(async (force = false, r = rangeRef.current): Promise<Error | null> => {
    const cached = cacheRef.current;
    if (!force && cached && cached.range === r && Date.now() - cached.at < 30000) {
      setData(cached.data);
      setErr(null);
      return null;
    }
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const resp = await api(`/api/usage?range=${r}&tz=${encodeURIComponent(tz)}`);
      cacheRef.current = { range: r, at: Date.now(), data: resp };
      if (rangeRef.current === r) {
        setData(resp);
        setErr(null);
      }
      return null;
    } catch (e: any) {
      if (rangeRef.current !== r) return null;
      const error = e instanceof Error ? e : new Error(String(e));
      setErr({ range: r, error });
      return error;
    }
  }, []);

  // 档位变化即加载；每 30 秒强制拉一次；切回标签页立即刷新（同 v1）
  useEffect(() => {
    load(false, range);
    const t = setInterval(() => load(true), 30000);
    const onVis = () => {
      if (!document.hidden) load(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [range, load]);

  // 只用属于当前档位的数据；切档位时先显示骨架，不拿上一档的数字冒充
  const current = data && data.range === range ? data : null;
  const loadError = err && err.range === range ? err.error : null;

  const rangePicker = useMemo(
    () => <RangePicker value={range} options={USAGE_RANGES} onChange={(v) => setRange(v as Range)} />,
    [range, setRange],
  );
  const asOf = current?.generatedAt ? Date.parse(current.generatedAt) : null;
  // 用量按浏览器时区分桶，接口把用的时区原样带回来；"数据截至"和图上的时段都按它显示
  const tz: string | undefined = current?.tz || undefined;
  useShellPage({
    onRefresh: async () => {
      const error = await load(true);
      if (error) throw error;
    },
    asOf: Number.isFinite(asOf) ? asOf : null,
    range: rangePicker,
    tz,
  });

  // ---- 聚合（照抄 v1 renderUsageBody）--------------------------------------
  const agg = useMemo(() => {
    if (!current) return null;
    // 「全部」只聚合上游；自营站点仍可在筛选里单独选看
    const sts =
      station === "all"
        ? (current.stations || []).filter((s: any) => !s.isOwn)
        : (current.stations || []).filter((s: any) => s.id === station);
    const okSts = sts.filter((s: any) => s.ok);
    const errSts = sts.filter((s: any) => !s.ok);

    // 跨上游汇总：按模型名合并（上游成本按各上游的汇率换成 ¥，没设置汇率的按 1 比 1）
    const mmap = new Map<string, any>();
    for (const s of okSts) {
      const rate = rateSnapshotOf(s).cnyPerUsd;
      for (const m of s.models || []) {
        const acc = mmap.get(m.model) || { model: m.model, tokens: 0, cost: 0, requests: 0, inputTokens: 0, outputTokens: 0, hasIO: false };
        acc.tokens += m.tokens || 0;
        acc.cost += (m.cost || 0) * rate;
        acc.requests += m.requests || 0;
        if (m.inputTokens != null) {
          acc.inputTokens += m.inputTokens || 0;
          acc.outputTokens += m.outputTokens || 0;
          acc.hasIO = true;
        }
        mmap.set(m.model, acc);
      }
    }
    const models = [...mmap.values()].sort((a, b) => b.tokens - a.tokens);

    // 按时间桶合并：能解析出时间戳的按小时/天取整分桶（跨天时小时标签会重复，
    // 不能拿标签当键），解析不出的按原始标签。天按接口用的时区（就是请求带上的浏览器时区）划
    const hourly = current.granularity === "hour";
    const zone: string = current.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const bucketKey = (p: any) => {
      if (p.t == null) return "l:" + (p.label || "?");
      if (hourly) return "t:" + Math.floor(p.t / 3600000);
      return "d:" + dayKeyInTz(p.t, zone);
    };
    const todayKey = dayKeyInTz(Date.now(), zone);
    const bucketLabel = (p: any) => {
      if (p.t == null) return p.label || "?";
      if (!hourly) return formatZonedDate(p.t, zone);
      const hh = formatZonedTime(Math.floor(p.t / 3600000) * 3600000, zone);
      return dayKeyInTz(p.t, zone) === todayKey ? hh : `${formatZonedDate(p.t, zone)} ${hh}`;
    };
    const bmap = new Map<string, any>();
    // 每个上游在各时间桶的 tokens，供"按上游"堆叠使用
    const perStation = new Map<string, Map<string, number>>();
    for (const s of okSts) {
      const rate = rateSnapshotOf(s).cnyPerUsd;
      const own = new Map<string, number>();
      for (const p of s.trend || []) {
        const k = bucketKey(p);
        const acc = bmap.get(k) || { key: k, label: bucketLabel(p), t: p.t ?? Infinity, tokens: 0, cost: 0, requests: 0 };
        acc.tokens += p.tokens || 0;
        acc.cost += (p.cost || 0) * rate;
        acc.requests += p.requests || 0;
        acc.t = Math.min(acc.t, p.t ?? Infinity);
        bmap.set(k, acc);
        own.set(k, (own.get(k) || 0) + (p.tokens || 0));
      }
      perStation.set(s.id, own);
    }
    const buckets = [...bmap.values()].sort((a, b) => a.t - b.t);

    // 合计的算法按范围选：今天 = 上游仪表盘同款数字（和上游页面显示一致）；
    // 近 24 小时 = 截好窗的趋势求和；7/30 天 = 模型明细求和
    let totTokens: number, totCost: number, totReqs: number;
    if (current.range === "today") {
      totTokens = okSts.reduce((a: number, s: any) => a + (s.summary?.tokens ?? (s.models || []).reduce((x: number, m: any) => x + m.tokens, 0)), 0);
      totCost = okSts.reduce((a: number, s: any) => a + (s.summary?.cost ?? (s.models || []).reduce((x: number, m: any) => x + m.cost, 0)) * rateSnapshotOf(s).cnyPerUsd, 0);
      totReqs = okSts.reduce((a: number, s: any) => a + (s.summary?.requests ?? (s.models || []).reduce((x: number, m: any) => x + m.requests, 0)), 0);
    } else {
      const src: any[] = current.range === "24h" ? buckets : models;
      totTokens = src.reduce((a, m) => a + m.tokens, 0);
      totCost = src.reduce((a, m) => a + m.cost, 0);
      totReqs = src.reduce((a, m) => a + m.requests, 0);
    }
    const modelsByDate = current.range === "24h" && okSts.some((s: any) => s.modelsWindow === "date");
    // 只选了自营站点：cnyPerUsd 是售价，算出来的是用户消费，不是上游成本（§3.2）
    const own = sts.length > 0 && sts.every((s: any) => s.isOwn);
    // 没设置汇率、按 1 比 1 算的上游个数（§7）：只数这段时间有花费的，花费是 0 的不影响合计
    const spent = (s: any) => (s.summary?.cost || 0) > 0 || (s.models || []).some((m: any) => m.cost > 0) || (s.trend || []).some((p: any) => p.cost > 0);
    const unrated = okSts.filter((s: any) => spent(s) && rateSnapshotOf(s).source !== "configured");
    const rateUnset = own ? 0 : unrated.length;
    const sellPriceUnset = own && unrated.length > 0;

    return { sts, okSts, errSts, models, buckets, perStation, totTokens, totCost, totReqs, modelsByDate, own, rateUnset, sellPriceUnset };
  }, [current, station]);

  // 分模型图：超过 10 项时后段合并为「其他 N 个」（同 v1 drawUsageModels）
  const modelChartItems = useMemo(() => {
    if (!agg) return [];
    let items = agg.models;
    if (items.length > 10) {
      const rest = items.slice(9);
      items = items.slice(0, 9);
      items.push({
        model: COPY.other(rest.length),
        tokens: rest.reduce((a: number, x: any) => a + x.tokens, 0),
        cost: rest.reduce((a: number, x: any) => a + x.cost, 0),
        requests: rest.reduce((a: number, x: any) => a + x.requests, 0),
      });
    }
    return items;
  }, [agg]);

  // "按上游"：取用量最大的 8 个上游单独成列，其余合并为"其他"。
  // 颜色跟着上游走，不跟排名走：每个上游的本色槽位 = 接口里的固定顺序（添加顺序）% 8。
  // 先让本色没被更早添加的上游占用的都拿本色，再把撞色的分到剩下的空槽；
  // 这样前 8 个添加的上游颜色永远不变，排名变化只会影响第 9 个以后、且和别人撞色的上游。
  const upstream = useMemo(() => {
    if (!agg || !current) return null;
    const order = new Map<string, number>((current.stations || []).map((s: any, i: number) => [s.id, i]));
    const totals = agg.okSts
      .map((s: any) => {
        let tokens = 0;
        for (const v of agg.perStation.get(s.id)?.values() || []) tokens += v;
        return { s, tokens };
      })
      .filter((x: any) => x.tokens > 0)
      .sort((a: any, b: any) => b.tokens - a.tokens);
    const shown = totals.slice(0, MAX_SERIES).map((x: any) => x.s);
    const rest = totals.slice(MAX_SERIES).map((x: any) => x.s);
    shown.sort((a: any, b: any) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const home = (s: any) => (order.get(s.id) ?? 0) % MAX_SERIES;
    const used = new Set<number>();
    const slotOf = new Map<string, number>();
    for (const s of shown) {
      if (used.has(home(s))) continue;
      used.add(home(s));
      slotOf.set(s.id, home(s));
    }
    for (const s of shown) {
      if (slotOf.has(s.id)) continue;
      let slot = home(s);
      while (used.has(slot)) slot = (slot + 1) % MAX_SERIES;
      used.add(slot);
      slotOf.set(s.id, slot);
    }
    const series: Series[] = shown.map((s: any) => ({ key: s.id, name: stationDisplayName(s), slot: slotOf.get(s.id) as number }));
    if (rest.length) series.push({ key: OTHER_KEY, name: COPY.other(rest.length), slot: null });

    const rows: { key: string; label: string; sid: string; name: string; tokens: number }[] = [];
    for (const b of agg.buckets) {
      for (const sr of series) {
        const tokens =
          sr.key === OTHER_KEY
            ? rest.reduce((a: number, s: any) => a + (agg.perStation.get(s.id)?.get(b.key) || 0), 0)
            : agg.perStation.get(sr.key)?.get(b.key) || 0;
        rows.push({ key: b.key, label: b.label, sid: sr.key, name: sr.name, tokens });
      }
    }
    return { series, rows };
  }, [agg, current]);

  const trendEmpty = !agg || !agg.buckets.length || agg.buckets.every((b: any) => !b.tokens);
  const kit = useMemo(() => chartKit(dark), [dark]);

  // 钱那一栏的名字：看上游时是上游成本，只看自营站点时是用户消费
  const costLabel = agg?.own ? COPY.ownCost : COPY.cost;
  // 悬停提示项：Token / 上游成本 / 请求数（同 v1 attachUsageTip 内容）
  const tipItems = [
    { field: "tokens", name: COPY.token, valueFormatter: (v: any) => formatInt(v) },
    { field: "cost", name: costLabel, valueFormatter: (v: any) => formatUnitPrice(v) },
    { field: "requests", name: COPY.requests, valueFormatter: (v: any) => formatInt(v) },
  ];

  const stationSelectId = `${uid}-station`;
  const filterBar = (
    <div className="jy-toolbar jy-usage-filters">
      <label htmlFor={stationSelectId}>{COPY.stationLabel}</label>
      <Select
        id={stationSelectId}
        value={station}
        onChange={setStation}
        popupMatchSelectWidth={false}
        options={[
          { value: "all", label: COPY.allStations },
          ...stations.map((s: any) => ({ value: s.id, label: `${stationDisplayName(s)}${s.isOwn ? COPY.ownSuffix : ""}` })),
        ]}
      />
      {station === "all" ? <span className="jy-caption">{COPY.allHint}</span> : null}
    </div>
  );

  // 首次加载 / 整页失败：保留筛选栏，只替换内容区
  if (!agg) {
    return (
      <div className="jy-page">
        {filterBar}
        {loadError ? (
          <Panel label={COPY.dataLabel}>
            <ErrorState what={COPY.readFailed} error={loadError} onRetry={() => void load(true)} />
          </Panel>
        ) : (
          <>
            <PanelSkeleton lines={2} />
            <div className="jy-usage-charts">
              <PanelSkeleton title={COPY.trendTitle} height={CHART_H} />
              <PanelSkeleton title={COPY.modelTitle} height={CHART_H} />
            </div>
            <PanelSkeleton title={COPY.detailTitle} lines={5} />
          </>
        )}
      </div>
    );
  }

  const hourly = current.granularity === "hour";
  const trendHasData = group === "total" ? !trendEmpty : !!upstream?.series.length && !trendEmpty;
  // 全部上游都读不到时，"没有用量"会被误读为真的没用；合计也不显示 0
  const allFailed = agg.okSts.length === 0 && agg.errSts.length > 0;
  const partial = agg.okSts.length > 0 && agg.errSts.length > 0;
  const figure = (text: string) => (allFailed ? EMPTY : text);
  const partialNote = partial ? <dd className="jy-caption">{COPY.excludeFailed(agg.errSts.length)}</dd> : null;
  const emptyTitle = allFailed ? COPY.allFailedTitle : COPY.emptyTitle;
  const emptyDesc = allFailed ? COPY.allFailedDesc : COPY.emptyDesc;
  // 整个范围都没有用量时只留一个空状态，不再并排三个空卡片
  const noData = trendEmpty && !agg.models.length;

  const trendTable = (
    <div className="jy-table-wrap jy-usage-scroll" tabIndex={0} role="region" aria-label={COPY.trendTable}>
      <table className="jy-data jy-data--compact">
        <thead>
          <tr>
            <th scope="col">{COPY.bucket}</th>
            {group === "total" ? (
              <>
                <th scope="col" className="r">{COPY.token}</th>
                <th scope="col" className="r">{costLabel}</th>
                <th scope="col" className="r">{COPY.requests}</th>
              </>
            ) : (
              <>
                {upstream!.series.map((s) => (
                  <th scope="col" className="r" key={s.key}>{s.name}</th>
                ))}
                <th scope="col" className="r">{COPY.total}</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {agg.buckets.map((b: any) => (
            <tr key={b.key}>
              <th scope="row" className="jy-usage-rowhead">{b.label}</th>
              {group === "total" ? (
                <>
                  <td className="r jy-num">{formatInt(b.tokens)}</td>
                  <td className="r jy-num">{formatUnitPrice(b.cost)}</td>
                  <td className="r jy-num">{formatInt(b.requests)}</td>
                </>
              ) : (
                <>
                  {upstream!.series.map((s) => (
                    <td className="r jy-num" key={s.key}>
                      {formatInt(upstream!.rows.find((r) => r.key === b.key && r.sid === s.key)?.tokens)}
                    </td>
                  ))}
                  <td className="r jy-num">{formatInt(b.tokens)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const trendChart =
    group === "total" ? (
      <ChartBox h={CHART_H}>
        <Column
          data={agg.buckets}
          xField="label"
          yField="tokens"
          height={CHART_H}
          theme={kit.theme}
          interaction={kit.interaction}
          style={{ fill: kit.p.cobalt, radiusTopLeft: 4, radiusTopRight: 4, maxWidth: 24 }}
          axis={{
            x: { ...kit.xAxis, labelFormatter: (v: any) => (isMobile ? truncateLabel(v, 8) : v) },
            y: { ...kit.yAxis, labelFormatter: (v: any) => formatCompact(v) },
          }}
          tooltip={{ title: (d: any) => d.label, items: tipItems }}
        />
      </ChartBox>
    ) : (
      <>
        <div className="jy-legend" aria-label={COPY.legend}>
          {upstream!.series.map((s) => (
            <span key={s.key}>
              <i className="jy-swatch" style={{ background: seriesVar(s) }} aria-hidden="true" />
              {s.name}
            </span>
          ))}
        </div>
        <ChartBox h={CHART_H}>
          <Column
            data={upstream!.rows}
            xField="label"
            yField="tokens"
            // 用上游 id 作颜色键，同名上游也不会并成一色
            colorField="sid"
            stack
            height={CHART_H}
            theme={kit.theme}
            interaction={kit.interaction}
            legend={false}
            scale={{
              color: {
                domain: upstream!.series.map((s) => s.key),
                range: upstream!.series.map((s) => (s.slot == null ? kit.p["ink-dis"] : kit.p[SERIES_KEYS[s.slot] as "s1"])),
              },
            }}
            style={{ maxWidth: 24 }}
            axis={{
              x: { ...kit.xAxis, labelFormatter: (v: any) => (isMobile ? truncateLabel(v, 8) : v) },
              y: { ...kit.yAxis, labelFormatter: (v: any) => formatCompact(v) },
            }}
            tooltip={{
              title: (d: any) => d.label,
              items: [(d: any) => ({ name: d.name, value: formatInt(d.tokens) })],
            }}
          />
        </ChartBox>
      </>
    );

  return (
    <div className="jy-page">
      {filterBar}

      {/* 已有数据时后台刷新失败：保留上次结果，提示原因 */}
      {loadError && <RefreshFailedBanner asOf={asOf} tz={tz} error={loadError} onRetry={() => void load(true)} />}

      {/* 合计：总 Token / 上游成本 / 请求数 / 读到的上游 */}
      <Panel label={COPY.totalsLabel} foot={TOKEN_NOTE}>
        <dl className="jy-usage-kpis">
          <div>
            <dt>{COPY.totalToken}</dt>
            <dd className="jy-usage-figure">{figure(formatCompact(agg.totTokens))}</dd>
            {allFailed ? <dd className="jy-caption">{COPY.noneRead}</dd> : <dd className="jy-caption">{COPY.exact(formatInt(agg.totTokens))}</dd>}
            {partialNote}
          </div>
          <div>
            <dt>{costLabel}</dt>
            <dd className="jy-usage-figure">{figure(formatUnitPrice(agg.totCost))}</dd>
            {!allFailed && agg.rateUnset > 0 && <dd className="jy-caption">{COPY.rateUnset(agg.rateUnset)}</dd>}
            {!allFailed && agg.sellPriceUnset && <dd className="jy-caption">{SELL_PRICE_UNSET}</dd>}
            {partialNote}
          </div>
          <div>
            <dt>{COPY.requests}</dt>
            <dd className="jy-usage-figure">{figure(formatCompact(agg.totReqs))}</dd>
            {!allFailed && agg.totReqs >= 1e4 && <dd className="jy-caption">{COPY.exact(formatInt(agg.totReqs))}</dd>}
            {partialNote}
          </div>
          <div>
            <dt>{COPY.sources}</dt>
            <dd className="jy-usage-figure">
              {agg.okSts.length}
              <span className="jy-usage-unit">{COPY.sourcesOf(agg.sts.length)}</span>
            </dd>
            {agg.errSts.length > 0 ? (
              <dd className="jy-status jy-status--warn">
                <Sym kind="warn" />
                {COPY.failedCount(agg.errSts.length)}
              </dd>
            ) : null}
          </div>
        </dl>
      </Panel>

      {/* 读不到用量的上游（同 v1 usage-errors）：合计里不含它们；原文进「查看详细原因」 */}
      {agg.errSts.length > 0 && (
        <div className="jy-banner">
          <Sym kind="warn" />
          <div className="jy-banner__body">
            <b>{allFailed ? COPY.failedTitle : COPY.failedTitlePartial}</b>
            <ul className="jy-usage-failed">
              {agg.errSts.map((s: any) => {
                const note = stationErrorOf(s);
                return (
                  <li key={s.id}>
                    {failureSentence(stationDisplayName(s), note.text)}
                    <ErrorDetail raw={note.raw} />
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {noData ? (
        <Panel title={COPY.noData}>
          <div className="jy-usage-empty jy-usage-empty--short">
            <EmptyState title={emptyTitle} desc={emptyDesc} />
          </div>
        </Panel>
      ) : (
        <>
          <div className="jy-usage-charts">
            <Panel
              title={COPY.trendTitle}
              caption={hourly ? COPY.byHour : COPY.byDay}
              extra={
                <div className="jy-usage-controls">
                  <Seg
                    size="sm"
                    label={COPY.groupBy}
                    value={group}
                    onChange={setGroup}
                    options={[
                      { value: "total", label: COPY.groupTotal },
                      { value: "upstream", label: COPY.groupUpstream },
                    ]}
                  />
                  <Seg
                    size="sm"
                    label={COPY.viewAs}
                    value={trendView}
                    onChange={(v) => setTrendView(v as "chart" | "table")}
                    options={[
                      { value: "chart", label: COPY.viewChart },
                      { value: "table", label: COPY.viewTable },
                    ]}
                  />
                </div>
              }
              body={trendView === "table" && trendHasData ? "flush" : true}
            >
              {!trendHasData ? (
                <div className="jy-usage-empty">
                  <EmptyState title={emptyTitle} desc={emptyDesc} />
                </div>
              ) : trendView === "table" ? (
                trendTable
              ) : (
                trendChart
              )}
            </Panel>

            <Panel
              title={COPY.modelTitle}
              caption={agg.modelsByDate ? COPY.modelCaptionByDate : COPY.modelCaption}
            >
              {!modelChartItems.length ? (
                <div className="jy-usage-empty">
                  <EmptyState title={emptyTitle} />
                </div>
              ) : (
                <ChartBox h={CHART_H}>
                  <Bar
                    data={modelChartItems}
                    xField="model"
                    yField="tokens"
                    height={CHART_H}
                    theme={kit.theme}
                    interaction={kit.interaction}
                    style={{ fill: kit.p.cobalt, maxWidth: 16, radiusTopRight: 4, radiusBottomRight: 4 }}
                    axis={{
                      x: { ...kit.xAxis, line: false, labelFill: kit.p["ink-2"], labelFormatter: (v: any) => truncateLabel(v, isMobile ? 12 : 20) },
                      y: false,
                    }}
                    label={isMobile ? false : { text: (d: any) => formatCompact(d.tokens), position: "right", dx: 4, fill: kit.p["ink-2"], fillOpacity: 1 }}
                    tooltip={{ title: (d: any) => d.model, items: tipItems }}
                  />
                </ChartBox>
              )}
            </Panel>
          </div>

          {/* 模型明细表 */}
          <Panel title={COPY.detailTitle} caption={COPY.modelCount(agg.models.length)} body="flush" foot={TOKEN_NOTE}>
            {!agg.models.length ? (
              <EmptyState title={emptyTitle} />
            ) : (
              <>
                <div className="jy-table-wrap has-mobile">
                  <table className="jy-data">
                    <thead>
                      <tr>
                        <th scope="col">{COPY.model}</th>
                        <th scope="col" className="r">{COPY.requests}</th>
                        <th scope="col" className="r">{COPY.inputToken}</th>
                        <th scope="col" className="r">{COPY.outputToken}</th>
                        <th scope="col" className="r">{COPY.totalToken}</th>
                        <th scope="col" className="r">{costLabel}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agg.models.map((m: any) => (
                        <tr key={m.model}>
                          <td className="jy-usage-model">{m.model}</td>
                          <td className="r jy-num">{formatInt(m.requests)}</td>
                          <td className="r jy-num">{m.hasIO ? formatInt(m.inputTokens) : EMPTY}</td>
                          <td className="r jy-num">{m.hasIO ? formatInt(m.outputTokens) : EMPTY}</td>
                          <td className="r jy-num">{formatInt(m.tokens)}</td>
                          <td className="r jy-num">{formatUnitPrice(m.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="jy-m-list">
                  {agg.models.map((m: any) => (
                    <li key={m.model}>
                      <span className="m-top jy-usage-model">{m.model}</span>
                      <span className="jy-num">{formatCompact(m.tokens)}</span>
                      <div className="m-sub">
                        <span>
                          {COPY.requests} <b>{formatInt(m.requests)}</b>
                        </span>
                        {m.hasIO ? (
                          <span>
                            {COPY.inputOutput} <b>{formatInt(m.inputTokens)}</b> / <b>{formatInt(m.outputTokens)}</b>
                          </span>
                        ) : null}
                        <span>
                          {costLabel} <b>{formatUnitPrice(m.cost)}</b>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
