"use client";
// 概览：指标行（有消费的用户、请求数、Token）；利润等式；每日收入（8 列）+ 消费最多的用户（4 列）；预计花费（8 列）+ 消费最多的模型（4 列）；利润怎么算（ui-design-spec §5.3）。
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "antd";
import { NAV_LABELS } from "../../../lib/brand";
import { dayKeyInTz } from "../../../lib/business-time";
import { ADMIN_UNMARKED, BASIS_TITLE, EMPTY, FORECAST_TEXT, RANGE_TEXT, SELL_PRICE_UNSET, formatCompact, formatDayKey, formatInt, formatMoney, formatSinceToday, weekdayOfDayKey } from "../../../lib/format";
import { profitApproxOf, splitProfitWarnings } from "../../../lib/profit";
import { EmptyState, ErrorState } from "../../components/data-state";
import { ForecastChart } from "../../components/forecast-chart";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Panel } from "../../components/panel";
import { EQ_TEXT, ProfitEquation, incomeUnreadProps } from "../../components/profit-equation";
import { Seg } from "../../components/seg";
import { TrendPanel } from "../../components/trend-panel";
import type { TrendRow } from "../../components/trend-panel";
import { ProfitBasis } from "./profit-basis";
import { COL_TEXT, DataTable, MY_TEXT, TAB_TEXT, TOKEN_NOTE, sum } from "./shared";
import type { MyTab, OwnRange, OwnView, UsageRow } from "./shared";

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
  // 每日收入：只画收入（这一页回答「钱从哪来」，上游成本在每日利润、成本估算里看）
  incomeTitle: "每日收入",
  incomeCaption: "按天。收入按当天普通用户消费和转售 Key 消费计算。",
  // 说明末尾去成本估算看上游成本（带当前时间范围）
  incomeCostLead: "上游成本在",
  incomeCostTail: "里看。",
  incomeEmpty: "暂时没有逐日收入",
  incomeEmptyDesc: "稍后刷新再看。",
  // 收入读不到：原因和「刷新」在上面的利润等式里，这里只写一句（同一句话一页只说一次）
  incomeSeeEq: "读不到，原因见上面的利润等式。",
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
  dailyCaption: "每日预计花费与最近 14 天实际消费",
  colDay: "日期",
  colKind: "类型",
  colBand: "以往起伏范围",
  kind: Object.freeze({ forecast: "预计", actual: "实际" } as const),
  band: (lo: string, hi: string) => `${lo} 到 ${hi}`,
  // 消费最多的用户、模型（各前 5，多的并成一行）
  otherUsers: (n: number) => `其他 ${n} 个用户`,
  // 不带人数：人数在指标行里（同一个数一页只出现一次）
  allUsers: () => "看全部用户",
  topModels: "消费最多的模型",
  otherModels: (n: number) => `其他 ${n} 个模型`,
  allModels: (n: number) => `全部 ${n} 个模型`,
  noModels: "这个时间范围内还没有模型用量",
  // 模型的消费含管理员自用，和等式里的收入不是一个数（模型与渠道标签页同一句，shared.tsx totalsNote）
  modelsInclAdmin: "含管理员自用，和收入不是一个数。",
  payingUsers: "有消费的用户",
  // 指标行（ui-design-spec §5.3）：这次只放利润等式里没有的三个数；收入和「这段时间毛利」等 G 把等式拿掉时再补
  metrics: "这段时间的用量",
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
  range,
  asOf,
  onRange,
  onTab,
  reload,
}: {
  v: OwnView;
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
      <Metrics v={v} />
      <Equation v={v} range={range} asOf={asOf} onBasis={openBasis} reload={reload} />
      {/* 两行 8 + 4（ui-design-spec §5.3）：每日收入 + 消费最多的用户；预计花费 + 消费最多的模型 */}
      <div className="jy-grid-8-4">
        {range === "today" ? (
          <Panel title={COPY.incomeTitle} caption={MY_TEXT.byDay}>
            <EmptyState
              title={COPY.todayOnly}
              desc={COPY.todayOnlyDesc}
              action={<Button onClick={() => onRange("7d")}>{COPY.view(RANGE_TEXT["7d"])}</Button>}
            />
          </Panel>
        ) : (
          <IncomeTrend v={v} range={range} asOf={asOf} />
        )}
        <TopUsers v={v} range={range} onTab={onTab} />
      </div>
      <div className="jy-grid-8-4">
        <ForecastPanel v={v} />
        <TopModels v={v} range={range} onTab={onTab} />
      </div>
      <div ref={basisRef}>
        <ProfitBasis v={v} open={basisOpen} onOpenChange={setBasisOpen} reload={reload} />
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

  // 没设置售价影响收入，上游没设置汇率影响上游成本；都由接口给出，不解析提示文字。和日报同一个判断（lib/profit.js）
  const approx = profitApproxOf(p, v.d.station);
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
        approx: approx.income,
        note: unread ? v.d.station?.name : revNotes.length ? revNotes : COPY.noAdminSelf,
        href: tabHref(range, "users"),
      }}
      upstream={{
        value: upstream,
        approx: approx.upstream,
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

// 每日收入：取自营站点接口的逐日收入（incomeDaily），只画收入，不再另读 /api/analytics 的逐日上游成本（ui-design-spec §5.3）
// 没设置售价时收入是估算：和等式同一个判断（profitApproxOf），数值带「≈」，说明里接上 SELL_PRICE_UNSET
function IncomeTrend({ v, range, asOf }: { v: OwnView; range: OwnRange; asOf: number | null }) {
  const d = v.d;
  const rows: TrendRow[] = useMemo(() => {
    if (!Array.isArray(d?.incomeDaily)) return [];
    // 「今天」按数据自己的结束时间判断：跨零点后、数据还停在昨天时，最后一天不画成今天
    const today = dayKeyInTz((d.endMs ?? Date.now()) - 1, d.tz);
    return d.incomeDaily.map((r: any) => ({ date: r.date, rev: Number(r.incomeCny) || 0, cost: null, fixed: 0, today: r.date === today }));
  }, [d]);
  if (d?.profit?.error || d?.profit?.incomeUnconfirmed) {
    return (
      <Panel title={COPY.incomeTitle} caption={MY_TEXT.byDay}>
        <p className="jy-muted" style={{ margin: 0 }}>{COPY.incomeSeeEq}</p>
      </Panel>
    );
  }
  if (!rows.length) {
    return (
      <Panel title={COPY.incomeTitle} caption={MY_TEXT.byDay}>
        <EmptyState title={COPY.incomeEmpty} desc={COPY.incomeEmptyDesc} />
      </Panel>
    );
  }
  const revApprox = !!v.profit && profitApproxOf(v.profit, d.station).income;
  return (
    <TrendPanel
      rows={rows}
      showCost={false}
      revApprox={revApprox}
      title={COPY.incomeTitle}
      asOf={asOf}
      tz={d.tz}
      caption={
        <>
          {COPY.incomeCaption}
          {revApprox ? `${SELL_PRICE_UNSET}。` : ""}
          {COPY.incomeCostLead}
          <Link className="jy-link" href={`/analytics?range=${range}`}>
            {NAV_LABELS.analytics}
          </Link>
          {COPY.incomeCostTail}
        </>
      }
    />
  );
}

// ---- 预计花费 -------------------------------------------------------------

type FcView = "24h" | "7d";

// 预计花费面板里重复出现的几句（design/ui-copy-spec.md §3.4）；「按过去 N 天估算」「过去 2 周平均差」和日报共用（FORECAST_TEXT）
export const FC_TITLE = "预计花费";
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
                {FORECAST_TEXT.accuracy} <b>{FORECAST_TEXT.accuracyPct(h.backtestWapePct)}</b>
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
              {FORECAST_TEXT.sampleLead} <b>{FORECAST_TEXT.sampleDays(fc.sampleDays)}</b>
              {FORECAST_TEXT.sampleTail}
            </li>
            {fc.backtestWapePct != null && (
              <li>
                {FORECAST_TEXT.accuracy} <b>{FORECAST_TEXT.accuracyPct(fc.backtestWapePct)}</b>
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

// 前 5 名排行，多的并成一行（悬停提示里的占比才是占全部消费）；用户和模型共用这一份
// 指标行：有消费的用户、请求数、Token（不含缓存）。收入、毛利在利润等式里，这里不再写（同一个数一页只出现一次）；
// G 把 /my 的等式拿掉时再补「收入」和「这段时间毛利 → 每日利润」（ui-design-spec §5.3，分两步做）
function Metrics({ v }: { v: OwnView }) {
  return (
    <Panel label={COPY.metrics}>
      <dl className="jy-kpis">
        <div>
          <dt>{COPY.payingUsers}</dt>
          <dd className="jy-kpi-figure">{COPY.userCount(v.users.length)}</dd>
        </div>
        <div>
          <dt>{COL_TEXT.requests}</dt>
          <dd className="jy-kpi-figure">{formatInt(v.totReqs)}</dd>
        </div>
        <div>
          <dt title={TOKEN_NOTE}>{COL_TEXT.tokens}</dt>
          <dd className="jy-kpi-figure">{formatCompact(v.totTokens)}</dd>
        </div>
      </dl>
    </Panel>
  );
}

// 模型排行下面一行：这段时间的消费合计（按模型加总，含管理员自用），等于模型那几条加起来；有消费的用户、请求数、Token 在指标行里
const USAGE_FACTS_FOOT = (v: OwnView) => (
  <ul className="jy-my-facts">
    <li>
      {COL_TEXT.cost} <b>{formatMoney(v.totCost)}</b>
    </li>
  </ul>
);

function TopPanel({
  title,
  caption,
  sub,
  rows,
  nameOf,
  otherLabel,
  allLabel,
  onAll,
  empty,
  foot,
  className,
}: {
  className?: string;
  title: string;
  caption: string;
  sub?: ReactNode;
  rows: UsageRow[];
  nameOf: (r: UsageRow) => string;
  otherLabel: (n: number) => string;
  allLabel: (n: number) => string;
  onAll: () => void;
  empty: ReactNode;
  foot?: ReactNode;
}) {
  const sorted = [...rows].sort((a, b) => b.cost - a.cost);
  const top = sorted.slice(0, 5);
  const rest = sorted.slice(5);
  const tip = (list: UsageRow[]): HBarItem["tipExtra"] => [
    [COL_TEXT.requests, formatInt(sum(list, (r) => r.requests))],
    [COL_TEXT.tokens, formatCompact(sum(list, (r) => r.tokens))],
  ];
  const items: HBarItem[] = top.map((r) => ({ key: nameOf(r), name: nameOf(r), value: r.cost, tipExtra: tip([r]) }));
  if (rest.length) items.push({ key: "__rest", name: otherLabel(rest.length), value: sum(rest, (r) => r.cost), tipExtra: tip(rest) });
  return (
    <Panel
      className={className}
      title={title}
      caption={caption}
      sub={sub}
      extra={
        sorted.length ? (
          <button type="button" className="jy-caption-link jy-my-linkbtn" onClick={onAll}>
            {allLabel(sorted.length)}
          </button>
        ) : undefined
      }
      foot={foot}
    >
      {items.length ? <HBars items={items} color="var(--jy-s1)" unitName={COL_TEXT.cost} /> : empty}
    </Panel>
  );
}

function TopUsers({ v, range, onTab }: { v: OwnView; range: OwnRange; onTab: (t: MyTab) => void }) {
  return (
    <TopPanel
      title={MY_TEXT.topUsers}
      caption={RANGE_TEXT[range]}
      // 用户列表读不到：标不出谁是管理员（§8.1）
      sub={v.d.usersUnavailable ? `${ADMIN_UNMARKED}。` : undefined}
      rows={v.users}
      nameOf={(u: any) => `${u.user}${u.isAdmin ? MY_TEXT.adminSuffix : ""}`}
      otherLabel={COPY.otherUsers}
      allLabel={COPY.allUsers}
      onAll={() => onTab("users")}
      empty={<EmptyState title={COPY.noUsers} desc={COPY.noUsersDesc} />}
    />
  );
}

function TopModels({ v, range, onTab }: { v: OwnView; range: OwnRange; onTab: (t: MyTab) => void }) {
  return (
    <TopPanel
      // 手机上不放（#64 第 5 节的手机顺序）：模型在「模型与渠道」标签页里看
      className="jy-my-top-models"
      title={COPY.topModels}
      caption={RANGE_TEXT[range]}
      rows={v.models}
      nameOf={(m: any) => String(m.model)}
      otherLabel={COPY.otherModels}
      allLabel={COPY.allModels}
      onAll={() => onTab("models")}
      sub={v.models.length ? COPY.modelsInclAdmin : undefined}
      empty={<EmptyState title={COPY.noModels} />}
      foot={v.models.length ? USAGE_FACTS_FOOT(v) : undefined}
    />
  );
}
