import test from "node:test";
import assert from "node:assert/strict";
import { RECONCILIATION_LEDGER_COLUMNS, decodeLedgerCursor, encodeLedgerCursor, ledgerDateTime, ledgerDecimal,
  ledgerEntryForSettlement, ledgerEntryFromRow, ledgerHistoryRecord, ledgerInsertValues, ledgerSettlement, ledgerWriteDecision, migratedLedgerEntries,
  sameLedgerContent } from "./reconciliation-ledger.js";
import { RECONCILIATION_SETTLE_DELAY_MS } from "./reconciliation-contract.js";

const DAY = 86400000;
const START = Date.UTC(2026, 9, 8, 16); // 上海 2026-10-09 00:00
const WINDOW = { preset: "yesterday", timezone: "Asia/Shanghai", startMs: START, endMs: START + DAY };

function confirmedSource({ window = WINDOW, generatedAt = new Date(WINDOW.endMs + RECONCILIATION_SETTLE_DELAY_MS).toISOString(), profitUsd = 3,
  downstreamUsd = 10, upstreamUsd = 7, recordType = "confirmed", calculation = null } = {}) {
  return {
    calculationVersion: 3, billingSource: "channel-log-stat", recordType, scopeFingerprint: "scope-a", window, resultGeneratedAt: generatedAt,
    ruleEvidence: { tokenId: 5, tokenName: "key", channels: [{ channelId: 9, name: "ch" }], scopeVersion: 1 },
    result: { window, requestedWindow: window, lastSuccessfulWindow: window, generatedAt,
      upstream: { state: "complete", amountUsd: upstreamUsd, knownAmountUsd: upstreamUsd, countedAmountUsd: upstreamUsd },
      downstream: { state: "complete", amountUsd: downstreamUsd, knownAmountUsd: downstreamUsd, channels: [] },
      calculation: calculation || { differenceUsd: profitUsd, profitUsd, riskDifferenceUsd: null, marginRate: profitUsd / downstreamUsd },
      health: { code: "READY", issues: [] } },
  };
}

test("迁移只搬恰好一个自然日、结束满结账等待期后生成的确认记录，同一天取最新一条", () => {
  const late = new Date(WINDOW.endMs + 2 * 3600000).toISOString();
  const rows = [
    { rule_id: "r1", source: JSON.stringify(confirmedSource({ profitUsd: 1 })) },
    { rule_id: "r1", source: confirmedSource({ profitUsd: 2, generatedAt: late }) },
    { rule_id: "r1", source: confirmedSource({ profitUsd: 9, generatedAt: new Date(WINDOW.endMs + 60000).toISOString() }) },
    { rule_id: "r1", source: confirmedSource({ window: { ...WINDOW, preset: "today" } }) },
    { rule_id: "r1", source: confirmedSource({ window: { ...WINDOW, endMs: WINDOW.endMs + DAY, preset: "custom" } }) },
    { rule_id: "r1", source: confirmedSource({ window: { ...WINDOW, timezone: "UTC" } }) },
    { rule_id: "r1", source: confirmedSource({ recordType: "observation" }) },
    { rule_id: "r1", source: { ...confirmedSource(), calculationVersion: 2 } },
    { rule_id: "r1", source: confirmedSource({ profitUsd: null }) },
    { rule_id: "r1", source: "{not json" },
    { rule_id: "r2", source: confirmedSource({ window: { ...WINDOW, startMs: START - DAY, endMs: START } }) },
    // 这一天只有一条，生成在结束后不满等待期（差 1 毫秒）：不搬
    { rule_id: "r3", source: confirmedSource({ generatedAt: new Date(WINDOW.endMs + RECONCILIATION_SETTLE_DELAY_MS - 1).toISOString() }) },
    // 没有生成时刻的也不搬
    { rule_id: "r4", source: confirmedSource({ generatedAt: null }) },
  ];
  const entries = migratedLedgerEntries(rows);
  assert.deepEqual(entries.map((entry) => [entry.ruleId, entry.billDate, entry.detail.result.calculation.profitUsd]),
    [["r1", "2026-10-09", 2], ["r2", "2026-10-08", 3]]);
  assert.deepEqual({ ...entries[0], detail: undefined }, { ruleId: "r1", billDate: "2026-10-09", revision: 1, versionId: null,
    timezone: "Asia/Shanghai", startMs: START, endMs: START + DAY, revenueUsd: 10, costUsd: 7, revenueRate: null, costRate: null,
    costBasis: null, source: "migrated", detail: undefined, settledAt: late });
});

test("迁移按旧口径补出只存了差额的毛利：健康 READY 才算毛利", () => {
  const legacy = (code) => { const source = confirmedSource({ calculation: { differenceUsd: 4, marginRate: 0.4 } }); source.result.health = { code }; return source; };
  const [entry] = migratedLedgerEntries([{ rule_id: "r1", source: legacy("READY") }]);
  assert.equal(entry.detail.result.calculation.profitUsd, 4);
  assert.deepEqual(migratedLedgerEntries([{ rule_id: "r1", source: legacy("STALE") }]), []);
});

