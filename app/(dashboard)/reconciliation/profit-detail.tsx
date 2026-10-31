"use client";
// 计算明细（设计稿 daily-profit-a.md §5、用语规范 §9）：一行一天，从上到下收入、应付成本（按模型拆开）、没算进的模型、上游成本、差额、毛利，
// 最后倍率、固定于、改过。几个渠道合用一把 Key 时收入、应付成本按渠道各写一行，上游成本只有一个数。
import { useState } from "react";
import { Button } from "antd";
import { Icon } from "../../components/icons";
import { ErrorState, Skeleton } from "../../components/data-state";
import type { ProfitDetailKey, ProfitDetailResponse, ProfitPageResponse, ProfitRow } from "../../../lib/client";
import { EMPTY, formatCompact, formatDayKey, formatPct, formatZonedDateTime, formatZonedTime, OPTION_UNREADABLE_EXPECTED_NOTE, OPTION_UNREADABLE_SETTLED_NOTE } from "../../../lib/format";
import { formatReconciliationMoney } from "../../../lib/reconciliation-view";
import { dayKeyInTz } from "../../../lib/business-time";
import { COPY } from "./copy";
import { adminUsageText, fmtMoney, gapReasonText, groupText, marginText, modelUsageText, overUnderText, rateText, ratioLine, ratioText, signedMoney, toDisplay, unitPriceText, verifyView } from "./profit-format";
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

// 「核对上游扣费」：平时收起，右边一句结论；对不上的那天默认展开。里面是应付成本、没算进的模型、差额、倍率
function Verify({ summary, children }: { summary: { text: string; open: boolean; tone: "crit" | null }; children: React.ReactNode }) {
  const [open, setOpen] = useState(summary.open);
  return <section className="jy-profit-verify" data-open={open ? "1" : "0"}>
    <button type="button" className="jy-profit-verify__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Icon name="expand" className={open ? "is-open" : undefined} /><h3>{COPY.detail.verify.title}</h3>
      <span className={`jy-profit-verify__summary${summary.tone === "crit" ? " is-crit" : ""}`}>{summary.text}</span>
    </button>
    {open ? <div className="jy-profit-verify__body">{children}</div> : null}
  </section>;
}

// 这天用了不止一把 Key：一把一行（接口里在用的排前面），最后合计；下面写收入怎么分、成本从哪来
function KeysTable({ detail, keys, income, cost, incomeRate, costRate, ctx }: { detail: ProfitDetailResponse; keys: ProfitDetailKey[]; income: (usd: number | null | undefined) => string; cost: (usd: number | null | undefined) => string; incomeRate: number | null; costRate: number | null; ctx: Ctx }) {
  const text = COPY.detail.keys, withUpstream = !!detail.swappedUpstream;
  const cells = keys.map((key) => {
    // 这一把 Key 这天的汇率：已固定的天是结账时记的（换上游那天两把 Key 各按各上游的）
    const kc = key.costRate ?? costRate, ki = key.incomeRate ?? incomeRate;
    const i = toDisplay(key.incomeUsd, ki, ctx.currency), c = toDisplay(key.costUsd, kc, ctx.currency), g = i != null && c != null ? i - c : null;
    return { key, i, c, g };
  });
  const sum = (pick: (item: (typeof cells)[number]) => number | null) => cells.every((item) => pick(item) != null) ? cells.reduce((total, item) => total + pick(item)!, 0) : null;
  const total = { i: sum((item) => item.i), c: sum((item) => item.c), g: sum((item) => item.g), raw: keys.every((key) => key.rawUsd != null) ? keys.reduce((t, key) => t + key.rawUsd!, 0) : null };
  const shares = (detail.split?.shares || []).map((share) => text.share(keys.find((key) => String(key.tokenId) === String(share.tokenId))?.name ?? EMPTY, `${Math.round(share.percent)}%`)).join("，");
  const money = (value: number | null) => fmtMoney(value, ctx.currency);
  const split = detail.split?.basis === "raw" ? text.splitRaw(keys.length, shares) : detail.split?.basis === "cost" ? text.splitCost(keys.length, shares) : null;
  return <>
    <p>{text.intro(keys.length)}</p>
    <table className="jy-profit-models jy-profit-keystable">
      <thead><tr><th>{text.col.key}</th><th className="jy-profit-num">{text.col.ratio}</th><th className="jy-profit-num">{text.col.cost}</th><th className="jy-profit-num">{text.col.raw}</th><th className="jy-profit-num">{text.col.income}</th><th className="jy-profit-num">{text.col.gross}</th><th className="jy-profit-num">{text.col.margin}</th></tr></thead>
      <tbody>{cells.map(({ key, i, c, g }) => <tr key={String(key.tokenId)}>
        <td>{withUpstream ? `${key.upstream?.name ?? EMPTY} · ` : ""}{key.name}</td>
        <td className="jy-profit-num">{key.ratio != null ? `×${ratioText(key.ratio)}` : EMPTY}{key.ratioKind === "actual_over_standard" ? <small>{text.ratioKind}</small> : null}</td>
        <td className="jy-profit-num">{money(c)}</td><td className="jy-profit-num">{key.rawUsd != null ? fmtMoney(toDisplay(key.rawUsd, key.costRate ?? costRate, ctx.currency), ctx.currency) : EMPTY}</td>
        <td className="jy-profit-num">{money(i)}</td><td className="jy-profit-num">{money(g)}</td><td className="jy-profit-num">{g == null ? EMPTY : marginText(g, i)}</td>
      </tr>)}</tbody>
      <tfoot><tr><td>{COPY.detail.total}</td><td /><td className="jy-profit-num">{money(total.c)}</td><td className="jy-profit-num">{total.raw != null ? fmtMoney(toDisplay(total.raw, costRate, ctx.currency), ctx.currency) : EMPTY}</td><td className="jy-profit-num">{money(total.i)}</td><td className="jy-profit-num">{money(total.g)}</td><td className="jy-profit-num">{total.g == null ? EMPTY : marginText(total.g, total.i)}</td></tr></tfoot>
    </table>
    {split ? <p>{split}</p> : null}
    <p>{text.from(keys.length)}</p>
  </>;
}

