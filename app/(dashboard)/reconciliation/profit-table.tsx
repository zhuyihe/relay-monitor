"use client";
// 每日利润的渠道表（设计 10-29）：桌面一行一个渠道（收入、上游成本、毛利、毛利率），默认按毛利从高到低、点表头换排法、亏钱的标红；
// 点开一个渠道一天一行，行末「计算明细」打开那天的计算明细；需处理的渠道名字后面一个感叹号，点开写原因加按钮。手机一个渠道一张卡片。
// 字都从 copy.ts 和 profit-format.ts 来，这里只负责摆。
import { Fragment, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Button } from "antd";
import { RecheckConsumeLogButton } from "../../components/recheck-consume-log";
import { IssueBang, IssuePop } from "../../components/issue-bang";
import { CountBadge, Panel } from "../../components/panel";
import { EmptyState } from "../../components/data-state";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import type { ProfitKeyRow, ProfitPageResponse, ProfitRow, WorkflowAction } from "../../../lib/client";
import { EMPTY } from "../../../lib/format";
import { COPY } from "./copy";
import { DEFAULT_SORT, arrangeRows, bubbleDiagnostic, fmtMoney, isTodayView, marginText, hasKeyRows, isSingleDay, isUnbound, keyCells, keyLabel, keyTag, rangeDays, rowCells, rowMoney, rowName, rowUpstream, swappedUpstream, totalsRow } from "./profit-format";
import type { Ctx, RowGroup, RowLayout, Sort, SortKey } from "./profit-format";

