"use client";
// 运营总览只留三样：今天赚了多少、需处理、快用完的前 3 个上游。
// 赚了多少只取「每日利润」那一个数（/api/reconciliation/profit 的今天），不在这里另算；
// 需处理、快用完来自 /api/stations：需处理和侧栏的计数共用 buildOverviewActions，快用完的档位和上游列表共用 balanceViewOf。
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Grid } from "antd";
import { api } from "../../lib/client";
import { STATION_TABS } from "../../lib/brand";
import type { ProfitPageResponse, WorkflowAction } from "../../lib/client";
import { attentionStationIds, balanceDaysText, balanceViewOf, buildOverviewActions, burnCellText, burnText, etaWindowDays, isSpending, lowLineOf, stationDisplayName } from "../../lib/overview-actions";
import { balanceMoneyOf } from "../../lib/profit";
import { workflowActionMeta } from "../../lib/workflow-actions";
import { asSentence, errorText, failureText, refreshAllText, refreshOneText } from "../../lib/error-copy";
import { BALANCE_STATE_TEXT, basisText, EMPTY, formatAsOf, formatDays, formatZonedDate, refreshFailedText, soonText } from "../../lib/format";
import { DEFAULT_BUSINESS_TIME_ZONE } from "../../lib/business-time";
import { UPSTREAM_FORM_TEXT } from "../../lib/channel-onboarding";
import { AttentionList } from "../components/attention-list";
import { Sym } from "../components/icons";
import { RecheckConsumeLogButton } from "../components/recheck-consume-log";
import { More } from "../components/more";
import type { AttentionItem } from "../components/attention-list";
import { EmptyState, ErrorState, PanelSkeleton } from "../components/data-state";
import type { TipRow } from "../components/float-tip";
import { CountBadge, Panel } from "../components/panel";
import { compareRunwayItems, Runway, RUNWAY_TEXT } from "../components/runway";
import type { RunwayItem } from "../components/runway";
import { useShellPage } from "../components/shell-context";
import { useWorkflowActions } from "../components/use-workflow-actions";
import { actionPhrase, workflowDetail, workflowOwner, workflowProblem } from "../components/workflow-copy";
import { fmtMoney, metrics, pageMoney } from "./reconciliation/profit-format";
import type { Ctx } from "./reconciliation/profit-format";
import TrendModal, { TREND_TEXT } from "./trend-modal";
import "../styles/pages/overview.css";

const RUNWAY_LIMIT = 3;
// 需处理露几条：其余收进「还有 N 件」
const ATTENTION_SHOWN = 3;
const REFRESH = workflowActionMeta("refresh")!.label;

// 运营总览独有的话，只在这一处写；用语按 design/ui-copy-spec.md
const COPY = Object.freeze({
  profitTitle: "今天赚了多少",
  profitUnread: "读不到每日利润",
  equation: (income: string, cost: string) => `收入 ${income} − 上游成本 ${cost}`,
  profitLink: "每日利润",
  readFailed: (what: string) => `读不到${what}`,
  workflowUnreadable: "读不到上游账单和每日利润里需处理的事。",
  attention: "需处理",
  attentionOrder: "最要紧的在前",
  refreshAttention: `${REFRESH}需处理的事`,
  refreshOne: (name: string) => `${REFRESH} ${name}`,
  refreshFailed: `${REFRESH}失败`,
  edit: "编辑",
  editOne: (name: string) => `编辑 ${name}`,
  trend: TREND_TEXT.title,
  trendOf: TREND_TEXT.of,
  others: (n: number) => `另有 ${n} 项：`,
  moreItems: (n: number) => `还有 ${n} 件`,
  healthy: (n: number) => `其余 ${n} 个上游没有要处理的事`,
  balance: (text: string) => `余额 ${text}`,
  lowLine: (text: string) => `余额提醒线 ${text}`,
  available: (days: string) => `可用${days}`,
  burnSentence: (balance: string, burn: string, basis: string) => `余额 ${balance}，日均花费 ${burn}，${basis}。`,
  expiresIn: (n: number) => `${n} 天后到期`,
  fixedSentence: (date: string) => `最近一笔 ${date}到期。要续上，再记一笔固定成本；不再续费可以在编辑里标记。`,
  runway: "快用完的上游",
  runwayAllGood: "上游余额都够用",
  runwayEmptyTitle: "还没有按余额计费的上游",
  runwayEmptyDesc: "加上上游后，这里显示最快用完的几个。",
  noRenewal: "不再续费",
  tip: Object.freeze({ ...RUNWAY_TEXT.tip, requests: "请求数", how: "怎么算的", note: "说明" }),
});

