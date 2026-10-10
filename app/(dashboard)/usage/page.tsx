"use client";
// 用量分析：按上游资源、模型和时段查看 Token 用量。
// 聚合口径沿用 v1（renderUsageBody）：时间档位、上游筛选、合计、查询失败提示、趋势/分模型图、模型明细。
// 新增"按上游"分组：各上游的 token 堆叠柱，颜色跟随上游而不是排名。
import "../../styles/pages/usage.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Grid, Select } from "antd";
import { Bar, Column } from "@ant-design/plots";
import { api, cny4, fmtTokens, rateOf } from "../../../lib/client";
import { palette, SERIES_KEYS } from "../../../lib/design-tokens";
import { useThemeMode } from "../../providers";
import ChartBox from "../chart-box";
import { Panel } from "../../components/panel";
import { EmptyState, ErrorState, PanelSkeleton } from "../../components/data-state";
import { Sym } from "../../components/icons";
import { RangePicker } from "../../components/range-picker";
import { Seg } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { useUrlState } from "../../components/use-url-state";

// 时间档位（照抄 v1 USAGE_RANGES）
const USAGE_RANGES = [
  { value: "today", label: "今天" },
  { value: "24h", label: "近 24 小时" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
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

// New API 上游的 token 口径（Sub2API 自带输入/输出明细，不受此限）
const NEWAPI_TOKEN_NOTE = "New API 口径：prompt + completion，不含缓存读写";

const num = (n: any) => Number(n ?? 0).toLocaleString("en-US");

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
  const [err, setErr] = useState<{ range: string; msg: string } | null>(null);
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

  // 拉取用量：force 跳过缓存；tz 传浏览器时区（同 v1 api.usage）
  const load = useCallback(async (force = false, r = rangeRef.current) => {
    const cached = cacheRef.current;
    if (!force && cached && cached.range === r && Date.now() - cached.at < 30000) {
      setData(cached.data);
      setErr(null);
      return;
    }
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const resp = await api(`/api/usage?range=${r}&tz=${encodeURIComponent(tz)}`);
      cacheRef.current = { range: r, at: Date.now(), data: resp };
      if (rangeRef.current === r) {
        setData(resp);
        setErr(null);
      }
    } catch (e: any) {
      if (rangeRef.current === r) setErr({ range: r, msg: e.message || String(e) });
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
  const errMsg = err && err.range === range ? err.msg : "";

  const rangePicker = useMemo(
    () => <RangePicker value={range} options={USAGE_RANGES} onChange={(v) => setRange(v as Range)} />,
    [range, setRange],
  );
  const asOf = current?.generatedAt ? Date.parse(current.generatedAt) : null;
  useShellPage({ onRefresh: () => load(true), asOf: Number.isFinite(asOf) ? asOf : null, range: rangePicker });

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

    // 跨上游汇总：按模型名合并（用量成本按各上游充值汇率折算成 ¥）
    const mmap = new Map<string, any>();
    for (const s of okSts) {
      const rate = rateOf(s);
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
    // 不能拿标签当键），解析不出的按原始标签
    const hourly = current.granularity === "hour";
    const bucketKey = (p: any) => {
      if (p.t == null) return "l:" + (p.label || "?");
      if (hourly) return "t:" + Math.floor(p.t / 3600000);
      const d = new Date(p.t);
      return "d:" + (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
    };
    const today = new Date();
    const bucketLabel = (p: any) => {
      if (p.t == null) return p.label || "?";
      const d = new Date(p.t);
      if (!hourly) return `${d.getMonth() + 1}/${d.getDate()}`;
      const hh = `${String(d.getHours()).padStart(2, "0")}:00`;
      return d.getDate() === today.getDate() && d.getMonth() === today.getMonth()
        ? hh
        : `${d.getMonth() + 1}/${d.getDate()} ${hh}`;
    };
    const bmap = new Map<string, any>();
    // 每个上游在各时间桶的 tokens，供"按上游"堆叠使用
    const perStation = new Map<string, Map<string, number>>();
    for (const s of okSts) {
      const rate = rateOf(s);
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

    // 合计口径按范围选：今天 = 上游仪表盘同款数字（和上游页面显示一致）；
    // 近 24 小时 = 截好窗的趋势求和；7/30 天 = 模型明细求和
    let totTokens: number, totCost: number, totReqs: number;
    if (current.range === "today") {
      totTokens = okSts.reduce((a: number, s: any) => a + (s.summary?.tokens ?? (s.models || []).reduce((x: number, m: any) => x + m.tokens, 0)), 0);
      totCost = okSts.reduce((a: number, s: any) => a + (s.summary?.cost ?? (s.models || []).reduce((x: number, m: any) => x + m.cost, 0)) * rateOf(s), 0);
      totReqs = okSts.reduce((a: number, s: any) => a + (s.summary?.requests ?? (s.models || []).reduce((x: number, m: any) => x + m.requests, 0)), 0);
    } else {
      const src: any[] = current.range === "24h" ? buckets : models;
      totTokens = src.reduce((a, m) => a + m.tokens, 0);
      totCost = src.reduce((a, m) => a + m.cost, 0);
      totReqs = src.reduce((a, m) => a + m.requests, 0);
    }
    const modelsByDate = current.range === "24h" && okSts.some((s: any) => s.modelsWindow === "date");

    return { sts, okSts, errSts, models, buckets, perStation, totTokens, totCost, totReqs, modelsByDate };
  }, [current, station]);

  // 分模型图：超过 10 项时后段合并为「其他 N 个」（同 v1 drawUsageModels）
  const modelChartItems = useMemo(() => {
    if (!agg) return [];
    let items = agg.models;
    if (items.length > 10) {
      const rest = items.slice(9);
      items = items.slice(0, 9);
      items.push({
        model: `其他 ${rest.length} 个`,
        tokens: rest.reduce((a: number, x: any) => a + x.tokens, 0),
        cost: rest.reduce((a: number, x: any) => a + x.cost, 0),
        requests: rest.reduce((a: number, x: any) => a + x.requests, 0),
      });
    }
    return items;
  }, [agg]);

  // "按上游"：取用量最大的 8 个上游单独成列，其余合并为"其他"。
  // 颜色按上游在接口里的固定顺序（添加顺序）取槽位，排名变化不换色；只有撞色时才顺延到下一个空槽。
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
    const used = new Set<number>();
    const series: Series[] = shown.map((s: any) => {
      let slot = (order.get(s.id) ?? 0) % MAX_SERIES;
      while (used.has(slot)) slot = (slot + 1) % MAX_SERIES;
      used.add(slot);
      return { key: s.id, name: s.name, slot };
    });
    if (rest.length) series.push({ key: OTHER_KEY, name: `其他 ${rest.length} 个`, slot: null });

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

  // 悬停提示项：tokens / 用量成本 / 请求（同 v1 attachUsageTip 内容）
  const tipItems = [
    { field: "tokens", name: "Tokens", valueFormatter: (v: any) => num(v) },
    { field: "cost", name: "用量成本", valueFormatter: (v: any) => cny4(v) },
    { field: "requests", name: "请求", valueFormatter: (v: any) => num(v) },
  ];

  const stationSelectId = `${uid}-station`;
  const filterBar = (
    <div className="jy-toolbar jy-usage-filters">
      <label htmlFor={stationSelectId}>上游资源</label>
      <Select
        id={stationSelectId}
        value={station}
        onChange={setStation}
        popupMatchSelectWidth={false}
        options={[
          { value: "all", label: "全部上游资源" },
          ...stations.map((s: any) => ({ value: s.id, label: `${s.name}${s.isOwn ? "（自营站点）" : ""}` })),
        ]}
      />
      {station === "all" ? <span className="jy-caption">「全部」不含自营站点，可在列表中单独选看</span> : null}
    </div>
  );

  // 首次加载 / 整页失败：保留筛选栏，只替换内容区
  if (!agg) {
    return (
      <div className="jy-page">
        {filterBar}
        {errMsg ? (
          <Panel label="用量数据">
            <ErrorState title="用量数据暂时无法读取" error={errMsg} onRetry={() => void load(true)} />
          </Panel>
        ) : (
          <>
            <PanelSkeleton lines={2} />
            <div className="jy-usage-charts">
              <PanelSkeleton title="Token 用量趋势" height={CHART_H} />
              <PanelSkeleton title="分模型 Token" height={CHART_H} />
            </div>
            <PanelSkeleton title="模型明细" lines={5} />
          </>
        )}
      </div>
    );
  }

  const hourly = current.granularity === "hour";
  const trendHasData = group === "total" ? !trendEmpty : !!upstream?.series.length && !trendEmpty;
  // 全部上游都查询失败时，"暂无数据"会被误读为没有用量
  const allFailed = agg.okSts.length === 0 && agg.errSts.length > 0;
  const emptyTitle = allFailed ? "用量查询全部失败，暂时没有数据" : "该范围内暂无用量数据";
  const emptyDesc = allFailed ? "失败原因见上方，恢复后会自动显示。" : "换一个时间范围，或在筛选里选择其他上游资源。";
  // 整个范围都没有用量时只留一个空状态，不再并排三个空卡片
  const noData = trendEmpty && !agg.models.length;

  const trendTable = (
    <div className="jy-table-wrap jy-usage-scroll" tabIndex={0} role="region" aria-label="Token 用量趋势数据">
      <table className="jy-data jy-data--compact">
        <thead>
          <tr>
            <th scope="col">时段</th>
            {group === "total" ? (
              <>
                <th scope="col" className="r">Tokens</th>
                <th scope="col" className="r">用量成本</th>
                <th scope="col" className="r">请求</th>
              </>
            ) : (
              <>
                {upstream!.series.map((s) => (
                  <th scope="col" className="r" key={s.key}>{s.name}</th>
                ))}
                <th scope="col" className="r">合计</th>
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
                  <td className="r jy-num">{num(b.tokens)}</td>
                  <td className="r jy-num">{cny4(b.cost)}</td>
                  <td className="r jy-num">{num(b.requests)}</td>
                </>
              ) : (
                <>
                  {upstream!.series.map((s) => (
                    <td className="r jy-num" key={s.key}>
                      {num(upstream!.rows.find((r) => r.key === b.key && r.sid === s.key)?.tokens)}
                    </td>
                  ))}
                  <td className="r jy-num">{num(b.tokens)}</td>
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
            y: { ...kit.yAxis, labelFormatter: (v: any) => fmtTokens(v) },
          }}
          tooltip={{ title: (d: any) => d.label, items: tipItems }}
        />
      </ChartBox>
    ) : (
      <>
        <div className="jy-legend" aria-label="图例">
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
              y: { ...kit.yAxis, labelFormatter: (v: any) => fmtTokens(v) },
            }}
            tooltip={{
              title: (d: any) => d.label,
              items: [(d: any) => ({ name: d.name, value: num(d.tokens) })],
            }}
          />
        </ChartBox>
      </>
    );

  return (
    <div className="jy-page">
      {filterBar}

      {errMsg ? (
        // 已有数据时后台刷新失败：保留上次结果，提示原因
        <div className="jy-banner jy-banner--crit" role="alert">
          <Sym kind="crit" />
          <div className="jy-usage-banner">
            <b>最近一次刷新失败，下面仍是上次读取的数据</b>
            <span>{errMsg}</span>
          </div>
          <Button size="small" onClick={() => void load(true)}>
            重试
          </Button>
        </div>
      ) : null}

      {/* 合计：总 Tokens / 用量成本 / 请求数 / 数据来源 */}
      <Panel label="用量合计" foot={NEWAPI_TOKEN_NOTE}>
        <dl className="jy-usage-kpis">
          <div>
            <dt>总 Tokens</dt>
            <dd className="jy-usage-figure">{fmtTokens(agg.totTokens)}</dd>
            <dd className="jy-caption">精确值 {num(agg.totTokens)}</dd>
          </div>
          <div>
            <dt>用量成本</dt>
            <dd className="jy-usage-figure">{cny4(agg.totCost)}</dd>
          </div>
          <div>
            <dt>请求数</dt>
            <dd className="jy-usage-figure">{num(agg.totReqs)}</dd>
          </div>
          <div>
            <dt>数据来源</dt>
            <dd className="jy-usage-figure">
              {agg.okSts.length}
              <span className="jy-usage-unit"> / {agg.sts.length} 个上游</span>
            </dd>
            {agg.errSts.length > 0 ? (
              <dd className="jy-status jy-status--warn">
                <Sym kind="warn" />
                {agg.errSts.length} 个查询失败
              </dd>
            ) : null}
          </div>
        </dl>
      </Panel>

      {/* 查询失败的上游（同 v1 usage-errors）：合计里不含它们 */}
      {agg.errSts.length > 0 && (
        <div className="jy-banner">
          <Sym kind="warn" />
          <div className="jy-usage-banner">
            <b>以下上游的用量查询失败，合计未包含它们</b>
            <ul>
              {agg.errSts.map((s: any) => (
                <li key={s.id}>
                  {s.name}：{s.error}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {noData ? (
        <Panel title="用量明细">
          <div className="jy-usage-empty jy-usage-empty--short">
            <EmptyState title={emptyTitle} desc={emptyDesc} />
          </div>
        </Panel>
      ) : (
        <>
          <div className="jy-usage-charts">
            <Panel
              title="Token 用量趋势"
              caption={hourly ? "按小时汇总" : "按天汇总"}
              extra={
                <div className="jy-usage-controls">
                  <Seg
                    size="sm"
                    label="分组方式"
                    value={group}
                    onChange={setGroup}
                    options={[
                      { value: "total", label: "合计" },
                      { value: "upstream", label: "按上游" },
                    ]}
                  />
                  <Seg
                    size="sm"
                    label="显示方式"
                    value={trendView}
                    onChange={(v) => setTrendView(v as "chart" | "table")}
                    options={[
                      { value: "chart", label: "图表" },
                      { value: "table", label: "表格" },
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
              title="分模型 Token"
              caption={agg.modelsByDate ? "Sub2API 模型明细按自然日（昨日+今日）统计" : "按用量降序，最多显示 10 项"}
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
                    label={isMobile ? false : { text: (d: any) => fmtTokens(d.tokens), position: "right", dx: 4, fill: kit.p["ink-2"], fillOpacity: 1 }}
                    tooltip={{ title: (d: any) => d.model, items: tipItems }}
                  />
                </ChartBox>
              )}
            </Panel>
          </div>

          {/* 模型明细表 */}
          <Panel title="模型明细" caption={`共 ${agg.models.length} 个模型`} body="flush" foot={NEWAPI_TOKEN_NOTE}>
            {!agg.models.length ? (
              <EmptyState title={emptyTitle} />
            ) : (
              <>
                <div className="jy-table-wrap has-mobile">
                  <table className="jy-data">
                    <thead>
                      <tr>
                        <th scope="col">模型</th>
                        <th scope="col" className="r">请求数</th>
                        <th scope="col" className="r">输入 Tokens</th>
                        <th scope="col" className="r">输出 Tokens</th>
                        <th scope="col" className="r">总 Tokens</th>
                        <th scope="col" className="r">用量成本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agg.models.map((m: any) => (
                        <tr key={m.model}>
                          <td className="jy-usage-model">{m.model}</td>
                          <td className="r jy-num">{num(m.requests)}</td>
                          <td className="r jy-num">{m.hasIO ? num(m.inputTokens) : "—"}</td>
                          <td className="r jy-num">{m.hasIO ? num(m.outputTokens) : "—"}</td>
                          <td className="r jy-num">{num(m.tokens)}</td>
                          <td className="r jy-num">{cny4(m.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="jy-m-list">
                  {agg.models.map((m: any) => (
                    <li key={m.model}>
                      <span className="m-top jy-usage-model">{m.model}</span>
                      <span className="jy-num">{fmtTokens(m.tokens)}</span>
                      <div className="m-sub">
                        <span>
                          请求 <b>{num(m.requests)}</b>
                        </span>
                        {m.hasIO ? (
                          <span>
                            输入/输出 <b>{num(m.inputTokens)}</b> / <b>{num(m.outputTokens)}</b>
                          </span>
                        ) : null}
                        <span>
                          用量成本 <b>{cny4(m.cost)}</b>
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
