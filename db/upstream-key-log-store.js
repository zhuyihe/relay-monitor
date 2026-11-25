// 只暂存账号窗口的额度聚合和翻页进度，不存日志正文、密钥或凭据；账本仍是独立的财务事实。
import { randomUUID } from "node:crypto";

export const UPSTREAM_KEY_LOG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS upstream_key_log_windows (
  source_key CHAR(64) NOT NULL,
  start_ms BIGINT NOT NULL,
  end_ms BIGINT NOT NULL,
  revision CHAR(36) NOT NULL,
  payload JSON NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (source_key, start_ms, end_ms),
  INDEX idx_upstream_key_log_updated (updated_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

export class UpstreamKeyLogStore {
  constructor(pool) { this.pool = pool; }

  async get(source, startMs, endMs) {
    const [[row]] = await this.pool.query("SELECT revision, payload FROM upstream_key_log_windows WHERE source_key = ? AND start_ms = ? AND end_ms = ?", [source, startMs, endMs]);
    return row ? { revision: row.revision, value: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload } : null;
  }

  async put(source, startMs, endMs, value, expectedRevision = null, now = Date.now()) {
    const revision = randomUUID();
    const [result] = expectedRevision == null
      ? await this.pool.query("INSERT IGNORE INTO upstream_key_log_windows (source_key, start_ms, end_ms, revision, payload, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        [source, startMs, endMs, revision, JSON.stringify(value), now])
      : await this.pool.query("UPDATE upstream_key_log_windows SET revision = ?, payload = ?, updated_at_ms = ? WHERE source_key = ? AND start_ms = ? AND end_ms = ? AND revision = ?",
        [revision, JSON.stringify(value), now, source, startMs, endMs, expectedRevision]);
    return result.affectedRows === 1 ? { revision, value } : null;
  }

  async prune(now = Date.now()) {
    await this.pool.query("DELETE FROM upstream_key_log_windows WHERE updated_at_ms < ? LIMIT 1000", [now - 40 * 86400000]);
  }
}
