// 对账持久化层的行为契约：同一组用例分别跑在 MySQL 版 ReconciliationRepository 与
// MemoryReconciliationRepository 上，两边不一致时以 MySQL 为准修正内存实现。
// 用例只调用公开方法；每个用例使用随机的站点、Key 与渠道编号，可以在已有数据的库里重复运行。
// 运行方提供：
//   create()                                        每个用例新建（或复用连接池）一个仓库实例
//   cleanup({ repository, ruleIds })                 删除本用例写入的全部规则及其渠道、分段、快照、告警
//   inspectSnapshot({ repository, ruleId, snapshotKey })  读取快照行的物理列（segment_id 等没有公开读取方法）
//   teardown()                                       全部用例结束后释放资源
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { RECONCILIATION_BILLING_SOURCE, RECONCILIATION_CALCULATION_VERSION } from "../../lib/reconciliation-contract.js";
import { reconciliationRuleEvidence, reconciliationScopeFingerprint, reconciliationSnapshotRecordIdentity } from "../../lib/reconciliation-snapshot.js";
import { reconciliationOwnerRuleState } from "../reconciliation-repository.js";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const EFFECTIVE_FROM = 1_700_000_000_000;
const UPSTREAM_IDENTITY = { provider: "newapi", baseUrl: "https://upstream.contract.invalid", accountId: "42" };

const randomInt = (min, span) => min + Math.floor(Math.random() * span);
const sortConflicts = (list) => [...list].sort((a, b) => a.channelId - b.channelId || a.ruleId.localeCompare(b.ruleId));
const alertColumns = (row) => row && Object.fromEntries(["rule_id", "event_code", "active", "first_seen_at", "last_seen_at", "last_notified_at", "recovered_at"]
  .map((column) => [column, row[column]]));

class Fixture {
  constructor(repository) {
    this.repository = repository;
    this.tag = randomBytes(4).toString("hex");
    this.ruleIds = new Set();
    this.tokenBase = randomInt(10_000_000, 900_000_000);
    this.channelBase = randomInt(10_000_000, 900_000_000);
  }

  station(name) {
    return `ct${this.tag}-${name}`;
  }

  token(offset = 0) {
    return this.tokenBase + offset;
  }

  channel(offset) {
    return this.channelBase + offset;
  }

  ownSource(namespace = "a") {
    return { stationId: this.station("own"), provider: "newapi", baseUrl: "https://own.contract.invalid", accountId: 7001, namespaceKey: `ns-${this.tag}-${namespace}` };
  }

  ruleInput(overrides = {}) {
    return {
      upstreamStationId: this.station("up"), ownStationId: this.station("own"), tokenId: this.token(),
      tokenName: `Contract ${this.tag}`, fixedGroup: "default", timezone: "UTC",
      channels: [{ channelId: this.channel(1), name: "Primary" }], initialEffectiveFromMs: EFFECTIVE_FROM,
      ...overrides,
    };
  }

  async createRule(overrides = {}) {
    const rule = await this.repository.createRule(this.ruleInput(overrides));
    this.ruleIds.add(rule.id);
    return rule;
  }

  // 失败用例里可能意外建出规则：清理前按本用例的站点前缀再收集一次。
  async collectRuleIds() {
    const rules = await this.repository.listRules({ includeArchived: true });
    for (const rule of rules) {
      if ([rule.upstreamStationId, rule.ownStationId].some((id) => id.toLowerCase().startsWith(`ct${this.tag}`))) this.ruleIds.add(rule.id);
    }
    return [...this.ruleIds];
  }

  async mine({ includeArchived = false } = {}) {
    const rules = await this.repository.listRules({ includeArchived });
    return rules.filter((rule) => this.ruleIds.has(rule.id));
  }

  async fingerprint(ruleId) {
    const rule = await this.repository.getRule(ruleId);
    return reconciliationScopeFingerprint(rule, await this.repository.listSegments(ruleId));
  }

  async ownerState() {
    return reconciliationOwnerRuleState(await this.repository.listRules());
  }
}

// 与 server/reconciliation.js 的 persistResult 写出的快照结构一致。
function billingSnapshot({ rule, segment, segmentId = segment.id, fingerprint, window, rowWindow = window, recordType = "confirmed",
  generatedAt, profitUsd = 1.25, healthCode = "READY", healthDetail = null, evidence = null, calculationVersion = RECONCILIATION_CALCULATION_VERSION }) {
  const confirmed = recordType === "confirmed";
  const upstream = { state: "complete", group: segment.group, ratio: segment.ratio, status: "enabled",
    quotaUnits: 500000, quotaPerUnit: 500000, amountUsd: 1, observedAt: window.endMs };
  const channels = rule.channels.map((channel) => ({ channelId: channel.channelId, name: channel.name, billingState: "complete", quotaUnits: 1125000, amountUsd: 2.25 }));
  const downstream = { state: "complete", quotaUnits: 1125000, quotaPerUnit: 500000, amountUsd: 2.25, coverage: 1, billingCoverage: 1, channels, observedAt: window.endMs };
  const calculation = { differenceUsd: profitUsd, profitUsd: confirmed ? profitUsd : null, riskDifferenceUsd: confirmed ? null : profitUsd, marginRate: 0.5 };
  const health = { code: healthCode, detail: healthDetail, issues: [] };
  return {
    ruleId: rule.id,
    segmentId,
    snapshotKey: reconciliationSnapshotRecordIdentity(window, fingerprint, recordType, segmentId),
    windowKind: window.preset,
    startMs: rowWindow.startMs,
    endMs: rowWindow.endMs,
    localDate: window.preset === "today" ? new Date(window.startMs).toISOString().slice(0, 10) : null,
    upstreamQuota: upstream.quotaUnits, upstreamQuotaPerUnit: upstream.quotaPerUnit, upstreamUsd: upstream.amountUsd,
    downstreamQuota: downstream.quotaUnits, downstreamQuotaPerUnit: downstream.quotaPerUnit, downstreamUsd: downstream.amountUsd,
    differenceUsd: calculation.differenceUsd, marginRate: calculation.marginRate, coverage: downstream.coverage,
    healthCode, healthDetail,
    source: {
      calculationVersion,
      billingSource: RECONCILIATION_BILLING_SOURCE,
      upstream: { group: upstream.group, ratio: upstream.ratio, status: upstream.status },
      downstream: { calculationVersion, billingSource: RECONCILIATION_BILLING_SOURCE, billingCoverage: 1, coverage: 1,
        channels: channels.map(({ channelId, quotaUnits, amountUsd }) => ({ channelId, quotaUnits, amountUsd })) },
      ruleEvidence: evidence || reconciliationRuleEvidence(rule, UPSTREAM_IDENTITY),
      scopePolicy: { billingPolicy: rule.billingPolicy, scopeVersion: rule.scopeVersion, billingEffectiveFrom: rule.billingEffectiveFrom,
        costCoverage: rule.costCoverage, sourceBinding: rule.sourceBinding, ownSource: rule.ownSource, coverageDeclaration: rule.coverageDeclaration,
        canonicalKey: rule.canonicalKey, sourceState: "verified" },
      recordType,
      scopeFingerprint: fingerprint,
      segment: { group: segment.group, ratio: segment.ratio, ratioObservedAt: segment.ratioObservedAt, ratioSource: segment.ratioSource, timingSource: segment.timingSource },
      origin: "contract",
      window,
      resultGeneratedAt: generatedAt,
      result: { window, requestedWindow: window, lastSuccessfulWindow: confirmed ? window : null, currentSegment: segment,
        upstream, downstream, calculation, health, generatedAt },
    },
  };
}

const CASES = [];
const contract = (title, run) => CASES.push([title, run]);

export function defineReconciliationRepositoryContract({ name, create, cleanup = async () => {}, inspectSnapshot = null, teardown = null }) {
  test(`reconciliation repository contract: ${name}`, { timeout: 120000 }, async (t) => {
    if (teardown) t.after(teardown);
    for (const [title, run] of CASES) {
      await t.test(title, async () => {
        const repository = await create();
        const fixture = new Fixture(repository);
        const inspect = inspectSnapshot && ((ruleId, snapshotKey) => inspectSnapshot({ repository, ruleId, snapshotKey }));
        try {
          await run({ repository, fixture, inspect });
        } finally {
          await cleanup({ repository, ruleIds: await fixture.collectRuleIds() });
        }
      });
    }
  });
}

