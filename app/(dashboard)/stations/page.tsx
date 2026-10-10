"use client";
// 上游资源：列表 + 编辑抽屉 + 单项刷新 / 重新测试 / 归档 / 恢复 / 彻底删除 + 余额趋势。
// 请求与旧版逐一对应（端点、方法、载荷不变）；页面标题、刷新按钮、数据截至时间交给外壳。
import "../../styles/pages/stations.css";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Dropdown, Grid, Input, Modal, Select } from "antd";
import type { MenuProps } from "antd";
import { api, cny, fmtTokens, statusOf } from "../../../lib/client";
import { actionsByStation, buildOverviewActions } from "../../../lib/overview-actions";
import { formatMoney, formatUsd } from "../../../lib/format";
import ChannelOnboarding from "../../components/channel-onboarding";
import { EmptyState, ErrorState, Skeleton } from "../../components/data-state";
import { Icon, Sym } from "../../components/icons";
import { Panel } from "../../components/panel";
import { RunwayTrack } from "../../components/runway";
import { Seg, TabPanel, Tabs } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { Spark } from "../../components/spark";
import { LEVEL_ORDER, StatusText } from "../../components/status";
import { useUrlParams, useUrlState } from "../../components/use-url-state";
import { useWorkflowActions } from "../../components/use-workflow-actions";
import TrendModal from "../trend-modal";
import {
  MAX_DAYS,
  WARN_DAYS,
  buildStationView,
  critDaysOf,
  fmtClock,
  relTime,
  resultIssue,
  syncTime,
} from "./model";
import type { StationCheck, StationView } from "./model";
import { useAccountCenter } from "./account-center";
import { StationDrawer } from "./station-drawer";
import type { StationDrawerHandle } from "./station-drawer";

const FILTERS = ["all", "attention", "ok", "archived"] as const;
type Filter = (typeof FILTERS)[number];
const SORTS = ["", "days", "-days"] as const;
// 资源列表、渠道接入、账号关系分成三个标签，避免一页从头滚到尾
const VIEWS = ["list", "onboarding", "accounts"] as const;
type View = (typeof VIEWS)[number];
const ONBOARDING_ACTIONS = ["connect", "coverage", "source"];
type Sort = (typeof SORTS)[number];
const COLS = 7;

// 与 buildOverviewActions 的 stationId 同一口径，保证“需处理”与总览的待办完全对得上
const actionKey = (s: any) => String(s.id || String(s?.name || "").trim() || "未命名资源");

function compareDays(a: number | null, b: number | null, dir: 1 | -1) {
  if (a === b) return 0;
  if (a == null) return 1; // 无法计算的永远排最后
  if (b == null) return -1;
  return dir * (a - b);
}

