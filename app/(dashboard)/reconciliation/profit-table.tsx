"use client";
// 每日利润的渠道表（设计 10-29）：桌面一行一个渠道（收入、上游成本、毛利、毛利率），默认按毛利从高到低、点表头换排法、亏钱的标红；
// 点开一个渠道一天一行，行末「计算明细」打开那天的计算明细；需处理的渠道名字后面一个感叹号，点开写原因加按钮。手机一个渠道一张卡片。
// 字都从 copy.ts 和 profit-format.ts 来，这里只负责摆。
import { useState } from "react";
import type { ReactNode } from "react";
import { Alert, Button } from "antd";
import { RecheckConsumeLogButton } from "../../components/recheck-consume-log";
import { Icon } from "../../components/icons";
import { IssueBang, IssuePop } from "../../components/issue-bang";
import { CountBadge, Panel } from "../../components/panel";
import { EmptyState } from "../../components/data-state";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import type { ProfitPageResponse, ProfitRow, WorkflowAction } from "../../../lib/client";
import { EMPTY } from "../../../lib/format";
import { COPY } from "./copy";
import { dayRows, fmtMoney, marginText, rowCells, rowMoney, rowName, rowUpstream, sortRows, totalsRow } from "./profit-format";
import type { Ctx, Sort, SortKey } from "./profit-format";

type Props = {
  page: ProfitPageResponse; ctx: Ctx; compact: boolean; switching: boolean;
  sort: Sort; onSort: (key: SortKey) => void;
  expanded: Set<string>; onToggle: (rowKey: string) => void;
  onOpenDetail: (row: ProfitRow, day: string) => void;
  onRetry: (row: ProfitRow) => void; onRefresh: () => void;
  retryingKeys: Set<string>; retryErrors: Record<string, unknown>;
  empty: { href: string; label: string } | null;
};

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: COPY.table.col.channel }, { key: "income", label: COPY.table.col.income }, { key: "actual", label: COPY.table.col.actual },
  { key: "gross", label: COPY.table.col.gross }, { key: "margin", label: COPY.table.col.margin },
];
const neg = (negative: boolean, text: string): ReactNode => (negative ? <span className="jy-profit-neg">{text}</span> : text);

// 需处理的按钮：按钮名和去处都从问题码来（action 里现成的）；重新读取在本页做，重新检查和刷新各有各的，别的有地址就跳转
function ActionButton({ action, row, onRetry, onRefresh, retrying }: { action: WorkflowAction | null; row: ProfitRow; onRetry: (row: ProfitRow) => void; onRefresh: () => void; retrying: boolean }) {
  // label 空：这一天碰到过自营站点没记收费记录的那段，没有按钮（R2）
  if (!action || !action.label) return null;
  const label = `${action.label} ${rowName(row)}`;
  if (action.kind === "recheck_consume_log") return <RecheckConsumeLogButton size="small" type="primary" aria-label={label} />;
  if (action.kind === "retry_bill") return <Button size="small" type="primary" loading={retrying} aria-label={label} onClick={() => onRetry(row)}>{action.label}</Button>;
  if (action.kind === "refresh") return <Button size="small" type="primary" aria-label={label} onClick={onRefresh}>{action.label}</Button>;
  if (action.href) return <Button size="small" type="primary" aria-label={label} href={action.href}>{action.label}</Button>;
  return null;
}

// 名字后面的感叹号：悬停一句，点开是需处理的标题、说明和按钮（提示类的，如今天提醒换 Key，写 text 和 detail、照常算进合计）。
// 放在点开一行的按钮旁边，点它不展开那一行（连气泡里的点击也不往上冒）
function RowBang({ row, popKey, open, onOpenChange, ...props }: { row: ProfitRow; popKey: string; open: string | null; onOpenChange: (key: string | null) => void } & Pick<Props, "onRetry" | "onRefresh" | "retryingKeys" | "retryErrors">) {
  const attention = row.attention, notice = row.notice;
  if (!attention && !notice) return null;
  const title = attention ? attention.title || COPY.table.unreadable : notice!.text;
  const note = attention ? [attention.detail, attention.moreCount > 0 ? COPY.attention.more(attention.moreCount) : ""].filter(Boolean).join("。") : notice!.detail;
  const action = attention ? attention.action : notice!.action;
  const retryError = props.retryErrors[row.rowKey];
  // 需处理（这天不算进来）橙色，提示（照常算进来、只是提醒）蓝色：看问题码是哪一种，不是「有感叹号就不算」
  const tone = attention ? "warn" : "info";
  return <span className="jy-profit-bang" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <IssueBang tone={tone} tip={COPY.table.issueTip(rowName(row), title)} open={open === popKey} onOpenChange={(next) => onOpenChange(next ? popKey : null)}>
      <IssuePop tone={tone} title={title} note={note} actions={<ActionButton action={action} row={row} onRetry={props.onRetry} onRefresh={props.onRefresh} retrying={props.retryingKeys.has(row.rowKey)} />}>
        {retryError ? <Alert type="error" showIcon title={COPY.attention.retryFailed} description={<ErrorDetail raw={noteOf(retryError).raw} />} /> : null}
      </IssuePop>
    </IssueBang>
  </span>;
}

