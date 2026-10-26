// 上游渠道对账的持久化层：只保存规则、聚合快照、告警状态和账单能力核验结果，绝不复制站点凭据。
import { isCurrentReconciliationBillingContract, isLiveReconciliationPreset, normalizeSuccessfulResult, sameReconciliationWindow } from "../lib/reconciliation-contract.js";
import { reconciliationScopeFingerprint, reconciliationSnapshotRecordPrefix } from "../lib/reconciliation-snapshot.js";
import { RECONCILIATION_LEDGER_COLUMNS, decodeLedgerCursor, encodeLedgerCursor, ledgerEntryFromRow, ledgerHistoryRecord,
  ledgerInsertValues, ledgerWriteDecision } from "../lib/reconciliation-ledger.js";
import { accountingFloorFor, applyScopePolicy, isScopedBillingPolicy, normalizeRuleSourceBinding, serializeRuleSourceBinding } from "../lib/reconciliation-scope-policy.js";
import { RESETTLE_KEPT_REASONS, RESETTLE_REASON_TRANSITION, isSettledAt, resettleRequestPlan } from "../lib/reconciliation-settlement.js";
import { billDayOf } from "../lib/business-time.js";
import { BILLING_CAPABILITY_IDENTITY_SCHEME } from "../lib/billing-capability-storage.js";

// MySQL 版和测试用的内存版（server/test-support）抛同一个码、同一句话；页面按码归类成用户看的话（lib/error-copy.js），这里的话只给开发看
const REPOSITORY_ERRORS = Object.freeze({
  RULE_NOT_FOUND: "这条绑定已解除",
  CURRENT_SEGMENT_MISSING: "这条绑定缺少当前的倍率时段",
  RESOURCE_CHANGED: "这一段前面没有倍率变化，不能改时间",
  TRANSITION_TIME_OUT_OF_RANGE: "改的时间要在前后两次倍率变化之间",
  TRANSITION_TIME_IN_FUTURE: "不能改到以后的时间",
  SOURCE_BINDING_UNCONFIRMED: "上游账号或自营站点变了，请确认这条绑定",
  LEGACY_IDENTITY_UNVERIFIED: "以前的绑定没记下上游账号，请确认这条绑定的上游账号和自营站点",
});

export function repositoryError(code) {
  return Object.assign(new Error(REPOSITORY_ERRORS[code]), { code });
}

export function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

export function reconciliationOwnerRuleState(rules) {
  return JSON.stringify(rules.map((rule) => [rule.id, rule.upstreamStationId, rule.ownStationId, rule.tokenId, rule.enabled])
    .sort(([a], [b]) => a.localeCompare(b)));
}

// 一条绑定的成本主人只看 token_id 相同的绑定（server/reconciliation.js 的 costOwnerFor）：写快照时只核对、只锁这一组（计划 P1c）
export function reconciliationOwnerScope(rules, tokenId) {
  const id = Number(tokenId);
  return { tokenId: id, state: reconciliationOwnerRuleState(rules.filter((rule) => Number(rule.tokenId) === id)) };
}

export function asJson(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

export function activeTokenKey(input) {
  return input.enabled === false ? null : input.canonicalKey || `${input.upstreamStationId}:${input.tokenId}`;
}

export function activeChannelKey(input, channelId) {
  return input.enabled === false ? null : `${input.ownStationId}:${channelId}`;
}

// 已解除的绑定只许记账本、而且这天开始早于解除时刻（New API 解除当天的账本行窗口仍是整天，金额只算到解除时刻；Sub2API 解除当天不结，由取数那边挡）
export function archivedLedgerAllowed(rule, ledger) {
  const archivedAt = rule.archivedAtMs;
  return Number.isFinite(archivedAt) && Number.isFinite(Number(ledger?.entry?.startMs)) && Number(ledger.entry.startMs) < archivedAt;
}

export function ruleFromRow(row, channels = []) {
  return {
    id: row.id,
    upstreamStationId: row.upstream_station_id,
    ownStationId: row.own_station_id,
    tokenId: Number(row.token_id),
    tokenName: row.token_name,
    fixedGroup: row.fixed_group,
    timezone: row.timezone,
    enabled: !!row.enabled,
    billingPolicy: row.billing_policy || "legacy-v3",
    scopeVersion: Number(row.scope_version || 1),
    billingEffectiveFrom: row.billing_effective_from_ms == null ? null : Number(row.billing_effective_from_ms),
    accountingFloorMs: row.accounting_floor_ms == null ? null : Number(row.accounting_floor_ms),
    costCoverage: row.cost_coverage || "unknown",
    provider: row.provider || null,
    canonicalKey: row.canonical_key || null,
    ...normalizeRuleSourceBinding(row.source_binding, row.cost_coverage || "unknown"),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    // 解除时刻（毫秒）：新写的行由进程写；回填前的旧行读不到时退回 archived_at
    archivedAtMs: row.archived_at_ms != null ? Number(row.archived_at_ms) : row.archived_at ? new Date(row.archived_at).getTime() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    channels: channels.map((channel) => ({
      channelId: Number(channel.channel_id),
      name: channel.channel_name,
      state: channel.channel_status || null,
      stateObservedAt: channel.status_observed_at_ms == null ? null : Number(channel.status_observed_at_ms),
      stateChangedAt: channel.status_changed_at_ms == null ? null : Number(channel.status_changed_at_ms),
    })),
  };
}

export function segmentFromRow(row) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    group: row.group_name,
    ratio: row.group_ratio == null ? null : Number(row.group_ratio),
    ratioObservedAt: row.ratio_observed_at_ms == null ? null : Number(row.ratio_observed_at_ms),
    ratioSource: row.ratio_source || null,
    effectiveFrom: Number(row.effective_from_ms),
    effectiveTo: row.effective_to_ms == null ? null : Number(row.effective_to_ms),
    detectedAt: Number(row.detected_at_ms),
    timingSource: row.timing_source,
  };
}

export function isConfirmedSnapshotSource(source) {
  return source?.recordType === "confirmed" && source?.result?.calculation?.profitUsd != null;
}

export function isObservationSnapshotSource(source) {
  return source?.recordType === "observation";
}

export function snapshotLogicalEnd(source) {
  const endMs = Number(source?.window?.endMs);
  return Number.isFinite(endMs) ? endMs : null;
}

export function snapshotGeneratedAt(source) {
  return String(source?.resultGeneratedAt || "");
}

// 结账记录只认已结束的整天窗口，而且生成在窗口结束满等待期以后；旧版本把今天的半天、近 7 天也写成过 confirmed，读取时一并排除。
// 和读侧、迁移同一个判断（lib/reconciliation-settlement.js 的 isSettledAt）。没存生成时刻的记录，selectLatestRecord 已经先筛掉了，
// 走不到这里；now 只是没有生成时刻时的兜底。
export function isSettledConfirmedSource(source, window = source?.window, now = Date.now()) {
  return !!window && isSettledAt({ startMs: Number(window.startMs), endMs: Number(window.endMs), timezone: window.timezone }, source?.resultGeneratedAt, now);
}

