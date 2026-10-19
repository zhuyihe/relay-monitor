// 对账持久化层的行为契约：同一组用例分别跑在 MySQL 版 ReconciliationRepository 与
// MemoryReconciliationRepository 上，两边不一致时以 MySQL 为准修正内存实现。
// 用例只调用公开方法；每个用例使用随机的站点、Key 与渠道编号，可以在已有数据的库里重复运行。
// 运行方提供：
//   create()                                        每个用例新建（或复用连接池）一个仓库实例
//   cleanup({ repository, ruleIds, capabilityIdentities })  删除本用例写入的全部规则及其渠道、分段、快照、告警、账本，以及账单能力记录
//   inspectSnapshot({ repository, ruleId, snapshotKey })  读取快照行的物理列（segment_id 等没有公开读取方法）
//   teardown()                                       全部用例结束后释放资源
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { RECONCILIATION_BILLING_SOURCE, RECONCILIATION_CALCULATION_VERSION } from "../../lib/reconciliation-contract.js";
import { ledgerEntryForSettlement } from "../../lib/reconciliation-ledger.js";
import { reconciliationRuleEvidence, reconciliationScopeFingerprint, reconciliationSnapshotRecordIdentity } from "../../lib/reconciliation-snapshot.js";
import { reconciliationOwnerRuleState } from "../reconciliation-repository.js";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const EFFECTIVE_FROM = 1_700_000_000_000;
const UPSTREAM_IDENTITY = { provider: "newapi", baseUrl: "https://upstream.contract.invalid", accountId: "42" };

