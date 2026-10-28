"use client";
// 每日利润的那一张对账表（设计稿 daily-profit-a.md §2–§4）：桌面一行一个渠道（收入、应付成本、上游成本、差额、毛利），
// 手机一个渠道一张卡片；点开一行看「差在哪」和每天的小格，点一格打开那天的计算明细。
// 字都从 copy.ts 和 profit-format.ts 来，这里只负责摆；金额不上色，对不上靠小标签和整行的底色。
import { Fragment } from "react";
import type { ReactNode } from "react";
import { Alert, Button } from "antd";
import { RecheckConsumeLogButton } from "../../components/recheck-consume-log";
import { Icon } from "../../components/icons";
import { CountBadge, Panel } from "../../components/panel";
import { Seg } from "../../components/seg";
import { EmptyState } from "../../components/data-state";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import type { ProfitPageResponse, ProfitRow, WorkflowAction } from "../../../lib/client";
import { EMPTY, formatDayKey } from "../../../lib/format";
import { COPY } from "./copy";
import {
  attentionNote, dayCellView, filterCounts, filterRows, fmtMoney, gapCell, gapHeader, isSingleDay, isTodayView, rangeDays, rowMoney, rowName, rowSubtitle, rowTone, showExpectedColumn,
  marginText, totalsRow, whereGapText, yesterdayOf,
} from "./profit-format";
import type { Ctx, GapCell, ProfitFilter } from "./profit-format";

type Props = {
  page: ProfitPageResponse; ctx: Ctx; compact: boolean; switching: boolean;
  filter: ProfitFilter; onFilter: (filter: ProfitFilter) => void;
  expanded: Set<string>; onToggle: (rowKey: string) => void;
  onOpenDetail: (row: ProfitRow, day: string) => void;
  onRetry: (row: ProfitRow) => void; onRefresh: () => void;
  retryingKeys: Set<string>; retryErrors: Record<string, unknown>;
  empty: { href: string; label: string } | null;
};

const toneClass = (tone: ReturnType<typeof rowTone>) => (tone ? ` jy-profit-row--${tone}` : "");

// 差额那一格：第一行的数、灰字、小标签
function GapText({ cell, prefix }: { cell: GapCell; prefix?: string }) {
  return <span className={`jy-profit-gap${cell.muted ? " jy-profit-gap--muted" : ""}`}>
    <span className="jy-profit-gap__main">{prefix}{cell.main}{cell.tag ? <span className={`jy-profit-tag jy-profit-tag--${cell.tone}`}>{COPY.gap.tag}</span> : null}</span>
    {cell.sub ? <small>{cell.sub}</small> : null}
  </span>;
}

// 需处理那一行的按钮（§5.2）：重新读取在本页做；去别处处理的直接跳转；刷新就是整页刷新
function ActionButton({ action, row, onRetry, onRefresh, retrying, size }: { action: WorkflowAction | null; row: ProfitRow; onRetry: (row: ProfitRow) => void; onRefresh: () => void; retrying: boolean; size?: "small" }) {
  // label 空：这一天碰到过自营站点没记收费记录的那段，没有按钮（R2）
  if (!action || !action.label) return null;
  const label = `${action.label} ${rowName(row)}`;
  // 重新检查：点了才马上再读一次自营站点的设置，三处入口同一个按钮（R2）；读完页面自己重读（page.tsx 听事件）
  if (action.kind === "recheck_consume_log") return <RecheckConsumeLogButton size={size} aria-label={label} />;
  if (action.kind === "retry_bill") return <Button size={size} loading={retrying} aria-label={label} onClick={() => onRetry(row)}>{action.label}</Button>;
  if (action.kind === "refresh") return <Button size={size} aria-label={label} onClick={onRefresh}>{action.label}</Button>;
  if (action.href) return <Button size={size} aria-label={label} href={action.href}>{action.label}</Button>;
  return null;
}

