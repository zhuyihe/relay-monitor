"use client";
// 全局 Provider：深浅色主题（cookie jy-theme，兼容迁移 v1 的 localStorage 键）+ PWA SW 注册
// antd 主题与 CSS 变量同出 lib/design-tokens.js，页面里不再手写色值。
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ConfigProvider, App, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { antdThemeConfig } from "../lib/design-tokens";
import { LEGACY_THEME_KEY, readLegacyTheme, writeThemeCookie } from "../lib/theme";

type ThemeMode = "light" | "dark";

const ThemeCtx = createContext<{ dark: boolean; toggle: () => void }>({
  dark: false,
  toggle: () => {},
});

export const useThemeMode = () => useContext(ThemeCtx);

export default function Providers({
  children,
  initialTheme = null,
}: {
  children: React.ReactNode;
  initialTheme?: ThemeMode | null;
}) {
  const [mode, setMode] = useState<ThemeMode>(initialTheme ?? "light");

  useEffect(() => {
    if (!initialTheme) {
      // 没有 cookie：内联脚本已按旧设置或系统偏好写好 data-theme，这里同步给 antd
      const legacy = readLegacyTheme();
      if (legacy) {
        writeThemeCookie(legacy);
        try { localStorage.removeItem(LEGACY_THEME_KEY); } catch {}
      }
      if (document.documentElement.dataset.theme === "dark") setMode("dark");
    }
    // PWA：注册 service worker（网络优先壳缓存，来自 v1.12）
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, [initialTheme]);

  // data-theme 只在用户切换时改写；首帧的值来自服务端或内联脚本
  const toggle = () => {
    const next: ThemeMode = mode === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    writeThemeCookie(next);
    setMode(next);
  };

  const themeConfig = useMemo(() => {
    const { token, components } = antdThemeConfig(mode);
    return {
      algorithm: mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token,
      components,
    };
  }, [mode]);

  return (
    <ThemeCtx.Provider value={{ dark: mode === "dark", toggle }}>
      <ConfigProvider locale={zhCN} theme={themeConfig} button={{ autoInsertSpace: false }}>
        <App>{children}</App>
      </ConfigProvider>
    </ThemeCtx.Provider>
  );
}
