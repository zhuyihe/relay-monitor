// 对账持久化层的行为契约：同一组用例分别跑在 MySQL 版 ReconciliationRepository 与
// MemoryReconciliationRepository 上，两边不一致时以 MySQL 为准修正内存实现。
// 用例只调用公开方法；每个用例使用随机的站点、Key 与渠道编号，可以在已有数据的库里重复运行。
// 运行方提供：
//   create()                                        每个用例新建（或复用连接池）一个仓库实例
//   cleanup({ repository, ruleIds, capabilityIdentities })  删除本用例写入的全部规则及其渠道、分段、快照、告警、账本，以及账单能力记录
//   inspectSnapshot({ repository, ruleId, snapshotKey })  读取快照行的物理列（segment_id 等没有公开读取方法）
//   failRequestWrites({ repository })                让之后写重结请求的那一步抛错，返回恢复的函数（改切换时间的事务里，请求写不进去要连分段一起回滚）
//   backdateRule({ repository, ruleId, createdAtMs })  把一条绑定的建立时刻改到过去（改时间要写重结请求的日子得在建绑定之后，用例里只能这样造）
//   insertSegmentKeyRow({ repository, segmentId, upstreamStationId, tokenId, tokenName })  给一段多插一行 Key（K1c 这版公开方法造不出一段多把 Key，这是唯一的造法，K2b 开始写才会真的发生）
//   teardown()                                       全部用例结束后释放资源
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { BILLING_CAPABILITY_IDENTITY_SCHEME, LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME } from "../../lib/billing-capability-storage.js";
import { RECONCILIATION_BILLING_SOURCE, RECONCILIATION_CALCULATION_VERSION } from "../../lib/reconciliation-contract.js";
import { ledgerEntryForSettlement } from "../../lib/reconciliation-ledger.js";
import { reconciliationRuleEvidence, reconciliationScopeFingerprint, reconciliationSnapshotRecordIdentity } from "../../lib/reconciliation-snapshot.js";
import { reconciliationOwnerRuleState, reconciliationOwnerScope } from "../reconciliation-repository.js";

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

  async fingerprint(ruleId, { includeArchived = false } = {}) {
    const rule = await this.repository.getRule(ruleId, { includeArchived });
    return reconciliationScopeFingerprint(rule, await this.repository.listSegments(ruleId));
  }

  async ownerState(tokenId) {
    return reconciliationOwnerScope(await this.repository.listRules(), tokenId);
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

export function defineReconciliationRepositoryContract({ name, create, cleanup = async () => {}, inspectSnapshot = null, backdateRule = null, failRequestWrites = null, insertSegmentKeyRow = null, teardown = null }) {
  test(`reconciliation repository contract: ${name}`, { timeout: 120000 }, async (t) => {
    if (teardown) t.after(teardown);
    for (const [title, run] of CASES) {
      await t.test(title, async () => {
        const repository = await create();
        const fixture = new Fixture(repository);
        const inspect = inspectSnapshot && ((ruleId, snapshotKey) => inspectSnapshot({ repository, ruleId, snapshotKey }));
        try {
          const backdate = backdateRule && ((ruleId, createdAtMs) => backdateRule({ repository, ruleId, createdAtMs }));
          const failRequests = failRequestWrites && (() => failRequestWrites({ repository }));
          const insertKey = insertSegmentKeyRow && ((args) => insertSegmentKeyRow({ repository, ...args }));
          await run({ repository, fixture, inspect, backdate, failRequests, insertKey });
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
    keyIssue: null,
    sourceBinding: null, ownSource: null, coverageDeclaration: { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] },
    archivedAt: null, archivedAtMs: null, accountingFloorMs: null, createdAt: null, updatedAt: null,
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
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { expectedOwnerState: { tokenId: rule.tokenId, state: reconciliationOwnerRuleState([]) }, ledger }), false);
  assert.equal(await repository.saveSnapshotsForScope(`rr_missing${fixture.tag}`, fingerprint, [snapshot], { ledger }), false);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { guard: () => false, ledger }), false);
  // 守卫在写完快照和账本之后才失败：两者一起回滚。
  let calls = 0;
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { guard: () => ++calls === 1, ledger }), false);
  assert.equal(calls, 2);
  assert.equal(await latest(), null);
  assert.equal(await repository.latestLedgerEntry(rule.id, window), null);
  assert.deepEqual((await repository.listLedgerHistory(rule.id, { startMs: window.startMs, endMs: window.endMs })).records, []);

  // 只核对同一把 Key 的那一组：之后别的 Key 的绑定变了，按之前的指纹照样能写（P1c）
  const owners = await fixture.ownerState(rule.tokenId);
  await fixture.createRule({ tokenId: fixture.token(7), channels: [{ channelId: fixture.channel(7), name: "Other key" }] });
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { expectedOwnerState: owners, guard: () => true, ledger }), true);
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
  // B-S1：窗口结束后、不满等待期（15 分钟）写下的也不算，和读侧、迁移同一个判断（原来仓库这里只要求窗口结束）
  await save({ segmentId: `seg-soon-${fixture.tag}`, generatedAt: "2026-01-12T00:14:59.999Z", profitUsd: 5 });
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

  // 起止一样、只是时区名不同（UTC 和 Etc/UTC）也算换了窗口：写下一版，按原来的时区就查不到了
  const etc = { ...window, timezone: "Etc/UTC" };
  assert.equal(await settle({ window: etc, generatedAt: "2026-01-11T02:10:00.000Z", profitUsd: 4 }), true);
  assert.equal(await latest(), null);
  assert.deepEqual([(await latest(etc)).revision, (await latest(etc)).source, (await latest(etc)).timezone], [3, "resettle", "Etc/UTC"]);

  // 同一天换了时区（窗口不同）也写下一版；之后按旧窗口查不到，成本取不到时记空。
  const shanghai = { preset: "yesterday", startMs: day - 8 * HOUR, endMs: day + 16 * HOUR, timezone: "Asia/Shanghai" };
  const moved = snapshot({ window: shanghai, generatedAt: "2026-01-10T16:30:00.000Z", profitUsd: 5 });
  moved.source.result.upstream.amountUsd = null;
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [], { ledger: settlement(moved, { costRate: 7.3, costBasis: "fixed" }) }), true);
  assert.equal(await latest(), null);
  const third = await latest(shanghai);
  assert.deepEqual([third.billDate, third.revision, third.source, third.costUsd, third.costRate, third.costBasis], ["2026-01-10", 4, "resettle", null, 7.3, "fixed"]);

  // 不是单个自然日的窗口、别的规则都查不到。
  assert.equal(await latest({ ...shanghai, endMs: shanghai.endMs + DAY }), null);
  assert.equal(await latest({ ...shanghai, startMs: shanghai.startMs + HOUR }), null);
  assert.equal(await repository.latestLedgerEntry(other.id, shanghai), null);
});

// B-L1：重结出来的账和最新一版内容相同就不写新版。内容只比窗口、成本计法，金额按 DECIMAL(20,8)、汇率按 DECIMAL(12,6) 存进去以后比；
// 不比明细和结账时刻
contract("a resettle with the same ledger content adds no revision; a change in amounts, rates or cost basis does", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const day = Date.UTC(2026, 2, 3);
  const window = { preset: "yesterday", startMs: day, endMs: day + DAY, timezone: "UTC" };
  let minutes = 20;
  const settle = ({ revenueUsd = 2.25, costUsd = 1, profitUsd = 1.25 } = {}, options = {}) => {
    const snapshot = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: new Date(day + DAY + (minutes += 10) * 60000).toISOString(), profitUsd });
    snapshot.source.result.downstream.amountUsd = revenueUsd;
    snapshot.source.result.upstream.amountUsd = costUsd;
    return repository.saveSnapshotsForScope(rule.id, fingerprint, [], { ledger: settlement(snapshot, { costBasis: "usage", ...options }) });
  };
  const latest = async () => {
    const entry = await repository.latestLedgerEntry(rule.id, window);
    return [entry.revision, entry.source, entry.revenueUsd, entry.costUsd, entry.revenueRate, entry.costBasis, entry.detail.result.calculation.profitUsd];
  };

  // 当天没有账时重结：写第 1 版，source 是 settle
  assert.equal(await settle({}, { resettle: true }), true);
  assert.deepEqual(await latest(), [1, "settle", 2.25, 1, null, "usage", 1.25]);
  // 重结、内容相同（明细里的毛利、结账时刻变了）：不写
  assert.equal(await settle({ profitUsd: 9 }, { resettle: true }), true);
  assert.deepEqual(await latest(), [1, "settle", 2.25, 1, null, "usage", 1.25]);
  // 金额舍入以后相同：不写
  assert.equal(await settle({ revenueUsd: 2.250000004, costUsd: 0.999999996 }, { resettle: true }), true);
  assert.deepEqual(await latest(), [1, "settle", 2.25, 1, null, "usage", 1.25]);
  // 重结、只有金额变：写
  assert.equal(await settle({ revenueUsd: 2.26, profitUsd: 1.26 }, { resettle: true }), true);
  assert.deepEqual(await latest(), [2, "resettle", 2.26, 1, null, "usage", 1.26]);
  // 重结、只有汇率从无到有：写；汇率舍入以后相同：不写
  assert.equal(await settle({ revenueUsd: 2.26 }, { resettle: true, revenueRate: 7.2 }), true);
  assert.deepEqual(await latest(), [3, "resettle", 2.26, 1, 7.2, "usage", 1.25]);
  assert.equal(await settle({ revenueUsd: 2.26 }, { resettle: true, revenueRate: 7.2000004 }), true);
  assert.equal((await latest())[0], 3);
  // 重结、只有成本计法变：写
  assert.equal(await settle({ revenueUsd: 2.26 }, { resettle: true, revenueRate: 7.2, costBasis: "fixed" }), true);
  assert.deepEqual(await latest(), [4, "resettle", 2.26, 1, 7.2, "fixed", 1.25]);
  // 两版都是固定成本、只有 cost_usd 不同：不写（cost_usd 只是读到的 Key 用量，毛利不扣它）
  assert.equal(await settle({ revenueUsd: 2.26, costUsd: null }, { resettle: true, revenueRate: 7.2, costBasis: "fixed" }), true);
  assert.equal((await latest())[0], 4);
  // 不是重结：内容变了也不写（已固定的日子不再变）
  assert.equal(await settle({ revenueUsd: 3 }), true);
  assert.equal((await latest())[0], 4);

  // 提交以后把结论放进 ledger.booked：没写时带回账本里最新那一版的固定时刻，写了带这次的
  const fourth = (await repository.latestLedgerEntry(rule.id, window)).settledAt;
  const book = async (fields, options) => {
    const snapshot = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: new Date(day + DAY + (minutes += 10) * 60000).toISOString(), profitUsd: 1.25 });
    Object.assign(snapshot.source.result.downstream, { amountUsd: fields.revenueUsd });
    const ledger = settlement(snapshot, { costBasis: "fixed", revenueRate: 7.2, ...options });
    assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [], { ledger }), true);
    return [ledger.booked.write, ledger.booked.revision, ledger.booked.settledAt, snapshot.source.resultGeneratedAt];
  };
  const same = await book({ revenueUsd: 2.26 }, { resettle: true });
  assert.deepEqual(same.slice(0, 3), [false, 4, fourth]);
  const changed = await book({ revenueUsd: 2.27 }, { resettle: true });
  assert.deepEqual(changed.slice(0, 3), [true, 5, changed[3]]);
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
  // 翻页之间重新结账了已经列过的一天：下一页既不重复也不漏。重结得出的账要和上一版不同才写新版（这里汇率从无到有）
  await settle(2, 30, { resettle: true, revenueRate: 7.2 });
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

