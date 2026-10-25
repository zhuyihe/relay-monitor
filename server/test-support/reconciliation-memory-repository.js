// 对账持久化层的内存实现，只给测试用：公开方法与 ReconciliationRepository 一一对应，
// SQL 之外的判定直接复用生产代码导出的同一批函数。
// 模拟测试会依赖的 MySQL 行为：
// - 事务内的写入先暂存，提交前其他读取看不到；回滚整体丢弃。
// - 行锁持有到提交或回滚，按到达顺序授予；带 owner 校验的快照保存锁住全部规则（对应全表 FOR UPDATE）。
// - 唯一键、NOT NULL、VARCHAR 长度按 schema 校验，报错带 mysql2 的 code/errno。
// - 字符串比较忽略大小写和重音（utf8mb4_0900_ai_ci）；TIMESTAMP 精确到秒，
//   ON UPDATE CURRENT_TIMESTAMP 只在值真正变化时刷新；UPDATE 返回匹配行数（mysql2 默认 FOUND_ROWS）。
// - 单表 UPDATE 的 SET 从左到右求值，后面的表达式读到的是前面刚赋的新值。
// - 读取结果是新对象，JSON 列像 mysql2 一样解析成新对象，调用方改了也不影响存储。
import { reconciliationScopeFingerprint, reconciliationSnapshotRecordPrefix } from "../../lib/reconciliation-snapshot.js";
import { applyScopePolicy, isScopedBillingPolicy, serializeRuleSourceBinding } from "../../lib/reconciliation-scope-policy.js";
import { billDayOf } from "../../lib/business-time.js";
import { sameReconciliationWindow } from "../../lib/reconciliation-contract.js";
import { LEDGER_DECIMAL_SCALE, RECONCILIATION_LEDGER_COLUMNS, encodeLedgerCursor, ledgerDecimal, ledgerEntryFromRow, ledgerHistoryRecord, ledgerInsertValues,
  ledgerWriteDecision } from "../../lib/reconciliation-ledger.js";
import {
  uid, reconciliationOwnerRuleState, asJson, activeTokenKey, activeChannelKey, ruleFromRow, segmentFromRow,
  snapshotLogicalEnd, snapshotGeneratedAt, selectLatestRecord, normalizeConfirmedHistoryOptions, repositoryError,
} from "../reconciliation-repository.js";
import { BILLING_CAPABILITY_IDENTITY_SCHEME, LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME } from "../../lib/billing-capability-storage.js";

const JSON_COLUMNS = new Set(["source_binding", "source", "capability", "detail"]);

const TABLE_NAMES = {
  rules: "reconciliation_rules",
  channels: "reconciliation_rule_channels",
  segments: "reconciliation_rule_segments",
  snapshots: "reconciliation_snapshots",
  alerts: "reconciliation_alert_state",
  capabilities: "reconciliation_billing_capabilities",
  ledger: "reconciliation_ledger",
};

// 与 db/pool.js 的建表语句保持一致。
const SCHEMA = {
  rules: {
    keys: { PRIMARY: ["id"], uq_reconciliation_active_token: ["active_token_key"] },
    notNull: ["id", "upstream_station_id", "own_station_id", "token_id", "token_name", "fixed_group", "timezone", "enabled", "billing_policy", "scope_version", "cost_coverage"],
    varchar: { id: 32, upstream_station_id: 32, own_station_id: 32, token_name: 160, fixed_group: 160, timezone: 64, active_token_key: 255, billing_policy: 32, cost_coverage: 24, provider: 24, canonical_key: 255 },
    onUpdate: "updated_at",
  },
  channels: {
    keys: { PRIMARY: ["rule_id", "channel_id"], uq_reconciliation_active_channel: ["active_channel_key"] },
    notNull: ["rule_id", "channel_id", "channel_name"],
    varchar: { rule_id: 32, channel_name: 160, active_channel_key: 96, channel_status: 24 },
  },
  segments: {
    keys: { PRIMARY: ["id"] },
    notNull: ["id", "rule_id", "group_name", "effective_from_ms", "detected_at_ms", "timing_source"],
    varchar: { id: 32, rule_id: 32, group_name: 160, ratio_source: 24, timing_source: 24 },
    onUpdate: "updated_at",
  },
  snapshots: {
    keys: { PRIMARY: ["id"], uq_reconciliation_snapshot: ["rule_id", "snapshot_key"] },
    notNull: ["rule_id", "snapshot_key", "window_kind", "window_start_ms", "window_end_ms", "health_code"],
    varchar: { rule_id: 32, snapshot_key: 128, window_kind: 24, health_code: 64, health_detail: 300, segment_id: 32 },
    onUpdate: "generated_at",
  },
  alerts: {
    keys: { PRIMARY: ["rule_id", "event_code"] },
    notNull: ["rule_id", "event_code", "active", "first_seen_at", "last_seen_at"],
    varchar: { rule_id: 32, event_code: 64 },
  },
  capabilities: {
    keys: { PRIMARY: ["identity"] },
    notNull: ["identity", "capability", "verified_at", "identity_scheme"],
    varchar: { identity: 64, identity_scheme: 24 },
  },
  ledger: {
    keys: { PRIMARY: ["rule_id", "bill_date", "revision"] },
    notNull: ["rule_id", "bill_date", "revision", "timezone", "window_start_ms", "window_end_ms", "revenue_usd", "source", "settled_at"],
    varchar: { rule_id: 32, version_id: 32, timezone: 64, cost_basis: 16, source: 24 },
  },
};
// 账本行按 LEDGER_SELECT 的读法返回：DECIMAL 是定点字符串，DATETIME(3) 经 DATE_FORMAT(%f) 带 6 位小数。
// 账本的 source 是 VARCHAR（结账来源），不是快照表那样的 JSON 列。
const ledgerRead = (row) => ({ ...fresh(row), source: row.source, settled_at: `${row.settled_at}000`,
  ...Object.fromEntries(Object.entries(LEDGER_DECIMAL_SCALE).map(([column, scale]) => [column, ledgerDecimal(row[column], scale)])) });
