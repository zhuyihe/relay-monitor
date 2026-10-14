"use client";
// 核算窗口的读取、全量汇总和单行重试。
// 页面查询只读：切换时间范围用 POST /query 跳过缓存重算但不写库；只有「刷新」和单行「重试」带 observe 让服务端观测并保存。
// 多个请求可能交错返回：windowRequestId 丢弃过期的窗口响应，resultEpoch / rowResultEpoch 保证较新的单行结果不被较早的全量响应覆盖。
import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/client";
import { isLivePreset, sameWindow } from "./recon-format";
import type { ReconPreset, ReconWindow } from "./recon-format";

// 今天每 30 秒重读；近 7 天、本月跨度大、上游取数重，总额分钟级变化不大，5 分钟一次
const livePollMs = (preset: string) => (preset === "today" ? 30000 : isLivePreset(preset) ? 300000 : null);

export function useReconWindow({ onRowReplaced }: { onRowReplaced: (id: string, row: any) => void }) {
  const [config, setConfig] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState("");
  const [preset, setPreset] = useState<ReconPreset>("yesterday");
  const [activeWindow, setActiveWindow] = useState<ReconWindow>({ preset: "yesterday" });
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
        return current?.epoch! > responseEpoch && sameWindow(current?.window, row.window);
      }).map((row: any) => String(row.rule?.id)));
      setData((previous: any) => ({ ...next, results: (next.results || []).map((row: any) => {
        const id = String(row.rule?.id), current = previous?.results?.find((item: any) => String(item.rule?.id) === id);
        if (newerRows.has(id) && sameWindow(current?.window, row.window)) return current;
        rowResultEpoch.current.set(id, { epoch: responseEpoch, window: row.window }); return row;
      }) }));
      if (newerRows.size) void refreshSummary(window, windowEpoch);
      else setSummaryStale(false);
    } catch (err: any) {
      if (requestId === summaryRequestId.current && windowEpoch === windowRequestId.current) setSummaryError(err?.message || "全量汇总读取失败");
    }
  };

  // force 跳过缓存重算，仍然只读；observe 让服务端立即观测并写库，只有「刷新」和单行「重试」这类明确操作才用。
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
            if (id && rowResultEpoch.current.get(id)?.epoch! > responseEpoch && sameWindow(previousWindow, nextWindow)) return previousRow || item;
            if (id) rowResultEpoch.current.set(id, { epoch: responseEpoch, window: item.window });
            return item;
          });
          return { ...next, results: rows };
        });
        setSummaryError("");
        const hasNewerRows = (next.results || []).some((item: any) => {
          const current = rowResultEpoch.current.get(String(item.rule?.id));
          return current?.epoch! > responseEpoch && sameWindow(current?.window, item.window);
        });
        setSummaryStale(hasNewerRows);
        if (hasNewerRows) void refreshSummary(window, requestId);
        setError("");
        return next;
      }
      return null;
    } catch (err: any) {
      if (requestId === windowRequestId.current) setError(err?.message || "核算数据加载失败");
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
    const requestId = (ruleRetryRequestId.current.get(id) || 0) + 1;
    ruleRetryRequestId.current.set(id, requestId);
    const requestWindowEpoch = windowRequestId.current;
    const responseEpoch = ++resultEpoch.current;
    setRetryingRuleIds((previous) => new Set(previous).add(id));
    setRuleRetryErrors((previous) => ({ ...previous, [id]: "" }));
    try {
      const next = await api("/api/reconciliation/query", { method: "POST", body: { preset: "custom", startMs: window.startMs, endMs: window.endMs, ruleIds: [id], observe: true } });
      const replacement = (next?.results || []).find((candidate: any) => String(candidate?.rule?.id) === id);
      const replacementWindow = replacement?.requestedWindow || replacement?.window;
      if (requestId !== ruleRetryRequestId.current.get(id) || requestWindowEpoch !== windowRequestId.current || !replacement || !sameWindow(window, replacementWindow)) return;
      setData((previous: any) => {
        const current = (previous?.results || []).find((candidate: any) => String(candidate?.rule?.id) === id);
        const currentWindow = current?.requestedWindow || current?.window;
        if (!current || !sameWindow(window, currentWindow)) return previous;
        rowResultEpoch.current.set(id, { epoch: responseEpoch, window: replacement.window });
        return { ...previous, results: previous.results.map((candidate: any) => String(candidate?.rule?.id) === id ? replacement : candidate) };
      });
      onRowReplaced(id, replacement);
      void refreshSummary(activeWindow, requestWindowEpoch);
    } catch (err: any) {
      if (requestId === ruleRetryRequestId.current.get(id) && requestWindowEpoch === windowRequestId.current) setRuleRetryErrors((previous) => ({ ...previous, [id]: err?.message || "重试失败，请稍后再试" }));
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
      setError(err?.message || "初始化失败");
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

  return {
    config, data, loading, querying, error, preset, activeWindow, pollMs, range, setRange, summaryStale, summaryError,
    retryingRuleIds, ruleRetryErrors, loadWindow, refreshSummary, retryRule, initialize, selectPreset, queryCustom,
  };
}
