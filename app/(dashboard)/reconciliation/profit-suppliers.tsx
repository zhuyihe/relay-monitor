"use client";
import { Fragment, useEffect, useState } from "react";
import { Button } from "antd";
import { Icon } from "../../components/icons";
import type { ProfitPageResponse, ProfitRow } from "../../../lib/client";
import { COPY } from "./copy";
import { fmtMoney, keyLabel, marginText, rowName, supplierGroups, totalsRow } from "./profit-format";
import type { Ctx, Sort, SortKey, SupplierItem } from "./profit-format";

type Props = { page: ProfitPageResponse; ctx: Ctx; compact: boolean; sort: Sort | null; onSort: (key: SortKey) => void;
  detailDay: string | null; revealRuleId?: string | null; onOpenDetail: (row: ProfitRow, day: string) => void; onShowChannels: () => void };
const columns: { key: SortKey; label: string }[] = [{ key: "name", label: "供应商" }, { key: "income", label: "收入" }, { key: "actual", label: "上游成本" }, { key: "gross", label: "毛利" }, { key: "margin", label: "毛利率" }];

export function ProfitSuppliers({ page, ctx, compact, sort, onSort, detailDay, revealRuleId, onOpenDetail, onShowChannels }: Props) {
  const groups = supplierGroups(page.rows, ctx, sort);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!revealRuleId) return;
    setExpanded((previous) => new Set([...previous, ...groups.filter((group) => group.items.some((item) => item.row.ruleIds.includes(revealRuleId))).map((group) => group.id)]));
  // 仅处理从告警跳转的目标；刷新数据保留用户展开状态。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRuleId]);
  const toggle = (id: string) => setExpanded((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const totals = totalsRow(page, ctx);
  const values = (money: { income: number | null; actual: number | null; gross: number | null }) => [fmtMoney(money.income, ctx.currency), fmtMoney(money.actual, ctx.currency), fmtMoney(money.gross, ctx.currency), marginText(money.gross, money.income)];
  const detail = (item: SupplierItem) => detailDay && !item.row.reading
    ? <Button type="link" size="small" aria-label={`计算明细 ${rowName(item.row)}`} onClick={() => onOpenDetail(item.row, detailDay)}>计算明细</Button> : null;
  const issue = (n: number) => n > 0 ? <button type="button" className="jy-profit-supplier-issue" onClick={onShowChannels}>{n} 组需处理</button> : null;
  const label = (item: SupplierItem) => item.key ? keyLabel(item.key, false) : item.row.key.name;
  if (compact) return <ul className="jy-profit-supplier-cards">
    {groups.map((group) => <li key={group.id} data-supplier-id={group.id}>
      <button type="button" className="jy-profit-supplier-toggle" aria-expanded={expanded.has(group.id)} onClick={() => toggle(group.id)}>
        <span><strong>{group.name}</strong><small>{group.keys} 把 Key · {group.channels} 个渠道</small></span><Icon name="expand" className={expanded.has(group.id) ? "is-open" : undefined} />
      </button>
      {issue(group.issues)}
      <dl className="jy-profit-card__metrics">{values(group).map((value, i) => <div key={columns[i + 1].key}><dt>{columns[i + 1].label}</dt><dd className={i === 2 && (group.gross ?? 0) < 0 ? "jy-profit-neg" : undefined}>{value}</dd></div>)}</dl>
      {expanded.has(group.id) ? <ul className="jy-profit-supplier-items">{group.items.map((item) => <li key={item.id} data-row-key={item.row.rowKey}>
        <div className="jy-profit-card__head"><strong>{label(item)}</strong>{detail(item)}</div><p>{rowName(item.row)}</p>
        <dl className="jy-profit-card__metrics">{values(item).map((value, i) => <div key={columns[i + 1].key}><dt>{columns[i + 1].label}</dt><dd>{value}</dd></div>)}</dl>
      </li>)}</ul> : null}
    </li>)}
  </ul>;
  return <div className="jy-table-wrap"><table className="jy-profit-table jy-profit-supplier-table">
    <colgroup><col className="jy-profit-col-name" /><col /><col /><col /><col />{detailDay ? <col className="jy-profit-col-detail" /> : null}</colgroup>
    <thead><tr>{columns.map((column) => <th key={column.key} className={column.key === "name" ? undefined : "jy-profit-num"} aria-sort={sort?.key === column.key ? sort.dir === "desc" ? "descending" : "ascending" : undefined}>
      <button type="button" className="jy-profit-sort" onClick={() => onSort(column.key)}>{column.label}{sort?.key === column.key ? sort.dir === "desc" ? " ▼" : " ▲" : null}</button>
    </th>)}{detailDay ? <th aria-label={COPY.table.day.detail} /> : null}</tr></thead>
    <tbody>{groups.map((group) => <Fragment key={group.id}>
      <tr className="jy-profit-supplier-row" data-supplier-id={group.id}>
        <td><button type="button" className="jy-profit-supplier-toggle" aria-expanded={expanded.has(group.id)} onClick={() => toggle(group.id)}>
          <Icon name="expand" className={expanded.has(group.id) ? "is-open" : undefined} /><span><strong>{group.name}</strong><small>{group.keys} 把 Key · {group.channels} 个渠道</small></span>
        </button>{issue(group.issues)}</td>
        {values(group).map((value, i) => <td key={i} className={`jy-profit-num${i === 2 && (group.gross ?? 0) < 0 ? " jy-profit-neg" : ""}`}>{value}</td>)}{detailDay ? <td /> : null}
      </tr>
      {expanded.has(group.id) ? group.items.map((item) => <tr key={item.id} className="jy-profit-supplier-item" data-row-key={item.row.rowKey}>
        <td><strong>{label(item)}</strong><small>{rowName(item.row)}</small></td>
        {values(item).map((value, i) => <td key={i} className={`jy-profit-num${i === 2 && (item.gross ?? 0) < 0 ? " jy-profit-neg" : ""}`}>{value}</td>)}{detailDay ? <td className="jy-profit-detail-cell r">{detail(item)}</td> : null}
      </tr>) : null}
    </Fragment>)}</tbody>
    <tfoot><tr className="jy-profit-totals"><td>{totals.label}</td>{[totals.income, totals.actual, totals.gross, totals.margin].map((value, i) => <td key={i} className="jy-profit-num">{value}</td>)}{detailDay ? <td /> : null}</tr></tfoot>
  </table></div>;
}
