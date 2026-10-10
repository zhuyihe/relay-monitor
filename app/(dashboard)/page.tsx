"use client";
// 运营总览：利润等式 + 需要处理 + 上游余量 + 收入 / 用量成本排行。
// 利润口径与"我的中转站"一致（/api/own/analytics 的 profit）；没设置自营站点时，成本退回 /api/analytics 统计。
// 需要处理、上游余量来自 /api/stations，规则与侧栏的待处理计数共用 buildOverviewActions。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button } from "antd";
import { api, rateOf, statusOf, threshold } from "../../lib/client";
import type { WorkflowAction } from "../../lib/client";
import { attentionStationIds, buildOverviewActions } from "../../lib/overview-actions";
import { describeConnectionFailure } from "../../lib/connection-test";
import { formatDays, formatHhmm, formatMoney, formatMonthDay, formatUsd } from "../../lib/format";
import { AttentionList } from "../components/attention-list";
import { Sym } from "../components/icons";
import type { AttentionItem } from "../components/attention-list";
import { EmptyState, ErrorState, PanelSkeleton } from "../components/data-state";
import type { TipRow } from "../components/float-tip";
import { HBars } from "../components/hbars";
import type { HBarItem } from "../components/hbars";
import { CountBadge, Panel } from "../components/panel";
import { ProfitEquation } from "../components/profit-equation";
import type { EqTerm } from "../components/profit-equation";
import { RangePicker } from "../components/range-picker";
import { Runway } from "../components/runway";
import type { RunwayItem } from "../components/runway";
import { useShellPage } from "../components/shell-context";
import { LEVEL_ORDER } from "../components/status";
import type { Level } from "../components/status";
import { useUrlState } from "../components/use-url-state";
import { useWorkflowActions } from "../components/use-workflow-actions";
import { actionPhrase, workflowDetail, workflowOwner, workflowProblem } from "../components/workflow-copy";
import TrendModal from "./trend-modal";
import "../styles/pages/overview.css";

const RANGES = ["today", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];
const RANGE_OPTIONS = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];
const RANGE_DAYS: Record<Range, number> = { today: 1, "7d": 7, "30d": 30 };
const RANGE_NAME: Record<Range, string> = { today: "今日", "7d": "近 7 天", "30d": "近 30 天" };

const RUNWAY_MAX_DAYS = 14;
const RUNWAY_WARN_DAYS = 7;
const RUNWAY_LIMIT = 8;
const TOP_USERS = 5;