contract("settlement state rows: record, overwrite, list by rule, skip a day already in the ledger, delete and prune in batches", async ({ repository, fixture }) => {
  const rule = await fixture.createRule(), other = await fixture.createRule({ tokenId: fixture.token(7), channels: [{ channelId: fixture.channel(7), name: "other" }] });
  const now = Date.UTC(2026, 0, 12, 3);
  const retry = { op: "retry", reason: "PENDING", attempts: 1, nextAttemptAt: now + 600000, firstFailedAt: now, lastAttemptAt: now,
    sourceVersion: "v1", detail: { code: "PENDING", side: "upstream" } };
  await repository.recordSettlementState(rule.id, "2026-01-10", retry, now);
  await repository.recordSettlementState(other.id, "2026-01-10", retry, now);
  assert.deepEqual(await repository.listSettlementStates([rule.id]), [{ ruleId: rule.id, billDate: "2026-01-10", retryReason: "PENDING", manualReason: null,
    manualSince: null, attempts: 1, nextAttemptAt: now + 600000, firstFailedAt: now, lastAttemptAt: now, resettleRequestedAt: null, resettleReason: null,
    sourceVersion: "v1", detail: { code: "PENDING", side: "upstream" } }]);
  assert.deepEqual(await repository.listSettlementStates([]), []);
  // 同一天再记一次：整行换成新的（读取类变成要人处理）
  const manual = { op: "manual", reason: "KEY_INVALID_OR_DENIED", attempts: 1, manualSince: now + 1, nextAttemptAt: now + 600001, firstFailedAt: now,
    lastAttemptAt: now + 1, sourceVersion: "v2", detail: { code: "KEY_INVALID_OR_DENIED", side: "upstream" } };
  await repository.recordSettlementState(rule.id, "2026-01-10", manual, now + 1);
  const [row] = await repository.listSettlementStates([rule.id]);
  assert.deepEqual([row.retryReason, row.manualReason, row.manualSince, row.sourceVersion], [null, "KEY_INVALID_OR_DENIED", now + 1, "v2"]);
  assert.equal((await repository.listSettlementStates([rule.id, other.id])).length, 2);

  // 账本里已经有这天：不写（另一处已经固定了）
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const window = { preset: "yesterday", startMs: Date.UTC(2026, 0, 9), endMs: Date.UTC(2026, 0, 10), timezone: "UTC" };
  const snapshot = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: "2026-01-10T00:20:00.000Z", profitUsd: 2 });
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { ledger: settlement(snapshot) }), true);
  await repository.recordSettlementState(rule.id, "2026-01-09", retry, now);
  assert.deepEqual((await repository.listSettlementStates([rule.id])).map((item) => item.billDate), ["2026-01-10"]);

  await repository.deleteSettlementState(other.id, "2026-01-10");
  assert.deepEqual(await repository.listSettlementStates([other.id]), []);
  await repository.deleteSettlementState(other.id, "2026-01-10");

  // 清理：只删日期早于给定那天的，一次最多 limit 行
  for (const day of ["2025-12-01", "2025-12-02", "2025-12-03"]) await repository.recordSettlementState(other.id, day, retry, now);
  assert.equal(await repository.pruneSettlementStates("2025-12-03", 1), 1);
  assert.equal(await repository.pruneSettlementStates("2025-12-03", 500), 1);
  assert.equal(await repository.pruneSettlementStates("2025-12-03", 500), 0);
  assert.deepEqual((await repository.listSettlementStates([other.id])).map((item) => item.billDate), ["2025-12-03"]);
  assert.deepEqual((await repository.listSettlementStates([rule.id])).map((item) => item.billDate), ["2026-01-10"], "别的日子不动");
});

contract("a settlement that books the day deletes its state row in the same transaction; a failing guard keeps it", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const window = { preset: "yesterday", startMs: Date.UTC(2026, 0, 10), endMs: Date.UTC(2026, 0, 11), timezone: "UTC" };
  const snapshot = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: "2026-01-11T00:20:00.000Z", profitUsd: 2 });
  const state = { op: "retry", reason: "PENDING", attempts: 2, nextAttemptAt: 1, firstFailedAt: 1, lastAttemptAt: 1, sourceVersion: null, detail: null };
  await repository.recordSettlementState(rule.id, "2026-01-10", state);
  let calls = 0;
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot],
    { ledger: settlement(snapshot), settlement: { billDate: "2026-01-10" }, guard: () => ++calls === 1 }), false);
  assert.equal((await repository.listSettlementStates([rule.id])).length, 1, "守卫失败：账本和删行一起回滚");
  assert.equal(await repository.latestLedgerEntry(rule.id, window), null);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { ledger: settlement(snapshot), settlement: { billDate: "2026-01-10" } }), true);
  assert.deepEqual(await repository.listSettlementStates([rule.id]), []);
  assert.equal((await repository.latestLedgerEntry(rule.id, window)).revision, 1);
});

contract("listLedgerDays lists each booked day once per rule from a date on, only for the given rules", async ({ repository, fixture }) => {
  const rule = await fixture.createRule(), other = await fixture.createRule({ tokenId: fixture.token(7), channels: [{ channelId: fixture.channel(7), name: "other" }] });
  const book = async (target, day, profitUsd = 2, resettle = false) => {
    const [segment] = await repository.listSegments(target.id);
    const fingerprint = await fixture.fingerprint(target.id);
    const window = { preset: "yesterday", startMs: Date.UTC(2026, 0, day), endMs: Date.UTC(2026, 0, day + 1), timezone: "UTC" };
    const snapshot = billingSnapshot({ rule: target, segment, fingerprint, window, generatedAt: `2026-01-${String(day + 1).padStart(2, "0")}T00:20:00.000Z`, profitUsd });
    assert.equal(await repository.saveSnapshotsForScope(target.id, fingerprint, [snapshot], { ledger: settlement(snapshot, { resettle }) }), true);
  };
  await book(rule, 8); await book(rule, 9); await book(rule, 9, 3, true); await book(other, 9);
  const days = await repository.listLedgerDays([rule.id], "2026-01-09");
  assert.deepEqual(days, [{ ruleId: rule.id, billDate: "2026-01-09" }], "两版只算一天，早于起点的不要，别的绑定不要");
  assert.equal((await repository.listLedgerDays([rule.id, other.id], "2026-01-01")).length, 3);
  assert.deepEqual(await repository.listLedgerDays([], "2026-01-01"), []);
});

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

contract("billing capabilities are kept apart by identity scheme, and one delete removes several identities of that scheme", async ({ repository, fixture }) => {
  const now = Date.now();
  const capability = (verifiedAt) => ({ state: "supported", currency: "USD", window: "natural-day", verifiedAt, reason: "RUNTIME_FILTERS_VERIFIED" });
  const [a, b, c] = ["scheme-a", "scheme-b", "scheme-c"].map((name) => fixture.capabilityIdentity(name));
  // 旧格式的行只有按旧格式才读得到；默认读的是新格式
  await repository.saveBillingCapability(a, capability(now - 2), LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME);
  assert.equal(await repository.getBillingCapability(a), null);
  assert.deepEqual(await repository.getBillingCapability(a, LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME), capability(now - 2));
  // 同一身份改存成新格式：只有新格式读得到
  await repository.saveBillingCapability(a, capability(now - 1));
  assert.deepEqual(await repository.getBillingCapability(a, BILLING_CAPABILITY_IDENTITY_SCHEME), capability(now - 1));
  assert.equal(await repository.getBillingCapability(a, LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME), null);
  // 一次删几个身份，只删这个格式的
  await repository.saveBillingCapability(b, capability(now));
  await repository.saveBillingCapability(c, capability(now), LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME);
  await repository.deleteBillingCapability([a, b, c]);
  assert.equal(await repository.getBillingCapability(a), null);
  assert.equal(await repository.getBillingCapability(b), null);
  assert.deepEqual(await repository.getBillingCapability(c, LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME), capability(now));
  await repository.deleteBillingCapability([c.toUpperCase()], LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME);
  assert.equal(await repository.getBillingCapability(c, LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME), null);
  await repository.deleteBillingCapability([]);
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
  // 传副本：billingSnapshot 会直接引用 window，下面改写保存输入时不能连带改掉查询窗口。生成在结束满等待期以后才算结账（B-S1）
  const snapshot = billingSnapshot({ rule: stored, segment: segments[0], fingerprint, window: { ...window }, generatedAt: "2026-03-02T00:15:00.000Z", profitUsd: 4 });
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

// ---- 重结请求（C2b）：改切换时间写进结账状态表，和改分段同一个事务 ----

const stateOf = async (repository, ruleId, billDate) => (await repository.listSettlementStates([ruleId])).find((row) => row.billDate === billDate);

contract("resettle requests: one multi-row write; a newer request moves the value up and clears retry and manual records; a failed attempt keeps the request and, with a request, is recorded even when the ledger has the day", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const now = Date.UTC(2026, 0, 12, 3);
  assert.equal(await repository.requestResettle(rule.id, ["2026-01-08", "2026-01-09", "2026-01-10"], { now }), 3);
  assert.equal(await repository.requestResettle(rule.id, [], { now }), 0);
  const rows = await repository.listSettlementStates([rule.id]);
  assert.deepEqual(rows.map((row) => [row.billDate, row.resettleRequestedAt, row.resettleReason, row.attempts]), [
    ["2026-01-08", now, "transition", 0], ["2026-01-09", now, "transition", 0], ["2026-01-10", now, "transition", 0]]);
  // 这天还在退避：再来一次请求，请求时刻变大（同一毫秒也变），重试的记录清掉，马上可以结
  const retry = { op: "retry", reason: "PENDING", attempts: 4, nextAttemptAt: now + HOUR, firstFailedAt: now, lastAttemptAt: now, sourceVersion: "v1", detail: { code: "PENDING" } };
  await repository.recordSettlementState(rule.id, "2026-01-10", retry, now, { requestedAt: now });
  const kept = await stateOf(repository, rule.id, "2026-01-10");
  assert.deepEqual([kept.retryReason, kept.attempts, kept.resettleRequestedAt], ["PENDING", 4, now], "失败只记退避，请求保留");
  await repository.requestResettle(rule.id, ["2026-01-10"], { now });
  const again = await stateOf(repository, rule.id, "2026-01-10");
  assert.deepEqual([again.retryReason, again.manualReason, again.attempts, again.nextAttemptAt, again.firstFailedAt, again.detail, again.resettleRequestedAt], [null, null, 0, null, null, null, now + 1]);
  // 账本里已经有这天：平常的日子不写状态行，有重结请求的日子照写（重结没成要记退避，不然每轮都再试一次）
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const window = { preset: "yesterday", startMs: Date.UTC(2026, 0, 9), endMs: Date.UTC(2026, 0, 10), timezone: "UTC" };
  const snapshot = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: "2026-01-10T00:20:00.000Z", profitUsd: 2 });
  assert.equal(await repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot], { ledger: settlement(snapshot) }), true);
  // 带请求的日子由调用方说明（requestedAt 是它读状态行时看到的请求时刻），不在这张表上再查一次（同表子查询会死锁）
  await repository.recordSettlementState(rule.id, "2026-01-09", { ...retry, attempts: 9 }, now + 4);
  assert.equal((await stateOf(repository, rule.id, "2026-01-09")).attempts, 0, "账本里有这天、没说有请求：不写");
  // 行里的请求时刻和调用方读到的不一样（取数期间又来了新请求）：这次的失败状态不盖
  await repository.recordSettlementState(rule.id, "2026-01-09", { ...retry, attempts: 7 }, now + 5, { requestedAt: now - 1 });
  assert.equal((await stateOf(repository, rule.id, "2026-01-09")).attempts, 0);
  await repository.recordSettlementState(rule.id, "2026-01-09", retry, now + 6, { requestedAt: now });
  const requestedAndBooked = await stateOf(repository, rule.id, "2026-01-09");
  assert.deepEqual([requestedAndBooked.retryReason, requestedAndBooked.attempts, requestedAndBooked.resettleRequestedAt], ["PENDING", 4, now]);
});

