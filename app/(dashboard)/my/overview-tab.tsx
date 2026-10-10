"use client";
// 概览：利润等式、每日趋势、消费预测、消费最多的用户、利润口径。
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "antd";
import { EMPTY, WEEKDAYS, formatCompact, formatInt, formatMoney, formatMonthDay } from "../../../lib/format";
import { EmptyState, ErrorState } from "../../components/data-state";
import { ForecastChart } from "../../components/forecast-chart";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Panel } from "../../components/panel";
import { ProfitEquation } from "../../components/profit-equation";
import { Seg } from "../../components/seg";
import { TrendPanel } from "../../components/trend-panel";
import { derive } from "../analytics/derive";
import { ProfitBasis } from "./profit-basis";
import { DataTable, RANGE_LABEL, TOKEN_NOTE, productErrorMessage, sum } from "./shared";
import type { MyTab, OwnRange, OwnView } from "./shared";

// 利润等式里各项跳到哪个标签页看明细（保留当前时间范围）
const tabHref = (range: OwnRange, tab: MyTab) => {
  const qs = new URLSearchParams();
  if (range !== "today") qs.set("range", range);
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
        <Panel title="收入与用量成本" caption="按天">
          <EmptyState
            title="今天只有一天，没有逐日趋势"
            desc="切到近 7 天或近 30 天查看每天的收入与毛利；今天每小时的用量在「模型与渠道」里。"
            action={<Button onClick={() => onRange("7d")}>看近 7 天</Button>}
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
  const title = "期内经营";
  const caption = RANGE_LABEL[range];
  if (!p || p.error) {
    return (
      <Panel title={title} caption={caption}>
        <ErrorState title="毛利暂时算不出来" error={productErrorMessage(p?.error || "接口没有返回利润数据")} onRetry={() => reload()} />
      </Panel>
    );
  }
  const costs: any[] = p.costs || [];
  const fixedRows = costs.filter((c) => c.mode === "fixed");
  const usageRows = costs.filter((c) => c.mode !== "fixed");
  const historyCount = usageRows.filter((c) => c.mode === "history").length;
  const usage = sum(usageRows, (c) => c.cny);
  const fixed = sum(fixedRows, (c) => c.cny);

  // 未配置汇率按 1:1 折算：自营站点没配影响收入，上游没配影响用量成本
  const warnings: string[] = p.warnings || [];
  const rateWarn = warnings.find((w) => w.includes("未配置汇率"));
  const noRate = rateWarn
    ? rateWarn
        .replace(/\s*未配置汇率.*$/, "")
        .split("、")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const ownNoRate = !(Number(v.d.station?.cnyPerUsd) > 0);
  const upstreamNoRate = noRate.some((n) => n !== v.d.station?.name) || (!p.complete && !rateWarn);
  const reasons = warnings.filter((w) => w.includes("推算") || w.includes("汇率")).map((w) => `${w}。`);

  const revNotes: ReactNode[] = [];
  if ((p.resoldCny || 0) > 0) revNotes.push(<span key="r">含转售 Key {formatMoney(p.resoldCny)}</span>);
  if ((p.adminUsageCny || 0) > 0) revNotes.push(<span key="a">管理员自用 {formatMoney(p.adminUsageCny)} 不计入</span>);

  return (
    <ProfitEquation
      title={title}
      caption={caption}
      extra={
        <button type="button" className="jy-caption-link jy-my-linkbtn" onClick={onBasis}>
          利润口径
        </button>
      }
      revenue={{
        value: p.incomeCny,
        approx: ownNoRate,
        note: revNotes.length ? revNotes : "不含管理员自用",
        href: tabHref(range, "users"),
      }}
      usage={{
        value: usage,
        approx: !!p.estimated || upstreamNoRate,
        note: historyCount
          ? `${historyCount} 个上游按余额推算`
          : usageRows.length
            ? `${usageRows.length} 个上游按用量计`
            : "没有按用量计的上游",
        href: tabHref(range, "models"),
      }}
      fixed={{ value: fixed, note: fixedRows.length ? `${fixedRows.length} 项按天摊销` : "没有固定成本" }}
      profit={p.profitCny}
      reasons={reasons}
      partialTail="实际毛利可能高于或低于这里。"
    />
  );
}

// ---- 每日趋势 -------------------------------------------------------------

// 逐日用量成本取自 /api/analytics（与「成本与利润」同一口径），每日收入按当天下游消费占比摊分，
// 缺记录的日子标成缺失，不补零。
function DailyTrend({ v, costs, asOf, reload }: { v: OwnView; costs: any; asOf: number | null; reload: () => Promise<unknown> }) {
  const dv = useMemo(() => (costs && !costs.error ? derive(costs, v.d) : null), [costs, v.d]);
  if (!dv) {
    return (
      <Panel title="收入与用量成本" caption="按天">
        {costs?.error ? (
          <ErrorState title="逐日成本加载失败" error={costs.error} onRetry={() => reload()} />
        ) : (
          <EmptyState title="暂时没有逐日成本" desc="稍后刷新再看。" />
        )}
      </Panel>
    );
  }
  const first = dv.rows[0]?.fixed ?? 0;
  const flat = dv.rows.every((r) => r.fixed === first);
  const note =
    dv.fixed > 0
      ? flat
        ? `固定成本每天 ${formatMoney(first)}，计入毛利`
        : `固定成本按天摊销，期内合计 ${formatMoney(dv.fixed)}，计入毛利`
      : undefined;
  return (
    <TrendPanel
      rows={dv.rows}
      showRev={dv.hasIncome}
      asOf={asOf}
      caption={
        <>
          按天，收入按当天消费占比摊分。
          <Link className="jy-link" href={`/analytics?range=${dv.rows.length <= 7 ? "7d" : "30d"}`}>
            成本明细
          </Link>
        </>
      }
      fixedNote={note}
    />
  );
}

