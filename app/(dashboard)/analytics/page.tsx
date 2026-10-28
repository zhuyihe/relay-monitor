"use client";
// 成本估算：只留「上游成本构成」和「每天的上游成本」两块，数都取每日利润同一份
// （/api/reconciliation/profit 的实付成本、「没算进利润的上游成本」和逐日成本 dailyCost）。
// 赚了多少钱只认每日利润那一个数，这里不算利润，也不再按余额变化估。
import "../../styles/pages/analytics.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { NAV_LABELS, STATION_TABS } from "../../../lib/brand";
import { api } from "../../../lib/client";
import type { ProfitPageResponse } from "../../../lib/client";
import { NO_UPSTREAM_TEXT, RANGE_TEXT } from "../../../lib/format";
import { DEFAULT_BUSINESS_TIME_ZONE, dayKeyInTz, dayStartInTz } from "../../../lib/business-time";
import { UPSTREAM_FORM_TEXT } from "../../../lib/channel-onboarding";
import { EmptyState, ErrorState, PanelSkeleton, RefreshFailedBanner } from "../../components/data-state";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Panel } from "../../components/panel";
import { RangePicker } from "../../components/range-picker";
import { useShellPage } from "../../components/shell-context";
import { useUrlParams } from "../../components/use-url-state";
import { fmtMoney, pageMoney, rowMoney } from "../reconciliation/profit-format";
import { COPY } from "./copy";
import { DailyCostPanel } from "./daily-cost-chart";
import { addDays, validDay } from "./derive";

const r2 = (v: number) => Math.round(v * 100) / 100;
const PRESET_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };
const RANGE_OPTIONS = (["7d", "30d"] as const).map((value) => ({ value, label: RANGE_TEXT[value] }));
// 每日利润最多看 31 天：自定义开始日期最早到 30 天前
const MAX_DAYS = 31;
const POLL_MS = 30000;

export default function AnalyticsPage() {
  const [sp, setUrl] = useUrlParams();
  const [tz, setTz] = useState<string>(DEFAULT_BUSINESS_TIME_ZONE);
  const [profit, setProfit] = useState<ProfitPageResponse | null>(null);
  // 这份数对应的开始日；与当前选择不一致时说明正在切换
  const [loadedStart, setLoadedStart] = useState<string | null>(null);
  const today = dayKeyInTz(Date.now(), tz);
  const minDate = addDays(today, -(MAX_DAYS - 1));
  const rawRange = sp.get("range") || "";
  const rawStart = sp.get("start");
  const customOk = rawRange === "custom" && validDay(rawStart) && rawStart >= minDate && rawStart <= today;
  const rangeValue = customOk ? "custom" : PRESET_DAYS[rawRange] ? rawRange : "30d";
  const startDay = customOk ? (rawStart as string) : addDays(today, -(PRESET_DAYS[rangeValue] - 1));

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);
  // 只采用最后一次发出的请求结果，避免快速切换范围时旧响应覆盖新范围
  const seq = useRef(0);

  useEffect(() => {
    api("/api/settings").then((r) => { if (r?.tz) setTz(r.tz); }).catch(() => {});
  }, []);

  // 返回这次加载的报错（成功或已被更新的请求取代时返回 null），顶栏刷新按钮原样往外抛，由外壳按码归类
  const load = useCallback(async (start: string): Promise<Error | null> => {
    const my = ++seq.current;
    try {
      const data = (await api("/api/reconciliation/profit", { method: "POST", body: { preset: "custom", startMs: dayStartInTz(start, tz), endMs: Date.now() } })) as ProfitPageResponse;
      if (my !== seq.current) return null;
      setProfit(data);
      setLoadedStart(start);
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
  }, [tz]);

  // 首次 + 每 30 秒重新读一次；切换范围立即重拉
  useEffect(() => {
    setLoading(true);
    load(startDay);
    const timer = setInterval(() => load(startDay), POLL_MS);
    return () => clearInterval(timer);
  }, [startDay, load]);

  const retry = useCallback(() => {
    setLoading(true);
    return load(startDay);
  }, [load, startDay]);

  const range = useMemo(
    () => (
      <RangePicker
        value={rangeValue}
        options={RANGE_OPTIONS}
        onChange={(v) => setUrl({ range: v === "30d" ? null : v, start: null })}
        custom={{
          startDate: customOk ? rawStart : null,
          minDate,
          maxDate: today,
          onApply: (start) => setUrl({ range: "custom", start }),
        }}
      />
    ),
    [rangeValue, customOk, rawStart, minDate, today, setUrl],
  );

  useShellPage({
    onRefresh: async () => {
      const error = await load(startDay);
      if (error) throw error;
    },
    asOf,
    range,
    tz,
  });

  const toDaily = (
    <Link className="jy-caption-link" href="/reconciliation">
      {NAV_LABELS.reconciliation}
    </Link>
  );

  // 首次加载：骨架与真实布局一致
  if (!profit && loading) {
    return (
      <div className="jy-page" aria-busy="true">
        <PanelSkeleton title={COPY.panel.mix} lines={5} />
        <PanelSkeleton title={COPY.panel.daily} height={300} />
      </div>
    );
  }

  // 没有任何数据，或刚切换的范围加载失败（旧数据对应别的范围，不能冒充）
  const stale = !!profit && loadedStart !== startDay;
  if (!profit || (stale && loadError && !loading)) {
    return (
      <div className="jy-page">
        <Panel title={COPY.panel.mix} extra={toDaily}>
          <ErrorState what={COPY.readFailed} error={loadError} onRetry={retry} center />
        </Panel>
      </div>
    );
  }

  if (!profit.rows.length && !profit.unaccountedUpstreamCostUsd) {
    return (
      <div className="jy-page">
        <Panel title={COPY.panel.mix} extra={toDaily}>
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
      <MixPanel profit={profit} extra={toDaily} />
      <DailyCostPanel profit={profit} tz={tz} emptyText={emptyNote(profit, COPY.dailyEmpty)} />
    </div>
  );
}

// ---- 上游成本构成 ----------------------------------------------------------------

// 按上游合计每日利润里各行的实付成本；最后一行「没算进利润的上游成本」（有才写）。合计 = 上游列表扣费的总数
// 没有成本时分两种说：还有渠道需处理、今天算不出（不是没有），和运营总览同一个说法；真的没有才写「没有上游成本」
function emptyNote(profit: ProfitPageResponse, fallback: string): React.ReactNode {
  const n = profit.counts?.attentionChannels ?? 0;
  return n > 0 ? (
    <>
      {COPY.notReady(n)}{" "}
      <Link href="/reconciliation" className="jy-link">{NAV_LABELS.reconciliation}</Link>
    </>
  ) : fallback;
}

function MixPanel({ profit, extra }: { profit: ProfitPageResponse; extra?: React.ReactNode }) {
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
    <Panel title={COPY.panel.mix} caption={COPY.mixCaption} extra={extra}>
      <HBars
        items={items}
        color="var(--jy-s2)"
        unitName={COPY.mixUnit}
        total={items.length ? { label: COPY.total, value: fmtMoney(r2(total), currency) } : undefined}
        empty={
          <>
            {emptyNote(profit, COPY.mixEmpty)}
            <Link href="/stations" className="jy-link">
              {STATION_TABS.list}
            </Link>
          </>
        }
      />
    </Panel>
  );
}
