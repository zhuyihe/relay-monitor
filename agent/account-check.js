// 启动后第一次读库时先看一眼账号的权限：专用账号只该有 channels 表那 7 列的 SELECT。
// 权限比这多（能写、能读别的表、是 New API 自己那个账号）就不读，/keys 回 ACCOUNT_TOO_BROAD。
// 只查 information_schema 的权限表（MySQL / MariaDB）和 pg_roles + has_*_privilege（PostgreSQL），不解析 SHOW GRANTS 的文本：
// MariaDB 的 SHOW GRANTS 带密码哈希，不能进日志。返回给外面的只有一个简短的原因名，不带库名、表名、列名
export const CHANNEL_COLUMNS = ["id", "name", "type", "status", "base_url", "key", "channel_info"];
const ALLOWED = new Set(CHANNEL_COLUMNS);

// 四张权限表合成一条语句（一次读多发一条语句也要算进每小时的额度）。scope：user / schema / table / column
export const MYSQL_ACCOUNT_SQL = [
  "SELECT 'user' AS scope, PRIVILEGE_TYPE AS priv, '' AS tbl, '' AS col FROM information_schema.USER_PRIVILEGES",
  "UNION ALL SELECT 'schema', PRIVILEGE_TYPE, TABLE_SCHEMA, '' FROM information_schema.SCHEMA_PRIVILEGES",
  "UNION ALL SELECT 'table', PRIVILEGE_TYPE, CONCAT(TABLE_SCHEMA, '.', TABLE_NAME), '' FROM information_schema.TABLE_PRIVILEGES",
  "UNION ALL SELECT 'column', PRIVILEGE_TYPE, CONCAT(TABLE_SCHEMA, '.', TABLE_NAME), COLUMN_NAME FROM information_schema.COLUMN_PRIVILEGES",
].join(" ");

const sqlList = CHANNEL_COLUMNS.map((c) => `'${c}'`).join(", ");
// 一条语句：角色属性、除 channels 以外还有权限的表有几张、channels 上的写类权限（表级和列级）、表级 SELECT（等于所有列）、7 列以外还能读写的列有几个、连接数上限
export const PG_ACCOUNT_SQL = `SELECT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) AS elevated,
  r.rolconnlimit AS connlimit,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast' AND c.oid <> to_regclass('channels')
      AND (has_table_privilege(c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') OR has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))) AS other_tables,
  (SELECT count(*) FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p WHERE has_table_privilege(to_regclass('channels'), p))
    + (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = to_regclass('channels') AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(a.attrelid, a.attnum, 'INSERT, UPDATE, REFERENCES')) AS write_privs,
  has_table_privilege(to_regclass('channels'), 'SELECT') AS table_select,
  (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = to_regclass('channels') AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege(a.attrelid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES') AND a.attname NOT IN (${sqlList})) AS extra_columns
FROM pg_roles r WHERE r.rolname = current_user`;

// 返回 null（账号没问题）或一个简短的原因名
export function judgeMysqlAccount(rows, { database }) {
  const home = `${String(database ?? "").toLowerCase()}.channels`;
  for (const row of rows ?? []) {
    const scope = String(row.scope), priv = String(row.priv).toUpperCase();
    if (scope === "user" && priv !== "USAGE") return "GLOBAL_PRIVILEGE";
    if (scope === "schema") return "SCHEMA_PRIVILEGE";
    if (scope === "table") return "TABLE_PRIVILEGE";
    if (scope === "column" && (priv !== "SELECT" || String(row.tbl).toLowerCase() !== home || !ALLOWED.has(String(row.col).toLowerCase()))) return "COLUMN_PRIVILEGE";
  }
  return null;
}

export function judgePgAccount(rows) {
  const row = rows?.[0];
  if (!row) return "ROLE_UNKNOWN";
  if (row.elevated) return "ROLE_ATTRIBUTES";
  if (Number(row.other_tables) > 0) return "OTHER_TABLES";
  if (Number(row.write_privs) > 0) return "WRITE_PRIVILEGE";
  if (row.table_select) return "TABLE_WIDE_SELECT";
  if (Number(row.extra_columns) > 0) return "EXTRA_COLUMNS";
  return null;
}

// --dry-run 用：PostgreSQL 的连接数上限（没设是 -1）
export const pgConnectionLimit = (rows) => (rows?.[0] ? Number(rows[0].connlimit) : null);