// ---- 规则：创建、读取、列表 ----

contract("createRule stores the rule, name-ordered channels and one operator-confirmed segment", async ({ repository, fixture }) => {
  const before = Date.now();
  // 排序规则不区分大小写和重音：alpha 与 Alpha 并列时按渠道编号，Ångström 排在 alpha 与 beta 之间。
  const rule = await fixture.createRule({
    initialRatio: 1.5,
    channels: [
      { channelId: fixture.channel(2), name: "beta" },
      { channelId: fixture.channel(3), name: "Alpha" },
      { channelId: fixture.channel(1), name: "alpha" },
      { channelId: fixture.channel(4), name: "Ångström" },
    ],
  });
  const after = Date.now();
  assert.match(rule.id, /^rr_/);
  assert.deepEqual({ ...rule, id: null, createdAt: null, updatedAt: null }, {
    id: null, upstreamStationId: fixture.station("up"), ownStationId: fixture.station("own"), tokenId: fixture.token(),
    tokenName: `Contract ${fixture.tag}`, fixedGroup: "default", timezone: "UTC", enabled: true,
    billingPolicy: "legacy-v3", scopeVersion: 1, billingEffectiveFrom: null, costCoverage: "unknown", provider: null, canonicalKey: null,
    sourceBinding: null, ownSource: null, coverageDeclaration: { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] },
    archivedAt: null, createdAt: null, updatedAt: null,
    channels: [
      { channelId: fixture.channel(1), name: "alpha", state: null, stateObservedAt: null, stateChangedAt: null },
      { channelId: fixture.channel(3), name: "Alpha", state: null, stateObservedAt: null, stateChangedAt: null },
      { channelId: fixture.channel(4), name: "Ångström", state: null, stateObservedAt: null, stateChangedAt: null },
      { channelId: fixture.channel(2), name: "beta", state: null, stateObservedAt: null, stateChangedAt: null },
    ],
  });
  assert.equal(typeof rule.createdAt, "string");
  assert.equal(typeof rule.updatedAt, "string");
  assert.deepEqual(await repository.getRule(rule.id), rule);
  assert.equal(await repository.getRule(`rr_missing${fixture.tag}`), null);

  const segments = await repository.listSegments(rule.id);
  assert.equal(segments.length, 1);
  const [segment] = segments;
  assert.match(segment.id, /^rs_/);
  assert.deepEqual({ ...segment, id: null, ratioObservedAt: null, detectedAt: null }, {
    id: null, ruleId: rule.id, group: "default", ratio: 1.5, ratioObservedAt: null, ratioSource: "group_catalog",
    effectiveFrom: EFFECTIVE_FROM, effectiveTo: null, detectedAt: null, timingSource: "operator_confirmed",
  });
  assert.ok(segment.ratioObservedAt >= before && segment.ratioObservedAt <= after);
  assert.ok(segment.detectedAt >= before && segment.detectedAt <= after);
});

contract("createRule applies the next-complete-day policy and leaves a ratio-less segment unobserved", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ billingPolicy: "next-complete-day", initialEffectiveFromMs: undefined });
  assert.equal(rule.billingPolicy, "next-complete-day");
  assert.equal(rule.scopeVersion, 1);
  assert.equal(Number.isSafeInteger(rule.billingEffectiveFrom), true);
  assert.ok(rule.billingEffectiveFrom > Date.now() - DAY);
  const [segment] = await repository.listSegments(rule.id);
  assert.equal(segment.effectiveFrom, 0);
  assert.equal(segment.ratio, null);
  assert.equal(segment.ratioObservedAt, null);
  assert.equal(segment.ratioSource, null);
});

contract("listRules hides archived rules, lists enabled rules first, and disabled rules reserve no keys", async ({ repository, fixture }) => {
  const enabled = await fixture.createRule({ channels: [{ channelId: fixture.channel(2), name: "zeta" }, { channelId: fixture.channel(1), name: "Eta" }] });
  // 与 enabled 同一 Key、同一本站渠道：停用规则不占用唯一键，所以可以建出来。
  const disabled = await fixture.createRule({ enabled: false, channels: [{ channelId: fixture.channel(2), name: "zeta" }] });
  const archived = await fixture.createRule({ tokenId: fixture.token(1), channels: [{ channelId: fixture.channel(3), name: "archived" }] });
  assert.equal(disabled.enabled, false);
  assert.equal(await repository.archiveRule(archived.id), true);

  assert.deepEqual((await fixture.mine()).map((rule) => rule.id), [enabled.id, disabled.id]);
  const listed = (await fixture.mine()).find((rule) => rule.id === enabled.id);
  assert.deepEqual(listed.channels.map((channel) => channel.name), ["Eta", "zeta"]);
  assert.deepEqual(listed, await repository.getRule(enabled.id));

  const withArchived = await fixture.mine({ includeArchived: true });
  assert.equal(withArchived[0].id, enabled.id);
  assert.deepEqual(withArchived.slice(1).map((rule) => rule.id).sort(), [disabled.id, archived.id].sort());
  assert.equal(await repository.getRule(archived.id), null);
  const stored = await repository.getRule(archived.id, { includeArchived: true });
  assert.equal(stored.enabled, false);
  assert.equal(typeof stored.archivedAt, "string");
  assert.deepEqual(stored.channels.map((channel) => channel.channelId), [fixture.channel(3)]);
});

contract("createRule rejects duplicate active keys and invalid columns without leaving rows", async ({ repository, fixture }) => {
  await fixture.createRule({ tokenId: fixture.token(0), channels: [{ channelId: fixture.channel(1), name: "one" }] });
  const otherOwn = fixture.station("own2");
  await assert.rejects(fixture.createRule({ tokenId: fixture.token(0), ownStationId: otherOwn, channels: [{ channelId: fixture.channel(2), name: "two" }] }),
    { code: "ER_DUP_ENTRY", errno: 1062 });
  // 唯一键按 utf8mb4_0900_ai_ci 比较，只差大小写的站点编号视为同一个 Key。
  await assert.rejects(fixture.createRule({ upstreamStationId: fixture.station("up").toUpperCase(), tokenId: fixture.token(0), ownStationId: otherOwn,
    channels: [{ channelId: fixture.channel(2), name: "two" }] }), { code: "ER_DUP_ENTRY", errno: 1062 });
  await assert.rejects(fixture.createRule({ tokenId: fixture.token(1), channels: [{ channelId: fixture.channel(1), name: "one again" }] }),
    { code: "ER_DUP_ENTRY", errno: 1062 });
  await assert.rejects(fixture.createRule({ tokenId: fixture.token(2), tokenName: undefined }), { code: "ER_BAD_NULL_ERROR", errno: 1048 });
  await assert.rejects(fixture.createRule({ tokenId: fixture.token(3), fixedGroup: "g".repeat(161) }), { code: "ER_DATA_TOO_LONG", errno: 1406 });
  // 不同本站可以复用同一渠道编号。
  const sameChannelOtherOwn = await fixture.createRule({ tokenId: fixture.token(4), ownStationId: otherOwn, channels: [{ channelId: fixture.channel(1), name: "one" }] });
  assert.equal(sameChannelOtherOwn.ownStationId, otherOwn);

  const tokens = (await repository.listRules({ includeArchived: true }))
    .filter((rule) => rule.upstreamStationId.toLowerCase() === fixture.station("up")).map((rule) => rule.tokenId).sort();
  assert.deepEqual(tokens, [fixture.token(0), fixture.token(4)].sort());
});

// ---- 冲突查询 ----

