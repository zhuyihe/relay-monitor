"use client";
// 炬元控制台外壳：深色侧栏（分组导航 + 待处理计数）+ 56px 顶栏（标题、时间范围、数据截至、刷新、主题、账户）。
// 页面通过 useShellPage 注册刷新动作、数据时间和时间范围控件，外壳只负责摆放。
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { App, Dropdown } from "antd";
import { api, statusOf } from "../../lib/client";
import { BRAND, formatPageTitle, NAV_LABELS } from "../../lib/brand";
import { NAV_GROUPS, NAV_ITEMS, navItemFor } from "../../lib/nav";
import { buildOverviewActions } from "../../lib/overview-actions";
import BrandMark from "../components/brand-mark";
import { Icon } from "../components/icons";
import type { IconName } from "../components/icons";
import { ShellContext } from "../components/shell-context";
import type { ShellPage } from "../components/shell-context";
import { useThemeMode } from "../providers";
import { loadWorkflowActions, useWorkflowActions } from "../components/use-workflow-actions";
import pkg from "../../package.json";

const SIDER_KEY = "jy-sider";
const COUNT_POLL_MS = 60_000;
const STALE_MS = 10 * 60_000;

const hhmm = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// 运营总览的待处理条数：与总览页"需要处理"同一套规则，账号与账单待办也算在内
function useAttentionCount(enabled: boolean) {
  const [source, setSource] = useState<{ stations: any[]; meta: any } | null>(null);
  const { actions: workflowActions } = useWorkflowActions(enabled);
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
      // 5 分钟内读过就直接用缓存
      void loadWorkflowActions();
    };
    load();
    const id = setInterval(load, COUNT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);
  return useMemo(() => {
    if (!enabled || !source) return 0;
    return buildOverviewActions(source.stations, {
      rules: source.meta?.rules || {},
      settings: source.meta?.settings || {},
      statusOf,
      workflowActions,
    }).all.length;
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
  const attentionCount = useAttentionCount(!passwordChangeRequired);

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

  // 刷新本页数据；没有注册刷新的页面（设置、告警中心、账单核算）不显示刷新按钮，
  // 避免在这些页面误触发"刷新全部上游"
  const onRefresh = async () => {
    if (refreshing || !page.onRefresh) return;
    setRefreshing(true);
    try {
      await page.onRefresh();
    } catch (e: any) {
      message.error(e?.message || "刷新失败");
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
          <Link href="/" className="jy-brand" aria-label={`${BRAND.productName}，回到${NAV_LABELS.home}`}>
            <BrandMark size={28} inverse />
            <div>
              <strong>{BRAND.name}</strong>
              <small>控制台</small>
            </div>
          </Link>
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
                      title={collapsed ? it.label : undefined}
                    >
                      <Icon name={it.icon as IconName} />
                      <span className="label">{it.label}</span>
                      {count > 0 && (
                        <>
                          <span className="jy-nav-count" aria-hidden="true">{count}</span>
                          <span className="sr-only">，{count} 项需要处理</span>
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
            <span className="grow">{username || "当前账户"}</span>
            <button type="button" className="jy-sider-logout" onClick={onLogout}>
              <Icon name="logout" />
              退出登录
            </button>
          </div>
          <div className="jy-sider-foot">
            <span className="grow">v{pkg.version}</span>
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
            <h1>{title}</h1>
            {range ? <div className="jy-topbar-range">{range}</div> : null}
            <div className="jy-topbar-spacer" />
            {asOf != null && (
              <span
                className={`jy-freshness${stale ? " is-stale" : ""}`}
                title={stale ? "数据已超过 10 分钟未更新，可点右侧刷新" : "数据每 60 秒自动刷新"}
              >
                <i className="dot" aria-hidden="true" />
                <span className="txt">数据截至</span>
                <span className="jy-num">{hhmm(asOf)}</span>
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
                  { key: "user", label: username ? `当前账户：${username}` : "当前账户", disabled: true },
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
              <button type="button" className="jy-avatar" aria-label={username ? `账户菜单，当前用户 ${username}` : "账户菜单"}>
                {initial}
              </button>
            </Dropdown>
          </header>

          <main className={`jy-content${refreshing ? " is-refreshing" : ""}`} aria-busy={refreshing || undefined}>
            {range ? <div className="jy-mobile-range">{range}</div> : null}
            {/* 页面用 useSearchParams 保存筛选状态，需要 Suspense 边界 */}
            <Suspense fallback={null}>{children}</Suspense>
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}