const r2 = (v: number) => Math.round(v * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// 相对时间："N 秒前 / N 分钟前 / N 小时前"
function relTime(iso: string | null | undefined): string {
  if (!iso) return "从未";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.max(0, Math.floor(d))} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

// 站点余额按站点自己的单位显示；配了汇率的站点是美元额度
const balanceText = (s: any, v: number) => (rateOf(s) !== 1 ? formatUsd(v) : formatMoney(v));
const balanceWithCny = (s: any, v: number) =>
  rateOf(s) !== 1 ? `${formatUsd(v)}，约 ${formatMoney(v * rateOf(s))}` : formatMoney(v);

// 利润等式标题下的时间说明
function windowCaption(range: Range, data: any): string {
  const now = new Date();
  const end = formatHhmm(now.getTime());
  if (range === "today") return `今日 00:00 至 ${end}`;
  const days = RANGE_DAYS[range];
  const start = data?.startMs ? new Date(data.startMs) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return `${formatMonthDay(start)} 00:00 至 今天 ${end}，共 ${days} 天`;
}

type Money =
  | { range: Range; unconfigured: false; own: any; fallback: null }
  | { range: Range; unconfigured: true; own: null; fallback: any };

export default function OverviewPage() {
  const { message } = App.useApp();
  const router = useRouter();
  const [range, setRange] = useUrlState<Range>("range", "today", RANGES);

  const [rules, setRules] = useState<any>({});
  const [settings, setSettings] = useState<any>({ refreshIntervalSec: 60, lowBalanceUsd: 5 });
  const [stations, setStations] = useState<any[] | null>(null);
  const [stationsErr, setStationsErr] = useState<string | null>(null);
  const [stationsAt, setStationsAt] = useState<number | null>(null);
  const [money, setMoney] = useState<Money | null>(null);
  const [moneyErr, setMoneyErr] = useState<string | null>(null);
  const [moneyAt, setMoneyAt] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [trendStation, setTrendStation] = useState<any>(null);
  // 账号关系与账单核算产生的待办：与侧栏计数、上游资源页共用一份
  const { actions: workflowActions, error: workflowError, loading: workflowLoading, reload: reloadWorkflowActions } = useWorkflowActions();
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const loadStations = useCallback(async () => {
    try {
      const r = await api("/api/stations");
      setStations(Array.isArray(r?.stations) ? r.stations : []);
      if (r?.settings) setSettings(r.settings);
      setStationsErr(null);
      setStationsAt(Date.now());
    } catch (e: any) {
      setStationsErr(e?.message || "上游资源加载失败");
    }
  }, []);

  // 经营数据：优先自营站点口径；没标记自营站点时只统计成本
  const loadMoney = useCallback(async (r: Range) => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const own = await api(`/api/own/analytics?range=${r}&tz=${encodeURIComponent(tz)}`);
      if (rangeRef.current !== r) return;
      setMoney({ range: r, unconfigured: false, own, fallback: null });
      setMoneyErr(null);
      setMoneyAt(Date.now());
    } catch (e: any) {
      if (rangeRef.current !== r) return;
      const msg = String(e?.message || "");
      if (!msg.includes("还没有标记")) {
        setMoneyErr(msg || "经营数据加载失败");
        return;
      }
      try {
        const fallback = await api(`/api/analytics?days=${RANGE_DAYS[r]}&includeArchived=true`);
        if (rangeRef.current !== r) return;
        setMoney({ range: r, unconfigured: true, own: null, fallback });
        setMoneyErr(null);
        setMoneyAt(Date.now());
      } catch (e2: any) {
        if (rangeRef.current === r) setMoneyErr(e2?.message || "成本数据加载失败");
      }
    }
  }, []);

  useEffect(() => {
    api("/api/meta")
      .then((m) => {
        setRules(m?.rules || {});
        if (m?.settings) setSettings(m.settings);
      })
      .catch(() => {});
  }, []);

  // 切换时间范围：清掉上一个范围的错误，立即重新拉取
  useEffect(() => {
    setMoneyErr(null);
    loadMoney(range);
  }, [range, loadMoney]);

  // 按系统设置的刷新间隔轮询（最短 30 秒）；标签页在后台时不拉，切回来立即拉一次
  const intervalSec = Math.max(30, Number(settings?.refreshIntervalSec) || 60);
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      loadStations();
      loadMoney(rangeRef.current);
    };
    loadStations();
    const timer = setInterval(tick, intervalSec * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalSec, loadStations, loadMoney]);

  const onRefresh = async () => {
    await api("/api/refresh", { method: "POST", body: {} });
    await Promise.all([loadStations(), loadMoney(rangeRef.current), reloadWorkflowActions()]);
    message.success("已刷新全部上游资源");
  };

  const syncOne = async (s: any) => {
    setSyncingId(s.id);
    try {
      await api(`/api/stations/${s.id}/refresh`, { method: "POST", body: {} });
      await loadStations();
      message.success(`已同步 ${s.name}`);
    } catch (e: any) {
      message.error(e?.message || "同步失败");
    } finally {
      setSyncingId(null);
    }
  };

  const rangePicker = useMemo(
    () => <RangePicker value={range} options={RANGE_OPTIONS} onChange={(v) => setRange(v as Range)} />,
    [range, setRange],
  );
  const asOfs = [stationsAt, moneyAt].filter((t): t is number => t != null);
  useShellPage({ onRefresh, asOf: asOfs.length ? Math.min(...asOfs) : null, range: rangePicker });

  const critDays = Number(rules?.etaDays) > 0 ? Number(rules.etaDays) : 3;
  const current = money && money.range === range ? money : null;
  const rangeName = RANGE_NAME[range];

  return (
    <div className="jy-page">
      <Equation range={range} money={current} error={moneyErr} onRetry={() => loadMoney(range)} />

      <div className="jy-grid-2">
        <AttentionPanel
          stations={stations}
          error={stationsErr}
          rules={rules}
          settings={settings}
          workflowActions={workflowActions}
          workflowError={workflowError}
          workflowLoading={workflowLoading}
          onReloadWorkflow={() => void reloadWorkflowActions()}
          syncingId={syncingId}
          onRetry={loadStations}
          onSync={syncOne}
          onEdit={(s) => router.push(`/stations?edit=${encodeURIComponent(s.id)}`)}
          onTrend={setTrendStation}
        />
        <RunwayPanel
          stations={stations}
          error={stationsErr}
          settings={settings}
          critDays={critDays}
          onRetry={loadStations}
          onTrend={setTrendStation}
        />
      </div>

      <div className="jy-grid-2 jy-grid-even">
        <RevenuePanel title={`${rangeName}收入`} money={current} error={moneyErr} onRetry={() => loadMoney(range)} />
        <CostPanel title={`${rangeName}用量成本`} money={current} error={moneyErr} onRetry={() => loadMoney(range)} />
      </div>

      <TrendModal station={trendStation} onClose={() => setTrendStation(null)} etaDaysRule={critDays} />
    </div>
  );
}

