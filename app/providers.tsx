"use client";
// 全局 Provider：深浅色主题（沿用 v1 的 localStorage 键 app-shell-theme）+ PWA SW 注册
import { createContext, useContext, useEffect, useState } from "react";
import { ConfigProvider, App, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";

const lightTokens = {
  colorPrimary: "#3157D5",
  colorInfo: "#3157D5",
  colorSuccess: "#137A63",
  colorWarning: "#A86400",
  colorError: "#C83C3C",
  colorBgBase: "#FFFFFF",
  colorBgLayout: "#F4F6F8",
  colorBgContainer: "#FFFFFF",
  colorBgElevated: "#FFFFFF",
  colorText: "#152033",
  colorTextSecondary: "#667085",
  colorTextTertiary: "#7A8494",
  colorBorder: "#DFE4EA",
  colorBorderSecondary: "#E9EDF2",
  borderRadius: 8,
  borderRadiusLG: 12,
  controlHeight: 40,
  fontSize: 14,
  lineHeight: 1.57,
  boxShadow: "0 8px 24px rgba(21, 32, 51, 0.08)",
  boxShadowSecondary: "0 12px 36px rgba(21, 32, 51, 0.12)",
};

const darkTokens = {
  ...lightTokens,
  colorPrimary: "#7F9CFF",
  colorInfo: "#7F9CFF",
  colorSuccess: "#55C7A6",
  colorWarning: "#E4AD62",
  colorError: "#FF7B7B",
  colorBgBase: "#0F141B",
  colorBgLayout: "#0F141B",
  colorBgContainer: "#151C25",
  colorBgElevated: "#1B2430",
  colorText: "#EEF2F7",
  colorTextSecondary: "#A5AFBD",
  colorTextTertiary: "#8A96A7",
  colorBorder: "#283343",
  colorBorderSecondary: "#222D3A",
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.24)",
  boxShadowSecondary: "0 16px 40px rgba(0, 0, 0, 0.32)",
};

const lightComponents = {
  Button: { primaryShadow: "none", defaultShadow: "none", dangerShadow: "none" },
  Card: { headerBg: "transparent" },
  Dropdown: { colorBgElevated: "#FFFFFF" },
  Input: { activeBorderColor: "#3157D5", hoverBorderColor: "#5B75DB" },
  Menu: {
    itemBg: "transparent",
    itemHoverBg: "#EDF2FF",
    itemSelectedBg: "#E5ECFF",
    itemSelectedColor: "#294BC0",
  },
  Modal: { contentBg: "#FFFFFF", headerBg: "#FFFFFF" },
  Table: {
    headerBg: "#F7F8FA",
    headerColor: "#475467",
    borderColor: "#E4E8ED",
    rowHoverBg: "#F7F9FC",
  },
  Tag: { defaultBg: "#F2F4F7", defaultColor: "#475467" },
};

const darkComponents = {
  ...lightComponents,
  Dropdown: { colorBgElevated: "#1B2430" },
  Input: { activeBorderColor: "#7F9CFF", hoverBorderColor: "#9BB0FF" },
  Menu: {
    itemBg: "transparent",
    itemHoverBg: "rgba(127, 156, 255, 0.10)",
    itemSelectedBg: "rgba(127, 156, 255, 0.16)",
    itemSelectedColor: "#AFC0FF",
  },
  Modal: { contentBg: "#151C25", headerBg: "#151C25" },
  Table: {
    headerBg: "#19222D",
    headerColor: "#BAC3D0",
    borderColor: "#283343",
    rowHoverBg: "#19222D",
  },
  Tag: { defaultBg: "#222D3A", defaultColor: "#C8D0DC" },
};

const ThemeCtx = createContext<{ dark: boolean; toggle: () => void }>({
  dark: false,
  toggle: () => {},
});

export const useThemeMode = () => useContext(ThemeCtx);

export default function Providers({ children }: { children: React.ReactNode }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // 主题恢复：显式保存优先，其次跟随系统（与 v1 行为一致）
    const saved = localStorage.getItem("app-shell-theme");
    if (saved === "dark") setDark(true);
    else if (!saved && window.matchMedia?.("(prefers-color-scheme: dark)").matches) setDark(true);
    // PWA：注册 service worker（网络优先壳缓存，来自 v1.12）
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  const toggle = () =>
    setDark((d) => {
      const next = !d;
      localStorage.setItem("app-shell-theme", next ? "dark" : "light");
      return next;
    });

  return (
    <ThemeCtx.Provider value={{ dark, toggle }}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: dark ? darkTokens : lightTokens,
          components: dark ? darkComponents : lightComponents,
        }}
      >
        <App>{children}</App>
      </ConfigProvider>
    </ThemeCtx.Provider>
  );
}
