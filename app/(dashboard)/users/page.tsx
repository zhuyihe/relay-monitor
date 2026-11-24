"use client";
// 用户运营：自营站点上用户的消费、余额，谁在涨、谁在掉、谁快用完了（design 用户运营 v5–v8）。
// 概览、用户取 /api/users 的本地结果；流失与渠道分组页签打开才取。分组消费独立选择日期，余额始终显示当前值。
// 页签、用户表的筛选（范围、只看重点用户、状态、分组）和排法、页码、打开的用户都写进地址栏，刷新、分享链接、后退键都回到同一屏；用户表在服务端筛选、分页，筛选一变就重新来取。
import "../../styles/pages/users.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "antd";
import { api } from "../../../lib/client";
import { visibleInterval } from "../../../lib/visible-interval.js";
import { NAV_LABELS } from "../../../lib/brand";
import { formatZonedTime, OWN_STATION_UNSET_STEP, OWN_STATION_UNSET_TITLE } from "../../../lib/format";
import { describeError } from "../../../lib/error-copy";
import { workflowAction } from "../../../lib/workflow-actions";
import { ErrorState, Onboarding, PanelSkeleton, RefreshFailedBanner } from "../../components/data-state";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/panel";
import { TabPanel, Tabs } from "../../components/seg";
import type { TabDef } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { TimeRangePicker } from "../../components/time-range-picker";
import { UserGroupsTab } from "./user-groups-tab";
import type { GroupQuery, UserGroupsPage } from "./user-groups-tab";
import { useUrlParams } from "../../components/use-url-state";
import { COPY } from "./copy";
import type { UsersTab as TabKey } from "./copy";
import { ChurnTab } from "./churn-tab";
import { OverviewTab } from "./overview-tab";
import { UserDrawer } from "./user-drawer";
import { UsersTab } from "./users-tab";
import { OPEN_TABS, TABS, backfillLine, balanceWarmLine, churnQueryString, listQueryString, parseChurnOnly, parseGroups, parseOnly, parsePageNo, parseScope, parseSort, parseTab } from "./users-format";
import type { ChurnPage, ChurnQuery, ListQuery, UsersPage } from "./users-format";

const SETUP = workflowAction("setup_own_station");
const GROUP_RANGES = [{ value: "today", label: "今天" }, { value: "yesterday", label: "昨天" }, { value: "7d", label: "近 7 天" }, { value: "month", label: "本月" }];
const TAB_DEFS: TabDef<TabKey>[] = TABS.map((key) => ({
  key,
  label: COPY.tabs[key],
  ...(OPEN_TABS.includes(key) ? {} : { disabled: true, note: COPY.comingSoon }),
}));