// 两个仓库抛同一个码和同一句话（server/reconciliation-repository.js 的 repositoryError）
const notFound = { code: "RULE_NOT_FOUND", message: "这条绑定已解除" };
const noPrevious = { code: "RESOURCE_CHANGED", message: "这一段前面没有倍率变化，不能改时间" };
const outOfRange = { code: "TRANSITION_TIME_OUT_OF_RANGE", message: "改的时间要在前后两次倍率变化之间" };
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
    this.capabilityIdentities = new Set();
  }

  // 账单能力按 64 位十六进制身份保存；以本用例的 tag 开头，清理时按集合删除。
  capabilityIdentity(name) {
    const identity = `${this.tag}${Buffer.from(String(name)).toString("hex")}`.padEnd(64, "0").slice(0, 64);
    this.capabilityIdentities.add(identity);
    return identity;
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

// 与 persistResult 结账时传给 saveSnapshotsForScope 的 ledger 选项一致：明细取整窗口的快照来源。
function settlement(snapshot, { resettle = false, ...rates } = {}) {
  return { entry: ledgerEntryForSettlement(snapshot.ruleId, snapshot.source.result, snapshot.source, rates), resettle };
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
          await cleanup({ repository, ruleIds: await fixture.collectRuleIds(), capabilityIdentities: [...fixture.capabilityIdentities] });
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

contract("createRule applies the immediate policy and leaves a ratio-less segment unobserved", async ({ repository, fixture }) => {
  const before = Date.now();
  const rule = await fixture.createRule({ billingPolicy: "immediate", initialEffectiveFromMs: undefined });
  assert.equal(rule.billingPolicy, "immediate");
  assert.equal(rule.scopeVersion, 1);
  // 确认即生效：生效时刻就是创建时刻。
  assert.ok(rule.billingEffectiveFrom >= before && rule.billingEffectiveFrom <= Date.now());
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

contract("updateRule keeps surviving channel rows with their status, replaces the rest and bumps the scope version", async ({ repository, fixture }) => {
  const c1 = fixture.channel(1), c2 = fixture.channel(2), c3 = fixture.channel(3);
  const rule = await fixture.createRule({ channels: [{ channelId: c1, name: "One" }, { channelId: c2, name: "Two" }] });
  await repository.updateChannelStates(rule.id, [{ channelId: c1, state: "enabled" }, { channelId: c2, state: "disabled" }], EFFECTIVE_FROM + HOUR);
  assert.equal((await repository.getRule(rule.id)).channels[0].state, "enabled");

  const before = Date.now();
  const updated = await repository.updateRule(rule.id, { channels: [{ channelId: c1, name: "One renamed" }, { channelId: c3, name: "Three" }] });
  assert.deepEqual(updated.channels, [
    { channelId: c1, name: "One renamed", state: "enabled", stateObservedAt: EFFECTIVE_FROM + HOUR, stateChangedAt: EFFECTIVE_FROM + HOUR },
    { channelId: c3, name: "Three", state: null, stateObservedAt: null, stateChangedAt: null },
  ]);
  assert.equal(updated.billingPolicy, "immediate");
  assert.equal(updated.scopeVersion, 2);
  assert.ok(updated.billingEffectiveFrom >= before && updated.billingEffectiveFrom <= Date.now());
  // 移除的渠道连同状态一起删掉，重新加回来时从空状态开始。
  const readded = await repository.updateRule(rule.id, { channels: [{ channelId: c1, name: "One renamed" }, { channelId: c2, name: "Two" }, { channelId: c3, name: "Three" }] });
  assert.deepEqual(readded.channels.find((channel) => channel.channelId === c2), { channelId: c2, name: "Two", state: null, stateObservedAt: null, stateChangedAt: null });
  assert.equal(readded.scopeVersion, 3);
  assert.equal(updated.tokenName, rule.tokenName);

  // 只改名称不改范围：策略和版本保持不变。
  const renamed = await repository.updateRule(rule.id, { tokenName: "Renamed" });
  assert.equal(renamed.tokenName, "Renamed");
  assert.equal(renamed.scopeVersion, 3);
  assert.equal(renamed.billingEffectiveFrom, readded.billingEffectiveFrom);

  await assert.rejects(repository.updateRule(`rr_missing${fixture.tag}`, { tokenName: "x" }), notFound);
  const archived = await fixture.createRule({ tokenId: fixture.token(5), channels: [{ channelId: fixture.channel(5), name: "Five" }] });
  await repository.archiveRule(archived.id);
  await assert.rejects(repository.updateRule(archived.id, { tokenName: "x" }), notFound);
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

contract("appendChannels keeps existing members with their status, and a failing guard rolls everything back", async ({ repository, fixture }) => {
  const c1 = fixture.channel(1), c2 = fixture.channel(2), c3 = fixture.channel(3);
  const rule = await fixture.createRule({ channels: [{ channelId: c1, name: "One" }] });
  await repository.updateChannelStates(rule.id, [{ channelId: c1, state: "enabled" }], EFFECTIVE_FROM + HOUR);
  const appended = await repository.appendChannels(rule.id, [{ channelId: c2, name: "Two" }]);
  assert.deepEqual(appended.channels, [
    { channelId: c1, name: "One", state: "enabled", stateObservedAt: EFFECTIVE_FROM + HOUR, stateChangedAt: EFFECTIVE_FROM + HOUR },
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

  await assert.rejects(repository.observeSource(`rr_missing${fixture.tag}`, { groups, group: "vip", ratio: 2, tokenName: "x", detectedAt: t5 }), notFound);
  await repository.archiveRule(rule.id);
  await assert.rejects(repository.observeSource(rule.id, { groups, group: "vip", ratio: 2, tokenName: "x", detectedAt: t5 }), notFound);
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

  await assert.rejects(repository.reconcileCurrentSegment(`rr_missing${fixture.tag}`, { group: "vip", ratio: 1, detectedAt: t4 }), { code: "CURRENT_SEGMENT_MISSING", message: "这条绑定缺少当前的倍率时段" });
});

contract("a transition detected before the current segment started closes it at zero length, ordered before the open segment", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ initialRatio: 1 });
  const shape = (segments) => segments.map((segment) => [segment.group, segment.effectiveFrom, segment.effectiveTo]);
  // 旧分段收成零长度，和新分段同一起点、常在同一秒创建；未结束的分段必须排在最后。
  const segments = await repository.transitionSegment(rule.id, { group: "vip", ratio: 2, detectedAt: EFFECTIVE_FROM - HOUR });
  assert.deepEqual(shape(segments), [["default", EFFECTIVE_FROM, EFFECTIVE_FROM], ["vip", EFFECTIVE_FROM, null]]);
  assert.deepEqual(await repository.listSegments(rule.id), segments);

  // 下一次切换收的是未结束的那一段。
  const next = await repository.transitionSegment(rule.id, { group: "pro", ratio: 3, detectedAt: EFFECTIVE_FROM + HOUR });
  assert.deepEqual(shape(next), [["default", EFFECTIVE_FROM, EFFECTIVE_FROM], ["vip", EFFECTIVE_FROM, EFFECTIVE_FROM + HOUR], ["pro", EFFECTIVE_FROM + HOUR, null]]);
  assert.deepEqual(await repository.listSegments(rule.id), next);
});

contract("correctTransition moves a transition between its neighbours only", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ initialRatio: 1 });
  const t1 = EFFECTIVE_FROM + 10 * HOUR, t2 = EFFECTIVE_FROM + 20 * HOUR;
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: "VIP", detectedAt: t1 });
  const { segments } = await repository.observeSource(rule.id, { groups: {}, group: "pro", ratio: 3, tokenName: "Pro", detectedAt: t2 });
  const [first, middle, last] = segments;

  await assert.rejects(repository.correctTransition(rule.id, first.id, EFFECTIVE_FROM + HOUR), noPrevious);
  await assert.rejects(repository.correctTransition(rule.id, `rs_missing${fixture.tag}`, EFFECTIVE_FROM + HOUR), noPrevious);
  await assert.rejects(repository.correctTransition(rule.id, middle.id, EFFECTIVE_FROM), outOfRange);
  await assert.rejects(repository.correctTransition(rule.id, middle.id, t2), outOfRange);
  await assert.rejects(repository.correctTransition(rule.id, middle.id, Number.NaN), outOfRange);
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

contract("updateChannelStates records status, observation time and the time the status last changed", async ({ repository, fixture }) => {
  const c1 = fixture.channel(1), c2 = fixture.channel(2);
  const rule = await fixture.createRule({ channels: [{ channelId: c1, name: "A" }, { channelId: c2, name: "B" }] });
  const t1 = EFFECTIVE_FROM + HOUR, t2 = EFFECTIVE_FROM + 2 * HOUR, t3 = EFFECTIVE_FROM + 3 * HOUR;
  await repository.updateChannelStates(rule.id, [{ channelId: c1, state: "enabled" }, { channelId: c2, state: "disabled" }, { channelId: fixture.channel(9), state: "enabled" }], t1);
  assert.deepEqual((await repository.getRule(rule.id)).channels, [
    { channelId: c1, name: "A", state: "enabled", stateObservedAt: t1, stateChangedAt: t1 },
    { channelId: c2, name: "B", state: "disabled", stateObservedAt: t1, stateChangedAt: t1 },
  ]);
  await repository.updateChannelStates(rule.id, [{ channelId: c1, state: "disabled" }], t2);
  // 状态不变只刷新观测时间，变化时刻保持上一次变化的时间。
  await repository.updateChannelStates(rule.id, [{ channelId: c1, state: "disabled" }, { channelId: c2, state: "disabled" }], t3);
  assert.deepEqual((await repository.getRule(rule.id)).channels, [
    { channelId: c1, name: "A", state: "disabled", stateObservedAt: t3, stateChangedAt: t2 },
    { channelId: c2, name: "B", state: "disabled", stateObservedAt: t3, stateChangedAt: t1 },
  ]);
  const listed = (await fixture.mine()).find((item) => item.id === rule.id);
  assert.deepEqual(listed.channels, (await repository.getRule(rule.id)).channels);

  await assert.rejects(repository.updateChannelStates(`rr_missing${fixture.tag}`, [{ channelId: c1, state: "enabled" }], t3), notFound);
  await repository.archiveRule(rule.id);
  await assert.rejects(repository.updateChannelStates(rule.id, [{ channelId: c1, state: "enabled" }], t3), notFound);
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
  const legacySource = (profitUsd) => ({ recordType: "confirmed", billingSource: RECONCILIATION_BILLING_SOURCE,
    calculationVersion: RECONCILIATION_CALCULATION_VERSION, result: { calculation: { profitUsd } } });

  assert.equal(await repository.saveSnapshot({ ruleId: rule.id, segmentId: "seg-first", snapshotKey, windowKind: "yesterday", startMs: 1000, endMs: 2000,
    localDate: null, upstreamUsd: 1, healthCode: "READY", healthDetail: null, source: legacySource(1) }), true);
  if (inspect) {
    assert.deepEqual(await inspect(rule.id, snapshotKey), { segmentId: "seg-first", windowKind: "yesterday", windowStartMs: 1000, windowEndMs: 2000,
      upstreamUsd: 1, healthCode: "READY", healthDetail: null });
  }

  assert.equal(await repository.saveSnapshot({ ruleId: rule.id, segmentId: "seg-second", snapshotKey, windowKind: "custom", startMs: 1500, endMs: 2500,
    localDate: "2026-01-01", upstreamUsd: 2, healthCode: "PARTIAL", healthDetail: "second write", source: legacySource(2) }), true);
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
  const window = { preset: "yesterday", startMs: Date.UTC(2026, 0, 10), endMs: Date.UTC(2026, 0, 11), timezone: "UTC" };
  const snapshot = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: "2026-01-11T00:20:00.000Z", profitUsd: 2 });
  const ledger = settlement(snapshot);
  const latest = () => repository.latestSuccessfulResult(rule.id, window, fingerprint);

  assert.equal(await repository.saveSnapshotsForScope(rule.id, "stale-fingerprint", [snapshot], { ledger }), false);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { expectedOwnerState: reconciliationOwnerRuleState([]), ledger }), false);
  assert.equal(await repository.saveSnapshotsForScope(`rr_missing${fixture.tag}`, fingerprint, [snapshot], { ledger }), false);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { guard: () => false, ledger }), false);
  // 守卫在写完快照和账本之后才失败：两者一起回滚。
  let calls = 0;
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { guard: () => ++calls === 1, ledger }), false);
  assert.equal(calls, 2);
  assert.equal(await latest(), null);
  assert.equal(await repository.latestLedgerEntry(rule.id, window), null);
  assert.deepEqual((await repository.listLedgerHistory(rule.id, { startMs: window.startMs, endMs: window.endMs })).records, []);

  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { expectedOwnerState: await fixture.ownerState(), guard: () => true, ledger }), true);
  assert.equal((await latest()).result.calculation.profitUsd, 2);
  assert.equal((await repository.latestLedgerEntry(rule.id, window)).revision, 1);

  // 规则口径变化后旧口径的保存被拒绝。
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: "VIP", detectedAt: window.startMs + HOUR });
  const second = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: "2026-01-11T01:00:00.000Z", profitUsd: 9 });
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
    window: { preset: "today", startMs: day, endMs: day + endHours * HOUR, timezone: "UTC" }, recordType: "observation", generatedAt, profitUsd })]);
  const latest = async () => {
    const found = await repository.latestObservation(rule.id, { preset: "today", startMs: day, endMs: day + DAY, timezone: "UTC" }, fingerprint);
    return [found.generatedAt, found.result.calculation.differenceUsd, found.result.window.endMs];
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

contract("latestObservation picks the newest matching observation; latestSuccessfulResult only returns settled whole days", async ({ repository, fixture }) => {
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

  // 旧版本把今天的半天也写成过 confirmed：不是已结束的自然日，不算结账记录。
  await repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, window, generatedAt: "2026-01-12T06:00:00.000Z", profitUsd: 2 }));
  await repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, window, recordType: "observation", generatedAt: "2026-01-12T06:00:01.000Z", profitUsd: 3 }));
  assert.equal(await confirmed(query(day + 8 * HOUR)), null);

  const observation = await observed(query(day + 8 * HOUR));
  assert.equal(observation.generatedAt, "2026-01-12T06:00:01.000Z");
  assert.deepEqual(observation.result.window, window);
  assert.equal(observation.result.lastSuccessfulWindow, null);
  assert.deepEqual(observation.result.calculation, { differenceUsd: 3, profitUsd: null, riskDifferenceUsd: 3, marginRate: 0.5 });

  // 行上的窗口结束晚于查询窗口、口径不同、时区不同都查不到；today 取不晚于查询结束的最新一条。
  assert.equal(await observed(query(day + 5 * HOUR)), null);
  assert.equal(await observed(query(day + 8 * HOUR, "other-fingerprint")), null);
  assert.equal(await repository.latestObservation(rule.id, { ...window, endMs: day + 8 * HOUR, timezone: "Asia/Shanghai" }, fingerprint), null);
  await repository.saveSnapshot(billingSnapshot({ rule, segment, segmentId: `seg-later-${fixture.tag}`, fingerprint, window: { ...window, endMs: day + 7 * HOUR },
    recordType: "observation", generatedAt: "2026-01-12T07:00:00.000Z", profitUsd: 5 }));
  assert.equal((await observed(query(day + 8 * HOUR))).result.calculation.differenceUsd, 5);
  assert.equal((await observed(query(day + 6.5 * HOUR))).result.calculation.differenceUsd, 3);

  // 已结束的自然日：结束时间必须完全一致；另一分段的更新记录胜出；利润未知的确认记录不算成功账单。
  const yesterday = { preset: "yesterday", startMs: day - DAY, endMs: day, timezone: "UTC" };
  await repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, window: yesterday, generatedAt: "2026-01-12T00:15:00.000Z", profitUsd: 11 }));
  const success = await repository.latestSuccessfulResult(rule.id, yesterday, fingerprint);
  assert.equal(success.generatedAt, "2026-01-12T00:15:00.000Z");
  assert.deepEqual(success.result.window, yesterday);
  assert.deepEqual(success.result.requestedWindow, yesterday);
  assert.deepEqual(success.result.lastSuccessfulWindow, yesterday);
  assert.deepEqual(success.result.calculation, { differenceUsd: 11, profitUsd: 11, riskDifferenceUsd: null, marginRate: 0.5 });
  assert.equal(success.result.health.code, "READY");
  await repository.saveSnapshot(billingSnapshot({ rule, segment, segmentId: `seg-settle-${fixture.tag}`, fingerprint, window: yesterday, generatedAt: "2026-01-12T01:00:00.000Z", profitUsd: 12 }));
  await repository.saveSnapshot(billingSnapshot({ rule, segment, segmentId: `seg-null-${fixture.tag}`, fingerprint, window: yesterday, generatedAt: "2026-01-12T02:00:00.000Z", profitUsd: null }));
  assert.equal((await repository.latestSuccessfulResult(rule.id, yesterday, fingerprint)).result.calculation.profitUsd, 12);
  assert.equal(await repository.latestSuccessfulResult(rule.id, { ...yesterday, endMs: day + HOUR }, fingerprint), null);

  // 整天窗口但生成时还没结束（当天写下的）也不算。
  const fullToday = { preset: "custom", startMs: day, endMs: day + DAY, timezone: "UTC" };
  await repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, window: fullToday, generatedAt: "2026-01-12T20:00:00.000Z", profitUsd: 9 }));
  assert.equal(await repository.latestSuccessfulResult(rule.id, fullToday, fingerprint), null);
});

