// 账单核算页的展示文案与纯函数：窗口、账单状态、分组倍率、渠道标签。不含 JSX，各组件和 hooks 共用。
// 时间一律按账单时区显示（lib/format 的 zoned 系列），不用浏览器时区。
import { EMPTY, formatZonedDateTime, formatZonedTime, formatZonedWindow } from "../../../lib/format";
import { formatReconciliationMoney as money, mergeReconciliationSegments } from "../../../lib/reconciliation-view";
import { isLiveReconciliationPreset, reconciliationHealthMeta } from "../../../lib/reconciliation-contract";

export type ReconPreset = "today" | "yesterday" | "7d" | "month" | "custom";
export type ReconWindow = { preset: ReconPreset; startMs?: number; endMs?: number };

export const PRESETS: { label: string; value: ReconPreset }[] = [
  { label: "今天", value: "today" },
  { label: "昨天", value: "yesterday" },
  { label: "近 7 天", value: "7d" },
  { label: "本月", value: "month" },
  { label: "自定义", value: "custom" },
];

// 截至现在的窗口（今天、近 7 天、本月）金额随时间增长，页面定时重读
export const isLivePreset = (preset: string) => isLiveReconciliationPreset(preset);

// 原始时间戳（UTC ISO），用于范围版本、生效时间等需要精确到毫秒的字段
export const iso = (value: number | null | undefined) => (value == null ? "未知" : new Date(value).toISOString());

export const channelStateLabel: Record<string, string> = {
  enabled: "启用", manual_disabled: "手动禁用", auto_disabled: "自动禁用", missing: "已缺失", unknown: "状态未知",
};

export const COVERAGE_STATUS_LABEL: Record<string, string> = {
  accounted: "已核算", unlinked: "未关联", not_effective: "范围未生效", source_unverified: "来源待核验",
  billing_missing: "账单未齐", coverage_unknown: "Key 用途待确认", duplicate: "重复归属",
};

// 服务端给出的结账状态；没有毛利时（待结账、不可用）表格已显示「待核算」，不再重复
export const SETTLEMENT_LABEL: Record<string, string> = { live: "实时", settled: "已结账", ended: "已结束" };

// 核算页的金额用 formatReconciliationMoney（负数为 "-$1.00"），百分比也用 ASCII 负号，同一页内保持一致
export function percent(value: any) {
  if (value == null) return EMPTY;
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : EMPTY;
}

function billingStateLabel(state: any) {
  return state === "complete" ? "完整" : state === "partial" ? "部分" : state === "pending" ? "待获取" : "不可用";
}

const BILLING_STATES = ["complete", "partial", "unavailable", "pending"];

export function billingAmountText(billing: any, rate: any) {
  if (!BILLING_STATES.includes(billing?.state)) return "— · 旧版待刷新";
  const state = billing.state;
  const amount = state === "complete" ? billing?.amountUsd : billing?.knownAmountUsd;
  if (amount == null || !Number.isFinite(Number(amount))) return `— · ${billingStateLabel(state)}`;
  return state === "complete" ? money(amount, rate) : `${money(amount, rate)} · ${billingStateLabel(state)}`;
}

export function billingCoverageText(billing: any) {
  if (!BILLING_STATES.includes(billing?.state)) return "旧版待刷新";
  const successful = Number(billing?.successfulCount);
  const expected = Number(billing?.expectedCount);
  return Number.isInteger(successful) && successful >= 0 && Number.isInteger(expected) && expected >= 0
    ? `已获取 ${successful}/${expected}` : billingStateLabel(billing?.state);
}

export function sameWindow(a: any, b: any) {
  return a?.startMs === b?.startMs && a?.endMs === b?.endMs && a?.timezone === b?.timezone;
}

// 10/07 00:00 — 10/08 00:00
export const formatWindow = (window: any) => formatZonedWindow(window);

// 10/07 00:00 — 10/08 00:00（Asia/Shanghai）
export const formatWindowWithZone = (window: any) => `${formatWindow(window)}（${window?.timezone}）`;

export function formatTime(value: any, timezone?: string) {
  const text = formatZonedTime(value, timezone);
  return text === EMPTY ? "暂未成功" : text;
}

