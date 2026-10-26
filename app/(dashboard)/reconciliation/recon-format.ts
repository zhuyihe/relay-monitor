// 每日利润页的展示文案与纯函数：日期、金额格子、分组倍率、渠道。不含 JSX，各组件和 hooks 共用。
// 用语按 design/ui-copy-spec.md；时间一律按这条绑定算一天的时区显示（lib/format 的 zoned 系列），不用浏览器时区。
import { EMPTY, FIXED_COST_TEXT, RATE_UNSET_USD, UPSTREAM_GONE, formatRate, formatZonedDateTime, formatZonedWindow } from "../../../lib/format";
import {
  formatReconciliationAmount, formatReconciliationMoney, mergeReconciliationSegments, reconciliationBillingText, reconciliationChannelTag, reconciliationRateFactors,
  reconciliationNotStarted, reconciliationRatioChange,
} from "../../../lib/reconciliation-view";
import type { ReconciliationCurrency } from "../../../lib/client";
import { adminUsageLineOf } from "../../../lib/admin-usage-text";
import { isLiveReconciliationPreset, reconciliationIssue, sameReconciliationWindow } from "../../../lib/reconciliation-contract";
import { ERROR_CATEGORIES } from "../../../lib/error-copy";
import { workflowAction, workflowActionMeta } from "../../../lib/workflow-actions";

export type ReconPreset = "today" | "yesterday" | "7d" | "month" | "custom";
export type ReconWindow = { preset: ReconPreset; startMs?: number; endMs?: number };

export const PRESETS: { label: string; value: ReconPreset }[] = [
  { label: "今天", value: "today" },
  { label: "昨天", value: "yesterday" },
  { label: "近 7 天", value: "7d" },
  { label: "本月", value: "month" },
  { label: "自定义", value: "custom" },
];

// 截至现在的日期范围（今天、近 7 天、本月）金额随时间增长，页面定时重读
export const isLivePreset = (preset: string) => isLiveReconciliationPreset(preset);

// 单行「重新读取」失败时界面上那一句；原文放进「查看详细原因」（§8.2）
export const RETRY_FAILED_TEXT = "重新读取没完成，请稍后再试";

// 本页的按钮名（§3.5），都从 lib/workflow-actions.js 取
const actionLabel = (kind: string) => workflowActionMeta(kind)!.label;
export const RECON_BUTTONS = Object.freeze({
  refresh: actionLabel("refresh"), retry: actionLabel("retry_bill"), setup: actionLabel("setup_own_station"), history: actionLabel("open_history"),
  correctTiming: actionLabel("correct_timing"), connect: actionLabel("connect_channels"),
});

// 列表、计算明细和以前的每日记录里共用的几句
export const RECON_COPY = Object.freeze({
  moreIssues: (count: number) => `还有 ${count} 个问题`,
  noChannels: "这条绑定还没有渠道",
  incomeSource: (count: number) => `来自自营站点 ${count} 个渠道的收费记录`,
});
// 「去设置」去哪：和需处理里的那个按钮同一个地址
export const SETUP_HREF = workflowAction("setup_own_station").href!;

// 读取失败时存下报错本身（带 code、status），页面再按 lib/error-copy.js 归类；抛出来的是空值时也要算出错
export const caughtError = (err: unknown) => err || new Error(ERROR_CATEGORIES.other.text);

// 包月、买断等按固定费用算的上游：上游成本一格不写金额（§3.2）

// 金额默认按系统原值（USD）；currency 为 CNY 时收入按自营站点汇率、成本按该上游自己的汇率折算（服务端已核对都设置了汇率）。
export const amountText = (value: any, currency: ReconciliationCurrency) => formatReconciliationAmount(value, currency);

// 固定成本的上游：Key 用量不计成本（费用计入固定成本），利润里上游成本记为 0
export const isFixedCost = (item: any) => item?.rates?.costBasis === "fixed";

// 某一侧金额的人民币汇率；按美元显示时为 null（原值）
export function sideRate(item: any, side: "income" | "cost", currency: ReconciliationCurrency) {
  const factors = reconciliationRateFactors(item?.rates, currency);
  return factors?.currency === "CNY" ? factors[side] : null;
}

// 显示口径的一侧金额，用于排序；取不到金额为 null
export function sideAmount(item: any, side: "income" | "cost", currency: ReconciliationCurrency) {
  if (side === "cost" && isFixedCost(item)) return 0;
  const billing = side === "income" ? item?.downstream : item?.upstream;
  const amount = Number(billing?.knownAmountUsd ?? billing?.amountUsd);
  return Number.isFinite(amount) ? amount * (sideRate(item, side, currency) ?? 1) : null;
}

// 收入、上游成本一格：读全了只写金额，没读全写「$1.20（没读全）」，没读到写「读取中」「读不到」
export const incomeText = (item: any, currency: ReconciliationCurrency, billing = item?.downstream) =>
  reconciliationNotStarted(item) ? EMPTY : reconciliationBillingText(billing, sideRate(item, "income", currency));