contract("latestSettlement returns the newest settled confirmed record of the exact window, whatever its scope or preset", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const other = await fixture.createRule({ tokenId: fixture.token(1), channels: [{ channelId: fixture.channel(2), name: "Other" }] });
  const [segment] = await repository.listSegments(rule.id);
  const [otherSegment] = await repository.listSegments(other.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const day = Date.UTC(2026, 0, 12);
  const yesterday = { preset: "yesterday", startMs: day - DAY, endMs: day, timezone: "UTC" };
  const custom = { ...yesterday, preset: "custom" };
  const save = (overrides) => repository.saveSnapshot(billingSnapshot({ rule, segment, fingerprint, window: yesterday, ...overrides }));
  assert.equal(await repository.latestSettlement(rule.id, yesterday), null);

  // 观测记录、利润未知的确认记录、窗口结束前写下的确认记录、起止不同的窗口、别的规则都不算。
  await save({ recordType: "observation", generatedAt: "2026-01-12T03:00:00.000Z", profitUsd: 1 });
  await save({ segmentId: `seg-null-${fixture.tag}`, generatedAt: "2026-01-12T03:00:00.000Z", profitUsd: null });
  await save({ segmentId: `seg-early-${fixture.tag}`, generatedAt: "2026-01-11T23:00:00.000Z", profitUsd: 2 });
  await save({ segmentId: `seg-later-${fixture.tag}`, window: { ...custom, startMs: day - DAY + HOUR }, generatedAt: "2026-01-12T03:00:00.000Z", profitUsd: 3 });
  await repository.saveSnapshot(billingSnapshot({ rule: other, segment: otherSegment, fingerprint: await fixture.fingerprint(other.id), window: yesterday,
    generatedAt: "2026-01-12T03:00:00.000Z", profitUsd: 4 }));
  assert.equal(await repository.latestSettlement(rule.id, yesterday), null);

  await save({ generatedAt: "2026-01-12T00:15:00.000Z", profitUsd: 11 });
  assert.equal((await repository.latestSettlement(rule.id, yesterday)).result.calculation.profitUsd, 11);
  // 结账后改了关联口径、按「自定义」查询写下的更新记录同样算数。
  await save({ segmentId: `seg-rebound-${fixture.tag}`, fingerprint: "other-fingerprint", window: custom, generatedAt: "2026-01-12T01:00:00.000Z", profitUsd: 12 });
  for (const window of [yesterday, custom]) {
    const settlement = await repository.latestSettlement(rule.id, window);
    assert.equal(settlement.generatedAt, "2026-01-12T01:00:00.000Z");
    assert.equal(settlement.result.calculation.profitUsd, 12);
    assert.deepEqual(settlement.result.window, custom);
  }
  assert.equal(await repository.latestSettlement(rule.id, { ...yesterday, timezone: "Asia/Shanghai" }), null);
  assert.equal(await repository.latestSettlement(rule.id, { ...yesterday, endMs: day + HOUR }), null);
  assert.equal((await repository.latestSettlement(other.id, yesterday)).result.calculation.profitUsd, 4);
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

// ---- 结账账本 ----

contract("the ledger keeps one row per settled day: the same window is not booked twice, a resettle or another window adds a revision", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const other = await fixture.createRule({ tokenId: fixture.token(1), channels: [{ channelId: fixture.channel(2), name: "Other" }] });
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const day = Date.UTC(2026, 0, 10);
  const window = { preset: "yesterday", startMs: day, endMs: day + DAY, timezone: "UTC" };
  const snapshot = (overrides) => billingSnapshot({ rule, segment, fingerprint, window, ...overrides });
  // 单日结账只写账本，不必带快照。
  const settle = (overrides, options) => repository.saveSnapshotsForScope(rule.id, fingerprint, [], { ledger: settlement(snapshot(overrides), options) });
  const latest = (query = window) => repository.latestLedgerEntry(rule.id, query);
  assert.equal(await latest(), null);

  assert.equal(await settle({ generatedAt: "2026-01-11T00:20:00.000Z", profitUsd: 2 }, { revenueRate: 7.1, costRate: null, costBasis: "usage" }), true);
  const first = await latest();
  assert.deepEqual({ ...first, detail: undefined }, { ruleId: rule.id, billDate: "2026-01-10", revision: 1, versionId: null, timezone: "UTC",
    startMs: day, endMs: day + DAY, revenueUsd: 2.25, costUsd: 1, revenueRate: 7.1, costRate: null, costBasis: "usage", source: "settle",
    detail: undefined, settledAt: "2026-01-11T00:20:00.000Z" });
  assert.equal(first.detail.result.calculation.profitUsd, 2);
  assert.equal(first.detail.scopeFingerprint, fingerprint);

  // 同一窗口再次结账（轮询重算、按「自定义」查询）不再记账；重新结账写下一版。
  assert.equal(await settle({ generatedAt: "2026-01-11T01:00:00.000Z", profitUsd: 3 }), true);
  assert.equal(await settle({ window: { ...window, preset: "custom" }, generatedAt: "2026-01-11T01:05:00.000Z", profitUsd: 3 }), true);
  assert.deepEqual([(await latest()).revision, (await latest()).detail.result.calculation.profitUsd], [1, 2]);
  assert.equal(await settle({ generatedAt: "2026-01-11T02:00:00.000Z", profitUsd: 4 }, { resettle: true, costBasis: "usage" }), true);
  const second = await latest();
  assert.deepEqual([second.revision, second.source, second.settledAt, second.revenueRate, second.detail.result.calculation.profitUsd],
    [2, "resettle", "2026-01-11T02:00:00.000Z", null, 4]);

  // 同一天换了时区（窗口不同）也写下一版；之后按旧窗口查不到，成本取不到时记空。
  const shanghai = { preset: "yesterday", startMs: day - 8 * HOUR, endMs: day + 16 * HOUR, timezone: "Asia/Shanghai" };
  const moved = snapshot({ window: shanghai, generatedAt: "2026-01-10T16:30:00.000Z", profitUsd: 5 });
  moved.source.result.upstream.amountUsd = null;
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [], { ledger: settlement(moved, { costRate: 7.3, costBasis: "fixed" }) }), true);
  assert.equal(await latest(), null);
  const third = await latest(shanghai);
  assert.deepEqual([third.billDate, third.revision, third.source, third.costUsd, third.costRate, third.costBasis], ["2026-01-10", 3, "resettle", null, 7.3, "fixed"]);

  // 不是单个自然日的窗口、别的规则都查不到。
  assert.equal(await latest({ ...shanghai, endMs: shanghai.endMs + DAY }), null);
  assert.equal(await latest({ ...shanghai, startMs: shanghai.startMs + HOUR }), null);
  assert.equal(await repository.latestLedgerEntry(other.id, shanghai), null);
});

