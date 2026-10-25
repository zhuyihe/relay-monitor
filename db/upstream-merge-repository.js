// 合并重复上游时，对账仓库那几张表（rules、channel_monitor_links）和合并日志的改动。
// 每个函数都吃一个已经开着事务的连接：合并时它就是 Store 写上游文档的那个连接（db/store.js 的 mergeUpstreams），
// 上游文档、绑定、关联、日志三边一起提交或一起回滚；回滚（db/k-unmerge.js）自己开事务照日志改回。
import { randomUUID } from "node:crypto";

export const MERGE_LOG_KIND = Object.freeze({
  STATION_RETAINED: "station_retained",
  STATION_MERGED: "station_merged",
  RULE: "rule",
  LINK_MOVED: "link_moved",
  LINK_DROPPED: "link_dropped",
});

export const mergeError = (code, message) => Object.assign(new Error(message), { code });
const STALE = "UPSTREAM_MERGE_STALE";
const CONFLICT = "UPSTREAM_MERGE_CONFLICT";

export const newMergeId = () => `mg_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

// 合并前对账仓库那一侧的样子（给 planUpstreamMerges 用）：rules 带它现在占着的键，links 只要三个主键列
export async function readMergeBasis(executor) {
  const [rules] = await executor.query("SELECT id, upstream_station_id, token_id, enabled, active_token_key, archived_at FROM reconciliation_rules");
  const [links] = await executor.query("SELECT own_station_id, channel_id, station_id FROM channel_monitor_links");
  return {
    rules: rules.map((row) => ({ id: row.id, upstreamStationId: row.upstream_station_id, tokenId: Number(row.token_id), enabled: !!row.enabled,
      activeKey: row.active_token_key || null })),
    links: links.map((row) => ({ ownStationId: row.own_station_id, channelId: Number(row.channel_id), stationId: row.station_id })),
  };
}

const logRow = (mergeId, nowMs, group, mergedId, kind, detail) =>
  [mergeId, nowMs, group.retained.id, mergedId, kind, JSON.stringify(detail)];

async function writeLog(conn, rows) {
  if (!rows.length) return;
  await conn.query("INSERT INTO upstream_merge_log (merge_id, merged_at_ms, retained_id, merged_id, kind, detail) VALUES ?", [rows]);
}

// 在 Store 的事务里改绑定、关联、写日志。planned 是合并前算出的这一组（lib/upstream-merge.js planUpstreamMerges 的一组）；
// 这里先锁住要改的行，再核对和算计划时一样，不一样就整个回滚（请用户重新看一遍）。
export async function applyMergeRows(conn, group, { mergeId, nowMs, oldRetainedAliases }) {
  const mergedIds = group.merged.map((station) => station.id);
  const retainedId = group.retained.id;
  const logs = [
    logRow(mergeId, nowMs, group, null, MERGE_LOG_KIND.STATION_RETAINED, { id: retainedId, costAliasesBefore: oldRetainedAliases }),
    ...mergedIds.map((id) => logRow(mergeId, nowMs, group, id, MERGE_LOG_KIND.STATION_MERGED, { id })),
  ];

  const [rules] = await conn.query(
    "SELECT id, upstream_station_id, token_id, enabled, active_token_key, canonical_key FROM reconciliation_rules WHERE upstream_station_id IN (?) ORDER BY id FOR UPDATE", [mergedIds]);
  if (JSON.stringify(rules.map((rule) => rule.id).sort()) !== JSON.stringify([...group.ruleIds].sort())) {
    throw mergeError(STALE, "合并之前绑定又变了，请重新看一遍清单");
  }
  for (const rule of rules) {
    const fallbackKey = `${rule.upstream_station_id}:${rule.token_id}`;
    const nextKey = rule.active_token_key && !rule.canonical_key && rule.active_token_key === fallbackKey ? `${retainedId}:${rule.token_id}` : rule.active_token_key;
    try {
      // updated_at = updated_at：不让这次改动把绑定顶到「最近改过」的最前面（列表按它排序）
      await conn.query("UPDATE reconciliation_rules SET upstream_station_id = ?, active_token_key = ?, updated_at = updated_at WHERE id = ?", [retainedId, nextKey, rule.id]);
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") throw mergeError(CONFLICT, "有一把 Key 在留下的上游里已经有一条绑定在用");
      throw err;
    }
    logs.push(logRow(mergeId, nowMs, group, rule.upstream_station_id, MERGE_LOG_KIND.RULE,
      { id: rule.id, upstreamStationId: rule.upstream_station_id, activeTokenKey: rule.active_token_key, newActiveTokenKey: nextKey }));
  }

  const [links] = await conn.query(
    "SELECT own_station_id, channel_id, station_id, channel_revision, confirmed_at_ms FROM channel_monitor_links WHERE station_id IN (?) ORDER BY own_station_id, channel_id, station_id FOR UPDATE",
    [[retainedId, ...mergedIds]]);
  const present = new Set(links.filter((link) => link.station_id === retainedId).map((link) => `${link.own_station_id}:${link.channel_id}`));
  const movingLinks = links.filter((link) => link.station_id !== retainedId);
  if (movingLinks.length !== group.linkCount) throw mergeError(STALE, "合并之前关联又变了，请重新看一遍清单");
  for (const link of movingLinks) {
    const id = `${link.own_station_id}:${link.channel_id}`;
    const key = [link.own_station_id, link.channel_id, link.station_id];
    if (present.has(id)) {
      await conn.query("DELETE FROM channel_monitor_links WHERE own_station_id = ? AND channel_id = ? AND station_id = ?", key);
      logs.push(logRow(mergeId, nowMs, group, link.station_id, MERGE_LOG_KIND.LINK_DROPPED,
        { ownStationId: link.own_station_id, channelId: Number(link.channel_id), stationId: link.station_id,
          channelRevision: link.channel_revision, confirmedAtMs: Number(link.confirmed_at_ms) }));
    } else {
      await conn.query("UPDATE channel_monitor_links SET station_id = ? WHERE own_station_id = ? AND channel_id = ? AND station_id = ?", [retainedId, ...key]);
      present.add(id);
      logs.push(logRow(mergeId, nowMs, group, link.station_id, MERGE_LOG_KIND.LINK_MOVED,
        { ownStationId: link.own_station_id, channelId: Number(link.channel_id), from: link.station_id }));
    }
  }
  await writeLog(conn, logs);
  return { rules: rules.length, linksMoved: logs.filter((row) => row[4] === MERGE_LOG_KIND.LINK_MOVED).length,
    linksDropped: logs.filter((row) => row[4] === MERGE_LOG_KIND.LINK_DROPPED).length };
}

// ---- 回滚 ----------------------------------------------------------------------

// 还没改回的合并，按合并时间从新到旧：[{ mergeId, mergedAtMs, retainedId, mergedIds, rows: [{ id, kind, mergedId, detail }] }]
export async function listMerges(executor, { mergeId = null } = {}) {
  const [rows] = await executor.query(
    `SELECT id, merge_id, merged_at_ms, retained_id, merged_id, kind, detail, undone_at_ms FROM upstream_merge_log
     WHERE undone_at_ms IS NULL ${mergeId ? "AND merge_id = ?" : ""} ORDER BY merged_at_ms DESC, id`, mergeId ? [mergeId] : []);
  const merges = new Map();
  for (const row of rows) {
    if (!merges.has(row.merge_id)) merges.set(row.merge_id, { mergeId: row.merge_id, mergedAtMs: Number(row.merged_at_ms), retainedId: row.retained_id, mergedIds: [], rows: [] });
    const merge = merges.get(row.merge_id);
    const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
    merge.rows.push({ id: Number(row.id), kind: row.kind, mergedId: row.merged_id, detail });
    if (row.kind === MERGE_LOG_KIND.STATION_MERGED) merge.mergedIds.push(row.merged_id);
  }
  return [...merges.values()];
}

// 一次合并要改回的事，每条一句话（先列出来给人看）
export function describeUndo(merge) {
  const lines = [`合并 ${merge.mergeId}：把 ${merge.mergedIds.join("、")} 并进了 ${merge.retainedId}`];
  for (const row of merge.rows) {
    if (row.kind === MERGE_LOG_KIND.STATION_MERGED) lines.push(`  - 上游 ${row.mergedId}：去掉「已合并」标记，重新出现在列表里、重新轮询`);
    else if (row.kind === MERGE_LOG_KIND.STATION_RETAINED) lines.push(`  - 上游 ${row.detail.id}：成本匹配地址改回合并前的 ${row.detail.costAliasesBefore.length} 个`);
    else if (row.kind === MERGE_LOG_KIND.RULE) lines.push(`  - 绑定 ${row.detail.id}：上游改回 ${row.detail.upstreamStationId}`);
    else if (row.kind === MERGE_LOG_KIND.LINK_MOVED) lines.push(`  - 渠道 ${row.detail.channelId} 的看余额关联：改回 ${row.detail.from}`);
    else if (row.kind === MERGE_LOG_KIND.LINK_DROPPED) lines.push(`  - 渠道 ${row.detail.channelId} 的看余额关联：重新加回 ${row.detail.stationId}`);
  }
  return lines;
}

// 一次合并照日志改回。调用的人先开事务（apply 时才改）。上游文档只改合并时碰过的两个字段，别的（包括加密的登录信息）原样不动。
export async function undoMergeRows(conn, merge, { nowMs }) {
  for (const row of merge.rows) {
    if (row.kind === MERGE_LOG_KIND.STATION_MERGED) {
      await conn.query("UPDATE stations SET doc = JSON_REMOVE(JSON_REMOVE(doc, '$.mergedInto'), '$.mergedAt') WHERE id = ?", [row.mergedId]);
    } else if (row.kind === MERGE_LOG_KIND.STATION_RETAINED) {
      await conn.query("UPDATE stations SET doc = JSON_SET(doc, '$.costAliases', CAST(? AS JSON)) WHERE id = ?", [JSON.stringify(row.detail.costAliasesBefore), row.detail.id]);
    } else if (row.kind === MERGE_LOG_KIND.RULE) {
      // 之后这条绑定又改过上游（比如用户改了绑定）就不动它：只改回还指着留下的那个的
      await conn.query("UPDATE reconciliation_rules SET upstream_station_id = ?, active_token_key = ?, updated_at = updated_at WHERE id = ? AND upstream_station_id = ?",
        [row.detail.upstreamStationId, row.detail.activeTokenKey, row.detail.id, merge.retainedId]);
    } else if (row.kind === MERGE_LOG_KIND.LINK_MOVED) {
      await conn.query("UPDATE channel_monitor_links SET station_id = ? WHERE own_station_id = ? AND channel_id = ? AND station_id = ?",
        [row.detail.from, row.detail.ownStationId, row.detail.channelId, merge.retainedId]);
    } else if (row.kind === MERGE_LOG_KIND.LINK_DROPPED) {
      await conn.query("INSERT IGNORE INTO channel_monitor_links (own_station_id, channel_id, station_id, channel_revision, confirmed_at_ms) VALUES (?, ?, ?, ?, ?)",
        [row.detail.ownStationId, row.detail.channelId, row.detail.stationId, row.detail.channelRevision, row.detail.confirmedAtMs]);
    }
  }
  await conn.query("UPDATE upstream_merge_log SET undone_at_ms = ? WHERE merge_id = ? AND undone_at_ms IS NULL", [nowMs, merge.mergeId]);
}