contract("recordSettlementState with a request only updates that row: when it was deleted meanwhile (a manual read settled the day), no orphan row is inserted", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const now = Date.UTC(2026, 0, 12, 3);
  const retry = { op: "retry", reason: "PENDING", attempts: 1, nextAttemptAt: now + HOUR, firstFailedAt: now, lastAttemptAt: now, sourceVersion: "v1", detail: { code: "PENDING" } };
  await repository.requestResettle(rule.id, ["2026-01-10"], { now });
  await repository.deleteSettlementState(rule.id, "2026-01-10"); // 手动那次同时结成了，行已经删掉
  await repository.recordSettlementState(rule.id, "2026-01-10", retry, now + 1, { requestedAt: now });
  assert.equal(await stateOf(repository, rule.id, "2026-01-10"), undefined, "不补插没有请求的孤儿行");
  // 没有请求的日子（第一次失败）照常插
  await repository.recordSettlementState(rule.id, "2026-01-11", retry, now + 2);
  assert.equal((await stateOf(repository, rule.id, "2026-01-11")).attempts, 1);
});

contract("a settlement consumes only the resettle request it read; a request made while it ran stays and is due again at once", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const now = Date.UTC(2026, 0, 12, 3);
  const book = async (day, resettleRequestedAt, extra = {}) => {
    const window = { preset: "custom", startMs: Date.UTC(2026, 0, day), endMs: Date.UTC(2026, 0, day + 1), timezone: "UTC" };
    const snapshot = billingSnapshot({ rule, segment, fingerprint, window, generatedAt: `2026-01-${String(day + 1).padStart(2, "0")}T00:20:00.000Z`, profitUsd: 2 });
    return repository.saveSnapshotsForScope(rule.id, fingerprint, [snapshot],
      { ledger: settlement(snapshot, { resettle: true }), settlement: { billDate: `2026-01-${String(day).padStart(2, "0")}`, resettleRequestedAt }, ...extra });
  };
  const retry = { op: "retry", reason: "PENDING", attempts: 4, nextAttemptAt: now + HOUR, firstFailedAt: now, lastAttemptAt: now, sourceVersion: "v1", detail: { code: "PENDING" } };
  // 读到的请求就是现在行里的：办完，行删掉
  await repository.requestResettle(rule.id, ["2026-01-08"], { now });
  assert.equal(await book(8, now), true);
  assert.equal(await stateOf(repository, rule.id, "2026-01-08"), undefined);
  // 取数期间又来了新请求（行里的值比读到的大）：行留着，请求保留（写新请求时已经把重试记录清掉了），下一轮马上再结
  await repository.requestResettle(rule.id, ["2026-01-09"], { now });
  await repository.recordSettlementState(rule.id, "2026-01-09", retry, now);
  await repository.requestResettle(rule.id, ["2026-01-09"], { now: now + 10 });
  assert.equal(await book(9, now), true);
  const left = await stateOf(repository, rule.id, "2026-01-09");
  assert.deepEqual([left.resettleRequestedAt, left.retryReason, left.attempts, left.nextAttemptAt], [now + 10, null, 0, null]);
  // 没有请求的行（平常的退避）：读到的是 null，办完删掉
  await repository.recordSettlementState(rule.id, "2026-01-07", retry, now);
  assert.equal(await book(7, null), true);
  assert.equal(await stateOf(repository, rule.id, "2026-01-07"), undefined);
  // 守卫失败：账本和删行一起回滚，请求还在
  await repository.requestResettle(rule.id, ["2026-01-06"], { now });
  assert.equal(await book(6, now, { guard: () => false }), false);
  assert.equal((await stateOf(repository, rule.id, "2026-01-06")).resettleRequestedAt, now);
});

contract("pruneSettlementStates also drops a request made before the given time (given up long ago) but keeps a recent one", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const now = Date.UTC(2026, 0, 12, 3);
  await repository.requestResettle(rule.id, ["2025-11-01"], { now: now - 40 * DAY });
  await repository.requestResettle(rule.id, ["2025-11-02"], { now: now - 2 * DAY });
  await repository.recordSettlementState(rule.id, "2025-11-03", { op: "retry", reason: "PENDING", attempts: 1, nextAttemptAt: 1, firstFailedAt: 1, lastAttemptAt: 1, sourceVersion: null, detail: null }, now);
  assert.equal(await repository.pruneSettlementStates("2025-12-01", 500, now - 31 * DAY), 2, "没有请求的和请求早已放弃的");
  assert.deepEqual((await repository.listSettlementStates([rule.id])).map((row) => row.billDate), ["2025-11-02"]);
  // 不带第三个参数：有请求的一律不删（和以前一样）
  await repository.requestResettle(rule.id, ["2025-11-04"], { now: 1 });
  assert.equal(await repository.pruneSettlementStates("2025-12-01", 500), 0);
});

contract("createRule: a new binding that takes the same channel (or Key) on the day an earlier New API binding was archived starts at that moment, not at 0:00; Sub2API, other channels and other days are not affected", async ({ repository, fixture }) => {
  const old = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:floor`, billingPolicy: "immediate", timezone: "UTC", channels: [{ channelId: fixture.channel(1), name: "A" }] });
  const other = await fixture.createRule({ tokenId: fixture.token(8), canonicalKey: `up:${fixture.tag}:floor-other`, billingPolicy: "immediate", timezone: "UTC", channels: [{ channelId: fixture.channel(8), name: "Z" }] });
  const sub2 = await fixture.createRule({ tokenId: fixture.token(9), canonicalKey: `up:${fixture.tag}:floor-sub2`, billingPolicy: "immediate", timezone: "UTC", provider: "sub2api", channels: [{ channelId: fixture.channel(9), name: "S" }] });
  const at = Date.now() - 60000; // 解除在一分钟前：新绑定（现在建）和它在同一天，除非正好跨过 0 点
  for (const rule of [old, other, sub2]) assert.equal(await repository.archiveRule(rule.id, { now: at }), true);
  const dayStart = Math.floor(Date.now() / 86400000) * 86400000;
  if (at < dayStart) return; // 刚好跨过 UTC 0 点，这一轮不测
  const sameChannel = await fixture.createRule({ tokenId: fixture.token(2), billingPolicy: "immediate", timezone: "UTC", channels: [{ channelId: fixture.channel(1), name: "A" }] });
  assert.equal(sameChannel.accountingFloorMs, at, "同一个渠道：从解除那一刻起算");
  const sameKey = await fixture.createRule({ tokenId: fixture.token(3), canonicalKey: `up:${fixture.tag}:floor`, billingPolicy: "immediate", timezone: "UTC", channels: [{ channelId: fixture.channel(3), name: "C" }] });
  assert.equal(sameKey.accountingFloorMs, at, "同一把 Key");
  const unrelated = await fixture.createRule({ tokenId: fixture.token(4), billingPolicy: "immediate", timezone: "UTC", channels: [{ channelId: fixture.channel(4), name: "D" }] });
  assert.equal(unrelated.accountingFloorMs, null, "别的渠道、别的 Key 不受影响");
  const afterSub2 = await fixture.createRule({ tokenId: fixture.token(5), billingPolicy: "immediate", timezone: "UTC", channels: [{ channelId: fixture.channel(9), name: "S" }] });
  assert.equal(afterSub2.accountingFloorMs, null, "旧的是 Sub2API：解除当天整天不算，新绑定照 0 点");
  // 新绑定是 Sub2API、旧的是 New API：下限照给（收入按秒切，上游成本取这把 Key 全天的，见 accountingUpstreamWindow）
  const oldNewApi = await fixture.createRule({ tokenId: fixture.token(10), canonicalKey: `up:${fixture.tag}:floor-n`, billingPolicy: "immediate", timezone: "UTC", channels: [{ channelId: fixture.channel(10), name: "N" }] });
  assert.equal(await repository.archiveRule(oldNewApi.id, { now: at }), true);
  const toSub2 = await fixture.createRule({ tokenId: fixture.token(6), billingPolicy: "immediate", timezone: "UTC", provider: "sub2api", channels: [{ channelId: fixture.channel(10), name: "N" }] });
  assert.equal(toSub2.accountingFloorMs, at, "新绑定是 Sub2API：也从旧绑定解除那一刻起算收入");
});

contract("segment keys (K1c): every segment has its Key row, filled from the rule; a new segment gets one; active_token_key follows the open segment of an enabled rule; the keys are not enumerable (results stay byte-identical)", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:sk`, billingPolicy: "immediate", timezone: "UTC" });
  const keyOf = (segment) => segment.keys.map((key) => [key.upstreamStationId, key.tokenId, key.tokenName, key.matchSource, key.active]);
  let segments = await repository.listSegments(rule.id);
  assert.equal(segments.length, 1);
  assert.deepEqual(keyOf(segments[0]), [[rule.upstreamStationId, rule.tokenId, rule.tokenName, "initial", true]]);
  assert.equal(Object.keys(segments[0]).includes("keys"), false, "不进 JSON、不进深比较");
  assert.equal(JSON.stringify(segments).includes("tokenId"), false);
  // 倍率变化开新段：新段有自己的 Key 行，旧段的不再是在用的
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: rule.tokenName, detectedAt: Date.now() - 1000 });
  segments = await repository.listSegments(rule.id);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((segment) => keyOf(segment).map((key) => key[4])), [[false], [true]]);
  // 改绑定的 Key：来源是 initial 的行都跟着走（旧代码整条绑定的历史都按现在这把取）
  await repository.updateRule(rule.id, { tokenName: "Renamed" });
  segments = await repository.listSegments(rule.id);
  assert.deepEqual(segments.map((segment) => segment.keys[0].tokenName), ["Renamed", "Renamed"]);
  // 解除：没有在用的了
  assert.equal(await repository.archiveRule(rule.id), true);
  segments = await repository.listSegments(rule.id);
  assert.deepEqual(segments.map((segment) => segment.keys[0].active), [false, false]);
});