// 余额的写法和上游列表同一处（balanceMoneyOf）：设了汇率写「$12.30（约 ¥88.56）」，没设按 1:1 写「¥12.30（没设置汇率）」
const balanceText = (s: any, v: number) => balanceMoneyOf(s, v).text;
const balanceWithCny = (s: any, v: number) => balanceMoneyOf(s, v).full;

export default function OverviewPage() {
  // 手机上需处理放在最前：按 DOM 先后排，读屏和键盘也先到需处理
  const compact = Grid.useBreakpoint().md === false;
  const { message } = App.useApp();
  const router = useRouter();

  const [rules, setRules] = useState<any>({});
  const [settings, setSettings] = useState<any>({ refreshIntervalSec: 60, lowBalanceUsd: 5 });
  const [stations, setStations] = useState<any[] | null>(null);
  const [stationsErr, setStationsErr] = useState<Error | null>(null);
  const [stationsAt, setStationsAt] = useState<number | null>(null);
  const [stationsTz, setStationsTz] = useState<string | null>(null);
  const [profit, setProfit] = useState<ProfitPageResponse | null>(null);
  const [profitErr, setProfitErr] = useState<Error | null>(null);
  const [profitAt, setProfitAt] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [trendStation, setTrendStation] = useState<any>(null);
  // 上游账单与每日利润产生的需处理事项：与侧栏计数、上游资源页共用一份
  const { actions: workflowActions, failed: workflowFailed, staleAsOf: workflowAsOf, loading: workflowLoading, reload: reloadWorkflowActions } = useWorkflowActions();

  // 两个加载函数都返回报错（成功返回 null），顶栏刷新据此提示
  const loadStations = useCallback(async (): Promise<Error | null> => {
    try {
      const r = await api("/api/stations");
      setStations(Array.isArray(r?.stations) ? r.stations : []);
      if (r?.settings) setSettings(r.settings);
      if (r?.tz) setStationsTz(r.tz);
      setStationsErr(null);
      setStationsAt(Date.now());
      return null;
    } catch (e: any) {
      setStationsErr(e);
      return e;
    }
  }, []);

  // 今天赚了多少：每日利润页同一个接口、同一个数
  const loadProfit = useCallback(async (): Promise<Error | null> => {
    try {
      const r = (await api("/api/reconciliation/profit", { method: "POST", body: { preset: "today" } })) as ProfitPageResponse;
      setProfit(r);
      setProfitErr(null);
      setProfitAt(Date.now());
      return null;
    } catch (e: any) {
      setProfitErr(e);
      return e;
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

  // 按系统设置的刷新间隔轮询（最短 30 秒）；标签页在后台时不拉，切回来立即拉一次
  const intervalSec = Math.max(30, Number(settings?.refreshIntervalSec) || 60);
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      loadStations();
      loadProfit();
    };
    loadStations();
    loadProfit();
    const timer = setInterval(tick, intervalSec * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalSec, loadStations, loadProfit]);

  // 刷新全部上游后重新加载本页；重新加载失败时抛错由顶栏提示，有上游读不到余额时如实说明
  const onRefresh = async () => {
    const r = await api("/api/refresh", { method: "POST", body: {} });
    const [stationsLoadErr, profitLoadErr] = await Promise.all([loadStations(), loadProfit(), reloadWorkflowActions()]);
    const err = stationsLoadErr || profitLoadErr;
    if (err) throw err;
    const done = refreshAllText(r?.stations);
    if (done.failed) message.warning(done.text);
    else message.success(done.text);
  };

  const refreshOne = async (s: any) => {
    setSyncingId(s.id);
    try {
      const r = await api(`/api/stations/${s.id}/refresh`, { method: "POST", body: {} });
      await loadStations();
      const done = refreshOneText(stationDisplayName(s), r?.balance);
      if (done.ok) message.success(done.text);
      else message.warning(done.text);
    } catch (e: any) {
      message.error(failureText(COPY.refreshFailed, e));
    } finally {
      setSyncingId(null);
    }
  };

  const asOfs = [stationsAt, profitAt].filter((t): t is number => t != null);
  useShellPage({
    onRefresh,
    asOf: asOfs.length ? Math.min(...asOfs) : null,
    tz: profit?.tz || stationsTz || undefined,
  });

  const businessTz = profit?.tz || stationsTz || DEFAULT_BUSINESS_TIME_ZONE;
  const workflowError = !workflowFailed
    ? ""
    : workflowAsOf
      ? refreshFailedText(workflowAsOf, businessTz)
      : COPY.workflowUnreadable;

  const attention = (
    <AttentionPanel
      stations={stations}
      error={stationsErr}
      rules={rules}
      settings={settings}
      workflowActions={workflowActions}
      workflowError={workflowError}
      workflowLoading={workflowLoading}
      onReloadWorkflow={() => void reloadWorkflowActions()}
      tz={businessTz}
      asOf={stationsAt}
      syncingId={syncingId}
      onRetry={loadStations}
      onSync={refreshOne}
      onEdit={(s) => router.push(`/stations?edit=${encodeURIComponent(s.id)}`)}
      onTrend={setTrendStation}
    />
  );

  return (
    <div className="jy-page jy-ov">
      {/* 手机上需处理在最前 */}
      {compact ? attention : null}
      <div className="jy-grid-8-4">
        <ProfitToday profit={profit} error={profitErr} onRetry={() => void loadProfit()} />
        {compact ? null : attention}
      </div>
      <RunwayPanel
        stations={stations}
        error={stationsErr}
        settings={settings}
        rules={rules}
        onRetry={loadStations}
        onTrend={setTrendStation}
      />
      <TrendModal station={trendStation} onClose={() => setTrendStation(null)} settings={settings} rules={rules} tz={businessTz} />
    </div>
  );
}

// ---- 今天赚了多少（取每日利润的数）---------------------------------------------

function ProfitToday({ profit, error, onRetry }: { profit: ProfitPageResponse | null; error: Error | null; onRetry: () => void }) {
  const link = (
    <Link className="jy-caption-link" href="/reconciliation">
      {COPY.profitLink}
    </Link>
  );
  if (!profit) {
    if (error) {
      return (
        <Panel title={COPY.profitTitle} extra={link}>
          <ErrorState what={COPY.profitUnread} error={error} onRetry={onRetry} />
        </Panel>
      );
    }
    return <PanelSkeleton title={COPY.profitTitle} lines={3} />;
  }
  // 和每日利润「今天」视图第一格同一份数、同一个函数（metrics）；总览上的字叫「上游成本」，不叫「实付成本」
  const currency = profit.displayCurrency === "CNY" ? "CNY" : "USD";
  const ctx = { currency, tz: profit.tz, zoneOf: () => profit.tz } as Ctx;
  const money = pageMoney(profit, currency);
  const gross = metrics(profit, ctx)[0];
  const lines = [...gross.lines];
  lines[0] = COPY.equation(fmtMoney(money.income, currency), fmtMoney(money.actual, currency));
  return (
    <Panel title={COPY.profitTitle} extra={link}>
      <p className="jy-ov-hero jy-num" aria-live="polite">{gross.value}</p>
      {lines.map((line, index) => <p key={index} className="jy-caption">{line}</p>)}
    </Panel>
  );
}

// ---- 需处理 -----------------------------------------------------------------

function AttentionPanel({
  stations,
  error,
  rules,
  settings,
  workflowActions,
  workflowError,
  workflowLoading,
  onReloadWorkflow,
  tz,
  asOf,
  syncingId,
  onRetry,
  onSync,
  onEdit,
  onTrend,
}: {
  stations: any[] | null;
  error: Error | null;
  rules: any;
  settings: any;
  workflowActions: WorkflowAction[];
  workflowError: string;
  workflowLoading: boolean;
  onReloadWorkflow: () => void;
  tz: string;
  asOf: number | null;
  syncingId: string | null;
  onRetry: () => void;
  onSync: (s: any) => void;
  onEdit: (s: any) => void;
  onTrend: (s: any) => void;
}) {
  const actions = useMemo(
    () =>
      buildOverviewActions(stations || [], {
        tz,
        rules,
        settings,
        workflowActions,
        limit: ATTENTION_SHOWN,
      }),
    [stations, tz, rules, settings, workflowActions],
  );
  const router = useRouter();
  const extra = (
    <>
      <span className="jy-caption">{COPY.attentionOrder}</span>
      <Button size="small" loading={workflowLoading} onClick={onReloadWorkflow} aria-label={COPY.refreshAttention}>
        {REFRESH}
      </Button>
    </>
  );
  if (!stations) {
    if (error) {
      return (
        <Panel title={COPY.attention}>
          <ErrorState what={COPY.readFailed(STATION_TABS.list)} error={error} onRetry={onRetry} />
        </Panel>
      );
    }
    return <PanelSkeleton title={COPY.attention} lines={4} />;
  }

  // 每条的第一个操作是带边框的按钮，其余是链接样式（与设计稿一致）
  const btn = (label: string, onClick: () => void, extra: { loading?: boolean; primary?: boolean; aria: string }) => (
    <Button size="small" type={extra.primary ? "default" : "link"} loading={extra.loading} onClick={onClick} aria-label={extra.aria}>
      {label}
    </Button>
  );
  const names = new Map(stations.filter(Boolean).map((s) => [String(s.id), stationDisplayName(s)]));
  const nameOf = (id: string) => names.get(id);
  // 账号与账单待办是真实链接（可复制、可在新标签打开），普通点击在本站内跳转（不整页刷新），按钮名就是要做的动作
  const open = (a: any, primary = true) => a.kind === "recheck_consume_log" ? (
    // 自营站点不记收费记录：点了才马上再读一次站点的设置（转圈、就地提示），不是跳转
    <RecheckConsumeLogButton type={primary ? "default" : "link"} aria-label={`${a.label}（${workflowOwner(a, nameOf)}）`} />
  ) : (
    <Button
      size="small"
      type={primary ? "default" : "link"}
      href={a.href}
      aria-label={`${a.label}（${workflowOwner(a, nameOf)}）`}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        router.push(a.href);
      }}
    >
      {a.label}
    </Button>
  );
  // 合并进同一行的其余事项：账号待办可以直接点开
  const noteOf = (a: any): ReactNode => {
    if (!a.others?.length) return undefined;
    return (
      <>
        {COPY.others(a.others.length)}
        {a.others.map((o: any, i: number) => (
          <Fragment key={o.id}>
            {i > 0 ? "、" : ""}
            {o.workflow ? (
              <Link href={o.href} className="jy-caption-link">
                {actionPhrase(o)}
              </Link>
            ) : (
              actionPhrase(o)
            )}
          </Fragment>
        ))}
      </>
    );
  };

  // 一条事项变成列表里的一行；收进「还有 N 件」的那些只在点开时才拼（RestAttention），需处理上百条时不白做
  const toItem = (a: any): AttentionItem => {
    if (a.workflow) {
      return {
        key: a.id,
        level: a.level,
        who: workflowOwner(a, nameOf),
        what: workflowProblem(a),
        desc: workflowDetail(a),
        note: noteOf(a),
        actions: open(a),
      };
    }
    const s = a.station;
    const name = a.stationName;
    const bal = Number(s.balance?.remaining) || 0;
    const eta = s.prediction?.etaDays;
    const sync = btn(REFRESH, () => onSync(s), { loading: syncingId === s.id, primary: true, aria: COPY.refreshOne(name) });
    const edit = (primary = false) => btn(COPY.edit, () => onEdit(s), { primary, aria: COPY.editOne(name) });
    const trend = btn(COPY.trend, () => onTrend(s), { primary: true, aria: COPY.trendOf(name) });
    let what: ReactNode;
    let desc: ReactNode;
    let buttons: ReactNode;
    switch (a.kind) {
      case "query-failed": {
        what = BALANCE_STATE_TEXT.unreadable;
        desc = asSentence(errorText(s.balance));
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
        what = low ? BALANCE_STATE_TEXT.low : BALANCE_STATE_TEXT.empty;
        const parts = [COPY.balance(balanceWithCny(s, bal))];
        if (low) parts.push(COPY.lowLine(balanceText(s, lowLineOf(s, settings))));
        if (low && eta != null && isSpending(s.prediction)) parts.push(COPY.available(formatDays(eta)));
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
        what = soonText(a.etaDays);
        desc = COPY.burnSentence(balanceWithCny(s, bal), burnText(s, s.prediction) ?? EMPTY, basisText(s.prediction?.basis));
        buttons = (
          <>
            {trend}
            {edit()}
          </>
        );
        break;
      }
      default: {
        what = COPY.expiresIn(a.daysRemaining);
        desc = COPY.fixedSentence(formatZonedDate(a.endAt, tz));
        buttons = edit(true);
      }
    }
    return { key: a.id, level: a.level, who: name, what, desc, note: noteOf(a), actions: buttons };
  };

  const hidden = actions.all.length - actions.visible.length;
  // 每个资源最多一行待处理，剩下的就是状态正常的，用一句话交代其余资源
  const busy = attentionStationIds(actions.all);
  const healthy = stations.filter((s) => s && !s.isOwn && !busy.has(String(s.id || stationDisplayName(s)))).length;
  const healthyNote = healthy > 0 ? <span className="jy-caption">{COPY.healthy(healthy)}</span> : null;
  return (
    <Panel title={COPY.attention} badge={<CountBadge count={actions.all.length} />} extra={extra} body={false}>
      {workflowError ? (
        <div className="jy-banner jy-ov-banner" role="status">
          <Sym kind="warn" />
          <span className="jy-ov-banner-text">{workflowError}</span>
          <Button size="small" onClick={onReloadWorkflow}>
            {REFRESH}
          </Button>
        </div>
      ) : null}
      {/* 露最要紧的几条（按等式那块的高度定，现在 2 条），其余收进「还有 N 件」（收起区 More，ui-design-spec §4.11、§5.1），点开在原地接着列 */}
      <AttentionList
        items={actions.visible.map(toItem)}
        emptyDesc={asOf ? `${formatAsOf(asOf, tz)}。` : undefined}
        more={
          hidden > 0 ? (
            <More label={COPY.moreItems(hidden)} className="jy-attention-rest">
              <RestAttention actions={actions.all.slice(actions.visible.length)} toItem={toItem} more={healthyNote ?? undefined} />
            </More>
          ) : (
            healthyNote ?? undefined
          )
        }
      />
    </Panel>
  );
}

