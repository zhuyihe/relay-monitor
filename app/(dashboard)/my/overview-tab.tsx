"use client";
// 概览：利润等式、每日趋势、预计花费、消费最多的用户、利润怎么算。
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "antd";
import { NAV_LABELS } from "../../../lib/brand";
import { dayKeyInTz } from "../../../lib/business-time";
import { EMPTY, RANGE_TEXT, formatCompact, formatDayKey, formatInt, formatMoney, formatSinceToday, weekdayOfDayKey } from "../../../lib/format";
import { rateSnapshotOf, splitProfitWarnings } from "../../../lib/profit";
import { EmptyState, ErrorState, PanelSkeleton } from "../../components/data-state";
import { ForecastChart } from "../../components/forecast-chart";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Panel } from "../../components/panel";
import { EQ_TEXT, ProfitEquation } from "../../components/profit-equation";
import { Seg } from "../../components/seg";
import { TrendPanel } from "../../components/trend-panel";
import { derive } from "../analytics/derive";
import { ProfitBasis } from "./profit-basis";
import { BASIS_TITLE, DataTable, TAB_TEXT, TOKEN_NOTE, sum } from "./shared";
import type { MyTab, OwnRange, OwnView } from "./shared";

// 利润等式里各项跳到哪个标签页看明细（保留当前时间范围）
const tabHref = (range: OwnRange, tab: MyTab) => {
  const qs = new URLSearchParams();
  if (range !== "7d") qs.set("range", range); // 7d 是默认范围，不写进地址
  if (tab !== "overview") qs.set("tab", tab);
  const s = qs.toString();
  return s ? `/my?${s}` : "/my";
};

