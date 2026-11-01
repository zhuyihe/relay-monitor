"use client";
// 用户运营：自营站点上用户的消费、余额，谁在涨、谁在掉、谁快用完了（design 用户运营 v5–v8）。
// 数据来自 /api/users（后台每 10 分钟采集一轮，页面每 60 秒来取，不会多读自营站点）；顶栏没有时间范围：这一页的数口径固定（今天、近 7 天、近 30 天）。
// 页签、用户表的筛选（范围、只看重点用户、状态、分组）和排法、页码、打开的用户都写进地址栏，刷新、分享链接、后退键都回到同一屏；用户表在服务端筛选、分页，筛选一变就重新来取。
import "../../styles/pages/users.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "antd";
import { api } from "../../../lib/client";
import { NAV_LABELS } from "../../../lib/brand";
import { OWN_STATION_UNSET_STEP, OWN_STATION_UNSET_TITLE } from "../../../lib/format";
import { describeError } from "../../../lib/error-copy";
import { workflowAction } from "../../../lib/workflow-actions";
import { ErrorState, Onboarding, PanelSkeleton, RefreshFailedBanner } from "../../components/data-state";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/panel";
import { TabPanel, Tabs } from "../../components/seg";
import type { TabDef } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { useUrlParams } from "../../components/use-url-state";
import { COPY } from "./copy";
import type { UsersTab as TabKey } from "./copy";
import { OverviewTab } from "./overview-tab";
import { UserDrawer } from "./user-drawer";
import { UsersTab } from "./users-tab";
import { OPEN_TABS, TABS, backfillLine, balanceWarmLine, listQueryString, parseGroups, parseOnly, parsePageNo, parseScope, parseSort, parseTab } from "./users-format";
import type { ListQuery, UsersPage } from "./users-format";

const POLL_MS = 60_000;
const SETUP = workflowAction("setup_own_station");
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
  const userId = /^\d+$/.test(params.get("user") || "") ? Number(params.get("user")) : null;

  const [page, setPage] = useState<UsersPage | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [unset, setUnset] = useState(false);
  const [loading, setLoading] = useState(false);
  // 筛选连着改几次，只认最后一次发出去的那个请求的结果
  const latest = useRef(0);

  const load = useCallback(async (rethrow = false) => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const res = await api(`/api/users${queryString ? `?${queryString}` : ""}`);
      if (mine !== latest.current) return;
      setPage(res);
      setUnset(false);
      setErr(null);
      setAsOf(Date.now());
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
    const timer = setInterval(() => load(), POLL_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  const onRefresh = useCallback(() => load(true), [load]);
  // 「数据截至」写后台最近一轮采集的时刻（页面取数的时刻不代表数据新）
  useShellPage({ onRefresh, asOf: unset ? null : page && !page.starting ? page.syncedMs : asOf, autoRefreshMs: POLL_MS, tz: page?.tz });

  const setTab = (next: TabKey) => setParams({ tab: next === "overview" ? null : next });
  // 改筛选都回到第 1 页（翻页本身不回）；搜索的字只在这一屏里，不进地址栏
  const onQuery = (patch: Partial<ListQuery>) => {
    if ("q" in patch) setQ(patch.q || "");
    const next = { ...urlQuery, ...patch };
    const defaultSort = next.sort === "week" && next.dir === "desc";
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
  const drawer = page ? <UserDrawer id={userId} page={page} onClose={closeUser} /> : null;

  // 补数据那一行：补数据没完写进度，补完了余额还没记满 24 小时写余额那一句；两件事都好了自己消失
  const progress = page ? backfillLine(page, tab === "overview") || (page.starting ? null : balanceWarmLine(page)) : null;
  const stale = !!page && !page.starting && page.fresh === false;

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
    <div className="jy-page">
      {err && <RefreshFailedBanner asOf={asOf} tz={page.tz} error={err} onRetry={() => load()} />}
      <Tabs<TabKey> tabs={TAB_DEFS} active={tab} onChange={setTab} idPrefix="users" label={COPY.tabsLabel} />
      {progress && (
        <p className="jy-users-progress" role="status">
          <span className="jy-spinning"><Icon name="refresh" /></span>
          {progress}
        </p>
      )}
      {stale && <p className="jy-users-progress jy-muted">{COPY.users.staleNote}</p>}
      {page.starting ? (
        <>
          <PanelSkeleton title={COPY.overview.kpiToday} lines={2} />
          <PanelSkeleton title={COPY.overview.chartTitle} height={300} />
        </>
      ) : (
        <div>
          <TabPanel idPrefix="users" tabKey="overview" active={tab === "overview"}>
            <OverviewTab page={page} onOpenUser={openUser} />
          </TabPanel>
          <TabPanel idPrefix="users" tabKey="users" active={tab === "users"}>
            <UsersTab page={page} query={query} loading={loading} onQuery={onQuery} onOpenUser={openUser} />
          </TabPanel>
        </div>
      )}
      {drawer}
    </div>
  );
}