type Props = {
  page: ProfitPageResponse; ctx: Ctx; compact: boolean; switching: boolean;
  sort: Sort | null; onSort: (key: SortKey) => void;
  // 看一天时是这一天（点这一行、「计算明细」打开这天的明细），看多天是 null（行不能点）；hold：开着计算明细时列表先别动
  detailDay: string | null; hold: boolean;
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
        {/* 读上游失败（被拒、读不到、超时）时上游回的原话（服务端脱敏过）：和上游列表、重新读取报错同一个「查看详细原因」 */}
        {bubbleDiagnostic(row) ? <ErrorDetail raw={bubbleDiagnostic(row)} /> : null}
      </IssuePop>
    </IssueBang>
  </span>;
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

// Key 行（用过两把以上 Key 的渠道下面一直挂着，不能收起、不能点）：缩进、灰一点，列和渠道行一样；标签看一天只写「在用」「已换掉」，看多天带日子
type KeyView = { singleDay: boolean; first: string; tz: string; now: number };
const keyView = (page: ProfitPageResponse, ctx: Ctx): KeyView => ({ singleDay: isSingleDay(page), first: rangeDays(page).first, tz: ctx.tz, now: ctx.now ?? Date.now() });
function KeyTag({ keyRow, view }: { keyRow: ProfitKeyRow; view: KeyView }) {
  const tag = keyTag(keyRow, view.singleDay, view.first, view.tz, view.now);
  return tag ? <em className={`jy-tag jy-profit-key-tag ${keyRow.state === "active" ? "jy-tag--info" : "jy-tag--type"}`}>{tag}</em> : null;
}
function KeyRowDesktop({ row, keyRow, ctx, view, detailDay }: { row: ProfitRow; keyRow: ProfitKeyRow; ctx: Ctx; view: KeyView; detailDay: string | null }) {
  const cells = keyCells(keyRow, row, ctx), loss = cells.gross != null && cells.gross < 0;
  return <tr className="jy-profit-keyrow" data-key-of={row.rowKey}>
    <td className="jy-profit-keyrow__name"><span>{keyLabel(keyRow, swappedUpstream(row))}</span><KeyTag keyRow={keyRow} view={view} /></td>
    <td className="jy-profit-num">{fmtMoney(cells.income, ctx.currency)}</td>
    <td className="jy-profit-num">{fmtMoney(cells.actual, ctx.currency)}</td>
    <td className="jy-profit-num">{cells.gross == null ? EMPTY : neg(loss, fmtMoney(cells.gross, ctx.currency))}</td>
    <td className="jy-profit-num">{cells.gross == null ? EMPTY : neg(loss, marginText(cells.gross, cells.income))}</td>
    {detailDay ? <td /> : null}
  </tr>;
}

// 看一天时（今天、昨天、选的某一天）每行最后一个「计算明细」，点它或点这一行都打开这天的计算明细；看多天时没有，行也不能点
function DesktopTable(props: Props & { groups: RowGroup[]; popOpen: string | null; setPopOpen: (key: string | null) => void }) {
  const { page, ctx, groups, onOpenDetail, sort, onSort, detailDay } = props;
  const view = keyView(page, ctx);
  const totals = totalsRow(page, ctx), columns = COLUMNS.length + (detailDay ? 1 : 0);
  return <div className="jy-table-wrap">
    <table className="jy-profit-table">
      <thead><tr>
        {COLUMNS.map((column) => <th key={column.key} className={column.key === "name" ? undefined : "jy-profit-num"} aria-sort={sort?.key === column.key ? (sort.dir === "desc" ? "descending" : "ascending") : undefined}>
          <button type="button" className="jy-profit-sort" onClick={() => onSort(column.key)}>{column.label}{sort?.key === column.key ? <span aria-hidden="true">{sort.dir === "desc" ? " ▼" : " ▲"}</span> : null}</button>
        </th>)}
        {detailDay ? <th aria-label={COPY.table.day.detail} /> : null}
      </tr></thead>
      {groups.map((group) => <tbody key={group.key} className="jy-profit-group" data-group={group.key}>
        {group.title ? <tr className={`jy-profit-group__title is-${group.key}`}><td colSpan={columns}>{group.key === "active" ? <i className="jy-profit-group__dot" aria-hidden="true" /> : null}{group.title}</td></tr> : null}
        {group.rows.map((row) => {
          const name = rowName(row);
          return <Fragment key={row.rowKey}><tr className={`jy-profit-row${detailDay ? " is-clickable" : ""}`} data-row-key={row.rowKey} onClick={detailDay ? () => onOpenDetail(row, detailDay) : undefined}>
            <td className="jy-profit-row__name">
              <span className="jy-profit-row__line">
                <strong>{name}</strong>
                {isUnbound(row) ? <em className="jy-tag jy-tag--type jy-profit-unbound-tag">{COPY.table.unboundTag}</em> : null}
                <RowBang row={row} popKey={row.rowKey} open={props.popOpen} onOpenChange={props.setPopOpen} onRetry={props.onRetry} onRefresh={props.onRefresh} retryingKeys={props.retryingKeys} retryErrors={props.retryErrors} />
              </span>
              {rowUpstream(row) ? <small>{rowUpstream(row)}</small> : null}
            </td>
            <Cells row={row} ctx={ctx} />
            {detailDay ? <td className="r jy-profit-detail-cell"><Button type="link" size="small" aria-label={`${COPY.table.day.detail} ${name}`} onClick={(event) => { event.stopPropagation(); onOpenDetail(row, detailDay); }}>{COPY.table.day.detail}</Button></td> : null}
          </tr>{hasKeyRows(row) ? row.keys!.map((key) => <KeyRowDesktop key={String(key.tokenId)} row={row} keyRow={key} ctx={ctx} view={view} detailDay={detailDay} />) : null}</Fragment>;
        })}
      </tbody>)}
      <tfoot><tr className="jy-profit-totals">
        <td>{totals.label}</td><td className="jy-profit-num">{totals.income}</td><td className="jy-profit-num">{totals.actual}</td><td className="jy-profit-num">{totals.gross}</td><td className="jy-profit-num">{totals.margin}</td>{detailDay ? <td /> : null}
      </tr></tfoot>
    </table>
  </div>;
}

function MobileCards(props: Props & { groups: RowGroup[]; popOpen: string | null; setPopOpen: (key: string | null) => void }) {
  const { page, ctx, groups, onOpenDetail, detailDay } = props;
  const view = keyView(page, ctx);
  return <div className="jy-profit-cards-wrap">
    {groups.map((group) => <section key={group.key} data-group={group.key}>
      {group.title ? <div className={`jy-profit-group__title jy-profit-group__title--card is-${group.key}`}>{group.key === "active" ? <i className="jy-profit-group__dot" aria-hidden="true" /> : null}{group.title}</div> : null}
      <ul className="jy-profit-cards">
        {group.rows.map((row) => {
          const name = rowName(row), money = rowMoney(row, ctx.currency), cells = rowCells(row, ctx);
          const loss = cells.gross != null && cells.gross < 0;
          return <li key={row.rowKey} className={`jy-profit-card${detailDay ? " is-clickable" : ""}`} data-row-key={row.rowKey} onClick={detailDay ? () => onOpenDetail(row, detailDay) : undefined}>
            <div className="jy-profit-card__head">
              <strong>{name}</strong>
              {isUnbound(row) ? <em className="jy-tag jy-tag--type jy-profit-unbound-tag">{COPY.table.unboundTag}</em> : null}
              <RowBang row={row} popKey={`m:${row.rowKey}`} open={props.popOpen} onOpenChange={props.setPopOpen} onRetry={props.onRetry} onRefresh={props.onRefresh} retryingKeys={props.retryingKeys} retryErrors={props.retryErrors} />
              <b className="jy-profit-card__gross">{row.counted ? neg(loss, fmtMoney(money.gross, ctx.currency)) : EMPTY}</b>{detailDay ? <span className="jy-profit-card__chev" aria-hidden="true">›</span> : null}
            </div>
            <div className="jy-profit-card__sub"><span title={rowUpstream(row) || undefined}>{rowUpstream(row)}</span><span>{COPY.table.mobileLine(fmtMoney(cells.income, ctx.currency), row.counted ? marginText(money.gross, money.income) : EMPTY)}</span></div>
            {hasKeyRows(row) ? <ul className="jy-profit-keys">{row.keys!.map((key) => {
              const cells = keyCells(key, row, ctx);
              return <li key={String(key.tokenId)} className="jy-profit-key">
                <div className="jy-profit-key__head"><span>{keyLabel(key, swappedUpstream(row))}<KeyTag keyRow={key} view={view} /></span><b>{cells.gross == null ? EMPTY : marginText(cells.gross, cells.income)}</b></div>
                <div className="jy-profit-key__sub">{COPY.table.mobileKeyLine(fmtMoney(cells.income, ctx.currency), fmtMoney(cells.actual, ctx.currency))}</div>
              </li>;
            })}</ul> : null}
          </li>;
        })}
      </ul>
    </section>)}
  </div>;
}

export function ProfitTable(props: Props) {
  const { page, ctx, compact, switching, empty, sort } = props;
  const [popOpen, setPopOpen] = useState<string | null>(null);
  const lastLayout = useRef<RowLayout | null>(null);
  if (!page.rows.length) {
    return <Panel title={COPY.table.title} className="jy-profit-panel">
      <EmptyState title={COPY.table.emptyTitle} desc={COPY.table.emptyDesc} action={empty ? <Button type="primary" href={empty.href}>{empty.label}</Button> : null} />
    </Panel>;
  }
  // 开着计算明细或感叹号气泡时先别动，关掉再排（和上游列表同一个 keepOrder）
  const { groups, layout } = arrangeRows(page.rows, { today: isTodayView(page), sort }, ctx, lastLayout.current, props.hold || popOpen != null);
  lastLayout.current = layout;
  const column = COLUMNS.find((item) => item.key === (sort ?? DEFAULT_SORT).key)!.label;
  return <Panel title={COPY.table.title} badge={<CountBadge count={page.counts.channels} muted />} extra={compact ? <span className="jy-caption">{COPY.table.mobileSort(column, (sort ?? DEFAULT_SORT).dir === "desc")}</span> : undefined}
    body={compact ? false : "flush"} className={`jy-profit-panel${switching ? " jy-profit-switching" : ""}`}>
    <div aria-busy={switching || undefined}>
      {compact ? <MobileCards {...props} groups={groups} popOpen={popOpen} setPopOpen={setPopOpen} /> : <DesktopTable {...props} groups={groups} popOpen={popOpen} setPopOpen={setPopOpen} />}
    </div>
  </Panel>;
}