contract("findChannelConflicts matches enabled rules by channel id and honours exclusion", async ({ repository, fixture }) => {
  const c1 = fixture.channel(1), c2 = fixture.channel(2);
  const main = await fixture.createRule({ tokenId: fixture.token(0), tokenName: "Main", fixedGroup: "vip",
    channels: [{ channelId: c1, name: "one" }, { channelId: c2, name: "two" }] });
  await fixture.createRule({ tokenId: fixture.token(1), enabled: false, channels: [{ channelId: c1, name: "one" }] });
  const elsewhere = await fixture.createRule({ tokenId: fixture.token(2), tokenName: "Elsewhere", ownStationId: fixture.station("own2"),
    channels: [{ channelId: c1, name: "one" }] });
  const archived = await fixture.createRule({ tokenId: fixture.token(3), ownStationId: fixture.station("own3"), channels: [{ channelId: c2, name: "two" }] });
  await repository.archiveRule(archived.id);

  assert.deepEqual(await repository.findChannelConflicts([]), []);
  assert.deepEqual(sortConflicts(await repository.findChannelConflicts([c1, c2])), sortConflicts([
    { ruleId: main.id, tokenName: "Main", fixedGroup: "vip", channelId: c1 },
    { ruleId: main.id, tokenName: "Main", fixedGroup: "vip", channelId: c2 },
    { ruleId: elsewhere.id, tokenName: "Elsewhere", fixedGroup: "default", channelId: c1 },
  ]));
  assert.deepEqual(await repository.findChannelConflicts([c1, c2], { excludeRuleId: main.id }),
    [{ ruleId: elsewhere.id, tokenName: "Elsewhere", fixedGroup: "default", channelId: c1 }]);
  assert.deepEqual(await repository.findChannelConflicts([fixture.channel(9)]), []);
  assert.equal(await repository.archiveRule(elsewhere.id), true);
  assert.deepEqual(await repository.findChannelConflicts([c1, c2], { excludeRuleId: main.id }), []);
});

contract("findTokenConflict ignores disabled, archived and excluded rules", async ({ repository, fixture }) => {
  const upstream = fixture.station("up");
  const active = await fixture.createRule({ tokenName: "Active", fixedGroup: "vip" });
  await fixture.createRule({ enabled: false, ownStationId: fixture.station("own2") });
  assert.deepEqual(await repository.findTokenConflict(upstream, fixture.token()), { ruleId: active.id, tokenName: "Active", fixedGroup: "vip" });
  // 站点编号按不区分大小写的排序规则比较。
  assert.deepEqual(await repository.findTokenConflict(upstream.toUpperCase(), fixture.token()), { ruleId: active.id, tokenName: "Active", fixedGroup: "vip" });
  assert.equal(await repository.findTokenConflict(upstream, fixture.token(), { excludeRuleId: active.id }), null);
  assert.equal(await repository.findTokenConflict(upstream, fixture.token(1)), null);
  assert.equal(await repository.archiveRule(active.id), true);
  assert.equal(await repository.findTokenConflict(upstream, fixture.token()), null);
});

// ---- 规则修改 ----

contract("updateRule re-inserts channels, drops their status columns and bumps the scope version", async ({ repository, fixture }) => {
  const c1 = fixture.channel(1), c2 = fixture.channel(2), c3 = fixture.channel(3);
  const rule = await fixture.createRule({ channels: [{ channelId: c1, name: "One" }, { channelId: c2, name: "Two" }] });
  await repository.updateChannelStates(rule.id, [{ channelId: c1, state: "enabled" }], EFFECTIVE_FROM + HOUR);
  assert.equal((await repository.getRule(rule.id)).channels[0].state, "enabled");

  const updated = await repository.updateRule(rule.id, { channels: [{ channelId: c1, name: "One" }, { channelId: c3, name: "Three" }] });
  assert.deepEqual(updated.channels, [
    { channelId: c1, name: "One", state: null, stateObservedAt: null, stateChangedAt: null },
    { channelId: c3, name: "Three", state: null, stateObservedAt: null, stateChangedAt: null },
  ]);
  assert.equal(updated.billingPolicy, "next-complete-day");
  assert.equal(updated.scopeVersion, 2);
  assert.equal(Number.isSafeInteger(updated.billingEffectiveFrom), true);
  assert.equal(updated.tokenName, rule.tokenName);

  // 只改名称不改范围：策略和版本保持不变。
  const renamed = await repository.updateRule(rule.id, { tokenName: "Renamed" });
  assert.equal(renamed.tokenName, "Renamed");
  assert.equal(renamed.scopeVersion, 2);
  assert.equal(renamed.billingEffectiveFrom, updated.billingEffectiveFrom);

  await assert.rejects(repository.updateRule(`rr_missing${fixture.tag}`, { tokenName: "x" }), /对账规则不存在或已归档/);
  const archived = await fixture.createRule({ tokenId: fixture.token(5), channels: [{ channelId: fixture.channel(5), name: "Five" }] });
  await repository.archiveRule(archived.id);
  await assert.rejects(repository.updateRule(archived.id, { tokenName: "x" }), /对账规则不存在或已归档/);
});

contract("updateRule rolls back the rule and the deleted channel set on a duplicate channel key", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(1), name: "One" }] });
  await fixture.createRule({ tokenId: fixture.token(1), channels: [{ channelId: fixture.channel(9), name: "Taken" }] });
  await assert.rejects(repository.updateRule(rule.id, { tokenName: "Changed", channels: [{ channelId: fixture.channel(1), name: "One" }, { channelId: fixture.channel(9), name: "Taken" }] }),
    { code: "ER_DUP_ENTRY", errno: 1062 });
  const after = await repository.getRule(rule.id);
  assert.equal(after.tokenName, rule.tokenName);
  assert.equal(after.scopeVersion, 1);
  assert.equal(after.billingPolicy, "legacy-v3");
  assert.deepEqual(after.channels, rule.channels);
});

contract("appendChannels keeps existing members, re-inserts them, and a failing guard rolls everything back", async ({ repository, fixture }) => {
  const c1 = fixture.channel(1), c2 = fixture.channel(2), c3 = fixture.channel(3);
  const rule = await fixture.createRule({ channels: [{ channelId: c1, name: "One" }] });
  await repository.updateChannelStates(rule.id, [{ channelId: c1, state: "enabled" }], EFFECTIVE_FROM + HOUR);
  const appended = await repository.appendChannels(rule.id, [{ channelId: c2, name: "Two" }]);
  assert.deepEqual(appended.channels, [
    { channelId: c1, name: "One", state: null, stateObservedAt: null, stateChangedAt: null },
    { channelId: c2, name: "Two", state: null, stateObservedAt: null, stateChangedAt: null },
  ]);
  assert.equal(appended.scopeVersion, 2);

  let calls = 0;
  const guard = () => {
    calls += 1;
    if (calls === 2) throw new Error("contract guard");
  };
  await assert.rejects(repository.appendChannels(rule.id, [{ channelId: c3, name: "Three" }], {}, { guard }), /contract guard/);
  assert.equal(calls, 2);
  const after = await repository.getRule(rule.id);
  assert.deepEqual(after.channels.map((channel) => channel.channelId), [c1, c2]);
  assert.equal(after.scopeVersion, 2);
});

// ---- 身份锚定 ----

contract("anchorRuleIdentity returns null for a missing rule, an archived rule or a stale fingerprint", async ({ repository, fixture }) => {
  const identity = { provider: "newapi", canonicalKey: `ck-${fixture.tag}`, ownSource: fixture.ownSource() };
  const rule = await fixture.createRule();
  const fingerprint = await fixture.fingerprint(rule.id);
  assert.equal(await repository.anchorRuleIdentity(`rr_missing${fixture.tag}`, identity, { expectedScopeFingerprint: fingerprint, allowInitialAnchoring: true }), null);
  assert.equal(await repository.anchorRuleIdentity(rule.id, identity, { expectedScopeFingerprint: "stale", allowInitialAnchoring: true }), null);
  assert.deepEqual(await repository.getRule(rule.id), rule);
  await repository.archiveRule(rule.id);
  assert.equal(await repository.anchorRuleIdentity(rule.id, identity, { expectedScopeFingerprint: fingerprint, allowInitialAnchoring: true }), null);
});

