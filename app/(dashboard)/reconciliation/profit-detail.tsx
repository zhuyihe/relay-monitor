"use client";
// 计算明细（设计稿 daily-profit-a.md §5、用语规范 §9）：一行一天，从上到下收入、应付成本（按模型拆开）、没算进的模型、实付成本、差额、毛利，
// 最后倍率、固定于、改过。几个渠道合用一把 Key 时收入、应付成本按渠道各写一行，实付成本只有一个数。
import { Button } from "antd";
import { ErrorState, Skeleton } from "../../components/data-state";
import type { ProfitDetailResponse, ProfitPageResponse, ProfitRow } from "../../../lib/client";
import { EMPTY, formatCompact, formatDayKey, formatPct, formatZonedDateTime } from "../../../lib/format";
import { formatReconciliationMoney } from "../../../lib/reconciliation-view";
import { dayKeyInTz } from "../../../lib/business-time";
import { COPY } from "./copy";
import { adminUsageText, fmtMoney, gapReasonText, groupText, modelUsageText, overUnderText, rateText, ratioLine, ratioText, signedMoney, toDisplay, tokensText, unitPriceText } from "./profit-format";
import type { Ctx } from "./profit-format";
import type { DetailState } from "./use-profit-page";

// 抽屉标题「计算明细 · 备用 C · 10月25日」
export const detailTitle = (row: ProfitRow, day: string, ctx: Ctx) => COPY.detail.title(row.channels.map((channel) => channel.name || `渠道 ${channel.channelId}`).join("、"), formatDayKey(day, ctx.tz, ctx.now));

function Section({ title, value, children }: { title: string; value?: string; children?: React.ReactNode }) {
  return <section className="jy-profit-detail__sec">
    <header><h3>{title}</h3>{value != null ? <strong>{value}</strong> : null}</header>
    {children}
  </section>;
}

