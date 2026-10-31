"use client";
// 每日利润页的读取：整页一次 POST /api/reconciliation/profit（只读，不写库）；「刷新」和需处理那一行的「重新读取」先 POST /query 带 observe
// 让服务端读取并保存，再读一次整页。范围里含今天时轮询（不带 observe）：「今天」和含今天的自定义范围 30 秒一次，「近 7 天」「本月」和旧页面一样 5 分钟一次；看已固定的范围（昨天、不含今天的自定义）
// 不轮询——那几天的数不会再变，没必要一直读；只有点「刷新」（或需处理行的「重新读取」）才带 observe 强制服务端重读（审核 #128）。
// 几个请求可能交错返回：requestId 丢弃过期的响应。error 存报错本身（带 code、status），页面按 lib/error-copy.js 归类成一句。
// 计算明细（GET /profit/detail）点开一行的一天才读，换了行或日期后上一次的结果不再写回。
import { App } from "antd";
import { createElement, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/client";
import type { ProfitDetailResponse, ProfitPageResponse, ProfitRow } from "../../../lib/client";
import { ERROR_CATEGORIES } from "../../../lib/error-copy";
import { livePollMs } from "./profit-format";
// 这天重算的数比原来少了一半多、没换掉：点「重新读取」先弹确认框写出换成多少，确认框的内容和老页面同一份（C3，审核 #126/#128 盘点）
import { RESETTLE_SHRUNK_CHANGED, resettleShrunkConfirm } from "../../../lib/reconciliation-view";

export type ProfitPreset = "today" | "yesterday" | "7d" | "month" | "since" | "custom";
export type ProfitWindow = { preset: ProfitPreset; startMs?: number; endMs?: number };

// 读取失败时存下报错本身，抛出来的是空值时也要算出错
export const caughtError = (err: unknown) => err || new Error(ERROR_CATEGORIES.other.text);
const sameWindow = (a: ProfitWindow | null, b: ProfitWindow) => !!a && a.preset === b.preset && a.startMs === b.startMs && a.endMs === b.endMs;

export type DetailState = { row: ProfitRow; day: string; data: ProfitDetailResponse | null; error: unknown; loading: boolean } | null;

export function useProfitPage() {
  const { modal, message } = App.useApp();
  const [config, setConfig] = useState<any>(null);
  const [data, setData] = useState<ProfitPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preset, setPreset] = useState<ProfitPreset>("today");
  const [activeWindow, setActiveWindow] = useState<ProfitWindow>({ preset: "today" });
  // data 是哪个时间范围读到的：换范围、新数据还没回来时，页面据此把上一个范围的数变淡
  const [loadedWindow, setLoadedWindow] = useState<ProfitWindow | null>(null);
  const [range, setRange] = useState<any>(null);
  const [retryingKeys, setRetryingKeys] = useState<Set<string>>(new Set());
  const [retryErrors, setRetryErrors] = useState<Record<string, unknown>>({});
  const [detail, setDetail] = useState<DetailState>(null);
  const requestId = useRef(0);
  const detailRequestId = useRef(0);

  const readPage = (window: ProfitWindow) => api("/api/reconciliation/profit", { method: "POST", body: { preset: window.preset, startMs: window.startMs, endMs: window.endMs } });

  // observe：先让服务端读取并保存（和「刷新」按钮一样的 /query），再读整页
  const load = async (window: ProfitWindow = activeWindow, { observe = false, ruleIds = null as string[] | null } = {}) => {
    const token = ++requestId.current;
    setQuerying(true);
    try {
      if (observe) await api("/api/reconciliation/query", { method: "POST", body: { preset: window.preset, startMs: window.startMs, endMs: window.endMs, ...(ruleIds ? { ruleIds } : {}), observe: true } });
      const next: ProfitPageResponse = await readPage(window);
      if (token !== requestId.current) return null;
      setData(next); setLoadedWindow(window); setError(null);
      return next;
    } catch (err) {
      if (token === requestId.current) setError(caughtError(err));
      return null;
    } finally {
      if (token === requestId.current) { setQuerying(false); setLoading(false); }
    }
  };

  // 首屏：先读配置（有没有自营站点、绑定在不在），再由页面按链接里的处理目标定初始范围
  const initialize = async (pickWindow: (config: any) => ProfitWindow) => {
    try {
      const current = await api("/api/reconciliation/configuration");
      setConfig(current);
      const initial = pickWindow(current);
      setActiveWindow(initial); setPreset(initial.preset);
      await load(initial);
    } catch (err) {
      setError(caughtError(err));
      setLoading(false);
    }
  };

  // 预设点选即查；「自定义」只展开日期选择，点「查询」才读
  const selectPreset = (next: ProfitPreset) => {
    if (next === preset) return;
    setPreset(next);
    if (next === "custom") return;
    const window = { preset: next };
    setActiveWindow(window);
    void load(window);
  };
  const selectDay = (startMs: number, endMs: number) => {
    const window: ProfitWindow = { preset: "custom", startMs, endMs };
    setPreset("custom"); setActiveWindow(window);
    void load(window);
  };
  const queryCustom = async () => {
    if (!range?.[0] || !range?.[1]) return false;
    const next: ProfitWindow = { preset: "custom", startMs: range[0].valueOf(), endMs: range[1].valueOf() };
    setActiveWindow(next);
    await load(next);
    return true;
  };
  const refresh = () => load(activeWindow, { observe: true });

  // 需处理那一行的「重新读取」：只让服务端读这一行的绑定（照旧带 observe），再读整页
  const retryRow = async (row: ProfitRow) => {
    const key = row.rowKey;
    const window = row.attention?.action?.window;
    // 这天是「重算的数比原来少了一半多」没换掉的：这一下会把已固定的钱换掉，先弹确认框写出换成多少（§5.3）；点了才带确认去读
    const confirmation = row.attention?.shrunk ? resettleShrunkConfirm({ displayStatus: { shrunk: row.attention.shrunk }, window }) : null;
    if (confirmation) {
      const confirmed = await new Promise<boolean>((resolve) => modal.confirm({
        title: confirmation.title, okText: confirmation.okText, cancelText: confirmation.cancelText,
        content: createElement("div", null, ...confirmation.lines.map((line: string) => createElement("div", { key: line }, line)),
          createElement("div", { style: { marginTop: 8, opacity: 0.65 } }, confirmation.hint)),
        onOk: () => resolve(true), onCancel: () => resolve(false),
      }));
      if (!confirmed) return;
    }
    setRetryingKeys((previous) => new Set(previous).add(key));
    setRetryErrors((previous) => ({ ...previous, [key]: null }));
    try {
      await api("/api/reconciliation/query", { method: "POST", body: { ...(window ? { preset: "custom", startMs: window.startMs, endMs: window.endMs } : { preset: activeWindow.preset, startMs: activeWindow.startMs, endMs: activeWindow.endMs }), ruleIds: row.ruleIds, observe: true, ...(confirmation ? { confirmShrink: true, confirmedAfter: confirmation.after } : {}) } });
      const next = await load(activeWindow);
      // 太早没自动重算的日子点「重新读取」，读出来又少了一半多：先没换掉，说一声（和需处理的标题同一句，§5.3）
      const fresh = next?.rows.find((item) => item.rowKey === key);
      if (fresh?.attention?.code === "RESETTLE_SHRUNK") message.warning(confirmation ? RESETTLE_SHRUNK_CHANGED : `${fresh.attention.title}，先没换掉`);
    } catch (err) {
      setRetryErrors((previous) => ({ ...previous, [key]: caughtError(err) }));
    } finally {
      setRetryingKeys((previous) => { const next = new Set(previous); next.delete(key); return next; });
    }
  };

  // 计算明细：一行一天
  const openDetail = async (row: ProfitRow, day: string) => {
    const token = ++detailRequestId.current;
    setDetail({ row, day, data: null, error: null, loading: true });
    try {
      const next: ProfitDetailResponse = await api(`/api/reconciliation/profit/detail?ruleIds=${encodeURIComponent(row.ruleIds.join(","))}&day=${encodeURIComponent(day)}`);
      if (token === detailRequestId.current) setDetail({ row, day, data: next, error: null, loading: false });
    } catch (err) {
      if (token === detailRequestId.current) setDetail({ row, day, data: null, error: caughtError(err), loading: false });
    }
  };
  const closeDetail = () => { detailRequestId.current += 1; setDetail(null); };

  // 截至现在的范围定时重读（只读）；选了「自定义」还没查询时暂停；切回前台时读一次
  const pollMs = preset === activeWindow.preset ? livePollMs(activeWindow, Date.now(), data?.tz, (data?.dayCounts?.reading ?? 0) > 0, !!data?.rows?.some((row) => row.reading)) : null;
  useEffect(() => {
    if (!pollMs || !config) return;
    const timer = setInterval(() => void load(activeWindow), pollMs);
    const onVisible = () => { if (!document.hidden) void load(activeWindow); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWindow.preset, activeWindow.startMs, activeWindow.endMs, pollMs, config]);

  // 换了范围、新数据还没回来：旧数字属于别的范围
  const switching = Boolean(data && querying && !sameWindow(loadedWindow, activeWindow));

  return {
    config, data, loading, querying, error, preset, activeWindow, loadedWindow, range, setRange, pollMs, switching,
    retryingKeys, retryErrors, detail, initialize, selectPreset, selectDay, queryCustom, refresh, load, retryRow, openDetail, closeDetail,
  };
}