contract("anchorRuleIdentity anchors an unobserved legacy rule only with initial anchoring allowed", async ({ repository, fixture }) => {
  const identity = { provider: "newapi", canonicalKey: `ck-${fixture.tag}`, ownSource: fixture.ownSource() };
  const rule = await fixture.createRule();
  const fingerprint = await fixture.fingerprint(rule.id);
  await assert.rejects(repository.anchorRuleIdentity(rule.id, identity, { expectedScopeFingerprint: fingerprint }), { code: "LEGACY_IDENTITY_UNVERIFIED" });
  assert.deepEqual(await repository.getRule(rule.id), rule);

  const anchored = await repository.anchorRuleIdentity(rule.id, identity, { expectedScopeFingerprint: fingerprint, allowInitialAnchoring: true });
  assert.equal(anchored.provider, "newapi");
  assert.equal(anchored.canonicalKey, identity.canonicalKey);
  assert.deepEqual(anchored.ownSource, { ...identity.ownSource, accountId: String(identity.ownSource.accountId) });
  assert.deepEqual(anchored.sourceBinding, {});
  assert.deepEqual(anchored.channels, rule.channels);
  assert.equal(anchored.scopeVersion, rule.scopeVersion);
  assert.deepEqual(await repository.getRule(rule.id), anchored);
  // 锚定只补身份，不改变核算口径。
  assert.equal(await fixture.fingerprint(rule.id), fingerprint);

  // 已有身份时同样的身份直接通过，换了本站来源或原始 Key 需要明确确认。
  assert.deepEqual(await repository.anchorRuleIdentity(rule.id, identity, { expectedScopeFingerprint: fingerprint }), anchored);
  await assert.rejects(repository.anchorRuleIdentity(rule.id, { ...identity, ownSource: fixture.ownSource("b") }, { expectedScopeFingerprint: fingerprint }),
    { code: "SOURCE_BINDING_UNCONFIRMED" });
  await assert.rejects(repository.anchorRuleIdentity(rule.id, { ...identity, canonicalKey: `ck-${fixture.tag}-other` }, { expectedScopeFingerprint: fingerprint }),
    { code: "SOURCE_BINDING_UNCONFIRMED" });
  assert.deepEqual(await repository.getRule(rule.id), anchored);
});

contract("anchorRuleIdentity rejects a changed canonical key on a keyed rule", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ canonicalKey: `ck-${fixture.tag}-a` });
  const fingerprint = await fixture.fingerprint(rule.id);
  await assert.rejects(repository.anchorRuleIdentity(rule.id, { provider: "newapi", canonicalKey: `ck-${fixture.tag}-b`, ownSource: fixture.ownSource() },
    { expectedScopeFingerprint: fingerprint, allowInitialAnchoring: true }), { code: "SOURCE_BINDING_UNCONFIRMED" });
  assert.deepEqual(await repository.getRule(rule.id), rule);
});

contract("anchorRuleIdentity trusts saved original evidence and refuses observed or contradicted legacy rules", async ({ repository, fixture }) => {
  const identity = { provider: "newapi", canonicalKey: `ck-${fixture.tag}`, ownSource: fixture.ownSource() };
  const window = { preset: "custom", startMs: EFFECTIVE_FROM, endMs: EFFECTIVE_FROM + DAY, timezone: "UTC" };
  const saveEvidence = async (rule, evidence) => {
    const [segment] = await repository.listSegments(rule.id);
    await repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint: await fixture.fingerprint(rule.id), window,
      generatedAt: "2023-11-15T22:13:20.000Z", evidence: { ...reconciliationRuleEvidence(rule, UPSTREAM_IDENTITY), ...evidence } }));
  };

  // 状态已被观察过：即使允许初次锚定也拒绝。
  const observed = await fixture.createRule({ tokenId: fixture.token(1), channels: [{ channelId: fixture.channel(1), name: "one" }] });
  await repository.updateChannelStates(observed.id, [{ channelId: fixture.channel(1), state: "enabled" }], EFFECTIVE_FROM + HOUR);
  await assert.rejects(repository.anchorRuleIdentity(observed.id, identity, { expectedScopeFingerprint: await fixture.fingerprint(observed.id), allowInitialAnchoring: true }),
    { code: "LEGACY_IDENTITY_UNVERIFIED" });

  // 已有账单记录但原始身份对不上：拒绝。
  const contradicted = await fixture.createRule({ tokenId: fixture.token(2), channels: [{ channelId: fixture.channel(2), name: "two" }] });
  await saveEvidence(contradicted, { canonicalKey: `ck-${fixture.tag}-other`, ownSource: identity.ownSource });
  await assert.rejects(repository.anchorRuleIdentity(contradicted.id, identity, { expectedScopeFingerprint: await fixture.fingerprint(contradicted.id), allowInitialAnchoring: true }),
    { code: "LEGACY_IDENTITY_UNVERIFIED" });
  assert.equal((await repository.getRule(contradicted.id)).canonicalKey, null);

  // 账单记录里的原始身份一致：不需要初次锚定许可。
  const proven = await fixture.createRule({ tokenId: fixture.token(3), channels: [{ channelId: fixture.channel(3), name: "three" }] });
  await saveEvidence(proven, { canonicalKey: identity.canonicalKey, ownSource: { ...identity.ownSource, accountId: String(identity.ownSource.accountId) } });
  const anchored = await repository.anchorRuleIdentity(proven.id, identity, { expectedScopeFingerprint: await fixture.fingerprint(proven.id) });
  assert.equal(anchored.canonicalKey, identity.canonicalKey);
  assert.equal(anchored.ownSource.namespaceKey, identity.ownSource.namespaceKey);
});

// ---- 分段 ----

contract("backfillMissingSegmentRatios fills only ratio-less segments of known groups and returns the count", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  assert.equal(await repository.backfillMissingSegmentRatios(rule.id, { other: { ratio: 3 } }, EFFECTIVE_FROM + HOUR), 0);
  assert.equal(await repository.backfillMissingSegmentRatios(rule.id, { default: { ratio: null } }, EFFECTIVE_FROM + HOUR), 0);
  assert.equal(await repository.backfillMissingSegmentRatios(rule.id, { default: { ratio: 1.75 } }, EFFECTIVE_FROM + HOUR), 1);
  assert.equal(await repository.backfillMissingSegmentRatios(rule.id, { default: { ratio: 2 } }, EFFECTIVE_FROM + 2 * HOUR), 0);
  const [segment] = await repository.listSegments(rule.id);
  assert.equal(segment.ratio, 1.75);
  assert.equal(segment.ratioObservedAt, EFFECTIVE_FROM + HOUR);
  assert.equal(segment.ratioSource, "group_catalog");
  assert.equal(segment.timingSource, "operator_confirmed");
  assert.deepEqual(await repository.listSegments(`rr_missing${fixture.tag}`), []);
});

contract("observeSource backfills, splits on group or ratio change and records the observed token", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const t1 = EFFECTIVE_FROM + HOUR, t2 = EFFECTIVE_FROM + 2 * HOUR, t3 = EFFECTIVE_FROM + 3 * HOUR, t4 = EFFECTIVE_FROM + 4 * HOUR, t5 = EFFECTIVE_FROM + 5 * HOUR;
  const groups = { default: { ratio: 1.5 }, vip: { ratio: 2 } };

  const backfill = await repository.observeSource(rule.id, { groups, group: "default", ratio: 1.5, tokenName: "Ignored without transition", detectedAt: t1 });
  assert.equal(backfill.transitioned, false);
  assert.equal(backfill.ratioBackfilled, true);
  assert.equal(backfill.segments.length, 1);
  assert.deepEqual(backfill.currentSegment, backfill.segments[0]);
  assert.equal(backfill.currentSegment.ratio, 1.5);
  assert.equal(backfill.currentSegment.ratioObservedAt, t1);
  assert.equal(backfill.currentSegment.ratioSource, "group_catalog");
  assert.equal((await repository.getRule(rule.id)).tokenName, rule.tokenName);

  const groupChange = await repository.observeSource(rule.id, { groups, group: "vip", ratio: 2, tokenName: "VIP token", detectedAt: t2 });
  assert.equal(groupChange.transitioned, true);
  assert.equal(groupChange.ratioBackfilled, false);
  assert.deepEqual(groupChange.segments.map(({ group, ratio, effectiveFrom, effectiveTo, timingSource }) => ({ group, ratio, effectiveFrom, effectiveTo, timingSource })), [
    { group: "default", ratio: 1.5, effectiveFrom: EFFECTIVE_FROM, effectiveTo: t2, timingSource: "operator_confirmed" },
    { group: "vip", ratio: 2, effectiveFrom: t2, effectiveTo: null, timingSource: "detected" },
  ]);
  assert.deepEqual(groupChange.currentSegment, groupChange.segments[1]);
  assert.equal(groupChange.currentSegment.detectedAt, t2);
  assert.equal(groupChange.currentSegment.ratioObservedAt, t2);
  assert.equal(groupChange.currentSegment.ratioSource, "group_catalog");
  assert.equal(groupChange.currentSegment.ruleId, rule.id);
  let stored = await repository.getRule(rule.id);
  assert.equal(stored.tokenName, "VIP token");
  assert.equal(stored.fixedGroup, "vip");

  const ratioChange = await repository.observeSource(rule.id, { groups: { vip: { ratio: 3 } }, group: "vip", ratio: 3, tokenName: "VIP token 2", detectedAt: t3 });
  assert.equal(ratioChange.transitioned, true);
  assert.deepEqual(ratioChange.segments.map((segment) => [segment.group, segment.ratio, segment.effectiveFrom, segment.effectiveTo]), [
    ["default", 1.5, EFFECTIVE_FROM, t2], ["vip", 2, t2, t3], ["vip", 3, t3, null],
  ]);
  assert.equal((await repository.getRule(rule.id)).tokenName, "VIP token 2");

  const unchanged = await repository.observeSource(rule.id, { groups: { vip: { ratio: 3 } }, group: "vip", ratio: 3, tokenName: "Ignored", detectedAt: t4 });
  assert.equal(unchanged.transitioned, false);
  assert.equal(unchanged.ratioBackfilled, false);
  assert.equal(unchanged.segments.length, 3);
  assert.equal((await repository.getRule(rule.id)).tokenName, "VIP token 2");

  const unknownRatio = await repository.observeSource(rule.id, { groups: {}, group: "free", ratio: null, tokenName: "Free token", detectedAt: t5 });
  assert.equal(unknownRatio.transitioned, true);
  assert.deepEqual({ ...unknownRatio.currentSegment, id: null }, {
    id: null, ruleId: rule.id, group: "free", ratio: null, ratioObservedAt: null, ratioSource: null,
    effectiveFrom: t5, effectiveTo: null, detectedAt: t5, timingSource: "detected",
  });
  stored = await repository.getRule(rule.id);
  assert.equal(stored.fixedGroup, "free");
  assert.equal(stored.tokenName, "Free token");
  assert.deepEqual(await repository.listSegments(rule.id), unknownRatio.segments);

  await assert.rejects(repository.observeSource(`rr_missing${fixture.tag}`, { groups, group: "vip", ratio: 2, tokenName: "x", detectedAt: t5 }), /对账规则不存在或已停止/);
  await repository.archiveRule(rule.id);
  await assert.rejects(repository.observeSource(rule.id, { groups, group: "vip", ratio: 2, tokenName: "x", detectedAt: t5 }), /对账规则不存在或已停止/);
});