contract("listLedgerHistory lists the newest revision of each settled day inside the range, latest day first", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const d1 = Date.UTC(2026, 0, 5), d2 = d1 + DAY, d3 = d2 + DAY;
  const settle = (startMs, profitUsd, options) => repository.saveSnapshotsForScope(rule.id, fingerprint, [], { ledger: settlement(billingSnapshot({ rule, segment, fingerprint,
    window: { preset: "custom", startMs, endMs: startMs + DAY, timezone: "UTC" }, generatedAt: new Date(startMs + DAY + profitUsd * 60000).toISOString(), profitUsd }), options) });
  await settle(d1, 1);
  await settle(d2, 2);
  await settle(d2, 22, { resettle: true, revenueRate: 7.2 });
  await settle(d3, 3);

  const all = await repository.listLedgerHistory(rule.id, { startMs: d1, endMs: d3 + DAY });
  assert.equal(all.nextCursor, null);
  assert.deepEqual(all.records.map((record) => [record.billDate, record.revision, record.settlementSource, record.window.startMs, record.window.endMs, record.calculation.profitUsd]), [
    ["2026-01-07", 1, "settle", d3, d3 + DAY, 3], ["2026-01-06", 2, "resettle", d2, d2 + DAY, 22], ["2026-01-05", 1, "settle", d1, d1 + DAY, 1],
  ]);
  for (const record of all.records) {
    assert.equal(record.scopeFingerprint, fingerprint);
    assert.equal(record.window.preset, "custom");
    assert.equal(record.window.timezone, "UTC");
    assert.equal(record.upstreamSource.tokenId, rule.tokenId);
  }
  assert.deepEqual([all.records[1].confirmedAt, all.records[1].settledRates, all.records[1].costBasis], [new Date(d3 + 22 * 60000).toISOString(), { income: 7.2, cost: null }, "usage"]);
  assert.equal(new Set(all.records.map((record) => record.historyId)).size, 3);

  const days = async (range) => (await repository.listLedgerHistory(rule.id, range)).records.map((record) => record.window.startMs);
  assert.deepEqual(await days({ startMs: d2, endMs: d3 + DAY }), [d3, d2]);
  assert.deepEqual(await days({ startMs: d1, endMs: d3 + DAY - 1 }), [d2, d1]);
  assert.deepEqual(await days({ startMs: d1 + 1, endMs: d2 + DAY }), [d2]);
  assert.deepEqual((await repository.listLedgerHistory(`rr_missing${fixture.tag}`, { startMs: d1, endMs: d3 + DAY })).records, []);
});

