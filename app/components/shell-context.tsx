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

export function useShellPage({ onRefresh, asOf, range }: ShellPage) {
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
    });
  }, [setPage, hasRefresh, asOf, range]);

  useEffect(() => clearPage, [clearPage]);
}
