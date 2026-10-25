// 启动后第一次读库之前先看一眼账号的权限：专用账号只该有 channels 表那 7 列的 SELECT、连接数上限 1。
// 权限比这多（能写、能读别的表、能转授权限、通过角色拿到权限、连接数上限不是 1、是 New API 自己那个账号）就不读，/keys 回 ACCOUNT_TOO_BROAD。
// 只查 information_schema 的权限表（MySQL / MariaDB）和 pg_roles + has_*_privilege（PostgreSQL），不解析 SHOW GRANTS 的文本：
// MariaDB 的 SHOW GRANTS 带密码哈希，不能进日志。返回给外面的只有一个简短的原因名，不带库名、表名、列名。
// 查不到的（写进部署说明：只允许直接授予那 7 列的 SELECT）：单个存储过程的 EXECUTE、PROXY 授权、PostgreSQL 的序列权限和 schema 上的 CREATE、SET ROLE。
// 只在启动后第一次读之前查一次：账号的权限之后又变了，要重启读取服务才会发现
export const CHANNEL_COLUMNS = ["id", "name", "type", "status", "base_url", "key", "channel_info"];
const ALLOWED = new Set(CHANNEL_COLUMNS);

// MySQL 8 和 MariaDB 有 information_schema.APPLICABLE_ROLES（账号能用的角色），5.7 没有角色这回事
export function mysqlHasRoles(version) {
  const text = String(version ?? "");
  if (/mariadb/i.test(text)) return true;
  const major = Number(/^(\d+)\./.exec(text)?.[1]);
  return Number.isFinite(major) && major >= 8;
}

// 权限表和连接数合成一条语句（一次读多发一条语句也要算进每小时的额度）。
// scope：conn（本会话的 max_user_connections：账号设了的话是账号的上限，没设就是全局值）/ user / schema / table / column / role；grantable 是 IS_GRANTABLE
export function mysqlAccountSql(version) {
  return [
    "SELECT 'conn' AS scope, CAST(@@session.max_user_connections AS CHAR) AS priv, '' AS tbl, '' AS col, 'NO' AS grantable",
    "UNION ALL SELECT 'user', PRIVILEGE_TYPE, '', '', IS_GRANTABLE FROM information_schema.USER_PRIVILEGES",
    "UNION ALL SELECT 'schema', PRIVILEGE_TYPE, TABLE_SCHEMA, '', IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES",
    "UNION ALL SELECT 'table', PRIVILEGE_TYPE, CONCAT(TABLE_SCHEMA, '.', TABLE_NAME), '', IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES",
    "UNION ALL SELECT 'column', PRIVILEGE_TYPE, CONCAT(TABLE_SCHEMA, '.', TABLE_NAME), COLUMN_NAME, IS_GRANTABLE FROM information_schema.COLUMN_PRIVILEGES",
    ...(mysqlHasRoles(version) ? ["UNION ALL SELECT 'role', 'ROLE', '', '', 'NO' FROM information_schema.APPLICABLE_ROLES"] : []),
  ].join(" ");
}

const sqlList = CHANNEL_COLUMNS.map((c) => `'${c}'`).join(", ");
// 一条语句：channels 在不在、角色属性、是不是别的角色的成员、连接数上限、除 channels 以外还有权限的表有几张、
// channels 上的写类权限（表级和列级）、表级 SELECT（等于所有列）、7 列以外还能读写的列有几个
export const PG_ACCOUNT_SQL = `SELECT (to_regclass('channels') IS NOT NULL) AS channels_found,
  (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) AS elevated,
  (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
  r.rolconnlimit AS connlimit,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast' AND c.oid IS DISTINCT FROM to_regclass('channels')
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
  const list = rows ?? [];
  for (const row of list) {
    const scope = String(row.scope), priv = String(row.priv).toUpperCase();
    if (scope === "role") return "ROLE_GRANTED";
    if (scope === "user" && priv !== "USAGE") return "GLOBAL_PRIVILEGE";
    if (scope === "schema") return "SCHEMA_PRIVILEGE";
    if (scope === "table") return "TABLE_PRIVILEGE";
    if (scope === "column" && (priv !== "SELECT" || String(row.tbl).toLowerCase() !== home || !ALLOWED.has(String(row.col).toLowerCase()))) return "COLUMN_PRIVILEGE";
    // 权限本身没问题、但能转授给别人（先判权限：root 这类账号既有全局权限又带 GRANT OPTION，说前一个更要紧）
    if (String(row.grantable).toUpperCase() === "YES") return "GRANT_OPTION";
  }
  // 账号（或全局）的连接数上限必须是 1：别处还占着连接时，读取服务的新连接才会被库挡回，而不是再开一个。放在权限之后判：
  // New API 自己的账号这类先说权限的事（原因更要紧）
  const conn = list.find((row) => String(row.scope) === "conn");
  if (!conn || String(conn.priv) !== "1") return "CONNECTION_LIMIT";
  return null;
}

// "CHANNELS_MISSING" 不是账号的问题：表现在不存在（New API 的库不对，或表被删了），别的检查没有意义，也不能把「通过」记下来，下次读再查
export function judgePgAccount(rows) {
  const row = rows?.[0];
  if (!row) return "ROLE_UNKNOWN";
  if (!row.channels_found) return "CHANNELS_MISSING";
  if (row.elevated) return "ROLE_ATTRIBUTES";
  if (Number(row.memberships) > 0) return "ROLE_MEMBERSHIP";
  if (Number(row.connlimit) !== 1) return "CONNECTION_LIMIT";
  if (Number(row.other_tables) > 0) return "OTHER_TABLES";
  if (Number(row.write_privs) > 0) return "WRITE_PRIVILEGE";
  if (row.table_select) return "TABLE_WIDE_SELECT";
  if (Number(row.extra_columns) > 0) return "EXTRA_COLUMNS";
  return null;
}

// --dry-run 用：PostgreSQL 的连接数上限（没设是 -1）
export const pgConnectionLimit = (rows) => (rows?.[0] ? Number(rows[0].connlimit) : null);
