"use client";
// 日期选择登记所选范围的缺账；首屏先显示缓存，再读取今天的最新汇总。
// 含今天的范围每分钟更新今天，历史仍取账本；顶部刷新强制更新今天。单行重新读取走 /query，保留历史重算确认。
// 几个请求可能交错返回：requestId 丢弃过期的响应。error 存报错本身（带 code、status），页面按 lib/error-copy.js 归类成一句。
// 计算明细（GET /profit/detail）点开一行的一天才读，换了行或日期后上一次的结果不再写回。
import { App } from "antd";
import { createElement, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/client";
import { visibleInterval } from "../../../lib/visible-interval.js";
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
  const [activeWindow, setActiveWindow] = useState<ProfitWindow>({ preset: "today" });
  // data 是哪个时间范围读到的：换范围、新数据还没回来时，页面据此把上一个范围的数变淡
  const [loadedWindow, setLoadedWindow] = useState<ProfitWindow | null>(null);
  const [retryingKeys, setRetryingKeys] = useState<Set<string>>(new Set());
  const [retryErrors, setRetryErrors] = useState<Record<string, unknown>>({});
  const [detail, setDetail] = useState<DetailState>(null);
  const requestId = useRef(0);
  const detailRequestId = useRef(0);

  const readPage = (window: ProfitWindow, refreshToday = false, forceToday = false) => api("/api/reconciliation/profit", { method: "POST", body: {
    preset: window.preset, startMs: window.startMs, endMs: window.endMs, ...(refreshToday ? { refreshToday: true, ...(forceToday ? { forceToday: true } : {}) } : {}),
  } });

  // observe：顶部手动刷新绕过今日缓存；历史只登记缺账，不把整段范围重新计算。
  const load = async (window: ProfitWindow = activeWindow, { observe = false, history = observe, cachedFirst = false } = {}) => {
    const token = ++requestId.current;
    setQuerying(true);
    try {
      if (history && window.preset !== "today") await api("/api/reconciliation/history", { method: "POST", body: { preset: window.preset, startMs: window.startMs, endMs: window.endMs } });
      if (cachedFirst) {
        const cached: ProfitPageResponse = await readPage(window);
        if (token !== requestId.current) return null;
        setData(cached); setLoadedWindow(window); setError(null); setLoading(false);
        if (!cached.timing?.provisional && !cached.rows.some((row) => row.reading)) return cached;
      }
      const next: ProfitPageResponse = await readPage(window, true, observe);
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
      const current = await api("/api/reconciliation/configuration?includeArchived=true");
      setConfig(current);
      const initial = pickWindow(current);
      setActiveWindow(initial);
      await load(initial, { history: true, cachedFirst: true });
    } catch (err) {
      setError(caughtError(err));
      setLoading(false);
    }
  };

  // 弹窗里只编辑草稿；确认后一次性提交所选范围。
  const applyWindow = (next: ProfitWindow) => {
    setActiveWindow(next);
    void load(next, { history: true, cachedFirst: true });
  };
  const refresh = async () => {
    const next = await load(activeWindow, { observe: true });
    if (!next) { message.error("刷新失败，请查看页面上的错误说明。"); return; }
    const incomplete = next.rows.filter((row) => row.reading || row.attention || row.notice?.code === "UPSTREAM_COST_UNREAD_TODAY");
    if (incomplete.length) message.warning(`已刷新当前对账范围，仍有 ${incomplete.length} 行数据未完整读取，请查看行内原因。`);
    else message.success("已刷新当前对账范围。");
  };

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

  // 弹窗草稿不影响当前范围的刷新；确认后的实时范围定时更新，切回前台时读一次
  const pollMs = livePollMs(activeWindow, Date.now(), data?.tz, (data?.dayCounts?.reading ?? 0) > 0, !!data?.rows?.some((row) => row.reading));
  useEffect(() => {
    if (!pollMs || !config) return;
    return visibleInterval(() => void load(activeWindow), pollMs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWindow.preset, activeWindow.startMs, activeWindow.endMs, pollMs, config]);

  // 换了范围、新数据还没回来：旧数字属于别的范围
  const switching = Boolean(data && querying && !sameWindow(loadedWindow, activeWindow));

  return {
    config, data, loading, querying, error, activeWindow, loadedWindow, pollMs, switching,
    retryingKeys, retryErrors, detail, initialize, applyWindow, refresh, load, retryRow, openDetail, closeDetail,
  };
}