function AttentionLine({ row, page, ctx, onRetry, onRefresh, retrying, retryError, compact }: { row: ProfitRow; page: ProfitPageResponse; ctx: Ctx; onRetry: (row: ProfitRow) => void; onRefresh: () => void; retrying: boolean; retryError?: unknown; compact: boolean }) {
  const attention = row.attention!;
  const note = attentionNote(row, page, ctx);
  const text = [attention.title, attention.detail].filter(Boolean).join("。");
  return <div className="jy-profit-attention">
    <span className="jy-profit-attention__text">
      <b>{COPY.attention.prefix}</b>{text}{note ? ` · ${note}` : ""}{attention.moreCount > 0 ? ` · ${COPY.attention.more(attention.moreCount)}` : ""}
    </span>
    <ActionButton action={attention.action} row={row} onRetry={onRetry} onRefresh={onRefresh} retrying={retrying} size={compact ? undefined : "small"} />
    {retryError ? <Alert type="error" showIcon title={COPY.attention.retryFailed} description={<ErrorDetail raw={noteOf(retryError).raw} />} /> : null}
  </div>;
}

// 点开一行：左边「差在哪」一句和链接，右边每天的小格（一个月时格子多，上下排）
function Expanded({ row, page, ctx, onOpenDetail, compact }: { row: ProfitRow; page: ProfitPageResponse; ctx: Ctx; onOpenDetail: (row: ProfitRow, day: string) => void; compact: boolean }) {
  const single = isSingleDay(page);
  const cells = row.daily.map((cell) => dayCellView(cell, page, ctx, row.rates?.cost ?? null));
  const wide = cells.length > 7;
  const viewed = rangeDays(page).first;
  const detailDay = single ? viewed : null;
  return <div className={`jy-profit-where${wide ? " jy-profit-where--wide" : ""}`}>
    <div className="jy-profit-where__text">
      <strong>{wide ? COPY.expanded.dailyTitleRange : COPY.expanded.where}</strong>
      <p>{whereGapText(row, page, ctx)}</p>
      <div className="jy-profit-where__links">
        {detailDay && !compact ? <Button type="link" size="small" onClick={() => onOpenDetail(row, detailDay)}>{COPY.expanded.seeDetail}</Button> : null}
        {row.key.upstreamKeyUrl ? <Button type="link" size="small" href={row.key.upstreamKeyUrl} target="_blank" rel="noreferrer">{COPY.expanded.upstreamKey}</Button> : null}
      </div>
    </div>
    <div className="jy-profit-where__days">
      {!wide ? <strong>{single ? COPY.expanded.dailyTitle : COPY.expanded.dailyTitleRange}</strong> : null}
      <div className="jy-profit-days" role="group" aria-label={single ? COPY.expanded.dailyTitle : COPY.expanded.dailyTitleRange}>
        {cells.map((cell) => <button
          key={cell.day} type="button" title={cell.title} aria-label={`${cell.title} ${cell.text}`} disabled={!cell.clickable}
          className={`jy-profit-day${cell.tone ? ` jy-profit-day--${cell.tone}` : ""}${cell.today ? " jy-profit-day--today" : ""}${cell.disabled ? " jy-profit-day--off" : ""}`}
          onClick={() => onOpenDetail(row, cell.day)}
        ><span>{cell.label}</span><b>{cell.text}</b></button>)}
      </div>
      {compact && detailDay ? <Button onClick={() => onOpenDetail(row, detailDay)}>{COPY.expanded.seeDetailShort}</Button> : null}
    </div>
  </div>;
}

