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

// scope：只处理一条绑定（写分段的事务里用），或不给就是全部（启动迁移）。三条语句，重复跑结果一样：
//   1 没有 Key 行的分段补一行，填 rules 上现在的那把；
//   2 来源是 initial 的行跟着 rules 上现在的上游、Key 走（改绑定时旧代码是整条绑定的历史都按新 Key 取，这里保持一样）；
//   3 active_token_key：先清掉，再把还开着的那段填上 rules.active_token_key（绑定在用时才有值，停用、解除后为空）。
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
    { sql: `INSERT INTO reconciliation_segment_keys (segment_id, upstream_station_id, token_id, token_name, match_source)
      SELECT s.id, r.upstream_station_id, r.token_id, r.token_name, 'initial'
      FROM reconciliation_rule_segments s JOIN reconciliation_rules r ON r.id = s.rule_id
      WHERE NOT EXISTS (SELECT 1 FROM reconciliation_segment_keys k WHERE k.segment_id = s.id)${only}`, params },
    { sql: `UPDATE reconciliation_segment_keys k
      JOIN reconciliation_rule_segments s ON s.id = k.segment_id JOIN reconciliation_rules r ON r.id = s.rule_id
      SET k.upstream_station_id = r.upstream_station_id, k.token_id = r.token_id, k.token_name = r.token_name, k.active_token_key = NULL
      WHERE k.match_source = 'initial'${only}`, params },
    { sql: `UPDATE reconciliation_segment_keys k
      JOIN reconciliation_rule_segments s ON s.id = k.segment_id JOIN reconciliation_rules r ON r.id = s.rule_id
      SET k.active_token_key = r.active_token_key
      WHERE k.match_source = 'initial' AND s.effective_to_ms IS NULL AND r.active_token_key IS NOT NULL${only}`, params },
  ];
}