contract("segment keys (K1c)：一段有不止一把 Key 时（K2b 开始写才会真的发生，这版用后门造），listSegments 的 JOIN 把同一段的几行折叠进一个 segment.keys 数组，不会把段拆成几份、也不会漏掉哪一把", async ({ repository, fixture, insertKey }) => {
  assert.ok(insertKey, "运行方要提供 insertSegmentKeyRow");
  const rule = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:sk-multi`, billingPolicy: "immediate", timezone: "UTC" });
  const [segment] = await repository.listSegments(rule.id);
  assert.equal(segment.keys.length, 1, "造之前只有 rules 上那一把");
  const extraStationId = fixture.station("up-extra"), extraTokenId = fixture.token(77);
  await insertKey({ segmentId: segment.id, upstreamStationId: extraStationId, tokenId: extraTokenId, tokenName: "Extra" });
  const segments = await repository.listSegments(rule.id);
  assert.equal(segments.length, 1, "多了一把 Key 的行，段数不变，不会把一段拆成两段");
  const keys = segments[0].keys.map((key) => [key.upstreamStationId, key.tokenId, key.tokenName]).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(keys, [[rule.upstreamStationId, rule.tokenId, rule.tokenName], [extraStationId, extraTokenId, "Extra"]].sort((a, b) => a[1] - b[1]),
    "两把都在同一段的 keys 里，不多不少");
});

// K2b：正常换 Key（没有冲突）时真正开段的那条路（server/key-agent-resegment.js 的计划 → 这里落库）。
// 同一个事务关旧段、开新段、写 segment_keys、改 rules 的 token_id/token_name/active_token_key；
// 真正兜底的是数据库的两道唯一约束，撞了整批回滚、返回 { conflict: true }，不靠应用层的预检查当唯一防线。
contract("applyKeyChangePlans: a windowed plan closes the old segment, opens a closed transitional multi-key segment and an open single-key segment; rules.token_id/token_name follow the open segment's key", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(30), name: "Windowed" }] });
  const oldRef = { upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId, tokenName: rule.tokenName };
  const newToken = fixture.token(31);
  const newRef = { upstreamStationId: rule.upstreamStationId, tokenId: newToken, tokenName: "New Key" };
  const windowStart = EFFECTIVE_FROM + HOUR, windowEnd = windowStart + 2 * 60 * 1000;
  const result = await repository.applyKeyChangePlans([
    { ruleId: rule.id, plan: { kind: "windowed", windowStart, windowEnd, windowKeys: [oldRef, newRef], after: [newRef] } },
  ]);
  assert.deepEqual(result, { conflict: false });
  const segments = await repository.listSegments(rule.id);
  assert.equal(segments.length, 3, "原段关掉 + 过渡段（已关）+ 新段（开着）");
  assert.equal(segments[0].effectiveTo, windowStart);
  assert.deepEqual(segments[0].keys.map((key) => key.tokenId), [rule.tokenId],
    "原段（已经关了的历史段）还是原来那把 Key，不会被换 Key 以后的 rules.token_id 带着一起变");
  const transitional = segments[1], open = segments[2];
  assert.equal(transitional.effectiveFrom, windowStart);
  assert.equal(transitional.effectiveTo, windowEnd);
  assert.deepEqual(transitional.keys.map((key) => [key.tokenId, key.active]).sort((a, b) => a[0] - b[0]),
    [[rule.tokenId, false], [newToken, false]].sort((a, b) => a[0] - b[0]), "过渡段两把 Key 都有，但段已经关了，都不是在用的");
  assert.equal(open.effectiveFrom, windowEnd);
  assert.equal(open.effectiveTo, null);
  assert.deepEqual(open.keys.map((key) => [key.tokenId, key.active]), [[newToken, true]]);
  const after = await repository.getRule(rule.id);
  assert.equal(after.tokenId, newToken);
  assert.equal(after.tokenName, "New Key");
});

contract("applyKeyChangePlans: segments opened for a key change carry timing_source key_change_window / key_change (not detected); plan.group/ratio give the new segment the new key's group and ratio while the transitional segment keeps the old; rules.fixed_group follows", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(60), name: "Grp" }], initialRatio: 1 });
  const oldRef = { upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId, tokenName: rule.tokenName };
  const newRef = { upstreamStationId: rule.upstreamStationId, tokenId: fixture.token(61), tokenName: "New" };
  const windowStart = EFFECTIVE_FROM + HOUR, windowEnd = windowStart + 5 * 60 * 1000;
  await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: { kind: "windowed", windowStart, windowEnd, windowKeys: [oldRef, newRef], after: [newRef], group: "vip", ratio: 1.5 } }]);
  const segments = await repository.listSegments(rule.id);
  assert.deepEqual(segments.map((segment) => segment.timingSource).slice(1), ["key_change_window", "key_change"], "不是 detected：不出「倍率变化的时间是系统估的」，也不能改时间");
  assert.deepEqual([segments[1].group, segments[1].ratio], [segments[0].group, segments[0].ratio], "过渡段还是旧的分组、倍率");
  assert.deepEqual([segments[2].group, segments[2].ratio], ["vip", 1.5], "新段按新 Key 的分组、倍率");
  assert.equal((await repository.getRule(rule.id)).fixedGroup, "vip");
  // 不给 group：新段沿用旧段的
  const other = await fixture.createRule({ tokenId: fixture.token(62), channels: [{ channelId: fixture.channel(62), name: "NoGrp" }], initialRatio: 2 });
  await repository.applyKeyChangePlans([{ ruleId: other.id, plan: { kind: "precise", cutoverAt: EFFECTIVE_FROM + HOUR, after: [{ upstreamStationId: other.upstreamStationId, tokenId: fixture.token(63), tokenName: "N2" }] } }]);
  const [first, second] = await repository.listSegments(other.id);
  assert.deepEqual([second.timingSource, second.group, second.ratio], ["key_change", first.group, first.ratio]);
});

contract("applyKeyChangePlans: swapping keys between two rules in one batch — clear-then-write means the swap itself never trips the unique constraint", async ({ repository, fixture }) => {
  const a = await fixture.createRule({ channels: [{ channelId: fixture.channel(32), name: "A" }] });
  const b = await fixture.createRule({ tokenId: fixture.token(33), tokenName: `Contract ${fixture.tag} B`, channels: [{ channelId: fixture.channel(34), name: "B" }] });
  const refOf = (r) => ({ upstreamStationId: r.upstreamStationId, tokenId: r.tokenId, tokenName: r.tokenName });
  const cutoverAt = EFFECTIVE_FROM + HOUR;
  const result = await repository.applyKeyChangePlans([
    { ruleId: a.id, plan: { kind: "moved", cutoverAt, after: [refOf(b)] } },
    { ruleId: b.id, plan: { kind: "moved", cutoverAt, after: [refOf(a)] } },
  ]);
  assert.deepEqual(result, { conflict: false });
  assert.equal((await repository.getRule(a.id)).tokenId, b.tokenId);
  assert.equal((await repository.getRule(b.id)).tokenId, a.tokenId);
  const [, openA] = await repository.listSegments(a.id);
  const [, openB] = await repository.listSegments(b.id);
  assert.deepEqual(openA.keys.map((key) => key.tokenId), [b.tokenId]);
  assert.deepEqual(openB.keys.map((key) => key.tokenId), [a.tokenId]);
});

contract("applyKeyChangePlans: writing a key another rule still actively holds rolls the whole batch back and returns conflict, untouched by the DB's unique constraint as the real backstop", async ({ repository, fixture }) => {
  const taken = await fixture.createRule({ tokenId: fixture.token(35), channels: [{ channelId: fixture.channel(35), name: "Taken" }] });
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(36), name: "Collide" }] });
  const before = await repository.getRule(rule.id);
  const beforeSegments = await repository.listSegments(rule.id);
  const collideRef = { upstreamStationId: taken.upstreamStationId, tokenId: taken.tokenId, tokenName: taken.tokenName };
  const result = await repository.applyKeyChangePlans([
    { ruleId: rule.id, plan: { kind: "precise", cutoverAt: EFFECTIVE_FROM + HOUR, after: [collideRef] } },
  ]);
  assert.deepEqual(result, { conflict: true });
  assert.deepEqual(await repository.getRule(rule.id), before, "回滚，rules 那几列原样");
  assert.deepEqual(await repository.listSegments(rule.id), beforeSegments, "回滚，段原样");
  assert.equal((await repository.getRule(taken.id)).tokenId, taken.tokenId, "没参与这批的那条绑定没被动");
});

contract("applyKeyChangePlans: an open multi-key segment gets active_token_key on every key, not just the first — a collision on the second key is still caught", async ({ repository, fixture }) => {
  const taken = await fixture.createRule({ tokenId: fixture.token(37), channels: [{ channelId: fixture.channel(37), name: "Taken" }] });
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(38), name: "Multi" }] });
  const freshA = { upstreamStationId: rule.upstreamStationId, tokenId: fixture.token(39), tokenName: "Fresh A" };
  const freshB = { upstreamStationId: rule.upstreamStationId, tokenId: fixture.token(40), tokenName: "Fresh B" };
  const ok = await repository.applyKeyChangePlans([
    { ruleId: rule.id, plan: { kind: "precise", cutoverAt: EFFECTIVE_FROM + HOUR, after: [freshA, freshB] } },
  ]);
  assert.deepEqual(ok, { conflict: false }, "两把都没人占着，都能开出来");
  const [, open] = await repository.listSegments(rule.id);
  assert.deepEqual(open.keys.map((key) => key.active).sort(), [true, true], "开着的段，两把 Key 都标在用——不是只有第一把");
  const collideRef = { upstreamStationId: taken.upstreamStationId, tokenId: taken.tokenId, tokenName: taken.tokenName };
  const freshC = { upstreamStationId: rule.upstreamStationId, tokenId: fixture.token(41), tokenName: "Fresh C" };
  const result = await repository.applyKeyChangePlans([
    { ruleId: rule.id, plan: { kind: "precise", cutoverAt: EFFECTIVE_FROM + 2 * HOUR, after: [freshC, collideRef] } },
  ]);
  assert.deepEqual(result, { conflict: true }, "rules.active_token_key 这一把（fresh C）没人占，但 segment_keys 里撞车的那把（collideRef）还是拦住了");
});

contract("applyKeyChangePlans: plan.canonicalKey given updates rules.canonical_key in lockstep with token_id (otherwise the next settle sees a stale anchor and SOURCE_BINDING_UNCONFIRMED blocks it); omitted leaves canonical_key untouched", async ({ repository, fixture }) => {
  const anchored = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:akp-canon`, channels: [{ channelId: fixture.channel(42), name: "Anchored" }] });
  const newToken = fixture.token(43);
  const newCanonicalKey = `up:${fixture.tag}:akp-canon-new`;
  await repository.applyKeyChangePlans([
    { ruleId: anchored.id, plan: { kind: "precise", cutoverAt: EFFECTIVE_FROM + HOUR, canonicalKey: newCanonicalKey,
      after: [{ upstreamStationId: anchored.upstreamStationId, tokenId: newToken, tokenName: "New" }] } },
  ]);
  const after = await repository.getRule(anchored.id);
  assert.equal(after.tokenId, newToken);
  assert.equal(after.canonicalKey, newCanonicalKey, "canonicalKey 跟着 tokenId 一起换，不然锚定对不上");

  const untouched = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:akp-canon-keep`, channels: [{ channelId: fixture.channel(44), name: "Untouched" }] });
  await repository.applyKeyChangePlans([
    { ruleId: untouched.id, plan: { kind: "precise", cutoverAt: EFFECTIVE_FROM + HOUR,
      after: [{ upstreamStationId: untouched.upstreamStationId, tokenId: fixture.token(45), tokenName: "New2" }] } },
  ]);
  assert.equal((await repository.getRule(untouched.id)).canonicalKey, `up:${fixture.tag}:akp-canon-keep`, "没传 canonicalKey 就不动原来的（给不关心锚定的调用方用）");
});

// refreshSegmentKeys 会把这条绑定所有 initial 行改成 rules 现在的 Key、非 initial 的行完全不碰——K2b 写过段以后，
// 别处再调一次（倍率变化开新段、改绑定、解除……）历史就被改掉，或者上一段的 agent 行还占着唯一键。守住：关掉的段 Key 行不再变、不再占唯一键
contract("after applyKeyChangePlans, every path that refreshes segment keys (ratio change, updateRule, archiveRule) leaves closed segments' keys unchanged and releases the unique keys", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(50), name: "Hist" }], tokenName: "Old Key" });
  const newToken = fixture.token(51);
  const newRef = { upstreamStationId: rule.upstreamStationId, tokenId: newToken, tokenName: "New Key" };
  const oldRef = { upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId, tokenName: "Old Key" };
  const windowStart = EFFECTIVE_FROM + HOUR, windowEnd = windowStart + 2 * 60 * 1000;
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: { kind: "windowed", windowStart, windowEnd, windowKeys: [oldRef, newRef], after: [newRef] } }]), { conflict: false });
  const shape = async () => (await repository.listSegments(rule.id)).map((segment) => ({ to: segment.effectiveTo, keys: segment.keys.map((key) => [key.tokenId, key.tokenName, key.matchSource, key.active]).sort((a, b) => a[0] - b[0]) }));
  const before = await shape();
  assert.equal(before.length, 3);
  const historyOf = (list) => list.slice(0, 2); // 原段（旧 Key）和过渡段（两把）：已经关掉的

  // 倍率变化开新段：上一段（K2b 写的 agent 行）不能还占着唯一键，新段才写得进去；历史段不变
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: "New Key", detectedAt: Date.now() - 1000 });
  let after = await shape();
  assert.equal(after.length, 4);
  assert.deepEqual(historyOf(after), historyOf(before), "倍率变化以后历史段的 Key 行不变");
  assert.deepEqual(after[2].keys.map((key) => key[3]), [false], "上一段（已经关掉）的 agent 行不再占唯一键");
  assert.deepEqual(after[3].keys.map((key) => [key[0], key[3]]), [[newToken, true]], "新开的段拿的是现在这把，占着唯一键");

  // 改绑定（这里只改名字）：initial 的行本来会整条历史一起改，K2b 以后关掉的段不跟着 rules 走
  await repository.updateRule(rule.id, { tokenName: "Renamed" });
  after = await shape();
  assert.deepEqual(historyOf(after), historyOf(before), "改绑定以后历史段的 Key 行不变（原段还是 Old Key，不是 Renamed）");
  assert.equal(after[3].keys[0][1], "Renamed", "开着的那段仍然跟着 rules");

  // 解除：所有 Key 行都不再占唯一键；别的绑定马上可以用这把 Key
  assert.equal(await repository.archiveRule(rule.id), true);
  after = await shape();
  assert.deepEqual(after.flatMap((segment) => segment.keys.map((key) => key[3])).filter(Boolean), [], "解除以后没有一行还占着唯一键");
  assert.deepEqual(historyOf(after), historyOf(before).map((segment) => ({ ...segment, keys: segment.keys.map(([id, name, source]) => [id, name, source, false]) })), "历史段的 Key 行还是原样");
  const taker = await fixture.createRule({ tokenId: newToken, channels: [{ channelId: fixture.channel(52), name: "Taker" }] });
  assert.equal(taker.tokenId, newToken, "解除以后别的绑定可以用这把 Key（agent 行没有留着占唯一键）");
});

contract("listSettlementStates with billDates only returns those days", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const now = Date.UTC(2026, 0, 12, 3);
  await repository.requestResettle(rule.id, ["2025-10-01", "2025-10-02", "2025-10-03"], { now, manualReason: "RESETTLE_TOO_OLD" });
  assert.deepEqual((await repository.listSettlementStates([rule.id], { billDates: ["2025-10-02"] })).map((row) => row.billDate), ["2025-10-02"]);
  assert.deepEqual(await repository.listSettlementStates([rule.id], { billDates: [] }), []);
  assert.equal((await repository.listSettlementStates([rule.id])).length, 3, "不给日期读全部");
});

contract("archiveRule writes the archive time in milliseconds; listRecentlyArchivedRules returns only anchored rules archived since the given time", async ({ repository, fixture }) => {
  const anchored = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:anchored` });
  const plain = await fixture.createRule({ tokenId: fixture.token(7), channels: [{ channelId: fixture.channel(7), name: "other" }] });
  const at = Date.UTC(2026, 0, 12, 6, 30);
  assert.equal(await repository.archiveRule(anchored.id, { now: at }), true);
  assert.equal(await repository.archiveRule(plain.id, { now: at }), true);
  assert.equal((await repository.getRule(anchored.id, { includeArchived: true })).archivedAtMs, at);
  assert.equal(await repository.getRule(anchored.id), null);
  const recent = (await repository.listRecentlyArchivedRules(at - 1)).filter((rule) => [anchored.id, plain.id].includes(rule.id));
  assert.deepEqual(recent.map((rule) => [rule.id, rule.archivedAtMs]), [[anchored.id, at]], "没锚定过的（没有 canonicalKey）不回看");
  assert.equal(recent[0].channels.length, 1, "带着渠道");
  assert.deepEqual((await repository.listRecentlyArchivedRules(at + 1)).filter((rule) => rule.id === anchored.id), [], "解除得更早的不返回");
});