contract("listLedgerHistory pages with a (day, rule) cursor that survives a resettle, and rejects invalid options", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const d1 = Date.UTC(2026, 1, 1);
  const settle = (index, profitUsd, options) => {
    const startMs = d1 + index * DAY;
    return repository.saveSnapshotsForScope(rule.id, fingerprint, [], { ledger: settlement(billingSnapshot({ rule, segment, fingerprint,
      window: { preset: "yesterday", startMs, endMs: startMs + DAY, timezone: "UTC" }, generatedAt: new Date(startMs + DAY + HOUR).toISOString(), profitUsd }), options) });
  };
  for (let index = 0; index < 3; index += 1) await settle(index, index + 1);
  const range = { startMs: d1, endMs: d1 + 3 * DAY };
  const first = await repository.listLedgerHistory(rule.id, { ...range, limit: 2 });
  assert.deepEqual(first.records.map((record) => record.calculation.profitUsd), [3, 2]);
  assert.equal(typeof first.nextCursor, "string");
  // 翻页之间重新结账了已经列过的一天：下一页既不重复也不漏。
  await settle(2, 30, { resettle: true });
  const second = await repository.listLedgerHistory(rule.id, { ...range, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.records.map((record) => record.calculation.profitUsd), [1]);
  assert.equal(second.nextCursor, null);
  const ids = [...first.records, ...second.records].map((record) => record.historyId);
  assert.equal(new Set(ids).size, 3);
  assert.equal((await repository.listLedgerHistory(rule.id, { ...range, limit: 3 })).nextCursor, null);
  assert.deepEqual((await repository.listLedgerHistory(rule.id, { ...range, limit: 1 })).records.map((record) => record.calculation.profitUsd), [30]);

  const invalid = { code: "INVALID_REQUEST" };
  await assert.rejects(repository.listLedgerHistory(rule.id, { startMs: d1, endMs: d1 }), invalid);
  await assert.rejects(repository.listLedgerHistory(rule.id, { startMs: d1, endMs: d1 + 32 * DAY }), invalid);
  await assert.rejects(repository.listLedgerHistory(rule.id, { ...range, limit: 0 }), invalid);
  await assert.rejects(repository.listLedgerHistory(rule.id, { ...range, limit: "" }), invalid);
  await assert.rejects(repository.listLedgerHistory(rule.id, { ...range, cursor: "not a cursor" }), invalid);
  await assert.rejects(repository.listLedgerHistory(rule.id, { ...range, cursor: Buffer.from("[1,2]").toString("base64url") }), invalid);
  await assert.rejects(repository.listLedgerHistory(rule.id, { ...range, cursor: Buffer.from('["2026-02-30","r"]').toString("base64url") }), invalid);
});