test("结账行只认单个自然日且算出了毛利的结果；成本取不到时为空", () => {
  const result = confirmedSource().result;
  const entry = ledgerEntryForSettlement("r1", result, { detail: true }, { revenueRate: 7.1, costRate: null, costBasis: "fixed" });
  assert.deepEqual(entry, { ruleId: "r1", billDate: "2026-10-09", revision: null, versionId: null, timezone: "Asia/Shanghai",
    startMs: START, endMs: START + DAY, revenueUsd: 10, costUsd: 7, revenueRate: 7.1, costRate: null, costBasis: "fixed",
    source: "settle", detail: { detail: true }, settledAt: result.generatedAt });
  assert.equal(ledgerEntryForSettlement("r1", { ...result, upstream: { amountUsd: null } }, {}).costUsd, null);
  assert.equal(ledgerEntryForSettlement("r1", { ...result, window: { ...WINDOW, endMs: WINDOW.endMs + DAY } }, {}), null);
  assert.equal(ledgerEntryForSettlement("r1", { ...result, calculation: { profitUsd: null } }, {}), null);
});

test("账本行写入与读出往返：日期按 UTC 字符串写、DECIMAL 字符串转数字", () => {
  const entry = { ...migratedLedgerEntries([{ rule_id: "r1", source: confirmedSource() }])[0], revenueRate: 7.2, costBasis: "usage" };
  const values = ledgerInsertValues(entry);
  assert.equal(values.length, RECONCILIATION_LEDGER_COLUMNS.length);
  const row = Object.fromEntries(RECONCILIATION_LEDGER_COLUMNS.map((column, index) => [column, values[index]]));
  assert.equal(row.settled_at, ledgerDateTime(entry.settledAt));
  assert.match(row.settled_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  const read = ledgerEntryFromRow({ ...row, revenue_usd: "10.00000000", cost_usd: "7.00000000", revenue_rate: "7.200000",
    settled_at: `${row.settled_at}000` });
  assert.deepEqual(read, entry);
});

test("账本行转成结账结果与历史记录：窗口以账本为准，附带版本、汇率和计法", () => {
  const entry = { ...migratedLedgerEntries([{ rule_id: "r1", source: confirmedSource() }])[0], revision: 2, source: "resettle", costRate: 7.3 };
  const settlement = ledgerSettlement(entry);
  assert.equal(settlement.generatedAt, entry.settledAt);
  assert.deepEqual(settlement.result.window, WINDOW);
  assert.equal(settlement.result.calculation.profitUsd, 3);
  assert.deepEqual(settlement.ledger, { billDate: "2026-10-09", revision: 2, source: "resettle", settledAt: entry.settledAt,
    rates: { income: null, cost: 7.3 }, costBasis: null });
  assert.equal(ledgerSettlement({ ...entry, detail: null }), null);
  const record = ledgerHistoryRecord(entry);
  assert.equal(record.billDate, "2026-10-09");
  assert.equal(record.revision, 2);
  assert.equal(record.settlementSource, "resettle");
  assert.equal(record.confirmedAt, entry.settledAt);
  assert.deepEqual(record.settledRates, { income: null, cost: 7.3 });
  assert.equal(record.costBasis, null);
  assert.deepEqual(record.window, WINDOW);
  assert.equal(record.calculation.profitUsd, 3);
  assert.notEqual(record.historyId, ledgerHistoryRecord({ ...entry, revision: 1 }).historyId);
  assert.equal(record.historyId, ledgerHistoryRecord({ ...entry }).historyId);
});

test("历史游标只认 (合法日期, 规则 ID)", () => {
  const cursor = encodeLedgerCursor({ billDate: "2026-10-09", ruleId: "rr_1" });
  assert.deepEqual(decodeLedgerCursor(cursor), ["2026-10-09", "rr_1"]);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const bad of [encode(["2026-02-31", "r"]), encode(["2026-10-09"]), encode(["2026-10-09", ""]), encode(["2026-10-09", "x".repeat(33)]),
    encode([1, "r"]), encode([1000, "2026-10-08 16:01:01", "k"]), "not a cursor", `${cursor}=`, 5, null]) {
    assert.equal(decodeLedgerCursor(bad), null, String(bad));
  }
});

test("固定账来源沿用原始证据：结果缺来源时回读保存证据，完全缺失时保持未知", () => {
  const ownSource = { stationId: "own-old", provider: "newapi", baseUrl: "https://old-own.test", accountId: "11", namespaceKey: "original" };
  const entry = migratedLedgerEntries([{ rule_id: "r1", source: confirmedSource() }])[0];
  entry.detail.ruleEvidence.ownSource = ownSource;
  assert.deepEqual(ledgerSettlement(entry).result.ownSource, ownSource);
  delete entry.detail.ruleEvidence.ownSource;
  entry.detail.scopePolicy = { ownSource };
  assert.deepEqual(ledgerSettlement(entry).result.ownSource, ownSource);
  delete entry.detail.scopePolicy;
  assert.equal(ledgerSettlement(entry).result.ownSource, null);
});