contract("saveSnapshotsForScope on an archived rule: only with archived: true, only a ledger entry whose day starts before the archive time", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:anchored2` });
  const [segment] = await repository.listSegments(rule.id);
  const fingerprint = await fixture.fingerprint(rule.id);
  const at = Date.UTC(2026, 0, 12, 6, 30);
  const day = (n) => ({ preset: "custom", startMs: Date.UTC(2026, 0, n), endMs: Date.UTC(2026, 0, n + 1), timezone: "UTC" });
  const entryFor = (n) => {
    const snapshot = billingSnapshot({ rule, segment, fingerprint, window: day(n), generatedAt: `2026-01-${String(n + 1).padStart(2, "0")}T00:20:00.000Z`, profitUsd: 2 });
    return { snapshot, ledger: settlement(snapshot) };
  };
  assert.equal(await repository.archiveRule(rule.id, { now: at }), true);
  const archivedFingerprint = await fixture.fingerprint(rule.id, { includeArchived: true });
  const before = entryFor(11), onArchiveDay = entryFor(12), after = entryFor(13);
  // 不说 archived: true：照旧写不进去
  assert.equal(await repository.saveSnapshotsForScope(rule.id, archivedFingerprint, [], { ledger: before.ledger, archived: false }), false);
  // 解除前的日子、解除当天（开始早于解除时刻）：写得进账本
  assert.equal(await repository.saveSnapshotsForScope(rule.id, archivedFingerprint, [], { ledger: before.ledger, archived: true }), true);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, archivedFingerprint, [], { ledger: onArchiveDay.ledger, archived: true }), true);
  // 解除以后才开始的日子、不带账本的：不写
  assert.equal(await repository.saveSnapshotsForScope(rule.id, archivedFingerprint, [], { ledger: after.ledger, archived: true }), false);
  assert.equal(await repository.saveSnapshotsForScope(rule.id, archivedFingerprint, [before.snapshot], { archived: true }), false, "只许记账本");
  assert.deepEqual((await repository.listLedgerDays([rule.id], "2026-01-01")).map((row) => row.billDate).sort(), ["2026-01-11", "2026-01-12"]);
});

contract("pruneSettlementStates never drops RESETTLE_TOO_OLD or RESETTLE_SHRUNK rows (waiting for a person), however old; they go once handled", async ({ repository, fixture }) => {
  const rule = await fixture.createRule();
  const now = Date.UTC(2026, 0, 12, 3);
  await repository.requestResettle(rule.id, ["2025-10-01"], { now: now - 60 * DAY, manualReason: "RESETTLE_TOO_OLD" });
  await repository.requestResettle(rule.id, ["2025-10-02"], { now: now - 60 * DAY });
  const shrunk = { op: "sticky", reason: "RESETTLE_SHRUNK", attempts: 0, manualSince: now - 59 * DAY, nextAttemptAt: null, firstFailedAt: now - 60 * DAY, lastAttemptAt: now - 59 * DAY, sourceVersion: null, detail: { code: "RESETTLE_SHRUNK", side: "revenue" } };
  await repository.recordSettlementState(rule.id, "2025-10-02", shrunk, now - 59 * DAY, { requestedAt: now - 60 * DAY });
  await repository.requestResettle(rule.id, ["2025-10-03"], { now: now - 60 * DAY });
  assert.equal(await repository.pruneSettlementStates("2025-12-01", 500, now - 31 * DAY), 1, "只删放弃了的普通请求");
  assert.deepEqual((await repository.listSettlementStates([rule.id])).map((row) => [row.billDate, row.manualReason]), [["2025-10-01", "RESETTLE_TOO_OLD"], ["2025-10-02", "RESETTLE_SHRUNK"]]);
});

contract("correctTransition writes a resettle request for every ended business day between the old and the new time, in the rule's own time zone (DST days included), none before the rule started", async ({ repository, fixture, backdate }) => {
  const rule = await fixture.createRule({ timezone: "America/New_York", initialRatio: 1 });
  assert.ok(backdate, "运行方要提供 backdateRule");
  await backdate(rule.id, Date.UTC(2026, 0, 1));
  const t1 = Date.UTC(2026, 2, 9, 12), t2 = Date.UTC(2026, 2, 12, 12);
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: "VIP", detectedAt: t1 });
  const { segments } = await repository.observeSource(rule.id, { groups: {}, group: "pro", ratio: 3, tokenName: "Pro", detectedAt: t2 });
  const middle = segments[1];
  const dates = async () => (await repository.listSettlementStates([rule.id])).filter((row) => row.resettleRequestedAt != null).map((row) => [row.billDate, row.resettleReason]);
  // 纽约 3 月 8 日夏令时开始，那一天只有 23 小时：从 3/9 12:00Z 提前到 3/7 12:00Z，纽约是 3/7 07:00 到 3/9 08:00，落到 3 月 7、8、9 三天
  const now = Date.now();
  await repository.correctTransition(rule.id, middle.id, Date.UTC(2026, 2, 7, 12), { now });
  assert.deepEqual(await dates(), [["2026-03-07", "transition"], ["2026-03-08", "transition"], ["2026-03-09", "transition"]]);
  assert.deepEqual((await repository.listSegments(rule.id))[1].effectiveFrom, Date.UTC(2026, 2, 7, 12));
  // 再往后改（旧时间到新时间）：落到的日子是 3/7 到 3/10 之间的，请求时刻比原来的大
  const before = (await repository.listSettlementStates([rule.id])).find((row) => row.billDate === "2026-03-09").resettleRequestedAt;
  await repository.correctTransition(rule.id, middle.id, Date.UTC(2026, 2, 10, 12), { now });
  const rows = await repository.listSettlementStates([rule.id]);
  assert.deepEqual(rows.filter((row) => row.resettleRequestedAt != null).map((row) => row.billDate), ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
  assert.ok(rows.find((row) => row.billDate === "2026-03-09").resettleRequestedAt > before);
  // 整天在绑定开始统计之前的日子不写：建立时刻改到 3/9 以后，再改回去，3/7、3/8 不会有新的请求，3/9 起的有
  const other = await fixture.createRule({ timezone: "America/New_York", initialRatio: 1, tokenId: fixture.token(3), channels: [{ channelId: fixture.channel(3), name: "late" }] });
  await backdate(other.id, Date.UTC(2026, 2, 9, 12));
  await repository.observeSource(other.id, { groups: {}, group: "vip", ratio: 2, tokenName: "VIP", detectedAt: t1 });
  const { segments: otherSegments } = await repository.observeSource(other.id, { groups: {}, group: "pro", ratio: 3, tokenName: "Pro", detectedAt: t2 });
  await repository.correctTransition(other.id, otherSegments[1].id, Date.UTC(2026, 2, 7, 12), { now });
  assert.deepEqual((await repository.listSettlementStates([other.id])).map((row) => row.billDate), ["2026-03-09"], "3/7、3/8 整天在开始统计之前");
});

contract("correctTransition: archived or unknown rule is RULE_NOT_FOUND and nothing changes; a future or non-integer time is out of range", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ initialRatio: 1 });
  const t1 = EFFECTIVE_FROM + 10 * HOUR;
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: "VIP", detectedAt: t1 });
  const { segments } = await repository.observeSource(rule.id, { groups: {}, group: "pro", ratio: 3, tokenName: "Pro", detectedAt: t1 + 10 * HOUR });
  const middle = segments[1];
  await assert.rejects(repository.correctTransition(rule.id, middle.id, t1 + 0.5), outOfRange, "不是整毫秒");
  await assert.rejects(repository.correctTransition(rule.id, middle.id, Date.now() + HOUR, { now: Date.now() }), { code: "TRANSITION_TIME_IN_FUTURE", message: "不能改到以后的时间" }, "改到未来有自己的码和话");
  await assert.rejects(repository.correctTransition(`rr_missing${fixture.tag}`, middle.id, t1 - HOUR), notFound);
  assert.equal(await repository.archiveRule(rule.id), true);
  await assert.rejects(repository.correctTransition(rule.id, middle.id, t1 - HOUR), notFound, "已解除的绑定不改分段");
  assert.deepEqual((await repository.listSegments(rule.id)).map((segment) => segment.effectiveFrom), segments.map((segment) => segment.effectiveFrom));
  assert.deepEqual(await repository.listSettlementStates([rule.id]), []);
});

contract("correctTransition changes the segments and writes the resettle requests in one transaction: a failing request write rolls the segments back too", async ({ repository, fixture, backdate, failRequests }) => {
  assert.ok(backdate && failRequests, "运行方要提供 backdateRule、failRequestWrites");
  const rule = await fixture.createRule({ timezone: "UTC", initialRatio: 1 });
  await backdate(rule.id, Date.UTC(2026, 0, 1));
  const t1 = Date.UTC(2026, 2, 9, 12), t2 = Date.UTC(2026, 2, 12, 12);
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: "VIP", detectedAt: t1 });
  const { segments } = await repository.observeSource(rule.id, { groups: {}, group: "pro", ratio: 3, tokenName: "Pro", detectedAt: t2 });
  const restore = failRequests();
  try {
    await assert.rejects(repository.correctTransition(rule.id, segments[1].id, Date.UTC(2026, 2, 7, 12), { now: Date.now() }), /request write failed/);
  } finally { restore(); }
  assert.deepEqual((await repository.listSegments(rule.id)).map((segment) => [segment.effectiveFrom, segment.effectiveTo]), segments.map((segment) => [segment.effectiveFrom, segment.effectiveTo]), "分段没动");
  assert.deepEqual(await repository.listSettlementStates([rule.id]), [], "也没有留下请求");
  // 恢复以后同样的改动成功，请求和分段一起生效
  await repository.correctTransition(rule.id, segments[1].id, Date.UTC(2026, 2, 7, 12), { now: Date.now() });
  assert.equal((await repository.listSegments(rule.id))[1].effectiveFrom, Date.UTC(2026, 2, 7, 12));
  assert.ok((await repository.listSettlementStates([rule.id])).length >= 3);
});

contract("correctTransition: days older than 31 days get an attention row (RESETTLE_TOO_OLD) that still carries the request; days inside 31 days get a plain request", async ({ repository, fixture, backdate }) => {
  const rule = await fixture.createRule({ timezone: "UTC", initialRatio: 1 });
  await backdate(rule.id, Date.UTC(2025, 0, 1));
  const now = Date.UTC(2026, 9, 9, 3);
  const t1 = Date.UTC(2026, 8, 20, 4), t2 = Date.UTC(2026, 8, 25, 4); // 19 天前、14 天前
  await repository.observeSource(rule.id, { groups: {}, group: "vip", ratio: 2, tokenName: "VIP", detectedAt: t1 });
  const { segments } = await repository.observeSource(rule.id, { groups: {}, group: "pro", ratio: 3, tokenName: "Pro", detectedAt: t2 });
  await repository.correctTransition(rule.id, segments[1].id, Date.UTC(2026, 7, 30, 4), { now }); // 40 天前
  const rows = await repository.listSettlementStates([rule.id]);
  const tooOld = rows.filter((row) => row.manualReason === "RESETTLE_TOO_OLD");
  const plain = rows.filter((row) => row.manualReason == null);
  assert.deepEqual([tooOld[0].billDate, tooOld.at(-1).billDate], ["2026-08-30", "2026-09-07"]);
  assert.deepEqual([plain[0].billDate, plain.at(-1).billDate], ["2026-09-08", "2026-09-20"]);
  assert.ok(rows.every((row) => row.resettleRequestedAt === now && row.resettleReason === "transition"));
  assert.deepEqual([tooOld[0].manualSince, tooOld[0].nextAttemptAt, tooOld[0].detail], [now, null, { code: "RESETTLE_TOO_OLD", side: null }]);
  assert.equal(plain[0].detail, null);
});

contract("applyKeyChangePlans: preconditions — replaying the same plan, a cutover before the open segment's start, an inverted window all write nothing and return stale (no inverted or duplicate segments; a cutover exactly at the open segment's start stays allowed and leaves a zero-length old segment, ordered before the open one)", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(66), name: "Pre" }], initialRatio: 1 });
  const oldRef = { upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId, tokenName: rule.tokenName };
  const newRef = { upstreamStationId: rule.upstreamStationId, tokenId: fixture.token(67), tokenName: "Pre2" };
  const windowStart = EFFECTIVE_FROM + HOUR, windowEnd = windowStart + 2 * 60 * 1000;
  const windowed = { kind: "windowed", windowStart, windowEnd, windowKeys: [oldRef, newRef], before: [oldRef], after: [newRef] };
  const snapshot = async () => JSON.stringify([await repository.listSegments(rule.id), (await repository.getRule(rule.id)).tokenId]);
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: windowed }]), { conflict: false });
  const applied = await snapshot();
  // 同一份计划再应用一次（页面刷新和轮询各算了一份）：规则现在的 Key 已经不是计划的「换之前」
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: windowed }]), { conflict: false, stale: true });
  assert.equal(await snapshot(), applied, "重放什么也没写：没有倒挂段、没有重复的过渡段");
  // 切点早于开着那段（现在是 windowEnd 起的新段）的起点：不写
  const back = { kind: "precise", cutoverAt: windowEnd - 1000, before: [newRef], after: [oldRef] };
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: back }]), { conflict: false, stale: true });
  // 窗口倒挂（a 晚于 b）：不写
  const inverted = { kind: "windowed", windowStart: windowEnd + 5000, windowEnd: windowEnd + 1000, windowKeys: [newRef, oldRef], before: [newRef], after: [oldRef] };
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: inverted }]), { conflict: false, stale: true });
  assert.equal(await snapshot(), applied);
  // 前置条件满足的还是能写（换回去）
  const ok = { kind: "precise", cutoverAt: windowEnd + 60000, before: [newRef], after: [oldRef] };
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: ok }]), { conflict: false });
  assert.equal((await repository.getRule(rule.id)).tokenId, rule.tokenId);
  // 一批里只要有一条不成立，整批都不写（互换的一组要同生同死）
  const other = await fixture.createRule({ tokenId: fixture.token(68), tokenName: `Contract ${fixture.tag} Pre-B`, channels: [{ channelId: fixture.channel(69), name: "PreB" }] });
  const before = JSON.stringify([await repository.listSegments(rule.id), await repository.listSegments(other.id)]);
  const stalePlan = { kind: "precise", cutoverAt: EFFECTIVE_FROM - 1, before: [{ upstreamStationId: other.upstreamStationId, tokenId: other.tokenId }], after: [{ upstreamStationId: other.upstreamStationId, tokenId: fixture.token(70), tokenName: "x" }] };
  const goodPlan = { kind: "precise", cutoverAt: windowEnd + 120000, before: [oldRef], after: [newRef] };
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: goodPlan }, { ruleId: other.id, plan: stalePlan }]), { conflict: false, stale: true });
  assert.equal(JSON.stringify([await repository.listSegments(rule.id), await repository.listSegments(other.id)]), before, "整批都不写");
});


contract("applyKeyChangePlans: the unique key it writes is canonicalKey (same form as createRule), so another binding with that canonicalKey is rejected; a disabled binding releases the key rows' unique slot and re-enabling takes it back", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:old`, billingPolicy: "immediate", timezone: "UTC", channels: [{ channelId: fixture.channel(71), name: "Act" }], initialRatio: 1 });
  const newRef = { upstreamStationId: rule.upstreamStationId, tokenId: fixture.token(72), tokenName: "Act2" };
  const canonical = `up:${fixture.tag}:new`;
  await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: { kind: "precise", cutoverAt: EFFECTIVE_FROM + HOUR, before: [{ upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId }], after: [newRef], canonicalKey: canonical } }]);
  assert.equal((await repository.getRule(rule.id)).canonicalKey, canonical);
  // rules.active_token_key 是 canonical 值（不是旧写法「上游:Key」）：另一条绑定带着同一个 canonicalKey 建，撞唯一键
  await assert.rejects(fixture.createRule({ tokenId: fixture.token(73), canonicalKey: canonical, ownStationId: fixture.station("own-other"), channels: [{ channelId: fixture.channel(73), name: "Dup" }] }),
    { code: "ER_DUP_ENTRY", errno: 1062 });
  const openKeys = async () => (await repository.listSegments(rule.id)).find((segment) => segment.effectiveTo == null).keys.map((key) => key.active);
  assert.deepEqual(await openKeys(), [true], "开着那段的 Key 行占着唯一键");
  // 停用：不占唯一键（别的绑定可以用这把 Key）；重新启用：agent 写的 Key 行占回来
  await repository.updateRule(rule.id, { enabled: false });
  assert.deepEqual(await openKeys(), [false], "停用以后释放");
  const taker = await fixture.createRule({ tokenId: fixture.token(74), canonicalKey: canonical, ownStationId: fixture.station("own-taker"), channels: [{ channelId: fixture.channel(74), name: "Taker" }] });
  assert.ok(taker.id, "停用期间别的绑定可以占这把 Key");
  assert.equal(await repository.archiveRule(taker.id), true);
  await repository.updateRule(rule.id, { enabled: true });
  assert.deepEqual(await openKeys(), [true], "重新启用以后 agent 行占回唯一键");
  await assert.rejects(fixture.createRule({ tokenId: fixture.token(75), canonicalKey: canonical, ownStationId: fixture.station("own-late"), channels: [{ channelId: fixture.channel(75), name: "Late" }] }),
    { code: "ER_DUP_ENTRY", errno: 1062 });
});