function DesktopTable(props: Props & { rows: ProfitRow[] }) {
  const { page, ctx, rows, expanded, onToggle, onOpenDetail, onRetry, onRefresh, retryingKeys, retryErrors } = props;
  const expectedCol = showExpectedColumn(page), header = gapHeader(page, ctx), totals = totalsRow(page, ctx);
  const columns = 3 + (expectedCol ? 1 : 0) + 3;
  // 全固定时五个数一行：收入、应付、实付、差额、毛利；其余：收入、实付、毛利、差额
  const Num = ({ children, sub }: { children: ReactNode; sub?: string }) => <td className="jy-profit-num">{children}{sub ? <small>{sub}</small> : null}</td>;
  const gapCol = (row: ProfitRow) => <td className="jy-profit-num jy-profit-num--gap"><GapText cell={gapCell(row, page, ctx)} /></td>;
  return <div className="jy-table-wrap">
    <table className="jy-profit-table">
      <thead><tr>
        <th>{COPY.table.col.channel}</th>
        <th className="jy-profit-num">{COPY.table.col.income}</th>
        {expectedCol ? <th className="jy-profit-num">{COPY.table.col.expected}</th> : null}
        <th className="jy-profit-num">{COPY.table.col.actual}</th>
        {expectedCol ? <th className="jy-profit-num">{header.title}{header.sub ? <small>{header.sub}</small> : null}</th> : null}
        <th className="jy-profit-num">{COPY.table.col.gross}</th>
        <th className="jy-profit-num">{COPY.table.col.margin}</th>
        {!expectedCol ? <th className="jy-profit-num">{header.title}{header.sub ? <small>{header.sub}</small> : null}</th> : null}
      </tr></thead>
      <tbody>
        {rows.map((row) => {
          const money = rowMoney(row, ctx.currency), open = expanded.has(row.rowKey), tone = toneClass(rowTone(row, page)), name = rowName(row);
          const income = fmtMoney(money.income ?? money.uncountedIncome, ctx.currency);
          const actual = !row.counted && money.actual == null ? <span className="jy-profit-unread">{COPY.table.unreadable}</span> : fmtMoney(money.actual, ctx.currency);
          return <Fragment key={row.rowKey}>
            <tr className={`jy-profit-row${tone}${open ? " is-open" : ""}`} data-row-key={row.rowKey} onClick={() => onToggle(row.rowKey)}>
              <td className="jy-profit-row__name">
                <button type="button" className="jy-profit-row__toggle" aria-expanded={open} aria-label={open ? COPY.table.collapse(name) : COPY.table.expand(name)} onClick={(event) => { event.stopPropagation(); onToggle(row.rowKey); }}>
                  <Icon name="expand" className={open ? "is-open" : undefined} /><strong>{name}</strong>
                </button>
                <small>{rowSubtitle(row, page, ctx)}</small>
              </td>
              <Num>{income}</Num>
              {expectedCol ? <Num>{fmtMoney(money.expected, ctx.currency)}</Num> : null}
              <Num>{actual}</Num>
              {expectedCol ? gapCol(row) : null}
              <Num>{row.counted ? fmtMoney(money.gross, ctx.currency) : EMPTY}</Num>
              <Num>{row.counted ? marginText(money.gross, money.income) : EMPTY}</Num>
              {!expectedCol ? gapCol(row) : null}
            </tr>
            {row.attention ? <tr className={`jy-profit-row jy-profit-row__attention${tone}`}><td colSpan={columns}>
              <AttentionLine row={row} page={page} ctx={ctx} onRetry={onRetry} onRefresh={onRefresh} retrying={retryingKeys.has(row.rowKey)} retryError={retryErrors[row.rowKey]} compact={false} />
            </td></tr> : null}
            {open ? <tr className={`jy-profit-row jy-profit-row__expanded${tone}`}><td colSpan={columns}><Expanded row={row} page={page} ctx={ctx} onOpenDetail={onOpenDetail} compact={false} /></td></tr> : null}
          </Fragment>;
        })}
      </tbody>
      <tfoot><tr className="jy-profit-totals">
        <td>{totals.label}</td>
        <Num>{totals.income}</Num>
        {expectedCol ? <Num sub={totals.expectedSub}>{totals.expected}</Num> : null}
        <Num>{totals.actual}</Num>
        {expectedCol ? <Num sub={totals.gapSub}>{totals.gap}</Num> : null}
        <Num>{totals.gross}</Num>
        <Num>{marginText(page.pageTotals.grossProfitUsd, page.pageTotals.incomeUsd)}</Num>
        {!expectedCol ? <Num sub={totals.gapSub}>{totals.gap}</Num> : null}
      </tr></tfoot>
    </table>
  </div>;
}

