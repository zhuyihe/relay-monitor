"use client";
// 概览：利润等式、每日趋势、预计花费、消费最多的用户、利润怎么算。
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "antd";
import { NAV_LABELS } from "../../../lib/brand";
import { dayKeyInTz } from "../../../lib/business-time";
import { ADMIN_UNMARKED, EMPTY, INCOME_UNREAD, RANGE_TEXT, formatCompact, formatDayKey, formatInt, formatMoney, formatSinceToday, weekdayOfDayKey } from "../../../lib/format";
import { rateSnapshotOf, splitProfitWarnings } from "../../../lib/profit";
import { EmptyState, ErrorState, PanelSkeleton } from "../../components/data-state";
import { ForecastChart } from "../../components/forecast-chart";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Panel } from "../../components/panel";
import { EQ_TEXT, ProfitEquation, incomeUnreadProps } from "../../components/profit-equation";
import { Seg } from "../../components/seg";
import { TREND_PANEL_TITLE, TrendPanel } from "../../components/trend-panel";
import { derive } from "../analytics/derive";
import { ProfitBasis } from "./profit-basis";
import { BASIS_TITLE, COL_TEXT, DataTable, MY_TEXT, TAB_TEXT, TOKEN_NOTE, sum } from "./shared";
import type { MyTab, OwnRange, OwnView } from "./shared";