contract("reconcileCurrentSegment backfills and splits segments without touching the rule row", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const t1 = EFFECTIVE_FROM + HOUR, t2 = EFFECTIVE_FROM + 2 * HOUR, t3 = EFFECTIVE_FROM + 3 * HOUR, t4 = EFFECTIVE_FROM + 4 * HOUR;

  const backfill = await repository.reconcileCurrentSegment(rule.id, { group: "default", ratio: 1.25, detectedAt: t1 });
  assert.equal(backfill.transitioned, false);
  assert.equal(backfill.ratioBackfilled, true);
  assert.equal(backfill.currentSegment.ratio, 1.25);
  assert.equal(backfill.currentSegment.ratioObservedAt, t1);

  const same = await repository.reconcileCurrentSegment(rule.id, { group: "default", ratio: 1.25, detectedAt: t2 });
  assert.deepEqual([same.transitioned, same.ratioBackfilled, same.segments.length], [false, false, 1]);

  const split = await repository.reconcileCurrentSegment(rule.id, { group: "vip", ratio: null, detectedAt: t2 });
  assert.equal(split.transitioned, true);
  assert.deepEqual(split.segments.map((segment) => [segment.group, segment.ratio, segment.effectiveFrom, segment.effectiveTo, segment.timingSource]), [
    ["default", 1.25, EFFECTIVE_FROM, t2, "operator_confirmed"], ["vip", null, t2, null, "detected"],
  ]);
  const stored = await repository.getRule(rule.id);
  assert.equal(stored.fixedGroup, "default");
  assert.equal(stored.tokenName, rule.tokenName);

  // 换组时用调用方观察到的当前分段倍率补齐旧分段，再切到新分段。
  const backfillAndSplit = await repository.reconcileCurrentSegment(rule.id, { group: "pro", ratio: 4, currentSegmentRatio: 0.5, detectedAt: t3 });
  assert.equal(backfillAndSplit.transitioned, true);
  assert.equal(backfillAndSplit.ratioBackfilled, true);
  assert.deepEqual(backfillAndSplit.segments.map((segment) => [segment.group, segment.ratio, segment.ratioObservedAt, segment.effectiveTo]), [
    ["default", 1.25, t1, t2], ["vip", 0.5, t3, t3], ["pro", 4, t3, null],
  ]);

  const ratioChange = await repository.reconcileCurrentSegment(rule.id, { group: "pro", ratio: 5, detectedAt: t4 });
  assert.equal(ratioChange.transitioned, true);
  assert.equal(ratioChange.ratioBackfilled, false);
  assert.deepEqual(ratioChange.currentSegment && [ratioChange.currentSegment.group, ratioChange.currentSegment.ratio, ratioChange.currentSegment.effectiveFrom], ["pro", 5, t4]);
  assert.deepEqual((await repository.transitionSegment(rule.id, { group: "pro", ratio: 5, detectedAt: t4 + HOUR })), ratioChange.segments);

  await assert.rejects(repository.reconcileCurrentSegment(`rr_missing${fixture.tag}`, { group: "vip", ratio: 1, detectedAt: t4 }), /对账规则缺少当前分段/);
});

contract("correctTransition moves a transition between its neighbours only", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ initialRatio: 1 });
  const t1 = EFFECTIVE_FROM + 10 * HOUR, t2 = EFFECTIVE_FROM + 20 * HOUR;
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: "VIP", detectedAt: t1 });
  const { segments } = await repository.observeSource(rule.id, { groups: {}, group: "pro", ratio: 3, tokenName: "Pro", detectedAt: t2 });
  const [first, middle, last] = segments;

  await assert.rejects(repository.correctTransition(rule.id, first.id, EFFECTIVE_FROM + HOUR), /只能修正有前序分段的切换时间/);
  await assert.rejects(repository.correctTransition(rule.id, `rs_missing${fixture.tag}`, EFFECTIVE_FROM + HOUR), /只能修正有前序分段的切换时间/);
  await assert.rejects(repository.correctTransition(rule.id, middle.id, EFFECTIVE_FROM), /切换时间必须位于相邻分段之间/);
  await assert.rejects(repository.correctTransition(rule.id, middle.id, t2), /切换时间必须位于相邻分段之间/);
  await assert.rejects(repository.correctTransition(rule.id, middle.id, Number.NaN), /切换时间必须位于相邻分段之间/);
  assert.deepEqual(await repository.listSegments(rule.id), segments);

  const corrected = await repository.correctTransition(rule.id, middle.id, t1 - HOUR);
  assert.deepEqual(corrected.map((segment) => [segment.id, segment.effectiveFrom, segment.effectiveTo, segment.timingSource]), [
    [first.id, EFFECTIVE_FROM, t1 - HOUR, "operator_confirmed"],
    [middle.id, t1 - HOUR, t2, "operator_confirmed"],
    [last.id, t2, null, "detected"],
  ]);
  assert.equal(corrected[1].detectedAt, t1);

  // 最后一段没有后继，只要求晚于前一段的开始时间。
  const tail = await repository.correctTransition(rule.id, last.id, t2 + HOUR);
  assert.deepEqual(tail.slice(1).map((segment) => [segment.effectiveFrom, segment.effectiveTo, segment.timingSource]), [
    [t1 - HOUR, t2 + HOUR, "operator_confirmed"], [t2 + HOUR, null, "operator_confirmed"],
  ]);
});

// ---- 渠道状态与归档 ----

contract("updateChannelStates records status and observation time per channel", async ({ repository, fixture }) => {
  const c1 = fixture.channel(1), c2 = fixture.channel(2);
  const rule = await fixture.createRule({ channels: [{ channelId: c1, name: "A" }, { channelId: c2, name: "B" }] });
  const t1 = EFFECTIVE_FROM + HOUR, t2 = EFFECTIVE_FROM + 2 * HOUR;
  await repository.updateChannelStates(rule.id, [{ channelId: c1, state: "enabled" }, { channelId: c2, state: "disabled" }, { channelId: fixture.channel(9), state: "enabled" }], t1);
  assert.deepEqual((await repository.getRule(rule.id)).channels, [
    { channelId: c1, name: "A", state: "enabled", stateObservedAt: t1, stateChangedAt: null },
    { channelId: c2, name: "B", state: "disabled", stateObservedAt: t1, stateChangedAt: null },
  ]);
  await repository.updateChannelStates(rule.id, [{ channelId: c1, state: "disabled" }], t2);
  // 已知缺陷（计划后续修复）：SET 从左到右求值，CASE 读到的 channel_status 已是新值，
  // 所以 status_changed_at_ms 永远不会被写入，状态变化后仍是 null。这里断言的是现状。
  assert.deepEqual((await repository.getRule(rule.id)).channels, [
    { channelId: c1, name: "A", state: "disabled", stateObservedAt: t2, stateChangedAt: null },
    { channelId: c2, name: "B", state: "disabled", stateObservedAt: t1, stateChangedAt: null },
  ]);
  const listed = (await fixture.mine()).find((item) => item.id === rule.id);
  assert.deepEqual(listed.channels, (await repository.getRule(rule.id)).channels);

  await assert.rejects(repository.updateChannelStates(`rr_missing${fixture.tag}`, [{ channelId: c1, state: "enabled" }], t2), /对账规则不存在或已停止/);
  await repository.archiveRule(rule.id);
  await assert.rejects(repository.updateChannelStates(rule.id, [{ channelId: c1, state: "enabled" }], t2), /对账规则不存在或已停止/);
});