function MobileCards(props: Props & { rows: ProfitRow[] }) {
  const { page, ctx, rows, expanded, onToggle, onOpenDetail, onRetry, onRefresh, retryingKeys, retryErrors } = props;
  const todayView = isTodayView(page), expectedCol = showExpectedColumn(page);
  // 今天的卡片差额那一行写「昨天多扣 $1.20」（最近固定的不是昨天时写那一天）
  const latestDay = page.latestSettledGap?.day;
  const gapLabel = todayView ? (!latestDay || latestDay === yesterdayOf(page) ? COPY.table.yesterdayGapShort : COPY.table.dayGapShort(formatDayKey(latestDay, ctx.tz, ctx.now))) : COPY.table.col.gap;
  return <div className="jy-profit-cards">
    {rows.map((row) => {
      const money = rowMoney(row, ctx.currency), open = expanded.has(row.rowKey), tone = toneClass(rowTone(row, page)), name = rowName(row), cell = gapCell(row, page, ctx);
      const income = fmtMoney(money.income ?? money.uncountedIncome, ctx.currency), actual = !row.counted && money.actual == null ? COPY.table.unreadable : fmtMoney(money.actual, ctx.currency);
      return <article key={row.rowKey} className={`jy-profit-card${tone}${open ? " is-open" : ""}`} data-row-key={row.rowKey}>
        <button type="button" className="jy-profit-card__head" aria-expanded={open} aria-label={open ? COPY.table.collapse(name) : COPY.table.expand(name)} onClick={() => onToggle(row.rowKey)}>
          <span className="jy-profit-card__top"><strong>{name}</strong><b>{open ? COPY.table.collapseShort : row.counted ? fmtMoney(money.gross, ctx.currency) : EMPTY}</b></span>
          <small>{rowSubtitle(row, page, ctx)}</small>
          {!open ? <>
            <span className="jy-profit-card__line">{COPY.table.mobileIncomeActual(income, actual)}</span>
            {!row.attention || cell.main !== EMPTY ? <span className={`jy-profit-card__line${cell.muted ? " jy-profit-card__line--muted" : ""}`}>
              {COPY.table.gapLine(gapLabel, cell.main, cell.main === EMPTY ? cell.sub : "")}{cell.tag ? <span className={`jy-profit-tag jy-profit-tag--${cell.tone}`}>{COPY.gap.tag}</span> : null}
            </span> : null}
          </> : null}
        </button>
        {row.attention ? <AttentionLine row={row} page={page} ctx={ctx} onRetry={onRetry} onRefresh={onRefresh} retrying={retryingKeys.has(row.rowKey)} retryError={retryErrors[row.rowKey]} compact /> : null}
        {open ? <div className="jy-profit-card__body">
          <dl className="jy-profit-card__facts">
            <dt>{COPY.table.col.income}</dt><dd>{income}</dd>
            {expectedCol ? <><dt>{COPY.table.col.expected}</dt><dd>{fmtMoney(money.expected, ctx.currency)}</dd></> : null}
            <dt>{COPY.table.col.actual}</dt><dd>{actual}</dd>
            <dt>{gapHeader(page, ctx).title}</dt><dd><GapText cell={cell} /></dd>
            <dt>{COPY.table.col.gross}</dt><dd><b>{row.counted ? fmtMoney(money.gross, ctx.currency) : EMPTY}</b></dd>
            <dt>{COPY.table.col.margin}</dt><dd>{row.counted ? marginText(money.gross, money.income) : EMPTY}</dd>
          </dl>
          <Expanded row={row} page={page} ctx={ctx} onOpenDetail={onOpenDetail} compact />
        </div> : null}
      </article>;
    })}
  </div>;
}

export function ProfitTable(props: Props) {
  const { page, compact, filter, onFilter, switching, empty } = props;
  const counts = filterCounts(page);
  const rows = filterRows(page.rows, filter, page);
  const filterSeg = <Seg
    size={compact ? undefined : "sm"} label={COPY.table.filterLabel} value={filter} onChange={onFilter}
    options={[{ value: "all", label: COPY.table.filterAll, count: counts.all }, { value: "mismatched", label: COPY.table.filterMismatched, count: counts.mismatched }, { value: "attention", label: COPY.table.filterAttention, count: counts.attention }]}
  />;
  if (!page.rows.length) {
    return <Panel title={COPY.table.title} className="jy-profit-panel">
      <EmptyState title={COPY.table.emptyTitle} desc={COPY.table.emptyDesc} action={empty ? <Button type="primary" href={empty.href}>{empty.label}</Button> : null} />
    </Panel>;
  }
  if (compact) {
    return <div className={`jy-profit-mobile${switching ? " jy-profit-switching" : ""}`} aria-busy={switching || undefined}>
      <div className="jy-profit-filter">{filterSeg}</div>
      {rows.length ? <MobileCards {...props} rows={rows} /> : <EmptyState title={COPY.table.noMatch} center={false} />}
    </div>;
  }
  return <Panel title={COPY.table.title} badge={<CountBadge count={counts.all} muted />} extra={filterSeg} body="flush" className={`jy-profit-panel${switching ? " jy-profit-switching" : ""}`}>
    <div aria-busy={switching || undefined}>
      {rows.length ? <DesktopTable {...props} rows={rows} /> : <EmptyState title={COPY.table.noMatch} center={false} />}
    </div>
  </Panel>;
}
