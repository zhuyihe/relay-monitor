// MySQL 连接池（mysql2/promise）。连接参数来自环境变量，见 .env.example
import mysql from "mysql2/promise";

let _pool = null;

export function getPool() {
  if (_pool) return _pool;
  _pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "relay",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "relay_monitor",
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4_unicode_ci",
    // JSON 列自动解析；BIGINT 时间戳按 Number 返回（2^53 内安全）
    supportBigNumbers: true,
  });
  return _pool;
}

// 建表（幂等）。JSON 文档列保持与 v1 数据形状 1:1，回归风险最低；
// history_points 落成关系行，供经营分析 SQL 聚合。
export async function ensureSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS stations (
    id VARCHAR(32) PRIMARY KEY,
    pos INT NOT NULL DEFAULT 0,
    doc JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS meta (
    k VARCHAR(64) PRIMARY KEY,
    v JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS history_points (
    station_id VARCHAR(32) NOT NULL,
    t BIGINT NOT NULL,
    remaining DOUBLE NOT NULL,
    used DOUBLE NOT NULL DEFAULT 0,
    PRIMARY KEY (station_id, t),
    INDEX idx_t (t)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 原始快照是长期事实来源；日汇总只用于成本分析查询加速。
  // 保留 DATE 类型，查询时统一 DATE_FORMAT 为 YYYY-MM-DD，避免时区隐式转换。
  await pool.query(`CREATE TABLE IF NOT EXISTS station_daily_usage (
    station_id VARCHAR(32) NOT NULL,
    date DATE NOT NULL,
    used_usd DOUBLE NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (station_id, date),
    INDEX idx_date (date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