// ---- 账单能力核验结果 ----

contract("billing capabilities round-trip, overwrite and delete by identity", async ({ repository, fixture }) => {
  const now = Date.now();
  const first = fixture.capabilityIdentity("first"), second = fixture.capabilityIdentity("second");
  assert.equal(await repository.getBillingCapability(first), null);
  const capability = { state: "supported", currency: "USD", window: "natural-day", verifiedAt: now - 1000, reason: "RUNTIME_FILTERS_VERIFIED" };
  await repository.saveBillingCapability(first, capability);
  await repository.saveBillingCapability(second, { ...capability, verifiedAt: now - 500 });
  assert.deepEqual(await repository.getBillingCapability(first), capability);
  // 身份大小写不同仍是同一行（utf8mb4_0900_ai_ci）。
  assert.deepEqual(await repository.getBillingCapability(first.toUpperCase()), capability);

  await repository.saveBillingCapability(first, { ...capability, verifiedAt: now });
  assert.equal((await repository.getBillingCapability(first)).verifiedAt, now);
  assert.equal((await repository.getBillingCapability(second)).verifiedAt, now - 500);

  await repository.deleteBillingCapability(first);
  assert.equal(await repository.getBillingCapability(first), null);
  assert.equal((await repository.getBillingCapability(second)).verifiedAt, now - 500);
  await repository.deleteBillingCapability(first);
  await assert.rejects(repository.saveBillingCapability(`${first}0`, capability), { code: "ER_DATA_TOO_LONG" });
});