// ---- 利润等式 ---------------------------------------------------------------

function Equation({ range, money, error, onRetry }: { range: Range; money: Money | null; error: string | null; onRetry: () => void }) {
  const title = `${RANGE_NAME[range]}经营`;
  if (error && !money) {
    return (
      <Panel title={title}>
        <ErrorState title="经营数据加载失败" error={error} onRetry={onRetry} />
      </Panel>
    );
  }
  const caption = windowCaption(range, money?.own);
  if (!money) {
    const blank: EqTerm = { value: null };
    return <ProfitEquation title={title} caption={caption} revenue={blank} usage={blank} fixed={blank} loading />;
  }

  if (money.unconfigured) {
    const fb = money.fallback || {};
    const list: any[] = (fb.stations || []).filter((s: any) => s.includeInProfit);
    const usageList = list.filter((s) => !s.isOwn && !(s.fixedCny > 0));
    const fixedList = list.filter((s) => s.fixedCny > 0);
    const usageIds = new Set(usageList.map((s) => s.id));
    const gaps: any[] = (fb.coverage?.stationGaps || []).filter((g: any) => usageIds.has(g.stationId) && Number(g.missingDays) > 0);
    return (
      <ProfitEquation
        title={title}
        caption={caption}
        unconfigured
        revenue={{ value: null }}
        usage={{
          value: r2(sum(usageList.map((s) => Number(s.totalCny) || 0))),
          approx: gaps.length > 0,
          note: `${usageList.length} 个上游资源`,
          href: "/analytics",
        }}
        fixed={{
          value: r2(sum(fixedList.map((s) => Number(s.fixedCny) || 0))),
          note: fixedList.length ? `${fixedList.length} 项，按天摊销` : "没有固定成本",
          href: "/stations",
        }}
        reasons={gaps.map((g) => `${g.stationName} 缺 ${g.missingDays} 天的消耗记录。`)}
        partialTail="实际成本会比这里高。"
      />
    );
  }

  const own = money.own || {};
  const profit = own.profit || {};
  if (profit.error) {
    return (
      <Panel title={title} caption={caption}>
        <ErrorState title="毛利暂时算不出来" error={profit.error} onRetry={onRetry} />
      </Panel>
    );
  }
  const costs: any[] = profit.costs || [];
  const usageCosts = costs.filter((c) => c.mode !== "fixed");
  const fixedCosts = costs.filter((c) => c.mode === "fixed");
  const ownRateMissing = !(Number(own.station?.cnyPerUsd) > 0);
  const users = (own.byUser || []).filter((u: any) => !u.isAdmin).length;
  // 只有"推算"和"汇率按 1:1"会让数字不准；未关联渠道、不计入利润是口径说明，放到成本面板底部
  const reasons = ((profit.warnings || []) as string[])
    .filter((w) => /推算|汇率/.test(w))
    .map((w) => (/[。！？]$/.test(w) ? w : `${w}。`));
  return (
    <ProfitEquation
      title={title}
      caption={caption}
      revenue={{
        value: profit.incomeCny ?? null,
        approx: ownRateMissing,
        note: ownRateMissing ? "未设置汇率，按 1:1 折算" : `来自 ${users} 位下游用户`,
        href: "/my",
      }}
      usage={{
        value: r2(sum(usageCosts.map((c) => Number(c.cny) || 0))),
        approx: !!profit.estimated || (!profit.complete && !ownRateMissing),
        note: `${usageCosts.length} 个上游资源`,
        href: "/analytics",
      }}
      fixed={{
        value: r2(sum(fixedCosts.map((c) => Number(c.cny) || 0))),
        note: fixedCosts.length ? `${fixedCosts.length} 项，按天摊销` : "没有固定成本",
        href: "/stations",
      }}
      profit={profit.profitCny ?? null}
      reasons={reasons}
      partialTail="实际数字可能与这里有出入。"
    />
  );
}