const fold = (value) => String(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const sameText = (a, b) => a != null && b != null && fold(a) === fold(b);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareText = (a, b) => compare(fold(a), fold(b));
// MySQL 里 NULL 比任何值都小：升序排最前，降序排最后。
const nullsFirst = (a, b) => a == null ? (b == null ? 0 : -1) : b == null ? 1 : compare(a, b);
const seconds = (value) => value == null ? null : Math.floor(new Date(value).getTime() / 1000);
const bigint = (value) => value == null ? null : Number(value);
const fresh = (row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column,
  value instanceof Date ? new Date(value) : JSON_COLUMNS.has(column) && value != null ? structuredClone(asJson(value)) : value]));

const sortKeys = (value) => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) : value;

// 判断一次 UPDATE 是否真的改了值：JSON 列按语义比较，其余按存储值比较（与排序规则无关）。
function sameValue(column, a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (JSON_COLUMNS.has(column)) return JSON.stringify(sortKeys(typeof a === "string" ? asJson(a) : a)) === JSON.stringify(sortKeys(typeof b === "string" ? asJson(b) : b));
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  return String(a) === String(b);
}

function sqlError(code, errno, sqlState, message) {
  return Object.assign(new Error(message), { code, errno, sqlState, sqlMessage: message });
}

class MemoryTransaction {
  constructor(name) {
    this.inserted = Object.fromEntries(Object.keys(TABLE_NAMES).map((table) => [table, []]));
    this.patches = new Map();
    this.deleted = new Set();
    this.locks = [];
    this.done = false;
    this.record = { name, snapshots: [], archivedRuleIds: [] };
  }
}

const conflicts = (a, b) => a === "*" || b === "*" || a === b;

export class MemoryReconciliationRepository {
  #held = [];
  #queue = [];
  #autoId = 0;

  // 表里存 snake_case 行；传入的行按引用保存，提交时原地更新，测试持有的引用始终是已提交的数据。
  // hooks（都可以是 async）：
  //   beforeTransaction(name)          对应 getConnection，事务开始前
  //   beforeRead(name, args)           非事务读取前，可以抛错模拟查询失败
  //   beforeSnapshotWrite(entry, tx)   写快照前，可以抛错模拟写入失败
  //   afterSnapshotWrite(entry, tx)    写快照后、提交前
  //   beforeCommit(tx) / afterCommit(tx)
  //   beforeCapabilityWrite(method, identity)  保存或删除账单能力前，可以抛错模拟写入失败
  // tx 是 { name, snapshots: [{ ruleId, snapshotKey, source }], archivedRuleIds }。
  constructor({ rules = [], channels = [], segments = [], snapshots = [], alerts = [], capabilities = [], ledger = [], now = () => Date.now(), hooks = {} } = {}) {
    this.tables = { rules: [...rules], channels: [...channels], segments: [...segments], snapshots: [...snapshots], alerts: [...alerts], capabilities: [...capabilities], ledger: [...ledger] };
    this.now = now;
    this.hooks = hooks;
    // snapshotWrites / ratioWrites / channelStateWrites 按语句记录，包括之后被回滚的写入。
    this.log = { snapshotWrites: [], ratioWrites: [], channelStateWrites: [], alertCalls: [], capabilityWrites: [], ledgerWrites: [], commits: [], rollbacks: [] };
  }