contract("channel optout (K2c): archiveRule({ optout: true }) records the rule's channels as user-stopped in the same transaction; plain archive records nothing; removeChannelOptouts deletes only the given channels; re-stopping is idempotent", async ({ repository, fixture }) => {
  const stopped = await fixture.createRule({ channels: [{ channelId: fixture.channel(81), name: "A" }, { channelId: fixture.channel(82), name: "B" }] });
  const plain = await fixture.createRule({ tokenId: fixture.token(83), channels: [{ channelId: fixture.channel(83), name: "C" }] });
  assert.equal(await repository.archiveRule(plain.id), true);
  assert.deepEqual((await repository.listChannelOptouts(plain.ownStationId)).filter((row) => row.channelId === fixture.channel(83)), [], "普通解除不记「用户停的」");
  const at = Date.UTC(2026, 9, 27, 3);
  assert.equal(await repository.archiveRule(stopped.id, { now: at, optout: true }), true);
  const rows = (await repository.listChannelOptouts(stopped.ownStationId)).filter((row) => [fixture.channel(81), fixture.channel(82)].includes(row.channelId));
  assert.deepEqual(rows.map((row) => [row.channelId, row.atMs]), [[fixture.channel(81), at], [fixture.channel(82), at]].sort((a, b) => a[0] - b[0]));
  // 已经解除的再停一次：什么也不记、不报错
  assert.equal(await repository.archiveRule(stopped.id, { now: at + 1000, optout: true }), false);
  assert.equal((await repository.listChannelOptouts(stopped.ownStationId)).filter((row) => row.atMs === at + 1000).length, 0);
  // 另一条绑定又用了同一个渠道、再停：不重复、时刻保留第一次
  const again = await fixture.createRule({ tokenId: fixture.token(84), channels: [{ channelId: fixture.channel(81), name: "A" }] });
  await repository.archiveRule(again.id, { now: at + 5000, optout: true });
  const first = (await repository.listChannelOptouts(stopped.ownStationId)).find((row) => row.channelId === fixture.channel(81));
  assert.equal(first.atMs, at, "时刻保留第一次");
  // 用户在「渠道」页签点「开始算利润」：删掉这一行；只删给的渠道
  assert.equal(await repository.removeChannelOptouts(stopped.ownStationId, [fixture.channel(81)]), 1);
  assert.deepEqual((await repository.listChannelOptouts(stopped.ownStationId)).filter((row) => [fixture.channel(81), fixture.channel(82)].includes(row.channelId)).map((row) => row.channelId), [fixture.channel(82)]);
  assert.equal(await repository.removeChannelOptouts(stopped.ownStationId, []), 0);
  // 别的自营站点的同编号渠道不受影响
  assert.deepEqual(await repository.listChannelOptouts(fixture.station("own-nobody")), []);
});

