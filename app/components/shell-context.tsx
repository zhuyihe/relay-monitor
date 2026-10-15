"use client";
// 页面向外壳注册顶栏内容：刷新动作、数据截至时间、时间范围控件。
// 外壳负责渲染；页面只描述"我有什么"。
import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";

export type ShellPage = {
  // 顶栏刷新按钮调用；返回 Promise 时外壳在完成前保持"刷新中"
  onRefresh?: () => unknown;
  // 本页数据的获取时刻（毫秒时间戳），显示为"数据截至 HH:MM"
  asOf?: number | null;
  // 时间范围控件：桌面端在标题右侧，移动端落到内容区顶部
  range?: ReactNode;
  // 本页自动刷新间隔（毫秒），用于"数据截至"的提示；null 表示不自动刷新，不传按 60 秒提示
  autoRefreshMs?: number | null;
  // 本页按业务时区划日时传接口返回的 tz，"数据截至"按它显示，与图表里的「截至」一致；不传按浏览器时区
  tz?: string | null;
};

type ShellApi = {
  setPage: (page: ShellPage) => void;
  clearPage: () => void;
  refreshing: boolean;
};

export const ShellContext = createContext<ShellApi>({
  setPage: () => {},
  clearPage: () => {},
  refreshing: false,
});

export function useShellRefreshing() {
  return useContext(ShellContext).refreshing;
}

export function useShellPage({ onRefresh, asOf, range, autoRefreshMs, tz }: ShellPage) {
  const { setPage, clearPage } = useContext(ShellContext);
  // onRefresh 通常是每次渲染新建的闭包，用 ref 保存最新值，避免反复注册
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const hasRefresh = !!onRefresh;

  useEffect(() => {
    setPage({
      onRefresh: hasRefresh ? () => refreshRef.current?.() : undefined,
      asOf: asOf ?? null,
      range,
      autoRefreshMs,
      tz: tz || null,
    });
  }, [setPage, hasRefresh, asOf, range, autoRefreshMs, tz]);

  useEffect(() => clearPage, [clearPage]);
}
