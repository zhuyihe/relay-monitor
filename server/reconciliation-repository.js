// 上游渠道对账的持久化层：只保存规则、聚合快照和告警状态，绝不复制站点凭据。

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

function asJson(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

function activeTokenKey(input) {
  return input.enabled === false ? null : `${input.upstreamStationId}:${input.tokenId}`;
}

function activeChannelKey(input, channelId) {
  return input.enabled === false ? null : `${input.ownStationId}:${channelId}`;
}

function ruleFromRow(row, channels = []) {
  return {
    id: row.id,
    upstreamStationId: row.upstream_station_id,
    ownStationId: row.own_station_id,
    tokenId: Number(row.token_id),
    tokenName: row.token_name,
    fixedGroup: row.fixed_group,
    timezone: row.timezone,
    enabled: !!row.enabled,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    channels: channels.map((channel) => ({
      channelId: Number(channel.channel_id),
      name: channel.channel_name,
    })),
  };
}

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
      "SELECT rule_id, channel_id, channel_name FROM reconciliation_rule_channels WHERE rule_id IN (?) ORDER BY channel_name, channel_id",
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

  async getRule(id, { includeArchived = false } = {}) {
    const [rows] = await this.pool.query(
      `SELECT * FROM reconciliation_rules WHERE id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}`,
      [id]
    );
    if (!rows.length) return null;
    const [channels] = await this.pool.query(
      "SELECT rule_id, channel_id, channel_name FROM reconciliation_rule_channels WHERE rule_id = ? ORDER BY channel_name, channel_id",
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

  async createRule(input) {
    const id = uid("rr");
    const tokenKey = activeTokenKey(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO reconciliation_rules
          (id, upstream_station_id, own_station_id, token_id, token_name, fixed_group, timezone, enabled, active_token_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.upstreamStationId, input.ownStationId, input.tokenId, input.tokenName,
          input.fixedGroup, input.timezone, input.enabled === false ? 0 : 1, tokenKey]
      );
      await conn.query(
        "INSERT INTO reconciliation_rule_channels (rule_id, channel_id, channel_name, active_channel_key) VALUES ?",
        [input.channels.map((channel) => [id, channel.channelId, channel.name, activeChannelKey(input, channel.channelId)])]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    return this.getRule(id);
  }

  async updateRule(id, input) {
    const tokenKey = activeTokenKey(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `UPDATE reconciliation_rules
         SET upstream_station_id = ?, own_station_id = ?, token_id = ?, token_name = ?, fixed_group = ?, timezone = ?, enabled = ?, active_token_key = ?
         WHERE id = ? AND archived_at IS NULL`,
        [input.upstreamStationId, input.ownStationId, input.tokenId, input.tokenName,
          input.fixedGroup, input.timezone, input.enabled === false ? 0 : 1, tokenKey, id]
      );
      if (!result.affectedRows) throw new Error("对账规则不存在或已归档");
      await conn.query("DELETE FROM reconciliation_rule_channels WHERE rule_id = ?", [id]);
      await conn.query(
        "INSERT INTO reconciliation_rule_channels (rule_id, channel_id, channel_name, active_channel_key) VALUES ?",
        [input.channels.map((channel) => [id, channel.channelId, channel.name, activeChannelKey(input, channel.channelId)])]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    return this.getRule(id);
  }

  async updateObservedToken(id, { tokenName }) {
    await this.pool.query(
      "UPDATE reconciliation_rules SET token_name = ? WHERE id = ? AND archived_at IS NULL",
      [tokenName, id]
    );
  }

  async archiveRule(id) {
    const conn = await this.pool.getConnection();
    let result;
    try {
      await conn.beginTransaction();
      [result] = await conn.query(
        "UPDATE reconciliation_rules SET enabled = 0, active_token_key = NULL, archived_at = NOW() WHERE id = ? AND archived_at IS NULL",
        [id]
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

  async saveSnapshot(snapshot) {
    await this.pool.query(
      `INSERT INTO reconciliation_snapshots (
        rule_id, snapshot_key, window_kind, window_start_ms, window_end_ms, local_date,
        upstream_quota, upstream_quota_per_unit, upstream_usd,
        downstream_quota, downstream_quota_per_unit, downstream_usd,
        difference_usd, margin_rate, coverage, health_code, health_detail, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        window_end_ms = VALUES(window_end_ms), upstream_quota = VALUES(upstream_quota),
        upstream_quota_per_unit = VALUES(upstream_quota_per_unit), upstream_usd = VALUES(upstream_usd),
        downstream_quota = VALUES(downstream_quota), downstream_quota_per_unit = VALUES(downstream_quota_per_unit),
        downstream_usd = VALUES(downstream_usd), difference_usd = VALUES(difference_usd),
        margin_rate = VALUES(margin_rate), coverage = VALUES(coverage), health_code = VALUES(health_code),
        health_detail = VALUES(health_detail), source = VALUES(source), generated_at = CURRENT_TIMESTAMP`,
      [snapshot.ruleId, snapshot.snapshotKey, snapshot.windowKind, snapshot.startMs, snapshot.endMs,
        snapshot.localDate, snapshot.upstreamQuota, snapshot.upstreamQuotaPerUnit, snapshot.upstreamUsd,
        snapshot.downstreamQuota, snapshot.downstreamQuotaPerUnit, snapshot.downstreamUsd,
        snapshot.differenceUsd, snapshot.marginRate, snapshot.coverage, snapshot.healthCode,
        snapshot.healthDetail, JSON.stringify(snapshot.source || null)]
    );
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

  async latestSnapshots(ruleIds) {
    if (!ruleIds.length) return new Map();
    const [rows] = await this.pool.query(
      `SELECT s.* FROM reconciliation_snapshots s
       JOIN (
         SELECT rule_id, MAX(generated_at) AS generated_at
         FROM reconciliation_snapshots WHERE rule_id IN (?) GROUP BY rule_id
       ) latest ON latest.rule_id = s.rule_id AND latest.generated_at = s.generated_at`,
      [ruleIds]
    );
    return new Map(rows.map((row) => [row.rule_id, {
      windowKind: row.window_kind,
      startMs: Number(row.window_start_ms),
      endMs: Number(row.window_end_ms),
      healthCode: row.health_code,
      healthDetail: row.health_detail,
      generatedAt: row.generated_at ? new Date(row.generated_at).toISOString() : null,
      source: asJson(row.source),
    }]));
  }
}
