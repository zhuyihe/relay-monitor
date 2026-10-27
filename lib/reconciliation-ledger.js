// 结账账本：每条核算关联、每个已结束的自然日记一行，只插入不更新；重新结账写 revision + 1，读取只认最新一版。
// 重结出来的内容和最新一版相同时不写新版（ledgerWriteDecision）。
// 金额按系统原值记美元：revenue_usd 是本站收入，cost_usd 是上游按用量的扣费（取不到时为空）；
// cost_basis 记结账时的成本计法，fixed 表示固定采购、毛利不扣 cost_usd。汇率只在当时配置过时才记，
// 没记的读取时按当前配置。迁移的旧账没有记录当时的计法和汇率，三者都为空。
// 引用了 reconciliation-snapshot.js（node:crypto），只能在服务端使用。
import { createHash } from "node:crypto";
import { isCurrentReconciliationBillingContract, isLiveReconciliationPreset, normalizeSuccessfulResult, sameReconciliationWindow } from "./reconciliation-contract.js";
import { billDayOf } from "./business-time.js";
import { isSettledAt } from "./reconciliation-settlement.js";
import { reconciliationConfirmedHistoryRecord } from "./reconciliation-snapshot.js";

// 应付成本 V1-b 多三列（都可空，旧账是 null）：expected_cost_usd 结账时按桶和价目表算出的上游应收；gap_reason 算不出时的原因码；
// tokens 这天的 Token 合计（页面「这天用了 288 万 Token」）。「对不上」不存：读的时候拿 cost_usd − expected_cost_usd 按常量现算（门槛要跑一两周再调）
export const RECONCILIATION_LEDGER_COLUMNS = Object.freeze(["rule_id", "bill_date", "revision", "version_id", "timezone",
  "window_start_ms", "window_end_ms", "revenue_usd", "cost_usd", "revenue_rate", "cost_rate", "cost_basis", "source", "detail", "settled_at",
  "expected_cost_usd", "gap_reason", "tokens"]);

const finite = (value) => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// 金额、汇率列的小数位：表里是 DECIMAL(20,8)、DECIMAL(12,6)
export const LEDGER_DECIMAL_SCALE = Object.freeze({ revenue_usd: 8, cost_usd: 8, revenue_rate: 6, cost_rate: 6, expected_cost_usd: 8 });

// 一个数存进 DECIMAL 列以后的样子（定点字符串），空的还是 null。和 MySQL 一样按十进制写法四舍五入，
// 不按二进制近似值（toFixed 会把 1.005 舍成 1.00，MySQL 存成 1.01）
export function ledgerDecimal(value, scale) {
  const number = finite(value);
  return number == null ? null : new Intl.NumberFormat("en-US", { useGrouping: false, minimumFractionDigits: scale,
    maximumFractionDigits: scale, roundingMode: "halfExpand", signDisplay: "negative" }).format(number);
}

