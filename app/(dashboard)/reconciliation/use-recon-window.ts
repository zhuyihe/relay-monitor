"use client";
// 每日利润页的读取、汇总和单行「重新读取」。
// 页面查询只读：切换时间范围用 POST /query 跳过缓存重算但不写库；只有「刷新」和单行「重新读取」带 observe 让服务端读取并保存。
// error 存报错本身（带 code、status），整块读不到时页面按它归类成一句（lib/error-copy.js）；summaryError、ruleRetryErrors 存的是报错原文，
// 页面只放进「查看详细原因」（design/ui-copy-spec.md §8.2）。
// 多个请求可能交错返回：windowRequestId 丢弃过期的窗口响应，resultEpoch / rowResultEpoch 保证较新的单行结果不被较早的全量响应覆盖。
import { App } from "antd";
import { createElement, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/client";
import { ERROR_CATEGORIES } from "../../../lib/error-copy";
import { sameReconciliationWindow } from "../../../lib/reconciliation-contract";
import { RESETTLE_SHRUNK_CHANGED, resettleShrunkConfirm } from "../../../lib/reconciliation-view";
import { caughtError, isLivePreset } from "./recon-format";
import type { ReconPreset, ReconWindow } from "./recon-format";

// 今天每 30 秒重读；近 7 天、本月跨度大、上游取数重，总额分钟级变化不大，5 分钟一次
const livePollMs = (preset: string) => (preset === "today" ? 30000 : isLivePreset(preset) ? 300000 : null);
const USAGE_REREAD_LIMIT = 3;
const USAGE_REREAD_MS = 5000;
// 报错没有原文时的那一句（§8.2「其他」）
const OTHER_ERROR = ERROR_CATEGORIES.other.text;

export function useReconWindow({ onRowReplaced }: { onRowReplaced: (id: string, row: any) => void }) {
  const { message, modal } = App.useApp();
  const [config, setConfig] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preset, setPreset] = useState<ReconPreset>("yesterday");
  const [activeWindow, setActiveWindow] = useState<ReconWindow>({ preset: "yesterday" });
  // data 是哪个时间范围读到的：切换范围、新数据还没回来时，页面据此不把上一个范围的数字当成这次的
  const [loadedWindow, setLoadedWindow] = useState<ReconWindow | null>(null);
  const [range, setRange] = useState<any>(null);
  const [summaryStale, setSummaryStale] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [retryingRuleIds, setRetryingRuleIds] = useState<Set<string>>(new Set());
  const [ruleRetryErrors, setRuleRetryErrors] = useState<Record<string, string>>({});
  const configRequestId = useRef(0);
  const windowRequestId = useRef(0);
  const windowRequestInFlight = useRef(false);
  const ruleRetryRequestId = useRef(new Map<string, number>());
  const resultEpoch = useRef(0);
  const rowResultEpoch = useRef(new Map<string, { epoch: number; window: any }>());
  const summaryRequestId = useRef(0);
  const usageRereads = useRef({ epoch: -1, count: 0 });
  const [usageRereadTick, setUsageRereadTick] = useState(0);

  const loadConfiguration = async () => {
    const requestId = ++configRequestId.current;
    const next = await api("/api/reconciliation/configuration");
    if (requestId !== configRequestId.current) return null;
    setConfig(next);
    return next;
  };

  const readWindow = (window: ReconWindow) => {
    const params = new URLSearchParams({ preset: window.preset });
    if (window.startMs != null) params.set("startMs", String(window.startMs));
    if (window.endMs != null) params.set("endMs", String(window.endMs));
    return api(`/api/reconciliation?${params}`);
  };

  const refreshSummary = async (window = activeWindow, windowEpoch = windowRequestId.current) => {
    const requestId = ++summaryRequestId.current;
    const responseEpoch = ++resultEpoch.current;
    setSummaryStale(true); setSummaryError("");
    try {
      const next = await readWindow(window);
      if (requestId !== summaryRequestId.current || windowEpoch !== windowRequestId.current) return;
      const newerRows = new Set((next.results || []).filter((row: any) => {
        const current = rowResultEpoch.current.get(String(row.rule?.id));
        return current?.epoch! > responseEpoch && sameReconciliationWindow(current?.window, row.window);
      }).map((row: any) => String(row.rule?.id)));
      setData((previous: any) => ({ ...next, results: (next.results || []).map((row: any) => {
        const id = String(row.rule?.id), current = previous?.results?.find((item: any) => String(item.rule?.id) === id);
        if (newerRows.has(id) && sameReconciliationWindow(current?.window, row.window)) return current;
        rowResultEpoch.current.set(id, { epoch: responseEpoch, window: row.window }); return row;
      }) }));
      if (newerRows.size) void refreshSummary(window, windowEpoch);
      else setSummaryStale(false);
    } catch (err: any) {
      if (requestId === summaryRequestId.current && windowEpoch === windowRequestId.current) setSummaryError(err?.message || OTHER_ERROR);
    }
  };

  // force 跳过缓存重算，仍然只读；observe 让服务端立即观测并写库，只有「刷新」和单行「重新读取」这类明确操作才用。
  const loadWindow = async (window = activeWindow, force = false, observe = false) => {
    if (!force && windowRequestInFlight.current) return null;
    const requestId = ++windowRequestId.current;
    summaryRequestId.current += 1;
    const responseEpoch = ++resultEpoch.current;
    windowRequestInFlight.current = true;
    setQuerying(true);
    try {
      const next = force ? await api("/api/reconciliation/query", { method: "POST", body: observe ? { ...window, observe: true } : window }) : await readWindow(window);
      if (requestId === windowRequestId.current) {
        setData((previous: any) => {
          const previousRows = new Map((previous?.results || []).map((item: any) => [String(item?.rule?.id), item]));
          const rows = (next?.results || []).map((item: any) => {
            const id = String(item?.rule?.id || "");
            const previousRow: any = previousRows.get(id);
            const previousWindow = previousRow?.window;
            const nextWindow = item?.window;
            if (id && rowResultEpoch.current.get(id)?.epoch! > responseEpoch && sameReconciliationWindow(previousWindow, nextWindow)) return previousRow || item;
            if (id) rowResultEpoch.current.set(id, { epoch: responseEpoch, window: item.window });
            return item;
          });
          return { ...next, results: rows };
        });
        setLoadedWindow(window);
        setSummaryError("");
        const hasNewerRows = (next.results || []).some((item: any) => {
          const current = rowResultEpoch.current.get(String(item.rule?.id));
          return current?.epoch! > responseEpoch && sameReconciliationWindow(current?.window, item.window);
        });
        setSummaryStale(hasNewerRows);
        if (hasNewerRows) void refreshSummary(window, requestId);
        setError(null);
        return next;
      }
      return null;
    } catch (err: any) {
      if (requestId === windowRequestId.current) setError(caughtError(err));
      return null;
    } finally {
      if (requestId === windowRequestId.current) {
        windowRequestInFlight.current = false;
        setQuerying(false);
        setLoading(false);
      }
    }
  };

  const retryRule = async (item: any) => {
    const id = String(item?.rule?.id || "");
    const window = item?.requestedWindow || item?.window;
    if (!id || !window?.startMs || !window?.endMs) return;
    // 这天是「重算的数比原来少了一半多」没换掉的：这一下会把已固定的钱换掉，先弹确认框写出换成多少（§5.3）；点了才带确认去读
    const confirmation = resettleShrunkConfirm(item);
    if (confirmation) {
      const confirmed = await new Promise<boolean>((resolve) => modal.confirm({
        title: confirmation.title, okText: confirmation.okText, cancelText: confirmation.cancelText,
        content: createElement("div", null, ...confirmation.lines.map((line: string) => createElement("div", { key: line }, line)),
          createElement("div", { style: { marginTop: 8, opacity: 0.65 } }, confirmation.hint)),
        onOk: () => resolve(true), onCancel: () => resolve(false),
      }));
      if (!confirmed) return;
    }
    const requestId = (ruleRetryRequestId.current.get(id) || 0) + 1;
    ruleRetryRequestId.current.set(id, requestId);
    const requestWindowEpoch = windowRequestId.current;
    const responseEpoch = ++resultEpoch.current;
    setRetryingRuleIds((previous) => new Set(previous).add(id));
    setRuleRetryErrors((previous) => ({ ...previous, [id]: "" }));
    try {
      const next = await api("/api/reconciliation/query", { method: "POST", body: { preset: "custom", startMs: window.startMs, endMs: window.endMs, ruleIds: [id], observe: true, ...(confirmation ? { confirmShrink: true, confirmedAfter: confirmation.after } : {}) } });
      const replacement = (next?.results || []).find((candidate: any) => String(candidate?.rule?.id) === id);
      const replacementWindow = replacement?.requestedWindow || replacement?.window;
      if (requestId !== ruleRetryRequestId.current.get(id) || requestWindowEpoch !== windowRequestId.current || !replacement || !sameReconciliationWindow(window, replacementWindow)) return;
      setData((previous: any) => {
        const current = (previous?.results || []).find((candidate: any) => String(candidate?.rule?.id) === id);
        const currentWindow = current?.requestedWindow || current?.window;
        if (!current || !sameReconciliationWindow(window, currentWindow)) return previous;
        rowResultEpoch.current.set(id, { epoch: responseEpoch, window: replacement.window });
        return { ...previous, results: previous.results.map((candidate: any) => String(candidate?.rule?.id) === id ? replacement : candidate) };
      });
      onRowReplaced(id, replacement);
      // 太早没自动重算的日子点「重新读取」，读出来又少了一半多：先没换掉，说一声（和需处理的标题同一句，§5.3）
      if (replacement.displayStatus?.action?.code === "RESETTLE_SHRUNK") message.warning(confirmation ? RESETTLE_SHRUNK_CHANGED : `${replacement.displayStatus.title}，先没换掉`);
      void refreshSummary(activeWindow, requestWindowEpoch);
    } catch (err: any) {
      if (requestId === ruleRetryRequestId.current.get(id) && requestWindowEpoch === windowRequestId.current) setRuleRetryErrors((previous) => ({ ...previous, [id]: err?.message || OTHER_ERROR }));
    } finally {
      if (requestId === ruleRetryRequestId.current.get(id)) setRetryingRuleIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };

  // 首屏：先读配置，再由页面根据处理目标决定初始窗口
  const initialize = async (pickWindow: (config: any) => ReconWindow) => {
    try {
      const current = await loadConfiguration();
      const initial = pickWindow(current);
      setActiveWindow(initial); setPreset(initial.preset);
      await loadWindow(initial);
    } catch (err: any) {
      setError(caughtError(err));
      setLoading(false);
    }
  };

  // 预设窗口点选即查；「自定义」只展开时间选择，点「查询」才读
  const selectPreset = (next: ReconPreset) => {
    if (next === preset) return;
    setPreset(next);
    if (next === "custom") return;
    const window = { preset: next };
    setActiveWindow(window);
    void loadWindow(window, true);
  };

  const queryCustom = async () => {
    if (!range?.[0] || !range?.[1]) return false;
    const next: ReconWindow = { preset: "custom", startMs: range[0].valueOf(), endMs: range[1].valueOf() };
    setActiveWindow(next);
    await loadWindow(next, true);
    return true;
  };

  // 截至现在的窗口（今天、近 7 天、本月）定时重读：只读，服务端在缓存有效期内复用上次结果，不触发观测。
  // 选了「自定义」还没查询时，显示的仍是旧窗口，暂停轮询，免得旧窗口在后台继续刷新。
  const pollMs = preset === activeWindow.preset ? livePollMs(activeWindow.preset) : null;
  useEffect(() => {
    if (!pollMs || !config) return;
    const timer = setInterval(() => loadWindow(activeWindow), pollMs);
    const onVisible = () => { if (!document.hidden) loadWindow(activeWindow); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWindow.preset, pollMs, config]);

  // 上游账号用量取数慢时服务端先回「读取中」：间隔 5 秒静默重读（读缓存，不重算），只换上「没算进利润的上游成本」，不动绑定列表、不进入查询中。
  // 次数按窗口请求计：每次窗口读取（切换范围、轮询、「刷新」）重新给 3 次；窗口请求变了或正在进行时，这一轮的重读作废。
  const unaccounted = data?.unaccountedUpstream;
  useEffect(() => {
    if (unaccounted?.state !== "pending" || !config) return;
    const epoch = windowRequestId.current;
    if (usageRereads.current.epoch !== epoch) usageRereads.current = { epoch, count: 0 };
    if (usageRereads.current.count >= USAGE_REREAD_LIMIT) return;
    const window = activeWindow;
    const timer = setTimeout(async () => {
      if (epoch !== windowRequestId.current || windowRequestInFlight.current) return;
      usageRereads.current.count += 1;
      let next: any = null;
      try { next = await readWindow(window); } catch { /* 读不到就等下一次 */ }
      if (epoch !== windowRequestId.current) return;
      if (next) setData((previous: any) => previous && { ...previous, unaccountedUpstream: next.unaccountedUpstream ?? null });
      setUsageRereadTick((tick) => tick + 1);
    }, USAGE_REREAD_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unaccounted, usageRereadTick, config]);
  // 还会自动重读：次数用完后页面提示点顶栏的刷新。usageRereadTick 每次重读后变化，保证这里读到最新次数。
  const usageRereading = unaccounted?.state === "pending" && Boolean(config)
    && (usageRereads.current.epoch !== windowRequestId.current || usageRereads.current.count < USAGE_REREAD_LIMIT);

  return {
    config, data, loading, querying, error, preset, activeWindow, loadedWindow, pollMs, range, setRange, summaryStale, summaryError, usageRereading,
    retryingRuleIds, ruleRetryErrors, loadWindow, refreshSummary, retryRule, initialize, selectPreset, queryCustom,
  };
}