  async listRules({ includeArchived = false } = {}) {
    await this.#read("listRules", [{ includeArchived }]);
    return this.#plain("rules")
      .filter((row) => includeArchived || row.archived_at == null)
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || nullsFirst(seconds(b.updated_at), seconds(a.updated_at)))
      .map((row) => ruleFromRow(fresh(row), this.#channelsOf(null, row.id)));
  }

  async getRule(id, { includeArchived = false } = {}) {
    await this.#read("getRule", [id, { includeArchived }]);
    const row = this.#plain("rules").find((item) => sameText(item.id, id) && (includeArchived || item.archived_at == null));
    return row ? ruleFromRow(fresh(row), this.#channelsOf(null, id)) : null;
  }

  async findChannelConflicts(channelIds, { excludeRuleId = null } = {}) {
    if (!channelIds.length) return [];
    await this.#read("findChannelConflicts", [channelIds, { excludeRuleId }]);
    const wanted = channelIds.map(Number);
    return this.#plain("rules")
      .filter((rule) => Number(rule.enabled) === 1 && rule.archived_at == null && !(excludeRuleId && sameText(rule.id, excludeRuleId)))
      .flatMap((rule) => this.#plain("channels")
        .filter((channel) => sameText(channel.rule_id, rule.id) && wanted.includes(Number(channel.channel_id)))
        .map((channel) => ({ ruleId: rule.id, tokenName: rule.token_name, fixedGroup: rule.fixed_group, channelId: Number(channel.channel_id) })));
  }

  async findTokenConflict(upstreamStationId, tokenId, { excludeRuleId = null } = {}) {
    await this.#read("findTokenConflict", [upstreamStationId, tokenId, { excludeRuleId }]);
    const row = this.#plain("rules").find((rule) => sameText(rule.upstream_station_id, upstreamStationId) && Number(rule.token_id) === Number(tokenId)
      && Number(rule.enabled) === 1 && rule.archived_at == null && !(excludeRuleId && sameText(rule.id, excludeRuleId)));
    return row ? { ruleId: row.id, tokenName: row.token_name, fixedGroup: row.fixed_group } : null;
  }

  async createRule(input, { guard = null } = {}) {
    const requested = input;
    const id = uid("rr");
    const tokenKey = activeTokenKey(input);
    await this.#transaction("createRule", async (tx) => {
      await this.#lock(tx, `rule:${id}`);
      if (isScopedBillingPolicy(input.billingPolicy)) input = applyScopePolicy(null, input);
      if (guard) guard(null, [], input);
      const createdAt = this.#timestamp();
      this.#insert(tx, "rules", {
        id, upstream_station_id: input.upstreamStationId ?? null, own_station_id: input.ownStationId ?? null, token_id: bigint(input.tokenId),
        token_name: input.tokenName ?? null, fixed_group: input.fixedGroup ?? null, timezone: input.timezone ?? null,
        enabled: input.enabled === false ? 0 : 1, active_token_key: tokenKey ?? null, archived_at: null,
        billing_policy: input.billingPolicy || "legacy-v3", scope_version: bigint(input.scopeVersion || 1),
        billing_effective_from_ms: bigint(input.billingEffectiveFrom), cost_coverage: input.costCoverage || "unknown",
        provider: input.provider || null, canonical_key: input.canonicalKey || null,
        source_binding: JSON.stringify(serializeRuleSourceBinding(input)), created_at: createdAt, updated_at: createdAt,
      });
      for (const channel of input.channels) this.#insertChannel(tx, id, channel, input);
      this.#insert(tx, "segments", {
        id: uid("rs"), rule_id: id, group_name: input.fixedGroup ?? null, group_ratio: bigint(input.initialRatio),
        ratio_observed_at_ms: input.initialRatio == null ? null : Date.now(), ratio_source: input.initialRatio == null ? null : "group_catalog",
        effective_from_ms: Number(input.initialEffectiveFromMs ?? (isScopedBillingPolicy(input.billingPolicy) ? 0 : Date.now())),
        effective_to_ms: null, detected_at_ms: Date.now(), timing_source: "operator_confirmed", created_at: createdAt, updated_at: createdAt,
      });
      if (guard) guard(null, [], isScopedBillingPolicy(input.billingPolicy) ? applyScopePolicy(null, requested) : input);
    });
    return this.getRule(id);
  }

  async updateRule(id, input, { append = false, guard = null } = {}) {
    const requested = input;
    await this.#transaction("updateRule", async (tx) => {
      await this.#lock(tx, `rule:${id}`);
      const entry = this.#ruleEntry(tx, id);
      if (!entry) throw repositoryError("RULE_NOT_FOUND");
      const existing = ruleFromRow(entry.row, this.#channelsOf(tx, id, "id"));
      input = applyScopePolicy(existing, input, Date.now(), { append });
      if (guard) guard(existing, existing.channels, input);
      const affected = this.#update(tx, "rules", [entry], {
        upstream_station_id: input.upstreamStationId ?? null, own_station_id: input.ownStationId ?? null, token_id: bigint(input.tokenId),
        token_name: input.tokenName ?? null, fixed_group: input.fixedGroup ?? null, timezone: input.timezone ?? null,
        enabled: input.enabled === false ? 0 : 1, active_token_key: activeTokenKey(input) ?? null,
        billing_policy: input.billingPolicy ?? null, scope_version: bigint(input.scopeVersion), billing_effective_from_ms: bigint(input.billingEffectiveFrom),
        cost_coverage: input.costCoverage ?? null, provider: input.provider ?? null, canonical_key: input.canonicalKey ?? null,
        source_binding: JSON.stringify(serializeRuleSourceBinding(input)),
      });
      if (!affected) throw repositoryError("RULE_NOT_FOUND");
      // 与 MySQL 版一致：保留仍在关联里的渠道行（含状态列），只删移除的、插入新增的。
      const current = this.#rows("channels", tx).filter(({ row }) => sameText(row.rule_id, id));
      const channelIds = new Set(input.channels.map((channel) => Number(channel.channelId)));
      this.#delete(tx, "channels", current.filter(({ row }) => !channelIds.has(Number(row.channel_id))));
      const kept = new Set(current.map(({ row }) => Number(row.channel_id)));
      for (const channel of input.channels) {
        if (!kept.has(Number(channel.channelId))) this.#insertChannel(tx, id, channel, input);
        else this.#update(tx, "channels", current.filter(({ row }) => Number(row.channel_id) === Number(channel.channelId)),
          { channel_name: channel.name ?? null, active_channel_key: activeChannelKey(input, channel.channelId) ?? null });
      }
      if (guard) guard(existing, existing.channels, applyScopePolicy(existing, requested, Date.now(), { append }));
    });
    return this.getRule(id);
  }

  async appendChannels(id, channels, confirmation = {}, { guard = null } = {}) {
    return this.updateRule(id, { channels, ...confirmation }, { append: true, guard });
  }

  async anchorRuleIdentity(id, { provider, canonicalKey, ownSource }, { expectedScopeFingerprint, allowInitialAnchoring = false } = {}) {
    const anchored = await this.#transaction("anchorRuleIdentity", async (tx) => {
      await this.#lock(tx, `rule:${id}`);
      const entry = this.#ruleEntry(tx, id);
      if (!entry) return false;
      const channels = this.#channelsOf(tx, id, "id");
      const segments = this.#segmentsOf(tx, id).map(({ row }) => row);
      const rule = ruleFromRow(entry.row, channels);
      if (reconciliationScopeFingerprint(rule, segments.map(segmentFromRow)) !== expectedScopeFingerprint) return false;
      if ((rule.canonicalKey && rule.canonicalKey !== canonicalKey) || (rule.ownSource && rule.ownSource.namespaceKey !== ownSource?.namespaceKey)) {
        throw repositoryError("SOURCE_BINDING_UNCONFIRMED");
      }
      if (!rule.canonicalKey || !rule.ownSource) {
        const history = this.#rows("snapshots", tx).map(({ row }) => row).filter((row) => sameText(row.rule_id, id))
          .sort((a, b) => nullsFirst(seconds(b.generated_at), seconds(a.generated_at)));
        const source = asJson(history[0]?.source);
        const original = source?.ruleEvidence || source?.scopePolicy;
        const originalMatches = original?.canonicalKey === canonicalKey && original?.ownSource?.namespaceKey === ownSource?.namespaceKey;
        const observed = channels.some((channel) => channel.status_observed_at_ms != null) || segments.some((segment) => segment.timing_source === "detected"
          || (segment.ratio_source === "group_catalog" && Number(segment.ratio_observed_at_ms) > Number(segment.effective_from_ms)));
        if (!originalMatches && !(allowInitialAnchoring && !history.length && !observed)) {
          throw repositoryError("LEGACY_IDENTITY_UNVERIFIED");
        }
        this.#update(tx, "rules", [entry], {
          provider: (rule.provider || provider) ?? null, canonical_key: (rule.canonicalKey || canonicalKey) ?? null,
          source_binding: JSON.stringify(serializeRuleSourceBinding({ ...rule, ownSource: rule.ownSource || ownSource })),
        });
      }
      return true;
    });
    return anchored ? this.getRule(id) : null;
  }

  async listSegments(ruleId) {
    await this.#read("listSegments", [ruleId]);
    return this.#segmentsOf(null, ruleId).map(({ row }) => segmentFromRow(fresh(row)));
  }

  async backfillMissingSegmentRatios(ruleId, groups, observedAt = Date.now(), segments = null) {
    const knownRatios = new Map(Object.entries(groups || {}).flatMap(([name, group]) => {
      const ratio = Number(group?.ratio);
      return group?.ratio != null && Number.isFinite(ratio) ? [[name, ratio]] : [];
    }));
    const existing = segments || await this.listSegments(ruleId);
    if (!existing.some((segment) => segment.ratio == null && knownRatios.has(segment.group))) return 0;
    return this.#transaction("backfillMissingSegmentRatios", async (tx) => {
      await this.#lock(tx, `rule:${ruleId}`);
      let updated = 0;
      for (const { row } of this.#segmentsOf(tx, ruleId)) {
        const ratio = knownRatios.get(row.group_name);
        if (row.group_ratio != null || ratio == null || !Number.isFinite(ratio)) continue;
        updated += this.#backfillRatio(tx, ruleId, row.id, ratio, observedAt);
      }
      return updated;
    });
  }

  async observeSource(ruleId, { groups, group, ratio, tokenName, detectedAt = Date.now() }) {
    const knownRatios = new Map(Object.entries(groups || {}).flatMap(([name, item]) => {
      const value = Number(item?.ratio);
      return item?.ratio != null && Number.isFinite(value) ? [[name, value]] : [];
    }));
    const outcome = await this.#transaction("observeSource", async (tx) => {
      await this.#lock(tx, `rule:${ruleId}`);
      const rule = this.#ruleEntry(tx, ruleId);
      if (!rule) throw repositoryError("RULE_NOT_FOUND");
      const rows = this.#segmentsOf(tx, ruleId).map(({ row }) => ({ ...row }));
      let ratioBackfilled = false;
      for (const row of rows) {
        const knownRatio = knownRatios.get(row.group_name);
        if (row.group_ratio != null || knownRatio == null) continue;
        const affected = this.#backfillRatio(tx, ruleId, row.id, knownRatio, detectedAt);
        ratioBackfilled ||= affected > 0;
        if (affected) row.group_ratio = knownRatio;
      }
      const current = rows.find((row) => row.effective_to_ms == null);
      if (!current) throw repositoryError("CURRENT_SEGMENT_MISSING");
      const currentRatio = current.group_ratio == null ? null : Number(current.group_ratio);
      const nextRatio = ratio == null ? null : Number(ratio);
      const sameGroup = current.group_name === group;
      const observedCurrentRatio = knownRatios.get(current.group_name) ?? null;
      const ratioToBackfill = sameGroup ? nextRatio : observedCurrentRatio;
      if (currentRatio == null && ratioToBackfill != null) {
        const affected = this.#backfillRatio(tx, ruleId, current.id, ratioToBackfill, detectedAt);
        ratioBackfilled ||= affected > 0;
        if (affected) current.group_ratio = ratioToBackfill;
      }
      const ratioChanged = sameGroup && currentRatio != null && nextRatio != null && currentRatio !== nextRatio;
      const transitioned = !sameGroup || ratioChanged;
      if (transitioned) {
        this.#splitSegment(tx, ruleId, current, { group, ratio, nextRatio, detectedAt });
        this.#update(tx, "rules", [this.#ruleEntry(tx, ruleId)].filter(Boolean), { token_name: tokenName ?? null, fixed_group: group ?? null });
      }
      return { transitioned, ratioBackfilled };
    });
    const segments = await this.listSegments(ruleId);
    return { ...outcome, segments, currentSegment: segments[segments.length - 1] || null };
  }

  async reconcileCurrentSegment(ruleId, { group, ratio, currentSegmentRatio = null, detectedAt = Date.now() }) {
    const outcome = await this.#transaction("reconcileCurrentSegment", async (tx) => {
      await this.#lock(tx, `rule:${ruleId}`);
      const current = this.#segmentsOf(tx, ruleId).map(({ row }) => ({ ...row })).find((row) => row.effective_to_ms == null);
      if (!current) throw repositoryError("CURRENT_SEGMENT_MISSING");
      const currentRatio = current.group_ratio == null ? null : Number(current.group_ratio);
      const nextRatio = ratio == null ? null : Number(ratio);
      const sameGroup = current.group_name === group;
      const observedCurrentSegmentRatio = currentSegmentRatio == null ? null : Number(currentSegmentRatio);
      const ratioToBackfill = sameGroup ? nextRatio : observedCurrentSegmentRatio;
      const ratioBackfilled = currentRatio == null && ratioToBackfill != null;
      const ratioChanged = sameGroup && currentRatio != null && nextRatio != null && currentRatio !== nextRatio;
      if (ratioBackfilled) {
        this.#backfillRatio(tx, ruleId, current.id, ratioToBackfill, detectedAt);
        current.group_ratio = ratioToBackfill;
      }
      if (!sameGroup || ratioChanged) this.#splitSegment(tx, ruleId, current, { group, ratio, nextRatio, detectedAt });
      return { transitioned: !sameGroup || ratioChanged, ratioBackfilled };
    });
    const segments = await this.listSegments(ruleId);
    return { ...outcome, segments, currentSegment: segments[segments.length - 1] || null };
  }

  async transitionSegment(ruleId, input) {
    return (await this.reconcileCurrentSegment(ruleId, input)).segments;
  }

  async correctTransition(ruleId, segmentId, effectiveAt) {
    const at = Number(effectiveAt);
    await this.#transaction("correctTransition", async (tx) => {
      await this.#lock(tx, `rule:${ruleId}`);
      const entries = this.#segmentsOf(tx, ruleId);
      const index = entries.findIndex(({ row }) => row.id === segmentId);
      if (index <= 0) throw repositoryError("RESOURCE_CHANGED");
      const previous = entries[index - 1], next = entries[index + 1];
      if (!Number.isFinite(at) || at <= Number(previous.row.effective_from_ms) || (next && at >= Number(next.row.effective_from_ms))) {
        throw repositoryError("TRANSITION_TIME_OUT_OF_RANGE");
      }
      this.#update(tx, "segments", [previous], { effective_to_ms: at });
      this.#update(tx, "segments", [entries[index]], { effective_from_ms: at, timing_source: "operator_confirmed" });
    });
    return this.listSegments(ruleId);
  }

  async updateChannelStates(ruleId, states, observedAt = Date.now()) {
    await this.#transaction("updateChannelStates", async (tx) => {
      await this.#lock(tx, `rule:${ruleId}`);
      if (!this.#ruleEntry(tx, ruleId)) throw repositoryError("RULE_NOT_FOUND");
      for (const state of states) {
        this.log.channelStateWrites.push({ ruleId, channelId: state.channelId, state: state.state ?? null, observedAt });
        const entries = this.#rows("channels", tx).filter(({ row }) => sameText(row.rule_id, ruleId) && Number(row.channel_id) === Number(state.channelId));
        // 对应 MySQL 版的 channel_status <=> ?：状态变了才刷新 status_changed_at_ms。
        this.#update(tx, "channels", entries, (row) => ({ channel_status: state.state ?? null, status_observed_at_ms: bigint(observedAt),
          status_changed_at_ms: (row.channel_status ?? null) === (state.state ?? null) ? row.status_changed_at_ms : bigint(observedAt) }));
      }
    });
  }

  async archiveRule(id) {
    return this.#transaction("archiveRule", async (tx) => {
      await this.#lock(tx, `rule:${id}`);
      const entry = this.#ruleEntry(tx, id);
      const affected = entry ? this.#update(tx, "rules", [entry], { enabled: 0, active_token_key: null, archived_at: this.#timestamp() }) : 0;
      if (affected) {
        this.#update(tx, "channels", this.#rows("channels", tx).filter(({ row }) => sameText(row.rule_id, id)), { active_channel_key: null });
        tx.record.archivedRuleIds.push(id);
      }
      return affected > 0;
    });
  }

  async saveSnapshot(snapshot) {
    return this.#saveSnapshot(snapshot, null);
  }

  async saveSnapshotsForScope(ruleId, expectedScopeFingerprint, snapshots, { expectedOwnerState = null, guard = null, ledger = null } = {}) {
    let booked = null;
    return this.#transaction("saveSnapshotsForScope", async (tx) => {
      // 和 MySQL 仓库一样只锁同一把 Key 的绑定（按 id 排好依次锁），锁内再比
      if (expectedOwnerState != null) {
        const group = () => this.#rows("rules", tx).map(({ row }) => row)
          .filter((row) => row.archived_at == null && Number(row.token_id) === Number(expectedOwnerState.tokenId)).sort((a, b) => compareText(a.id, b.id));
        for (const row of group()) await this.#lock(tx, `rule:${row.id}`);
        if (reconciliationOwnerRuleState(group().map((row) => ruleFromRow(row))) !== expectedOwnerState.state) return this.#abort(tx, false);
      }
      await this.#lock(tx, `rule:${ruleId}`);
      const entry = this.#ruleEntry(tx, ruleId);
      if (!entry) return false;
      const rule = ruleFromRow(entry.row, this.#channelsOf(tx, ruleId));
      if (reconciliationScopeFingerprint(rule, this.#segmentsOf(tx, ruleId).map(({ row }) => segmentFromRow(row))) !== expectedScopeFingerprint) return false;
      if (guard && !guard()) return this.#abort(tx, false);
      for (const snapshot of snapshots) {
        const existing = this.#snapshotEntry(tx, ruleId, snapshot.snapshotKey);
        const savedSource = asJson(existing?.row.source);
        const incomingSource = snapshot.source || null;
        const savedEnd = snapshotLogicalEnd(savedSource);
        const incomingEnd = snapshotLogicalEnd(incomingSource);
        const sameRecordType = savedSource?.recordType && savedSource.recordType === incomingSource?.recordType;
        if (sameRecordType && (savedEnd > incomingEnd
          || (savedEnd === incomingEnd && snapshotGeneratedAt(savedSource) > snapshotGeneratedAt(incomingSource)))) continue;
        await this.#saveSnapshot(snapshot, tx);
      }
      if (ledger?.entry) {
        const top = this.#ledgerOf(tx, ruleId, ledger.entry.billDate)[0];
        booked = ledgerWriteDecision(top ? ledgerEntryFromRow(ledgerRead(top)) : null, ledger.entry, { resettle: ledger.resettle });
        if (booked.write) {
          const values = ledgerInsertValues({ ...ledger.entry, ruleId, revision: booked.revision, source: booked.source });
          const row = Object.fromEntries(RECONCILIATION_LEDGER_COLUMNS.map((column, index) => [column, values[index]]));
          this.log.ledgerWrites.push({ ruleId, billDate: row.bill_date, revision: row.revision, source: row.source });
          this.#insert(tx, "ledger", row);
        }
      }
      if (guard && !guard()) return this.#abort(tx, false);
      if (booked) ledger.booked = booked;
      return true;
    });
  }

  async getAlertState(ruleId, eventCode) {
    this.log.alertCalls.push({ method: "getAlertState", ruleId, eventCode });
    await this.#read("getAlertState", [ruleId, eventCode]);
    const row = this.#alertEntry(ruleId, eventCode)?.row;
    return row ? fresh(row) : null;
  }

  async setAlertState(ruleId, eventCode, next) {
    this.log.alertCalls.push({ method: "setAlertState", ruleId, eventCode, next });
    const values = {
      active: next.active ? 1 : 0, first_seen_at: bigint(next.firstSeenAt), last_seen_at: bigint(next.lastSeenAt),
      last_notified_at: bigint(next.lastNotifiedAt), recovered_at: bigint(next.recoveredAt),
    };
    const existing = this.#alertEntry(ruleId, eventCode);
    if (existing) this.#update(null, "alerts", [existing], values);
    else this.#insert(null, "alerts", { rule_id: ruleId, event_code: eventCode, ...values });
  }

  async clearActiveAlerts(ruleId, recoveredAt) {
    this.log.alertCalls.push({ method: "clearActiveAlerts", ruleId, recoveredAt });
    const active = this.#rows("alerts").filter(({ row }) => sameText(row.rule_id, ruleId) && Number(row.active) === 1);
    this.#update(null, "alerts", active, { active: 0, recovered_at: bigint(recoveredAt), last_seen_at: bigint(recoveredAt) });
  }

  async getBillingCapability(identity, scheme = BILLING_CAPABILITY_IDENTITY_SCHEME) {
    await this.#read("getBillingCapability", [identity]);
    const row = this.#capabilityEntry(identity)?.row;
    return row && sameText(row.identity_scheme ?? LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME, scheme) ? fresh(row).capability : null;
  }

  async saveBillingCapability(identity, capability, scheme = BILLING_CAPABILITY_IDENTITY_SCHEME) {
    await this.hooks.beforeCapabilityWrite?.("saveBillingCapability", identity);
    this.log.capabilityWrites.push({ method: "saveBillingCapability", identity, capability: structuredClone(capability) });
    const values = { capability: JSON.stringify(capability), verified_at: bigint(capability.verifiedAt), identity_scheme: scheme };
    const existing = this.#capabilityEntry(identity);
    if (existing) this.#update(null, "capabilities", [existing], values);
    else this.#insert(null, "capabilities", { identity, ...values });
  }

  async deleteBillingCapability(identity, scheme = BILLING_CAPABILITY_IDENTITY_SCHEME) {
    await this.hooks.beforeCapabilityWrite?.("deleteBillingCapability", identity);
    this.log.capabilityWrites.push({ method: "deleteBillingCapability", identity });
    const identities = Array.isArray(identity) ? identity : [identity];
    const existing = this.#rows("capabilities").filter(({ row }) => sameText(row.identity_scheme ?? LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME, scheme)
      && identities.some((id) => sameText(row.identity, id)));
    if (existing.length) this.#delete(null, "capabilities", existing);
  }

  async latestRecord(ruleId, window, scopeFingerprint, recordType) {
    if (!scopeFingerprint) throw new Error("成功账单查询必须指定核算口径");
    await this.#read("latestRecord", [ruleId, window, scopeFingerprint, recordType]);
    const prefix = fold(reconciliationSnapshotRecordPrefix(window, scopeFingerprint, recordType));
    const rows = this.#plain("snapshots")
      .filter((row) => sameText(row.rule_id, ruleId) && sameText(row.window_kind, window.preset)
        && Number(row.window_end_ms) <= Number(window.endMs) && row.snapshot_key != null && fold(row.snapshot_key).startsWith(prefix))
      .sort((a, b) => nullsFirst(seconds(b.generated_at), seconds(a.generated_at)));
    return selectLatestRecord(rows.map(fresh), window, scopeFingerprint, recordType);
  }

  async latestSuccessfulResult(ruleId, window, scopeFingerprint) {
    return this.latestRecord(ruleId, window, scopeFingerprint, "confirmed");
  }

  async latestSettlement(ruleId, window) {
    await this.#read("latestSettlement", [ruleId, window]);
    const rows = this.#plain("snapshots")
      .filter((row) => sameText(row.rule_id, ruleId) && row.snapshot_key != null && fold(row.snapshot_key).startsWith("r3:c:")
        && Number(row.window_start_ms) >= Number(window.startMs) && Number(row.window_end_ms) <= Number(window.endMs))
      .sort((a, b) => nullsFirst(seconds(b.generated_at), seconds(a.generated_at)));
    return selectLatestRecord(rows.map(fresh), window, null, "confirmed");
  }

  async latestObservation(ruleId, window, scopeFingerprint) {
    return this.latestRecord(ruleId, window, scopeFingerprint, "observation");
  }

  async latestLedgerEntry(ruleId, window) {
    const billDate = billDayOf(window);
    if (!billDate) return null;
    await this.#read("latestLedgerEntry", [ruleId, window]);
    const top = this.#ledgerOf(null, ruleId, billDate)[0];
    const entry = top ? ledgerEntryFromRow(ledgerRead(top)) : null;
    return entry && sameReconciliationWindow(entry, window) ? entry : null;
  }

  async listLedgerHistory(ruleId, input = {}) {
    const { startMs, endMs, limit, after } = normalizeConfirmedHistoryOptions(input);
    await this.#read("listLedgerHistory", [ruleId, input]);
    const rows = this.#plain("ledger").filter((row) => sameText(row.rule_id, ruleId)
      && Number(row.window_start_ms) >= startMs && Number(row.window_end_ms) <= endMs
      && Number(row.revision) === this.#ledgerOf(null, row.rule_id, row.bill_date)[0].revision
      && (!after || row.bill_date < after[0] || (row.bill_date === after[0] && compareText(row.rule_id, after[1]) < 0)))
      .sort((a, b) => compare(b.bill_date, a.bill_date) || compareText(b.rule_id, a.rule_id)).slice(0, limit + 1);
    const entries = rows.map((row) => ledgerEntryFromRow(ledgerRead(row)));
    const page = entries.slice(0, limit);
    return { records: page.map(ledgerHistoryRecord), nextCursor: entries.length > limit ? encodeLedgerCursor(page.at(-1)) : null };
  }

  // ---- 内部：事务、锁与行操作 ----

  #timestamp() {
    return new Date(Math.floor(this.now() / 1000) * 1000);
  }

  async #read(name, args) {
    await this.hooks.beforeRead?.(name, args);
  }

  async #transaction(name, work) {
    await this.hooks.beforeTransaction?.(name);
    const tx = new MemoryTransaction(name);
    try {
      const value = await work(tx);
      if (!tx.done) await this.#commit(tx);
      return value;
    } catch (err) {
      if (!tx.done) this.#rollback(tx);
      throw err;
    }
  }

  #abort(tx, value) {
    this.#rollback(tx);
    return value;
  }

  async #commit(tx) {
    await this.hooks.beforeCommit?.(tx.record);
    try {
      // 其他事务可能已在本事务暂存之后提交了同样的唯一键，提交前再校验一次。
      for (const table of Object.keys(TABLE_NAMES)) {
        for (const { ref, row } of this.#rows(table, tx)) {
          if (tx.patches.has(ref) || tx.inserted[table].includes(ref)) this.#assertUnique(table, tx, ref, row);
        }
      }
    } catch (err) {
      this.#rollback(tx);
      throw err;
    }
    for (const [ref, patch] of tx.patches) Object.assign(ref, patch);
    for (const table of Object.keys(TABLE_NAMES)) {
      const rows = this.tables[table];
      for (let index = rows.length - 1; index >= 0; index -= 1) if (tx.deleted.has(rows[index])) rows.splice(index, 1);
      rows.push(...tx.inserted[table]);
    }
    tx.done = true;
    this.log.commits.push(tx.record);
    this.#release(tx);
    await this.hooks.afterCommit?.(tx.record);
  }

  #rollback(tx) {
    tx.done = true;
    this.log.rollbacks.push(tx.record);
    this.#release(tx);
  }

  #blocked(tx, key, waiting) {
    return this.#held.some((lock) => lock.tx !== tx && conflicts(lock.key, key))
      || waiting.some((wait) => wait.tx !== tx && conflicts(wait.key, key));
  }

  // "*" 与任何锁冲突；其余按规则 id 互斥。同一事务内可重入。
  async #lock(tx, key) {
    if (tx.locks.some((held) => held === "*" || held === key)) return;
    if (!this.#blocked(tx, key, this.#queue)) return this.#grant(tx, key);
    await new Promise((resolve) => this.#queue.push({ tx, key, resolve }));
  }

  #grant(tx, key) {
    this.#held.push({ tx, key });
    tx.locks.push(key);
  }

  #release(tx) {
    this.#held = this.#held.filter((lock) => lock.tx !== tx);
    for (let index = 0; index < this.#queue.length;) {
      const wait = this.#queue[index];
      if (this.#blocked(wait.tx, wait.key, this.#queue.slice(0, index))) { index += 1; continue; }
      this.#queue.splice(index, 1);
      this.#grant(wait.tx, wait.key);
      wait.resolve();
    }
  }

  // 事务内看到的是已提交数据叠加本事务的暂存改动；tx 为 null 时只看已提交数据。
  // 返回 { ref, row }：ref 是存储里的行，row 是当前可见的值，调用方不得修改。
  #rows(table, tx = null) {
    const rows = [];
    for (const ref of this.tables[table]) {
      if (tx?.deleted.has(ref)) continue;
      const patch = tx?.patches.get(ref);
      rows.push({ ref, row: patch ? { ...ref, ...patch } : ref });
    }
    if (tx) for (const ref of tx.inserted[table]) rows.push({ ref, row: ref });
    return rows;
  }

  #plain(table) {
    return this.tables[table].slice();
  }

  #ruleEntry(tx, id) {
    return this.#rows("rules", tx).find(({ row }) => sameText(row.id, id) && row.archived_at == null) || null;
  }

  #snapshotEntry(tx, ruleId, snapshotKey) {
    return this.#rows("snapshots", tx).find(({ row }) => sameText(row.rule_id, ruleId) && sameText(row.snapshot_key, snapshotKey)) || null;
  }

  #alertEntry(ruleId, eventCode) {
    return this.#rows("alerts").find(({ row }) => sameText(row.rule_id, ruleId) && sameText(row.event_code, eventCode)) || null;
  }

  // 某天的账本行，按 revision 倒序。
  #ledgerOf(tx, ruleId, billDate) {
    return this.#rows("ledger", tx).map(({ row }) => row).filter((row) => sameText(row.rule_id, ruleId) && row.bill_date === billDate)
      .sort((a, b) => Number(b.revision) - Number(a.revision));
  }

  #capabilityEntry(identity) {
    return this.#rows("capabilities").find(({ row }) => sameText(row.identity, identity)) || null;
  }

  // order = "name"：ORDER BY channel_name, channel_id；"id"：没有 ORDER BY 时按主键顺序。
  #channelsOf(tx, ruleId, order = "name") {
    return this.#rows("channels", tx).map(({ row }) => fresh(row)).filter((row) => sameText(row.rule_id, ruleId))
      .sort((a, b) => (order === "name" ? compareText(a.channel_name, b.channel_name) : 0) || Number(a.channel_id) - Number(b.channel_id));
  }

  // ORDER BY effective_from_ms ASC, created_at ASC, effective_to_ms IS NOT NULL DESC, effective_to_ms ASC；同值时保持插入顺序。
  #segmentsOf(tx, ruleId) {
    return this.#rows("segments", tx).filter(({ row }) => sameText(row.rule_id, ruleId))
      .sort((a, b) => Number(a.row.effective_from_ms) - Number(b.row.effective_from_ms) || nullsFirst(seconds(a.row.created_at), seconds(b.row.created_at))
        || Number(a.row.effective_to_ms == null) - Number(b.row.effective_to_ms == null) || nullsFirst(bigint(a.row.effective_to_ms), bigint(b.row.effective_to_ms)));
  }

  #insertChannel(tx, ruleId, channel, input) {
    this.#insert(tx, "channels", {
      rule_id: ruleId, channel_id: bigint(channel.channelId), channel_name: channel.name ?? null,
      active_channel_key: activeChannelKey(input, channel.channelId) ?? null,
      channel_status: null, status_observed_at_ms: null, status_changed_at_ms: null, created_at: this.#timestamp(),
    });
  }

  #backfillRatio(tx, ruleId, segmentId, ratio, observedAt) {
    this.log.ratioWrites.push({ ruleId, segmentId, ratio, observedAt });
    const entries = this.#rows("segments", tx).filter(({ row }) => sameText(row.id, segmentId) && row.group_ratio == null);
    return this.#update(tx, "segments", entries, { group_ratio: bigint(ratio), ratio_observed_at_ms: bigint(observedAt), ratio_source: "group_catalog" });
  }

  #splitSegment(tx, ruleId, current, { group, ratio, nextRatio, detectedAt }) {
    const at = Math.max(Number(detectedAt), Number(current.effective_from_ms));
    this.#update(tx, "segments", this.#rows("segments", tx).filter(({ row }) => sameText(row.id, current.id)), { effective_to_ms: at });
    const createdAt = this.#timestamp();
    this.#insert(tx, "segments", {
      id: uid("rs"), rule_id: ruleId, group_name: group ?? null, group_ratio: bigint(ratio),
      ratio_observed_at_ms: nextRatio == null ? null : bigint(detectedAt), ratio_source: nextRatio == null ? null : "group_catalog",
      effective_from_ms: at, effective_to_ms: null, detected_at_ms: at, timing_source: "detected", created_at: createdAt, updated_at: createdAt,
    });
  }

  async #saveSnapshot(snapshot, tx) {
    const source = JSON.stringify(snapshot.source || null);
    const entry = { ruleId: snapshot.ruleId, snapshotKey: snapshot.snapshotKey, source: JSON.parse(source) };
    await this.hooks.beforeSnapshotWrite?.(entry, tx?.record ?? null);
    const updated = {
      window_end_ms: bigint(snapshot.endMs), upstream_quota: snapshot.upstreamQuota ?? null, upstream_quota_per_unit: snapshot.upstreamQuotaPerUnit ?? null,
      upstream_usd: snapshot.upstreamUsd ?? null, downstream_quota: snapshot.downstreamQuota ?? null, downstream_quota_per_unit: snapshot.downstreamQuotaPerUnit ?? null,
      downstream_usd: snapshot.downstreamUsd ?? null, difference_usd: snapshot.differenceUsd ?? null, margin_rate: snapshot.marginRate ?? null,
      coverage: snapshot.coverage ?? null, health_code: snapshot.healthCode ?? null, health_detail: snapshot.healthDetail ?? null, source,
      generated_at: this.#timestamp(),
    };
    const existing = this.#snapshotEntry(tx, snapshot.ruleId, snapshot.snapshotKey);
    // ON DUPLICATE KEY UPDATE 不改 segment_id / window_kind / window_start_ms / local_date。
    if (existing) this.#update(tx, "snapshots", [existing], updated);
    else {
      this.#autoId = Math.max(this.#autoId, ...this.tables.snapshots.map((row) => Number(row.id) || 0)) + 1;
      this.#insert(tx, "snapshots", {
        id: this.#autoId, rule_id: snapshot.ruleId ?? null, segment_id: snapshot.segmentId ?? null, snapshot_key: snapshot.snapshotKey ?? null,
        window_kind: snapshot.windowKind ?? null, window_start_ms: bigint(snapshot.startMs), local_date: snapshot.localDate ?? null, ...updated,
      });
    }
    this.log.snapshotWrites.push(entry);
    tx?.record.snapshots.push(entry);
    await this.hooks.afterSnapshotWrite?.(entry, tx?.record ?? null);
    return true;
  }

  #check(table, row) {
    const { notNull, varchar } = SCHEMA[table];
    for (const [column, value] of Object.entries(row)) {
      if (value == null && notNull.includes(column)) throw sqlError("ER_BAD_NULL_ERROR", 1048, "23000", `Column '${column}' cannot be null`);
      if (value != null && varchar[column] != null && [...String(value)].length > varchar[column]) {
        throw sqlError("ER_DATA_TOO_LONG", 1406, "22001", `Data too long for column '${column}' at row 1`);
      }
    }
  }

  #assertUnique(table, tx, ref, row) {
    for (const [name, columns] of Object.entries(SCHEMA[table].keys)) {
      const parts = columns.map((column) => row[column]);
      if (parts.some((part) => part == null)) continue;
      const clash = this.#rows(table, tx).some((other) => other.ref !== ref && columns.every((column, index) => sameText(other.row[column], parts[index])));
      if (clash) throw sqlError("ER_DUP_ENTRY", 1062, "23000", `Duplicate entry '${parts.join("-")}' for key '${TABLE_NAMES[table]}.${name}'`);
    }
  }

  #insert(tx, table, row) {
    this.#check(table, row);
    this.#assertUnique(table, tx, row, row);
    (tx ? tx.inserted[table] : this.tables[table]).push(row);
    return row;
  }

  // patch 可以是对象，或按当前行计算的函数；返回匹配的行数。
  #update(tx, table, entries, patch) {
    const onUpdate = SCHEMA[table].onUpdate;
    for (const { ref, row } of entries) {
      // patch 里值为 undefined 的列表示保持原值。
      let next = Object.fromEntries(Object.entries(typeof patch === "function" ? patch(row) : patch).filter(([, value]) => value !== undefined));
      this.#check(table, next);
      const changed = Object.entries(next).some(([column, value]) => !sameValue(column, row[column], value));
      if (changed && onUpdate && !(onUpdate in next)) next = { ...next, [onUpdate]: this.#timestamp() };
      this.#assertUnique(table, tx, ref, { ...row, ...next });
      if (!tx || tx.inserted[table].includes(ref)) Object.assign(ref, next);
      else tx.patches.set(ref, { ...tx.patches.get(ref), ...next });
    }
    return entries.length;
  }

  #delete(tx, table, entries) {
    for (const { ref } of entries) {
      const inserted = tx?.inserted[table];
      if (!tx) this.tables[table].splice(this.tables[table].indexOf(ref), 1);
      else if (inserted.includes(ref)) inserted.splice(inserted.indexOf(ref), 1);
      else {
        tx.deleted.add(ref);
        tx.patches.delete(ref);
      }
    }
  }
}