export default function StationsPage() {
  const { message } = App.useApp();
  const compact = Grid.useBreakpoint().md === false;

  const [stations, setStations] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({ refreshIntervalSec: 60, lowBalanceUsd: 5 });
  const [types, setTypes] = useState<any[]>([]);
  const [rules, setRules] = useState<any>({});
  const [loaded, setLoaded] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  // 每次读取资源后递增，账号关系随之重读
  const [accountsToken, setAccountsToken] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<Record<string, boolean>>({});
  const [retestingIds, setRetestingIds] = useState<Record<string, boolean>>({});
  const [restoringIds, setRestoringIds] = useState<Record<string, boolean>>({});
  // 列表内“重新测试连接”的结果只存在本地，不写库（同旧版）
  const [stationChecks, setStationChecks] = useState<Record<string, StationCheck>>({});
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const [trendStation, setTrendStation] = useState<any>(null);
  // 资源生命周期：默认归档保留历史；物理删除必须在独立危险流程中输入确认词
  const [archiveTarget, setArchiveTarget] = useState<any>(null);
  const [purgeTarget, setPurgeTarget] = useState<any>(null);
  const [purgeConfirm, setPurgeConfirm] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [purging, setPurging] = useState(false);

  // 搜索词写进地址栏（停止输入 300ms 后），刷新与分享链接时保持
  const [queryParam, setQueryParam] = useUrlState<string>("q", "");
  const [query, setQuery] = useState(queryParam);
  const [view, setView] = useUrlState<View>("view", "list", VIEWS);
  const [filter, setFilter] = useUrlState<Filter>("filter", "all", FILTERS);
  const [typeFilter, setTypeFilter] = useUrlState<string>("type", "");
  const [sort, setSort] = useUrlState<Sort>("sort", "", SORTS);
  const [params, setParams] = useUrlParams();
  const editParam = params.get("edit");

  useEffect(() => {
    if (query === queryParam) return;
    const t = setTimeout(() => setQueryParam(query.trim() ? query : ""), 300);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  // 浏览器前进后退改了地址栏时跟上
  useEffect(() => {
    setQuery((cur) => (cur.trim() === queryParam.trim() ? cur : queryParam));
  }, [queryParam]);

  const drawerRef = useRef<StationDrawerHandle>(null);
  // 更多菜单里的“编辑”：关闭抽屉后焦点回到这一行的更多按钮
  const moreTriggerRef = useRef<HTMLElement | null>(null);

  // 始终带上归档与暂停监控的资源：“已归档”只是一个筛选；暂停监控的资源在账号关系中管理
  const reload = useCallback(async () => {
    setLoadingList(true);
    try {
      const r = await api("/api/stations?includeUnmonitored=true&includeArchived=true");
      setStations(r.stations);
      setSettings(r.settings);
      setLoaded(true);
      setLoadError(null);
      setRefreshedAt(Date.now());
    } catch (e: any) {
      setLoadError(e.message || "上游资源加载失败");
      throw e;
    } finally {
      setLoadingList(false);
      setAccountsToken((n) => n + 1);
    }
  }, []);

  const loadMeta = useCallback(async () => {
    setLoadingMeta(true);
    try {
      const m = await api("/api/meta");
      setTypes(m.types);
      setRules(m.rules);
      setMetaError(null);
    } catch (e: any) {
      setMetaError(e.message || "资源配置加载失败");
      throw e;
    } finally {
      setLoadingMeta(false);
    }
  }, []);

  useEffect(() => {
    reload().catch(() => {});
    loadMeta().catch(() => {});
  }, [loadMeta, reload]);

  // 自动刷新跟随全局刷新间隔（下限 10 秒）；标签页在后台时跳过，回到前台的下一拍再拉
  useEffect(() => {
    const sec = Math.max(10, Number(settings.refreshIntervalSec) || 60);
    const t = setInterval(() => {
      if (document.hidden) return;
      reload().catch(() => {});
    }, sec * 1000);
    return () => clearInterval(t);
  }, [settings.refreshIntervalSec, reload]);

  // 外壳的刷新只重新读取；向上游同步余额是工具栏的“同步全部”
  useShellPage({
    onRefresh: () => Promise.all([reload(), metaError || !types.length ? loadMeta() : null]),
    asOf: refreshedAt,
  });

  const openEditor = (s: any | null, trigger?: HTMLElement | null) => drawerRef.current?.open(s, trigger);

  // /stations?edit=<id>：数据和类型都到齐后打开对应资源的抽屉，然后把参数从地址栏去掉；找不到就静默忽略
  useEffect(() => {
    if (!editParam || !loaded || loadingMeta) return;
    const target = stations.find((x) => String(x.id) === editParam);
    if (target) openEditor(target, null);
    setParams({ edit: null });
  }, [editParam, loaded, loadingMeta]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefreshAll = async () => {
    setRefreshingAll(true);
    try {
      await api("/api/refresh", { method: "POST", body: {} });
      // /api/refresh 只返回在监控的资源；重新读取完整列表，归档与暂停监控的资源一并保留
      await reload();
      message.success("已刷新全部");
    } catch {
      message.error("刷新失败");
    } finally {
      setRefreshingAll(false);
    }
  };

  const onRefreshOne = async (s: any) => {
    setRefreshingIds((m) => ({ ...m, [s.id]: true }));
    try {
      const r = await api(`/api/stations/${s.id}/refresh`, { method: "POST", body: {} });
      setStations((list) => list.map((x) => (x.id === s.id ? { ...x, ...(r.station || {}), balance: r.balance } : x)));
      setAccountsToken((n) => n + 1);
      if (!r.balance.ok) message.error(`${s.name}：${resultIssue(null, r.balance.error).message}`);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRefreshingIds((m) => ({ ...m, [s.id]: false }));
    }
  };

  const onRetest = async (station: any) => {
    setRetestingIds((ids) => ({ ...ids, [station.id]: true }));
    setStationChecks((checks) => {
      const { [station.id]: _ignored, ...rest } = checks;
      return rest;
    });
    try {
      // 只传资源 ID 与类型；测试接口从已保存资源的内存副本读取凭证，不写库、不刷新、不告警
      const result = await api("/api/stations/test", {
        body: { stationId: station.id, type: station.type },
      });
      if (!result.ok) {
        const issue = resultIssue(result, result.message);
        setStationChecks((checks) => ({ ...checks, [station.id]: { issue, checkedAt: new Date().toISOString() } }));
        return;
      }
      const checkedAt = new Date().toISOString();
      setStations((list) => list.map((item) => (item.id === station.id ? {
        ...item,
        balance: {
          ...(item.balance && item.balance.ok ? item.balance : {}),
          ok: true,
          checkedAt,
          latencyMs: result.latencyMs,
          account: result.account || null,
          remaining: result.remaining,
          currency: result.currency || null,
        },
      } : item)));
      message.success(`${station.name} 已验证连接，当前展示已更新`);
    } catch (e: any) {
      const issue = resultIssue(null, e.message || "请求失败");
      setStationChecks((checks) => ({ ...checks, [station.id]: { issue, checkedAt: new Date().toISOString() } }));
    } finally {
      setRetestingIds((ids) => ({ ...ids, [station.id]: false }));
    }
  };

  const onArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      const result = await api(`/api/stations/${archiveTarget.id}`, { method: "DELETE" });
      if (!result.ok) throw new Error(result.error || "资源不存在或已归档");
      message.success(`已归档「${archiveTarget.name}」，监测历史会继续保留用于分析`);
      setArchiveTarget(null);
      await reload();
    } catch (e: any) {
      message.error(e.message || "归档失败");
    } finally {
      setArchiving(false);
    }
  };

  const onPurge = async () => {
    if (!purgeTarget || purgeConfirm !== "DELETE") return;
    setPurging(true);
    try {
      const result = await api(`/api/stations/${purgeTarget.id}?purge=true`, { method: "DELETE", body: { confirm: "DELETE" } });
      if (!result.ok) throw new Error(result.error || "资源不存在或已删除");
      message.success(`已彻底删除「${purgeTarget.name}」及其监测历史`);
      setPurgeTarget(null);
      setPurgeConfirm("");
      await reload();
    } catch (e: any) {
      message.error(e.message || "彻底删除失败");
    } finally {
      setPurging(false);
    }
  };

  // 恢复：PUT archived=false，服务端恢复后会重新开始刷新
  const onRestore = async (s: any) => {
    setRestoringIds((m) => ({ ...m, [s.id]: true }));
    try {
      await api(`/api/stations/${s.id}`, { method: "PUT", body: { archived: false } });
      message.success(`已恢复「${s.name}」，正在查询余额…`);
      setTimeout(() => reload().catch(() => {}), 800);
      await reload();
    } catch (e: any) {
      message.error(e.message || "恢复失败");
    } finally {
      setRestoringIds((m) => ({ ...m, [s.id]: false }));
    }
  };

  const openPurge = (s: any) => {
    setPurgeTarget(s);
    setPurgeConfirm("");
  };

  // 新增后后台正在首查，稍后再拉一次拿到余额（同旧版）
  const onSaved = async () => {
    setTimeout(() => reload().catch(() => {}), 800);
    await reload();
  };

  // “需处理”直接复用总览的待办规则：同一批在用资源、同一份规则和阈值，账号与账单待办也算在内
  // 列表只放在监控的资源（归档的照常放在「已归档」里）；暂停监控的资源在「账号关系」标签中查看与重新启用
  const listed = useMemo(() => stations.filter((s) => s.monitorEnabled !== false || s.archivedAt), [stations]);
  const paused = stations.filter((s) => s.monitorEnabled === false && !s.archivedAt);
  const { actions: workflowActions } = useWorkflowActions();

  const { todosById, unowned } = useMemo(() => {
    const live = listed.filter((s) => !s.archivedAt);
    const all = buildOverviewActions(live, { rules, settings, statusOf, workflowActions }).all;
    const ids = new Set(live.map(actionKey));
    // 按账号或核算规则归类、不落在单个资源上的待办只在运营总览处理，这里交代条数
    return { todosById: actionsByStation(all), unowned: all.filter((a: any) => !a.stationId || !ids.has(String(a.stationId))).length };
  }, [listed, rules, settings, workflowActions]);

  const critDays = critDaysOf(rules);
  const views = useMemo(() => {
    const now = Date.now();
    return listed.map((s) => buildStationView(s, {
      settings,
      critDays,
      typeName: (t) => types.find((x) => x.value === t)?.label || t,
      check: stationChecks[s.id],
      attention: !s.archivedAt && todosById.has(actionKey(s)),
      now,
    }));
  }, [listed, settings, critDays, types, stationChecks, todosById]);

  const live = views.filter((v) => !v.archived);
  const archived = views.filter((v) => v.archived);
  // 「需处理」与「无需处理」互补，两者相加等于「全部」
  const needsWork = (v: StationView) => v.attention || v.level === "crit" || v.level === "warn";
  const counts: Record<Filter, number> = {
    all: live.length,
    attention: live.filter(needsWork).length,
    ok: live.filter((v) => !needsWork(v)).length,
    archived: archived.length,
  };

  const q = query.trim().toLowerCase();
  const byStatus = filter === "archived" ? archived : filter === "attention" ? live.filter(needsWork) : filter === "ok" ? live.filter((v) => !needsWork(v)) : live;
  const rows = byStatus
    .filter((v) => !typeFilter || v.s.type === typeFilter)
    .filter((v) => !q || [v.s.name, v.s.baseUrl, v.host, v.s.balance?.account].some((x) => String(x || "").toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sort === "days") return compareDays(a.sortDays, b.sortDays, 1) || String(a.s.name).localeCompare(String(b.s.name), "zh-CN");
      if (sort === "-days") return compareDays(a.sortDays, b.sortDays, -1) || String(a.s.name).localeCompare(String(b.s.name), "zh-CN");
      // 默认：最严重的在前，同级按可用天数升序，再按名称
      return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
        || compareDays(a.sortDays, b.sortDays, 1)
        || String(a.s.name).localeCompare(String(b.s.name), "zh-CN");
    });
  const filtered = !!q || !!typeFilter || filter !== "all";
  const clearFilters = () => {
    setQuery("");
    setParams({ filter: null, type: null, q: null });
  };
  const nextSort: Record<Sort, Sort> = { "": "days", days: "-days", "-days": "" };
  const ariaSort = sort === "days" ? "ascending" : sort === "-days" ? "descending" : undefined;

  // 弹窗内 KPI 用列表里的最新站点数据（轮询会更新）
  const trendCur = trendStation ? stations.find((x) => x.id === trendStation.id) || trendStation : null;
  const canAdd = !!types.length && !loadingMeta;

  const accounts = useAccountCenter({
    stations,
    types,
    loadingMeta,
    compact,
    showArchived: filter === "archived",
    loaded,
    loadingList,
    loadError,
    reload,
    reloadToken: accountsToken,
    openEditor: (station) => openEditor(station, null),
    openTrend: setTrendStation,
  });

  // 行内的账号待办：本页能处理的直接打开对应抽屉或区块，不整页刷新
  const router = useRouter();
  const openTodo = (href: string) => {
    if (!href.startsWith("/stations")) {
      router.push(href);
      return;
    }
    accounts.openWorkflow(href);
    // 核验与授权会弹出抽屉；接入类事项切到「渠道接入」，其余在页面顶部列出原资源
    const action = new URL(href, window.location.origin).searchParams.get("action") || "";
    if (["verify", "verify-billing", "authorization"].includes(action)) return;
    const target = ONBOARDING_ACTIONS.includes(action) ? ".jy-tabs" : ".jy-accounts-inspect";
    setTimeout(() => document.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  };
  // 从总览、账单核算或行内打开的接入类事项，在「渠道接入」标签里处理
  useEffect(() => {
    if (accounts.destination && ONBOARDING_ACTIONS.includes(accounts.destination.action)) setView("onboarding");
  }, [accounts.destination]); // eslint-disable-line react-hooks/exhaustive-deps
  const todosOf = (v: StationView) => (v.archived ? [] : (todosById.get(actionKey(v.s)) || []).filter((a: any) => a.workflow));
  const todoLinks = (v: StationView) => {
    const list = todosOf(v);
    if (!list.length) return null;
    return (
      <span className="jy-stations-todos">
        {list.map((a: any) => (
          <button key={a.id} type="button" className="link" onClick={() => openTodo(a.href)} aria-label={`${a.label}（${v.s.name}）`}>
            {a.label}
          </button>
        ))}
      </span>
    );
  };

  const retryAll = () => {
    reload().catch(() => {});
    if (metaError || !types.length) loadMeta().catch(() => {});
  };

  // ---- 单元格 --------------------------------------------------------------
  const resourceCell = (v: StationView) => {
    const s = v.s;
    const b = s.balance;
    const account = !v.fixed && b?.ok ? b.account : null;
    const renewal = s.type === "sub2api-password" && s.tokenInfo?.expiresAt
      ? `令牌有效至 ${fmtClock(s.tokenInfo.expiresAt)}，到期自动续期`
      : null;
    return (
      <div className="jy-res-name">
        <div className="jy-stations-name-line">
          <button type="button" className="link" onClick={(e) => openEditor(s, e.currentTarget)}>{s.name}</button>
          {s.isOwn ? <em className="jy-tag jy-tag--type jy-stations-flag">自营</em> : null}
          {s.includeInProfit === false ? <em className="jy-tag jy-tag--type jy-stations-flag">不计利润成本</em> : null}
          {s.noRenewal ? <em className="jy-tag jy-tag--type jy-stations-flag">不再续费</em> : null}
          {s.demo ? <em className="jy-tag jy-tag--type jy-stations-flag">演示</em> : null}
        </div>
        <span title={s.baseUrl || undefined}>
          {v.typeLabel} · {v.host || (v.fixed ? "不访问接口" : "未填写地址")}
        </span>
        {account ? <span title={account}>{account}</span> : null}
        {renewal ? <span title={renewal}>{renewal}</span> : null}
      </div>
    );
  };

  const statusCell = (v: StationView) => (
    <>
      <StatusText level={v.level}>{v.statusLabel}</StatusText>
      {!v.issue && v.statusNote ? <span className="jy-stations-sub">{v.statusNote}</span> : null}
      {todoLinks(v)}
    </>
  );

  // 余额与总览同一口径：设了汇率的是美元额度，主数字显示折算后的人民币，原币放在下方；
  // 没设汇率的按人民币直接显示，并注明未设置汇率（不再把同一个数同时写成 $ 和 ¥）
  const hasRate = (v: StationView) => Number(v.s.cnyPerUsd) > 0;
  const balanceCell = (v: StationView) => {
    const b = v.s.balance;
    if (v.fixed) return <span className="jy-muted">不适用</span>;
    if (!b?.ok) return <span className="jy-muted">—</span>;
    const rem = Number(b.remaining);
    return (
      <>
        {hasRate(v) ? (
          <>
            {formatMoney(rem * v.rate)}
            <span className="jy-sub-money">原币 {formatUsd(rem)}</span>
          </>
        ) : (
          <>
            {formatMoney(rem)}
            <span className="jy-sub-money" title="折算成本与利润时按 1:1 计算，可在编辑里设置汇率">未设置汇率</span>
          </>
        )}
        {sparkButton(v)}
      </>
    );
  };

  // 近 48 小时走势本身就是余额趋势的入口；没有足够数据点时只能从“更多”菜单打开
  const sparkButton = (v: StationView, withLabel = false) => {
    const pts = v.s.spark;
    if (v.fixed || v.archived || !v.s.balance?.ok || !Array.isArray(pts) || pts.length < 2) return null;
    return (
      <button
        type="button"
        className="jy-spark-btn"
        title="近 48 小时余额走势，点击查看详细趋势"
        aria-label={`查看 ${v.s.name} 的余额趋势`}
        onClick={() => setTrendStation(v.s)}
      >
        {withLabel ? <span>近 48 小时</span> : null}
        <Spark pts={pts} width={withLabel ? 120 : 88} />
      </button>
    );
  };

  const burnCell = (v: StationView) => {
    const s = v.s;
    const b = s.balance;
    if (v.archived) return <span className="jy-muted">—</span>;
    if (v.fixed && v.fx) {
      return (
        <>
          {formatMoney(v.fx.daily)}
          <span className="jy-sub-money">
            生效 {v.fx.active}/{v.fx.total} 笔{v.fx.pendingStart ? `，待生效 ${v.fx.pendingStart} 笔` : ""}
          </span>
        </>
      );
    }
    const p = s.prediction;
    // tokens 数放到悬停提示里，单元格只留金额，避免把表格撑出横向滚动
    const today = b?.ok && s.todayUsed != null ? `今日 ${s.todayIsEstimate ? "≈" : ""}${cny(s.todayUsed * v.rate)}` : null;
    const todayTokens = today && s.todayTokens != null ? `今日 ${fmtTokens(s.todayTokens)} tokens` : undefined;
    let main;
    if (p?.burnPerDay === 0) main = <span className="jy-muted">{p.basis || "近期"}无消耗</span>;
    else if (p?.burnPerDay > 0) {
      main = (
        <>
          {formatMoney(p.burnPerDay * v.rate, { approx: true })}
          <span className="jy-sub-money">依据：{p.basis || "估算"}</span>
        </>
      );
    } else main = <span className="jy-muted">—</span>;
    return (
      <>
        {main}
        {today ? <span className="jy-sub-money" title={todayTokens}>{today}</span> : null}
      </>
    );
  };

  const runwayCell = (v: StationView) => (v.runway ? (
    <div className="jy-cell-runway">
      <RunwayTrack
        mini
        days={v.runway.days}
        level={v.runway.level}
        failed={v.runway.failed}
        critDays={critDays}
        warnDays={WARN_DAYS}
        maxDays={MAX_DAYS}
      />
      <span className="v">{v.runway.text}</span>
    </div>
  ) : <span className="jy-muted">—</span>);

  const syncCell = (v: StationView) => {
    const b = v.s.balance;
    if (v.fixed) return <span className="jy-muted">不同步</span>;
    if (refreshingIds[v.s.id]) return <span className="jy-muted">同步中…</span>;
    if (v.issue) return <StatusText level="crit">{v.checkedAt ? `${syncTime(v.checkedAt)} 失败` : "失败"}</StatusText>;
    if (b?.checkedAt) {
      return (
        <>
          {syncTime(b.checkedAt)}
          <span className="jy-stations-sub">
            {relTime(b.checkedAt)}
          </span>
        </>
      );
    }
    return <span className="jy-muted">尚未查询</span>;
  };

  const moreItems = (v: StationView): MenuProps["items"] => {
    const s = v.s;
    if (v.archived) {
      return [
        { key: "edit", label: "编辑", icon: <Icon name="edit" /> },
        ...(!v.fixed ? [{ key: "trend", label: "余额趋势", icon: <Icon name="chart" /> }] : []),
        { type: "divider" as const },
        { key: "purge", label: "彻底删除…", danger: true, icon: <Icon name="trash" /> },
      ];
    }
    return [
      ...(!v.fixed
        ? [
            { key: "refresh", label: "刷新", icon: <Icon name="refresh" />, disabled: !!refreshingIds[s.id] },
            { key: "trend", label: "余额趋势", icon: <Icon name="chart" /> },
            { type: "divider" as const },
          ]
        : []),
      { key: "archive", label: "归档…", icon: <Icon name="archive" /> },
      { key: "purge", label: "彻底删除…", danger: true, icon: <Icon name="trash" /> },
    ];
  };

  const onMore = (v: StationView, key: string) => {
    const s = v.s;
    if (key === "refresh") onRefreshOne(s);
    else if (key === "trend") setTrendStation(s);
    else if (key === "edit") openEditor(s, moreTriggerRef.current);
    else if (key === "archive") setArchiveTarget(s);
    else if (key === "purge") openPurge(s);
  };

  const moreButton = (v: StationView) => (
    <Dropdown trigger={["click"]} menu={{ items: moreItems(v), onClick: ({ key }) => onMore(v, key) }}>
      <button
        type="button"
        className="jy-icon-btn jy-icon-btn--sm"
        title="更多操作"
        aria-label={`${v.s.name} 的更多操作`}
        onClick={(e: MouseEvent<HTMLButtonElement>) => { moreTriggerRef.current = e.currentTarget; }}
      >
        <Icon name="more" />
      </button>
    </Dropdown>
  );

  const primaryAction = (v: StationView) => (v.archived ? (
    <Button
      type="text"
      size="small"
      icon={<Icon name="restore" />}
      loading={!!restoringIds[v.s.id]}
      aria-label={`恢复 ${v.s.name}`}
      onClick={() => onRestore(v.s)}
    >
      恢复
    </Button>
  ) : (
    <Button
      type="text"
      size="small"
      icon={<Icon name="edit" />}
      aria-label={`编辑 ${v.s.name}`}
      onClick={(e) => openEditor(v.s, e.currentTarget)}
    >
      编辑
    </Button>
  ));

  const issueBox = (v: StationView) => {
    const issue = v.issue;
    if (!issue) return null;
    return (
      <div className="jy-stations-issue">
        <Sym kind="crit" />
        <div className="jy-stations-issue-body">
          <b>{issue.category}：{issue.message}</b>
          {issue.action ? <span>{issue.action}</span> : null}
          <span>最近检查：{relTime(v.checkedAt)}</span>
          {issue.diagnostic ? (
            <details className="jy-stations-diag">
              <summary>查看脱敏诊断</summary>
              <span>{issue.diagnostic}</span>
            </details>
          ) : null}
        </div>
        <Button size="small" icon={<Icon name="test" />} loading={!!retestingIds[v.s.id]} onClick={() => onRetest(v.s)}>
          重新测试连接
        </Button>
      </div>
    );
  };

  // ---- 列表主体 -------------------------------------------------------------
  const addButton = (
    <Button type="primary" icon={<Icon name="plus" />} disabled={!canAdd} onClick={(e) => openEditor(null, e.currentTarget)}>
      新增上游资源
    </Button>
  );

  let body;
  if (!loaded && !loadError) {
    body = (
      <div className="jy-stations-skeleton" aria-busy="true">
        <span className="sr-only">正在加载上游资源…</span>
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={40} />)}
      </div>
    );
  } else if (!loaded) {
    body = <ErrorState title="上游资源暂时无法加载" error={loadError} onRetry={retryAll} />;
  } else if (!stations.length) {
    body = (
      <EmptyState
        title="还没有上游资源"
        desc="添加上游资源并填写连接地址与凭证，之后就能看到余额、消耗和预计可用天数。"
        action={addButton}
      />
    );
  } else if (!live.length && filter !== "archived" && paused.length) {
    body = (
      <EmptyState
        title="没有正在监控的上游资源"
        desc={`另有 ${paused.length} 个资源已暂停监控，可在「账号关系」标签中重新启用。`}
        action={addButton}
      />
    );
  } else if (!live.length && filter !== "archived") {
    body = (
      <EmptyState
        title="还没有在用的上游资源"
        desc={`另有 ${archived.length} 个已归档资源，可在「已归档」中恢复。`}
        action={addButton}
      />
    );
  } else {
    body = (
      <>
        <div className="jy-table-wrap has-mobile">
          <table className="jy-data jy-stations-table">
            <caption className="sr-only">上游资源列表</caption>
            <thead>
              <tr>
                <th scope="col" className="jy-stations-pin-l">资源</th>
                <th scope="col">状态</th>
                <th scope="col" className="r">余额</th>
                <th scope="col" className="r">日均消耗</th>
                <th scope="col" aria-sort={ariaSort}>
                  <button type="button" className="jy-stations-sort" onClick={() => setSort(nextSort[sort])}>
                    可用天数
                    {sort ? <Icon name={sort === "days" ? "sort" : "sort-down"} /> : null}
                  </button>
                </th>
                <th scope="col">最近同步</th>
                <th scope="col" className="r jy-stations-pin-r">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const issue = !v.archived && v.issue;
                return (
                  <Fragment key={v.id}>
                    <tr className={issue ? "has-issue" : undefined}>
                      <td className="jy-stations-pin-l">{resourceCell(v)}</td>
                      <td>{statusCell(v)}</td>
                      <td className="r">{balanceCell(v)}</td>
                      <td className="r">{burnCell(v)}</td>
                      <td>{runwayCell(v)}</td>
                      <td>{syncCell(v)}</td>
                      <td className="r jy-stations-pin-r">
                        <div className="jy-row-actions">
                          {primaryAction(v)}
                          {moreButton(v)}
                        </div>
                      </td>
                    </tr>
                    {issue ? (
                      <tr className="jy-stations-issue-row">
                        <td colSpan={COLS}>{issueBox(v)}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={COLS} className="jy-empty-row">
                    没有符合条件的上游资源。
                    {filtered ? <Button type="link" onClick={clearFilters}>清除筛选</Button> : null}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <ul className="jy-m-list" aria-label="上游资源列表">
          {rows.map((v) => {
            const b = v.s.balance;
            return (
              <li key={v.id}>
                <span className="m-top" title={v.s.name}>{v.s.name}</span>
                <StatusText level={v.level}>{v.statusLabel}</StatusText>
                {todoLinks(v)}
                <div className="m-sub">
                  {v.fixed ? (
                    <span>日均 <b>{v.fx ? formatMoney(v.fx.daily) : "—"}</b></span>
                  ) : !b?.ok ? (
                    <span>余额 <b>—</b></span>
                  ) : hasRate(v) ? (
                    <span>余额 <b>{formatMoney(Number(b.remaining) * v.rate)}</b>（{formatUsd(Number(b.remaining))}）</span>
                  ) : (
                    <span>余额 <b>{formatMoney(Number(b.remaining))}</b>（未设汇率）</span>
                  )}
                  {!v.fixed && !v.archived && v.s.prediction?.burnPerDay > 0 ? (
                    <span>日均 <b>{formatMoney(v.s.prediction.burnPerDay * v.rate, { approx: true })}</b></span>
                  ) : null}
                  {v.runway ? <span>可用 <b>{v.runway.text}</b></span> : null}
                  {!v.fixed && b?.checkedAt && !v.issue ? <span>同步 <b>{syncTime(b.checkedAt)}</b></span> : null}
                </div>
                {sparkButton(v, true) ? <div className="m-spark">{sparkButton(v, true)}</div> : null}
                {!v.archived && v.issue ? <div className="jy-stations-m-issue">{issueBox(v)}</div> : null}
                <div className="m-actions">
                  {primaryAction(v)}
                  {!v.archived && !v.fixed ? (
                    <Button
                      type="text"
                      size="small"
                      icon={<Icon name="refresh" />}
                      loading={!!refreshingIds[v.s.id]}
                      aria-label={`刷新 ${v.s.name}`}
                      onClick={() => onRefreshOne(v.s)}
                    >
                      刷新
                    </Button>
                  ) : null}
                  {moreButton(v)}
                </div>
              </li>
            );
          })}
          {!rows.length ? (
            <li>
              <span className="jy-muted">没有符合条件的上游资源。</span>
              {filtered ? <Button type="link" size="small" onClick={clearFilters}>清除筛选</Button> : null}
            </li>
          ) : null}
        </ul>
      </>
    );
  }

  return (
    <div className="jy-page jy-stations">
      {loadError && loaded ? (
        <div className="jy-banner" role="alert">
          <Sym kind="warn" />
          <div className="jy-stations-banner-body">
            <b>资源数据刷新失败，正在显示上次成功加载的数据</b>
            <p className="jy-caption">{loadError}</p>
          </div>
          <Button size="small" onClick={() => { reload().catch(() => {}); }}>重试</Button>
        </div>
      ) : null}
      {metaError ? (
        <div className="jy-banner" role="alert">
          <Sym kind="warn" />
          <div className="jy-stations-banner-body">
            <b>{types.length ? "资源配置刷新失败，正在使用上次成功加载的配置" : "资源配置暂时无法加载，暂不能添加或编辑资源"}</b>
            <p className="jy-caption">{metaError}</p>
          </div>
          <Button size="small" loading={loadingMeta} onClick={() => { loadMeta().catch(() => {}); }}>重试</Button>
        </div>
      ) : null}
      {accounts.top}

      <Tabs<View>
        tabs={[
          { key: "list", label: "资源列表" },
          { key: "onboarding", label: "渠道接入" },
          { key: "accounts", label: "账号关系" },
        ]}
        active={view}
        onChange={setView}
        idPrefix="stations"
        label="上游资源视图"
      />
      {/* 外层包一层：隐藏的标签面板不参与页面的间距；渠道接入与账号关系始终挂载，切换标签不丢状态 */}
      <div>
        <TabPanel idPrefix="stations" tabKey="list" active={view === "list"}>
          <div className="jy-toolbar">
            <Input
              prefix={<Icon name="search" />}
              allowClear
              placeholder="搜索名称或地址"
              aria-label="搜索上游资源"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Seg<Filter>
              label="按状态筛选"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "全部", count: counts.all },
                { value: "attention", label: "需处理", count: counts.attention },
                { value: "ok", label: "无需处理", count: counts.ok },
                { value: "archived", label: "已归档", count: counts.archived },
              ]}
            />
            <Select
              className="jy-stations-type"
              aria-label="按类型筛选"
              value={typeFilter}
              onChange={(value: string) => setTypeFilter(value)}
              options={[{ value: "", label: "全部类型" }, ...types.map((t) => ({ value: t.value, label: t.label }))]}
            />
            <span className="spacer" />
            <Button icon={<Icon name="refresh" />} loading={refreshingAll} onClick={onRefreshAll}>同步全部</Button>
            {addButton}
          </div>

          {filter === "attention" && unowned > 0 ? (
            <p className="jy-caption jy-stations-unowned">
              另有 {unowned} 项账号与账单待办不归属单个资源，在<Link className="jy-link" href="/">运营总览</Link>处理。
            </p>
          ) : null}
          <Panel body={false} label="上游资源列表">{body}</Panel>
        </TabPanel>

        <TabPanel idPrefix="stations" tabKey="onboarding" active={view === "onboarding"}>
          <div className="jy-stations-onboarding">
            {/* 行内打开新的处理目标时重新挂载，让它按新目标重新定位 */}
            <ChannelOnboarding key={accounts.destinationSeq} compact={compact} onComplete={reload} destination={accounts.destination} />
          </div>
        </TabPanel>

        <TabPanel idPrefix="stations" tabKey="accounts" active={view === "accounts"}>
          {accounts.center}
        </TabPanel>
      </div>

      <Modal
        title={archiveTarget ? `归档「${archiveTarget.name}」？` : "归档资源"}
        open={!!archiveTarget}
        onCancel={() => setArchiveTarget(null)}
        onOk={onArchive}
        okText="归档资源"
        cancelText="取消"
        confirmLoading={archiving}
        width={480}
      >
        <div className="jy-banner jy-banner--info">
          <Sym kind="info" />
          <div className="jy-stations-banner-body">
            <b>归档会停止刷新与告警，但不会删除监测历史。</b>
            <p className="jy-caption">归档后的资源默认不出现在实时总览，历史成本仍可用于长期分析。</p>
          </div>
        </div>
        <Button
          type="link"
          danger
          className="jy-stations-purge-link"
          onClick={() => {
            setPurgeTarget(archiveTarget);
            setPurgeConfirm("");
            setArchiveTarget(null);
          }}
        >
          改为彻底删除资源及其监测历史…
        </Button>
      </Modal>

      <Modal
        title={purgeTarget ? `彻底删除「${purgeTarget.name}」？` : "彻底删除资源"}
        open={!!purgeTarget}
        onCancel={() => { setPurgeTarget(null); setPurgeConfirm(""); }}
        onOk={onPurge}
        okText="永久删除"
        cancelText="取消"
        confirmLoading={purging}
        okButtonProps={{ danger: true, disabled: purgeConfirm !== "DELETE" }}
        width={480}
      >
        <div className="jy-banner jy-banner--crit">
          <Sym kind="crit" />
          <div className="jy-stations-banner-body">
            <b>此操作不可恢复</b>
            <p className="jy-caption">资源配置、原始监测快照与用于长期分析的历史都会被永久删除。</p>
          </div>
        </div>
        <div className="jy-stations-confirm">
          <label className="jy-caption" htmlFor="jy-stations-purge-input">请输入 <code>DELETE</code> 以确认：</label>
          <Input
            id="jy-stations-purge-input"
            autoFocus
            aria-label="输入 DELETE 确认彻底删除资源"
            value={purgeConfirm}
            onChange={(event) => setPurgeConfirm(event.target.value)}
            placeholder="DELETE"
            autoComplete="off"
          />
        </div>
      </Modal>

      {accounts.overlays}

      <TrendModal station={trendCur} onClose={() => setTrendStation(null)} etaDaysRule={rules.etaDays ?? 3} />

      <StationDrawer ref={drawerRef} types={types} onSaved={onSaved} />
    </div>
  );
}
