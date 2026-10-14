"use client";
// 已确认账单历史：只读原确认记录，不参与当前汇总。
// 关联目录含已停止 / 归档的关联；改日期、换关联或关闭抽屉都会作废还在路上的请求，已读记录保留到新结果返回。
import { useRef, useState } from "react";
import { api } from "../../../lib/client";
import type { ConfirmedHistoryResponse } from "../../../lib/client";

type HistoryRange = { startMs: number; endMs: number } | null;

export function useConfirmedHistory() {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<any[] | null>(null);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [range, setRange] = useState<any>(null);
  const [rangeChanged, setRangeChanged] = useState(false);
  const [records, setRecords] = useState<ConfirmedHistoryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const requestId = useRef(0);
  const lastRequest = useRef<{ ruleId: string; range: HistoryRange; cursor: string | null } | null>(null);

  const loadDirectory = async () => {
    setDirectoryBusy(true); setDirectoryError("");
    try { const next = await api("/api/reconciliation/configuration?includeArchived=true"); setDirectory(next.rules || []); }
    catch (err: any) { setDirectoryError(err.message || "历史关联目录读取失败"); }
    finally { setDirectoryBusy(false); }
  };

  const load = async (id: string, window: HistoryRange = null, cursor: string | null = null) => {
    const token = ++requestId.current; lastRequest.current = { ruleId: id, range: window, cursor }; setBusy(true); setError("");
    const params = new URLSearchParams({ limit: "20" });
    if (window) { params.set("startMs", String(window.startMs)); params.set("endMs", String(window.endMs)); }
    if (cursor) params.set("cursor", cursor);
    try {
      const next: ConfirmedHistoryResponse = await api(`/api/reconciliation/rules/${encodeURIComponent(id)}/confirmed?${params}`);
      if (token !== requestId.current) return;
      setRangeChanged(false);
      setRecords((previous) => {
        const merged = cursor ? [...(previous?.records || []), ...next.records] : next.records;
        return { ...next, records: merged.filter((record, index) => merged.findIndex((item) => item.historyId === record.historyId) === index) };
      });
    } catch (err: any) { if (token === requestId.current) setError(err.message || "确认账单历史读取失败"); }
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
    requestId.current += 1; setBusy(false); setRange(value); setRangeChanged(true); setError(""); setExpandedId(null);
  };

  const query = () => { if (ruleId) void load(ruleId, selectedRange()); };
  const retry = () => { const request = lastRequest.current; if (request) void load(request.ruleId, request.range, request.cursor); };
  const loadMore = () => { if (ruleId && records?.nextCursor) void load(ruleId, lastRequest.current?.range || null, records.nextCursor); };
  const toggleExpanded = (id: string) => setExpandedId((current) => current === id ? null : id);

  return {
    open, directory, directoryBusy, directoryError, loadDirectory, ruleId, range, rangeChanged, records, busy, error, expandedId,
    setExpandedId, toggleExpanded, show, close, chooseRule, changeRange, query, retry, loadMore,
  };
}