contract("saving a billing capability never drops other identities, however long ago they were verified", async ({ repository, fixture }) => {
  const now = Date.now();
  const idle = fixture.capabilityIdentity("idle"), fresh = fixture.capabilityIdentity("fresh");
  const capability = (verifiedAt) => ({ state: "supported", currency: "USD", window: "natural-day", verifiedAt, reason: "RUNTIME_FILTERS_VERIFIED" });
  // 长期零消费的账号无法重新核验，它的旧核验结果要一直可读。
  await repository.saveBillingCapability(idle, capability(now - 400 * DAY));
  await repository.saveBillingCapability(fresh, capability(now));
  assert.equal((await repository.getBillingCapability(idle)).verifiedAt, now - 400 * DAY);
  assert.equal((await repository.getBillingCapability(fresh)).verifiedAt, now);
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

  const ledgerSnapshot = billingSnapshot({ rule: stored, segment: segments[0], fingerprint, window: { ...window }, generatedAt: "2026-03-02T00:05:00.000Z", profitUsd: 4 });
  const ledger = settlement(ledgerSnapshot);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [], { ledger }), true);
  ledger.entry.detail.result.calculation.profitUsd = 40;
  ledger.entry.revenueUsd = 40;
  const entry = await repository.latestLedgerEntry(rule.id, window);
  assert.deepEqual([entry.revenueUsd, entry.detail.result.calculation.profitUsd], [2.25, 4]);
  entry.detail.result.calculation.profitUsd = 41;
  entry.startMs = 1;
  const entryAgain = await repository.latestLedgerEntry(rule.id, window);
  assert.deepEqual([entryAgain.startMs, entryAgain.detail.result.calculation.profitUsd], [day, 4]);

  const history = await repository.listLedgerHistory(rule.id, { startMs: day, endMs: day + DAY });
  history.records[0].calculation.profitUsd = 42;
  history.records[0].window.startMs = 2;
  const historyAgain = await repository.listLedgerHistory(rule.id, { startMs: day, endMs: day + DAY });
  assert.equal(historyAgain.records[0].calculation.profitUsd, 4);
  assert.equal(historyAgain.records[0].window.startMs, day);

  const identity = fixture.capabilityIdentity("copies");
  const capability = { state: "supported", currency: "USD", window: "natural-day", verifiedAt: Date.now(), reason: "RUNTIME_FILTERS_VERIFIED" };
  await repository.saveBillingCapability(identity, capability);
  capability.state = "mutated input";
  const read = await repository.getBillingCapability(identity);
  assert.equal(read.state, "supported");
  read.state = "mutated result";
  assert.equal((await repository.getBillingCapability(identity)).state, "supported");
});
