"use client";
// 上游资源：上游列表 + 编辑页 + 单个刷新 / 测试读取 / 归档 / 恢复 / 删除上游 + 余额趋势。
// 请求与旧版逐一对应（端点、方法、载荷不变）；页面标题、刷新按钮、数据截至时间交给外壳。
// 用语按 design/ui-copy-spec.md：共用的叫法从 lib/ 取，只在本页出现的写在下面的 COPY 里。
import "../../styles/pages/stations.css";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Dropdown, Grid, Input, Modal, Select } from "antd";
import type { MenuProps } from "antd";
import { api, readWorkflowDestination, type StationListResponse } from "../../../lib/client";
import { actionsByStation, buildOverviewActions, burnText, etaWindowDays, stationDisplayName } from "../../../lib/overview-actions";
import { basisText, EMPTY, formatAsOf, formatCompact, formatMoney, LOADING_TEXT, NO_SPEND_TEXT, NO_UPSTREAM_TEXT, OWN_STATION_LABEL, RATE_UNSET } from "../../../lib/format";
import { DEFAULT_BUSINESS_TIME_ZONE } from "../../../lib/business-time";
import { balanceMoneyOf } from "../../../lib/profit";
import { NAV_LABELS, STATION_TABS } from "../../../lib/brand";
import { testReadText, workflowActionMeta } from "../../../lib/workflow-actions";
import { failureText, refreshAllText, refreshOneText } from "../../../lib/error-copy";
import { CREDENTIAL_FIELDS, ONBOARDING_TYPES, UPSTREAM_FORM_TEXT, UPSTREAM_TYPES } from "../../../lib/channel-onboarding.js";
import ChannelOnboarding from "../../components/channel-onboarding";
import { EmptyState, ErrorState, RefreshFailedBanner, Skeleton } from "../../components/data-state";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import { Icon, Sym } from "../../components/icons";
import { Panel } from "../../components/panel";
import { RunwayTrack } from "../../components/runway";
import { Seg, TabPanel, Tabs } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { Spark } from "../../components/spark";
import { LEVEL_ORDER, StatusText } from "../../components/status";
import { useUrlParams, useUrlState } from "../../components/use-url-state";
import { channelNameKey, useWorkflowActions } from "../../components/use-workflow-actions";
import { workflowProblem } from "../../components/workflow-copy";
import TrendModal, { TREND_TEXT } from "../trend-modal";
import { buildStationView, resultIssue, testBalanceText, TYPES_MISSING_TEXT } from "./model";
import type { StationCheck, StationView } from "./model";
import { useAccountCenter } from "./account-center";
import { StationDrawer } from "./station-drawer";
import type { StationDrawerHandle } from "./station-drawer";

const FILTERS = ["all", "attention", "ok", "archived"] as const;
type Filter = (typeof FILTERS)[number];
const SORTS = ["", "days", "-days"] as const;
// 资源列表、渠道接入、上游账单分成三个标签，避免一页从头滚到尾
const VIEWS = ["list", "onboarding", "bills"] as const;
type View = (typeof VIEWS)[number];
// 「上游账单」原名「账号关系」，旧链接 view=accounts 仍打开它
const URL_VIEWS = [...VIEWS, "accounts"] as const;
const ONBOARDING_ACTIONS = ["connect", "coverage", "source"];
// 指向某条核算关联的事项：无论从哪里打开，都切到「上游账单」定位
const ASSOCIATION_ACTIONS = ["scope", "conflict"];
type Sort = (typeof SORTS)[number];
const COLS = 6;

const REFRESH = workflowActionMeta("refresh").label;
const DELETE = workflowActionMeta("delete_upstream");
const TEST_READ = workflowActionMeta("verify_identity").label;
const FIXED_TYPE = UPSTREAM_TYPES.find((t) => t.value === "fixed")?.label || "";

// 状态格里「需处理」和页顶筛选同一个词（ui-copy-spec §5.2）
const ATTENTION = "需处理";
// 名称按钮的读屏提示「点名称打开编辑」：用 aria-describedby，不和行末的「编辑 上游名」重名
const EDIT_HINT_ID = "stations-edit-hint";

// 只在上游列表出现的说法（design/ui-copy-spec.md §3.3、§3.5、§6、§8.1）
const COPY = Object.freeze({
  readFailed: `读不到${STATION_TABS.list}`,
  refreshFailed: `${REFRESH}失败`,
  // 上游类型、汇率这些设置读不到时，还能看列表，只是不能新增、编辑
  metaFailed: TYPES_MISSING_TEXT,
  metaStale: "读不到最新的上游类型，先按上次读到的显示",
  testReadOk: (name: string, text: string) => `「${name}」${text}`,
  archive: "归档",
  archiveTitle: (name: string) => `归档「${name}」？`,
  archiveWhat: "不再刷新和提醒，历史数据保留。",
  archiveWhere: "归档后不出现在运营总览里，可以在「已归档」里恢复。",
  archiveDone: (name: string) => `已归档「${name}」`,
  archiveGone: "这个上游已经归档或删除了",
  archiveFailed: "归档失败",
  toDelete: `改为${DELETE.label}…`,
  restore: "恢复",
  restoreOne: (name: string) => `恢复 ${name}`,
  restoreDone: (name: string) => `已恢复「${name}」，正在读取余额`,
  restoreFailed: "恢复失败",
  deleteTitle: (name: string) => `${DELETE.label}「${name}」？`,
  deleteWhat: "删除后不能恢复",
  deleteDesc: "这个上游的设置和历史数据会一起删掉。只想不再刷新和提醒，用「归档」。",
  deleteConfirm: "输入这个上游的名字确认：",
  deleteConfirmAria: (name: string) => `输入「${name}」确认${DELETE.label}`,
  deleteDone: (name: string) => `${DELETE.done}「${name}」`,
  deleteGone: "这个上游已经删除了",
  deleteFailed: "删除失败",
  edit: "编辑",
  editOne: (name: string) => `编辑 ${name}`,
  refreshOne: (name: string) => `${REFRESH} ${name}`,
  more: "更多操作",
  moreOf: (name: string) => `${name} 的更多操作`,
  trend: TREND_TEXT.title,
  trendOf: TREND_TEXT.of,
  trendTip: "近 48 小时的余额，点开看余额趋势",
  own: OWN_STATION_LABEL,
  notInProfit: "不算进利润",
  noRenewal: "不再续费",
  demo: "演示",
  noAddress: `还没填${CREDENTIAL_FIELDS.baseUrl.label}`,
  refreshing: "正在刷新",
  // 这个上游的数据比别的上游旧两轮刷新以上时，状态格下一行写「数据截至 14:20」（ui-copy-spec §6）
  staleTip: "后面几次刷新都没读到这个上游的新数据",
  // 一个上游有几件事（ui-copy-spec §5.2）：状态格「需处理 · 还有 1 个问题」，「⋯」里「按钮名：标题」
  moreTodos: (label: string, n: number) => `${label} · 还有 ${n} 个问题`,
  // 「还没确认这把 Key 属于哪个上游账号」放在上游这一行时，「这把 Key」说清是哪些渠道的（ui-copy-spec §5.2）；K 做完这条提示就没了
  ownerNames: (names: string[]) => `渠道${names.map((n) => `「${n}」`).join("")}用的 Key 还没确认属于哪个上游账号`,
  ownerMany: (first: string, n: number) => `渠道「${first}」等 ${n} 个渠道用的 Key 还没确认属于哪个上游账号`,
  ownerCount: (n: number) => `这个上游下 ${n} 个渠道用的 Key 还没确认属于哪个上游账号`,
  ownerNone: "这个上游的 Key 还没确认属于哪个上游账号",
  todoItem: (label: string, title: string) => `${label}：${title}`,
  editHint: "点名称打开编辑",
  today: (money: string) => `今天花费 ${money}`,
  todayTokens: (tokens: string) => `今天 ${tokens} Token`,
  emptyDesc: "加上上游、填好登录信息后，这里显示每个上游的余额、日均花费和可用天数。",
  pausedTitle: "没有在看余额的上游",
  pausedDesc: (n: number) => `另有 ${n} 个上游暂停了监控，可以在「${STATION_TABS.bills}」里恢复监控。`,
  archivedOnlyTitle: "没有在用的上游",
  archivedOnlyDesc: (n: number) => `另有 ${n} 个已归档的上游，可以在「已归档」里恢复。`,
  noMatch: "没有符合条件的上游。",
  clearFilters: "清除筛选",
  col: Object.freeze({ name: "上游", status: "状态", balance: "余额", burn: "日均花费", days: "可用天数", actions: "操作" }),
  views: "上游资源的标签页",
  search: "搜索名称或地址",
  searchAria: "搜索上游",
  byStatus: "按状态筛选",
  byType: "按类型筛选",
  allTypes: "全部类型",
  filter: Object.freeze({ all: "全部", attention: ATTENTION, ok: "无需处理", archived: "已归档" }),
  unownedBefore: (n: number) => `另有 ${n} 件需处理的事不在某一个上游上，在`,
  unownedAfter: "里处理。",
  cancel: "取消",
});