// 只在概览出现的话（design/ui-copy-spec.md §12）；列名、标签名、时间范围名、利润等式和趋势卡片名从共用的地方取
const COPY = Object.freeze({
  todayOnly: "今天只有一天，没有逐日趋势",
  todayOnlyDesc: `切到${RANGE_TEXT["7d"]}或${RANGE_TEXT["30d"]}，看每天的收入和净利；今天每小时的用量在「${TAB_TEXT.models}」里。`,
  view: (range: string) => `看${range}`,
  // 利润等式
  resold: (money: string) => `含转售 Key ${money}`,
  adminSelf: (money: string) => `管理员自用 ${money} 不算进收入`,
  noAdminSelf: "不含管理员自用",
  historyEst: (upstreams: string, n: number) => `${upstreams}，${n} 个按余额变化估算`,
  noUsageUpstream: "没有按用量算的上游",
  // 每日趋势
  dailyFailed: "读不到逐日成本",
  dailyEmpty: "暂时没有逐日成本",
  dailyEmptyDesc: "稍后刷新再看。",
  trendCaption: "按天。收入按当天普通用户消费和转售 Key 消费计算。",
  trendEstimated: "按天。旧接口没给逐日收入，按全部模型消费的占比估算，包含管理员自用的消费。",
  trendNoIncome: `按天。${INCOME_UNREAD.title}，这里只画成本。`,
  // 预计花费
  fcRange: "预计范围",
  next24: "未来 24 小时",
  next7: "未来 7 天",
  hourlyShort: "小时数据不够",
  hourlyShortDesc: "有几个小时的消费记录后，这里会估算未来 24 小时每小时的花费。",
  next24Lead: "未来 24 小时预计",
  next24Tail: "，阴影是每小时的以往起伏范围。",
  todaySoFar: "今天已消费",
  todayEst: "今天全天预计",
  dailyShortDesc: "有 3 天以上的消费记录后，这里会估算未来 7 天。",
  next7Lead: "未来 7 天预计",
  next7Band: (lo: string, hi: string) => `，按以往起伏，预计 ${lo} 到 ${hi}。`,
  recentTail: "；下面是最近每天的消费。",
  sampleLead: "按过去",
  sampleDays: (n: number) => `${n} 天`,
  sampleTail: "估算",
  dailyCaption: "每日预计花费与最近 14 天实际消费",
  colDay: "日期",
  colKind: "类型",
  colBand: "以往起伏范围",
  kind: Object.freeze({ forecast: "预计", actual: "实际" } as const),
  band: (lo: string, hi: string) => `${lo} 到 ${hi}`,
  // 消费最多的用户
  otherUsers: (n: number) => `其他 ${n} 个用户`,
  allUsers: (n: number) => `全部 ${n} 个用户`,
  payingUsers: "有消费的用户",
  userCount: (n: number) => `${n} 个`,
  noUsers: "这个时间范围内还没有用户消费",
  noUsersDesc: "换个更长的时间范围看看，或确认用户已经在用自营站点。",
});

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
      <Equation v={v} range={range} asOf={asOf} onBasis={openBasis} reload={reload} />
      {range === "today" ? (
        <Panel title={TREND_PANEL_TITLE.withRevenue} caption={MY_TEXT.byDay}>
          <EmptyState
            title={COPY.todayOnly}
            desc={COPY.todayOnlyDesc}
            action={<Button onClick={() => onRange("7d")}>{COPY.view(RANGE_TEXT["7d"])}</Button>}
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

function Equation({
  v,
  range,
  asOf,
  onBasis,
  reload,
}: {
  v: OwnView;
  range: OwnRange;
  asOf: number | null;
  onBasis: () => void;
  reload: () => Promise<unknown>;
}) {
  const p = v.profit;
  const title = EQ_TEXT.business(RANGE_TEXT[range]);
  // 写到数据自己的结束时间：刷新失败、数据停在 14:30 时不跟着时钟往后写
  const caption = formatSinceToday(v.d.startMs, v.d.tz, v.d.endMs ?? asOf ?? Date.now());
  if (!p || p.error) {
    return (
      <Panel title={title} caption={caption}>
        <ErrorState what={EQ_TEXT.profitFailed} error={p} onRetry={() => reload()} />
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
  if ((p.resoldCny || 0) > 0) revNotes.push(<span key="r">{COPY.resold(formatMoney(p.resoldCny))}</span>);
  if ((p.adminUsageCny || 0) > 0) revNotes.push(<span key="a">{COPY.adminSelf(formatMoney(p.adminUsageCny))}</span>);
  // 收入确认不了：收入、毛利、净利留空并说原因，两项成本照常（design/ui-copy-spec.md §8.1）
  const unread = p.incomeUnconfirmed ? incomeUnreadProps(p.incomeUnconfirmed, () => void reload()) : null;

  return (
    <ProfitEquation
      title={title}
      caption={caption}
      {...(unread || {})}
      extra={
        <button type="button" className="jy-caption-link jy-my-linkbtn" onClick={onBasis}>
          {BASIS_TITLE}
        </button>
      }
      revenue={{
        value: p.incomeCny,
        approx: ownNoRate,
        note: unread ? v.d.station?.name : revNotes.length ? revNotes : COPY.noAdminSelf,
        href: tabHref(range, "users"),
      }}
      upstream={{
        value: upstream,
        approx: !!p.estimated || upstreamNoRate,
        note: historyCount
          ? COPY.historyEst(EQ_TEXT.upstreamCount(usageRows.length), historyCount)
          : usageRows.length
            ? EQ_TEXT.upstreamCount(usageRows.length)
            : COPY.noUsageUpstream,
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

// 逐日上游成本取自 /api/analytics（和成本估算页同一份），每日收入取自用户和转售消费，
// 缺记录的日子标成缺失，不补零。
function DailyTrend({ v, costs, asOf, reload }: { v: OwnView; costs: any; asOf: number | null; reload: () => Promise<unknown> }) {
  const dv = useMemo(() => (costs && !costs.error ? derive(costs, v.d) : null), [costs, v.d]);
  if (costs === undefined) return <PanelSkeleton title={TREND_PANEL_TITLE.withRevenue} height={220} />;
  if (!dv) {
    return (
      <Panel title={TREND_PANEL_TITLE.withRevenue} caption={MY_TEXT.byDay}>
        {costs?.error ? (
          <ErrorState what={COPY.dailyFailed} error={costs.error} onRetry={() => reload()} />
        ) : (
          <EmptyState title={COPY.dailyEmpty} desc={COPY.dailyEmptyDesc} />
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
          {dv.incomeError ? COPY.trendNoIncome : dv.incomeEstimated ? COPY.trendEstimated : COPY.trendCaption}
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
      label={COPY.fcRange}
      value={view}
      onChange={setView}
      options={[
        { value: "24h", label: COPY.next24 },
        { value: "7d", label: COPY.next7 },
      ]}
    />
  );

  if (view === "24h") {
    const enough = h && (h.past?.length || 0) + (h.next?.length || 0) >= 4 && h.next?.length;
    if (!enough) {
      return (
        <Panel title={FC_TITLE} extra={seg}>
          <EmptyState title={COPY.hourlyShort} desc={COPY.hourlyShortDesc} />
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
            {COPY.next24Lead} <b>{formatMoney(h.next24Total * rate, { approx: true })}</b>
            {COPY.next24Tail}
          </>
        }
        foot={
          <ul className="jy-my-facts">
            <li>
              {COPY.todaySoFar} <b>{formatMoney(h.todaySoFar * rate)}</b>
            </li>
            <li>
              {COPY.todayEst} <b>{formatMoney(h.todayEst * rate, { approx: true })}</b>
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
        <EmptyState title={FC_TOO_SHORT} desc={COPY.dailyShortDesc} />
      </Panel>
    );
  }
  const lo = fc ? (fc.nextLo ?? sum(fcPts, (x) => x.lo)) : 0;
  const hi = fc ? (fc.nextHi ?? sum(fcPts, (x) => x.hi)) : 0;
  type DayRow = { t: number; kind: (typeof COPY.kind)[keyof typeof COPY.kind]; cost: number; lo?: number; hi?: number };
  // 预计在前（明天起），实际在后（昨天起倒序）
  const rows: DayRow[] = [
    ...fcPts.map((x) => ({ t: x.t, kind: COPY.kind.forecast, cost: x.cost * rate, lo: x.lo * rate, hi: x.hi * rate })),
    ...[...hist].reverse().map((x) => ({ t: x.t, kind: COPY.kind.actual, cost: x.cost * rate })),
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
            {COPY.next7Lead} <b>{formatMoney(fc.nextTotal * rate, { approx: true })}</b>
            {COPY.next7Band(formatMoney(lo * rate), formatMoney(hi * rate))}
          </>
        ) : (
          `${FC_TOO_SHORT}${COPY.recentTail}`
        )
      }
      foot={
        fc ? (
          <ul className="jy-my-facts">
            <li>
              {COPY.sampleLead} <b>{COPY.sampleDays(fc.sampleDays)}</b>
              {COPY.sampleTail}
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
        caption={COPY.dailyCaption}
        rows={rows}
        rowKey={(r) => `${r.kind}${r.t}`}
        empty={EMPTY}
        cols={[
          { key: "day", label: COPY.colDay, render: (r) => dayName(r.t) },
          {
            key: "kind",
            label: COPY.colKind,
            render: (r) => <span className={`jy-tag ${r.kind === COPY.kind.forecast ? "jy-tag--info" : "jy-tag--type"}`}>{r.kind}</span>,
          },
          { key: "cost", label: COL_TEXT.cost, num: true, render: (r) => formatMoney(r.cost, { approx: r.kind === COPY.kind.forecast }) },
          {
            key: "band",
            label: COPY.colBand,
            num: true,
            render: (r) => (r.lo != null ? COPY.band(formatMoney(r.lo), formatMoney(r.hi)) : <span className="jy-muted">{EMPTY}</span>),
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
    name: `${u.user}${u.isAdmin ? MY_TEXT.adminSuffix : ""}`,
    value: u.cost,
    tipExtra: [
      [COL_TEXT.requests, formatInt(u.requests)],
      [COL_TEXT.tokens, formatCompact(u.tokens)],
    ],
  }));
  // 其余用户合成一行，悬停提示里的占比才是占全部消费
  if (rest.length)
    items.push({
      key: "__rest",
      name: COPY.otherUsers(rest.length),
      value: sum(rest, (u) => u.cost),
      tipExtra: [
        [COL_TEXT.requests, formatInt(sum(rest, (u) => u.requests))],
        [COL_TEXT.tokens, formatCompact(sum(rest, (u) => u.tokens))],
      ],
    });
  return (
    <Panel
      title={MY_TEXT.topUsers}
      caption={RANGE_TEXT[range]}
      // 用户列表读不到：标不出谁是管理员（§8.1）
      sub={v.d.usersUnavailable ? `${ADMIN_UNMARKED}。` : undefined}
      extra={
        users.length ? (
          <button type="button" className="jy-caption-link jy-my-linkbtn" onClick={() => onTab("users")}>
            {COPY.allUsers(users.length)}
          </button>
        ) : undefined
      }
      foot={
        // 原页顶部的四项用量总数，放在用户排行下面
        <ul className="jy-my-facts">
          <li>
            {COL_TEXT.cost} <b>{formatMoney(v.totCost)}</b>
          </li>
          <li title={TOKEN_NOTE}>
            {COL_TEXT.tokens} <b>{formatCompact(v.totTokens)}</b>
          </li>
          <li>
            {COL_TEXT.requests} <b>{formatInt(v.totReqs)}</b>
          </li>
          <li>
            {COPY.payingUsers} <b>{COPY.userCount(users.length)}</b>
          </li>
        </ul>
      }
    >
      {items.length ? (
        <HBars items={items} color="var(--jy-s1)" unitName={COL_TEXT.cost} />
      ) : (
        <EmptyState title={COPY.noUsers} desc={COPY.noUsersDesc} />
      )}
    </Panel>
  );
}