// 收入里减掉的管理员自用（用语规范 §9「管理员自用」）：写法和判断都在 lib/admin-usage-text.js（有单元测试），这里只把钱按汇率和币种写出来
export function adminUsageLine(item: any, currency: ReconciliationCurrency, billing = item?.downstream) {
  return adminUsageLineOf(billing, (usd: number) => formatReconciliationMoney(usd, sideRate(item, "income", currency)));
}
export const costText = (item: any, currency: ReconciliationCurrency, billing = item?.upstream) => reconciliationNotStarted(item) ? EMPTY : isFixedCost(item)
  ? FIXED_COST_TEXT : reconciliationBillingText(billing, sideRate(item, "cost", currency));

// 汇率一行（§9）：「1 美元 = 7.20 元」；收入和上游成本的汇率不一样时分开写；固定时记下的汇率写上固定的时间。
// 按美元显示时写「没设置汇率，按美元显示」（§7）。
export function rateText(item: any, currency: ReconciliationCurrency, timezone?: string) {
  const factors = reconciliationRateFactors(item?.rates, currency);
  if (factors?.currency !== "CNY") return RATE_UNSET_USD;
  const text = rateLine(factors.income, factors.cost, factors.fixedCost);
  return item?.ledger?.rates && item?.settledAt ? `${text}，${formatZonedDateTime(item.settledAt, timezone)} 固定时记下` : text;
}

// 汇率一行的正文，计算明细和以前的每日记录共用：两边一样写一次，不一样分开写；计入固定成本的只看收入；没有的写「—」
export function rateLine(income: any, cost: any, fixedCost = false) {
  const a = formatRate(income), b = formatRate(cost);
  return fixedCost || a === b ? a || EMPTY : `收入按 ${a || EMPTY}，上游成本按 ${b || EMPTY}`;
}

// 今天、近 7 天、本月截至取数时刻，各绑定截止点不同：同一预设、同一起点和时区就算同一段时间；起止和时区都相同的当然也算
export function sameRequestedWindow(a: any, b: any) {
  return sameReconciliationWindow(a, b) || sameReconciliationWindow(a, b, { asRequested: true });
}

// 一整天「10月9日」，几天「10月1日–10月7日」，今天「10月16日 0:00–14:30」（§6）
export const formatWindow = (window: any) => formatZonedWindow(window);

// 10月9日 14:30
export const formatRecentTime = (value: any, timezone?: string) => formatZonedDateTime(value, timezone);

export function upstreamName(rule: any, upstreams: any) {
  if (!Array.isArray(upstreams)) return "上游账号暂时读不到";
  const station = upstreams.find((item) => String(item.id) === String(rule?.upstreamStationId));
  return station?.name || UPSTREAM_GONE;
}

export function ratioLabel(value: any) {
  return value == null ? reconciliationIssue("GROUP_DATA_UNAVAILABLE").ratio : `${value}×`;
}

// 一次倍率的起止：「10月9日 14:30–10月10日 0:00」，还在用的写「10月9日 14:30 至今」
export function segmentPeriod(segment: any, timezone?: string) {
  const from = formatZonedDateTime(segment.effectiveFrom, timezone);
  return segment.effectiveTo == null ? `${from} 至今` : `${from}–${formatZonedDateTime(segment.effectiveTo, timezone)}`;
}

// 计算明细里上游成本一行的补充：「倍率在 14:30 从 1× 变成 1.2×，分两段算」；所选日期里没变过时不写
export function ratioChangeText(item: any, timezone?: string) {
  const change = reconciliationRatioChange(item, timezone);
  if (!change) return "";
  return change.from != null && change.to != null && change.from !== change.to
    ? `倍率在 ${change.time} 从 ${ratioLabel(change.from)} 变成 ${ratioLabel(change.to)}，分两段算`
    : `倍率在 ${change.time} 变了，分两段算`;
}

// 倍率变化的时间从哪来：系统按读到的变化估的要提示能改；人改过的写明是手动改的（不写「改过」，那是已固定的日子又重算过，§4）；最初那段不写
export function segmentTimingLabel(segment: any) {
  return segment.timingSource === "detected" ? reconciliationIssue("SEGMENT_TIMING_UNCONFIRMED").hint
    : segment.timingSource === "operator_confirmed" ? "倍率变化的时间是手动改的" : "";
}

export function currentGroup(item: any) {
  return item?.currentSegment?.group || item?.upstream?.group || item?.rule?.fixedGroup || EMPTY;
}

function currentRatio(item: any) {
  if (Object.prototype.hasOwnProperty.call(item?.upstream || {}, "ratio")) return item.upstream.ratio;
  return item?.currentSegment?.ratio;
}

export const currentRatioLabel = (item: any) => ratioLabel(currentRatio(item));

export function ruleHistory(item: any) {
  return mergeReconciliationSegments(item?.transitionSegments, item?.segments);
}

// 绑定的渠道里有几个已停用、已删除（§5.4）；都正常时不写
export function channelStateSummary(channels: any[]) {
  return ["SALES_CHANNEL_DISABLED", "SALES_CHANNEL_MISSING"].map((code) => {
    const tag = reconciliationIssue(code).tag;
    const count = channels.filter((channel) => reconciliationChannelTag(channel) === tag).length;
    return count ? `${tag} ${count}` : "";
  }).filter(Boolean).join(" · ");
}
