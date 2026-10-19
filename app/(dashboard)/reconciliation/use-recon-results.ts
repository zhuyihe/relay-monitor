"use client";
// 绑定列表的搜索、状态筛选、分页和展开行。搜索、筛选、翻页都会收起已展开的倍率变化。
import { useMemo, useState } from "react";
import { filterReconciliationResults, reconciliationRowFlags } from "../../../lib/reconciliation-view";
import type { ReconciliationCurrency } from "../../../lib/client";

export type ReconStatusFilter = "all" | "attention" | "negative";

// 「亏损」按页面显示的币种判断：包月上游不计成本、两侧汇率不同都会改变正负；需处理的行不算亏损
export function useReconResults({ results, upstreams, compact, currency }: { results: any[]; upstreams: any; compact: boolean; currency: ReconciliationCurrency }) {
  const [search, setSearchValue] = useState("");
  const [statusFilter, setStatusFilterValue] = useState<ReconStatusFilter>("all");
  const [page, setPageValue] = useState(1);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);

  const filtered = useMemo(() => filterReconciliationResults(results, upstreams, search, statusFilter, currency), [results, upstreams, search, statusFilter, currency]);
  const counts = useMemo(() => results.reduce((total: Record<ReconStatusFilter, number>, item: any) => {
    const flags = reconciliationRowFlags(item, currency);
    total.all += 1;
    if (flags.attention) total.attention += 1;
    if (flags.negative) total.negative += 1;
    return total;
  }, { all: 0, attention: 0, negative: 0 }), [results, currency]);

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