contract("archiveRule archives once and releases the token and channel keys", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  assert.equal(await repository.archiveRule(`rr_missing${fixture.tag}`), false);
  assert.equal(await repository.archiveRule(rule.id), true);
  assert.equal(await repository.archiveRule(rule.id), false);
  assert.equal(await repository.getRule(rule.id), null);
  const archived = await repository.getRule(rule.id, { includeArchived: true });
  assert.equal(archived.enabled, false);
  assert.equal(typeof archived.archivedAt, "string");
  assert.deepEqual(archived.channels, rule.channels);
  const reused = await fixture.createRule();
  assert.notEqual(reused.id, rule.id);
  assert.equal(reused.tokenId, rule.tokenId);
  assert.deepEqual(reused.channels.map((channel) => channel.channelId), rule.channels.map((channel) => channel.channelId));
  assert.deepEqual((await fixture.mine()).map((item) => item.id), [reused.id]);
});

// ---- 快照 ----

contract("saveSnapshot upserts values but keeps the first segment, window kind and window start", async ({ repository, fixture, inspect }) => {
  const rule = await fixture.createRule();
  const snapshotKey = `contract-legacy-${fixture.tag}`;
  // 旧格式记录没有逻辑窗口，历史接口直接回显行上的 window_kind / window_start_ms / window_end_ms。
  const legacySource = (profitUsd) => ({ recordType: "confirmed", billingSource: RECONCILIATION_BILLING_SOURCE,
    calculationVersion: RECONCILIATION_CALCULATION_VERSION, result: { calculation: { profitUsd } } });
  const history = () => repository.listConfirmedHistory(rule.id, { startMs: 0, endMs: 10_000 });

  assert.equal(await repository.saveSnapshot({ ruleId: rule.id, segmentId: "seg-first", snapshotKey, windowKind: "yesterday", startMs: 1000, endMs: 2000,
    localDate: null, upstreamUsd: 1, healthCode: "READY", healthDetail: null, source: legacySource(1) }), true);
  let { records } = await history();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].window, { preset: "yesterday", startMs: 1000, endMs: 2000, timezone: null });
  assert.equal(records[0].calculation.profitUsd, 1);

  assert.equal(await repository.saveSnapshot({ ruleId: rule.id, segmentId: "seg-second", snapshotKey, windowKind: "custom", startMs: 1500, endMs: 2500,
    localDate: "2026-01-01", upstreamUsd: 2, healthCode: "PARTIAL", healthDetail: "second write", source: legacySource(2) }), true);
  ({ records } = await history());
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].window, { preset: "yesterday", startMs: 1000, endMs: 2500, timezone: null });
  assert.equal(records[0].calculation.profitUsd, 2);
  if (inspect) {
    assert.deepEqual(await inspect(rule.id, snapshotKey), { segmentId: "seg-first", windowKind: "yesterday", windowStartMs: 1000, windowEndMs: 2500,
      upstreamUsd: 2, healthCode: "PARTIAL", healthDetail: "second write" });
  }

  // VARCHAR(300) 按字符计：300 个汉字可以保存，301 个字符报错且不改动已有行。
  const cjk = "账".repeat(300);
  await repository.saveSnapshot({ ruleId: rule.id, segmentId: "seg-third", snapshotKey, windowKind: "custom", startMs: 1500, endMs: 2500,
    upstreamUsd: 3, healthCode: "PARTIAL", healthDetail: cjk, source: legacySource(3) });
  await assert.rejects(repository.saveSnapshot({ ruleId: rule.id, snapshotKey, windowKind: "custom", startMs: 1500, endMs: 2600,
    upstreamUsd: 4, healthCode: "PARTIAL", healthDetail: "x".repeat(301), source: legacySource(4) }), { code: "ER_DATA_TOO_LONG", errno: 1406 });
  await assert.rejects(repository.saveSnapshot({ ruleId: rule.id, snapshotKey: `${snapshotKey}-long`, windowKind: "custom", startMs: 1500, endMs: 2600,
    healthCode: "PARTIAL", healthDetail: "x".repeat(301), source: legacySource(4) }), { code: "ER_DATA_TOO_LONG", errno: 1406 });
  await assert.rejects(repository.saveSnapshot({ ruleId: rule.id, snapshotKey: `${snapshotKey}-null`, windowKind: "custom", startMs: 1500, endMs: 2600,
    healthCode: null, source: legacySource(4) }), { code: "ER_BAD_NULL_ERROR", errno: 1048 });
  ({ records } = await history());
  assert.equal(records.length, 1);
  assert.equal(records[0].calculation.profitUsd, 3);
  assert.equal(records[0].window.endMs, 2500);
  if (inspect) {
    assert.deepEqual(await inspect(rule.id, snapshotKey), { segmentId: "seg-first", windowKind: "yesterday", windowStartMs: 1000, windowEndMs: 2500,
      upstreamUsd: 3, healthCode: "PARTIAL", healthDetail: cjk });
    assert.equal(await inspect(rule.id, `${snapshotKey}-long`), null);
    assert.equal(await inspect(rule.id, `${snapshotKey}-null`), null);
  }
});

contract("saveSnapshotsForScope writes nothing for a stale scope, a stale owner state or a failing guard", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const window = { preset: "today", startMs: Date.UTC(2026, 0, 10), endMs: Date.UTC(2026, 0, 10, 6), timezone: "UTC" };
  const snapshot = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: "2026-01-10T06:00:00.000Z", profitUsd: 2 });
  const latest = () => repository.latestSuccessfulResult(rule.id, { ...window, endMs: Date.UTC(2026, 0, 11) }, fingerprint);

  assert.equal(await repository.saveSnapshotsForScope(rule.id, "stale-fingerprint", [snapshot]), false);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { expectedOwnerState: reconciliationOwnerRuleState([]) }), false);
  assert.equal(await repository.saveSnapshotsForScope(`rr_missing${fixture.tag}`, fingerprint, [snapshot]), false);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { guard: () => false }), false);
  let calls = 0;
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { guard: () => ++calls === 1 }), false);
  assert.equal(calls, 2);
  assert.equal(await latest(), null);
  assert.deepEqual((await repository.listConfirmedHistory(rule.id, { startMs: window.startMs, endMs: window.startMs + DAY })).records, []);

  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { expectedOwnerState: await fixture.ownerState(), guard: () => true }), true);
  assert.equal((await latest()).result.calculation.profitUsd, 2);

  // 规则口径变化后旧口径的保存被拒绝。
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: "VIP", detectedAt: window.startMs + HOUR });
  const second = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: "2026-01-10T07:00:00.000Z", profitUsd: 9 });
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [second]), false);
  assert.equal((await latest()).result.calculation.profitUsd, 2);
  await repository.archiveRule(rule.id);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [second]), false);
});

