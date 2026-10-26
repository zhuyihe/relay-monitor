import test from "node:test";
import assert from "node:assert/strict";
import { accountingFloorFor, applyScopePolicy, canonicalBillingKey, completedBillingDayWindow, nextBillingEffectiveFrom, scopePolicyIssues, normalizeRuleSourceBinding, serializeRuleSourceBinding, reconciliationBillingSchedule, isCompletedBillingWindow, isScopedBillingPolicy, reconciliationAccountingStart, scopeRecalculatedInWindow, startOfBillingDay } from "./reconciliation-scope-policy.js";
import { reconciliationScopeFingerprint } from "./reconciliation-snapshot.js";
import { COVERAGE_ANSWERS, coverageDeclarationOf } from "./reconciliation-contract.js";

test("关联下午确认后，从下一完整日开始；DST 按日历而非固定 24 小时", () => {
  assert.equal(nextBillingEffectiveFrom("Asia/Shanghai", Date.parse("2026-10-09T07:00:00Z")), Date.parse("2026-10-09T16:00:00Z"));
  assert.equal(nextBillingEffectiveFrom("America/New_York", Date.parse("2026-03-08T06:00:00Z")), Date.parse("2026-03-09T04:00:00Z"));
  assert.equal(nextBillingEffectiveFrom("America/New_York", Date.parse("2026-11-01T05:00:00Z")), Date.parse("2026-11-02T05:00:00Z"));
});

test("来源绑定V2公开保持数字渠道地图、来源和用途声明，旧null/map不伪造身份", () => {
  assert.deepEqual(normalizeRuleSourceBinding(null, "complete"), { sourceBinding: null, ownSource: null,
    coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] } });
  const legacy = normalizeRuleSourceBinding({ 2: "r2", 1: "r1", version: 1, credential: "ignored" }, "unknown");
  assert.deepEqual(legacy.sourceBinding, { 1: "r1", 2: "r2" });
  assert.equal(legacy.ownSource, null);
  assert.equal(serializeRuleSourceBinding({ sourceBinding: null }), null);
  const ownSource = { stationId: "own", provider: "newapi", baseUrl: "https://own.test", accountId: "1", namespaceKey: "source-a" };
  const rule = { sourceBinding: { 1: "r1" }, ownSource,
    coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [9, 9, 3] }, costCoverage: "unknown" };
  assert.deepEqual(normalizeRuleSourceBinding(JSON.stringify(serializeRuleSourceBinding(rule))), {
    sourceBinding: rule.sourceBinding, ownSource,
    coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [3, 9] },
  });
});

test("读存下来的「去回答」以 COVERAGE_ANSWERS 为准：表里五项原样读出，认不出的按 costCoverage 退回，结构不变", () => {
  const read = (coverageDeclaration, costCoverage = "unknown") =>
    normalizeRuleSourceBinding({ version: 2, channels: {}, ownSource: null, coverageDeclaration }, costCoverage).coverageDeclaration;
  for (const option of COVERAGE_ANSWERS) {
    const declaration = coverageDeclarationOf(option.value, [3]);
    assert.deepEqual(read(declaration), declaration);
  }
  assert.deepEqual(read({ answer: "none", otherUse: "external" }), { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] });
  assert.deepEqual(read({ answer: "other_use", otherUse: "elsewhere" }), { answer: "other_use", otherUse: null, uncoveredOwnChannelIds: [] });
  assert.deepEqual(read({ answer: "yes" }, "complete"), { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] });
  assert.deepEqual(read({ answer: "yes" }), { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] });
});

test("来源namespace与完整Key用途变化推进范围一次；同源授权轮换不改变财务范围", () => {
  const now = Date.parse("2026-10-09T07:00:00Z");
  const input = { timezone: "Asia/Shanghai", channels: [{ channelId: 1 }], enabled: true, costCoverage: "complete", sourceBinding: { 1: "r1" },
    ownSource: { stationId: "own", provider: "newapi", baseUrl: "https://own.test", accountId: "1", namespaceKey: "a" },
    coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] } };
  const first = applyScopePolicy(null, input, now);
  const rotated = applyScopePolicy(first, { ...input, authVersion: 2 }, now + 86400000);
  assert.equal(rotated.scopeVersion, first.scopeVersion);
  assert.equal(rotated.billingEffectiveFrom, first.billingEffectiveFrom);
  const switched = applyScopePolicy(first, { ...input, ownSource: { ...input.ownSource, accountId: "2", namespaceKey: "b" } }, now);
  assert.equal(switched.scopeVersion, 2);
  assert.notEqual(reconciliationScopeFingerprint(first, []), reconciliationScopeFingerprint(switched, []));
  const external = applyScopePolicy(first, { ...input, costCoverage: "unknown",
    coverageDeclaration: { answer: "other_use", otherUse: "external", uncoveredOwnChannelIds: [] } }, now);
  assert.equal(external.scopeVersion, 2);
});