// K2c 重新分组（k-plan 3.3）
contract("regroupRules: a split — the old rule gets a [a, b) segment holding both keys, is archived at b (no optout), and the new rules start from b (floor = b, effective from b); everything in one transaction", async ({ repository, fixture }) => {
  const oldRule = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:t1`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(91), name: "A" }, { channelId: fixture.channel(92), name: "B" }] });
  const oldRef = { upstreamStationId: oldRule.upstreamStationId, tokenId: oldRule.tokenId, tokenName: oldRule.tokenName };
  const newRef = { upstreamStationId: oldRule.upstreamStationId, tokenId: fixture.token(93), tokenName: "T2" };
  const a = EFFECTIVE_FROM + HOUR, b = a + 5 * 60 * 1000;
  const groupInput = (ref, channelId, name, canonicalKey) => fixture.ruleInput({ tokenId: ref.tokenId, tokenName: ref.tokenName, canonicalKey, billingPolicy: "immediate", channels: [{ channelId, name }] });
  const result = await repository.regroupRules({ at: b, closes: [{ ruleId: oldRule.id, expect: { tokenId: oldRule.tokenId, channelIds: [fixture.channel(91), fixture.channel(92)] }, window: { from: a, keys: [oldRef, newRef] } }],
    creates: [groupInput(oldRef, fixture.channel(91), "A", `up:${fixture.tag}:t1`), groupInput(newRef, fixture.channel(92), "B", `up:${fixture.tag}:t2`)] });
  assert.deepEqual([result.conflict, result.stale, result.ruleIds.length], [false, false, 2]);
  result.ruleIds.forEach((id) => fixture.ruleIds.add(id));
  const archived = await repository.getRule(oldRule.id, { includeArchived: true });
  assert.deepEqual([archived.enabled, archived.archivedAtMs], [false, b], "在 b 归档");
  assert.deepEqual((await repository.listChannelOptouts(oldRule.ownStationId)).filter((row) => [fixture.channel(91), fixture.channel(92)].includes(row.channelId)), [], "重新分组不是用户停的，不记 optout");
  const segments = await repository.listSegments(oldRule.id);
  assert.deepEqual(segments.map((segment) => [segment.effectiveFrom, segment.effectiveTo, segment.timingSource]), [[EFFECTIVE_FROM, a, "operator_confirmed"], [a, b, "key_change_window"]]);
  assert.deepEqual(segments[1].keys.map((key) => key.tokenId).sort((x, y) => x - y), [oldRef.tokenId, newRef.tokenId].sort((x, y) => x - y), "过渡段两把 Key 都放着");
  assert.deepEqual(segments.flatMap((segment) => segment.keys.map((key) => key.active)).filter(Boolean), [], "归档以后不占唯一键");
  const created = await Promise.all(result.ruleIds.map((id) => repository.getRule(id)));
  assert.deepEqual(created.map((rule) => [rule.enabled, rule.accountingFloorMs, rule.billingEffectiveFrom, rule.channels.map((channel) => channel.channelId)]),
    [[true, b, b, [fixture.channel(91)]], [true, b, b, [fixture.channel(92)]]], "新绑定从 b 起算");
});

contract("regroupRules: a merge — the old rules are archived at b without a window (last segment keeps only their own key); one new rule holds all channels", async ({ repository, fixture }) => {
  const first = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:m1`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(94), name: "A" }] });
  const second = await fixture.createRule({ tokenId: fixture.token(95), tokenName: `Contract ${fixture.tag} M2`, canonicalKey: `up:${fixture.tag}:m2`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(96), name: "B" }] });
  const b = EFFECTIVE_FROM + 2 * HOUR;
  const merged = fixture.ruleInput({ tokenId: first.tokenId, tokenName: first.tokenName, canonicalKey: `up:${fixture.tag}:m1`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(94), name: "A" }, { channelId: fixture.channel(96), name: "B" }] });
  const result = await repository.regroupRules({ at: b, closes: [
    { ruleId: first.id, expect: { tokenId: first.tokenId, channelIds: [fixture.channel(94)] }, window: null },
    { ruleId: second.id, expect: { tokenId: second.tokenId, channelIds: [fixture.channel(96)] }, window: null }], creates: [merged] });
  assert.deepEqual([result.conflict, result.stale], [false, false]);
  result.ruleIds.forEach((id) => fixture.ruleIds.add(id));
  assert.deepEqual([(await repository.getRule(first.id, { includeArchived: true })).archivedAtMs, (await repository.getRule(second.id, { includeArchived: true })).archivedAtMs], [b, b]);
  assert.equal((await repository.listSegments(first.id)).length, 1, "合组：旧绑定不开过渡段");
  const created = await repository.getRule(result.ruleIds[0]);
  assert.deepEqual(created.channels.map((channel) => channel.channelId).sort((x, y) => x - y), [fixture.channel(94), fixture.channel(96)].sort((x, y) => x - y));
});

contract("regroupRules: stale plans (the rule's key or channels changed since, a before the open segment, b before a) and unique-key conflicts write nothing", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:s1`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(97), name: "A" }] });
  const holder = await fixture.createRule({ tokenId: fixture.token(98), tokenName: `Contract ${fixture.tag} H`, canonicalKey: `up:${fixture.tag}:s-holder`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(98), name: "H" }] });
  const snapshot = async () => JSON.stringify([await repository.listRules({ includeArchived: true }).then((rules) => rules.filter((item) => fixture.ruleIds.has(item.id))), await repository.listSegments(rule.id)]);
  const before = await snapshot();
  const input = fixture.ruleInput({ tokenId: fixture.token(99), tokenName: "N", canonicalKey: `up:${fixture.tag}:s-new`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(97), name: "A" }] });
  const close = (overrides = {}) => ({ ruleId: rule.id, expect: { tokenId: rule.tokenId, channelIds: [fixture.channel(97)] }, window: null, ...overrides });
  const b = EFFECTIVE_FROM + HOUR;
  for (const [label, closes, at] of [
    ["规则现在的 Key 不是计划的", [close({ expect: { tokenId: fixture.token(55), channelIds: [fixture.channel(97)] } })], b],
    ["渠道变了", [close({ expect: { tokenId: rule.tokenId, channelIds: [fixture.channel(97), fixture.channel(55)] } })], b],
    ["b 早于开着那段的起点", [close()], EFFECTIVE_FROM - 1000],
    ["a 早于开着那段的起点", [close({ window: { from: EFFECTIVE_FROM - 5000, keys: [] } })], b],
    ["b 早于 a", [close({ window: { from: b + 1000, keys: [] } })], b],
  ]) {
    assert.deepEqual(await repository.regroupRules({ at, closes, creates: [input] }), { conflict: false, stale: true }, label);
    assert.equal(await snapshot(), before, `${label}：什么也没写`);
  }
  // 新绑定撞了别的绑定握着的 Key：整体回滚（旧绑定没归档、没开过渡段）
  const clash = fixture.ruleInput({ tokenId: holder.tokenId, tokenName: holder.tokenName, canonicalKey: `up:${fixture.tag}:s-holder`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(97), name: "A" }] });
  assert.deepEqual(await repository.regroupRules({ at: b, closes: [close({ window: { from: EFFECTIVE_FROM + 1000, keys: [{ upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId }] } })], creates: [clash] }), { conflict: true, stale: false });
  assert.equal(await snapshot(), before, "撞唯一键：旧绑定没归档、没开过渡段");
});

contract("applyKeyChangePlans: a plan whose only mismatch is `before` (a legal cutover) writes nothing; a cutover exactly at the open segment's start is allowed (zero-length old segment); concurrent identical plans write exactly one copy", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(101), name: "P" }], initialRatio: 1 });
  const oldRef = { upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId, tokenName: rule.tokenName };
  const newRef = { upstreamStationId: rule.upstreamStationId, tokenId: fixture.token(102), tokenName: "P2" };
  const snapshot = async () => JSON.stringify([await repository.listSegments(rule.id), (await repository.getRule(rule.id)).tokenId]);
  const before = await snapshot();
  const cutoverAt = EFFECTIVE_FROM + HOUR; // 切点本身是合法的，只有「换之前」那把 Key 对不上规则现在的
  const wrongToken = { kind: "precise", cutoverAt, before: [{ upstreamStationId: rule.upstreamStationId, tokenId: fixture.token(555) }], after: [newRef] };
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: wrongToken }]), { conflict: false, stale: true });
  const wrongStation = { kind: "precise", cutoverAt, before: [{ upstreamStationId: "other-upstream", tokenId: rule.tokenId }], after: [newRef] };
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: wrongStation }]), { conflict: false, stale: true });
  assert.equal(await snapshot(), before, "只有 before 不符：什么也没写");
  // 切点正好等于开着那段的起点：允许，旧段长度为零
  assert.deepEqual(await repository.applyKeyChangePlans([{ ruleId: rule.id, plan: { kind: "precise", cutoverAt: EFFECTIVE_FROM, before: [oldRef], after: [newRef] } }]), { conflict: false });
  assert.deepEqual((await repository.listSegments(rule.id)).map((segment) => [segment.effectiveFrom, segment.effectiveTo]), [[EFFECTIVE_FROM, EFFECTIVE_FROM], [EFFECTIVE_FROM, null]]);
  // 三个同时进来的同一份计划（页面刷新 + 轮询）：只写一份，其余 stale（行锁 + 前置条件）
  const other = await fixture.createRule({ tokenId: fixture.token(110), tokenName: `Contract ${fixture.tag} Q`, channels: [{ channelId: fixture.channel(110), name: "Q" }], initialRatio: 1 });
  const otherRef = { upstreamStationId: other.upstreamStationId, tokenId: other.tokenId, tokenName: other.tokenName };
  const nextRef = { upstreamStationId: other.upstreamStationId, tokenId: fixture.token(111), tokenName: "Q2" };
  const plan = { kind: "windowed", windowStart: EFFECTIVE_FROM + HOUR, windowEnd: EFFECTIVE_FROM + HOUR + 60000, windowKeys: [otherRef, nextRef], before: [otherRef], after: [nextRef] };
  const settled = await Promise.allSettled([1, 2, 3].map(() => repository.applyKeyChangePlans([{ ruleId: other.id, plan }])));
  const outcomes = settled.map((item) => (item.status === "fulfilled" ? JSON.stringify(item.value) : `ERR:${item.reason?.code}`));
  assert.equal(outcomes.filter((item) => item === JSON.stringify({ conflict: false })).length, 1, `只写一份：${outcomes.join(" ")}`);
  assert.equal((await repository.listSegments(other.id)).length, 3, "原段 + 过渡段 + 新段，没有重复的");
});

contract("applyKeyChangePlans: rules carrying a real active_token_key — one plan alone collides on the unique key, a swap or a three-rule rotation in one batch works (why the driver keeps a swap group in one transaction)", async ({ repository, fixture }) => {
  const canonicalOf = (name) => `up:${fixture.tag}:${name}`;
  const make = (name, offset) => fixture.createRule({ tokenId: fixture.token(offset), tokenName: `Contract ${fixture.tag} ${name}`, canonicalKey: canonicalOf(name), billingPolicy: "immediate", channels: [{ channelId: fixture.channel(offset), name }] });
  const [a, b, c] = [await make("a", 120), await make("b", 121), await make("c", 122)];
  const refOf = (rule) => ({ upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId, tokenName: rule.tokenName });
  const move = (rule, to, canonical, at) => ({ ruleId: rule.id, plan: { kind: "moved", cutoverAt: at, before: [refOf(rule)], after: [refOf(to)], canonicalKey: canonical } });
  const at = EFFECTIVE_FROM + HOUR;
  // 拆开单独应用：第一条拿了另一条握着的 canonical key，撞唯一键
  assert.deepEqual(await repository.applyKeyChangePlans([move(a, b, canonicalOf("b"), at)]), { conflict: true });
  // 同一批互换：先清空再写，不撞
  assert.deepEqual(await repository.applyKeyChangePlans([move(a, b, canonicalOf("b"), at), move(b, a, canonicalOf("a"), at)]), { conflict: false });
  assert.deepEqual([(await repository.getRule(a.id)).tokenId, (await repository.getRule(b.id)).tokenId], [b.tokenId, a.tokenId]);
  // 三条轮换：拆开撞，同一批不撞
  const now = [await repository.getRule(a.id), await repository.getRule(b.id), await repository.getRule(c.id)];
  const at2 = at + HOUR;
  const ring = [move(now[0], now[2], canonicalOf("c"), at2), move(now[2], now[1], canonicalOf("a"), at2), move(now[1], now[0], canonicalOf("b"), at2)];
  assert.deepEqual(await repository.applyKeyChangePlans([ring[0]]), { conflict: true }, "轮换拆开：撞");
  assert.deepEqual(await repository.applyKeyChangePlans(ring), { conflict: false }, "轮换同一批：不撞");
});

contract("regroupRules: a new rule with dayExtraKeys (Sub2API) gets a closed first segment up to the next business day carrying the extra old keys (no unique key held), then an open segment with only its own key", async ({ repository, fixture }) => {
  const oldRule = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:x1`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(131), name: "A" }] });
  const dropped = { upstreamStationId: oldRule.upstreamStationId, tokenId: oldRule.tokenId, tokenName: oldRule.tokenName };
  const b = EFFECTIVE_FROM + 2 * HOUR, endsAt = b + 10 * HOUR;
  const input = fixture.ruleInput({ tokenId: fixture.token(132), tokenName: "New", canonicalKey: `up:${fixture.tag}:x2`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(131), name: "A" }], dayExtraKeys: { endsAt, keys: [dropped] } });
  const result = await repository.regroupRules({ at: b, closes: [{ ruleId: oldRule.id, expect: { tokenId: oldRule.tokenId, channelIds: [fixture.channel(131)] }, window: null }], creates: [input] });
  assert.deepEqual([result.conflict, result.stale], [false, false]);
  result.ruleIds.forEach((id) => fixture.ruleIds.add(id));
  const segments = await repository.listSegments(result.ruleIds[0]);
  assert.deepEqual(segments.map((segment) => [segment.effectiveTo === null ? null : segment.effectiveTo, segment.keys.map((key) => key.tokenId).sort((x, y) => x - y), segment.keys.map((key) => key.active)]),
    [[endsAt, [oldRule.tokenId, input.tokenId].sort((x, y) => x - y), [false, false]], [null, [input.tokenId], [true]]], "第一段关着、带着多出来的旧 Key 且不占唯一键；第二段开着只有自己的 Key");
  assert.equal(segments[1].effectiveFrom, endsAt);
  // 旧 Key 没被占着：别的绑定马上可以用它
  const taker = await fixture.createRule({ tokenId: oldRule.tokenId, ownStationId: fixture.station("own-after"), canonicalKey: `up:${fixture.tag}:x3`, channels: [{ channelId: fixture.channel(133), name: "T" }] });
  assert.equal(taker.tokenId, oldRule.tokenId);
});