function Body({ detail, row, page, ctx }: { detail: ProfitDetailResponse; row: ProfitRow; page: ProfitPageResponse; ctx: Ctx }) {
  // 汇率用这一天的（已固定的天是结账时记下的、换上游之前是旧上游的），接口没给才退回这一行现在的
  const incomeRate = detail.rates?.income ?? row.rates?.income ?? null, costRate = detail.rates?.cost ?? row.rates?.cost ?? null;
  const income = (usd: number | null | undefined) => fmtMoney(toDisplay(usd, incomeRate, ctx.currency), ctx.currency);
  const cost = (usd: number | null | undefined) => fmtMoney(toDisplay(usd, costRate, ctx.currency), ctx.currency);
  // 这天几块各按各的汇率换好的总数（接口算的）；没有就退回按上面那个汇率换
  const incomeTotal = ctx.currency === "CNY" && detail.income.cny != null ? fmtMoney(detail.income.cny, ctx.currency) : income(detail.income.usd);
  const actualTotal = ctx.currency === "CNY" && detail.actual.cny != null ? fmtMoney(detail.actual.cny, ctx.currency) : cost(detail.actual.usd);
  const grossTotal = detail.grossProfitUsd == null ? EMPTY : ctx.currency === "CNY" && detail.income.cny != null && detail.actual.cny != null ? fmtMoney(detail.income.cny - detail.actual.cny, ctx.currency)
    : fmtMoney(toDisplay(detail.income.usd, incomeRate, ctx.currency)! - toDisplay(detail.actual.usd, costRate, ctx.currency)!, ctx.currency);
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
  // 换 Key 的时刻（KEY_CHANGE_RATIO_DIFFERS 的说明用）：定得出写「14:30」，两次读取之间写「15:19–16:05 之间」；带不到就不写时刻
  const keyChangeWhen = (change: { atMs: number | null; between: [number, number] | null } | null | undefined) => change?.between && change.between[0] !== change.between[1]
    ? `${formatZonedTime(change.between[0], ctx.tz)}–${formatZonedTime(change.between[1], ctx.tz)} 之间` : change?.atMs != null ? formatZonedTime(change.atMs, ctx.tz) : null;
  // 新旧倍率不一样（换 Key 那天）：这天不比差额，写新的一句
  const verify = detail.keyChangeRatioDiffers ? { text: COPY.detail.verify.keyRatioDiffers, open: false, tone: null } : verifyView(detail, page, ctx, costRate, keyChangeWhen(detail.expected.keyChange));
  const keys = detail.keys && detail.keys.length >= 2 ? detail.keys : null;
  return <div className="jy-profit-detail">
    <Section title={COPY.detail.income} value={incomeTotal}>
      <p>{many ? COPY.detail.incomeFromMany(row.channels.length) : COPY.detail.incomeFrom(channelName(row.channels[0]?.channelId))}{admin ? `，${admin}` : ""}。</p>
      {many && detail.income.byChannel?.length ? <ul className="jy-profit-detail__list">{detail.income.byChannel.map((item) => <li key={item.channelId}><span>{channelName(item.channelId)}</span><b>{income(item.usd)}</b></li>)}</ul> : null}
    </Section>
    <Section title={COPY.detail.actual} value={actualTotal}>
      {detail.unavailable ? <p>{[detail.unavailable.title, detail.unavailable.detail].filter(Boolean).join("。") || COPY.detail.unavailableUnknown}</p>
        : keys ? <KeysTable detail={detail} keys={keys} income={income} cost={cost} incomeRate={incomeRate} costRate={costRate} ctx={ctx} />
          : <p>{COPY.detail.actualFrom(detail.actual.keyName || row.key.name)}</p>}
    </Section>
    <Section title={COPY.detail.gross} value={grossTotal}>
      <p>{COPY.detail.grossFormula}</p>
    </Section>
    <Verify key={`${detail.day}:${verify.open}`} summary={verify}>
      <Section title={COPY.detail.expected} value={detail.expected.usd == null ? EMPTY : cost(detail.expected.usd)}>
        {today ? <p>{COPY.detail.expectedToday}</p>
          : detail.expected.usd == null && !models.length ? <p>{gapReasonText(detail.expected.reason, missing.map((model) => model.model), { settled: detail.settled, zone: ctx.zoneOf?.(row), keyChangeWhen: keyChangeWhen(detail.expected.keyChange) })}</p>
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
      <Section title={COPY.detail.gap} value={gapValue}>
        <p>{COPY.detail.gapFormula}{gap?.rate != null && gap.state !== "within" ? `，${rateText(gap.rate)}` : ""}。{COPY.detail.gapNote(formatReconciliationMoney(page.gapThreshold.usd, null), formatPct(page.gapThreshold.rate, 0))}</p>
      </Section>
      <dl className="jy-kv jy-profit-detail__facts"><dt>{COPY.detail.ratio}</dt><dd>{ratioLine(detail, ctx.tz)}</dd></dl>
    </Verify>
    <dl className="jy-kv jy-profit-detail__facts">
      <dt>{COPY.detail.fixedAt}</dt><dd>{detail.fixedAt ? formatZonedDateTime(detail.fixedAt, ctx.tz) : COPY.detail.notFixed}</dd>
      {detail.settled ? <><dt>{COPY.detail.revised}</dt><dd>{detail.revisions && detail.revisions > 1 ? COPY.detail.revisedTimes(detail.revisions - 1) : COPY.detail.notRevised}</dd></> : null}
    </dl>
    {detail.settingUnreadable ? <p className="jy-caption">{OPTION_UNREADABLE_SETTLED_NOTE}{detail.expected.usd != null ? OPTION_UNREADABLE_EXPECTED_NOTE : ""}</p> : null}
    {row.key.upstreamKeyUrl ? <Button href={row.key.upstreamKeyUrl} target="_blank" rel="noreferrer">{COPY.expanded.upstreamKey}</Button> : null}
  </div>;
}

export function ProfitDetail({ detail, page, ctx, onRetry }: { detail: NonNullable<DetailState>; page: ProfitPageResponse; ctx: Ctx; onRetry: () => void }) {
  if (detail.loading) return <div aria-busy="true" className="jy-stack" style={{ gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} width={i === 3 ? "60%" : "100%"} />)}</div>;
  if (detail.error || !detail.data) return <ErrorState what={COPY.detail.readFailed} error={detail.error} onRetry={onRetry} />;
  return <Body detail={detail.data} row={detail.row} page={page} ctx={ctx} />;
}
