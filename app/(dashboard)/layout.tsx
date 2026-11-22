"use client";
// 统一导航与工作区；页面注册自己的数据时间、刷新动作和时间范围。
// 页面通过 useShellPage 注册刷新动作、数据时间和时间范围控件，外壳只负责摆放。
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { App, Dropdown } from "antd";
import { api } from "../../lib/client";
import { visibleInterval } from "../../lib/visible-interval.js";
import { formatAsOf, formatAsOfTime } from "../../lib/format";
import { failureText } from "../../lib/error-copy";
import { workflowActionMeta } from "../../lib/workflow-actions";
import { BRAND, formatPageTitle, NAV_LABELS } from "../../lib/brand";
import { NAV_GROUPS, NAV_ITEMS, navItemFor } from "../../lib/nav";
import { buildOverviewActions } from "../../lib/overview-actions";
import BrandMark from "../components/brand-mark";
import { Icon } from "../components/icons";
import type { IconName } from "../components/icons";
import { ShellContext } from "../components/shell-context";
import type { ShellPage } from "../components/shell-context";
import { useThemeMode } from "../providers";
import { useWorkflowActions } from "../components/use-workflow-actions";

const SIDER_KEY = "jy-sider";
const COUNT_POLL_MS = 60_000;
const STALE_MS = 10 * 60_000;

