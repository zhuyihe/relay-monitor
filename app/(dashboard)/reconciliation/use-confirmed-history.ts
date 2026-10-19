"use client";
// 以前的每日记录：只读，不算进上面的汇总。
// 绑定列表含已解除的；改日期、换绑定或关闭抽屉都会作废还在路上的请求，已读的记录保留到新结果回来。
// 报错存下报错本身，界面上写「读不到…：原因。」，原文放进「查看详细原因」（§8.1、§8.2）。
import { useRef, useState } from "react";
import { api } from "../../../lib/client";
import type { ConfirmedHistoryResponse } from "../../../lib/client";
import { caughtError } from "./recon-format";

type HistoryRange = { startMs: number; endMs: number } | null;

export function useConfirmedHistory() {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<any[] | null>(null);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [directoryError, setDirectoryError] = useState<unknown>(null);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [range, setRange] = useState<any>(null);
  const [rangeChanged, setRangeChanged] = useState(false);
  const [records, setRecords] = useState<ConfirmedHistoryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // 最近一次读到记录的时间：刷新失败时写「数据截至」
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const requestId = useRef(0);
  const lastRequest = useRef<{ ruleId: string; range: HistoryRange; cursor: string | null } | null>(null);

  const loadDirectory = async () => {
    setDirectoryBusy(true); setDirectoryError(null);
    try { const next = await api("/api/reconciliation/configuration?includeArchived=true"); setDirectory(next.rules || []); }
    catch (err) { setDirectoryError(caughtError(err)); }
    finally { setDirectoryBusy(false); }
  };

  const load = async (id: string, window: HistoryRange = null, cursor: string | null = null) => {
    const token = ++requestId.current; lastRequest.current = { ruleId: id, range: window, cursor }; setBusy(true); setError(null);
    const params = new URLSearchParams({ limit: "20" });
    if (window) { params.set("startMs", String(window.startMs)); params.set("endMs", String(window.endMs)); }
    if (cursor) params.set("cursor", cursor);
    try {
      const next: ConfirmedHistoryResponse = await api(`/api/reconciliation/rules/${encodeURIComponent(id)}/confirmed?${params}`);
      if (token !== requestId.current) return;
      setRangeChanged(false);
      setLoadedAt(Date.now());
      setRecords((previous) => {
        const merged = cursor ? [...(previous?.records || []), ...next.records] : next.records;
        return { ...next, records: merged.filter((record, index) => merged.findIndex((item) => item.historyId === record.historyId) === index) };
      });
    } catch (err) { if (token === requestId.current) setError(caughtError(err)); }
    finally { if (token === requestId.current) setBusy(false); }
  };

  const selectedRange = (): HistoryRange => range?.[0] && range?.[1] ? { startMs: range[0].valueOf(), endMs: range[1].valueOf() } : null;

  const show = (id?: string) => {
    setOpen(true);
    if (!directory && !directoryBusy) void loadDirectory();
    if (id && id !== ruleId) { setRange(null); setRangeChanged(false); setRuleId(id); setRecords(null); setExpandedId(null); void load(id); }
  };

  const close = () => {
    setOpen(false);
    requestId.current += 1;
    setBusy(false);
  };

  const chooseRule = (id: string) => {
    setRuleId(id); setRecords(null); setExpandedId(null); setRangeChanged(false); void load(id, selectedRange());
  };

  const changeRange = (value: any) => {
    requestId.current += 1; setBusy(false); setRange(value); setRangeChanged(true); setError(null); setExpandedId(null);
  };

  const query = () => { if (ruleId) void load(ruleId, selectedRange()); };
  const retry = () => { const request = lastRequest.current; if (request) void load(request.ruleId, request.range, request.cursor); };
  const loadMore = () => { if (ruleId && records?.nextCursor) void load(ruleId, lastRequest.current?.range || null, records.nextCursor); };
  const toggleExpanded = (id: string) => setExpandedId((current) => current === id ? null : id);

  return {
    open, directory, directoryBusy, directoryError, loadDirectory, ruleId, range, rangeChanged, records, busy, error, loadedAt, expandedId,
    setExpandedId, toggleExpanded, show, close, chooseRule, changeRange, query, retry, loadMore,
  };
}