test("存进 DECIMAL 以后的样子：和 MySQL 一样按十进制写法四舍五入，空的还是空", () => {
  assert.equal(ledgerDecimal(1.005, 2), "1.01"); // toFixed 是 1.00
  assert.equal(ledgerDecimal(0.123456785, 8), "0.12345679");
  assert.equal(ledgerDecimal(-1.0000000050000001, 8), "-1.00000001");
  assert.equal(ledgerDecimal(-0, 8), "0.00000000");
  assert.equal(ledgerDecimal(-1e-9, 8), "0.00000000");
  assert.equal(ledgerDecimal("7.2", 6), "7.200000");
  assert.equal(ledgerDecimal(123456789012.12346, 8), "123456789012.12346000");
  for (const empty of [null, undefined, "", "abc"]) assert.equal(ledgerDecimal(empty, 8), null);
});

test("账本写不写：没有账写第 1 版；窗口不同写下一版；窗口相同只有重结、内容又不同才写；固定时刻写了是这次的，没写是原来那一版的", () => {
  const entry = { timezone: "Asia/Shanghai", startMs: START, endMs: START + DAY, revenueUsd: 2.25, costUsd: 1, revenueRate: null, costRate: 7.2, costBasis: "usage", settledAt: "2026-10-09T18:00:00.000Z" };
  const NEW = entry.settledAt, OLD = "2026-10-09T17:00:00.000Z";
  const latest = { ...entry, revision: 3, source: "resettle", costUsd: 1.000000004, detail: { other: true }, settledAt: "2026-10-09T17:00:00.000Z" };
  assert.deepEqual(ledgerWriteDecision(null, entry, { resettle: true }), { write: true, revision: 1, source: "settle", settledAt: NEW });
  assert.deepEqual(ledgerWriteDecision(null, entry), { write: true, revision: 1, source: "settle", settledAt: NEW });
  assert.deepEqual(ledgerWriteDecision(latest, entry), { write: false, revision: 3, source: "resettle", settledAt: OLD });
  assert.deepEqual(ledgerWriteDecision(latest, entry, { resettle: true }), { write: false, revision: 3, source: "resettle", settledAt: OLD });
  for (const changed of [{ revenueUsd: 2.26 }, { costUsd: null }, { revenueRate: 7.2 }, { costRate: 7.21 }, { costBasis: "fixed" }]) {
    assert.equal(sameLedgerContent(latest, { ...entry, ...changed }), false, JSON.stringify(changed));
    assert.deepEqual(ledgerWriteDecision(latest, { ...entry, ...changed }), { write: false, revision: 3, source: "resettle", settledAt: OLD });
    assert.deepEqual(ledgerWriteDecision(latest, { ...entry, ...changed }, { resettle: true }), { write: true, revision: 4, source: "resettle", settledAt: NEW });
  }
  // 窗口不同（时区名不同也算）：不管是不是重结都写下一版
  for (const moved of [{ timezone: "PRC" }, { startMs: START - 1 }, { endMs: START + DAY + 1 }]) {
    assert.deepEqual(ledgerWriteDecision(latest, { ...entry, ...moved }), { write: true, revision: 4, source: "resettle", settledAt: NEW });
  }
});

test("两版都是固定成本时不比 cost_usd（只是读到的 Key 用量，毛利不扣它）；计法从按用量变成固定，照样算变了", () => {
  const fixed = { timezone: "Asia/Shanghai", startMs: START, endMs: START + DAY, revenueUsd: 2.5, costUsd: 1, revenueRate: 7.2, costRate: null, costBasis: "fixed", settledAt: "2026-10-09T18:00:00.000Z" };
  const latest = { ...fixed, costUsd: null, revision: 1, source: "settle", settledAt: "2026-10-09T17:00:00.000Z" };
  assert.equal(sameLedgerContent(latest, fixed), true);
  assert.deepEqual(ledgerWriteDecision(latest, fixed, { resettle: true }), { write: false, revision: 1, source: "settle", settledAt: latest.settledAt });
  assert.equal(sameLedgerContent(latest, { ...fixed, revenueUsd: 2.6 }), false, "收入变了照样写");
  const usage = { ...latest, costBasis: "usage", costUsd: 1 };
  assert.equal(sameLedgerContent(usage, fixed), false);
  assert.deepEqual(ledgerWriteDecision(usage, fixed, { resettle: true }), { write: true, revision: 2, source: "resettle", settledAt: fixed.settledAt });
  assert.equal(sameLedgerContent({ ...usage, costUsd: 2 }, { ...usage, costUsd: 1 }), false, "按用量的照旧比 cost_usd");
});
