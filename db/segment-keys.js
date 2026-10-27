// 分段记 Key（计划 K1c）：reconciliation_segment_keys 一段里的每把 Key 一行。
// 建表、迁移和仓库写分段时补行用同一份 SQL（db/pool.js 启动时跑一遍，server/reconciliation-repository.js 在写分段的事务里跑）。
//
// 这一版（K1c）里每段只有一把 Key，就是 rules 上的那把（match_source = 'initial'）：结果和以前逐字相同。
// rules 上的 token_id、token_name、active_token_key 在 K1、K2 期间照写，新代码读 segment_keys（6a 再删 rules 上这几列）。
// 和方案的差别：分组和倍率（group_name、group_ratio、ratio_source）这一版不挪到这张表——倍率回填有好几处写分段表，
// 挪一半会两处对不上；等 K2b 开始用这张表写段时再加这几列。

export const SEGMENT_KEYS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS reconciliation_segment_keys (
  segment_id VARCHAR(32) NOT NULL,
  upstream_station_id VARCHAR(32) NOT NULL,
  token_id BIGINT NOT NULL,
  token_name VARCHAR(160) NULL,
  key_mask VARCHAR(64) NULL,
  match_source VARCHAR(16) NOT NULL DEFAULT 'initial',
  active_token_key VARCHAR(255) NULL,
  PRIMARY KEY (segment_id, upstream_station_id, token_id),
  UNIQUE KEY uq_segment_key_active (active_token_key),
  INDEX idx_segment_key_token (upstream_station_id, token_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

// scope：只处理一条绑定（写分段的事务里用），或不给就是全部（启动迁移）。几条语句，重复跑结果一样：
//   0 已经关掉的段、以及停用/解除的绑定的所有 Key 行，不再占着 active_token_key（不管 match_source：K2b 写的 agent 行也一样，
//     不然倍率变化开新段、或者解除以后，上一段的 agent 行还占着唯一键，新段（或别的绑定）写不进去）；
//   1 没有 Key 行的分段补一行，填 rules 上现在的那把；
//   2 来源是 initial 的行跟着 rules 现在的上游、Key 走（改绑定时旧代码是整条绑定的历史都按新 Key 取，这里保持一样）。
//     K2b 以后（这条绑定有了非 initial 的行：agent 等），已经关掉的段的 Key 行不再跟着 rules 走——关掉的段用的是哪把 Key
//     是按时间定下来的，换 Key 以后别处再调一次这个函数，历史段不能被改成新 Key；开着的那段仍然跟着 rules；
//   3 active_token_key：把还开着的那段填上 rules.active_token_key（绑定在用时才有值，停用、解除后为空）。
//   4 开着的那段里非 initial 的行（K2b 写的）：第一把和 rules 上的是同一把就用 rules.active_token_key，别的用「上游:Key」。
//     绑定停用以后重新启用，它们要重新占回唯一键。
// 这条绑定有没有非 initial 的 Key 行：放在派生表里（DISTINCT 逼它先物化），不能写成对同一张表的子查询（MySQL 报 1093：
// 更新的表不能同时在子查询里读）
const AGENT_ROWS_JOIN = `LEFT JOIN (SELECT DISTINCT xs.rule_id FROM reconciliation_segment_keys x JOIN reconciliation_rule_segments xs ON xs.id = x.segment_id
        WHERE x.match_source <> 'initial') agent ON agent.rule_id = s.rule_id`;
// 只补没有 Key 行的分段（填 rules 上现在的那把），不改已有的行：K2b 换 Key 之前先跑一遍，保证要关掉的段留得住换之前的 Key
export function fillMissingSegmentKeysSql(ruleId) {
  return { sql: `INSERT INTO reconciliation_segment_keys (segment_id, upstream_station_id, token_id, token_name, match_source)
      SELECT s.id, r.upstream_station_id, r.token_id, r.token_name, 'initial'
      FROM reconciliation_rule_segments s JOIN reconciliation_rules r ON r.id = s.rule_id
      WHERE NOT EXISTS (SELECT 1 FROM reconciliation_segment_keys k WHERE k.segment_id = s.id) AND s.rule_id = ?`, params: [ruleId] };
}

export function refreshSegmentKeysSql(ruleId = null) {
  const only = ruleId == null ? "" : " AND s.rule_id = ?";
  const params = ruleId == null ? [] : [ruleId];
  // 启动迁移（不给 ruleId）：写分段的代码本来就一直在维护，这里只补缺的（1）和缺的 active_token_key（3 的变体），已经对的行不写，
  // 不然每次启动都重写所有行
  if (ruleId == null) return [
    { sql: `INSERT INTO reconciliation_segment_keys (segment_id, upstream_station_id, token_id, token_name, match_source, active_token_key)
      SELECT s.id, r.upstream_station_id, r.token_id, r.token_name, 'initial', IF(s.effective_to_ms IS NULL, r.active_token_key, NULL)
      FROM reconciliation_rule_segments s JOIN reconciliation_rules r ON r.id = s.rule_id
      WHERE NOT EXISTS (SELECT 1 FROM reconciliation_segment_keys k WHERE k.segment_id = s.id)`, params },
  ];
  return [
    { sql: `UPDATE reconciliation_segment_keys k
      JOIN reconciliation_rule_segments s ON s.id = k.segment_id JOIN reconciliation_rules r ON r.id = s.rule_id
      SET k.active_token_key = NULL
      WHERE k.active_token_key IS NOT NULL AND (s.effective_to_ms IS NOT NULL OR r.active_token_key IS NULL)${only}`, params },
    fillMissingSegmentKeysSql(ruleId),
    { sql: `UPDATE reconciliation_segment_keys k
      JOIN reconciliation_rule_segments s ON s.id = k.segment_id JOIN reconciliation_rules r ON r.id = s.rule_id
      ${AGENT_ROWS_JOIN}
      SET k.upstream_station_id = r.upstream_station_id, k.token_id = r.token_id, k.token_name = r.token_name, k.active_token_key = NULL
      WHERE k.match_source = 'initial' AND (s.effective_to_ms IS NULL OR agent.rule_id IS NULL)${only}`, params },
    { sql: `UPDATE reconciliation_segment_keys k
      JOIN reconciliation_rule_segments s ON s.id = k.segment_id JOIN reconciliation_rules r ON r.id = s.rule_id
      SET k.active_token_key = r.active_token_key
      WHERE k.match_source = 'initial' AND s.effective_to_ms IS NULL AND r.active_token_key IS NOT NULL${only}`, params },
    { sql: `UPDATE reconciliation_segment_keys k
      JOIN reconciliation_rule_segments s ON s.id = k.segment_id JOIN reconciliation_rules r ON r.id = s.rule_id
      SET k.active_token_key = IF(k.upstream_station_id = r.upstream_station_id AND k.token_id = r.token_id, r.active_token_key, CONCAT(k.upstream_station_id, ':', k.token_id))
      WHERE k.match_source <> 'initial' AND s.effective_to_ms IS NULL AND r.active_token_key IS NOT NULL${only}`, params },
  ];
}