// 与 buildOverviewActions 的 stationId 同一口径，保证“需处理”与总览的待办完全对得上
const actionKey = (s: any) => String(s.id || stationDisplayName(s));

// 渠道接入目录里的资源及其用到的字段（与服务端目录同口径：四种账号类型，含本站来源）
const onboardingSig = (list: any[]) =>
  list
    .filter((s) => ONBOARDING_TYPES.some((item) => item.value === s.type))
    .map((s) =>
      [s.id, s.name, s.type, s.baseUrl, s.archivedAt ?? "", s.monitorEnabled !== false, !!s.isOwn, s.authVersion ?? "", s.verifiedIdentity?.provider ?? "", s.verifiedIdentity?.accountId ?? ""].join("|"),
    )
    .join("\n");

// 渠道接入只在挂载时读目录，切换标签又保持挂载；这里决定什么时候换 key 重新挂载（rev + 1）。
// sig：当前实例已同步到的资源签名（列表首次读到前为 null）；dirty：上游账单里改过身份、授权或核算；
// shown：标签打开过（首次打开才挂载，读到的就是当前目录）；wait：列表还在刷新，落地后怎么处理——
// absorb 实例刚按当前目录挂载，只记下签名；compare 切回时还不知道有没有变化，落地后再比。
// 显示期间的变化不重挂（免得冲掉接入结果），也不算已同步，下次切回时重挂
type OnboardingSync = { view: string; seq: number; sig: string | null; dirty: boolean; shown: boolean; wait: "absorb" | "compare" | null; rev: number };
function syncOnboarding(o: OnboardingSync, view: string, seq: number, sig: string, loaded: boolean, loading: boolean): OnboardingSync {
  let n = o;
  // 实例此刻按当前目录（重新）挂载
  const mounted = (x: OnboardingSync): OnboardingSync => ({ ...x, sig: loaded ? sig : x.sig, dirty: false, wait: loading ? "absorb" : null });
  // 行内打开新的处理目标已按新 key 重挂
  if (n.seq !== seq) n = mounted({ ...n, seq });
  if (loaded && n.sig === null) n = { ...n, sig };
  if (n.view !== view) {
    if (view !== "onboarding") n = { ...n, view, wait: n.wait === "compare" ? null : n.wait };
    else if (!n.shown) n = mounted({ ...n, view, shown: true });
    // 切回时已知有变化就立刻重挂（改动已写进服务端，重挂后读到的是新目录）；还在刷新就等它落地再比
    else if (n.dirty || (loaded && n.sig !== sig)) n = mounted({ ...n, view, rev: n.rev + 1 });
    else n = { ...n, view, wait: n.wait ?? (loading ? "compare" : null) };
  }
  if (n.wait && loaded && !loading) {
    const changed = n.wait === "compare" && n.sig !== sig;
    n = changed ? { ...n, sig, wait: null, dirty: false, rev: n.rev + 1 } : { ...n, sig, wait: null };
  }
  return n;
}

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
  // 服务端返回列表的时刻：判断「数据旧了」的参照（staleAt）
  const [listAt, setListAt] = useState<number | null>(null);
  // 这次列表之后测试读取成功的上游：页面上显示的是刚读到的余额，下一次刷新列表之前不标「数据旧了」
  const [testedIds, setTestedIds] = useState<Record<string, true>>({});
  const [settings, setSettings] = useState<any>({ refreshIntervalSec: 60, lowBalanceUsd: 5 });
  const [types, setTypes] = useState<any[]>([]);
  const [rules, setRules] = useState<any>({});
  const [loaded, setLoaded] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  // 每次读取资源后递增，上游账单随之重读
  const [accountsToken, setAccountsToken] = useState(0);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<Error | null>(null);
  // 业务时区（接口返回的 tz）：数据截至、归档日期、固定成本到期都按它写
  const [tz, setTz] = useState<string>(DEFAULT_BUSINESS_TIME_ZONE);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<Record<string, boolean>>({});
  const [retestingIds, setRetestingIds] = useState<Record<string, boolean>>({});
  const [restoringIds, setRestoringIds] = useState<Record<string, boolean>>({});
  // 列表内「测试读取」的结果只存在本地，不写库（同旧版）
  const [stationChecks, setStationChecks] = useState<Record<string, StationCheck>>({});
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const [trendStation, setTrendStation] = useState<any>(null);
  // 上游的去留：默认归档，历史数据保留；删除上游要在单独的确认框里输入上游的名字
  const [archiveTarget, setArchiveTarget] = useState<any>(null);
  const [purgeTarget, setPurgeTarget] = useState<any>(null);
  const [purgeConfirm, setPurgeConfirm] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [purging, setPurging] = useState(false);

  // 搜索词写进地址栏（停止输入 300ms 后），刷新与分享链接时保持
  const [queryParam, setQueryParam] = useUrlState<string>("q", "");
  const [query, setQuery] = useState(queryParam);
  const [rawView, setUrlView] = useUrlState<(typeof URL_VIEWS)[number]>("view", "list", URL_VIEWS);
  const urlView: View = rawView === "accounts" ? "bills" : rawView;
  const [filter, setFilter] = useUrlState<Filter>("filter", "all", FILTERS);
  const [typeFilter, setTypeFilter] = useUrlState<string>("type", "");
  const [sort, setSort] = useUrlState<Sort>("sort", "", SORTS);
  const [params, setParams] = useUrlParams();
  // 带着处理入口进来时，第一帧就落在它所在的标签，不先渲染资源列表再跳过去（中途切换会打断按钮加载动画的收尾）。
  // 地址栏写入 view 之后以地址栏为准；用户自己切标签时立即放弃
  const [entryView, setEntryView] = useState<View | null>(() => {
    const destination = readWorkflowDestination(params.toString(), "stations");
    return destination ? (ONBOARDING_ACTIONS.includes(destination.action) ? "onboarding" : "bills") : null;
  });
  if (entryView && urlView === entryView) setEntryView(null);
  const view = entryView ?? urlView;
  const setView = useCallback((v: View) => {
    setEntryView(null);
    setUrlView(v);
  }, [setUrlView]);
  const editParam = params.get("edit");

  // 写地址栏是异步的：记住自己写进去的值，回声到达时不回填输入框，否则会吞掉这期间新打的字
  const lastWrittenQuery = useRef(queryParam);
  useEffect(() => {
    if (query === queryParam) return;
    const t = setTimeout(() => {
      const next = query.trim() ? query : "";
      lastWrittenQuery.current = next;
      setQueryParam(next);
    }, 300);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  // 浏览器前进后退等外部改动了地址栏时才跟上
  useEffect(() => {
    if (queryParam === lastWrittenQuery.current) return;
    lastWrittenQuery.current = queryParam;
    setQuery(queryParam);
  }, [queryParam]);

  const drawerRef = useRef<StationDrawerHandle>(null);
  // 更多菜单里的“编辑”：关闭抽屉后焦点回到这一行的更多按钮
  const moreTriggerRef = useRef<HTMLElement | null>(null);

  // 轮询和手动刷新可能重叠，全部落地才算刷新结束
  const reloading = useRef(0);
  // 始终带上归档与暂停监控的资源：“已归档”只是一个筛选；暂停监控的资源在上游账单中管理
  const reload = useCallback(async () => {
    reloading.current += 1;
    setLoadingList(true);
    try {
      const r: StationListResponse = await api("/api/stations?includeUnmonitored=true&includeArchived=true");
      setStations(r.stations);
      setListAt(Date.parse(r.generatedAt || "") || null);
      setTestedIds({});
      setSettings(r.settings);
      if (r.tz) setTz(r.tz);
      setLoaded(true);
      setLoadError(null);
      setRefreshedAt(Date.now());
      return r.stations as any[];
    } catch (e: any) {
      setLoadError(e);
      throw e;
    } finally {
      reloading.current -= 1;
      if (!reloading.current) setLoadingList(false);
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
      setMetaError(e);
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
  // 「数据比别的旧」也按它算（staleAt）
  const refreshSec = Math.max(10, Number(settings.refreshIntervalSec) || 60);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      reload().catch(() => {});
    }, refreshSec * 1000);
    return () => clearInterval(t);
  }, [refreshSec, reload]);

  // 外壳的刷新只重新读取；向上游重新读余额是工具栏的「刷新」
  useShellPage({
    onRefresh: () => Promise.all([reload(), metaError || !types.length ? loadMeta() : null]),
    asOf: refreshedAt,
    tz,
  });

  const openEditor = (s: any | null, trigger?: HTMLElement | null) => drawerRef.current?.open(s, trigger);

  // /stations?edit=<id>：数据和类型都到齐后打开对应上游的抽屉，然后把参数从地址栏去掉；找不到就静默忽略。
  // edit=new 打开「新增上游」（运营总览的空状态用）
  useEffect(() => {
    if (!editParam || !loaded || loadingMeta) return;
    const target = editParam === "new" ? null : stations.find((x) => String(x.id) === editParam);
    if (target || (editParam === "new" && types.length)) openEditor(target || null, null);
    setParams({ edit: null });
  }, [editParam, loaded, loadingMeta]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRefreshAll = async () => {
    setRefreshingAll(true);
    try {
      const r = await api("/api/refresh", { method: "POST", body: {} });
      // /api/refresh 只返回在监控的上游；重新读取完整列表，归档与暂停监控的上游一并保留。
      // 刷新已经做完：读列表失败时由列表顶上的「读取失败」交代，这里照旧报刷新结果
      await reload().catch(() => {});
      // 和运营总览同一句：有读不到余额的说几个
      const done = refreshAllText(r?.stations);
      if (done.failed) message.warning(done.text);
      else message.success(done.text);
    } catch (e) {
      message.error(failureText(COPY.refreshFailed, e));
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
      const done = refreshOneText(stationDisplayName(s), r.balance);
      if (done.ok) message.success(done.text);
      else message.warning(done.text);
    } catch (e) {
      message.error(failureText(COPY.refreshFailed, e));
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
      // 只传上游 ID 与类型；测试接口用已保存的登录信息读取，不写库、不刷新、不告警
      const result = await api("/api/stations/test", {
        body: { stationId: station.id, type: station.type },
      });
      if (!result.ok) {
        const issue = resultIssue(result);
        setStationChecks((checks) => ({ ...checks, [station.id]: { issue, checkedAt: new Date().toISOString() } }));
        return;
      }
      // 测试读取不写库：读取时刻不改（不拿浏览器的时刻），这一行在下一次刷新列表之前不标「数据旧了」——
      // 显示的是刚读到的余额，不是「读得比别的旧」（ui-design-spec §5.2）
      setTestedIds((ids) => ({ ...ids, [station.id]: true }));
      setStations((list) => list.map((item) => (item.id === station.id ? {
        ...item,
        balance: {
          ...(item.balance && item.balance.ok ? item.balance : {}),
          ok: true,
          checkedAt: item.balance?.checkedAt || null,
          latencyMs: result.latencyMs,
          account: result.account || null,
          remaining: result.remaining,
          currency: result.currency || null,
        },
      } : item)));
      message.success(COPY.testReadOk(stationDisplayName(station), testReadText({ ok: true, balance: testBalanceText(result) || "", bill: false })));
    } catch (e: any) {
      const issue = resultIssue(e);
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
      if (result.ok) message.success(COPY.archiveDone(stationDisplayName(archiveTarget)));
      else message.warning(COPY.archiveGone);
      setArchiveTarget(null);
      await reload();
    } catch (e) {
      message.error(failureText(COPY.archiveFailed, e));
    } finally {
      setArchiving(false);
    }
  };

  const onPurge = async () => {
    if (!purgeTarget || !purgeMatches) return;
    setPurging(true);
    try {
      // 界面上输入的是上游的名字；接口的确认词不变
      const result = await api(`/api/stations/${purgeTarget.id}?purge=true`, { method: "DELETE", body: { confirm: "DELETE" } });
      if (result.ok) message.success(COPY.deleteDone(stationDisplayName(purgeTarget)));
      else message.warning(COPY.deleteGone);
      setPurgeTarget(null);
      setPurgeConfirm("");
      await reload();
    } catch (e) {
      message.error(failureText(COPY.deleteFailed, e));
    } finally {
      setPurging(false);
    }
  };

  // 恢复：PUT archived=false，服务端恢复后会重新开始刷新
  const onRestore = async (s: any) => {
    setRestoringIds((m) => ({ ...m, [s.id]: true }));
    try {
      await api(`/api/stations/${s.id}`, { method: "PUT", body: { archived: false } });
      message.success(COPY.restoreDone(stationDisplayName(s)));
      setTimeout(() => reload().catch(() => {}), 800);
      await reload();
    } catch (e) {
      message.error(failureText(COPY.restoreFailed, e));
    } finally {
      setRestoringIds((m) => ({ ...m, [s.id]: false }));
    }
  };

  // 删除上游要输入这个上游的名字（§3.5），前后空格不算
  const purgeName = purgeTarget ? stationDisplayName(purgeTarget) : "";
  const purgeMatches = !!purgeTarget && purgeConfirm.trim() === purgeName;
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
  // 列表只放在监控的资源（归档的照常放在「已归档」里）；暂停监控的资源在「上游账单」标签中查看与重新启用
  const listed = useMemo(() => stations.filter((s) => s.monitorEnabled !== false || s.archivedAt), [stations]);
  const paused = stations.filter((s) => s.monitorEnabled === false && !s.archivedAt);
  // 账号待办由上游账单读到后发布，这里只补读账单待办
  const { actions: workflowActions, channelNames } = useWorkflowActions(true, ["bills"]);

  const { todosById, unowned } = useMemo(() => {
    const live = listed.filter((s) => !s.archivedAt);
    const all = buildOverviewActions(live, { tz, rules, settings, workflowActions }).all;
    const ids = new Set(live.map(actionKey));
    // 按账号或核算关联归类、不落在单个资源上的待办只在运营总览处理，这里交代条数
    return { todosById: actionsByStation(all), unowned: all.filter((a: any) => !a.stationId || !ids.has(String(a.stationId))).length };
  }, [listed, tz, rules, settings, workflowActions]);

  // 「还没确认这把 Key 属于哪个上游账号」：同一个上游下几条绑定都没确认时，总览按种类去重只留一条，渠道要从原始事项里合起来（ui-copy-spec §5.2）
  const isOwnerTodo = (a: any) => a.code === "COST_OWNER_UNVERIFIED" || (!a.code && a.kind === "verify_identity");
  const ownerChannels = useMemo(() => {
    const byStation = new Map<string, Map<string, { own: unknown; id: number }>>();
    for (const a of workflowActions as any[]) {
      if (!isOwnerTodo(a) || a.stationId == null) continue;
      const key = String(a.stationId);
      const list = byStation.get(key) || new Map();
      for (const id of a.channelIds || []) list.set(channelNameKey(a.ownStationId, id), { own: a.ownStationId, id: Number(id) });
      byStation.set(key, list);
    }
    return byStation;
  }, [workflowActions]);

  // 这个上游身上要处理的事（利润类、账号类），先后同运营总览
  const todosOf = (v: StationView) => (v.archived ? [] : (todosById.get(actionKey(v.s)) || []).filter((a: any) => a.workflow));

  const critDays = etaWindowDays(rules);
  const views = useMemo(() => {
    const now = Date.now();
    return listed.map((s) => buildStationView(s, {
      settings,
      rules,
      tz,
      check: stationChecks[s.id],
      attention: !s.archivedAt && todosById.has(actionKey(s)),
      now,
    }));
  }, [listed, settings, rules, tz, stationChecks, todosById]);

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

  // 默认排序按需要关注的程度：档位和那几件事里最严重的那个（ui-design-spec §5.2）
  const rankOf = (v: StationView) => Math.min(LEVEL_ORDER[v.level], ...todosOf(v).map((a: any) => LEVEL_ORDER[a.level as keyof typeof LEVEL_ORDER] ?? Infinity));
  const q = query.trim().toLowerCase();
  const byStatus = filter === "archived" ? archived : filter === "attention" ? live.filter(needsWork) : filter === "ok" ? live.filter((v) => !needsWork(v)) : live;
  const rows = byStatus
    .filter((v) => !typeFilter || v.s.type === typeFilter)
    .filter((v) => !q || [v.s.name, v.s.baseUrl, v.host, v.s.balance?.account].some((x) => String(x || "").toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sort === "days") return compareDays(a.sortDays, b.sortDays, 1) || String(a.s.name).localeCompare(String(b.s.name), "zh-CN");
      if (sort === "-days") return compareDays(a.sortDays, b.sortDays, -1) || String(a.s.name).localeCompare(String(b.s.name), "zh-CN");
      // 默认：最严重的在前，同级按可用天数升序，再按名称
      return rankOf(a) - rankOf(b)
        || compareDays(a.sortDays, b.sortDays, 1)
        || String(a.s.name).localeCompare(String(b.s.name), "zh-CN");
    });
  const filtered = !!q || !!typeFilter || filter !== "all";
  const clearFilters = () => {
    setQuery("");
    // 同搜索框：记下写进去的空值，回声到达时不清掉这期间新打的字
    lastWrittenQuery.current = "";
    setParams({ filter: null, type: null, q: null });
  };
  const nextSort: Record<Sort, Sort> = { "": "days", days: "-days", "-days": "" };
  const ariaSort = sort === "days" ? "ascending" : sort === "-days" ? "descending" : undefined;

  // 弹窗内 KPI 用列表里的最新站点数据（轮询会更新）
  const trendCur = trendStation ? stations.find((x) => x.id === trendStation.id) || trendStation : null;
  const canAdd = !!types.length && !loadingMeta;

  const [onboardingSync, setOnboardingSync] = useState<OnboardingSync>(() => ({ view, seq: 0, sig: null, dirty: false, shown: view === "onboarding", wait: null, rev: 0 }));
  // 上游账单里的操作都会改到接入目录（身份、授权、监控用途、核算关联），切回渠道接入时重读
  const reloadAfterAccountChange = useCallback(async () => {
    setOnboardingSync((o) => ({ ...o, dirty: true }));
    await reload();
  }, [reload]);
  // 渠道接入自己完成后的刷新：它已经读过最新目录，即使刷新落地前切走了，切回来也不重挂
  const reloadAfterOnboarding = useCallback(async () => {
    const list = await reload();
    setOnboardingSync((o) => ({ ...o, sig: onboardingSig(list) }));
  }, [reload]);

  const accounts = useAccountCenter({
    stations,
    types,
    loadingMeta,
    compact,
    loaded,
    loadingList,
    loadError,
    reload: reloadAfterAccountChange,
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
    // 核验与授权会弹出抽屉；核算关联在「上游账单」里定位；接入类事项切到「渠道接入」，其余在页面顶部列出原资源
    const action = new URL(href, window.location.origin).searchParams.get("action") || "";
    if (["verify", "verify-billing", "authorization", ...ASSOCIATION_ACTIONS].includes(action)) return;
    const target = ONBOARDING_ACTIONS.includes(action) ? ".jy-tabs" : ".jy-accounts-inspect";
    setTimeout(() => document.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  };
  // 从总览、账单核算或行内打开的接入类事项，在「渠道接入」标签里处理；核算关联事项总在「上游账单」里定位。
  // 从别的页面带进来的账号事项（核验、授权、定位原资源）落到「上游账单」，抽屉下面就是这个账号。
  // 行内打开的账号事项（destinationSeq > 0）留在当前列表
  useEffect(() => {
    if (!accounts.destination) return;
    if (ONBOARDING_ACTIONS.includes(accounts.destination.action)) setUrlView("onboarding");
    else if (accounts.destinationSeq === 0 || ASSOCIATION_ACTIONS.includes(accounts.destination.action)) setUrlView("bills");
  }, [accounts.destination]); // eslint-disable-line react-hooks/exhaustive-deps
  const resourceSig = useMemo(() => onboardingSig(stations), [stations]);
  const nextSync = syncOnboarding(onboardingSync, view, accounts.destinationSeq, resourceSig, loaded, loadingList);
  if (nextSync !== onboardingSync) setOnboardingSync(nextSync);
  // 这个上游的数据比服务端此刻旧「2 × 刷新间隔 + 30 秒」以上：返回「数据截至 14:20」，否则 null（ui-design-spec §5.2）。
  // 30 秒是单次读取超时的余量。两边都是服务端的时刻，不拿浏览器的时钟比；所有上游都旧了、只有一个上游时也照样标。
  // 接口没给此刻（旧版服务端）时退回到在用上游里最新的读取时刻。读不到余额的上游下面另有一行说原因，不再标
  const readAt = (v: StationView) => (v.fixed || v.archived || v.issue || !v.checkedAt ? NaN : new Date(v.checkedAt).getTime());
  const staleRef = listAt ?? Math.max(0, ...live.map(readAt).filter(Number.isFinite));
  const staleAt = (v: StationView) => {
    if (testedIds[v.s.id]) return null;
    const at = readAt(v);
    return Number.isFinite(at) && staleRef - at > (2 * refreshSec + 30) * 1000 ? formatAsOf(v.checkedAt, tz) : null;
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
    return (
      <div className="jy-res-name">
        <div className="jy-stations-name-line">
          <button type="button" className="link" title={stationDisplayName(s)} aria-describedby={EDIT_HINT_ID} onClick={(e) => openEditor(s, e.currentTarget)}>{stationDisplayName(s)}</button>
          {s.isOwn ? <em className="jy-tag jy-tag--type jy-stations-flag">{COPY.own}</em> : null}
          {/* 自营站点本来就不算进利润（countsInProfit），编辑页也不给这个开关，不挂这个标签 */}
          {!s.isOwn && s.includeInProfit === false ? <em className="jy-tag jy-tag--type jy-stations-flag">{COPY.notInProfit}</em> : null}
          {s.noRenewal ? <em className="jy-tag jy-tag--type jy-stations-flag">{COPY.noRenewal}</em> : null}
          {s.demo ? <em className="jy-tag jy-tag--type jy-stations-flag">{COPY.demo}</em> : null}
        </div>
        {/* 下面一行写地址 · 账号名，放不下的省略、悬停看全；类型名在编辑页和「按类型筛选」里看 */}
        <span title={[s.baseUrl, account].filter(Boolean).join(" · ") || undefined}>
          {[v.fixed ? FIXED_TYPE : v.host || COPY.noAddress, account].filter(Boolean).join(" · ")}
        </span>
      </div>
    );
  };

  // 一件事在这一行里的标题：「还没确认这把 Key 属于哪个上游账号」要说清是这个上游下哪些渠道的 Key（ui-copy-spec §5.2）
  const todoTitle = (a: any) => {
    if (!isOwnerTodo(a)) return workflowProblem(a);
    const merged = a.stationId != null ? ownerChannels.get(String(a.stationId)) : undefined;
    const channels = merged?.size ? [...merged.values()] : (a.channelIds || []).map((id: number) => ({ own: a.ownStationId, id: Number(id) }));
    if (!channels.length) return COPY.ownerNone;
    const names = channels.map((c: { own: unknown; id: number }) => channelNames[channelNameKey(c.own, c.id)]).filter(Boolean);
    if (names.length < channels.length) return COPY.ownerCount(channels.length);
    return names.length <= 2 ? COPY.ownerNames(names) : COPY.ownerMany(names[0], names.length);
  };

  // 状态格只放状态（ui-design-spec §5.2）：上一行档位，或者只有要处理的事时写「需处理」，几件事时加「· 还有 N 个问题」；
  // 有档位又有事时写「余额偏低 · 还有 N 个问题」，N 是事的件数（档位本身不算）。
  // 下一行按先后只放一样：正在刷新、数据旧了；有档位时是这一档的说明（事的标题不写在这里，免得读起来像在解释档位，标题在行末按钮的悬停和读屏里）；
  // 没有档位时是那件事的标题；再不然是状态自己的说明。读不到余额的行原因在下面那一行，这里不写。要处理的事的按钮在行末，不在这里
  const statusOf = (v: StationView) => {
    const todos = todosOf(v);
    const todo = todos[0];
    const tier = v.statusLabel;
    const label = tier ? (todos.length ? COPY.moreTodos(tier, todos.length) : tier) : todo ? (todos.length > 1 ? COPY.moreTodos(ATTENTION, todos.length - 1) : ATTENTION) : "";
    const level = tier ? v.level : todo?.level;
    const stale = staleAt(v);
    const title = todo ? todoTitle(todo) : null;
    const refreshing = !!refreshingIds[v.s.id];
    // 档位自己没有说明时（「还没读取」、部分固定成本状态）退回写事的标题，状态格总说得出为什么
    const note = refreshing ? COPY.refreshing : stale || (v.issue ? null : tier ? v.statusNote || title : title || v.statusNote);
    // 小钟和「后面几次刷新都没读到」那句只跟「数据截至」走，正在刷新时不挂
    return { label, level, note, stale: refreshing ? null : stale, title };
  };
  // 下一行那一格：放不下的省略，悬停看全；数据旧时前面一个小钟，后面那句说明只给悬停和读屏
  const subLine = (note: string, stale: string | null) => (
    <span className="jy-stations-sub" title={stale ? `${note}。${COPY.staleTip}` : note}>
      {stale ? <Icon name="clock" /> : null}
      <span>{note}</span>
      {stale ? <span className="sr-only">。{COPY.staleTip}</span> : null}
    </span>
  );
  const statusCell = (v: StationView) => {
    const { label, level, note, stale } = statusOf(v);
    return (
      <>
        {label ? <StatusText level={level}>{label}</StatusText> : null}
        {note ? subLine(note, stale) : null}
      </>
    );
  };

  // 余额的写法和运营总览同一处（balanceMoneyOf）：按上游自己的币种写，设了汇率下面写「约 ¥88.56」，
  // 没设置汇率下面写「没设置汇率」，悬停是整句
  const balanceCell = (v: StationView) => {
    const b = v.s.balance;
    if (v.fixed || !b?.ok) return <span className="jy-muted">{EMPTY}</span>;
    const m = balanceMoneyOf(v.s, Number(b.remaining));
    // 上一行近 48 小时的小图在左、余额在右（没有小图的行留同样宽的空位，金额上下对齐），下一行换算或「没设置汇率」
    return (
      <>
        <span className="jy-stations-money">
          <span className="jy-stations-spark">{sparkButton(v)}</span>
          {m.text}
        </span>
        <span className="jy-sub-money" title={m.note}>{m.cny || RATE_UNSET}</span>
      </>
    );
  };

  // 近 48 小时的小图本身就是余额趋势的入口；数据不够两个点时只能从「更多操作」打开
  const sparkButton = (v: StationView) => {
    const pts = v.s.spark;
    if (v.fixed || v.archived || !v.s.balance?.ok || !Array.isArray(pts) || pts.length < 2) return null;
    return (
      <button
        type="button"
        className="jy-spark-btn"
        title={COPY.trendTip}
        aria-label={COPY.trendOf(stationDisplayName(v.s))}
        onClick={() => setTrendStation(v.s)}
      >
        <Spark pts={pts} width={88} />
      </button>
    );
  };

  const burnCell = (v: StationView) => {
    const s = v.s;
    const b = s.balance;
    if (v.archived) return <span className="jy-muted">{EMPTY}</span>;
    if (v.fixed && v.fx) {
      // 固定成本按天平摊；笔数句和运营总览、成本估算同一处（fixedCostNowOf）
      return (
        <>
          {formatMoney(v.fx.daily)}
          {v.fx.note ? <span className="jy-sub-money">{v.fx.note}</span> : null}
        </>
      );
    }
    const p = s.prediction;
    // Token 数放到悬停提示里，单元格只留金额，避免把表格撑出横向滚动
    const today = b?.ok && s.todayUsed != null ? COPY.today(formatMoney(s.todayUsed * v.rate, { approx: !!s.todayIsEstimate })) : null;
    const todayTokens = today && s.todayTokens != null ? COPY.todayTokens(formatCompact(s.todayTokens)) : undefined;
    // 日均花费的写法和推送、日报同一个（burnText）
    const burn = burnText(s, p);
    let main;
    if (p?.burnPerDay === 0) main = <span className="jy-muted">{NO_SPEND_TEXT}</span>;
    else if (burn) {
      // 按哪段花费估的放进悬停，格子里两行：日均花费、今天花费
      main = (
        <span title={basisText(p.basis) || undefined}>
          {burn}
          <span className="sr-only">，{basisText(p.basis)}</span>
        </span>
      );
    } else main = <span className="jy-muted">{EMPTY}</span>;
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
      />
      <span className="v">{v.runway.text}</span>
    </div>
  ) : <span className="jy-muted">{EMPTY}</span>);

  // 「⋯」：有要处理的事时，行末放第一件，其余几件放最上面，「编辑」也挪进来；手机上小图和刷新也在这里
  const moreItems = (v: StationView, mobile = false): MenuProps["items"] => {
    const s = v.s;
    const [lead, ...rest] = todosOf(v);
    const head = [
      ...rest.map((a: any) => ({ key: `todo:${a.id}`, label: COPY.todoItem(a.label, todoTitle(a)) })),
      ...(lead || mobile ? [{ key: "edit", label: COPY.edit, icon: <Icon name="edit" /> }] : []),
    ];
    if (v.archived) {
      return [
        { key: "edit", label: COPY.edit, icon: <Icon name="edit" /> },
        ...(!v.fixed ? [{ key: "trend", label: COPY.trend, icon: <Icon name="chart" /> }] : []),
        { type: "divider" as const },
        { key: "purge", label: `${DELETE.label}…`, danger: true, icon: <Icon name="trash" /> },
      ];
    }
    return [
      ...head,
      ...(head.length ? [{ type: "divider" as const }] : []),
      ...(!v.fixed
        ? [
            { key: "refresh", label: REFRESH, icon: <Icon name="refresh" />, disabled: !!refreshingIds[s.id] },
            { key: "trend", label: COPY.trend, icon: <Icon name="chart" /> },
            { type: "divider" as const },
          ]
        : []),
      { key: "archive", label: `${COPY.archive}…`, icon: <Icon name="archive" /> },
      { key: "purge", label: `${DELETE.label}…`, danger: true, icon: <Icon name="trash" /> },
    ];
  };

  const onMore = (v: StationView, key: string) => {
    const s = v.s;
    const todo = key.startsWith("todo:") ? todosOf(v).find((a: any) => `todo:${a.id}` === key) : null;
    if (todo) openTodo(todo.href);
    else if (key === "refresh") onRefreshOne(s);
    else if (key === "trend") setTrendStation(s);
    else if (key === "edit") openEditor(s, moreTriggerRef.current);
    else if (key === "archive") setArchiveTarget(s);
    else if (key === "purge") openPurge(s);
  };

  const moreButton = (v: StationView, mobile = false) => (
    <Dropdown trigger={["click"]} menu={{ items: moreItems(v, mobile), onClick: ({ key }) => onMore(v, key) }}>
      <button
        type="button"
        className="jy-icon-btn jy-icon-btn--sm"
        title={COPY.more}
        aria-label={COPY.moreOf(stationDisplayName(v.s))}
        onClick={(e: MouseEvent<HTMLButtonElement>) => { moreTriggerRef.current = e.currentTarget; }}
      >
        <Icon name="more" />
      </button>
    </Dropdown>
  );

  // 行末：有要处理的事时就是那件事的按钮（例如「测试读取」），没有时是「编辑」（ui-design-spec §5.2）
  const todoAction = (v: StationView) => {
    const todo = todosOf(v)[0];
    if (!todo) return null;
    return (
      <Button
        type="text"
        size="small"
        title={COPY.todoItem(todo.label, todoTitle(todo))}
        aria-label={`${COPY.todoItem(todo.label, todoTitle(todo))}（${stationDisplayName(v.s)}）`}
        onClick={() => openTodo(todo.href)}
      >
        {todo.label}
      </Button>
    );
  };
  const primaryAction = (v: StationView) => todoAction(v) || (v.archived ? (
    <Button
      type="text"
      size="small"
      icon={<Icon name="restore" />}
      loading={!!restoringIds[v.s.id]}
      aria-label={COPY.restoreOne(stationDisplayName(v.s))}
      onClick={() => onRestore(v.s)}
    >
      {COPY.restore}
    </Button>
  ) : (
    <Button
      type="text"
      size="small"
      icon={<Icon name="edit" />}
      aria-label={COPY.editOne(stationDisplayName(v.s))}
      onClick={(e) => openEditor(v.s, e.currentTarget)}
    >
      {COPY.edit}
    </Button>
  ));

  const issueBox = (v: StationView) => {
    const issue = v.issue;
    if (!issue) return null;
    return (
      <div className="jy-stations-issue">
        <Sym kind="crit" />
        <div className="jy-stations-issue-body">
          <b>{testReadText({ ok: false, reason: issue.text })}</b>
          {v.checkedAt ? <span>{formatAsOf(v.checkedAt, tz)}</span> : null}
          <ErrorDetail raw={issue.raw} />
        </div>
        <Button size="small" icon={<Icon name="test" />} loading={!!retestingIds[v.s.id]} onClick={() => onRetest(v.s)}>
          {TEST_READ}
        </Button>
      </div>
    );
  };

  // ---- 列表主体 -------------------------------------------------------------
  const addButton = (
    <Button type="primary" icon={<Icon name="plus" />} disabled={!canAdd} onClick={(e) => openEditor(null, e.currentTarget)}>
      {UPSTREAM_FORM_TEXT.create}
    </Button>
  );

  let body;
  if (!loaded && !loadError) {
    body = (
      <div className="jy-stations-skeleton" aria-busy="true">
        <span className="sr-only">{LOADING_TEXT}</span>
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={40} />)}
      </div>
    );
  } else if (!loaded) {
    body = <ErrorState what={COPY.readFailed} error={loadError} onRetry={retryAll} />;
  } else if (!stations.length) {
    body = (
      <EmptyState
        title={NO_UPSTREAM_TEXT}
        desc={COPY.emptyDesc}
        action={addButton}
      />
    );
  } else if (!live.length && filter !== "archived" && paused.length) {
    body = (
      <EmptyState
        title={COPY.pausedTitle}
        desc={COPY.pausedDesc(paused.length)}
        action={addButton}
      />
    );
  } else if (!live.length && filter !== "archived") {
    body = (
      <EmptyState
        title={COPY.archivedOnlyTitle}
        desc={COPY.archivedOnlyDesc(archived.length)}
        action={addButton}
      />
    );
  } else {
    body = (
      <>
        <span id={EDIT_HINT_ID} className="sr-only">{COPY.editHint}</span>
        <div className="jy-table-wrap has-mobile">
          <table className="jy-data jy-stations-table">
            <caption className="sr-only">{STATION_TABS.list}</caption>
            <thead>
              <tr>
                <th scope="col" className="jy-stations-pin-l">{COPY.col.name}</th>
                <th scope="col">{COPY.col.status}</th>
                <th scope="col" className="r">{COPY.col.balance}</th>
                <th scope="col" className="r">{COPY.col.burn}</th>
                <th scope="col" aria-sort={ariaSort}>
                  <button type="button" className="jy-stations-sort" onClick={() => setSort(nextSort[sort])}>
                    {COPY.col.days}
                    {sort ? <Icon name={sort === "days" ? "sort" : "sort-down"} /> : null}
                  </button>
                </th>
                <th scope="col" className="r jy-stations-pin-r">{COPY.col.actions}</th>
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
                    {COPY.noMatch}
                    {filtered ? <Button type="link" onClick={clearFilters}>{COPY.clearFilters}</Button> : null}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <ul className="jy-m-list jy-stations-m" aria-label={STATION_TABS.list}>
          {rows.map((v) => {
            const b = v.s.balance;
            const name = stationDisplayName(v.s);
            const money = !v.fixed && b?.ok ? balanceMoneyOf(v.s, Number(b.remaining)) : null;
            const { label, level, note, stale, title } = statusOf(v);
            const todo = todoAction(v);
            const refreshing = !!refreshingIds[v.s.id];
            // 手机上一张卡片两行（ui-design-spec §4.7、§5.2）：名称、状态、「⋯」；余额 · 可用天数，后面带正在刷新或数据截至。
            // 有要处理的事时多一行：那件事的标题（放不下省略）和按钮。余额设了汇率只写金额，没设置汇率照写「（没设置汇率）」，
            // 不让人当成人民币。小图、刷新、编辑、余额趋势都在「⋯」里，点名称也能编辑
            return (
              <li key={v.id}>
                <button type="button" className="m-top link" title={name} aria-describedby={EDIT_HINT_ID} onClick={(e) => openEditor(v.s, e.currentTarget)}>{name}</button>
                <span className="m-end">
                  {label ? <StatusText level={level}>{label}</StatusText> : null}
                  {v.archived ? null : moreButton(v, true)}
                </span>
                <div className="m-sub">
                  {v.fixed ? (
                    <span>{COPY.col.burn} <b>{v.fx ? formatMoney(v.fx.daily) : EMPTY}</b></span>
                  ) : (
                    <span title={money?.cny ? `${money.full}，${money.note}` : money?.note}>{COPY.col.balance} <b>{money ? (money.cny ? money.text : money.full) : EMPTY}</b></span>
                  )}
                  {v.runway ? <span>{COPY.col.days} <b>{v.runway.text}</b></span> : null}
                  {refreshing || stale ? subLine(note!, stale) : null}
                </div>
                {todo ? (
                  <div className="m-todo-line">
                    {title ? <span className="m-title" title={title}>{title}</span> : null}
                    <span className="m-todo">{todo}</span>
                  </div>
                ) : null}
                {!v.archived && v.issue ? <div className="jy-stations-m-issue">{issueBox(v)}</div> : null}
                {v.archived ? (
                  <div className="m-actions">
                    {primaryAction(v)}
                    {moreButton(v, true)}
                  </div>
                ) : null}
              </li>
            );
          })}
          {!rows.length ? (
            <li>
              <span className="jy-muted">{COPY.noMatch}</span>
              {filtered ? <Button type="link" size="small" onClick={clearFilters}>{COPY.clearFilters}</Button> : null}
            </li>
          ) : null}
        </ul>
      </>
    );
  }

  return (
    <div className="jy-page jy-stations">
      {/* 刷新失败但有上次读到的数据（§8.1）：「刷新失败，数据截至 14:30。」+ 原因，原文只进「查看详细原因」 */}
      {loadError && loaded ? (
        <RefreshFailedBanner asOf={refreshedAt} tz={tz} error={loadError} retrying={loadingList} onRetry={() => { reload().catch(() => {}); }} />
      ) : null}
      {metaError ? (
        <div className="jy-banner" role="alert">
          <Sym kind="warn" />
          <div className="jy-banner__body">
            <b>{types.length ? COPY.metaStale : COPY.metaFailed}</b>
            <p className="jy-caption">{noteOf(metaError).text}</p>
            <ErrorDetail raw={noteOf(metaError).raw} />
          </div>
          <Button size="small" loading={loadingMeta} onClick={() => { loadMeta().catch(() => {}); }}>{REFRESH}</Button>
        </div>
      ) : null}
      {accounts.top}

      <Tabs<View>
        tabs={[
          { key: "list", label: STATION_TABS.list },
          { key: "onboarding", label: STATION_TABS.onboarding },
          { key: "bills", label: STATION_TABS.bills },
        ]}
        active={view}
        onChange={setView}
        idPrefix="stations"
        label={COPY.views}
      />
      {/* 外层包一层：隐藏的标签面板不参与页面的间距；渠道接入与上游账单首次打开后保持挂载，切换标签不丢状态 */}
      <div>
        <TabPanel idPrefix="stations" tabKey="list" active={view === "list"}>
          <div className="jy-toolbar">
            <Input
              prefix={<Icon name="search" />}
              allowClear
              placeholder={COPY.search}
              aria-label={COPY.searchAria}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Seg<Filter>
              label={COPY.byStatus}
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((value) => ({ value, label: COPY.filter[value], count: counts[value] }))}
            />
            <Select
              className="jy-stations-type"
              aria-label={COPY.byType}
              value={typeFilter}
              onChange={(value: string) => setTypeFilter(value)}
              options={[{ value: "", label: COPY.allTypes }, ...types.map((t) => ({ value: t.value, label: t.label }))]}
            />
            <span className="spacer" />
            {/* 向每个在看余额的上游重新读一遍余额；顶栏的刷新只重新读本页 */}
            <Button icon={<Icon name="refresh" />} loading={refreshingAll} onClick={onRefreshAll}>{REFRESH}</Button>
            {addButton}
          </div>

          {filter === "attention" && unowned > 0 ? (
            <p className="jy-caption jy-stations-unowned">
              {COPY.unownedBefore(unowned)}<Link className="jy-link" href="/">{NAV_LABELS.home}</Link>{COPY.unownedAfter}
            </p>
          ) : null}
          <Panel body={false} label={STATION_TABS.list}>{body}</Panel>
        </TabPanel>

        <TabPanel idPrefix="stations" tabKey="onboarding" active={view === "onboarding"} keepMounted>
          <div className="jy-stations-onboarding">
            {/* 行内打开新的处理目标、或离开期间目录有变动时重新挂载（见 syncOnboarding） */}
            <ChannelOnboarding key={`${accounts.destinationSeq}-${onboardingSync.rev}`} compact={compact} onComplete={reloadAfterOnboarding} destination={accounts.destination} />
          </div>
        </TabPanel>

        <TabPanel idPrefix="stations" tabKey="bills" active={view === "bills"} keepMounted>
          {accounts.center}
        </TabPanel>
      </div>

      <Modal
        title={archiveTarget ? COPY.archiveTitle(stationDisplayName(archiveTarget)) : COPY.archive}
        open={!!archiveTarget}
        onCancel={() => setArchiveTarget(null)}
        onOk={onArchive}
        okText={COPY.archive}
        cancelText={COPY.cancel}
        confirmLoading={archiving}
        width={480}
      >
        <div className="jy-banner jy-banner--info">
          <Sym kind="info" />
          <div className="jy-banner__body">
            <b>{COPY.archiveWhat}</b>
            <p className="jy-caption">{COPY.archiveWhere}</p>
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
          {COPY.toDelete}
        </Button>
      </Modal>

      <Modal
        title={purgeTarget ? COPY.deleteTitle(purgeName) : DELETE.label}
        open={!!purgeTarget}
        onCancel={() => { setPurgeTarget(null); setPurgeConfirm(""); }}
        onOk={onPurge}
        okText={DELETE.label}
        cancelText={COPY.cancel}
        confirmLoading={purging}
        okButtonProps={{ danger: true, disabled: !purgeMatches }}
        width={480}
      >
        <div className="jy-banner jy-banner--crit">
          <Sym kind="crit" />
          <div className="jy-banner__body">
            <b>{COPY.deleteWhat}</b>
            <p className="jy-caption">{COPY.deleteDesc}</p>
          </div>
        </div>
        <div className="jy-stations-confirm">
          <label className="jy-caption" htmlFor="jy-stations-purge-input">{COPY.deleteConfirm}<b>{purgeName}</b></label>
          <Input
            id="jy-stations-purge-input"
            autoFocus
            aria-label={COPY.deleteConfirmAria(purgeName)}
            value={purgeConfirm}
            onChange={(event) => setPurgeConfirm(event.target.value)}
            onPressEnter={() => { if (purgeMatches && !purging) onPurge(); }}
            placeholder={purgeName}
            autoComplete="off"
          />
        </div>
      </Modal>

      {accounts.overlays}

      <TrendModal station={trendCur} onClose={() => setTrendStation(null)} settings={settings} rules={rules} tz={tz} />

      <StationDrawer ref={drawerRef} types={types} onSaved={onSaved} />
    </div>
  );
}