function Body({ detail, row, page, ctx }: { detail: ProfitDetailResponse; row: ProfitRow; page: ProfitPageResponse; ctx: Ctx }) {
  const incomeRate = row.rates?.income ?? null, costRate = row.rates?.cost ?? null;
  const income = (usd: number | null | undefined) => fmtMoney(toDisplay(usd, incomeRate, ctx.currency), ctx.currency);
  const cost = (usd: number | null | undefined) => fmtMoney(toDisplay(usd, costRate, ctx.currency), ctx.currency);
  const channelName = (channelId: number) => row.channels.find((channel) => channel.channelId === channelId)?.name || `渠道 ${channelId}`;
  const many = row.channels.length > 1;
  const group = groupText(detail.expected.groupName, detail.expected.groupRatio) || (detail.expected.groupRatio != null ? `×${ratioText(detail.expected.groupRatio)}` : EMPTY);
  const ratio = ratioText(detail.expected.groupRatio) || EMPTY;
  const admin = adminUsageText(detail.income.adminUsage, income);
  const models = detail.expected.byModel || [], missing = detail.expected.missingPriceModels || [];
  const totalTokens = detail.expected.tokens ?? (models.length ? models.reduce((sum, model) => sum + (model.inputTokens || 0) + (model.outputTokens || 0) + (model.cacheWriteTokens || 0), 0) : null);
  const gap = detail.gap;
  const gapValue = gap?.usd == null ? EMPTY : gap.state === "within" ? signedMoney(toDisplay(gap.usd, costRate, ctx.currency), ctx.currency) : overUnderText(toDisplay(gap.usd, costRate, ctx.currency)!, ctx.currency);
  const today = detail.day === page.today;
  return <div className="jy-profit-detail">
    <Section title={COPY.detail.income} value={income(detail.income.usd)}>
      <p>{many ? COPY.detail.incomeFromMany(row.channels.length) : COPY.detail.incomeFrom(channelName(row.channels[0]?.channelId))}{admin ? `，${admin}` : ""}。</p>
      {many && detail.income.byChannel?.length ? <ul className="jy-profit-detail__list">{detail.income.byChannel.map((item) => <li key={item.channelId}><span>{channelName(item.channelId)}</span><b>{income(item.usd)}</b></li>)}</ul> : null}
    </Section>
    <Section title={COPY.detail.expected} value={detail.expected.usd == null ? EMPTY : cost(detail.expected.usd)}>
      {today ? <p>{COPY.detail.expectedToday}</p>
        : detail.expected.usd == null && !models.length ? <p>{gapReasonText(detail.expected.reason, missing.map((model) => model.model), { settled: detail.settled, zone: ctx.zoneOf?.(row) })}</p>
          : <>
            <p>{many ? COPY.detail.expectedIntroMany(row.upstream.name || EMPTY, group) : COPY.detail.expectedIntro(row.upstream.name || EMPTY, group)}</p>
            {ctx.currency === "CNY" ? <p className="jy-caption">{COPY.detail.usdTable}</p> : null}
            <table className="jy-profit-models">
              <thead><tr><th>{COPY.detail.col.model}</th><th>{COPY.detail.col.usage}</th><th className="jy-profit-num">{COPY.detail.col.price}</th><th className="jy-profit-num">{COPY.detail.col.ratio(ratio)}</th></tr></thead>
              <tbody>{models.map((model) => <tr key={`${model.model}-${model.upstreamModel || ""}`}>
                <td>{model.model}</td>
                <td>{modelUsageText(model)}{unitPriceText(model.pricesPerMillion) ? <small>{unitPriceText(model.pricesPerMillion)}</small> : null}</td>
                <td className="jy-profit-num">{fmtMoney(model.beforeRatioUsd, "USD")}</td>
                <td className="jy-profit-num">{fmtMoney(model.usd, "USD")}</td>
              </tr>)}</tbody>
              <tfoot><tr><td>{COPY.detail.total}</td><td>{totalTokens != null ? COPY.detail.totalTokens(formatCompact(totalTokens)) : EMPTY}</td><td className="jy-profit-num">{fmtMoney(models.reduce((sum, model) => sum + (model.beforeRatioUsd || 0), 0), "USD")}</td><td className="jy-profit-num"><b>{detail.expected.usd == null ? EMPTY : fmtMoney(detail.expected.usd, "USD")}</b></td></tr></tfoot>
            </table>
            <p className="jy-caption">{COPY.detail.pricingNote}</p>
            {detail.expected.backfilledAt ? <p className="jy-caption">{COPY.detail.backfilled(formatDayKey(dayKeyInTz(Date.parse(detail.expected.backfilledAt), ctx.tz), ctx.tz))}</p> : null}
            {many && detail.expected.byChannel?.length ? <ul className="jy-profit-detail__list">{detail.expected.byChannel.map((item) => <li key={item.channelId}><span>{channelName(item.channelId)}</span><b>{cost(item.usd)}</b></li>)}</ul> : null}
          </>}
    </Section>
    {missing.length ? <Section title={COPY.detail.missing}>
      <p>{missing.map((model) => COPY.detail.missingOne(model.model, formatCompact(model.inputTokens), formatCompact(model.outputTokens))).join("、")}。{COPY.detail.missingHint}</p>
    </Section> : null}
    <Section title={COPY.detail.actual} value={cost(detail.actual.usd)}>
      <p>{COPY.detail.actualFrom(detail.actual.keyName || row.key.name)}</p>
    </Section>
    <Section title={COPY.detail.gap} value={gapValue}>
      <p>{COPY.detail.gapFormula}{gap?.rate != null && gap.state !== "within" ? `，${rateText(gap.rate)}` : ""}。{COPY.detail.gapNote(formatReconciliationMoney(page.gapThreshold.usd, null), formatPct(page.gapThreshold.rate, 0))}</p>
    </Section>
    <Section title={COPY.detail.gross} value={detail.grossProfitUsd == null ? EMPTY : fmtMoney(toDisplay(detail.income.usd, incomeRate, ctx.currency)! - toDisplay(detail.actual.usd, costRate, ctx.currency)!, ctx.currency)}>
      <p>{COPY.detail.grossFormula}</p>
    </Section>
    <dl className="jy-kv jy-profit-detail__facts">
      <dt>{COPY.detail.ratio}</dt><dd>{ratioLine(detail, ctx.tz)}</dd>
      <dt>{COPY.detail.fixedAt}</dt><dd>{detail.fixedAt ? formatZonedDateTime(detail.fixedAt, ctx.tz) : COPY.detail.notFixed}</dd>
      {detail.settled ? <><dt>{COPY.detail.revised}</dt><dd>{detail.revisions && detail.revisions > 1 ? COPY.detail.revisedTimes(detail.revisions - 1) : COPY.detail.notRevised}</dd></> : null}
    </dl>
    {row.key.upstreamKeyUrl ? <Button href={row.key.upstreamKeyUrl} target="_blank" rel="noreferrer">{COPY.expanded.upstreamKey}</Button> : null}
  </div>;
}

export function ProfitDetail({ detail, page, ctx, onRetry }: { detail: NonNullable<DetailState>; page: ProfitPageResponse; ctx: Ctx; onRetry: () => void }) {
  if (detail.loading) return <div aria-busy="true" className="jy-stack" style={{ gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} width={i === 3 ? "60%" : "100%"} />)}</div>;
  if (detail.error || !detail.data) return <ErrorState what={COPY.detail.readFailed} error={detail.error} onRetry={onRetry} />;
  return <Body detail={detail.data} row={detail.row} page={page} ctx={ctx} />;
}