// ---- 需要处理 ---------------------------------------------------------------

function AttentionPanel({
  stations,
  error,
  rules,
  settings,
  workflowActions,
  workflowError,
  workflowLoading,
  onReloadWorkflow,
  syncingId,
  onRetry,
  onSync,
  onEdit,
  onTrend,
}: {
  stations: any[] | null;
  error: string | null;
  rules: any;
  settings: any;
  workflowActions: WorkflowAction[];
  workflowError: string;
  workflowLoading: boolean;
  onReloadWorkflow: () => void;
  syncingId: string | null;
  onRetry: () => void;
  onSync: (s: any) => void;
  onEdit: (s: any) => void;
  onTrend: (s: any) => void;
}) {
  const actions = useMemo(
    () =>
      buildOverviewActions(stations || [], {
        rules,
        settings,
        statusOf,
        workflowActions,
      }),
    [stations, rules, settings, workflowActions],
  );
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const extra = (
    <>
      <span className="jy-caption">紧急在前，同级按耗尽时间</span>
      <Button size="small" loading={workflowLoading} onClick={onReloadWorkflow}>
        刷新处理事项
      </Button>
    </>
  );
  if (!stations) {
    if (error) {
      return (
        <Panel title="需要处理">
          <ErrorState title="上游资源加载失败" error={error} onRetry={onRetry} />
        </Panel>
      );
    }
    return <PanelSkeleton title="需要处理" lines={4} />;
  }

  // 每条的第一个操作是带边框的按钮，其余是链接样式（与设计稿一致）
  const btn = (label: string, onClick: () => void, extra: { loading?: boolean; primary?: boolean; aria: string }) => (
    <Button size="small" type={extra.primary ? "default" : "link"} loading={extra.loading} onClick={onClick} aria-label={extra.aria}>
      {label}
    </Button>
  );
  const names = new Map(stations.filter(Boolean).map((s) => [String(s.id), s.name || s.id]));
  const nameOf = (id: string) => names.get(id);
  // 账号与账单待办在本站内跳转（不整页刷新），按钮名就是要做的动作
  const open = (a: any, primary = true) =>
    btn(a.label, () => router.push(a.href), { primary, aria: `${a.label}（${workflowOwner(a, nameOf)}）` });
  // 合并进同一行的其余事项：账号待办可以直接点开
  const noteOf = (a: any): ReactNode => {
    if (!a.others?.length) return undefined;
    return (
      <>
        另有 {a.others.length} 项：
        {a.others.map((o: any, i: number) => (
          <Fragment key={o.id}>
            {i > 0 ? "、" : ""}
            {o.workflow ? (
              <Link href={o.href} className="jy-caption-link">
                {o.label}
              </Link>
            ) : (
              actionPhrase(o)
            )}
          </Fragment>
        ))}
      </>
    );
  };

  const shown = expanded ? actions.all : actions.visible;
  const items: AttentionItem[] = shown.map((a: any) => {
    if (a.workflow) {
      return {
        key: a.id,
        level: a.level,
        who: workflowOwner(a, nameOf),
        what: workflowProblem(a.kind),
        desc: workflowDetail(a),
        note: noteOf(a),
        actions: open(a),
      };
    }
    const s = a.station;
    const name = a.stationName;
    const rate = rateOf(s);
    const bal = Number(s.balance?.remaining) || 0;
    const burn = Number(s.prediction?.burnPerDay) || 0;
    const eta = s.prediction?.etaDays;
    const sync = btn("立即同步", () => onSync(s), { loading: syncingId === s.id, primary: true, aria: `立即同步 ${name}` });
    const edit = (primary = false) => btn("编辑", () => onEdit(s), { primary, aria: `编辑 ${name}` });
    const trend = btn("查看趋势", () => onTrend(s), { primary: true, aria: `查看 ${name} 的余额趋势` });
    let what: ReactNode;
    let desc: ReactNode;
    let buttons: ReactNode;
    switch (a.kind) {
      case "query-failed": {
        const issue = describeConnectionFailure(s.balance?.error, s);
        what = "余额查询失败";
        desc = `${issue.message}，最近查询 ${relTime(s.balance?.checkedAt)}。`;
        buttons = (
          <>
            {sync}
            {edit()}
          </>
        );
        break;
      }
      case "balance-danger":
      case "balance-low": {
        const low = a.kind === "balance-low";
        what = low ? "余额低于提醒线" : "余额已用完";
        const parts = [`当前余额 ${balanceWithCny(s, bal)}`];
        if (low) parts.push(`提醒线 ${balanceText(s, threshold(s, settings))}`);
        if (low && eta != null && burn > 0) parts.push(`预计 ${formatDays(eta)}后用完`);
        desc = `${parts.join("，")}。`;
        buttons = (
          <>
            {trend}
            {edit()}
          </>
        );
        break;
      }
      case "eta-soon": {
        what = `预计 ${formatDays(a.etaDays)}后用完`;
        const basis = s.prediction?.basis ? `（${s.prediction.basis}）` : "";
        desc = `当前余额 ${balanceWithCny(s, bal)}，日均消耗 ${formatMoney(burn * rate)}${basis}。`;
        buttons = (
          <>
            {trend}
            {edit()}
          </>
        );
        break;
      }
      default: {
        what = `${a.daysRemaining} 天后到期`;
        desc = `最近一笔付费在 ${formatMonthDay(a.endAt)} ${formatHhmm(a.endAt)} 到期。续费请追加付费记录；不再续费可在编辑里标记。`;
        buttons = edit(true);
      }
    }
    return { key: a.id, level: a.level, who: name, what, desc, note: noteOf(a), actions: buttons };
  });

  const hidden = actions.all.length - actions.visible.length;
  // 每个资源最多一行待处理，剩下的就是状态正常的，用一句话交代其余资源
  const busy = attentionStationIds(actions.all);
  const healthy = stations.filter((s) => s && !s.isOwn && !busy.has(String(s.id || s.name))).length;
  const healthyNote = healthy > 0 ? <span className="jy-caption">其余 {healthy} 个上游资源状态正常</span> : null;
  return (
    <Panel title="需要处理" badge={<CountBadge count={actions.all.length} />} extra={extra} body={false}>
      {workflowError ? (
        <div className="jy-banner jy-ov-banner" role="status">
          <Sym kind="warn" />
          <span className="jy-ov-banner-text">{workflowError}</span>
          <Button size="small" onClick={onReloadWorkflow}>
            重读处理事项
          </Button>
        </div>
      ) : null}
      <AttentionList
        items={items}
        emptyDesc="上游资源余额充足、查询正常，近期没有到期的固定成本，账号与账单也没有待办。"
        more={
          hidden > 0 ? (
            <>
              <button type="button" className="jy-attention-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                {expanded ? "收起" : `展开其余 ${hidden} 项`}
              </button>
              {expanded ? healthyNote : null}
            </>
          ) : (
            healthyNote ?? undefined
          )
        }
      />
    </Panel>
  );
}