// latestRecord 在 SQL 粗筛之后的判定：只认当前账单合同、同一口径、同一窗口的记录，取最新生成的一条。
// scopeFingerprint 为 null（latestSettlement）时不限口径和查询方式，只认起止和时区都相同的窗口。
// 这里问的是「旧记录还能不能用」：实时预设允许记录截止得更早，不是两段窗口相等，所以不用 sameReconciliationWindow。
export function selectLatestRecord(rows, window, scopeFingerprint, recordType) {
  const anyScope = scopeFingerprint == null;
  const exact = rows.map((row) => {
    const source = asJson(row.source);
    return { row, source, result: normalizeSuccessfulResult(source?.result, row.health_code) };
  }).filter(({ source, result }) => {
    const saved = source?.window;
    if (!isCurrentReconciliationBillingContract(source)
      || (!anyScope && source?.scopeFingerprint !== scopeFingerprint) || !source?.result || !source?.resultGeneratedAt || !saved
      || (!anyScope && saved.preset !== window.preset)
      || Number(saved.startMs) !== Number(window.startMs) || saved.timezone !== window.timezone) return false;
    if (recordType === "confirmed" ? !isConfirmedSnapshotSource(source) : !isObservationSnapshotSource(source)) return false;
    const sameWindow = !anyScope && isLiveReconciliationPreset(window.preset)
      ? Number(saved.endMs) <= Number(window.endMs)
      : Number(saved.endMs) === Number(window.endMs);
    return sameWindow && (recordType !== "confirmed" || (result?.calculation?.profitUsd != null && isSettledConfirmedSource(source)));
  });
  if (!exact.length) return null;
  const latest = exact.reduce((current, candidate) => String(candidate.source.resultGeneratedAt) > String(current.source.resultGeneratedAt) ? candidate : current);
  const savedWindow = latest.source.window;
  return {
    generatedAt: latest.source.resultGeneratedAt,
    result: {
      ...latest.result,
      ownSource: latest.result.ownSource || latest.source.ruleEvidence?.ownSource || latest.source.scopePolicy?.ownSource || null,
      window: savedWindow,
      requestedWindow: latest.source.result.requestedWindow || savedWindow,
      lastSuccessfulWindow: recordType === "confirmed" ? latest.source.result.lastSuccessfulWindow || savedWindow : latest.source.result.lastSuccessfulWindow ?? null,
    },
  };
}

export function normalizeConfirmedHistoryOptions(input = {}, now = Date.now()) {
  const invalid = () => Object.assign(new Error("历史日期范围、数量或游标无效"), { code: "INVALID_REQUEST" });
  const endMs = input.endMs == null ? now : Number(input.endMs);
  const startMs = input.startMs == null ? endMs - 31 * 86400000 : Number(input.startMs);
  const requestedLimit = input.limit == null ? 20 : Number(input.limit);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs || endMs - startMs > 31 * 86400000
    || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || input.startMs === "" || input.endMs === "" || input.limit === "") throw invalid();
  const after = input.cursor == null ? null : decodeLedgerCursor(input.cursor);
  if (input.cursor != null && !after) throw invalid();
  return { startMs, endMs, limit: Math.min(50, requestedLimit), cursor: input.cursor ?? null, after };
}

// 结账状态表的读写（计划 C2a），MySQL 和内存两个仓库共用
const SETTLEMENT_STATE_SELECT = ["rule_id", "DATE_FORMAT(bill_date, '%Y-%m-%d') AS bill_date", "retry_reason", "manual_reason", "manual_since_ms", "attempts",
  "next_attempt_at_ms", "first_failed_at_ms", "last_attempt_at_ms", "resettle_requested_at_ms", "resettle_reason", "source_version", "last_detail"].join(", ");
export const SETTLEMENT_STATE_WRITE_COLUMNS = Object.freeze(["retry_reason", "manual_reason", "manual_since_ms", "attempts", "next_attempt_at_ms",
  "first_failed_at_ms", "last_attempt_at_ms", "source_version", "last_detail"]);

const msOrNull = (value) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);

export function settlementStateFromRow(row) {
  return {
    ruleId: row.rule_id, billDate: typeof row.bill_date === "string" ? row.bill_date : billDateText(row.bill_date),
    retryReason: row.retry_reason ?? null, manualReason: row.manual_reason ?? null, manualSince: msOrNull(row.manual_since_ms),
    attempts: Number(row.attempts) || 0, nextAttemptAt: msOrNull(row.next_attempt_at_ms), firstFailedAt: msOrNull(row.first_failed_at_ms),
    lastAttemptAt: msOrNull(row.last_attempt_at_ms), resettleRequestedAt: msOrNull(row.resettle_requested_at_ms), resettleReason: row.resettle_reason ?? null,
    sourceVersion: row.source_version ?? null, detail: asJson(row.last_detail),
  };
}

// settlementOutcome 的 state（op 是 retry / manual / sticky）按 SETTLEMENT_STATE_WRITE_COLUMNS 的顺序给出要写的值
export function settlementStateValues(state) {
  const retry = state.op === "retry";
  return [retry ? state.reason : null, retry ? null : state.reason, retry ? null : msOrNull(state.manualSince), Number(state.attempts) || 0,
    msOrNull(state.nextAttemptAt), msOrNull(state.firstFailedAt), msOrNull(state.lastAttemptAt), state.sourceVersion ?? null,
    JSON.stringify(state.detail ?? null)];
}

function billDateText(value) {
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  return String(value ?? "");
}

// 记账时读最新一版只为比内容和带回固定时刻（ledgerWriteDecision）：不读 detail 这类大列
const LEDGER_DECISION_SELECT = ["revision", "source", "timezone", "window_start_ms", "window_end_ms", "revenue_usd", "cost_usd",
  "revenue_rate", "cost_rate", "cost_basis", "DATE_FORMAT(settled_at, '%Y-%m-%d %H:%i:%s.%f') AS settled_at"].join(", ");
const LEDGER_SELECT = RECONCILIATION_LEDGER_COLUMNS.map((column) => column === "bill_date" ? "DATE_FORMAT(bill_date, '%Y-%m-%d') AS bill_date"
  : column === "settled_at" ? "DATE_FORMAT(settled_at, '%Y-%m-%d %H:%i:%s.%f') AS settled_at" : column).join(", ");