// 「还有 N 件」点开以后的那几条：收起区只在点开时渲染它，拼列表项的活也到这时才做
function RestAttention({ actions, toItem, more }: { actions: any[]; toItem: (a: any) => AttentionItem; more?: ReactNode }) {
  return <AttentionList items={actions.map(toItem)} more={more} />;
}

// ---- 上游余量 ---------------------------------------------------------------

function RunwayPanel({
  stations,
  error,
  settings,
  rules,
  onRetry,
  onTrend,
}: {
  stations: any[] | null;
  error: Error | null;
  settings: any;
  rules: any;
  onRetry: () => void;
  onTrend: (s: any) => void;
}) {
  const router = useRouter();
  const critDays = etaWindowDays(rules);
  const allLink = (
    <Link className="jy-caption-link" href="/stations">
      {STATION_TABS.list}
    </Link>
  );
  const rows = useMemo(() => {
    const list = (stations || []).filter((s) => !s.isOwn && s.type !== "fixed" && !s.archivedAt);
    return list.map((s) => {
      // 档位、颜色、可用天数和上游列表同一个判断（balanceViewOf）
      const view = balanceViewOf(s, { settings, rules });
      const failed = view.state === "unreadable";
          const p = s.prediction;
      const bal = s.balance?.ok ? Number(s.balance.remaining) : null;
      const name = stationDisplayName(s);
      const state = view.state ? BALANCE_STATE_TEXT[view.state] : undefined;

      let tip: TipRow[];
      if (failed) {
        tip = [[COPY.tip.reason, errorText(s.balance)]];
      } else {
        tip = [
          [COPY.tip.balance, bal == null ? BALANCE_STATE_TEXT.pending : balanceWithCny(s, bal)],
          [COPY.tip.burn, burnCellText(s, p)],
          [COPY.tip.days, balanceDaysText(view)],
        ];
        if (view.days != null && view.days !== Infinity && view.days > 0) tip.push([COPY.tip.basis, basisText(p?.basis)]);
      }
      if (s.noRenewal) tip.push([COPY.tip.renewal, COPY.noRenewal]);

      const item: RunwayItem = {
        key: String(s.id),
        name: (
          <button type="button" className="jy-ov-name" onClick={() => onTrend(s)} aria-label={COPY.trendOf(name)}>
            {name}
          </button>
        ),
        tipTitle: name,
        sub: bal == null ? undefined : `${balanceText(s, bal)}${s.noRenewal ? `，${COPY.noRenewal}` : ""}`,
        days: view.days,
        failed,
        level: view.level,
        state,
        // 余额用完时天数写「—」，只看档位名（和上游列表、余额趋势同一个写法）
        daysLabel: balanceDaysText(view),
        tip,
      };
      return { item };
    });
  }, [stations, settings, rules, onTrend]);

  if (!stations) {
    if (error) {
      return (
        <Panel title={COPY.runway} extra={allLink}>
          <ErrorState what={COPY.readFailed(STATION_TABS.list)} error={error} onRetry={onRetry} />
        </Panel>
      );
    }
    return <PanelSkeleton title={COPY.runway} lines={5} />;
  }
  if (!rows.length) {
    return (
      <Panel title={COPY.runway} extra={allLink}>
        <EmptyState
          title={COPY.runwayEmptyTitle}
          desc={COPY.runwayEmptyDesc}
          action={
            <Button size="small" onClick={() => router.push("/stations?edit=new")}>
              {UPSTREAM_FORM_TEXT.create}
            </Button>
          }
        />
      </Panel>
    );
  }

  const sorted = [...rows].sort((a, b) => compareRunwayItems(a.item, b.item));
  // 只列快用完的（红、黄两档）里可用天数最少的 3 个；都够用就写一行
  const shown = sorted.filter((r) => r.item.level === "crit" || r.item.level === "warn").slice(0, RUNWAY_LIMIT);
  if (!shown.length) {
    return (
      <Panel title={COPY.runway} extra={allLink}>
        <p className="jy-caption">{COPY.runwayAllGood}</p>
      </Panel>
    );
  }
  return (
    <Panel title={COPY.runway} extra={allLink} body={false}>
      <Runway items={shown.map((r) => r.item)} critDays={critDays} />
    </Panel>
  );
}