// ---- 消费预测 -------------------------------------------------------------

type FcView = "24h" | "7d";

function ForecastPanel({ v }: { v: OwnView }) {
  const [view, setView] = useState<FcView>("24h");
  const { d, rate } = v;
  const h = d.hourly;
  const fc = d.forecast;
  const seg = (
    <Seg<FcView>
      size="sm"
      label="预测范围"
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
        <Panel title="消费预测" extra={seg}>
          <EmptyState title="小时数据不足" desc="有几个小时的消费记录后，这里会预测未来 24 小时每小时的消费。" />
        </Panel>
      );
    }
    const points = h.next.map((x: any) => ({ t: x.t, cost: x.cost * rate, lo: x.lo * rate, hi: x.hi * rate }));
    return (
      <Panel
        title="消费预测"
        extra={seg}
        sub={
          <>
            未来 24 小时预计 <b>{formatMoney(h.next24Total * rate, { approx: true })}</b>，阴影是每小时的历史波动范围。
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
                24 小时总量回测偏差 <b>±{h.backtestWapePct}%</b>
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
      <Panel title="消费预测" extra={seg}>
        <EmptyState title="历史数据不足 3 天，暂无法预测" desc="有 3 天以上的完整消费记录后，这里会预测未来 7 天。" />
      </Panel>
    );
  }
  const lo = fc ? (fc.nextLo ?? sum(fcPts, (x) => x.lo)) : 0;
  const hi = fc ? (fc.nextHi ?? sum(fcPts, (x) => x.hi)) : 0;
  type DayRow = { t: number; kind: "预测" | "实际"; cost: number; lo?: number; hi?: number };
  // 预测在前（明天起），历史在后（昨天起倒序）
  const rows: DayRow[] = [
    ...fcPts.map((x) => ({ t: x.t, kind: "预测" as const, cost: x.cost * rate, lo: x.lo * rate, hi: x.hi * rate })),
    ...[...hist].reverse().map((x) => ({ t: x.t, kind: "实际" as const, cost: x.cost * rate })),
  ];
  const dayName = (t: number) => {
    const dt = new Date(t);
    return `${formatMonthDay(dt)} ${WEEKDAYS[dt.getDay()]}`;
  };
  return (
    <Panel
      title="消费预测"
      extra={seg}
      sub={
        fc ? (
          <>
            未来 7 天预计 <b>{formatMoney(fc.nextTotal * rate, { approx: true })}</b>，按历史波动在 {formatMoney(lo * rate)} 至{" "}
            {formatMoney(hi * rate)} 之间。
          </>
        ) : (
          "历史数据不足 3 天，暂无法预测；下面是最近的每日消费。"
        )
      }
      foot={
        fc ? (
          <ul className="jy-my-facts">
            <li>
              预测方法 <b>{fc.method}</b>
            </li>
            <li>
              基于 <b>{fc.sampleDays} 天</b>
            </li>
            {fc.backtestWapePct != null && (
              <li>
                近 2 周回测日均偏差 <b>±{fc.backtestWapePct}%</b>
              </li>
            )}
          </ul>
        ) : undefined
      }
    >
      <DataTable<DayRow>
        scroll
        compact
        caption="每日消费预测与最近 14 天实际消费"
        rows={rows}
        rowKey={(r) => `${r.kind}${r.t}`}
        empty="暂无数据"
        cols={[
          { key: "day", label: "日期", render: (r) => dayName(r.t) },
          {
            key: "kind",
            label: "类型",
            render: (r) => <span className={`jy-tag ${r.kind === "预测" ? "jy-tag--info" : "jy-tag--type"}`}>{r.kind}</span>,
          },
          { key: "cost", label: "消费", num: true, render: (r) => formatMoney(r.cost, { approx: r.kind === "预测" }) },
          {
            key: "band",
            label: "历史波动范围",
            num: true,
            render: (r) => (r.lo != null ? `${formatMoney(r.lo)} 至 ${formatMoney(r.hi)}` : <span className="jy-muted">{EMPTY}</span>),
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
      ["请求", formatInt(u.requests)],
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
        ["请求", formatInt(sum(rest, (u) => u.requests))],
        ["Token", formatCompact(sum(rest, (u) => u.tokens))],
      ],
    });
  return (
    <Panel
      title="消费最多的用户"
      caption={RANGE_LABEL[range]}
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
            期内消费 <b>{formatMoney(v.totCost)}</b>
          </li>
          <li title={TOKEN_NOTE}>
            计费 Token <b>{formatCompact(v.totTokens)}</b>
          </li>
          <li>
            请求 <b>{formatInt(v.totReqs)}</b>
          </li>
          <li>
            活跃用户 <b>{users.length} 个</b>
          </li>
        </ul>
      }
    >
      {items.length ? (
        <HBars items={items} color="var(--jy-s1)" unitName="消费" />
      ) : (
        <EmptyState title="这个时间范围内还没有用户消费" desc="换个更长的时间范围看看，或确认下游用户已经在用自营站点。" />
      )}
    </Panel>
  );
}