export class ReconciliationRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listRules({ includeArchived = false } = {}) {
    const [rows] = await this.pool.query(
      `SELECT * FROM reconciliation_rules ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY enabled DESC, updated_at DESC`
    );
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [channelRows] = await this.pool.query(
      "SELECT rule_id, channel_id, channel_name, channel_status, status_observed_at_ms, status_changed_at_ms FROM reconciliation_rule_channels WHERE rule_id IN (?) ORDER BY channel_name, channel_id",
      [ids]
    );
    const grouped = new Map();
    for (const channel of channelRows) {
      const list = grouped.get(channel.rule_id) || [];
      list.push(channel);
      grouped.set(channel.rule_id, list);
    }
    return rows.map((row) => ruleFromRow(row, grouped.get(row.id) || []));
  }

  // 最近解除的绑定（解除时刻 ≥ sinceMs）：只有锚定过的（有 canonicalKey，解除前这把 Key 只有它在用）才回看解除前的日子（计划 C3 4.1）
  async listRecentlyArchivedRules(sinceMs) {
    const [rows] = await this.pool.query(
      // enabled = 0 AND archived_at >= …：走 idx_reconciliation_enabled(enabled, archived_at)，不扫全表（已解除的行只增不减）；archived_at 是 DATETIME，
      // 多放宽一天免得时区偏差漏掉，精确的比较用毫秒那一列
      "SELECT * FROM reconciliation_rules WHERE enabled = 0 AND archived_at >= FROM_UNIXTIME(?) AND archived_at_ms >= ? AND canonical_key IS NOT NULL ORDER BY archived_at_ms DESC",
      [Math.floor(sinceMs / 1000) - 86400, sinceMs]);
    if (!rows.length) return [];
    const [channelRows] = await this.pool.query(
      "SELECT rule_id, channel_id, channel_name, channel_status, status_observed_at_ms, status_changed_at_ms FROM reconciliation_rule_channels WHERE rule_id IN (?) ORDER BY channel_name, channel_id",
      [rows.map((row) => row.id)]);
    return rows.map((row) => ruleFromRow(row, channelRows.filter((channel) => channel.rule_id === row.id)));
  }

  async getRule(id, { includeArchived = false } = {}) {
    const [rows] = await this.pool.query(
      `SELECT * FROM reconciliation_rules WHERE id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}`,
      [id]
    );
    if (!rows.length) return null;
    const [channels] = await this.pool.query(
      "SELECT rule_id, channel_id, channel_name, channel_status, status_observed_at_ms, status_changed_at_ms FROM reconciliation_rule_channels WHERE rule_id = ? ORDER BY channel_name, channel_id",
      [id]
    );
    return ruleFromRow(rows[0], channels);
  }

  async findChannelConflicts(channelIds, { excludeRuleId = null } = {}) {
    if (!channelIds.length) return [];
    const params = [channelIds];
    let exclusion = "";
    if (excludeRuleId) {
      exclusion = " AND r.id <> ?";
      params.push(excludeRuleId);
    }
    const [rows] = await this.pool.query(
      `SELECT DISTINCT r.id, r.token_name, r.fixed_group, c.channel_id
       FROM reconciliation_rules r
       JOIN reconciliation_rule_channels c ON c.rule_id = r.id
       WHERE r.enabled = 1 AND r.archived_at IS NULL AND c.channel_id IN (?)${exclusion}`,
      params
    );
    return rows.map((row) => ({
      ruleId: row.id,
      tokenName: row.token_name,
      fixedGroup: row.fixed_group,
      channelId: Number(row.channel_id),
    }));
  }

  async findTokenConflict(upstreamStationId, tokenId, { excludeRuleId = null } = {}) {
    const params = [upstreamStationId, tokenId];
    let exclusion = "";
    if (excludeRuleId) {
      exclusion = " AND id <> ?";
      params.push(excludeRuleId);
    }
    const [rows] = await this.pool.query(
      `SELECT id, token_name, fixed_group
       FROM reconciliation_rules
       WHERE upstream_station_id = ? AND token_id = ? AND enabled = 1 AND archived_at IS NULL${exclusion}
       LIMIT 1`,
      params
    );
    return rows.length ? {
      ruleId: rows[0].id,
      tokenName: rows[0].token_name,
      fixedGroup: rows[0].fixed_group,
    } : null;
  }

  async createRule(input, { guard = null } = {}) {
    const requested = input;
    const id = uid("rr");
    const tokenKey = activeTokenKey(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      if (isScopedBillingPolicy(input.billingPolicy)) input = applyScopePolicy(null, input);
      if (guard) guard(null, [], input);
      // 同一天里更早解除的占着同一个渠道（或同一把 Key）的 New API 绑定：新绑定从那一刻起算（C3）
      let accountingFloor = null;
      if (isScopedBillingPolicy(input.billingPolicy) && Number.isFinite(input.billingEffectiveFrom)) {
        const dayAgo = input.billingEffectiveFrom - 36 * 3600000;
        const [oldRows] = await conn.query(
          "SELECT * FROM reconciliation_rules WHERE enabled = 0 AND archived_at >= FROM_UNIXTIME(?) AND archived_at_ms >= ? AND own_station_id = ?",
          [Math.floor(dayAgo / 1000), dayAgo, input.ownStationId]);
        if (oldRows.some((row) => row.archived_at_ms != null)) {
          const [oldChannels] = await conn.query("SELECT rule_id, channel_id, channel_name FROM reconciliation_rule_channels WHERE rule_id IN (?)", [oldRows.filter((row) => row.archived_at_ms != null).map((row) => row.id)]);
          accountingFloor = accountingFloorFor({ timezone: input.timezone, effectiveFrom: input.billingEffectiveFrom, ownStationId: input.ownStationId, canonicalKey: input.canonicalKey, channels: input.channels, provider: input.provider },
            oldRows.filter((row) => row.archived_at_ms != null).map((row) => ruleFromRow(row, oldChannels.filter((channel) => channel.rule_id === row.id))));
        }
      }
      await conn.query(
        `INSERT INTO reconciliation_rules
          (id, upstream_station_id, own_station_id, token_id, token_name, fixed_group, timezone, enabled, active_token_key,
           billing_policy, scope_version, billing_effective_from_ms, cost_coverage, provider, canonical_key, source_binding, accounting_floor_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.upstreamStationId, input.ownStationId, input.tokenId, input.tokenName,
          input.fixedGroup, input.timezone, input.enabled === false ? 0 : 1, tokenKey,
          input.billingPolicy || "legacy-v3", input.scopeVersion || 1, input.billingEffectiveFrom ?? null,
          input.costCoverage || "unknown", input.provider || null, input.canonicalKey || null, JSON.stringify(serializeRuleSourceBinding(input)), accountingFloor]
      );
      if (input.channels.length) {
        await conn.query(
          "INSERT INTO reconciliation_rule_channels (rule_id, channel_id, channel_name, active_channel_key) VALUES ?",
          [input.channels.map((channel) => [id, channel.channelId, channel.name, activeChannelKey(input, channel.channelId)])]
        );
      }
      await conn.query(
        `INSERT INTO reconciliation_rule_segments
          (id, rule_id, group_name, group_ratio, ratio_observed_at_ms, ratio_source, effective_from_ms, detected_at_ms, timing_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'operator_confirmed')`,
        [uid("rs"), id, input.fixedGroup, input.initialRatio ?? null, input.initialRatio == null ? null : Date.now(), input.initialRatio == null ? null : "group_catalog", Number(input.initialEffectiveFromMs ?? (isScopedBillingPolicy(input.billingPolicy) ? 0 : Date.now())), Date.now()]
      );
      if (guard) guard(null, [], isScopedBillingPolicy(input.billingPolicy) ? applyScopePolicy(null, requested) : input);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    return this.getRule(id);
  }

  async updateRule(id, input, { append = false, guard = null } = {}) {
    const requested = input;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query("SELECT * FROM reconciliation_rules WHERE id = ? AND archived_at IS NULL FOR UPDATE", [id]);
      if (!rows.length) throw repositoryError("RULE_NOT_FOUND");
      const [channelRows] = await conn.query("SELECT * FROM reconciliation_rule_channels WHERE rule_id = ? FOR UPDATE", [id]);
      const existing = ruleFromRow(rows[0], channelRows);
      input = applyScopePolicy(existing, input, Date.now(), { append });
      if (guard) guard(existing, existing.channels, input);
      const tokenKey = activeTokenKey(input);
      const [result] = await conn.query(
        `UPDATE reconciliation_rules
         SET upstream_station_id = ?, own_station_id = ?, token_id = ?, token_name = ?, fixed_group = ?, timezone = ?, enabled = ?, active_token_key = ?,
             billing_policy = ?, scope_version = ?, billing_effective_from_ms = ?, cost_coverage = ?, provider = ?, canonical_key = ?, source_binding = ?
         WHERE id = ? AND archived_at IS NULL`,
        [input.upstreamStationId, input.ownStationId, input.tokenId, input.tokenName,
          input.fixedGroup, input.timezone, input.enabled === false ? 0 : 1, tokenKey,
          input.billingPolicy, input.scopeVersion, input.billingEffectiveFrom, input.costCoverage,
          input.provider, input.canonicalKey, JSON.stringify(serializeRuleSourceBinding(input)), id]
      );
      if (!result.affectedRows) throw repositoryError("RULE_NOT_FOUND");
      // 保留仍在关联里的渠道行（连同已观测到的状态列），只删掉移除的、插入新增的。
      const kept = new Set(channelRows.map((row) => Number(row.channel_id)));
      const channelIds = input.channels.map((channel) => Number(channel.channelId));
      await conn.query(channelIds.length ? "DELETE FROM reconciliation_rule_channels WHERE rule_id = ? AND channel_id NOT IN (?)"
        : "DELETE FROM reconciliation_rule_channels WHERE rule_id = ?", channelIds.length ? [id, channelIds] : [id]);
      for (const channel of input.channels.filter((item) => kept.has(Number(item.channelId)))) await conn.query(
        "UPDATE reconciliation_rule_channels SET channel_name = ?, active_channel_key = ? WHERE rule_id = ? AND channel_id = ?",
        [channel.name, activeChannelKey(input, channel.channelId), id, channel.channelId]
      );
      const added = input.channels.filter((channel) => !kept.has(Number(channel.channelId)));
      if (added.length) {
        await conn.query(
          "INSERT INTO reconciliation_rule_channels (rule_id, channel_id, channel_name, active_channel_key) VALUES ?",
          [added.map((channel) => [id, channel.channelId, channel.name, activeChannelKey(input, channel.channelId)])]
        );
      }
      if (guard) guard(existing, existing.channels, applyScopePolicy(existing, requested, Date.now(), { append }));
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    return this.getRule(id);
  }

  async appendChannels(id, channels, confirmation = {}, { guard = null } = {}) {
    return this.updateRule(id, { channels, ...confirmation }, { append: true, guard });
  }

  async anchorRuleIdentity(id, { provider, canonicalKey, ownSource }, { expectedScopeFingerprint, allowInitialAnchoring = false } = {}) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query("SELECT * FROM reconciliation_rules WHERE id = ? AND archived_at IS NULL FOR UPDATE", [id]);
      if (!rows.length) { await conn.commit(); return null; }
      const [channels] = await conn.query("SELECT * FROM reconciliation_rule_channels WHERE rule_id = ? FOR UPDATE", [id]);
      const [segments] = await conn.query("SELECT * FROM reconciliation_rule_segments WHERE rule_id = ? ORDER BY effective_from_ms ASC, created_at ASC, effective_to_ms IS NOT NULL DESC, effective_to_ms ASC FOR UPDATE", [id]);
      const rule = ruleFromRow(rows[0], channels);
      if (reconciliationScopeFingerprint(rule, segments.map(segmentFromRow)) !== expectedScopeFingerprint) { await conn.commit(); return null; }
      if ((rule.canonicalKey && rule.canonicalKey !== canonicalKey) || (rule.ownSource && rule.ownSource.namespaceKey !== ownSource?.namespaceKey)) {
        throw repositoryError("SOURCE_BINDING_UNCONFIRMED");
      }
      if (!rule.canonicalKey || !rule.ownSource) {
        const [history] = await conn.query("SELECT source FROM reconciliation_snapshots WHERE rule_id = ? ORDER BY generated_at DESC LIMIT 1", [id]);
        const source = asJson(history[0]?.source);
        const original = source?.ruleEvidence || source?.scopePolicy;
        const originalMatches = original?.canonicalKey === canonicalKey && original?.ownSource?.namespaceKey === ownSource?.namespaceKey;
        const observed = channels.some((channel) => channel.status_observed_at_ms != null) || segments.some((segment) => segment.timing_source === "detected"
          || (segment.ratio_source === "group_catalog" && Number(segment.ratio_observed_at_ms) > Number(segment.effective_from_ms)));
        if (!originalMatches && !(allowInitialAnchoring && !history.length && !observed)) {
          throw repositoryError("LEGACY_IDENTITY_UNVERIFIED");
        }
        await conn.query("UPDATE reconciliation_rules SET provider = ?, canonical_key = ?, source_binding = ? WHERE id = ? AND archived_at IS NULL",
          [rule.provider || provider, rule.canonicalKey || canonicalKey, JSON.stringify(serializeRuleSourceBinding({ ...rule, ownSource: rule.ownSource || ownSource })), id]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally { conn.release(); }
    return this.getRule(id);
  }

  // 切换检测得比当前分段起点还早时，旧分段收成零长度，和新分段同一起点、常在同一秒创建；
  // 各处都按起点、创建时间排序后让未结束的分段排最后，「最后一段」才总是当前分段。
  async listSegments(ruleId) {
    const [rows] = await this.pool.query(
      `SELECT * FROM reconciliation_rule_segments
       WHERE rule_id = ? ORDER BY effective_from_ms ASC, created_at ASC, effective_to_ms IS NOT NULL DESC, effective_to_ms ASC`,
      [ruleId]
    );
    return rows.map(segmentFromRow);
  }

  async backfillMissingSegmentRatios(ruleId, groups, observedAt = Date.now(), segments = null) {
    const knownRatios = new Map(Object.entries(groups || {}).flatMap(([name, group]) => {
      const ratio = Number(group?.ratio);
      return group?.ratio != null && Number.isFinite(ratio) ? [[name, ratio]] : [];
    }));
    const existing = segments || await this.listSegments(ruleId);
    if (!existing.some((segment) => segment.ratio == null && knownRatios.has(segment.group))) return 0;

    const conn = await this.pool.getConnection();
    let updated = 0;
    try {
      await conn.beginTransaction();
      await conn.query("SELECT id FROM reconciliation_rules WHERE id = ? AND archived_at IS NULL FOR UPDATE", [ruleId]);
      const [rows] = await conn.query(
        `SELECT * FROM reconciliation_rule_segments
         WHERE rule_id = ? ORDER BY effective_from_ms ASC, created_at ASC, effective_to_ms IS NOT NULL DESC, effective_to_ms ASC FOR UPDATE`,
        [ruleId]
      );
      for (const row of rows) {
        const ratio = knownRatios.get(row.group_name);
        if (row.group_ratio != null || ratio == null || !Number.isFinite(ratio)) continue;
        const [result] = await conn.query(
          "UPDATE reconciliation_rule_segments SET group_ratio = ?, ratio_observed_at_ms = ?, ratio_source = 'group_catalog' WHERE id = ? AND group_ratio IS NULL",
          [ratio, observedAt, row.id]
        );
        updated += Number(result.affectedRows || 0);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally { conn.release(); }
    return updated;
  }

  // Metadata observation is one historical fact: ratio backfills, a possible
  // segment transition, and the rule's current group must commit together.
  async observeSource(ruleId, { groups, group, ratio, tokenName, detectedAt = Date.now() }) {
    const knownRatios = new Map(Object.entries(groups || {}).flatMap(([name, item]) => {
      const value = Number(item?.ratio);
      return item?.ratio != null && Number.isFinite(value) ? [[name, value]] : [];
    }));
    const conn = await this.pool.getConnection();
    let outcome;
    try {
      await conn.beginTransaction();
      const [rules] = await conn.query(
        "SELECT id FROM reconciliation_rules WHERE id = ? AND archived_at IS NULL FOR UPDATE", [ruleId]
      );
      if (!rules.length) throw repositoryError("RULE_NOT_FOUND");
      const [rows] = await conn.query(
        `SELECT * FROM reconciliation_rule_segments
         WHERE rule_id = ? ORDER BY effective_from_ms ASC, created_at ASC, effective_to_ms IS NOT NULL DESC, effective_to_ms ASC FOR UPDATE`, [ruleId]
      );
      let ratioBackfilled = false;
      for (const row of rows) {
        const knownRatio = knownRatios.get(row.group_name);
        if (row.group_ratio != null || knownRatio == null) continue;
        const [result] = await conn.query(
          "UPDATE reconciliation_rule_segments SET group_ratio = ?, ratio_observed_at_ms = ?, ratio_source = 'group_catalog' WHERE id = ? AND group_ratio IS NULL",
          [knownRatio, detectedAt, row.id]
        );
        ratioBackfilled ||= Number(result.affectedRows || 0) > 0;
        if (Number(result.affectedRows || 0)) row.group_ratio = knownRatio;
      }
      const current = rows.find((row) => row.effective_to_ms == null);
      if (!current) throw repositoryError("CURRENT_SEGMENT_MISSING");
      const currentRatio = current.group_ratio == null ? null : Number(current.group_ratio);
      const nextRatio = ratio == null ? null : Number(ratio);
      const sameGroup = current.group_name === group;
      const observedCurrentRatio = knownRatios.get(current.group_name) ?? null;
      const ratioToBackfill = sameGroup ? nextRatio : observedCurrentRatio;
      if (currentRatio == null && ratioToBackfill != null) {
        const [result] = await conn.query(
          "UPDATE reconciliation_rule_segments SET group_ratio = ?, ratio_observed_at_ms = ?, ratio_source = 'group_catalog' WHERE id = ? AND group_ratio IS NULL",
          [ratioToBackfill, detectedAt, current.id]
        );
        ratioBackfilled ||= Number(result.affectedRows || 0) > 0;
        if (Number(result.affectedRows || 0)) current.group_ratio = ratioToBackfill;
      }
      const ratioChanged = sameGroup && currentRatio != null && nextRatio != null && currentRatio !== nextRatio;
      const transitioned = !sameGroup || ratioChanged;
      if (transitioned) {
        const at = Math.max(Number(detectedAt), Number(current.effective_from_ms));
        await conn.query("UPDATE reconciliation_rule_segments SET effective_to_ms = ? WHERE id = ?", [at, current.id]);
        await conn.query(
          `INSERT INTO reconciliation_rule_segments
            (id, rule_id, group_name, group_ratio, ratio_observed_at_ms, ratio_source, effective_from_ms, detected_at_ms, timing_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'detected')`,
          [uid("rs"), ruleId, group, ratio ?? null, nextRatio == null ? null : detectedAt, nextRatio == null ? null : "group_catalog", at, at]
        );
        await conn.query(
          "UPDATE reconciliation_rules SET token_name = ?, fixed_group = ? WHERE id = ? AND archived_at IS NULL",
          [tokenName, group, ruleId]
        );
      }
      await conn.commit();
      outcome = { transitioned, ratioBackfilled };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally { conn.release(); }
    const segments = await this.listSegments(ruleId);
    return { ...outcome, segments, currentSegment: segments[segments.length - 1] || null };
  }

  async reconcileCurrentSegment(ruleId, { group, ratio, currentSegmentRatio = null, detectedAt = Date.now() }) {
    const conn = await this.pool.getConnection();
    let outcome;
    try {
      await conn.beginTransaction();
      await conn.query("SELECT id FROM reconciliation_rules WHERE id = ? AND archived_at IS NULL FOR UPDATE", [ruleId]);
      const [rows] = await conn.query(
        `SELECT * FROM reconciliation_rule_segments
         WHERE rule_id = ? AND effective_to_ms IS NULL FOR UPDATE`, [ruleId]
      );
      const current = rows[0];
      if (!current) throw repositoryError("CURRENT_SEGMENT_MISSING");
      const currentRatio = current.group_ratio == null ? null : Number(current.group_ratio);
      const nextRatio = ratio == null ? null : Number(ratio);
      const sameGroup = current.group_name === group;
      const observedCurrentSegmentRatio = currentSegmentRatio == null ? null : Number(currentSegmentRatio);
      const ratioToBackfill = sameGroup ? nextRatio : observedCurrentSegmentRatio;
      const ratioBackfilled = currentRatio == null && ratioToBackfill != null;
      const ratioChanged = sameGroup && currentRatio != null && nextRatio != null && currentRatio !== nextRatio;
      if (ratioBackfilled) {
        await conn.query(
          "UPDATE reconciliation_rule_segments SET group_ratio = ?, ratio_observed_at_ms = ?, ratio_source = 'group_catalog' WHERE id = ? AND group_ratio IS NULL",
          [ratioToBackfill, detectedAt, current.id]
        );
        current.group_ratio = ratioToBackfill;
      }
      if (!sameGroup || ratioChanged) {
        const at = Math.max(Number(detectedAt), Number(current.effective_from_ms));
        await conn.query("UPDATE reconciliation_rule_segments SET effective_to_ms = ? WHERE id = ?", [at, current.id]);
        await conn.query(
          `INSERT INTO reconciliation_rule_segments
            (id, rule_id, group_name, group_ratio, ratio_observed_at_ms, ratio_source, effective_from_ms, detected_at_ms, timing_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'detected')`,
          [uid("rs"), ruleId, group, ratio ?? null, nextRatio == null ? null : detectedAt, nextRatio == null ? null : "group_catalog", at, at]
        );
      }
      await conn.commit();
      outcome = { transitioned: !sameGroup || ratioChanged, ratioBackfilled };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally { conn.release(); }
    const segments = await this.listSegments(ruleId);
    return { ...outcome, segments, currentSegment: segments[segments.length - 1] || null };
  }

  async transitionSegment(ruleId, input) {
    return (await this.reconcileCurrentSegment(ruleId, input)).segments;
  }

  // 改一段倍率变化的时间。同一个事务里：改分段，再给 [旧时间, 新时间) 落到的每个已结束的业务日写一条重结请求（计划 C2b，
  // resettleBillDates）；写请求失败连分段一起回滚。绑定不存在或已解除报 RULE_NOT_FOUND；改到未来、不是整毫秒的拒绝。
  async correctTransition(ruleId, segmentId, effectiveAt, { now = Date.now(), onPlan = null } = {}) {
    const at = Number(effectiveAt);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [ruleRows] = await conn.query("SELECT * FROM reconciliation_rules WHERE id = ? FOR UPDATE", [ruleId]);
      if (!ruleRows.length || ruleRows[0].archived_at) throw repositoryError("RULE_NOT_FOUND");
      const rule = ruleFromRow(ruleRows[0]);
      const [rows] = await conn.query(
        `SELECT * FROM reconciliation_rule_segments
         WHERE rule_id = ? ORDER BY effective_from_ms ASC, created_at ASC, effective_to_ms IS NOT NULL DESC, effective_to_ms ASC FOR UPDATE`,
        [ruleId]
      );
      const segments = rows.map((row) => ({
        id: row.id,
        effectiveFrom: Number(row.effective_from_ms),
      }));
      const index = segments.findIndex((segment) => segment.id === segmentId);
      if (index <= 0) throw repositoryError("RESOURCE_CHANGED");
      const previous = segments[index - 1];
      const next = segments[index + 1];
      if (Number.isSafeInteger(at) && at > now) throw repositoryError("TRANSITION_TIME_IN_FUTURE");
      if (!Number.isSafeInteger(at) || at <= previous.effectiveFrom || (next && at >= next.effectiveFrom)) {
        throw repositoryError("TRANSITION_TIME_OUT_OF_RANGE");
      }
      await conn.query(
        `UPDATE reconciliation_rule_segments
         SET effective_to_ms = CASE WHEN id = ? THEN ? ELSE effective_to_ms END,
             effective_from_ms = CASE WHEN id = ? THEN ? ELSE effective_from_ms END,
             timing_source = CASE WHEN id = ? THEN 'operator_confirmed' ELSE timing_source END
         WHERE id IN (?, ?)`,
        [previous.id, at, segmentId, at, segmentId, previous.id, segmentId]
      );
      // 31 天以内的日子写重结请求；更早的写一条要人处理的状态行（RESETTLE_TOO_OLD），不自动重结
      const plan = resettleRequestPlan(rule, segments[index].effectiveFrom, at, now);
      onPlan?.(plan); // 调用方要告诉用户哪几天会自动重算、哪几天太早没算
      await this.requestResettle(ruleId, plan.recent, { reason: RESETTLE_REASON_TRANSITION, now }, conn);
      await this.requestResettle(ruleId, plan.tooOld, { reason: RESETTLE_REASON_TRANSITION, now, manualReason: "RESETTLE_TOO_OLD" }, conn);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    return this.listSegments(ruleId);
  }

  async updateChannelStates(ruleId, states, observedAt = Date.now()) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rules] = await conn.query(
        "SELECT id FROM reconciliation_rules WHERE id = ? AND archived_at IS NULL FOR UPDATE", [ruleId]
      );
      if (!rules.length) throw repositoryError("RULE_NOT_FOUND");
      for (const state of states) await conn.query(
        `UPDATE reconciliation_rule_channels
         SET status_changed_at_ms = CASE WHEN channel_status <=> ? THEN status_changed_at_ms ELSE ? END,
             channel_status = ?, status_observed_at_ms = ?
         WHERE rule_id = ? AND channel_id = ?`,
        // SET 从左到右求值：先拿旧的 channel_status 比较，再覆盖。
        [state.state, observedAt, state.state, observedAt, ruleId, state.channelId]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally { conn.release(); }
  }

  async archiveRule(id, { now = Date.now() } = {}) {
    const conn = await this.pool.getConnection();
    let result;
    try {
      await conn.beginTransaction();
      await conn.query("SELECT id FROM reconciliation_rules WHERE id = ? AND archived_at IS NULL FOR UPDATE", [id]);
      [result] = await conn.query(
        "UPDATE reconciliation_rules SET enabled = 0, active_token_key = NULL, archived_at = NOW(), archived_at_ms = ? WHERE id = ? AND archived_at IS NULL",
        [now, id]
      );
      if (result.affectedRows) {
        await conn.query("UPDATE reconciliation_rule_channels SET active_channel_key = NULL WHERE rule_id = ?", [id]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    return result.affectedRows > 0;
  }

  async saveSnapshot(snapshot, executor = this.pool) {
    await executor.query(
      `INSERT INTO reconciliation_snapshots (
        rule_id, segment_id, snapshot_key, window_kind, window_start_ms, window_end_ms, local_date,
        upstream_quota, upstream_quota_per_unit, upstream_usd,
        downstream_quota, downstream_quota_per_unit, downstream_usd,
        difference_usd, margin_rate, coverage, health_code, health_detail, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        window_end_ms = VALUES(window_end_ms), upstream_quota = VALUES(upstream_quota),
        upstream_quota_per_unit = VALUES(upstream_quota_per_unit), upstream_usd = VALUES(upstream_usd),
        downstream_quota = VALUES(downstream_quota), downstream_quota_per_unit = VALUES(downstream_quota_per_unit),
        downstream_usd = VALUES(downstream_usd), difference_usd = VALUES(difference_usd),
        margin_rate = VALUES(margin_rate), coverage = VALUES(coverage), health_code = VALUES(health_code),
        health_detail = VALUES(health_detail), source = VALUES(source),
        generated_at = CURRENT_TIMESTAMP`,
      [snapshot.ruleId, snapshot.segmentId ?? null, snapshot.snapshotKey, snapshot.windowKind, snapshot.startMs, snapshot.endMs,
        snapshot.localDate, snapshot.upstreamQuota, snapshot.upstreamQuotaPerUnit, snapshot.upstreamUsd,
        snapshot.downstreamQuota, snapshot.downstreamQuotaPerUnit, snapshot.downstreamUsd,
        snapshot.differenceUsd, snapshot.marginRate, snapshot.coverage, snapshot.healthCode,
        snapshot.healthDetail, JSON.stringify(snapshot.source || null)]
    );
    return true;
  }

  // ledger：{ entry, resettle } 时在同一事务里记账。写不写、写第几版见 ledgerWriteDecision；提交以后把这个结论放进 ledger.booked
  // （其中 settledAt 是账本里这天最新那一版的固定时刻），调用方不用再读一次账本。
  // settlement：{ billDate, resettleRequestedAt } 时这天结成了，同一个事务里删掉结账状态表的那一行（计划 C2a），守卫失败时一起回滚；
  // 行里的重结请求时刻和 resettleRequestedAt 不同（取数期间又来了新请求）就不删（计划 C2b）。
  // archived：已解除的绑定补结解除前的日子（计划 C3），只许写账本、而且这天开始早于解除时刻；不核对同一把 Key 的绑定组（不传 expectedOwnerState）
  async saveSnapshotsForScope(ruleId, expectedScopeFingerprint, snapshots, { expectedOwnerState = null, guard = null, ledger = null, settlement = null, archived = false } = {}) {
    let booked = null;
    const conn = await this.pool.getConnection();
    try {
      // expectedOwnerState：{ tokenId, state }（reconciliationOwnerScope）。只锁同一把 Key 的绑定：先普通读出这一组的 id
      // （不加锁，走 idx_reconciliation_rule_token），再按主键锁、锁内再比一次。不直接按 token_id 加锁：二级索引上的锁定读会带间隙锁，
      // 别的 Key 的绑定插在同一间隙里就要等。
      // 停用的绑定也读：期望的指纹（reconciliationOwnerScope）是按这一组全部没解除的绑定、连同启用与否算的，两边要是同一个集合；
      // 停用的那条被重新启用，指纹里它的 enabled 变了，锁内就比得出来。只读启用的，就看不出「停用的那条刚被启用」。
      // 新加同一把 Key 的启用绑定有唯一键 active_token_key 挡着，建、改绑定也在进程内排队（serializeWrite）。
      // 这条普通读放在事务外面：事务里第一条一致性读会定下读视图，放在锁前面，下面锁内读快照就看不到等锁期间别人提交的写入了
      const [ids] = expectedOwnerState != null
        ? await conn.query("SELECT id FROM reconciliation_rules WHERE token_id = ? AND archived_at IS NULL", [expectedOwnerState.tokenId]) : [[]];
      await conn.beginTransaction();
      if (expectedOwnerState != null) {
        const [owners] = ids.length
          ? await conn.query("SELECT * FROM reconciliation_rules WHERE id IN (?) AND archived_at IS NULL ORDER BY id FOR UPDATE", [ids.map((row) => row.id)])
          : [[]];
        if (reconciliationOwnerRuleState(owners.map((row) => ruleFromRow(row))) !== expectedOwnerState.state) {
          await conn.rollback();
          return false;
        }
      }
      const [ruleRows] = await conn.query(`SELECT * FROM reconciliation_rules WHERE id = ? ${archived ? "" : "AND archived_at IS NULL"} FOR UPDATE`, [ruleId]);
      if (!ruleRows.length) {
        await conn.commit();
        return false;
      }
      if (ruleRows[0].archived_at && !(archived && archivedLedgerAllowed(ruleFromRow(ruleRows[0]), ledger))) {
        await conn.rollback();
        return false;
      }
      const [channels] = await conn.query("SELECT rule_id, channel_id, channel_name, channel_status, status_observed_at_ms, status_changed_at_ms FROM reconciliation_rule_channels WHERE rule_id = ? ORDER BY channel_name, channel_id FOR UPDATE", [ruleId]);
      const [segments] = await conn.query("SELECT * FROM reconciliation_rule_segments WHERE rule_id = ? ORDER BY effective_from_ms ASC, created_at ASC, effective_to_ms IS NOT NULL DESC, effective_to_ms ASC FOR UPDATE", [ruleId]);
      if (reconciliationScopeFingerprint(ruleFromRow(ruleRows[0], channels), segments.map(segmentFromRow)) !== expectedScopeFingerprint) {
        await conn.commit();
        return false;
      }
      if (guard && !guard()) { await conn.rollback(); return false; }
      for (const snapshot of snapshots) {
        // 规则行已 FOR UPDATE，同一规则的快照写入在这里串行；此前的查询都是锁定读，本事务的
        // read view 在这里才建立，普通一致性读就能看到已提交的写入。不对快照行加 FOR UPDATE：
        // 键不存在时 InnoDB 会加间隙锁，两条规则的事务落在同一间隙后各自插入会互相等待而死锁（1213）。
        const [existing] = await conn.query(
          "SELECT source FROM reconciliation_snapshots WHERE rule_id = ? AND snapshot_key = ?",
          [ruleId, snapshot.snapshotKey]
        );
        const savedSource = asJson(existing[0]?.source);
        const incomingSource = snapshot.source || null;
        const savedEnd = snapshotLogicalEnd(savedSource);
        const incomingEnd = snapshotLogicalEnd(incomingSource);
        const sameRecordType = savedSource?.recordType && savedSource.recordType === incomingSource?.recordType;
        if (sameRecordType && (savedEnd > incomingEnd
          || (savedEnd === incomingEnd && snapshotGeneratedAt(savedSource) > snapshotGeneratedAt(incomingSource)))) continue;
        await this.saveSnapshot(snapshot, conn);
      }
      if (ledger?.entry) {
        // 同快照：规则行锁已把同一规则的记账串行，普通读就能看到已提交的版本，不加锁避免间隙锁死锁。
        const [latest] = await conn.query(
          `SELECT ${LEDGER_DECISION_SELECT} FROM reconciliation_ledger WHERE rule_id = ? AND bill_date = ? ORDER BY revision DESC LIMIT 1`,
          [ruleId, ledger.entry.billDate]
        );
        booked = ledgerWriteDecision(latest.length ? ledgerEntryFromRow(latest[0]) : null, ledger.entry, { resettle: ledger.resettle });
        if (booked.write) {
          await conn.query(`INSERT INTO reconciliation_ledger (${RECONCILIATION_LEDGER_COLUMNS.join(", ")}) VALUES (${RECONCILIATION_LEDGER_COLUMNS.map(() => "?").join(", ")})`,
            ledgerInsertValues({ ...ledger.entry, ruleId, revision: booked.revision, source: booked.source }));
        }
      }
      if (settlement?.billDate) {
        // 请求按值比对：取数时读到的请求时刻等于行里现在的才删（没有请求的行是 NULL 对 NULL）。取数期间又来了新的重结请求，行留着
        // （写请求时已经把重试、要人处理的记录清掉了，下一轮马上再结），新请求不被这一次吃掉。还是一条 DELETE，不多发语句
        await conn.query("DELETE FROM reconciliation_settlement_state WHERE rule_id = ? AND bill_date = ? AND resettle_requested_at_ms <=> ?",
          [ruleId, settlement.billDate, settlement.resettleRequestedAt ?? null]);
      }
      if (guard && !guard()) { await conn.rollback(); return false; }
      await conn.commit();
      if (booked) ledger.booked = booked;
      return true;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally { conn.release(); }
  }

  // ---- 结账状态（计划 C2a）：每条绑定每个还没固定的日子一行 ----

  // 一轮轮询的批量读：这些绑定的全部状态行（表有上限，正常时接近空），不按绑定逐条查
  // billDates：只读这几天的行（页面查询只要选的那几天，不读全部；主键前缀 rule_id、再 bill_date）
  async listSettlementStates(ruleIds, { billDates = null } = {}) {
    if (!ruleIds?.length || (billDates && !billDates.length)) return [];
    const [rows] = await this.pool.query(`SELECT ${SETTLEMENT_STATE_SELECT} FROM reconciliation_settlement_state WHERE rule_id IN (?)${billDates ? " AND bill_date IN (?)" : ""}`,
      billDates ? [ruleIds, billDates] : [ruleIds]);
    return rows.map(settlementStateFromRow);
  }

  // 账本里这些绑定从 sinceDate（含）起有哪些日子。必须带 rule_id IN 走主键前缀：账本没有单独的 bill_date 索引，只按日期查会扫整本账
  async listLedgerDays(ruleIds, sinceDate) {
    if (!ruleIds?.length) return [];
    const [rows] = await this.pool.query(
      "SELECT rule_id, DATE_FORMAT(bill_date, '%Y-%m-%d') AS bill_date FROM reconciliation_ledger WHERE rule_id IN (?) AND bill_date >= ? GROUP BY rule_id, bill_date",
      [ruleIds, sinceDate]);
    return rows.map((row) => ({ ruleId: row.rule_id, billDate: row.bill_date }));
  }

  // 结账没成：记下或更新这一行（settlementOutcome 的 state，op 是 retry / manual / sticky）。
  // 账本里已经有这天的任一版就不写（另一处已经固定了），一条语句判断，不用先读；调用方读状态行时带着重结请求的日子除外
  // （requestedAt 不为空：账本里本来就有这天，重结没成要照样记下退避，不然每轮都再试一次——请求在不在由调用方手里的状态行说了算，
  // 不在这张表上再查一次：同表子查询会让并发写同一天死锁，审核 C2b 低-1）。
  // 取数期间又来了新的重结请求（行里的请求时刻和 requestedAt 不一样）：这次的失败状态不盖，新请求刚清零的记录留着（审核 C2b 低-5）。
  async recordSettlementState(ruleId, billDate, state, now = Date.now(), { requestedAt = null } = {}) {
    const values = settlementStateValues(state);
    // 调用方读到这一行带着重结请求：只更新这一行（请求时刻还一样才盖）。行已经没了（手动那次同时结成、删掉了）就什么也不做，
    // 不补插一行没有请求的孤儿行
    if (requestedAt != null) {
      const columns = [...SETTLEMENT_STATE_WRITE_COLUMNS, "updated_at_ms"];
      await this.pool.query(
        `UPDATE reconciliation_settlement_state SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE rule_id = ? AND bill_date = ? AND resettle_requested_at_ms = ?`,
        [...values, now, ruleId, billDate, requestedAt]);
      return;
    }
    const keep = (column) => `${column} = IF(resettle_requested_at_ms <=> ?, VALUES(${column}), ${column})`;
    await this.pool.query(
      `INSERT INTO reconciliation_settlement_state (rule_id, bill_date, ${SETTLEMENT_STATE_WRITE_COLUMNS.join(", ")}, updated_at_ms)
       SELECT ?, ?, ${SETTLEMENT_STATE_WRITE_COLUMNS.map(() => "?").join(", ")}, ? FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM reconciliation_ledger WHERE rule_id = ? AND bill_date = ?)
       ON DUPLICATE KEY UPDATE ${SETTLEMENT_STATE_WRITE_COLUMNS.map(keep).join(", ")}, ${keep("updated_at_ms")}`,
      [ruleId, billDate, ...values, now, ruleId, billDate, ...Array(SETTLEMENT_STATE_WRITE_COLUMNS.length + 1).fill(null)]);
  }

  // 给这些日子写重结请求（一条多行 INSERT）：改时间、以后改设置、换 Key 的时刻都走这一个。conn 是调用方已经开着的事务连接，没传就直接用连接池。
  // 已有状态行（这天还在退避、等人处理）的重置成「马上可以结」：请求时刻取比原来大的（按值比对才分得出新旧请求），重试和要人处理的记录清掉
  // manualReason：这些日子不自动重结，写一条要人处理的状态行（不会自己消失的那种，比如 RESETTLE_TOO_OLD），请求仍记在行里（不记的话
  // 这天账本里有，「已固定」的清理会把行删掉），人点「重新读取」才结
  async requestResettle(ruleId, billDates, { reason = RESETTLE_REASON_TRANSITION, now = Date.now(), manualReason = null } = {}, conn = this.pool) {
    if (!billDates?.length) return 0;
    const detail = manualReason == null ? null : JSON.stringify({ code: manualReason, side: null });
    await conn.query(
      `INSERT INTO reconciliation_settlement_state (rule_id, bill_date, resettle_requested_at_ms, resettle_reason, manual_reason, manual_since_ms, last_detail, updated_at_ms)
       VALUES ${billDates.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
       ON DUPLICATE KEY UPDATE resettle_requested_at_ms = GREATEST(VALUES(resettle_requested_at_ms), COALESCE(resettle_requested_at_ms, 0) + 1),
         resettle_reason = VALUES(resettle_reason), retry_reason = NULL, manual_reason = VALUES(manual_reason), manual_since_ms = VALUES(manual_since_ms), attempts = 0,
         next_attempt_at_ms = NULL, first_failed_at_ms = NULL, last_detail = VALUES(last_detail), updated_at_ms = VALUES(updated_at_ms)`,
      billDates.flatMap((date) => [ruleId, date, now, reason, manualReason, manualReason == null ? null : now, detail, now]));
    return billDates.length;
  }

  // 这天已经固定（账本里有）但状态行还在：删掉。结账成功时的删除在 saveSnapshotsForScope 的事务里做
  async deleteSettlementState(ruleId, billDate) {
    await this.pool.query("DELETE FROM reconciliation_settlement_state WHERE rule_id = ? AND bill_date = ?", [ruleId, billDate]);
  }

  // 每小时清一批：beforeDate 以前的、没有重结请求（或请求早已放弃）的行，一次最多 limit 行，删不完下次接着删。走 (bill_date) 索引
  // 重结请求提出满 requestedBeforeMs 以前的也删（已经放弃的请求，7 天内还没结成的会一直留着）；RESETTLE_TOO_OLD、RESETTLE_SHRUNK 的行不删，等人处理
  async pruneSettlementStates(beforeDate, limit = 500, requestedBeforeMs = 0) {
    const [result] = await this.pool.query(
      `DELETE FROM reconciliation_settlement_state WHERE bill_date < ? AND (resettle_requested_at_ms IS NULL OR resettle_requested_at_ms < ?)
         AND (manual_reason IS NULL OR manual_reason NOT IN (${RESETTLE_KEPT_REASONS.map(() => "?").join(", ")})) LIMIT ?`, [beforeDate, requestedBeforeMs, ...RESETTLE_KEPT_REASONS, limit]);
    return Number(result?.affectedRows) || 0;
  }

  async getAlertState(ruleId, eventCode) {
    const [rows] = await this.pool.query(
      "SELECT * FROM reconciliation_alert_state WHERE rule_id = ? AND event_code = ?",
      [ruleId, eventCode]
    );
    return rows.length ? rows[0] : null;
  }

  async setAlertState(ruleId, eventCode, next) {
    await this.pool.query(
      `INSERT INTO reconciliation_alert_state
        (rule_id, event_code, active, first_seen_at, last_seen_at, last_notified_at, recovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE active = VALUES(active), first_seen_at = VALUES(first_seen_at),
         last_seen_at = VALUES(last_seen_at), last_notified_at = VALUES(last_notified_at), recovered_at = VALUES(recovered_at)`,
      [ruleId, eventCode, next.active ? 1 : 0, next.firstSeenAt, next.lastSeenAt,
        next.lastNotifiedAt, next.recoveredAt]
    );
  }

  async clearActiveAlerts(ruleId, recoveredAt) {
    await this.pool.query(
      "UPDATE reconciliation_alert_state SET active = 0, recovered_at = ?, last_seen_at = ? WHERE rule_id = ? AND active = 1",
      [recoveredAt, recoveredAt, ruleId]
    );
  }

  // Sub2API 账单过滤能力的核验结果，按上游连接身份的哈希保存，重启后仍有效。
  async getBillingCapability(identity, scheme = BILLING_CAPABILITY_IDENTITY_SCHEME) {
    const [rows] = await this.pool.query(
      "SELECT capability FROM reconciliation_billing_capabilities WHERE identity = ? AND identity_scheme = ?",
      [identity, scheme]
    );
    return rows.length ? asJson(rows[0].capability) : null;
  }

  // 不按核验时间清理：长期没有消费的账号无法重新核验（核验需要非零扣费），清掉后零消费的日子就结不了账。
  // 换过凭据或时区留下的旧身份只在人工改授权时产生，数量很小。
  async saveBillingCapability(identity, capability, scheme = BILLING_CAPABILITY_IDENTITY_SCHEME) {
    await this.pool.query(
      `INSERT INTO reconciliation_billing_capabilities (identity, capability, verified_at, identity_scheme) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE capability = VALUES(capability), verified_at = VALUES(verified_at), identity_scheme = VALUES(identity_scheme)`,
      [identity, JSON.stringify(capability), capability.verifiedAt, scheme]
    );
  }

  async deleteBillingCapability(identity, scheme = BILLING_CAPABILITY_IDENTITY_SCHEME) {
    const identities = Array.isArray(identity) ? identity : [identity];
    if (!identities.length) return;
    await this.pool.query("DELETE FROM reconciliation_billing_capabilities WHERE identity IN (?) AND identity_scheme = ?", [identities, scheme]);
  }

  async latestRecord(ruleId, window, scopeFingerprint, recordType) {
    if (!scopeFingerprint) throw new Error("成功账单查询必须指定核算口径");
    const [rows] = await this.pool.query(
      `SELECT * FROM reconciliation_snapshots
       WHERE rule_id = ? AND window_kind = ? AND window_end_ms <= ? AND snapshot_key LIKE ?
       ORDER BY generated_at DESC`,
      [ruleId, window.preset, window.endMs, `${reconciliationSnapshotRecordPrefix(window, scopeFingerprint, recordType)}%`]
    );
    return selectLatestRecord(rows, window, scopeFingerprint, recordType);
  }

  async latestSuccessfulResult(ruleId, window, scopeFingerprint) {
    return this.latestRecord(ruleId, window, scopeFingerprint, "confirmed");
  }

  // 多日完整窗口最近一次结账（单个自然日读账本，见 latestLedgerEntry），不管当时的关联口径和查询方式。
  async latestSettlement(ruleId, window) {
    const [rows] = await this.pool.query(
      `SELECT * FROM reconciliation_snapshots
       WHERE rule_id = ? AND snapshot_key LIKE 'r3:c:%' AND window_start_ms >= ? AND window_end_ms <= ?
       ORDER BY generated_at DESC`,
      [ruleId, window.startMs, window.endMs]
    );
    return selectLatestRecord(rows, window, null, "confirmed");
  }

  async latestObservation(ruleId, window, scopeFingerprint) {
    return this.latestRecord(ruleId, window, scopeFingerprint, "observation");
  }

  // 某个自然日的最新一版账，窗口（时区和起止）必须一致：结账后改关联、换 Key、换凭据都不改已结账的日子。
  async latestLedgerEntry(ruleId, window) {
    const billDate = billDayOf(window);
    if (!billDate) return null;
    const [rows] = await this.pool.query(
      `SELECT ${LEDGER_SELECT} FROM reconciliation_ledger WHERE rule_id = ? AND bill_date = ? ORDER BY revision DESC LIMIT 1`,
      [ruleId, billDate]
    );
    const entry = rows.length ? ledgerEntryFromRow(rows[0]) : null;
    return entry && sameReconciliationWindow(entry, window) ? entry : null;
  }

  // 已结账历史：每天只列最新一版，窗口落在请求范围内。按 (bill_date, rule_id) 倒序分页。
  async listLedgerHistory(ruleId, input = {}) {
    const { startMs, endMs, limit, after } = normalizeConfirmedHistoryOptions(input);
    const [rows] = await this.pool.query(
      `SELECT ${LEDGER_SELECT} FROM reconciliation_ledger l
       WHERE rule_id = ? AND window_start_ms >= ? AND window_end_ms <= ?
         AND revision = (SELECT MAX(revision) FROM reconciliation_ledger m WHERE m.rule_id = l.rule_id AND m.bill_date = l.bill_date)
         ${after ? "AND (bill_date < ? OR (bill_date = ? AND rule_id < ?))" : ""}
       ORDER BY bill_date DESC, rule_id DESC LIMIT ?`,
      [ruleId, startMs, endMs, ...(after ? [after[0], after[0], after[1]] : []), limit + 1]
    );
    const entries = rows.map(ledgerEntryFromRow);
    const page = entries.slice(0, limit);
    return { records: page.map(ledgerHistoryRecord), nextCursor: entries.length > limit ? encodeLedgerCursor(page.at(-1)) : null };
  }
}