function parseJson(value) {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

// DATETIME(3) 按 UTC 存：mysql2 会按进程时区换算 Date 参数，所以写入前自己格式化成字符串。
export function ledgerDateTime(iso) {
  return new Date(iso).toISOString().slice(0, 23).replace("T", " ");
}

function isoFromDateTime(value) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? "");
  const ms = Date.parse(text.includes("T") ? text : `${text.slice(0, 23).replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function ledgerInsertValues(entry) {
  return [entry.ruleId, entry.billDate, entry.revision, entry.versionId ?? null, entry.timezone, entry.startMs, entry.endMs,
    entry.revenueUsd, entry.costUsd ?? null, entry.revenueRate ?? null, entry.costRate ?? null, entry.costBasis ?? null,
    entry.source, entry.detail == null ? null : JSON.stringify(entry.detail), ledgerDateTime(entry.settledAt),
    entry.expectedCostUsd ?? null, entry.gapReason ?? null, entry.tokens ?? null];
}

export function ledgerEntryFromRow(row) {
  const billDate = row.bill_date instanceof Date ? null : String(row.bill_date ?? "");
  return {
    ruleId: String(row.rule_id), billDate: /^\d{4}-\d{2}-\d{2}$/.test(billDate) ? billDate : null, revision: Number(row.revision),
    versionId: row.version_id ?? null, timezone: row.timezone, startMs: Number(row.window_start_ms), endMs: Number(row.window_end_ms),
    revenueUsd: finite(row.revenue_usd), costUsd: finite(row.cost_usd), revenueRate: finite(row.revenue_rate), costRate: finite(row.cost_rate),
    costBasis: row.cost_basis ?? null, source: row.source, detail: parseJson(row.detail), settledAt: isoFromDateTime(row.settled_at),
    expectedCostUsd: finite(row.expected_cost_usd), gapReason: row.gap_reason ?? null, tokens: finite(row.tokens),
  };
}

// 每日利润页按天要的几列（设计稿 #118 §9：范围里的应付成本、差额、对不上与否按天存成列，范围查询直接加，不读明细）：每条绑定每天最新一版
// cost_rate：M3 固定成本按历史日子摊，要那天记的汇率，不用现在的（审核 #126 M3）
export const LEDGER_DAY_FACT_COLUMNS = Object.freeze(["rule_id", "bill_date", "revision", "settled_at", "revenue_usd", "cost_usd", "cost_basis", "cost_rate", "expected_cost_usd", "gap_reason", "tokens"]);
export function ledgerDayFactFromRow(row) {
  const billDate = row.bill_date instanceof Date ? null : String(row.bill_date ?? "");
  return { ruleId: String(row.rule_id), billDate: /^\d{4}-\d{2}-\d{2}$/.test(billDate) ? billDate : null, revision: Number(row.revision), settledAt: isoFromDateTime(row.settled_at),
    revenueUsd: finite(row.revenue_usd), costUsd: finite(row.cost_usd), costBasis: row.cost_basis ?? null, costRate: finite(row.cost_rate),
    expectedCostUsd: finite(row.expected_cost_usd), gapReason: row.gap_reason ?? null, tokens: finite(row.tokens) };
}

// 一次结账要写的账本行：只认恰好一个已结束自然日、算出了毛利的结果。revision 由仓库在事务里按已有版本决定。
export function ledgerEntryForSettlement(ruleId, result, detail, { revenueRate = null, costRate = null, costBasis = "usage", expectedCostUsd = null, gapReason = null, tokens = null } = {}) {
  const window = result?.window;
  const billDate = billDayOf(window);
  const revenueUsd = finite(result?.downstream?.amountUsd);
  if (!billDate || result?.calculation?.profitUsd == null || revenueUsd == null) return null;
  return { ruleId, billDate, revision: null, versionId: null, timezone: window.timezone, startMs: window.startMs, endMs: window.endMs,
    revenueUsd, costUsd: finite(result.upstream?.amountUsd), revenueRate, costRate, costBasis, source: "settle", detail,
    settledAt: result.generatedAt, expectedCostUsd: finite(expectedCostUsd), gapReason: gapReason ?? null, tokens: finite(tokens) };
}

const LEDGER_CONTENT_FIELDS = Object.freeze([["revenueUsd", "revenue_usd"], ["costUsd", "cost_usd"], ["revenueRate", "revenue_rate"], ["costRate", "cost_rate"]]);

// 两版账内容是否相同：窗口（时区、起止）、成本计法，金额和汇率按存进表以后的小数位比，null 只和 null 相等。
// 不比 settledAt 和 detail：detail 里的生成时刻、分段、指纹每次重算都会变，金额没变就不算内容变了。
// 两版都是固定成本时也不比 cost_usd：它只是读到的 Key 用量，毛利不扣它（上游读不到时还是空的）；计法本身变了照样算变了
export function sameLedgerContent(a, b) {
  const bothFixed = a.costBasis === "fixed" && b.costBasis === "fixed";
  return sameReconciliationWindow(a, b) && (a.costBasis ?? null) === (b.costBasis ?? null)
    && LEDGER_CONTENT_FIELDS.every(([field, column]) => (bothFixed && field === "costUsd")
      || ledgerDecimal(a[field], LEDGER_DECIMAL_SCALE[column]) === ledgerDecimal(b[field], LEDGER_DECIMAL_SCALE[column]));
}

// 这次结账写不写账、写第几版，以及写完以后账本里这天最新那一版的固定时刻（settledAt：写了是这次的，没写是原来那一版的）。
// latest 是这条关联这天最新的一版（没有为 null），两个仓库在同一事务里读出来再问这里：
//   当天还没有账：写第 1 版，source = settle
//   窗口不同：写下一版，source = resettle
//   窗口相同、不是重结：不写（已固定的日子不再变）
//   窗口相同、是重结：内容和最新一版相同就不写，不同才写下一版
export function ledgerWriteDecision(latest, entry, { resettle = false } = {}) {
  if (!latest) return { write: true, revision: 1, source: "settle", settledAt: entry.settledAt };
  const next = { write: true, revision: Number(latest.revision) + 1, source: "resettle", settledAt: entry.settledAt };
  if (!sameReconciliationWindow(latest, entry)) return next;
  return resettle && !sameLedgerContent(latest, entry) ? next
    : { write: false, revision: Number(latest.revision), source: latest.source, settledAt: latest.settledAt };
}

// 第 4 阶段之前的结账写在 reconciliation_snapshots 的 confirmed 记录里。只搬恰好一个自然日、
// 结束满结账等待期后才生成的记录：今天、近 7 天、本月和多日窗口都不搬。同一天有多条（多分段、多次结账）取最新生成的一条。
export function migratedLedgerEntries(rows = []) {
  const latest = new Map();
  for (const row of rows) {
    const source = parseJson(row.source);
    const window = source?.window;
    if (!isCurrentReconciliationBillingContract(source) || source.recordType !== "confirmed" || !source.result || !window
      || isLiveReconciliationPreset(window.preset)) continue;
    const result = normalizeSuccessfulResult(source.result, row.health_code);
    const startMs = finite(window.startMs), endMs = finite(window.endMs);
    const billDate = billDayOf({ startMs, endMs, timezone: window.timezone });
    const generatedMs = Date.parse(source.resultGeneratedAt);
    const revenueUsd = finite(result?.downstream?.amountUsd);
    if (!billDate || result?.calculation?.profitUsd == null || revenueUsd == null
      || !isSettledAt({ startMs, endMs, timezone: window.timezone }, source.resultGeneratedAt)) continue;
    const key = `${row.rule_id}\u0000${billDate}`;
    if (latest.has(key) && latest.get(key).generatedMs >= generatedMs) continue;
    latest.set(key, { generatedMs, entry: {
      ruleId: String(row.rule_id), billDate, revision: 1, versionId: null, timezone: window.timezone, startMs, endMs,
      revenueUsd, costUsd: finite(result.upstream?.amountUsd), revenueRate: null, costRate: null, costBasis: null, source: "migrated",
      detail: { ...source, result }, settledAt: new Date(generatedMs).toISOString(),
    } });
  }
  return [...latest.values()].map((item) => item.entry)
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.billDate.localeCompare(b.billDate));
}

// 账本行 → 与旧版结账记录相同形状的结果，供已结账窗口直接返回。窗口以账本行为准。
export function ledgerSettlement(entry) {
  const saved = entry?.detail?.result;
  if (!saved || !entry.settledAt) return null;
  const result = normalizeSuccessfulResult(saved);
  if (result?.calculation?.profitUsd == null) return null;
  const window = { ...(entry.detail.window || saved.window || {}), startMs: entry.startMs, endMs: entry.endMs, timezone: entry.timezone };
  const ownSource = saved.ownSource || entry.detail.ruleEvidence?.ownSource || entry.detail.scopePolicy?.ownSource || null;
  return {
    generatedAt: entry.settledAt,
    result: { ...result, ownSource, window, requestedWindow: saved.requestedWindow || window, lastSuccessfulWindow: saved.lastSuccessfulWindow || window },
    ledger: ledgerReference(entry),
  };
}

export function ledgerReference(entry) {
  const consumeLogSetting = entry.detail?.settlement?.consumeLogSetting ?? null;
  return { billDate: entry.billDate, revision: entry.revision, source: entry.source, settledAt: entry.settledAt,
    rates: { income: entry.revenueRate, cost: entry.costRate }, costBasis: entry.costBasis,
    // 应付成本（V1-b）：旧账三样都是 null / undefined
    expectedCostUsd: entry.expectedCostUsd ?? null, gapReason: entry.gapReason ?? null, tokens: entry.tokens ?? null,
    // 固定这天时自营站点的设置读不到、照读到的收费记录固定了（R2）：计算明细要说一句，只在有的时候带
    ...(consumeLogSetting ? { consumeLogSetting } : {}) };
}

// 历史账单沿用旧版记录的字段，另加账本日期、版本、来源、结账时的汇率和成本计法。窗口以账本行为准。
export function ledgerHistoryRecord(entry) {
  const detail = entry.detail || {};
  const window = { ...(detail.window || {}), startMs: entry.startMs, endMs: entry.endMs, timezone: entry.timezone };
  const record = reconciliationConfirmedHistoryRecord({ rule_id: entry.ruleId, source: { ...detail, window }, window_kind: detail.window?.preset ?? null,
    window_start_ms: entry.startMs, window_end_ms: entry.endMs, generated_at: entry.settledAt, snapshot_key: null });
  return { ...record, historyId: createHash("sha256").update(JSON.stringify(["ledger", entry.ruleId, entry.billDate, entry.revision])).digest("hex").slice(0, 24),
    confirmedAt: entry.settledAt, billDate: entry.billDate, revision: entry.revision, settlementSource: entry.source,
    settledRates: { income: entry.revenueRate, cost: entry.costRate }, costBasis: entry.costBasis };
}

// 历史游标 (bill_date, rule_id)：账本行只插入不更新，游标不会因为重新取数而漂移。
export function encodeLedgerCursor(entry) {
  return Buffer.from(JSON.stringify([entry.billDate, entry.ruleId])).toString("base64url");
}

export function decodeLedgerCursor(cursor) {
  if (typeof cursor !== "string" || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const decoded = Buffer.from(cursor, "base64url");
  if (decoded.toString("base64url") !== cursor) return null;
  let after;
  try { after = JSON.parse(decoded.toString("utf8")); } catch { return null; }
  if (!Array.isArray(after) || after.length !== 2 || typeof after[0] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(after[0])
    || typeof after[1] !== "string" || !after[1].length || after[1].length > 32) return null;
  const dayMs = Date.parse(`${after[0]}T00:00:00Z`);
  return Number.isFinite(dayMs) && new Date(dayMs).toISOString().slice(0, 10) === after[0] ? after : null;
}