// ---- 上游余量 ---------------------------------------------------------------

function RunwayPanel({
  stations,
  error,
  settings,
  critDays,
  onRetry,
  onTrend,
}: {
  stations: any[] | null;
  error: string | null;
  settings: any;
  critDays: number;
  onRetry: () => void;
  onTrend: (s: any) => void;
}) {
  const router = useRouter();
  const allLink = (
    <Link className="jy-caption-link" href="/stations">
      全部上游资源
    </Link>
  );
  const rows = useMemo(() => {
    const list = (stations || []).filter((s) => !s.isOwn && s.type !== "fixed" && !s.archivedAt);
    return list.map((s) => {
      const st = statusOf(s, settings);
      const failed = st === "error";
      const rate = rateOf(s);
      const p = s.prediction;
      const bal = s.balance?.ok ? Number(s.balance.remaining) : null;
      let days: number | null = null;
      let daysLabel: string | undefined;
      if (p && Number(p.burnPerDay) === 0) {
        days = RUNWAY_MAX_DAYS;
        daysLabel = "近期无消耗";
      } else if (p?.etaDays != null) {
        days = Math.max(0, Number(p.etaDays));
      } else {
        daysLabel = st === "pending" ? "等待查询" : "数据积累中";
      }

      let level: Level = st === "danger" ? "crit" : st === "warn" ? "warn" : "good";
      if (days != null && !daysLabel) {
        if (days <= critDays) level = "crit";
        else if (days <= RUNWAY_WARN_DAYS && level === "good") level = "warn";
      }
      if (failed) level = "crit";
      else if (st === "pending" || (days == null && level === "good")) level = "muted";

      let tip: TipRow[];
      if (failed) {
        const issue = describeConnectionFailure(s.balance?.error, s);
        tip = [
          ["状态", "查询失败"],
          ["原因", issue.message],
          ["最近查询", relTime(s.balance?.checkedAt)],
        ];
      } else {
        tip = [
          ["余额", bal == null ? "尚未查询" : balanceWithCny(s, bal)],
          ["日均消耗", p?.burnPerDay != null ? formatMoney(Number(p.burnPerDay) * rate) : "—"],
          ["可用", daysLabel ?? formatDays(days)],
        ];
        if (p?.basis) tip.push(["依据", p.basis]);
      }
      if (s.noRenewal) tip.push(["续费", "已标记不再续费"]);

      const sub = bal == null ? "尚未查询" : `${balanceText(s, bal)}${s.noRenewal ? "，不再续费" : ""}`;
      const item: RunwayItem = {
        key: String(s.id),
        name: (
          <button type="button" className="jy-ov-name" onClick={() => onTrend(s)} aria-label={`${s.name}，查看余额趋势`}>
            {s.name}
          </button>
        ),
        tipTitle: s.name,
        sub,
        days,
        failed,
        level,
        daysLabel,
        tip,
      };
      return { item, cny: bal == null || failed ? null : bal * rate };
    });
  }, [stations, settings, critDays, onTrend]);

  if (!stations) {
    if (error) {
      return (
        <Panel title="上游余量" extra={allLink}>
          <ErrorState title="上游资源加载失败" error={error} onRetry={onRetry} />
        </Panel>
      );
    }
    return <PanelSkeleton title="上游余量" lines={5} />;
  }
  if (!rows.length) {
    return (
      <Panel title="上游余量" extra={allLink}>
        <EmptyState
          title="还没有按余额计费的上游资源"
          desc="添加上游资源后，这里会显示每个上游还能用多少天。"
          action={
            <Button size="small" onClick={() => router.push("/stations")}>
              添加上游资源
            </Button>
          }
        />
      </Panel>
    );
  }

  const sorted = [...rows].sort(
    (a, b) =>
      LEVEL_ORDER[a.item.level] - LEVEL_ORDER[b.item.level] ||
      Number(!!b.item.failed) - Number(!!a.item.failed) ||
      (a.item.days ?? Infinity) - (b.item.days ?? Infinity),
  );
  const shown = sorted.slice(0, RUNWAY_LIMIT);
  const failedN = rows.filter((r) => r.item.failed).length;
  const total = sum(rows.map((r) => r.cny ?? 0));
  const sub = (
    <>
      可用余额合计 <b className="jy-num">{formatMoney(total)}</b>
      {failedN > 0 && <span className="jy-caption">，不含 {failedN} 个查询失败的上游</span>}
    </>
  );
  const foot = (
    <>
      竖线为告警阈值：少于 {critDays} 天为紧急，少于 {RUNWAY_WARN_DAYS} 天为注意。
      {rows.length > RUNWAY_LIMIT && `这里只列最紧急的 ${RUNWAY_LIMIT} 个。`}
      紧急阈值可在
      <Link href="/notifications" className="jy-link">
        告警中心
      </Link>
      修改。
    </>
  );
  return (
    <Panel title="上游余量" extra={allLink} sub={sub} foot={foot} body={false}>
      <Runway items={shown.map((r) => r.item)} critDays={critDays} warnDays={RUNWAY_WARN_DAYS} maxDays={RUNWAY_MAX_DAYS} />
    </Panel>
  );
}