// 页面没声明时沿用 60 秒的说法；null 表示本页（或当前时间范围）不自动刷新
const autoRefreshHint = (ms: number | null | undefined) => ms === null ? "当前时间范围不自动刷新，可点右侧刷新"
  : `数据每 ${ms == null ? "60 秒" : ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${Math.round(ms / 1000)} 秒`}自动刷新`;

// 「数据截至 14:20，已经 10 分钟没更新。」（§8.1）；一小时以上写小时
const staleText = (asOf: number, now: number, tz: string | undefined) => {
  const minutes = Math.floor((now - asOf) / 60_000);
  const gap = minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时`;
  return `${formatAsOf(asOf, tz, now)}，已经 ${gap}没更新。`;
};
// 页面没给业务时区时按浏览器所在时区写，和原来一样
const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// 运营总览的需处理条数：与总览页「需处理」同一套规则。
// 账号与账单待办只读总览、上游资源页已经取到的那份：账单待办要在服务端跑一遍全部核算，
// 不能让每个页面的侧栏都去触发
function useAttentionCount(enabled: boolean) {
  const [source, setSource] = useState<{ stations: any[]; meta: any } | null>(null);
  const { actions: workflowActions } = useWorkflowActions(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let meta: any = null;
    const load = async () => {
      try {
        if (!meta) meta = await api("/api/meta");
        const r = await api("/api/stations");
        const stations = Array.isArray(r) ? r : r?.stations || [];
        if (alive) setSource({ stations, meta });
      } catch {}
    };
    load();
    const stop = visibleInterval(load, COUNT_POLL_MS);
    return () => {
      alive = false;
      stop();
    };
  }, [enabled]);
  return useMemo(() => {
    if (!enabled || !source) return { count: 0, own: undefined };
    const count = buildOverviewActions(source.stations, {
      tz: source.meta?.tz || undefined,
      rules: source.meta?.rules || {},
      settings: source.meta?.settings || {},
      workflowActions,
    }).all.length;
    return { count, own: source.stations.find((station) => station.isOwn && !station.archivedAt) || null };
  }, [enabled, source, workflowActions]);
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { message } = App.useApp();
  const { dark, toggle } = useThemeMode();
  const [username, setUsername] = useState("");
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPageState] = useState<ShellPage>({});
  const [now, setNow] = useState(() => Date.now());
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const siderRef = useRef<HTMLElement>(null);

  const current = navItemFor(pathname);
  const title = passwordChangeRequired ? NAV_LABELS.settings : current?.label || BRAND.productName;
  const { count: attentionCount, own: ownStation } = useAttentionCount(!passwordChangeRequired);

  useEffect(() => {
    document.title = formatPageTitle(title);
  }, [title]);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDER_KEY) === "collapsed");
    } catch {}
  }, []);

  // "数据截至"的新鲜度判断需要时钟走动
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // 校验登录态；初始密码会话只能前往修改密码流程
  useEffect(() => {
    api("/api/auth/me")
      .then((r) => {
        setUsername(r.username);
        setPasswordChangeRequired(!!r.isDefaultPassword);
        if (r.isDefaultPassword && pathname !== "/settings") router.replace("/settings");
      })
      .catch(() => {});
  }, [pathname, router]);

  // 移动端抽屉：换页即关；Esc 关闭并把焦点还给菜单按钮
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    siderRef.current?.querySelector<HTMLElement>("a[aria-current='page'], a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNavOpen(false);
        menuBtnRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDER_KEY, c ? "expanded" : "collapsed");
      } catch {}
      return !c;
    });

  const setPage = useCallback((p: ShellPage) => setPageState(p), []);
  const clearPage = useCallback(() => setPageState({}), []);
  const shellApi = useMemo(() => ({ setPage, clearPage, refreshing }), [setPage, clearPage, refreshing]);

  // 刷新本页数据；没有注册刷新的页面（设置、告警中心）不显示刷新按钮，
  // 避免在这些页面误触发"刷新全部上游"
  const onRefresh = async () => {
    if (refreshing || !page.onRefresh) return;
    setRefreshing(true);
    try {
      await page.onRefresh();
    } catch (e: any) {
      message.error(failureText(`${workflowActionMeta("refresh")!.label}失败`, e));
    } finally {
      setRefreshing(false);
    }
  };

  // 退出登录：失败也照样回登录页
  const onLogout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
    } catch {}
    router.push("/login");
  };

  const groups = passwordChangeRequired
    ? [{ label: "系统", items: NAV_ITEMS.filter((it) => it.key === "settings") }]
    : NAV_GROUPS;
  const asOf = page.asOf ?? null;
  const stale = asOf != null && now - asOf > STALE_MS;
  const initial = (username || "管").slice(0, 1).toUpperCase();
  const range = passwordChangeRequired ? null : page.range;

  return (
    <ShellContext.Provider value={shellApi}>
      <div className={`jy-shell${collapsed ? " is-collapsed" : ""}${navOpen ? " is-nav-open" : ""}`}>
        <aside className="jy-sider" id="jy-sider" ref={siderRef} aria-label="主导航">
          <div className="jy-brand-row">
            <Link href="/" className="jy-brand" aria-label={`${BRAND.productName}，回到${NAV_LABELS.home}`}>
              <BrandMark size={34} />
              <div>
                <strong>{BRAND.name}</strong>
                <small>运营控制台</small>
              </div>
            </Link>
            <button
              type="button"
              className="jy-collapse-btn"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "展开导航" : "收起导航"}
              aria-expanded={!collapsed}
            >
              <Icon name={collapsed ? "expand" : "collapse"} />
            </button>
          </div>
          {!passwordChangeRequired && ownStation?.baseUrl && <a className="jy-workspace" href={`${ownStation.baseUrl.replace(/\/+$/, "")}/dashboard`} target="_blank" rel="noopener noreferrer" aria-label={`${ownStation.name}主站，打开主站控制台`} title="打开主站控制台">
            <span className="jy-workspace-dot" aria-hidden="true" />
            <span className="jy-workspace-name">{ownStation.name}主站</span>
            <Icon name="external" />
          </a>}
          <nav className="jy-nav">
            {groups.map((g) => (
              <Fragment key={g.label}>
                <div className="jy-nav-group">{g.label}</div>
                {g.items.map((it) => {
                  const active = current?.key === it.key || (passwordChangeRequired && it.key === "settings");
                  const count = it.key === "home" ? attentionCount : 0;
                  return (
                    <Link
                      key={it.key}
                      href={it.path}
                      aria-current={active ? "page" : undefined}
                      aria-label={count > 0 ? `${it.label}，需处理 ${count} 项` : it.label}
                      title={it.label}
                    >
                      <Icon name={it.icon as IconName} />
                      <span className="label">{it.label}</span>
                      {count > 0 && (
                        <>
                          <span className="jy-nav-count" aria-hidden="true">{count}</span>
                          <span className="sr-only">，需处理 {count} 项</span>
                        </>
                      )}
                    </Link>
                  );
                })}
              </Fragment>
            ))}
          </nav>
          {/* 窄屏顶栏放不下账户菜单，账户与退出登录放在导航抽屉底部 */}
          <div className="jy-sider-account">
            <span className="jy-avatar" aria-hidden="true">{initial}</span>
            <span className="grow">{username || "当前账号"}</span>
            <button type="button" className="jy-sider-logout" onClick={onLogout}>
              <Icon name="logout" />
              退出登录
            </button>
          </div>
        </aside>
        <div className="jy-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

        <div className="jy-main">
          <header className="jy-topbar">
            <button
              ref={menuBtnRef}
              type="button"
              className="jy-icon-btn jy-menu-btn"
              aria-label={navOpen ? "关闭导航" : "打开导航"}
              aria-controls="jy-sider"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((o) => !o)}
            >
              <Icon name="menu" />
            </button>
            <div className="jy-breadcrumb"><span>{current?.key === "settings" || current?.key === "notifications" ? "管理" : ["stations", "usage", "analytics"].includes(current?.key || "") ? "资源与分析" : "工作空间"}</span><span aria-hidden="true">/</span><span>{title}</span></div>
            <div className="jy-topbar-spacer" />
            {asOf != null && (
              <span
                className={`jy-freshness${stale ? " is-stale" : ""}`}
                title={stale ? staleText(asOf, now, page.tz || localTz()) : autoRefreshHint(page.autoRefreshMs)}
              >
                <i className="dot" aria-hidden="true" />
                <span className="txt">数据截至</span>
                <span className="jy-num">{formatAsOfTime(asOf, page.tz || localTz(), now)}</span>
              </span>
            )}
            {!passwordChangeRequired && page.onRefresh && (
              <button
                type="button"
                className={`jy-icon-btn${refreshing ? " jy-spinning" : ""}`}
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="刷新当前页面数据"
                title="刷新当前页面数据"
              >
                <Icon name="refresh" />
              </button>
            )}
            <button
              type="button"
              className="jy-icon-btn"
              onClick={toggle}
              aria-label={dark ? "切换到浅色模式" : "切换到深色模式"}
              title={dark ? "切换到浅色模式" : "切换到深色模式"}
            >
              <Icon name="theme" />
            </button>
            <Dropdown
              trigger={["click"]}
              placement="bottomRight"
              menu={{
                items: [
                  { key: "user", label: username ? `当前账号：${username}` : "当前账号", disabled: true },
                  { type: "divider" },
                  ...(passwordChangeRequired
                    ? []
                    : [{ key: "settings", icon: <Icon name="gear" />, label: NAV_LABELS.settings }]),
                  { key: "logout", icon: <Icon name="logout" />, label: "退出登录" },
                ],
                onClick: ({ key }) => {
                  if (key === "settings") router.push("/settings");
                  if (key === "logout") onLogout();
                },
              }}
            >
              <button type="button" className="jy-avatar" aria-label={username ? `账号菜单，当前账号 ${username}` : "账号菜单"}>
                {initial}
              </button>
            </Dropdown>
          </header>

          <main className={`jy-content${refreshing ? " is-refreshing" : ""}`} aria-busy={refreshing || undefined}>
            <div className="jy-page-head"><div className="jy-page-title"><h1>{title}</h1>{page.subtitle ? <p>{page.subtitle}</p> : null}</div>{range || page.headingExtra ? <div className="jy-page-actions">{range ? <div className="jy-page-range">{range}</div> : null}{page.headingExtra}</div> : null}</div>
            {/* 页面用 useSearchParams 保存筛选状态，需要 Suspense 边界 */}
            <Suspense fallback={null}>{children}</Suspense>
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}