contract("saveSnapshotsForScope skips records older than the saved one of the same type", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const day = Date.UTC(2026, 0, 10);
  const save = (endHours, generatedAt, profitUsd) => repository.saveSnapshotsForScope(rule.id, fingerprint, [billingSnapshot({ rule, segment, fingerprint,
    window: { preset: "today", startMs: day, endMs: day + endHours * HOUR, timezone: "UTC" }, generatedAt, profitUsd })]);
  const latest = async () => {
    const found = await repository.latestSuccessfulResult(rule.id, { preset: "today", startMs: day, endMs: day + DAY, timezone: "UTC" }, fingerprint);
    return [found.generatedAt, found.result.calculation.profitUsd, found.result.window.endMs];
  };

  assert.equal(await save(6, "2026-01-10T06:00:00.000Z", 6), true);
  assert.deepEqual(await latest(), ["2026-01-10T06:00:00.000Z", 6, day + 6 * HOUR]);
  // 窗口更早的记录即使生成时间更新也跳过；同一窗口按生成时间取新。
  assert.equal(await save(4, "2026-01-10T07:00:00.000Z", 4), true);
  assert.deepEqual(await latest(), ["2026-01-10T06:00:00.000Z", 6, day + 6 * HOUR]);
  assert.equal(await save(6, "2026-01-10T05:00:00.000Z", 5), true);
  assert.deepEqual(await latest(), ["2026-01-10T06:00:00.000Z", 6, day + 6 * HOUR]);
  assert.equal(await save(6, "2026-01-10T06:30:00.000Z", 7), true);
  assert.deepEqual(await latest(), ["2026-01-10T06:30:00.000Z", 7, day + 6 * HOUR]);
  assert.equal(await save(8, "2026-01-10T08:00:00.000Z", 8), true);
  assert.deepEqual(await latest(), ["2026-01-10T08:00:00.000Z", 8, day + 8 * HOUR]);
});

contract("latestSuccessfulResult and latestObservation pick the newest matching record of their type", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const day = Date.UTC(2026, 0, 12);
  const window = { preset: "today", startMs: day, endMs: day + 6 * HOUR, timezone: "UTC" };
  const query = (endMs, scope = fingerprint) => ({ preset: "today", startMs: day, endMs, timezone: "UTC", scope });
  const confirmed = (q) => repository.latestSuccessfulResult(rule.id, { preset: q.preset, startMs: q.startMs, endMs: q.endMs, timezone: q.timezone }, q.scope);
  const observed = (q) => repository.latestObservation(rule.id, { preset: q.preset, startMs: q.startMs, endMs: q.endMs, timezone: q.timezone }, q.scope);

  await assert.rejects(repository.latestSuccessfulResult(rule.id, window, ""), /成功账单查询必须指定核算口径/);
  await assert.rejects(repository.latestObservation(rule.id, window, null), /成功账单查询必须指定核算口径/);
  assert.equal(await confirmed(query(day + DAY)), null);

  await repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, window, generatedAt: "2026-01-12T06:00:00.000Z", profitUsd: 2 }));
  await repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, window, recordType: "observation", generatedAt: "2026-01-12T06:00:01.000Z", profitUsd: 3 }));

  const success = await confirmed(query(day + 8 * HOUR));
  assert.equal(success.generatedAt, "2026-01-12T06:00:00.000Z");
  assert.deepEqual(success.result.window, window);
  assert.deepEqual(success.result.requestedWindow, window);
  assert.deepEqual(success.result.lastSuccessfulWindow, window);
  assert.deepEqual(success.result.calculation, { differenceUsd: 2, profitUsd: 2, riskDifferenceUsd: null, marginRate: 0.5 });
  assert.equal(success.result.health.code, "READY");

  const observation = await observed(query(day + 8 * HOUR));
  assert.equal(observation.generatedAt, "2026-01-12T06:00:01.000Z");
  assert.equal(observation.result.lastSuccessfulWindow, null);
  assert.deepEqual(observation.result.calculation, { differenceUsd: 3, profitUsd: null, riskDifferenceUsd: 3, marginRate: 0.5 });

  // 行上的窗口结束晚于查询窗口、口径不同、时区不同都查不到。
  assert.equal(await confirmed(query(day + 5 * HOUR)), null);
  assert.equal(await confirmed(query(day + 8 * HOUR, "other-fingerprint")), null);
  assert.equal(await repository.latestSuccessfulResult(rule.id, { ...window, endMs: day + 8 * HOUR, timezone: "Asia/Shanghai" }, fingerprint), null);

  // 另一分段的更新记录胜出；利润未知的确认记录不算成功账单。
  const later = { ...window, endMs: day + 7 * HOUR };
  await repository.saveSnapshot(billingSnapshot({ rule, segment, segmentId: `seg-later-${fixture.tag}`, fingerprint, window: later, generatedAt: "2026-01-12T07:00:00.000Z", profitUsd: 5 }));
  await repository.saveSnapshot(billingSnapshot({ rule, segment, segmentId: `seg-null-${fixture.tag}`, fingerprint, window: later, generatedAt: "2026-01-12T09:00:00.000Z", profitUsd: null }));
  assert.equal((await confirmed(query(day + 8 * HOUR))).result.calculation.profitUsd, 5);
  assert.equal((await confirmed(query(day + 6.5 * HOUR))).result.calculation.profitUsd, 2);
  assert.equal((await observed(query(day + 8 * HOUR))).generatedAt, "2026-01-12T06:00:01.000Z");

  // 非 today/7d 窗口要求结束时间完全一致。
  const custom = { preset: "custom", startMs: day - DAY, endMs: day, timezone: "UTC" };
  await repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, window: custom, generatedAt: "2026-01-12T00:10:00.000Z", profitUsd: 11 }));
  assert.equal((await repository.latestSuccessfulResult(rule.id, custom, fingerprint)).result.calculation.profitUsd, 11);
  assert.equal(await repository.latestSuccessfulResult(rule.id, { ...custom, endMs: day + HOUR }, fingerprint), null);
});

// ---- 告警 ----

contract("alert state upserts per rule and event, and clearActiveAlerts recovers only active rows of one rule", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const other = await fixture.createRule({ tokenId: fixture.token(1), channels: [{ channelId: fixture.channel(2), name: "Other" }] });
  assert.equal(await repository.getAlertState(rule.id, "KEY_INVALID_OR_DENIED"), null);

  await repository.setAlertState(rule.id, "KEY_INVALID_OR_DENIED", { active: true, firstSeenAt: 100, lastSeenAt: 200, lastNotifiedAt: 150, recoveredAt: null });
  assert.deepEqual(alertColumns(await repository.getAlertState(rule.id, "KEY_INVALID_OR_DENIED")), {
    rule_id: rule.id, event_code: "KEY_INVALID_OR_DENIED", active: 1, first_seen_at: 100, last_seen_at: 200, last_notified_at: 150, recovered_at: null,
  });
  await repository.setAlertState(rule.id, "KEY_INVALID_OR_DENIED", { active: true, firstSeenAt: 100, lastSeenAt: 300, lastNotifiedAt: null, recoveredAt: null });
  await repository.setAlertState(rule.id, "UPSTREAM_DATA_UNAVAILABLE", { active: false, firstSeenAt: 50, lastSeenAt: 60, lastNotifiedAt: null, recoveredAt: 70 });
  await repository.setAlertState(other.id, "KEY_INVALID_OR_DENIED", { active: true, firstSeenAt: 10, lastSeenAt: 20, lastNotifiedAt: null, recoveredAt: null });
  assert.deepEqual(alertColumns(await repository.getAlertState(rule.id, "KEY_INVALID_OR_DENIED")), {
    rule_id: rule.id, event_code: "KEY_INVALID_OR_DENIED", active: 1, first_seen_at: 100, last_seen_at: 300, last_notified_at: null, recovered_at: null,
  });

  await repository.clearActiveAlerts(rule.id, 500);
  assert.deepEqual(alertColumns(await repository.getAlertState(rule.id, "KEY_INVALID_OR_DENIED")), {
    rule_id: rule.id, event_code: "KEY_INVALID_OR_DENIED", active: 0, first_seen_at: 100, last_seen_at: 500, last_notified_at: null, recovered_at: 500,
  });
  assert.deepEqual(alertColumns(await repository.getAlertState(rule.id, "UPSTREAM_DATA_UNAVAILABLE")), {
    rule_id: rule.id, event_code: "UPSTREAM_DATA_UNAVAILABLE", active: 0, first_seen_at: 50, last_seen_at: 60, last_notified_at: null, recovered_at: 70,
  });
  assert.deepEqual(alertColumns(await repository.getAlertState(other.id, "KEY_INVALID_OR_DENIED")), {
    rule_id: other.id, event_code: "KEY_INVALID_OR_DENIED", active: 1, first_seen_at: 10, last_seen_at: 20, last_notified_at: null, recovered_at: null,
  });
  // 已恢复的告警再次清理不会改写恢复时间。
  await repository.clearActiveAlerts(rule.id, 900);
  assert.equal((await repository.getAlertState(rule.id, "KEY_INVALID_OR_DENIED")).recovered_at, 500);
});

