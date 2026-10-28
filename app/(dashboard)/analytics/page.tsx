"use client";
// 成本估算：只留「成本构成」和一张趋势图（按上游余额变化估出来的成本）。
// 赚了多少钱只认每日利润那一个数，这里不算利润；余额变化在这里只用来看每个上游花了多少。
import "../../styles/pages/analytics.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { STATION_TABS } from "../../../lib/brand";
import { api } from "../../../lib/client";
import { formatMoney, NO_UPSTREAM_TEXT, RANGE_TEXT } from "../../../lib/format";
import { DEFAULT_BUSINESS_TIME_ZONE, dayKeyInTz } from "../../../lib/business-time";
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

const PRESET_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
const RANGE_OPTIONS = (["7d", "30d", "90d"] as const).map((value) => ({ value, label: RANGE_TEXT[value] }));
// 接口 days 上限 365：自定义开始日期最早到 364 天前
const MAX_DAYS = 365;
const POLL_MS = 30000;

type Snapshot = {
  data: any;
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
      setSnap({ data, query });
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
      <MixPanel dv={dv} />
    </div>
  );
}

// ---- 成本构成 ------------------------------------------------------------------

function MixPanel({ dv }: { dv: Derived }) {
  const items: HBarItem[] = dv.mix.map((m) => {
    const name = m.archived ? `${m.name}${COPY.archivedSuffix}` : m.name;
    if (m.unknown) {
      // 所选时间内一条用量记录都没有：画斜纹空条，不当作 0
      return { key: m.id, name, value: null, note: m.fixed > 0 ? COPY.noRecordFixed(formatMoney(m.fixed)) : COPY.noRecord };
    }
    const tip: [ReactNode, ReactNode][] = [
      ["上游成本", formatMoney(m.usage, { approx: m.missingDays > 0 })],
      ["固定成本", formatMoney(m.fixed)],
    ];
    if (m.missingDays > 0) tip.push([COPY.usageRecord, COPY.missingDays(m.missingDays)]);
    return { key: m.id, name, value: r2(m.usage + m.fixed), tipExtra: tip };
  });
  return (
    <Panel title={COPY.panel.mix} caption={COPY.mixCaption}>
      <HBars
        items={items}
        color="var(--jy-s2)"
        unitName={COPY.mixUnit}
        total={items.length ? { label: COPY.total, value: formatMoney(r2(dv.usage + dv.fixed), { approx: dv.usageApprox }) } : undefined}
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
