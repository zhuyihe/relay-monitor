// 读 New API 的数据库配置（SQL_DSN / KEY_AGENT_DSN / SQLITE_PATH），规则和 New API 一样：
// postgres:// 或 postgresql:// 开头是 PostgreSQL，其余非空是 MySQL（Go 风格 DSN），空或 local 是 SQLite
export function dsnError(message) {
  return Object.assign(new Error(message), { code: "DSN_INVALID" });
}

// Go 的 go-sql-driver/mysql 写法：[user[:password]@][net[(addr)]]/dbname[?k=v&…]，密码里可以有 @ / :
function parseGoMysql(dsn) {
  const slash = dsn.lastIndexOf("/");
  if (slash < 0) throw dsnError("MySQL 连接串格式不对：缺少 /库名");
  const head = dsn.slice(0, slash), tail = dsn.slice(slash + 1);
  const q = tail.indexOf("?");
  const database = decodeURIComponent(q < 0 ? tail : tail.slice(0, q));
  const params = new URLSearchParams(q < 0 ? "" : tail.slice(q + 1));
  let user = "", password = "", net = head;
  const at = head.lastIndexOf("@");
  if (at >= 0) {
    const cred = head.slice(0, at);
    net = head.slice(at + 1);
    const colon = cred.indexOf(":");
    user = colon < 0 ? cred : cred.slice(0, colon);
    password = colon < 0 ? "" : cred.slice(colon + 1);
  }
  const m = net.match(/^([a-z0-9]*)(?:\((.*)\))?$/i);
  if (!m) throw dsnError("MySQL 连接串格式不对：地址部分");
  const protocol = (m[1] || "tcp").toLowerCase(), address = m[2] ?? "";
  const out = { kind: "mysql", user, password, database };
  if (protocol === "unix") {
    out.socketPath = address;
  } else if (protocol === "tcp") {
    const hp = address.match(/^(?:\[([^\]]+)\]|([^:]*))(?::(\d+))?$/);
    if (!hp) throw dsnError("MySQL 连接串格式不对：主机和端口");
    out.host = hp[1] || hp[2] || "127.0.0.1";
    out.port = hp[3] ? Number(hp[3]) : 3306;
  } else {
    throw dsnError("MySQL 连接串只认 tcp 和 unix");
  }
  const tls = params.get("tls");
  if (tls === "true" || tls === "preferred") out.ssl = {};
  else if (tls === "skip-verify") out.ssl = { rejectUnauthorized: false };
  return out;
}

// mysql://user:pass@host:port/db 的写法（KEY_AGENT_DSN 里顺手写成 URL 的人）
function parseMysqlUrl(dsn) {
  let url;
  try { url = new URL(dsn); } catch { throw dsnError("MySQL 连接串格式不对"); }
  const out = { kind: "mysql", host: url.hostname || "127.0.0.1", port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.replace(/^\//, "")) };
  const tls = url.searchParams.get("tls") ?? url.searchParams.get("ssl");
  if (tls === "true") out.ssl = {};
  else if (tls === "skip-verify") out.ssl = { rejectUnauthorized: false };
  return out;
}

export function sqlitePathOf(env) {
  const raw = String(env.SQLITE_PATH ?? "").trim() || "one-api.db";
  const q = raw.indexOf("?");
  return q < 0 ? raw : raw.slice(0, q);
}

// 返回 { kind: "mysql"|"postgres"|"sqlite", … }；没有的就是 SQLite
export function resolveDatabase(env = process.env) {
  const dsn = String(env.KEY_AGENT_DSN ?? "").trim() || String(env.SQL_DSN ?? "").trim();
  if (!dsn || dsn === "local") return { kind: "sqlite", path: sqlitePathOf(env) };
  if (/^postgres(ql)?:\/\//i.test(dsn)) return { kind: "postgres", connectionString: dsn };
  if (/^mysql:\/\//i.test(dsn)) return parseMysqlUrl(dsn);
  return parseGoMysql(dsn);
}
