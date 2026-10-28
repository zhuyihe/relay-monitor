"use client";
// 成本估算：只留「上游成本构成」和「每天的上游成本」两块。
// 成本构成的数取每日利润同一份（/api/reconciliation/profit 的实付成本和「没算进利润的上游成本」）；
// 赚了多少钱只认每日利润那一个数，这里不算利润。
import "../../styles/pages/analytics.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { STATION_TABS } from "../../../lib/brand";
import { api } from "../../../lib/client";
import type { ProfitPageResponse } from "../../../lib/client";
import { formatMoney, NO_UPSTREAM_TEXT, RANGE_TEXT } from "../../../lib/format";
import { DEFAULT_BUSINESS_TIME_ZONE, dayKeyInTz, dayStartInTz } from "../../../lib/business-time";
import { fmtMoney, pageMoney, rowMoney } from "../reconciliation/profit-format";
import { UPSTREAM_FORM_TEXT } from "../../../lib/channel-onboarding";
import { EmptyState, ErrorState, PanelSkeleton, RefreshFailedBanner } from "../../components/data-state";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Panel } from "../../components/panel";
import { RangePicker } from "../../components/range-picker";
import { useShellPage } from "../../components/shell-context";
import { TREND_PANEL_TITLE, TrendPanel } from "../../components/trend-panel";
import { useUrlParams } from "../../components/use-url-state";
import { COPY } from "./copy";
import { addDays, derive, r2, validDay } from "./derive";
import type { Derived } from "./derive";

const PRESET_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };
const RANGE_OPTIONS = (["7d", "30d"] as const).map((value) => ({ value, label: RANGE_TEXT[value] }));
// 成本构成读每日利润，最多看 31 天：自定义开始日期最早到 30 天前
const MAX_DAYS = 31;
const POLL_MS = 30000;

type Snapshot = {
  data: any;
  // 每日利润同一份数（成本构成用）；读不到是 null
  profit: ProfitPageResponse | null;
  // 这份数据对应的查询条件；与当前选择不一致时说明正在切换
  query: string;
};

