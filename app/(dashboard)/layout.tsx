"use client";
// 面板壳：ProLayout 侧栏导航 + 顶栏动作（手动刷新 / 用户下拉退出）+ 页脚版本号
// 导航结构对照 v1 index.html 侧栏：总览/中转站/我的站点/用量统计/经营分析/通知/设置
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ProLayout } from "@ant-design/pro-components";
import { App, Avatar, Button, Dropdown, Grid, theme as antdTheme } from "antd";
import {
  AppstoreOutlined,
  ClusterOutlined,
  LineChartOutlined,
  BarChartOutlined,
  FundOutlined,
  BellOutlined,
  SettingOutlined,
  ReloadOutlined,
  LogoutOutlined,
  UserOutlined,
  MoonOutlined,
  SunOutlined,
} from "@ant-design/icons";
import { api } from "../../lib/client";
import { useThemeMode } from "../providers";

// 侧栏菜单（path 即 App Router 路由）
const menuRoute = {
  path: "/",
  routes: [
    { path: "/", name: "总览", icon: <AppstoreOutlined /> },
    { path: "/stations", name: "中转站", icon: <ClusterOutlined /> },
    { path: "/my", name: "我的站点", icon: <LineChartOutlined /> },
    { path: "/usage", name: "用量统计", icon: <BarChartOutlined /> },
    { path: "/analytics", name: "经营分析", icon: <FundOutlined /> },
    { path: "/notifications", name: "通知", icon: <BellOutlined /> },
    { path: "/settings", name: "设置", icon: <SettingOutlined /> },
  ],
};

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
  const [appInfo, setAppInfo] = useState<{ version: string; commit: string | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(isMobile);
  }, [isMobile]);

  // 挂载时校验登录态（401 由 api() 自动跳转 /login），并取版本号
  useEffect(() => {
    api("/api/auth/me")
      .then((r) => setUsername(r.username))
      .catch(() => {});
    api("/api/meta")
      .then((m) => setAppInfo(m.app))
      .catch(() => {});
  }, []);

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
      title="中转站余额监控"
      logo={<LineChartOutlined style={{ fontSize: 22, color: "#1677ff" }} />}
      layout="side"
      fixSiderbar
      breakpoint="lg"
      collapsed={collapsed}
      onCollapse={setCollapsed}
      contentStyle={{ minWidth: 0 }}
      route={menuRoute}
      location={{ pathname }}
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
      actionsRender={() => [
        <Button
          key="theme"
          className="touch-icon-button"
          type="text"
          icon={dark ? <SunOutlined /> : <MoonOutlined />}
          onClick={toggle}
          title={dark ? "切换浅色" : "切换深色"}
          aria-label={dark ? "切换浅色主题" : "切换深色主题"}
        />,
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
            menu={{
              items: [{ key: "logout", icon: <LogoutOutlined />, label: "退出登录" }],
              onClick: ({ key }) => {
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
      footerRender={() => (
        <div style={{ textAlign: "center", padding: "12px 0", fontSize: 12, color: token.colorTextTertiary }}>
          中转站余额监控
          {appInfo ? ` v${appInfo.version}${appInfo.commit ? ` (${appInfo.commit})` : ""}` : ""}
        </div>
      )}
    >
      {children}
    </ProLayout>
  );
}
