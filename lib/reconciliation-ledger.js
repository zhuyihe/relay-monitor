// 结账账本：每条核算关联、每个已结束的自然日记一行，只插入不更新；重新结账写 revision + 1，读取只认最新一版。
// 金额按系统原值记美元：revenue_usd 是本站收入，cost_usd 是上游按用量的扣费（取不到时为空）；
// cost_basis 记结账时的成本计法，fixed 表示固定采购、毛利不扣 cost_usd。汇率只在当时配置过时才记，
// 没记的读取时按当前配置。迁移的旧账没有记录当时的计法和汇率，三者都为空。
// 引用了 reconciliation-snapshot.js（node:crypto），只能在服务端使用。
import { createHash } from "node:crypto";
import { RECONCILIATION_SETTLE_DELAY_MS, isCurrentReconciliationBillingContract, isLiveReconciliationPreset, normalizeSuccessfulResult } from "./reconciliation-contract.js";
import { billDayOf } from "./business-time.js";
import { reconciliationConfirmedHistoryRecord } from "./reconciliation-snapshot.js";

// 结账等待时长定义在 reconciliation-contract.js（页面也要用，那边不引用 node:crypto）。
export { RECONCILIATION_SETTLE_DELAY_MS };

export const RECONCILIATION_LEDGER_COLUMNS = Object.freeze(["rule_id", "bill_date", "revision", "version_id", "timezone",
  "window_start_ms", "window_end_ms", "revenue_usd", "cost_usd", "revenue_rate", "cost_rate", "cost_basis", "source", "detail", "settled_at"]);

const finite = (value) => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

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
    entry.source, entry.detail == null ? null : JSON.stringify(entry.detail), ledgerDateTime(entry.settledAt)];
}

export function ledgerEntryFromRow(row) {
  const billDate = row.bill_date instanceof Date ? null : String(row.bill_date ?? "");
  return {
    ruleId: String(row.rule_id), billDate: /^\d{4}-\d{2}-\d{2}$/.test(billDate) ? billDate : null, revision: Number(row.revision),
    versionId: row.version_id ?? null, timezone: row.timezone, startMs: Number(row.window_start_ms), endMs: Number(row.window_end_ms),
    revenueUsd: finite(row.revenue_usd), costUsd: finite(row.cost_usd), revenueRate: finite(row.revenue_rate), costRate: finite(row.cost_rate),
    costBasis: row.cost_basis ?? null, source: row.source, detail: parseJson(row.detail), settledAt: isoFromDateTime(row.settled_at),
  };
}

// 一次结账要写的账本行：只认恰好一个已结束自然日、算出了毛利的结果。revision 由仓库在事务里按已有版本决定。
export function ledgerEntryForSettlement(ruleId, result, detail, { revenueRate = null, costRate = null, costBasis = "usage" } = {}) {
  const window = result?.window;
  const billDate = billDayOf(window);
  const revenueUsd = finite(result?.downstream?.amountUsd);
  if (!billDate || result?.calculation?.profitUsd == null || revenueUsd == null) return null;
  return { ruleId, billDate, revision: null, versionId: null, timezone: window.timezone, startMs: window.startMs, endMs: window.endMs,
    revenueUsd, costUsd: finite(result.upstream?.amountUsd), revenueRate, costRate, costBasis, source: "settle", detail,
    settledAt: result.generatedAt };
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
      || !Number.isFinite(generatedMs) || generatedMs < endMs + RECONCILIATION_SETTLE_DELAY_MS) continue;
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
  return { billDate: entry.billDate, revision: entry.revision, source: entry.source, settledAt: entry.settledAt,
    rates: { income: entry.revenueRate, cost: entry.costRate }, costBasis: entry.costBasis };
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