// ---- 收入 / 用量成本排行 ------------------------------------------------------

function MoneyPanelShell({
  title,
  caption,
  money,
  error,
  onRetry,
  children,
  foot,
}: {
  title: string;
  caption: string;
  money: Money | null;
  error: string | null;
  onRetry: () => void;
  children?: ReactNode;
  foot?: ReactNode;
}) {
  if (!money) {
    if (error) {
      return (
        <Panel title={title} caption={caption}>
          <ErrorState title="数据加载失败" error={error} onRetry={onRetry} />
        </Panel>
      );
    }
    return <PanelSkeleton title={title} lines={5} />;
  }
  return (
    <Panel title={title} caption={caption} foot={foot}>
      {children}
    </Panel>
  );
}

function RevenuePanel({ title, money, error, onRetry }: { title: string; money: Money | null; error: string | null; onRetry: () => void }) {
  const router = useRouter();
  const content = useMemo(() => {
    if (!money) return null;
    if (money.unconfigured) {
      return (
        <div className="jy-empty-inline">
          <p style={{ margin: 0 }}>还没有设置自营站点，暂时无法统计收入。</p>
          <Button size="small" onClick={() => router.push("/my")}>
            设置自营站点
          </Button>
        </div>
      );
    }
    const own = money.own || {};
    const profit = own.profit || {};
    const ownRate = Number(own.station?.cnyPerUsd) > 0 ? Number(own.station.cnyPerUsd) : 1;
    const users = (own.byUser || [])
      .filter((u: any) => !u.isAdmin)
      .map((u: any) => ({ name: String(u.user || "未命名用户"), value: r2((Number(u.cost) || 0) * ownRate), requests: u.requests }))
      .filter((u: any) => u.value > 0)
      .sort((a: any, b: any) => b.value - a.value);
    const items: HBarItem[] = users.slice(0, TOP_USERS).map((u: any) => ({
      key: `u-${u.name}`,
      name: u.name,
      value: u.value,
      tipExtra: u.requests != null ? [["请求数", Number(u.requests).toLocaleString("en-US")]] : undefined,
    }));
    const rest = users.slice(TOP_USERS);
    if (rest.length) items.push({ key: "rest", name: `其他 ${rest.length} 位用户`, value: r2(sum(rest.map((u: any) => u.value))) });
    if (Number(profit.resoldCny) > 0) items.push({ key: "resold", name: "转售的管理员 Key", value: Number(profit.resoldCny) });
    const income = profit.incomeCny ?? r2(sum(items.map((i) => i.value ?? 0)));
    return (
      <HBars
        items={items}
        color="var(--jy-s1)"
        unitName="收入"
        empty="这段时间还没有下游用户产生收入。"
        total={items.length ? { label: "合计", value: formatMoney(income, { approx: !(Number(own.station?.cnyPerUsd) > 0) }) } : undefined}
      />
    );
  }, [money, router]);
  return (
    <MoneyPanelShell title={title} caption="按下游用户" money={money} error={error} onRetry={onRetry}>
      {content}
    </MoneyPanelShell>
  );
}