// 点开一个渠道：一天一行（桌面一张小表，手机一天一块）
function DayTable({ row, page, ctx, onOpenDetail, compact }: { row: ProfitRow; page: ProfitPageResponse; ctx: Ctx; onOpenDetail: (row: ProfitRow, day: string) => void; compact: boolean }) {
  const days = dayRows(row, page, ctx);
  if (compact) {
    return <ul className="jy-profit-days jy-profit-days--cards">
      {days.map((day) => <li key={day.day} data-day={day.day}>
        <div className="jy-profit-days__top"><span>{day.label}</span><span className={`jy-profit-days__state is-${day.state}`}>{day.stateText}</span></div>
        <div className="jy-profit-days__line"><span>{COPY.table.mobileDay(day.income, day.actual)}</span><b>{neg(day.negative, COPY.table.mobileGross(day.gross))}</b></div>
        <Button type="link" size="small" onClick={() => onOpenDetail(row, day.day)}>{COPY.table.day.detail}</Button>
      </li>)}
    </ul>;
  }
  return <table className="jy-data jy-profit-days">
    <thead><tr>
      <th>{COPY.table.day.date}</th><th className="r">{COPY.table.col.income}</th><th className="r">{COPY.table.col.actual}</th><th className="r">{COPY.table.col.gross}</th><th className="r">{COPY.table.col.margin}</th><th>{COPY.table.day.state}</th><th />
    </tr></thead>
    <tbody>{days.map((day) => <tr key={day.day} data-day={day.day}>
      <td>{day.label}</td><td className="r">{day.income}</td><td className="r">{day.actual}</td><td className="r">{neg(day.negative, day.gross)}</td><td className="r">{neg(day.negative, day.margin)}</td>
      <td><span className={`jy-profit-days__state is-${day.state}`}>{day.stateText}</span></td>
      <td className="r"><Button type="link" size="small" aria-label={`${COPY.table.day.detail} ${rowName(row)} ${day.label}`} onClick={() => onOpenDetail(row, day.day)}>{COPY.table.day.detail}</Button></td>
    </tr>)}</tbody>
  </table>;
}

function Cells({ row, ctx }: { row: ProfitRow; ctx: Ctx }) {
  const money = rowMoney(row, ctx.currency), cells = rowCells(row, ctx);
  const loss = cells.gross != null && cells.gross < 0;
  return <>
    <td className="jy-profit-num">{fmtMoney(cells.income, ctx.currency)}</td>
    <td className="jy-profit-num">{row.counted ? fmtMoney(money.actual, ctx.currency) : EMPTY}</td>
    <td className="jy-profit-num">{row.counted ? neg(loss, fmtMoney(money.gross, ctx.currency)) : EMPTY}</td>
    <td className="jy-profit-num">{row.counted ? neg(loss, marginText(money.gross, money.income)) : EMPTY}</td>
  </>;
}

