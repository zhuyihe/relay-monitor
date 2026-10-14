"use client";
// 关联列表的搜索、状态筛选、分页和展开行。搜索、筛选、翻页都会收起已展开的分组历史。
import { useMemo, useState } from "react";
import { filterReconciliationResults, reconciliationRowFlags } from "../../../lib/reconciliation-view";

export type ReconStatusFilter = "all" | "attention" | "negative" | "pending";

export function useReconResults({ results, upstreams, compact }: { results: any[]; upstreams: any; compact: boolean }) {
  const [search, setSearchValue] = useState("");
  const [statusFilter, setStatusFilterValue] = useState<ReconStatusFilter>("all");
  const [page, setPageValue] = useState(1);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);

  const filtered = useMemo(() => filterReconciliationResults(results, upstreams, search, statusFilter), [results, upstreams, search, statusFilter]);
  const counts = useMemo(() => results.reduce((total: Record<ReconStatusFilter, number>, item: any) => {
    const flags = reconciliationRowFlags(item);
    total.all += 1;
    if (flags.attention || flags.negative) total.attention += 1;
    if (flags.negative) total.negative += 1;
    if (flags.pending) total.pending += 1;
    return total;
  }, { all: 0, attention: 0, negative: 0, pending: 0 }), [results]);

  const pageSize = compact ? 4 : 10;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const pageItems = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const setSearch = (value: string) => { setSearchValue(value); setPageValue(1); setExpandedRuleId(null); };
  const setStatusFilter = (value: ReconStatusFilter) => { setStatusFilterValue(value); setPageValue(1); setExpandedRuleId(null); };
  const setPage = (value: number) => { setPageValue(value); setExpandedRuleId(null); };
  const showAll = () => { setSearchValue(""); setStatusFilterValue("all"); setPageValue(1); };
  const toggleExpanded = (id: string) => setExpandedRuleId((current) => current === id ? null : id);

  return {
    search, setSearch, statusFilter, setStatusFilter, filtered, counts, pageSize, currentPage, pageItems, setPage, showAll,
    expandedRuleId, setExpandedRuleId, toggleExpanded,
  };
}
