"use client";
// 炬元控制台外壳：保留 ProLayout 的响应式导航能力，定制品牌区、导航与全局动作。
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ProLayout } from "@ant-design/pro-components";
import { App, Avatar, Button, Dropdown, Grid, theme as antdTheme } from "antd";
import {
  AppstoreOutlined,
  ClusterOutlined,
  ApiOutlined,
  BarChartOutlined,
  FundOutlined,
  AuditOutlined,
  BellOutlined,
  SettingOutlined,
  ReloadOutlined,
  LogoutOutlined,
  UserOutlined,
  MoonOutlined,
  SunOutlined,
} from "@ant-design/icons";
import { api } from "../../lib/client";
import { BRAND, formatPageTitle, NAV_LABELS } from "../../lib/brand";
import BrandMark from "../components/brand-mark";
import { useThemeMode } from "../providers";

// 侧栏菜单（path 即 App Router 路由）
const menuRoute = {
  path: "/",
  routes: [
    { path: "/", name: NAV_LABELS.home, icon: <AppstoreOutlined /> },
    { path: "/stations", name: NAV_LABELS.stations, icon: <ClusterOutlined /> },
    { path: "/my", name: NAV_LABELS.my, icon: <ApiOutlined /> },
    { path: "/usage", name: NAV_LABELS.usage, icon: <BarChartOutlined /> },
    { path: "/analytics", name: NAV_LABELS.analytics, icon: <FundOutlined /> },
    { path: "/reconciliation", name: NAV_LABELS.reconciliation, icon: <AuditOutlined /> },
    { path: "/notifications", name: NAV_LABELS.notifications, icon: <BellOutlined /> },
    { path: "/settings", name: NAV_LABELS.settings, icon: <SettingOutlined /> },
  ],
};

const passwordChangeRoute = {
  path: "/settings",
  routes: [{ path: "/settings", name: NAV_LABELS.settings, icon: <SettingOutlined /> }],
};

const pageNames = Object.fromEntries(menuRoute.routes.map((route) => [route.path, route.name]));

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { message } = App.useApp();
  const { dark, toggle } = useThemeMode();
  const { token } = antdTheme.useToken();
  const screens = Grid.useBreakpoint();
  const compactHeader = !screens.md;
  const isMobile = !screens.lg;
  const [username, setUsername] = useState<string>("");
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const currentPageName = passwordChangeRequired ? NAV_LABELS.settings : (pageNames[pathname] || BRAND.productName);

  useEffect(() => {
    setCollapsed(isMobile);
  }, [isMobile]);

  // 校验登录态；初始密码会话只能前往修改密码流程。
  useEffect(() => {
    api("/api/auth/me")
      .then((r) => {
        setUsername(r.username);
        setPasswordChangeRequired(!!r.isDefaultPassword);
        if (r.isDefaultPassword && pathname !== "/settings") router.replace("/settings");
      })
      .catch(() => {});
  }, [pathname, router]);

  // 手动全量刷新（对应 v1 标题栏的刷新按钮）
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await api("/api/refresh", { method: "POST", body: {} });
      message.success("已刷新全部站点");
    } catch (e: any) {
      message.error(e.message || "刷新失败");
    } finally {
      setRefreshing(false);
    }
  };

  // 退出登录：失败也照样回登录页（同 v1 logoutBtn）
  const onLogout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
    } catch {}
    router.push("/login");
  };

  return (
    <ProLayout
      className="dashboard-layout"
      title={BRAND.name}
      logo={<BrandMark size={30} inverse />}
      layout="side"
      fixSiderbar
      breakpoint="lg"
      siderWidth={240}
      collapsed={collapsed}
      onCollapse={setCollapsed}
      contentStyle={{ minWidth: 0 }}
      token={{
        bgLayout: token.colorBgLayout,
        sider: {
          colorMenuBackground: "#111827",
          colorBgMenuItemHover: "rgba(255, 255, 255, 0.07)",
          colorBgMenuItemActive: "rgba(127, 156, 255, 0.12)",
          colorBgMenuItemSelected: "rgba(127, 156, 255, 0.16)",
          colorTextMenu: "#B8C2D1",
          colorTextMenuActive: "#FFFFFF",
          colorTextMenuItemHover: "#FFFFFF",
          colorTextMenuSelected: "#FFFFFF",
          colorTextMenuTitle: "#FFFFFF",
          colorTextMenuSecondary: "#8F9BAA",
          colorMenuItemDivider: "rgba(255, 255, 255, 0.08)",
          colorBgCollapsedButton: "#182231",
          colorTextCollapsedButton: "#B8C2D1",
          colorTextCollapsedButtonHover: "#FFFFFF",
          paddingInlineLayoutMenu: 12,
          paddingBlockLayoutMenu: 8,
        },
        header: {
          colorBgHeader: token.colorBgContainer,
          colorBgScrollHeader: token.colorBgContainer,
          colorHeaderTitle: token.colorText,
          colorTextRightActionsItem: token.colorTextSecondary,
          colorBgRightActionsItemHover: token.colorFillTertiary,
        },
      }}
      route={passwordChangeRequired ? passwordChangeRoute : menuRoute}
      location={{ pathname: passwordChangeRequired ? "/settings" : pathname }}
      pageTitleRender={() => formatPageTitle(currentPageName)}
      menuHeaderRender={(_logo, _title, props) => (
        <div className="app-sider-brand">
          <BrandMark
            size={30}
            inverse
            showWordmark={!props?.collapsed}
            subtitle={BRAND.productDescriptor}
          />
        </div>
      )}
      headerTitleRender={() => (
        <div className="app-header-context">
          <BrandMark className="app-header-context__mark" size={26} />
          <span>
            <small>{BRAND.productName}</small>
            <strong>{currentPageName}</strong>
          </span>
        </div>
      )}
      menuItemRender={(item, dom) => (
        <a
          onClick={(e) => {
            e.preventDefault();
            if (item.path && item.path !== pathname) router.push(item.path);
            if (isMobile) setCollapsed(true);
          }}
        >
          {dom}
        </a>
      )}
      actionsRender={() => passwordChangeRequired ? [] : [
        <Button
          key="refresh"
          className="touch-icon-button"
          type="text"
          icon={<ReloadOutlined />}
          loading={refreshing}
          onClick={onRefresh}
          title="刷新全部"
          aria-label="刷新全部站点"
        />,
      ]}
      avatarProps={{
        icon: <UserOutlined />,
        size: "small",
        title: compactHeader ? undefined : username || "…",
        render: () => (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: passwordChangeRequired ? [
                { key: "logout", icon: <LogoutOutlined />, label: "退出登录" },
              ] : [
                {
                  key: "theme",
                  icon: dark ? <SunOutlined /> : <MoonOutlined />,
                  label: dark ? "切换为浅色主题" : "切换为深色主题",
                },
                { key: "settings", icon: <SettingOutlined />, label: NAV_LABELS.settings },
                { type: "divider" },
                { key: "logout", icon: <LogoutOutlined />, label: "退出登录" },
              ],
              onClick: ({ key }) => {
                if (key === "theme") toggle();
                if (key === "settings") router.push("/settings");
                if (key === "logout") onLogout();
              },
            }}
          >
            <button
              type="button"
              className="header-avatar-trigger"
              aria-label={username ? `用户菜单，当前用户 ${username}` : "用户菜单"}
            >
              <Avatar icon={<UserOutlined />} size={28} />
              {compactHeader ? null : <span>{username || "…"}</span>}
            </button>
          </Dropdown>
        ),
      }}
      footerRender={false}
    >
      {children}
    </ProLayout>
  );
}