// ---- 确认账单历史 ----

contract("listConfirmedHistory keeps one record per logical bill within the requested range", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = `contract-history-${fixture.tag}`;
  const d1 = Date.UTC(2026, 0, 5), d2 = d1 + DAY, d3 = d2 + DAY;
  const dayWindow = (startMs) => ({ preset: "custom", startMs, endMs: startMs + DAY, timezone: "UTC" });
  const save = (options) => repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, ...options }));

  // 同一逻辑账单的两个分段行只保留物理窗口结束最晚的一行。
  await save({ window: dayWindow(d1), rowWindow: { startMs: d1, endMs: d1 + 12 * HOUR }, segmentId: "seg-a", generatedAt: "2026-01-06T00:05:00.000Z", profitUsd: 1 });
  await save({ window: dayWindow(d1), rowWindow: { startMs: d1 + 12 * HOUR, endMs: d2 }, segmentId: "seg-b", generatedAt: "2026-01-06T00:05:00.000Z", profitUsd: 2 });
  await save({ window: dayWindow(d2), generatedAt: "2026-01-07T00:05:00.000Z", profitUsd: 3 });
  await save({ window: dayWindow(d3), generatedAt: "2026-01-08T00:05:00.000Z", profitUsd: 4 });
  // 观察记录、利润未知、旧计算版本都不进入确认账单历史。
  await save({ window: dayWindow(d2), segmentId: "seg-observation", recordType: "observation", generatedAt: "2026-01-07T00:06:00.000Z", profitUsd: 30 });
  await save({ window: dayWindow(d2), segmentId: "seg-unknown", generatedAt: "2026-01-07T00:07:00.000Z", profitUsd: null });
  await save({ window: dayWindow(d2), segmentId: "seg-v2", generatedAt: "2026-01-07T00:08:00.000Z", profitUsd: 31, calculationVersion: 2 });

  const all = await repository.listConfirmedHistory(rule.id, { startMs: d1, endMs: d3 + DAY });
  assert.equal(all.nextCursor, null);
  assert.deepEqual(all.records.map((record) => [record.window.startMs, record.window.endMs, record.calculation.profitUsd]), [
    [d3, d3 + DAY, 4], [d2, d2 + DAY, 3], [d1, d1 + DAY, 2],
  ]);
  for (const record of all.records) {
    assert.equal(record.scopeFingerprint, fingerprint);
    assert.equal(record.window.preset, "custom");
    assert.equal(record.window.timezone, "UTC");
    assert.equal(record.upstreamSource.tokenId, rule.tokenId);
  }
  assert.equal(all.records[2].confirmedAt, "2026-01-06T00:05:00.000Z");
  assert.equal(new Set(all.records.map((record) => record.historyId)).size, 3);

  assert.deepEqual((await repository.listConfirmedHistory(rule.id, { startMs: d2, endMs: d3 + DAY })).records.map((record) => record.window.startMs), [d3, d2]);
  assert.deepEqual((await repository.listConfirmedHistory(rule.id, { startMs: d1, endMs: d3 + DAY - 1 })).records.map((record) => record.window.startMs), [d2, d1]);
  assert.deepEqual((await repository.listConfirmedHistory(rule.id, { startMs: d1 + 1, endMs: d2 + DAY })).records.map((record) => record.window.startMs), [d2]);
  assert.deepEqual((await repository.listConfirmedHistory(`rr_missing${fixture.tag}`, { startMs: d1, endMs: d3 + DAY })).records, []);
});

contract("listConfirmedHistory pages with an opaque cursor and rejects invalid options", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = `contract-pages-${fixture.tag}`;
  const d1 = Date.UTC(2026, 1, 1);
  for (let index = 0; index < 3; index += 1) {
    const startMs = d1 + index * DAY;
    await repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, window: { preset: "custom", startMs, endMs: startMs + DAY, timezone: "UTC" },
      generatedAt: new Date(startMs + DAY + HOUR).toISOString(), profitUsd: index + 1 }));
  }
  const range = { startMs: d1, endMs: d1 + 3 * DAY };
  const first = await repository.listConfirmedHistory(rule.id, { ...range, limit: 2 });
  assert.deepEqual(first.records.map((record) => record.calculation.profitUsd), [3, 2]);
  assert.equal(typeof first.nextCursor, "string");
  const second = await repository.listConfirmedHistory(rule.id, { ...range, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.records.map((record) => record.calculation.profitUsd), [1]);
  assert.equal(second.nextCursor, null);
  const ids = [...first.records, ...second.records].map((record) => record.historyId);
  assert.equal(new Set(ids).size, 3);
  assert.equal((await repository.listConfirmedHistory(rule.id, { ...range, limit: 3 })).nextCursor, null);

  const invalid = { code: "INVALID_REQUEST" };
  await assert.rejects(repository.listConfirmedHistory(rule.id, { startMs: d1, endMs: d1 }), invalid);
  await assert.rejects(repository.listConfirmedHistory(rule.id, { startMs: d1, endMs: d1 + 32 * DAY }), invalid);
  await assert.rejects(repository.listConfirmedHistory(rule.id, { ...range, limit: 0 }), invalid);
  await assert.rejects(repository.listConfirmedHistory(rule.id, { ...range, limit: "" }), invalid);
  await assert.rejects(repository.listConfirmedHistory(rule.id, { ...range, cursor: "not a cursor" }), invalid);
  await assert.rejects(repository.listConfirmedHistory(rule.id, { ...range, cursor: Buffer.from("[1,2]").toString("base64url") }), invalid);
});

// ---- 返回值隔离 ----

contract("returned values and saved inputs are independent copies", async ({ repository, fixture }) => {
  const input = fixture.ruleInput({ initialRatio: 1 });
  const rule = await repository.createRule(input);
  fixture.ruleIds.add(rule.id);
  input.channels[0].name = "mutated input";
  rule.channels[0].name = "mutated result";
  rule.tokenName = "mutated result";
  const stored = await repository.getRule(rule.id);
  assert.equal(stored.channels[0].name, "Primary");
  assert.equal(stored.tokenName, `Contract ${fixture.tag}`);
  (await fixture.mine())[0].channels.length = 0;
  assert.equal((await repository.getRule(rule.id)).channels.length, 1);

  const segments = await repository.listSegments(rule.id);
  segments[0].ratio = 99;
  assert.equal((await repository.listSegments(rule.id))[0].ratio, 1);

  await repository.setAlertState(rule.id, "READY", { active: true, firstSeenAt: 1, lastSeenAt: 2, lastNotifiedAt: null, recoveredAt: null });
  const alert = await repository.getAlertState(rule.id, "READY");
  alert.active = 0;
  alert.last_seen_at = 99;
  assert.equal((await repository.getAlertState(rule.id, "READY")).last_seen_at, 2);

  const fingerprint = await fixture.fingerprint(rule.id);
  const day = Date.UTC(2026, 2, 1);
  const window = { preset: "custom", startMs: day, endMs: day + DAY, timezone: "UTC" };
  // 传副本：billingSnapshot 会直接引用 window，下面改写保存输入时不能连带改掉查询窗口。
  const snapshot = billingSnapshot({ rule: stored, segment: segments[0], fingerprint, window: { ...window }, generatedAt: "2026-03-02T00:05:00.000Z", profitUsd: 4 });
  await repository.saveSnapshot(snapshot);
  snapshot.source.result.calculation.profitUsd = 40;
  snapshot.source.window.startMs = 0;

  const latest = await repository.latestSuccessfulResult(rule.id, window, fingerprint);
  assert.equal(latest.result.calculation.profitUsd, 4);
  latest.result.calculation.profitUsd = 41;
  latest.result.window.startMs = 1;
  const again = await repository.latestSuccessfulResult(rule.id, window, fingerprint);
  assert.equal(again.result.calculation.profitUsd, 4);
  assert.equal(again.result.window.startMs, day);

  const history = await repository.listConfirmedHistory(rule.id, { startMs: day, endMs: day + DAY });
  history.records[0].calculation.profitUsd = 42;
  history.records[0].window.startMs = 2;
  const historyAgain = await repository.listConfirmedHistory(rule.id, { startMs: day, endMs: day + DAY });
  assert.equal(historyAgain.records[0].calculation.profitUsd, 4);
  assert.equal(historyAgain.records[0].window.startMs, day);
});