contract("markRuleStartSource (K2c): records 'auto' once and only when nothing was recorded; a rule nobody marked looks exactly as before (no startSource field)", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(141), name: "S" }] });
  assert.equal("startSource" in rule, false, "没记过的规则的样子和以前逐字一样");
  assert.equal(await repository.markRuleStartSource(rule.id, "auto"), true);
  assert.equal((await repository.getRule(rule.id)).startSource, "auto");
  assert.equal(await repository.markRuleStartSource(rule.id, "user"), false, "已经记过的不改");
  assert.equal((await repository.getRule(rule.id)).startSource, "auto");
  assert.equal(await repository.markRuleStartSource(`rr_missing${fixture.tag}`, "auto"), false);
});

contract("archiveRule reason (K2c): a system stop records stop_reason and no optout; a plain archive records neither; the field only exists when set", async ({ repository, fixture }) => {
  const removed = await fixture.createRule({ channels: [{ channelId: fixture.channel(151), name: "R" }] });
  const plain = await fixture.createRule({ tokenId: fixture.token(152), channels: [{ channelId: fixture.channel(152), name: "P" }] });
  assert.equal(await repository.archiveRule(removed.id, { reason: "upstream_removed" }), true);
  assert.equal(await repository.archiveRule(plain.id), true);
  assert.equal((await repository.getRule(removed.id, { includeArchived: true })).stopReason, "upstream_removed");
  assert.equal("stopReason" in (await repository.getRule(plain.id, { includeArchived: true })), false);
  assert.deepEqual((await repository.listChannelOptouts(removed.ownStationId)).filter((row) => [fixture.channel(151), fixture.channel(152)].includes(row.channelId)), [], "系统停的不记用户停的");
});

contract("listSegmentsForRules (K2d): several rules' segments (with keys) in one read, same content as listSegments per rule; no ids gives {}; an unknown id gives an empty list", async ({ repository, fixture }) => {
  const first = await fixture.createRule({ canonicalKey: `up:${fixture.tag}:l1`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(181), name: "A" }] });
  const second = await fixture.createRule({ tokenId: fixture.token(182), tokenName: "L2", canonicalKey: `up:${fixture.tag}:l2`, billingPolicy: "immediate", channels: [{ channelId: fixture.channel(182), name: "B" }] });
  const batch = await repository.listSegmentsForRules([first.id, second.id, `rr_missing${fixture.tag}`]);
  assert.deepEqual(Object.keys(batch).sort(), [first.id, second.id, `rr_missing${fixture.tag}`].sort());
  for (const id of [first.id, second.id]) {
    const single = await repository.listSegments(id);
    assert.deepEqual(batch[id].map((segment) => [segment.id, segment.effectiveFrom, segment.effectiveTo, segment.keys.map((key) => key.tokenId)]), single.map((segment) => [segment.id, segment.effectiveFrom, segment.effectiveTo, segment.keys.map((key) => key.tokenId)]));
    assert.ok(batch[id].length >= 1 && batch[id].every((segment) => segment.keys.length >= 1));
  }
  assert.deepEqual(batch[`rr_missing${fixture.tag}`], []);
  assert.deepEqual(await repository.listSegmentsForRules([]), {});
});

contract("markKeyIssue (K2b): an open issue reads back as keyIssue; with untilMs it reads back as keyIssueClosed (and keyIssue is null); null clears both", async ({ repository, fixture }) => {
  const rule = await fixture.createRule({ channels: [{ channelId: fixture.channel(191), name: "K" }] });
  const get = () => repository.getRule(rule.id);
  assert.deepEqual([(await get()).keyIssue, (await get()).keyIssueClosed ?? null], [null, null]);
  await repository.markKeyIssue(rule.id, { code: "KEY_GROUP_CHANGED", sinceMs: 1000 });
  assert.deepEqual([(await get()).keyIssue, (await get()).keyIssueClosed ?? null], [{ code: "KEY_GROUP_CHANGED", sinceMs: 1000 }, null]);
  await repository.markKeyIssue(rule.id, { code: "KEY_GROUP_CHANGED", sinceMs: 1000, untilMs: 5000 });
  assert.deepEqual([(await get()).keyIssue, (await get()).keyIssueClosed], [null, { code: "KEY_GROUP_CHANGED", sinceMs: 1000, untilMs: 5000 }]);
  await repository.markKeyIssue(rule.id, null);
  assert.deepEqual([(await get()).keyIssue, (await get()).keyIssueClosed ?? null], [null, null]);
});

contract("createRule (K2c-1): a key whose segment in another binding closed earlier today — the new binding's floor is that segment's end (New API, revenue and cost both start there); a Sub2API new binding starts the next day (the day cannot be cut)", async ({ repository, fixture }) => {
  const dayStart = Math.floor(Date.now() / 86400000) * 86400000; // 契约的时区是 UTC
  const end = Math.max(Date.now() - 2000, dayStart + 2000), start = end - 1000;
  const a = await fixture.createRule({ billingPolicy: "immediate", canonicalKey: `up:${fixture.tag}:h1`, channels: [{ channelId: fixture.channel(201), name: "A" }] });
  const oldRef = { upstreamStationId: a.upstreamStationId, tokenId: a.tokenId, tokenName: a.tokenName };
  const newRef = { upstreamStationId: a.upstreamStationId, tokenId: fixture.token(202), tokenName: "N" };
  const applied = await repository.applyKeyChangePlans([{ ruleId: a.id, plan: { kind: "windowed", windowStart: start, windowEnd: end, windowKeys: [oldRef, newRef], before: [oldRef], after: [newRef], canonicalKey: `up:${fixture.tag}:h1n` } }]);
  assert.deepEqual(applied, { conflict: false });
  const nobody = await fixture.createRule({ billingPolicy: "immediate", tokenId: fixture.token(299), tokenName: "Z", canonicalKey: `up:${fixture.tag}:h0`, channels: [{ channelId: fixture.channel(209), name: "Z" }] });
  assert.equal(nobody.accountingFloorMs, null, "没被别的绑定握过的 Key 没有下限");
  const b = await fixture.createRule({ billingPolicy: "immediate", tokenId: oldRef.tokenId, tokenName: oldRef.tokenName, canonicalKey: `up:${fixture.tag}:h2`, channels: [{ channelId: fixture.channel(203), name: "B" }] });
  assert.equal(b.accountingFloorMs, end, "新绑定从那条绑定放开这把 Key 的那一刻起算");
});

contract("createRule (K2c-1): the same on a Sub2API upstream — the new binding is not counted today and starts at the next day's 0:00", async ({ repository, fixture }) => {
  const dayStart = Math.floor(Date.now() / 86400000) * 86400000;
  const end = Math.max(Date.now() - 2000, dayStart + 2000), start = end - 1000;
  const a = await fixture.createRule({ billingPolicy: "immediate", provider: "sub2api", canonicalKey: `up:${fixture.tag}:s1`, channels: [{ channelId: fixture.channel(211), name: "A" }] });
  const oldRef = { upstreamStationId: a.upstreamStationId, tokenId: a.tokenId, tokenName: a.tokenName };
  const newRef = { upstreamStationId: a.upstreamStationId, tokenId: fixture.token(212), tokenName: "N" };
  await repository.applyKeyChangePlans([{ ruleId: a.id, plan: { kind: "windowed", windowStart: start, windowEnd: end, windowKeys: [oldRef, newRef], before: [oldRef], after: [newRef], canonicalKey: `up:${fixture.tag}:s1n` } }]);
  const b = await fixture.createRule({ billingPolicy: "immediate", provider: "sub2api", tokenId: oldRef.tokenId, tokenName: oldRef.tokenName, canonicalKey: `up:${fixture.tag}:s2`, channels: [{ channelId: fixture.channel(213), name: "B" }] });
  assert.equal(b.accountingFloorMs, dayStart + 86400000, "Sub2API 切不开一天中间：今天不算，第二天 0 点起整天算");
});