export default function AnalyticsPage() {
  const [sp, setUrl] = useUrlParams();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // 「今天」与日期选择器的可选范围要和服务端按同一个业务时区取：加载后用接口返回的 tz
  const tz: string = snap?.data?.tz || DEFAULT_BUSINESS_TIME_ZONE;
  const today = dayKeyInTz(Date.now(), tz);
  const minDate = addDays(today, -(MAX_DAYS - 1));
  const rawRange = sp.get("range") || "";
  const rawStart = sp.get("start");
  // 拿到业务时区之前按上海估算「今天」，可能与服务端差一天：开始日期前后各放宽一天，超出的由服务端收窄
  const customOk =
    rawRange === "custom" && validDay(rawStart) && rawStart >= addDays(minDate, -1) && rawStart <= addDays(today, 1);
  const rangeValue = customOk ? "custom" : PRESET_DAYS[rawRange] ? rawRange : "30d";
  // 请求条件：预设范围传天数，自定义范围传开始日期、天数由服务端按业务时区算
  const query = customOk ? `start=${rawStart}` : `days=${PRESET_DAYS[rangeValue]}`;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);
  // 只采用最后一次发出的请求结果，避免快速切换范围时旧响应覆盖新范围
  const seq = useRef(0);

  // 返回这次加载的报错（成功或已被更新的请求取代时返回 null），顶栏刷新按钮原样往外抛，由外壳按码归类
  const load = useCallback(async (query: string): Promise<Error | null> => {
    const my = ++seq.current;
    const params = new URLSearchParams(query);
    params.set("includeArchived", "true");
    try {
      const data = await api(`/api/analytics?${params}`);
      if (my !== seq.current) return null;
      // 成本构成取每日利润同一份：窗口用上面接口给的开始日和业务时区，到现在为止
      let profit: ProfitPageResponse | null = null;
      try {
        profit = (await api("/api/reconciliation/profit", { method: "POST", body: { preset: "custom", startMs: dayStartInTz(data.start, data.tz), endMs: Date.now() } })) as ProfitPageResponse;
      } catch { profit = null; }
      if (my !== seq.current) return null;
      setSnap({ data, profit, query });
      setAsOf(Date.now());
      setLoadError(null);
      setLoading(false);
      return null;
    } catch (e: any) {
      if (my !== seq.current) return null;
      // 保留上一次成功的数据，页面顶部提示刷新失败
      setLoadError(e);
      setLoading(false);
      return e;
    }
  }, []);

  // 首次 + 每 30 秒重新读一次；切换范围立即重拉
  useEffect(() => {
    setLoading(true);
    load(query);
    const timer = setInterval(() => load(query), POLL_MS);
    return () => clearInterval(timer);
  }, [query, load]);

  const retry = useCallback(() => {
    setLoading(true);
    return load(query);
  }, [load, query]);

  const range = useMemo(
    () => (
      <RangePicker
        value={rangeValue}
        options={RANGE_OPTIONS}
        onChange={(v) => setUrl({ range: v === "30d" ? null : v, start: null })}
        custom={{
          // 数据回来后显示服务端实际采用的开始日期（超出范围的已被收窄）
          startDate: customOk ? (snap?.query === query && snap.data?.start) || rawStart : null,
          minDate,
          maxDate: today,
          onApply: (start) => setUrl({ range: "custom", start }),
        }}
      />
    ),
    [rangeValue, customOk, rawStart, snap, query, minDate, today, setUrl],
  );

  useShellPage({
    onRefresh: async () => {
      const error = await load(query);
      if (error) throw error;
    },
    asOf,
    range,
    tz: snap?.data?.tz,
  });

  const dv = useMemo(() => (snap ? derive(snap.data, null) : null), [snap]);

  // 首次加载：骨架与真实布局一致
  if (!snap && loading) {
    return (
      <div className="jy-page" aria-busy="true">
        <PanelSkeleton title={TREND_PANEL_TITLE.costOnly} height={400} />
        <PanelSkeleton title={COPY.panel.mix} lines={5} />
      </div>
    );
  }

  // 没有任何数据，或刚切换的范围加载失败（旧数据对应别的范围，不能冒充）
  const stale = !!snap && snap.query !== query;
  if (!snap || !dv || (stale && loadError && !loading)) {
    return (
      <div className="jy-page">
        <Panel title={COPY.panel.mix}>
          <ErrorState what={COPY.readFailed} error={loadError} onRetry={retry} center />
        </Panel>
      </div>
    );
  }

  const data = snap.data;
  const stations: any[] = Array.isArray(data.stations) ? data.stations : [];
  if (stations.length === 0) {
    return (
      <div className="jy-page">
        <Panel title={COPY.panel.mix}>
          <EmptyState
            title={NO_UPSTREAM_TEXT}
            desc={COPY.emptyDesc}
            action={
              <Link href="/stations?edit=new" className="jy-link">
                {UPSTREAM_FORM_TEXT.create}
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className={`jy-page${loading && stale ? " jy-analytics-switching" : ""}`} aria-busy={(loading && stale) || undefined}>
      {loadError && <RefreshFailedBanner asOf={asOf} tz={tz} error={loadError} onRetry={retry} />}
      <TrendPanel rows={dv.rows} showRev={false} revApprox={false} asOf={asOf} tz={tz} />
      <MixPanel profit={snap.profit} />
    </div>
  );
}

// ---- 上游成本构成 ----------------------------------------------------------------

// 按上游合计每日利润里各行的实付成本；最后一行「没算进利润的上游成本」（有才写）。合计 = 上游列表扣费的总数
function MixPanel({ profit }: { profit: ProfitPageResponse | null }) {
  if (!profit) {
    return (
      <Panel title={COPY.panel.mix} caption={COPY.mixCaption}>
        <p className="jy-caption">{COPY.mixUnread}</p>
      </Panel>
    );
  }
  const currency = profit.displayCurrency === "CNY" ? "CNY" : "USD";
  const byUpstream = new Map<string, { name: string; value: number }>();
  for (const row of profit.rows) {
    const actual = rowMoney(row, currency).actual;
    if (actual == null) continue;
    const id = row.upstream.stationId;
    const entry = byUpstream.get(id) || { name: row.upstream.name || id, value: 0 };
    entry.value += actual;
    byUpstream.set(id, entry);
  }
  const items: HBarItem[] = [...byUpstream.entries()].map(([id, entry]) => ({ key: id, name: entry.name, value: r2(entry.value) }));
  const unaccounted = pageMoney(profit, currency).unaccounted;
  if (unaccounted) items.push({ key: "unaccounted", name: COPY.unaccounted, value: r2(unaccounted) });
  const total = items.reduce((sum, item) => sum + (item.value ?? 0), 0);
  return (
    <Panel title={COPY.panel.mix} caption={COPY.mixCaption}>
      <HBars
        items={items}
        color="var(--jy-s2)"
        unitName={COPY.mixUnit}
        total={items.length ? { label: COPY.total, value: fmtMoney(r2(total), currency) } : undefined}
        empty={
          <>
            {COPY.mixEmpty}
            <Link href="/stations" className="jy-link">
              {STATION_TABS.list}
            </Link>
          </>
        }
      />
    </Panel>
  );
}