export function OverviewTab({
  v,
  costs,
  range,
  asOf,
  onRange,
  onTab,
  reload,
}: {
  v: OwnView;
  // /api/analytics 的逐日上游成本；今天为 null，取不到时是 { error }
  costs: any;
  range: OwnRange;
  asOf: number | null;
  onRange: (r: OwnRange) => void;
  onTab: (t: MyTab) => void;
  reload: () => Promise<unknown>;
}) {
  const [basisOpen, setBasisOpen] = useState(false);
  const basisRef = useRef<HTMLDivElement>(null);
  const openBasis = () => {
    setBasisOpen(true);
    // 等面板展开后再滚过去
    requestAnimationFrame(() => basisRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <>
      <Equation v={v} range={range} onBasis={openBasis} reload={reload} />
      {range === "today" ? (
        <Panel title="收入与上游成本" caption="按天">
          <EmptyState
            title="今天只有一天，没有逐日趋势"
            desc={`切到${RANGE_TEXT["7d"]}或${RANGE_TEXT["30d"]}，看每天的收入和净利；今天每小时的用量在「${TAB_TEXT.models}」里。`}
            action={<Button onClick={() => onRange("7d")}>看{RANGE_TEXT["7d"]}</Button>}
          />
        </Panel>
      ) : (
        <DailyTrend v={v} costs={costs} asOf={asOf} reload={reload} />
      )}
      <div className="jy-grid-2 jy-grid-even">
        <ForecastPanel v={v} />
        <TopUsers v={v} range={range} onTab={onTab} />
      </div>
      <div ref={basisRef}>
        <ProfitBasis v={v} open={basisOpen} onToggle={() => setBasisOpen((o) => !o)} reload={reload} />
      </div>
    </>
  );
}

// ---- 利润等式 -------------------------------------------------------------

function Equation({ v, range, onBasis, reload }: { v: OwnView; range: OwnRange; onBasis: () => void; reload: () => Promise<unknown> }) {
  const p = v.profit;
  const title = EQ_TEXT.business(RANGE_TEXT[range]);
  const caption = formatSinceToday(v.d.startMs, v.d.tz);
  if (!p || p.error) {
    return (
      <Panel title={title} caption={caption}>
        <ErrorState what={EQ_TEXT.profitFailed} error={p?.error} onRetry={() => reload()} />
      </Panel>
    );
  }
  const costs: any[] = p.costs || [];
  const fixedRows = costs.filter((c) => c.mode === "fixed");
  const usageRows = costs.filter((c) => c.mode !== "fixed");
  const historyCount = usageRows.filter((c) => c.mode === "history").length;
  // 优先用接口算好的两项成本，与毛利、净利同一次舍入
  const upstream = p.upstreamCostCny ?? sum(usageRows, (c) => c.cny);
  const fixed = p.fixedCostCny ?? sum(fixedRows, (c) => c.cny);

  // 没设置售价影响收入，上游没设置汇率影响上游成本；都由接口给出，不解析提示文字
  const ownNoRate = rateSnapshotOf(v.d.station).source === "default";
  const upstreamNoRate = (p.rateUnsetStations || []).length > 0;
  const { reasons } = splitProfitWarnings(p);

  const revNotes: ReactNode[] = [];
  if ((p.resoldCny || 0) > 0) revNotes.push(<span key="r">含转售 Key {formatMoney(p.resoldCny)}</span>);
  if ((p.adminUsageCny || 0) > 0) revNotes.push(<span key="a">管理员自用 {formatMoney(p.adminUsageCny)} 不算进收入</span>);

  return (
    <ProfitEquation
      title={title}
      caption={caption}
      extra={
        <button type="button" className="jy-caption-link jy-my-linkbtn" onClick={onBasis}>
          {BASIS_TITLE}
        </button>
      }
      revenue={{
        value: p.incomeCny,
        approx: ownNoRate,
        note: revNotes.length ? revNotes : "不含管理员自用",
        href: tabHref(range, "users"),
      }}
      upstream={{
        value: upstream,
        approx: !!p.estimated || upstreamNoRate,
        note: historyCount
          ? `${EQ_TEXT.upstreamCount(usageRows.length)}，${historyCount} 个按余额变化估算`
          : usageRows.length
            ? EQ_TEXT.upstreamCount(usageRows.length)
            : "没有按用量算的上游",
        href: tabHref(range, "models"),
      }}
      fixed={{ value: fixed, note: fixedRows.length ? EQ_TEXT.fixedCount(fixedRows.length) : EQ_TEXT.noFixed }}
      gross={p.grossProfitCny}
      net={p.netProfitCny ?? p.profitCny}
      reasons={reasons}
      partialTail={EQ_TEXT.profitPartialTail}
    />
  );
}

// ---- 每日趋势 -------------------------------------------------------------

// 逐日上游成本取自 /api/analytics（和成本估算页同一份），每日收入按当天用户消费的占比分，
// 缺记录的日子标成缺失，不补零。
function DailyTrend({ v, costs, asOf, reload }: { v: OwnView; costs: any; asOf: number | null; reload: () => Promise<unknown> }) {
  const dv = useMemo(() => (costs && !costs.error ? derive(costs, v.d) : null), [costs, v.d]);
  if (costs === undefined) return <PanelSkeleton title="收入与上游成本" height={220} />;
  if (!dv) {
    return (
      <Panel title="收入与上游成本" caption="按天">
        {costs?.error ? (
          <ErrorState what="读不到逐日成本" error={costs.error} onRetry={() => reload()} />
        ) : (
          <EmptyState title="暂时没有逐日成本" desc="稍后刷新再看。" />
        )}
      </Panel>
    );
  }
  return (
    <TrendPanel
      rows={dv.rows}
      showRev={dv.hasIncome}
      asOf={asOf}
      tz={costs.tz || v.d?.tz}
      caption={
        <>
          按天。每天的收入按当天用户消费的占比分。
          <Link className="jy-link" href={`/analytics?range=${dv.rows.length <= 7 ? "7d" : "30d"}`}>
            {NAV_LABELS.analytics}
          </Link>
        </>
      }
    />
  );
}

// ---- 预计花费 -------------------------------------------------------------

type FcView = "24h" | "7d";

// 预计花费面板里重复出现的几句（design/ui-copy-spec.md §3.4）
export const FC_TITLE = "预计花费";
const FC_ACCURACY = "过去 2 周平均差";
const FC_TOO_SHORT = "记录不到 3 天，还估算不了";

function ForecastPanel({ v }: { v: OwnView }) {
  const [view, setView] = useState<FcView>("24h");
  const { d, rate } = v;
  const h = d.hourly;
  const fc = d.forecast;
  const seg = (
    <Seg<FcView>
      size="sm"
      label="预计范围"
      value={view}
      onChange={setView}
      options={[
        { value: "24h", label: "未来 24 小时" },
        { value: "7d", label: "未来 7 天" },
      ]}
    />
  );

  if (view === "24h") {
    const enough = h && (h.past?.length || 0) + (h.next?.length || 0) >= 4 && h.next?.length;
    if (!enough) {
      return (
        <Panel title={FC_TITLE} extra={seg}>
          <EmptyState title="小时数据不够" desc="有几个小时的消费记录后，这里会估算未来 24 小时每小时的花费。" />
        </Panel>
      );
    }
    const points = h.next.map((x: any) => ({ t: x.t, cost: x.cost * rate, lo: x.lo * rate, hi: x.hi * rate }));
    return (
      <Panel
        title={FC_TITLE}
        extra={seg}
        sub={
          <>
            未来 24 小时预计 <b>{formatMoney(h.next24Total * rate, { approx: true })}</b>，阴影是每小时的以往起伏范围。
          </>
        }
        foot={
          <ul className="jy-my-facts">
            <li>
              今天已消费 <b>{formatMoney(h.todaySoFar * rate)}</b>
            </li>
            <li>
              今天全天预计 <b>{formatMoney(h.todayEst * rate, { approx: true })}</b>
            </li>
            {h.backtestWapePct != null && (
              <li>
                {FC_ACCURACY} <b>±{h.backtestWapePct}%</b>
              </li>
            )}
          </ul>
        }
      >
        <ForecastChart points={points} />
      </Panel>
    );
  }

  const hist: any[] = d.daily || [];
  const fcPts: any[] = fc?.points || [];
  if (!hist.length && !fcPts.length) {
    return (
      <Panel title={FC_TITLE} extra={seg}>
        <EmptyState title={FC_TOO_SHORT} desc="有 3 天以上的消费记录后，这里会估算未来 7 天。" />
      </Panel>
    );
  }
  const lo = fc ? (fc.nextLo ?? sum(fcPts, (x) => x.lo)) : 0;
  const hi = fc ? (fc.nextHi ?? sum(fcPts, (x) => x.hi)) : 0;
  type DayRow = { t: number; kind: "预计" | "实际"; cost: number; lo?: number; hi?: number };
  // 预计在前（明天起），实际在后（昨天起倒序）
  const rows: DayRow[] = [
    ...fcPts.map((x) => ({ t: x.t, kind: "预计" as const, cost: x.cost * rate, lo: x.lo * rate, hi: x.hi * rate })),
    ...[...hist].reverse().map((x) => ({ t: x.t, kind: "实际" as const, cost: x.cost * rate })),
  ];
  // t 是业务时区某天的 0 点；取当天中午再换日历日，夏令时那天也不会落到前一天
  const dayName = (t: number) => {
    const key = dayKeyInTz(t + 12 * 3600000, d.tz);
    return `${formatDayKey(key, d.tz)} ${weekdayOfDayKey(key)}`;
  };
  return (
    <Panel
      title={FC_TITLE}
      extra={seg}
      sub={
        fc ? (
          <>
            未来 7 天预计 <b>{formatMoney(fc.nextTotal * rate, { approx: true })}</b>，按以往起伏，预计 {formatMoney(lo * rate)} 到{" "}
            {formatMoney(hi * rate)}。
          </>
        ) : (
          `${FC_TOO_SHORT}；下面是最近每天的消费。`
        )
      }
      foot={
        fc ? (
          <ul className="jy-my-facts">
            <li>
              按过去 <b>{fc.sampleDays} 天</b>估算
            </li>
            {fc.backtestWapePct != null && (
              <li>
                {FC_ACCURACY} <b>±{fc.backtestWapePct}%</b>
              </li>
            )}
          </ul>
        ) : undefined
      }
    >
      <DataTable<DayRow>
        scroll
        compact
        caption="每日预计花费与最近 14 天实际消费"
        rows={rows}
        rowKey={(r) => `${r.kind}${r.t}`}
        empty={EMPTY}
        cols={[
          { key: "day", label: "日期", render: (r) => dayName(r.t) },
          {
            key: "kind",
            label: "类型",
            render: (r) => <span className={`jy-tag ${r.kind === "预计" ? "jy-tag--info" : "jy-tag--type"}`}>{r.kind}</span>,
          },
          { key: "cost", label: "消费", num: true, render: (r) => formatMoney(r.cost, { approx: r.kind === "预计" }) },
          {
            key: "band",
            label: "以往起伏范围",
            num: true,
            render: (r) => (r.lo != null ? `${formatMoney(r.lo)} 到 ${formatMoney(r.hi)}` : <span className="jy-muted">{EMPTY}</span>),
          },
        ]}
      />
    </Panel>
  );
}

// ---- 消费最多的用户 --------------------------------------------------------

function TopUsers({ v, range, onTab }: { v: OwnView; range: OwnRange; onTab: (t: MyTab) => void }) {
  const users = [...v.users].sort((a, b) => b.cost - a.cost);
  const top = users.slice(0, 5);
  const rest = users.slice(5);
  const items: HBarItem[] = top.map((u) => ({
    key: u.user,
    name: `${u.user}${u.isAdmin ? "（管理员）" : ""}`,
    value: u.cost,
    tipExtra: [
      ["请求数", formatInt(u.requests)],
      ["Token", formatCompact(u.tokens)],
    ],
  }));
  // 其余用户合成一行，悬停提示里的占比才是占全部消费
  if (rest.length)
    items.push({
      key: "__rest",
      name: `其他 ${rest.length} 个用户`,
      value: sum(rest, (u) => u.cost),
      tipExtra: [
        ["请求数", formatInt(sum(rest, (u) => u.requests))],
        ["Token", formatCompact(sum(rest, (u) => u.tokens))],
      ],
    });
  return (
    <Panel
      title="消费最多的用户"
      caption={RANGE_TEXT[range]}
      extra={
        users.length ? (
          <button type="button" className="jy-caption-link jy-my-linkbtn" onClick={() => onTab("users")}>
            全部 {users.length} 个用户
          </button>
        ) : undefined
      }
      foot={
        // 原页顶部的四项用量总数，放在用户排行下面
        <ul className="jy-my-facts">
          <li>
            消费 <b>{formatMoney(v.totCost)}</b>
          </li>
          <li title={TOKEN_NOTE}>
            Token（不含缓存） <b>{formatCompact(v.totTokens)}</b>
          </li>
          <li>
            请求数 <b>{formatInt(v.totReqs)}</b>
          </li>
          <li>
            有消费的用户 <b>{users.length} 个</b>
          </li>
        </ul>
      }
    >
      {items.length ? (
        <HBars items={items} color="var(--jy-s1)" unitName="消费" />
      ) : (
        <EmptyState title="这个时间范围内还没有用户消费" desc="换个更长的时间范围看看，或确认用户已经在用自营站点。" />
      )}
    </Panel>
  );
}