test("能力探测的最近结束自然日使用真实 DST 边界", () => {
  const window = completedBillingDayWindow("America/New_York", Date.parse("2026-03-09T16:00:00Z"));
  assert.deepEqual(window, { startMs: Date.parse("2026-03-08T05:00:00Z"), endMs: Date.parse("2026-03-09T04:00:00Z"), timezone: "America/New_York" });
});

test("U05 firstQueryable按下一日历零点，23h/25h完整日与未结束日严格区分", () => {
  for (const [start, end, duration] of [["2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 23], ["2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", 25]]) {
    const startMs = Date.parse(start), endMs = Date.parse(end), timezone = "America/New_York";
    const schedule = reconciliationBillingSchedule({ scopeVersion: 4, billingEffectiveFrom: startMs, timezone });
    assert.deepEqual(schedule, { scopeVersion: 4, billingEffectiveFromMs: startMs, accountingStartMs: startMs, firstFullDayStartMs: startMs, firstQueryableAtMs: endMs });
    assert.equal((endMs - startMs) / 3600000, duration);
    assert.equal(isCompletedBillingWindow({ startMs, endMs, timezone }, endMs), true);
    assert.equal(isCompletedBillingWindow({ startMs, endMs, timezone }, endMs - 1), false);
    assert.equal(isCompletedBillingWindow({ startMs: startMs + 1, endMs, timezone }, endMs), false);
  }
});

test("范围策略只提示用途待确认；未结束和不完整窗口照常给实时结果，生效前时段由窗口裁切处理", () => {
  const startMs = Date.parse("2026-10-09T16:00:00Z");
  const endMs = Date.parse("2026-10-10T16:00:00Z");
  const window = { startMs, endMs, timezone: "Asia/Shanghai" };
  for (const billingPolicy of ["next-complete-day", "immediate"]) {
    const rule = { billingPolicy, billingEffectiveFrom: startMs, costCoverage: "complete", timezone: "Asia/Shanghai" };
    assert.deepEqual(scopePolicyIssues(rule, window, endMs + 1000), []);
    assert.deepEqual(scopePolicyIssues(rule, { ...window, startMs: startMs - 86400000 }, endMs), []);
    assert.deepEqual(scopePolicyIssues(rule, { ...window, startMs: startMs + 3600000 }, endMs), []);
    assert.deepEqual(scopePolicyIssues(rule, window, endMs - 1), []);
    assert.deepEqual(scopePolicyIssues({ ...rule, costCoverage: "unknown" }, window, endMs).map((issue) => issue.code), ["COST_COVERAGE_UNKNOWN"]);
  }
  assert.deepEqual(scopePolicyIssues({ billingPolicy: "legacy-v3", costCoverage: "unknown" }, { ...window, startMs: 1 }, endMs), []);
  assert.equal(isCompletedBillingWindow(window, endMs), true);
  assert.equal(isCompletedBillingWindow(window, endMs - 1), false);
  assert.equal(isCompletedBillingWindow({ ...window, startMs: startMs + 3600000 }, endMs), false);
});

test("确认即生效：核算从创建时刻开始，首日之后的零点首次结账；修改不推迟核算起点", () => {
  assert.equal(isScopedBillingPolicy("immediate"), true);
  assert.equal(isScopedBillingPolicy("next-complete-day"), true);
  assert.equal(isScopedBillingPolicy("legacy-v3"), false);
  const createdMs = Date.parse("2026-10-10T06:30:00Z"), midnight = Date.parse("2026-10-10T16:00:00Z");
  const created = { billingPolicy: "immediate", scopeVersion: 1, billingEffectiveFrom: createdMs, createdAt: new Date(createdMs).toISOString(), timezone: "Asia/Shanghai" };
  assert.equal(startOfBillingDay(createdMs, "Asia/Shanghai"), Date.parse("2026-10-09T16:00:00Z"));
  const dayStart = Date.parse("2026-10-09T16:00:00Z"); // 建绑定那天（上海）的 0 点：从这天 0 点整天算，不从建好那一刻起
  assert.deepEqual(reconciliationBillingSchedule(created), { scopeVersion: 1, billingEffectiveFromMs: createdMs, accountingStartMs: dayStart,
    firstFullDayStartMs: dayStart, firstQueryableAtMs: midnight });
  const editedMs = Date.parse("2026-10-12T03:00:00Z");
  const edited = { ...created, scopeVersion: 2, billingEffectiveFrom: editedMs };
  assert.equal(reconciliationAccountingStart(edited), dayStart);
  assert.equal(reconciliationBillingSchedule(edited).firstQueryableAtMs, midnight);
  // 旧版次日生效规则：边界在创建之后，核算起点取创建那天的 0 点。
  assert.equal(reconciliationAccountingStart({ billingPolicy: "next-complete-day", billingEffectiveFrom: midnight, createdAt: created.createdAt, timezone: "Asia/Shanghai" }), dayStart);
  assert.equal(reconciliationAccountingStart({ billingPolicy: "legacy-v3", billingEffectiveFrom: midnight }), null);
  const today = { startMs: Date.parse("2026-10-11T16:00:00Z"), endMs: Date.parse("2026-10-12T05:00:00Z"), timezone: "Asia/Shanghai" };
  assert.equal(scopeRecalculatedInWindow(edited, today), true);
  assert.equal(scopeRecalculatedInWindow(edited, { ...today, startMs: editedMs }), false);
  assert.equal(scopeRecalculatedInWindow(created, today), false);
  assert.equal(scopeRecalculatedInWindow(edited, { startMs: dayStart - 86400000, endMs: dayStart, timezone: "Asia/Shanghai" }), false, "整天在起点之前：不算");
  assert.equal(scopeRecalculatedInWindow(edited, { startMs: dayStart - 86400000, endMs: createdMs, timezone: "Asia/Shanghai" }), true, "含建绑定那天早上：那段也按现在的设置算");
});

test("相同确认在次日重试不会推进版本或改生效时间，真实追加从确认时刻起按新范围生效", () => {
  const now = Date.parse("2026-10-09T07:00:00Z");
  const input = { timezone: "Asia/Shanghai", channels: [{ channelId: 1 }], enabled: true, costCoverage: "complete", sourceBinding: { 1: "r1" } };
  const first = applyScopePolicy(null, input, now);
  const retried = applyScopePolicy(first, input, now + 86400000);
  assert.equal(retried.billingEffectiveFrom, first.billingEffectiveFrom);
  assert.equal(retried.scopeVersion, 1);
  assert.equal(retried.scopeChanged, false);
  const appended = applyScopePolicy(first, { ...input, channels: [...input.channels, { channelId: 2 }], sourceBinding: { 1: "r1", 2: "r2" } }, now + 86400000);
  assert.equal(appended.scopeVersion, 2);
  assert.equal(appended.billingPolicy, "immediate");
  assert.equal(appended.billingEffectiveFrom, now + 86400000);
});

test("真实canonical Key与Key ID变更推进版本并即时生效；启停和同账号授权不改生效时间", () => {
  const now = Date.parse("2026-10-09T07:00:00Z");
  const input = { timezone: "Asia/Shanghai", channels: [{ channelId: 1 }], tokenId: 9, canonicalKey: "account-a-key-9", costCoverage: "complete" };
  const first = applyScopePolicy(null, input, now);
  for (const change of [{ canonicalKey: "account-b-key-9" }, { tokenId: 10, canonicalKey: "account-a-key-10" }]) {
    const changed = applyScopePolicy(first, change, now + 86400000);
    assert.equal(changed.scopeVersion, 2);
    assert.equal(changed.billingEffectiveFrom, now + 86400000);
    assert.equal(applyScopePolicy(changed, change, now + 2 * 86400000).billingEffectiveFrom, changed.billingEffectiveFrom);
  }
  const disabled = applyScopePolicy(first, { enabled: false, authVersion: 2 }, now + 86400000);
  assert.equal(disabled.scopeVersion, 1);
  assert.equal(disabled.billingEffectiveFrom, first.billingEffectiveFrom);
  assert.equal(applyScopePolicy(disabled, { enabled: true }, now + 2 * 86400000).billingEffectiveFrom, first.billingEffectiveFrom);
  assert.equal(applyScopePolicy(first, { costCoverage: "unknown" }, now).costCoverage, "unknown");
});

test("确认跨午夜照常保存并从确认时刻生效；旧客户端带来的预览生效时间不再拒绝", () => {
  const before = Date.parse("2026-10-09T15:59:59Z");
  const input = { timezone: "Asia/Shanghai", channels: [{ channelId: 1 }], enabled: true };
  const previewEffectiveFromMs = nextBillingEffectiveFrom(input.timezone, before);
  const crossed = applyScopePolicy(null, { ...input, previewEffectiveFromMs }, before + 2000);
  assert.equal(crossed.billingPolicy, "immediate");
  assert.equal(crossed.billingEffectiveFrom, before + 2000);
  assert.equal(crossed.scopeVersion, 1);
  const first = applyScopePolicy(null, input, before);
  const retried = applyScopePolicy(first, { ...input, previewEffectiveFromMs }, before + 2000);
  assert.equal(retried.scopeVersion, 1);
  assert.equal(retried.billingEffectiveFrom, before);
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


test("accountingFloorFor：同一天里更早解除的占着同一个渠道（或同一把 Key）的 New API 绑定，新绑定从那一刻起算；别的情况没有下限", () => {
  const tz = "Asia/Shanghai", effectiveFrom = Date.parse("2026-10-08T07:00:00Z"); // 15:00
  const at = (hhmm) => Date.parse(`2026-10-08T${hhmm}:00Z`);
  const old = (extra = {}) => ({ archivedAtMs: at("06:30"), provider: "newapi", ownStationId: "own", canonicalKey: "k1", channels: [{ channelId: 1 }], ...extra });
  const mine = { timezone: tz, effectiveFrom, ownStationId: "own", canonicalKey: "k2", channels: [{ channelId: 1 }, { channelId: 2 }] };
  assert.equal(accountingFloorFor(mine, [old()]), at("06:30"), "同一个渠道");
  assert.equal(accountingFloorFor({ ...mine, channels: [{ channelId: 9 }], canonicalKey: "k1" }, [old()]), at("06:30"), "同一把 Key");
  assert.equal(accountingFloorFor({ ...mine, channels: [{ channelId: 9 }] }, [old()]), null, "别的渠道、别的 Key");
  assert.equal(accountingFloorFor(mine, [old({ provider: "sub2api" })]), null, "旧的是 Sub2API：解除当天整天不算");
  assert.equal(accountingFloorFor(mine, [old({ archivedAtMs: Date.parse("2026-10-07T06:30:00Z") })]), null, "隔天才绑上");
  assert.equal(accountingFloorFor(mine, [old({ ownStationId: "other" })]), null, "别的自营站点");
  assert.equal(accountingFloorFor(mine, [old({ archivedAtMs: at("05:00") }), old({ archivedAtMs: at("06:00") })]), at("06:00"), "有几条取最晚的");
  assert.equal(accountingFloorFor(mine, [old({ archivedAtMs: at("08:00") })]), null, "解除在新绑定建好以后的不算");
  assert.equal(accountingFloorFor(mine, []), null);
});

test("accountingFloorFor：新绑定是 Sub2API 时没有下限（只能按整天读，从 0 点整天算；旧的 New API 绑定这天由「同一渠道被占着」挡住）", () => {
  const effectiveFrom = Date.parse("2026-10-08T07:00:00Z");
  const old = { archivedAtMs: Date.parse("2026-10-08T06:30:00Z"), provider: "newapi", ownStationId: "own", canonicalKey: "k1", channels: [{ channelId: 1 }] };
  const mine = { timezone: "Asia/Shanghai", effectiveFrom, ownStationId: "own", canonicalKey: "k2", channels: [{ channelId: 1 }] };
  assert.equal(accountingFloorFor({ ...mine, provider: "newapi" }, [old]), old.archivedAtMs);
  assert.equal(accountingFloorFor({ ...mine, provider: "sub2api" }, [old]), null);
});