function DesktopTable(props: Props & { rows: ProfitRow[]; popOpen: string | null; setPopOpen: (key: string | null) => void }) {
  const { page, ctx, rows, expanded, onToggle, onOpenDetail, sort, onSort } = props;
  const totals = totalsRow(page, ctx);
  return <div className="jy-table-wrap">
    <table className="jy-profit-table">
      <thead><tr>
        {COLUMNS.map((column) => <th key={column.key} className={column.key === "name" ? undefined : "jy-profit-num"} aria-sort={sort.key === column.key ? (sort.dir === "desc" ? "descending" : "ascending") : undefined}>
          <button type="button" className="jy-profit-sort" onClick={() => onSort(column.key)}>{column.label}{sort.key === column.key ? <span aria-hidden="true">{sort.dir === "desc" ? " ▼" : " ▲"}</span> : null}</button>
        </th>)}
      </tr></thead>
      {rows.map((row) => {
          const open = expanded.has(row.rowKey), name = rowName(row);
          return <tbody key={row.rowKey} className="jy-profit-group">
            <tr className={`jy-profit-row${open ? " is-open" : ""}`} data-row-key={row.rowKey} onClick={() => onToggle(row.rowKey)}>
              <td className="jy-profit-row__name">
                <span className="jy-profit-row__line">
                  <button type="button" className="jy-profit-row__toggle" aria-expanded={open} aria-label={open ? COPY.table.collapse(name) : COPY.table.expand(name)} onClick={(event) => { event.stopPropagation(); onToggle(row.rowKey); }}>
                    <Icon name="expand" className={open ? "is-open" : undefined} /><strong>{name}</strong>
                  </button>
                  <RowBang row={row} popKey={row.rowKey} open={props.popOpen} onOpenChange={props.setPopOpen} onRetry={props.onRetry} onRefresh={props.onRefresh} retryingKeys={props.retryingKeys} retryErrors={props.retryErrors} />
                </span>
                <small>{rowUpstream(row)}</small>
              </td>
              <Cells row={row} ctx={ctx} />
            </tr>
            {open ? <tr className="jy-profit-row__expanded"><td colSpan={5}><DayTable row={row} page={page} ctx={ctx} onOpenDetail={onOpenDetail} compact={false} /></td></tr> : null}
          </tbody>;
        })}
      <tfoot><tr className="jy-profit-totals">
        <td>{totals.label}</td><td className="jy-profit-num">{totals.income}</td><td className="jy-profit-num">{totals.actual}</td><td className="jy-profit-num">{totals.gross}</td><td className="jy-profit-num">{totals.margin}</td>
      </tr></tfoot>
    </table>
  </div>;
}

function MobileCards(props: Props & { rows: ProfitRow[]; popOpen: string | null; setPopOpen: (key: string | null) => void }) {
  const { page, ctx, rows, expanded, onToggle, onOpenDetail } = props;
  return <ul className="jy-profit-cards">
    {rows.map((row) => {
      const open = expanded.has(row.rowKey), name = rowName(row), money = rowMoney(row, ctx.currency), cells = rowCells(row, ctx);
      const loss = cells.gross != null && cells.gross < 0;
      return <li key={row.rowKey} className={`jy-profit-card${open ? " is-open" : ""}`} data-row-key={row.rowKey}>
        <div className="jy-profit-card__head">
          <button type="button" className="jy-profit-card__toggle" aria-expanded={open} aria-label={open ? COPY.table.collapse(name) : COPY.table.expand(name)} onClick={() => onToggle(row.rowKey)}>
            <Icon name="expand" className={open ? "is-open" : undefined} /><strong>{name}</strong>
          </button>
          <RowBang row={row} popKey={`m:${row.rowKey}`} open={props.popOpen} onOpenChange={props.setPopOpen} onRetry={props.onRetry} onRefresh={props.onRefresh} retryingKeys={props.retryingKeys} retryErrors={props.retryErrors} />
          <b className="jy-profit-card__gross">{row.counted ? neg(loss, fmtMoney(money.gross, ctx.currency)) : EMPTY}</b>
        </div>
        <div className="jy-profit-card__sub"><span>{rowUpstream(row)}</span><span>{COPY.table.mobileLine(fmtMoney(cells.income, ctx.currency), row.counted ? marginText(money.gross, money.income) : EMPTY)}</span></div>
        {open ? <DayTable row={row} page={page} ctx={ctx} onOpenDetail={onOpenDetail} compact /> : null}
      </li>;
    })}
  </ul>;
}


export function ProfitTable(props: Props) {
  const { page, ctx, compact, switching, empty, sort } = props;
  const [popOpen, setPopOpen] = useState<string | null>(null);
  if (!page.rows.length) {
    return <Panel title={COPY.table.title} className="jy-profit-panel">
      <EmptyState title={COPY.table.emptyTitle} desc={COPY.table.emptyDesc} action={empty ? <Button type="primary" href={empty.href}>{empty.label}</Button> : null} />
    </Panel>;
  }
  const rows = sortRows(page.rows, sort, ctx);
  const column = COLUMNS.find((item) => item.key === sort.key)!.label;
  return <Panel title={COPY.table.title} badge={<CountBadge count={page.counts.channels} muted />} extra={compact ? <span className="jy-caption">{COPY.table.mobileSort(column, sort.dir === "desc")}</span> : undefined}
    body={compact ? false : "flush"} className={`jy-profit-panel${switching ? " jy-profit-switching" : ""}`}>
    <div aria-busy={switching || undefined}>
      {compact ? <MobileCards {...props} rows={rows} popOpen={popOpen} setPopOpen={setPopOpen} /> : <DesktopTable {...props} rows={rows} popOpen={popOpen} setPopOpen={setPopOpen} />}
    </div>
  </Panel>;
}