function CostPanel({ title, money, error, onRetry }: { title: string; money: Money | null; error: string | null; onRetry: () => void }) {
  const view = useMemo(() => {
    if (!money) return null;
    if (money.unconfigured) {
      const fb = money.fallback || {};
      const gaps = new Map<string, number>(
        (fb.coverage?.stationGaps || [])
          .filter((g: any) => Number(g.missingDays) > 0)
          .map((g: any) => [g.stationId, Number(g.missingDays)]),
      );
      const list = (fb.stations || []).filter(
        (s: any) => s.includeInProfit && !s.isOwn && !(s.fixedCny > 0) && (s.totalCny > 0 || gaps.has(s.id)),
      );
      const items: HBarItem[] = list
        .map((s: any) => ({
          key: String(s.id),
          name: s.name,
          value: Number(s.totalCny) || 0,
          tipExtra: gaps.has(s.id) ? [["缺数", `${gaps.get(s.id)} 天没有记录`]] : undefined,
        }))
        .sort((a: HBarItem, b: HBarItem) => (b.value ?? 0) - (a.value ?? 0));
      const approx = list.some((s: any) => gaps.has(s.id));
      return { items, total: sum(items.map((i) => i.value ?? 0)), approx, notes: [] as string[] };
    }
    const profit = money.own?.profit || {};
    if (profit.error) return { items: [], total: null, approx: false, notes: [] as string[], error: profit.error };
    const items: HBarItem[] = (profit.costs || [])
      .filter((c: any) => c.mode !== "fixed")
      .map((c: any) => ({
        key: String(c.stationId),
        name: c.name,
        value: Number(c.cny) || 0,
        tipExtra: c.note ? [["口径", c.note]] : c.mode === "history" ? [["口径", "按余额变化推算"]] : undefined,
      }))
      .sort((a: HBarItem, b: HBarItem) => (b.value ?? 0) - (a.value ?? 0));
    const notes = ((profit.warnings || []) as string[])
      .filter((w) => !/推算|汇率/.test(w))
      .map((w) => (/[。！？]$/.test(w) ? w : `${w}。`));
    return { items, total: sum(items.map((i) => i.value ?? 0)), approx: !!profit.estimated, notes };
  }, [money]);

  return (
    <MoneyPanelShell
      title={title}
      caption="按上游资源"
      money={money}
      error={error}
      onRetry={onRetry}
      foot={view?.notes?.length ? view.notes.join("") : undefined}
    >
      {view?.error ? (
        <ErrorState title="成本暂时算不出来" error={view.error} />
      ) : view ? (
        <HBars
          items={view.items}
          color="var(--jy-s2)"
          unitName="用量成本"
          empty="这段时间上游资源没有产生用量成本。"
          total={view.items.length ? { label: "合计", value: formatMoney(view.total, { approx: view.approx }) } : undefined}
        />
      ) : null}
    </MoneyPanelShell>
  );
}
