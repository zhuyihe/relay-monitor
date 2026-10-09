import test from "node:test";
import assert from "node:assert/strict";
import { applyScopePolicy, canonicalBillingKey, completedBillingDayWindow, nextBillingEffectiveFrom, scopePolicyIssues } from "./reconciliation-scope-policy.js";
import { reconciliationScopeFingerprint } from "./reconciliation-snapshot.js";

test("关联下午确认后，从下一完整日开始；DST 按日历而非固定 24 小时", () => {
  assert.equal(nextBillingEffectiveFrom("Asia/Shanghai", Date.parse("2026-10-09T07:00:00Z")), Date.parse("2026-10-09T16:00:00Z"));
  assert.equal(nextBillingEffectiveFrom("America/New_York", Date.parse("2026-03-08T06:00:00Z")), Date.parse("2026-03-09T04:00:00Z"));
  assert.equal(nextBillingEffectiveFrom("America/New_York", Date.parse("2026-11-01T05:00:00Z")), Date.parse("2026-11-02T05:00:00Z"));
});

test("能力探测的最近结束自然日使用真实 DST 边界", () => {
  const window = completedBillingDayWindow("America/New_York", Date.parse("2026-03-09T16:00:00Z"));
  assert.deepEqual(window, { startMs: Date.parse("2026-03-08T05:00:00Z"), endMs: Date.parse("2026-03-09T04:00:00Z"), timezone: "America/New_York" });
});

test("只有生效后已结束的同一时区完整自然日能确认，金额窗口不裁切", () => {
  const startMs = Date.parse("2026-10-09T16:00:00Z");
  const endMs = Date.parse("2026-10-10T16:00:00Z");
  const rule = { billingPolicy: "next-complete-day", billingEffectiveFrom: startMs, costCoverage: "complete", timezone: "Asia/Shanghai" };
  const window = { startMs, endMs, timezone: "Asia/Shanghai" };
  assert.deepEqual(scopePolicyIssues(rule, window, endMs + 1000), []);
  assert.ok(scopePolicyIssues(rule, { ...window, startMs: startMs - 86400000 }, endMs).some((issue) => issue.code === "BILLING_SCOPE_NOT_EFFECTIVE"));
  assert.ok(scopePolicyIssues(rule, { ...window, startMs: startMs + 3600000 }, endMs).some((issue) => issue.code === "BILLING_WINDOW_UNCONFIRMED"));
  assert.ok(scopePolicyIssues(rule, window, endMs - 1).some((issue) => issue.code === "BILLING_WINDOW_UNCONFIRMED"));
  assert.ok(scopePolicyIssues({ ...rule, costCoverage: "unknown" }, window, endMs).some((issue) => issue.code === "COST_COVERAGE_UNKNOWN"));
  assert.deepEqual(scopePolicyIssues({ ...rule, billingPolicy: "legacy-v3" }, { ...window, startMs: 1 }, endMs), []);
});

test("相同确认在次日重试不会推进版本或延期，真实追加会重置完整日范围", () => {
  const now = Date.parse("2026-10-09T07:00:00Z");
  const input = { timezone: "Asia/Shanghai", channels: [{ channelId: 1 }], enabled: true, costCoverage: "complete", sourceBinding: { 1: "r1" } };
  const first = applyScopePolicy(null, input, now);
  const retried = applyScopePolicy(first, input, now + 86400000);
  assert.equal(retried.billingEffectiveFrom, first.billingEffectiveFrom);
  assert.equal(retried.scopeVersion, 1);
  assert.equal(retried.scopeChanged, false);
  const appended = applyScopePolicy(first, { ...input, channels: [...input.channels, { channelId: 2 }], sourceBinding: { 1: "r1", 2: "r2" } }, now + 86400000);
  assert.equal(appended.scopeVersion, 2);
  assert.equal(appended.billingEffectiveFrom, Date.parse("2026-10-10T16:00:00Z"));
});

test("服务端确认跨午夜拒绝旧预览并返回新边界；幂等确认不受旧预览影响", () => {
  const before = Date.parse("2026-10-09T15:59:59Z");
  const input = { timezone: "Asia/Shanghai", channels: [{ channelId: 1 }], enabled: true };
  const previewEffectiveFromMs = nextBillingEffectiveFrom(input.timezone, before);
  assert.throws(() => applyScopePolicy(null, { ...input, previewEffectiveFromMs }, before + 2000), (error) => error.code === "EFFECTIVE_PREVIEW_CHANGED"
    && error.billingEffectiveFrom === Date.parse("2026-10-10T16:00:00Z"));
  const first = applyScopePolicy(null, input, before);
  assert.equal(applyScopePolicy(first, { ...input, previewEffectiveFromMs }, before + 2000).scopeVersion, 1);
});

test("实际 Key 身份不依赖资源 ID、登录模式或凭证；不同账号和面板保持独立", () => {
  const a = { id: "a", type: "sub2api", baseUrl: "https://PANEL.test/", accessToken: "jwt" };
  const b = { id: "b", type: "sub2api-password", baseUrl: "https://panel.test", email: "x", password: "pw" };
  const metadata = { platform: "sub2api", accountId: 42 };
  assert.equal(canonicalBillingKey(a, metadata, 7), canonicalBillingKey(b, metadata, 7));
  assert.notEqual(canonicalBillingKey(a, metadata, 7), canonicalBillingKey(a, { ...metadata, accountId: 43 }, 7));
  assert.notEqual(canonicalBillingKey(a, metadata, 7), canonicalBillingKey({ ...a, baseUrl: "https://another.test" }, metadata, 7));
});

test("范围版本、有效日期、覆盖和来源确认进入指纹；迁移默认保留 v3 指纹", () => {
  const rule = { upstreamStationId: "up", ownStationId: "own", tokenId: 7, tokenName: "k", timezone: "Asia/Shanghai", channels: [{ channelId: 1 }] };
  const old = reconciliationScopeFingerprint(rule, []);
  assert.equal(reconciliationScopeFingerprint({ ...rule, billingPolicy: "legacy-v3", scopeVersion: 1, costCoverage: "unknown", sourceBinding: null }, []), old);
  const current = { ...rule, billingPolicy: "next-complete-day", scopeVersion: 1, billingEffectiveFrom: 1000, costCoverage: "complete", sourceBinding: { 1: "a" } };
  for (const patch of [{ scopeVersion: 2 }, { billingEffectiveFrom: 2000 }, { costCoverage: "unknown" }, { sourceBinding: { 1: "b" } }]) {
    assert.notEqual(reconciliationScopeFingerprint({ ...current, ...patch }, []), reconciliationScopeFingerprint(current, []));
  }
});