export function formatRecentTime(value: any, timezone?: string, includeSeconds = false, includeYear = false) {
  return formatZonedDateTime(value, timezone, { year: includeYear, seconds: includeSeconds });
}

export function upstreamName(rule: any, upstreams: any) {
  if (!Array.isArray(upstreams)) return "上游账号目录暂不可用";
  const station = upstreams.find((item) => String(item.id) === String(rule?.upstreamStationId));
  return station?.name || `已删除的上游账号（${rule?.upstreamStationId || "未知站点"}）`;
}

export function ratioLabel(value: any) {
  return value == null ? "倍率未知" : `${value}×`;
}

export function segmentPeriod(segment: any, timezone?: string) {
  return `${formatRecentTime(segment.effectiveFrom, timezone, false, true)} — ${segment.effectiveTo == null ? "至今" : formatRecentTime(segment.effectiveTo, timezone, false, true)}`;
}

export function segmentTimingLabel(segment: any) {
  return segment.timingSource === "detected" ? "切换时间待确认"
    : segment.timingSource === "operator_confirmed" ? "已人工确认" : "初始分段";
}

export function currentGroup(item: any) {
  return item?.currentSegment?.group || item?.upstream?.group || item?.rule?.fixedGroup || "未返回";
}

function currentRatio(item: any) {
  if (Object.prototype.hasOwnProperty.call(item?.upstream || {}, "ratio")) return item.upstream.ratio;
  return item?.currentSegment?.ratio;
}

export function currentRatioLabel(item: any) {
  const ratio = currentRatio(item);
  if (ratio != null) return ratioLabel(ratio);
  const reference = item?.currentSegment?.ratio;
  if (reference == null) return "倍率未知";
  const observedAt = item?.currentSegment?.ratioObservedAt || item?.currentSegment?.observedAt;
  return `倍率未知 · 参考 ${reference}×${observedAt ? `（${formatRecentTime(observedAt, item?.window?.timezone)}）` : "（历史参考）"}`;
}

export function ruleHistory(item: any) {
  return mergeReconciliationSegments(item?.transitionSegments, item?.segments);
}

export function channelStateSummary(channels: any[]) {
  const enabled = channels.filter((channel) => channel.state === "enabled").length;
  const disabled = channels.filter((channel) => channel.state === "manual_disabled" || channel.state === "auto_disabled").length;
  const missing = channels.filter((channel) => channel.state === "missing").length;
  const unknown = channels.length - enabled - disabled - missing;
  return `启用 ${enabled} · 禁用 ${disabled} · 缺失 ${missing}${unknown ? ` · 未知 ${unknown}` : ""}`;
}

export function channelLabel(channel: any) {
  const id = channel.channelId ?? channel.id;
  return `${channel.name || `渠道 ${id ?? "—"}`} · ID ${id ?? "—"}`;
}

const CONFLICT_CODES = ["DUPLICATE_CHANNEL_ASSIGNMENT", "CANONICAL_KEY_CONFLICT"];

// 核算页只读：编辑渠道、停止核算等都回到「上游资源 → 上游账单」，并定位到这条核算关联。
export function upstreamBillsHref(ruleId: string, conflict = false) {
  return `/stations?action=${conflict ? "conflict" : "scope"}&ruleId=${encodeURIComponent(ruleId || "")}`;
}

export function rowHasConflict(item: any) {
  return CONFLICT_CODES.includes(item?.health?.code) || (item?.health?.issues || []).some((issue: any) => CONFLICT_CODES.includes(issue.code));
}

export function healthLabel(code: string) {
  if (code === "GROUP_DATA_UNAVAILABLE") return "当前上游分组目录不可用";
  if (code === "PERSISTENCE_FAILED") return "核算结果保存失败";
  return reconciliationHealthMeta(code).label || code;
}

export function coverageIssueLabel(issue: string) {
  return issue === "CHANNEL_UNLINKED" ? "尚未建立核算关联"
    : issue === "BILLING_EVIDENCE_NOT_QUERIED" ? "该窗口账单证据尚未读取" : healthLabel(issue);
}

// 金额正负对应的颜色类：负为 danger，非负为 success，没有金额不着色
export function amountTone(value: any, { positive = "success" }: { positive?: string } = {}) {
  if (value == null) return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number < 0 ? "danger" : positive;
}