export default function UsersPageRoute() {
  const [params, setParams] = useUrlParams();
  const tab = parseTab(params.get("tab"));
  const sort = parseSort(params.get("sort"), params.get("dir"));
  const urlQuery: Omit<ListQuery, "q"> = {
    scope: parseScope(params.get("scope")), big: params.get("big") === "1", only: parseOnly(params.get("only")), groups: parseGroups(params.get("group")),
    sort: sort.key, dir: sort.dir, page: parsePageNo(params.get("page")),
  };
  // 搜索的字不进地址栏（打一个字改一次地址太吵），只跟着这一屏走
  const [q, setQ] = useState("");
  const query: ListQuery = useMemo(() => ({ ...urlQuery, q }), [params.toString(), q]);
  const queryString = listQueryString(query);
  const churnQuery: ChurnQuery = useMemo(() => ({ only: parseChurnOnly(params.get("only")), big: params.get("big") === "1", page: parsePageNo(params.get("page")), q }), [params.toString(), q]);
  const churnQs = churnQueryString(churnQuery);
  const userId = /^\d+$/.test(params.get("user") || "") ? Number(params.get("user")) : null;

  const [page, setPage] = useState<UsersPage | null>(null);
  const pollMs = 15_000; // 只读取本地快照，源站同步仍按设置的节拍进行。
  const [err, setErr] = useState<Error | null>(null);
  const [unset, setUnset] = useState(false);
  const [loading, setLoading] = useState(false);
  // 筛选连着改几次，只认最后一次发出去的那个请求的结果
  const latest = useRef(0);

  const load = useCallback(async (rethrow = false, sync = false) => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const res = await api(`/api/users${queryString ? `?${queryString}` : ""}`, sync ? { method: "POST" } : undefined);
      if (mine !== latest.current) return;
      setPage(res);
      setUnset(false);
      setErr(null);
      if (rethrow && res.syncErrors?.length) throw new Error(COPY.syncPartial);
    } catch (e: any) {
      if (mine !== latest.current) return;
      // 没设置自营站点是引导场景，不当错误（接口带 OWN_STATION_UNSET）
      if (describeError(e).category === "unset") { setUnset(true); setErr(null); return; }
      setErr(e);
      if (rethrow) throw e;
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    load();
    return visibleInterval(() => load(), pollMs);
  }, [load, pollMs]);

  // 流失页签：打开才取（后台只读库、读一个近 30 天的流向），每 60 秒再取；筛选一变就重取
  const [churn, setChurn] = useState<ChurnPage | null>(null);
  const [churnErr, setChurnErr] = useState<Error | null>(null);
  const [churnLoading, setChurnLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const latestChurn = useRef(0);
  const loadChurn = useCallback(async (rethrow = false, readModels = false) => {
    const mine = ++latestChurn.current;
    setChurnLoading(true);
    if (readModels) setModelsLoading(true);
    try {
      const res = await api(`/api/users/churn${churnQs ? `?${churnQs}` : ""}`, readModels ? { method: "POST" } : undefined);
      if (mine !== latestChurn.current) return;
      setChurn(res);
      setChurnErr(null);
    } catch (e: any) {
      if (mine !== latestChurn.current) return;
      setChurnErr(e);
      if (rethrow) throw e;
    } finally {
      if (mine === latestChurn.current) setChurnLoading(false);
      if (readModels) setModelsLoading(false);
    }
  }, [churnQs]);
  const churnOn = tab === "churn" && !!page && !page.starting && !page.basicOnly;
  useEffect(() => {
    if (!churnOn) return;
    loadChurn();
    return visibleInterval(() => loadChurn(), 60_000);
  }, [churnOn, loadChurn]);

  const [groupSearch, setGroupSearch] = useState("");
  const groupPreset = params.get("groupsRange") || "today";
  const groupStart = params.get("groupsStart"), groupEnd = params.get("groupsEnd");
  const groupQuery: GroupQuery = { q: groupSearch, channelGroup: params.get("channelGroup") || "", active: params.get("groupsActive") !== "false",
    sort: ["amount", "balance", "user"].includes(params.get("groupsSort") || "") ? params.get("groupsSort")! : "amount", dir: params.get("groupsDir") === "asc" ? "asc" : "desc", page: parsePageNo(params.get("groupsPage")) };
  const groupParams = new URLSearchParams({ preset: groupPreset, q: groupQuery.q, channelGroup: groupQuery.channelGroup, active: String(groupQuery.active), sort: groupQuery.sort, dir: groupQuery.dir, page: String(groupQuery.page) });
  if (groupPreset === "custom") { groupParams.set("startMs", groupStart || ""); groupParams.set("endMs", groupEnd || ""); }
  const groupListQs = groupParams.toString();
  if (userId != null) groupParams.set("user", String(userId));
  const groupsQs = groupParams.toString();
  const [groups, setGroups] = useState<UserGroupsPage | null>(null), [groupsKey, setGroupsKey] = useState("");
  const [groupsError, setGroupsError] = useState<any>(null), [groupsLoading, setGroupsLoading] = useState(false);
  const latestGroups = useRef(0);
  const loadGroups = useCallback(async (rethrow = false, refresh = false) => {
    const mine = ++latestGroups.current; setGroupsLoading(true);
    try {
      const result = await api(`/api/users/groups?${groupsQs}`, refresh ? { method: "POST" } : undefined);
      if (mine !== latestGroups.current) return;
      setGroups(result); setGroupsKey(groupListQs); setGroupsError(null);
      if (rethrow && result.error) throw Object.assign(new Error("渠道分组消费更新未完成"), { code: result.error });
    } catch (error) { if (mine !== latestGroups.current) return; setGroupsError(error); if (rethrow) throw error; }
    finally { if (mine === latestGroups.current) setGroupsLoading(false); }
  }, [groupsQs, groupListQs]);
  const groupsOn = tab === "groups" && !!page && !page.starting;
  useEffect(() => {
    if (!groupsOn) return;
    void loadGroups(); return visibleInterval(() => void loadGroups(), pollMs);
  }, [groupsOn, loadGroups, pollMs]);
  const groupsPage = groupsKey === groupListQs ? groups : null;
  const groupRangeKey = `${groupPreset}|${groupStart}|${groupEnd}`;
  const onGroupQuery = (patch: Partial<GroupQuery>) => {
    if (patch.q != null) setGroupSearch(patch.q);
    const next = { ...groupQuery, ...patch };
    setParams({ channelGroup: next.channelGroup || null, groupsActive: next.active ? null : "false", groupsSort: next.sort === "amount" ? null : next.sort,
      groupsDir: next.dir === "desc" ? null : next.dir, groupsPage: patch.page && patch.page > 1 ? String(patch.page) : null });
  };
  const groupsRange = useMemo(() => <TimeRangePicker value={{ preset: groupPreset, ...(groupStart ? { startMs: Number(groupStart) } : {}), ...(groupEnd ? { endMs: Number(groupEnd) } : {}) }}
    options={GROUP_RANGES} tz={page?.tz || "Asia/Shanghai"} custom={{ mode: "datetime", maxDays: 31 }} range={groupsPage ? { startMs: groupsPage.startMs, endMs: groupsPage.endMs } : undefined}
    onApply={value => setParams({ groupsRange: value.preset === "today" ? null : value.preset, groupsStart: value.preset === "custom" ? String(value.startMs) : null,
      groupsEnd: value.preset === "custom" ? String(value.endMs) : null, groupsPage: null, user: null })} />, [groupPreset, groupStart, groupEnd, page?.tz, groupsPage?.startMs, groupsPage?.endMs]);
  const onRefresh = useCallback(async () => {
    if (groupsOn) { await loadGroups(true, true); await load(true); return; }
    await load(true, true); if (churnOn) await loadChurn(true);
  }, [load, loadChurn, churnOn, groupsOn, loadGroups]);
  // 「数据截至」写后台最近一轮采集的时刻（页面取数的时刻不代表数据新）
  useShellPage({ onRefresh, asOf: tab === "groups" ? groupsPage?.asOf ?? null : unset || !page || page.starting ? null : page.syncedMs, range: tab === "groups" ? groupsRange : undefined, autoRefreshMs: page?.refreshIntervalMs ?? 60_000, tz: page?.tz });

  // 换页签：两个表的筛选各是各的，地址栏里的筛选、页码、排法、搜索的字都清掉
  const setTab = (next: TabKey) => {
    setQ(""); setGroupSearch("");
    setParams({ tab: next === "overview" ? null : next, scope: null, big: null, only: null, group: null, sort: null, dir: null, page: null, channelGroup: null, groupsActive: null, groupsSort: null, groupsDir: null, groupsPage: null, user: null });
  };
  const onChurnQuery = (patch: Partial<ChurnQuery>) => {
    if ("q" in patch) setQ(patch.q || "");
    const next = { ...churnQuery, ...patch };
    setParams({ only: next.only === "all" ? null : next.only, big: next.big ? "1" : null, page: "page" in patch && next.page > 1 ? String(next.page) : null });
  };
  // 改筛选都回到第 1 页（翻页本身不回）；搜索的字只在这一屏里，不进地址栏
  const onQuery = (patch: Partial<ListQuery>) => {
    if ("q" in patch) setQ(patch.q || "");
    const next = { ...urlQuery, ...patch };
    const defaultSort = next.sort === "balance" && next.dir === "asc";
    setParams({
      scope: next.scope === "active30" ? null : next.scope,
      big: next.big ? "1" : null,
      only: next.only === "all" ? null : next.only,
      group: next.groups.length ? next.groups.join(",") : null,
      sort: defaultSort ? null : next.sort,
      dir: defaultSort ? null : next.dir,
      page: "page" in patch && next.page > 1 ? String(next.page) : null,
    });
  };
  const openUser = (id: number) => setParams({ user: String(id) });
  const closeUser = () => setParams({ user: null });
  // 抽屉在打开前就要有 page：没有数据时不会走到这里
  const drawer = page && tab !== "groups" ? <UserDrawer id={userId} page={page} onClose={closeUser} /> : null;

  // 补数据那一行：补数据没完写进度，补完了余额还没记满 24 小时写余额那一句；两件事都好了自己消失
  const progress = tab !== "groups" && page && !page.starting && !page.basicOnly && !page.paused ? backfillLine(page, tab === "overview") || balanceWarmLine(page) : null;
  const stale = tab !== "groups" && !!page && !page.starting && !page.basicOnly && !page.paused && page.fresh === false;
  const enableSync = <Link href="/settings">{COPY.enableSync}</Link>;
  const userTable = page && <UsersTab page={page} query={query} loading={loading} onQuery={onQuery} onOpenUser={openUser} />;

  if (unset) {
    return (
      <div className="jy-page">
        <Onboarding
          title={OWN_STATION_UNSET_TITLE}
          desc={COPY.setupDesc}
          steps={[OWN_STATION_UNSET_STEP]}
          action={SETUP.href ? <Link href={SETUP.href}><Button type="primary" size="large">{SETUP.label}</Button></Link> : undefined}
          figureNote={COPY.setupFigure}
        />
      </div>
    );
  }
  if (!page) {
    if (err) {
      return (
        <div className="jy-page">
          <Panel label={NAV_LABELS.users}>
            <ErrorState center what={COPY.unreadable} error={err} onRetry={() => load()} />
          </Panel>
        </div>
      );
    }
    return (
      <div className="jy-page" aria-busy="true">
        <PanelSkeleton title={COPY.overview.chartTitle} height={300} />
      </div>
    );
  }

  return (
    <div className="jy-page jy-users-page">
      {err && !page.starting && <RefreshFailedBanner asOf={page.syncedMs} tz={page.tz} error={err} onRetry={() => load(false, true)} />}
      {!err && tab === "churn" && churn && churnErr && <RefreshFailedBanner asOf={churn.syncedMs} tz={page.tz} error={churnErr} onRetry={() => loadChurn()} />}
      <Tabs<TabKey> tabs={TAB_DEFS} active={tab} onChange={setTab} idPrefix="users" label={COPY.tabsLabel} />
      {tab !== "groups" && <div className="jy-users-data-note">
        {(page.todaySyncedMs != null || page.balanceSyncedMs != null) && <p className="jy-users-progress" role="status">
          {page.balanceSyncedMs != null && <span>{COPY.drawer.balanceReadAt(formatZonedTime(page.balanceSyncedMs, page.tz))}</span>}
          {page.todaySyncedMs != null && <span>{COPY.consumptionReadAt(formatZonedTime(page.todaySyncedMs, page.tz))}</span>}
        </p>}
        {tab !== "churn" && !page.basicOnly && <p className="jy-users-progress">{COPY.consumptionWindow}</p>}
      </div>}
      {!!page.syncErrors?.length && <p className="jy-users-progress" role="alert">{COPY.syncPartial}</p>}
      {page.paused && <p className="jy-users-progress" role="status">{COPY.syncPaused}{enableSync}</p>}
      {page.basicOnly && tab !== "groups" && <p className="jy-users-progress" role="status">{COPY.basicOnly}</p>}
      {progress && (
        <p className="jy-users-progress" role="status">
          <span className="jy-spinning"><Icon name="refresh" /></span>
          {progress}
        </p>
      )}
      {stale && <p className="jy-users-progress jy-muted">{COPY.users.staleNote}</p>}
      {page.starting ? (
        <Panel label={NAV_LABELS.users}>
          {err || page.directoryError
            ? <ErrorState center what={COPY.unreadable} error={err || { code: page.directoryError }} extra={
              !page.paused && <Button type="primary" loading={loading} onClick={() => load(false, true)}>{COPY.syncDirectory}</Button>
            } />
            : <div className="jy-state jy-state--center">
              <h3>{COPY.noData}</h3>
              {!page.paused && <div className="actions"><Button type="primary" loading={loading} onClick={() => load(false, true)}>{COPY.syncDirectory}</Button></div>}
            </div>}
        </Panel>
      ) : (
        <div>
          <TabPanel idPrefix="users" tabKey="overview" active={tab === "overview"}>
            {page.basicOnly ? tab === "overview" && userTable : <OverviewTab page={page} onOpenUser={openUser} />}
          </TabPanel>
          <TabPanel idPrefix="users" tabKey="users" active={tab === "users"}>
            {(!page.basicOnly || tab === "users") && userTable}
          </TabPanel>
          <TabPanel idPrefix="users" tabKey="groups" active={tab === "groups"}>
            {tab === "groups" && <UserGroupsTab data={groupsPage} base={page} query={groupQuery} rangeKey={groupRangeKey} userId={userId} loading={groupsLoading} error={groupsError}
              onQuery={onGroupQuery} onOpenUser={openUser} onCloseUser={closeUser} onRetry={() => void loadGroups(false, true)} />}
          </TabPanel>
          <TabPanel idPrefix="users" tabKey="churn" active={tab === "churn"}>
            {tab === "churn" && (page.basicOnly ? null : churn && !churn.starting
              ? <ChurnTab page={churn} users={page} query={churnQuery} loading={churnLoading} onQuery={onChurnQuery} onOpenUser={openUser} onShowReturned={() => onChurnQuery({ only: "returned" })} onReadModels={() => loadChurn(false, true)} modelsLoading={modelsLoading} />
              : churnErr
                ? <Panel label={COPY.tabs.churn}><ErrorState center what={COPY.unreadable} error={churnErr} onRetry={() => loadChurn()} /></Panel>
                : <PanelSkeleton title={COPY.churn.tableTitle} lines={4} />)}
          </TabPanel>
        </div>
      )}
      {drawer}
    </div>
  );
}
