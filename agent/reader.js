// 读 New API 的 channels 表。原则：不能影响线上的 New API。
// - 每次读：连一次库、发 1 条 SELECT、断开。不留连接池、不留空闲连接（专用账号在库里只许 1 个连接，--dry-run 也不和服务抢）。
// - 查询时限由语句自己带上（MySQL 8 的 MAX_EXECUTION_TIME 提示、MariaDB 的 SET STATEMENT max_statement_time、PostgreSQL 的启动参数），
//   到点由库掐掉，不靠客户端断开（mysql2 的 destroy 只关 socket，库里卡在锁上的查询不会停）。
// - 账号权限比 channels 那几列多就不读（account-check.js）。
// 报错只在这里看驱动的错误码，往外只给原因码（DB_UNREACHABLE / DB_DENIED / DB_TIMEOUT / DB_LIMIT / TABLE_MISSING / ACCOUNT_TOO_BROAD / DB_ERROR），不带库的报错原文（可能带出主机、账号）
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { MYSQL_ACCOUNT_SQL, PG_ACCOUNT_SQL, judgeMysqlAccount, judgePgAccount, pgConnectionLimit } from "./account-check.js";

const FULL_COLUMNS = "id, name, type, status, base_url, KEY_COL, channel_info";
const NO_INFO_COLUMNS = "id, name, type, status, base_url, KEY_COL";
const CONNECT_TIMEOUT_MS = 5000;
// 库那一侧每条语句的时限：一次读正常只要几毫秒，到点就掐，不拖住 New API 的 ALTER 或别的查询
export const DB_TIME_LIMIT_MS = 500;
// 客户端这边的兜底（库没按时掐、网络卡住时放手）
const QUERY_TIMEOUT_MS = 5000;
// 一次读库从头到尾的总时限
const READ_DEADLINE_MS = 12000;
const CLOSE_DEADLINE_MS = 2000;
// SQLite 等锁最多等这么久（读只是几毫秒的事）
const SQLITE_BUSY_MS = 200;
// 老表没有 channel_info 退到不含这一列的那条以后，隔多久再试一次带这一列的（New API 升级会补上这一列）
const FULL_RETRY_MS = 10 * 60 * 1000;

export const selectBody = (kind, withChannelInfo) => {
  const quoted = kind === "mysql" ? "`key`" : '"key"';
  return `SELECT ${(withChannelInfo ? FULL_COLUMNS : NO_INFO_COLUMNS).replace("KEY_COL", quoted)} FROM channels ORDER BY id`;
};

// 握手给的版本串：MariaDB（带 MariaDB 字样）、MySQL ≥ 5.7.8（有 MAX_EXECUTION_TIME 提示）、其余（更老的 MySQL）没有语句级时限
export function mysqlFlavor(version) {
  const text = String(version ?? "");
  if (/mariadb/i.test(text)) return "mariadb";
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return "unknown";
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return major > 5 || (major === 5 && (minor > 7 || (minor === 7 && patch >= 8))) ? "mysql" : "old";
}

// 给 SELECT 带上库侧时限。语句仍然只有一条
export function withTimeLimit(sql, { flavor, limitMs }) {
  if (!limitMs) return sql;
  if (flavor === "mariadb") return `SET STATEMENT max_statement_time=${limitMs / 1000} FOR ${sql}`;
  if (flavor === "mysql") return sql.replace(/^SELECT /, `SELECT /*+ MAX_EXECUTION_TIME(${limitMs}) */ `);
  return sql;
}

export const selectSql = (kind, withChannelInfo, { flavor = "unknown", limitMs = 0 } = {}) => withTimeLimit(selectBody(kind, withChannelInfo), { flavor, limitMs });

const UNREACHABLE_NET = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ENOENT", "EACCES",
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_SEQUENCE_TIMEOUT"]);
const MYSQL_DENIED = new Set(["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "ER_HOST_NOT_PRIVILEGED", "ER_HOST_IS_BLOCKED", "ER_ACCESS_DENIED_NO_PASSWORD_ERROR"]);
const MYSQL_NO_DB = new Set(["ER_BAD_DB_ERROR"]);
// 库自己到点掐掉的（MySQL 3024、MariaDB 1969、PostgreSQL 57014 / 55P03）
const DB_TIMEOUT_ERRNO = new Set([3024, 1969]);
const DB_TIMEOUT_CODES = new Set(["ER_QUERY_TIMEOUT", "ER_STATEMENT_TIMEOUT", "57014", "55P03"]);
// 账号或服务器的连接数、每小时额度到顶（MySQL 1226 用户额度、1203 / 1040 连接数；PostgreSQL 53300）
const DB_LIMIT_ERRNO = new Set([1226, 1203, 1040]);
const DB_LIMIT_CODES = new Set(["ER_USER_LIMIT_REACHED", "ER_TOO_MANY_USER_CONNECTIONS", "ER_CON_COUNT_ERROR", "53300"]);
const PG_GONE_MESSAGE = /connection terminated|terminating connection|server closed the connection|connection ended/i;
const SAFE_DRIVER_CODE = /^[A-Za-z0-9_]{1,40}$/;

// 缺 channel_info 这一列：MySQL 1054（列不存在）、PostgreSQL 42703、SQLite no such column，报错里都要点名 channel_info（别的列缺了不算，不能悄悄退）。
// 1143（有这一列、账号没给它授权）不算：那是权限不够，退回会把多 Key 渠道悄悄当成一把 Key
export function isMissingColumn(err) {
  const message = String(err?.message ?? "");
  if (!/channel_info/i.test(message)) return false;
  return err?.code === "ER_BAD_FIELD_ERROR" || err?.errno === 1054 || err?.code === "42703" || /no such column/i.test(message);
}

// { code: 给外面的原因码, driver: 驱动自己的错误码（只用来记日志，只认字母数字下划线）}
export function classifyError(err) {
  const raw = String(err?.code ?? err?.errno ?? "UNKNOWN");
  const driver = SAFE_DRIVER_CODE.test(raw) ? raw : "UNKNOWN";
  const c = String(err?.code ?? "");
  const errno = Number(err?.errno);
  if (err instanceof ReadFailure) return { code: err.code, driver: err.driver };
  if (DB_LIMIT_ERRNO.has(errno) || DB_LIMIT_CODES.has(c)) return { code: "DB_LIMIT", driver };
  if (DB_TIMEOUT_ERRNO.has(errno) || DB_TIMEOUT_CODES.has(c)) return { code: "DB_TIMEOUT", driver };
  const timedOut = err?.name === "TimeoutError" || /timeout|timed out/i.test(String(err?.message ?? ""));
  if (UNREACHABLE_NET.has(c) || MYSQL_NO_DB.has(c) || c === "3D000" || c.startsWith("08") || c === "57P01" || c === "57P02" || c === "57P03"
    || (!c && PG_GONE_MESSAGE.test(String(err?.message ?? ""))) || (timedOut && !c.startsWith("ER_"))) return { code: "DB_UNREACHABLE", driver };
  if (MYSQL_DENIED.has(c) || c.startsWith("28") || c === "42501") return { code: "DB_DENIED", driver };
  if (c === "ER_NO_SUCH_TABLE" || c === "42P01") return { code: "TABLE_MISSING", driver };
  if (err?.errcode !== undefined || err?.code === "ERR_SQLITE_ERROR") {
    const message = String(err?.message ?? "");
    // SQLite 的扩展错误码低 8 位才是主码（1544 = READONLY 的扩展，266 = IOERR 的扩展）
    const primary = Number(err.errcode) & 0xff;
    const named = `SQLITE_${Number.isFinite(primary) ? primary : "UNKNOWN"}`;
    if (/no such table/i.test(message)) return { code: "TABLE_MISSING", driver: named };
    if (primary === 14) return { code: "DB_UNREACHABLE", driver: "SQLITE_CANTOPEN" };
    if (primary === 5 || primary === 6) return { code: "DB_TIMEOUT", driver: named };
    if (primary === 8 || primary === 23 || primary === 3) return { code: "DB_DENIED", driver: named };
    return { code: "DB_ERROR", driver: named };
  }
  return { code: "DB_ERROR", driver };
}

export class ReadFailure extends Error {
  constructor(code, driver) {
    super(code);
    this.code = code;
    this.driver = driver;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// 超过时限就放手：那一次读还在后面跑着，它以后的报错没人听了，要接住，免得变成没人处理的拒绝
function withDeadline(promise, ms, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("read deadline"), { code: "READ_DEADLINE", name: "TimeoutError" })), ms);
    timer.unref?.();
  });
  promise.catch(() => {});
  return Promise.race([promise, deadline]).catch((err) => {
    if (err?.code === "READ_DEADLINE") onTimeout?.();
    throw err;
  }).finally(() => clearTimeout(timer));
}

// 每个驱动：open(database, opts) → 一次会话 { fetch(withChannelInfo), inspect(), end(), destroy(), flavor }
async function mysqlSession(database, { queryTimeoutMs, dbTimeLimitMs }) {
  const { default: mysql } = await import("mysql2/promise");
  const conn = await mysql.createConnection({
    ...(database.socketPath ? { socketPath: database.socketPath } : { host: database.host, port: database.port }),
    user: database.user, password: database.password, database: database.database,
    ...(database.ssl ? { ssl: database.ssl } : {}),
    connectTimeout: CONNECT_TIMEOUT_MS, multipleStatements: false,
  });
  // 连接被对方断开时 mysql2 会发 error 事件；没人听就是进程崩溃，原因读的时候自然会报
  conn.on("error", () => {});
  // 握手里的版本串（mysql2 没有公开的取法）。取不到就不带语句级时限，只靠客户端那一道
  const flavor = mysqlFlavor(conn.connection?._handshakePacket?.serverVersion);
  const run = async (sql) => (await conn.query({ sql: withTimeLimit(sql, { flavor, limitMs: dbTimeLimitMs }), timeout: queryTimeoutMs }))[0];
  return {
    flavor,
    fetch: (withChannelInfo) => run(selectBody("mysql", withChannelInfo)),
    inspect: () => run(MYSQL_ACCOUNT_SQL),
    judge: (rows) => judgeMysqlAccount(rows, { database: database.database }),
    end: () => conn.end(),
    destroy: () => conn.destroy(),
  };
}

async function postgresSession(database, { queryTimeoutMs, dbTimeLimitMs }) {
  const { default: pg } = await import("pg");
  const limits = dbTimeLimitMs ? [`-c statement_timeout=${dbTimeLimitMs}`, `-c lock_timeout=${Math.max(100, Math.floor(dbTimeLimitMs / 5))}`, "-c idle_in_transaction_session_timeout=5000"].join(" ") : undefined;
  const client = new pg.Client({ connectionString: database.connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, query_timeout: queryTimeoutMs, ...(limits ? { options: limits } : {}) });
  // 查询中途被掐断、空闲连接被对方断开时 pg 会发 error 事件；没人听就是进程崩溃
  client.on("error", () => {});
  await client.connect();
  const run = async (sql) => (await client.query(sql)).rows;
  return {
    flavor: "postgres",
    fetch: (withChannelInfo) => run(selectBody("postgres", withChannelInfo)),
    inspect: () => run(PG_ACCOUNT_SQL),
    judge: (rows) => judgePgAccount(rows),
    connectionLimit: (rows) => pgConnectionLimit(rows),
    end: () => client.end(),
    destroy: () => { try { client.connection?.stream?.destroy(); } catch { /* 已经断了 */ } },
  };
}

// WAL 模式的库在 New API 干净关闭后目录里没有 -wal。这时只读打开会留下空的 -wal / -shm（New API 下次启动可能因此写不了），不读
function sqliteWalMissing(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(20);
    if (readSync(fd, header, 0, 20, 0) < 20) return false;
    const wal = header[18] === 2 && header[19] === 2;
    return wal && !existsSync(`${path}-wal`);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function sqliteSession(database) {
  const { DatabaseSync } = await import("node:sqlite");
  if (sqliteWalMissing(database.path)) throw new ReadFailure("DB_UNREACHABLE", "SQLITE_NO_WAL");
  const db = new DatabaseSync(database.path, { readOnly: true, timeout: SQLITE_BUSY_MS });
  db.exec("PRAGMA query_only = 1");
  return {
    flavor: "sqlite",
    fetch: (withChannelInfo) => db.prepare(selectBody("sqlite", withChannelInfo)).all(),
    inspect: null,
    end: async () => db.close(),
    destroy: () => { try { db.close(); } catch { /* 已经关了 */ } },
  };
}

const SESSIONS = { mysql: mysqlSession, postgres: postgresSession, sqlite: sqliteSession };

// 返回 { kind, read(): Promise<行数组>, status(), close() }。read 失败抛 ReadFailure（带原因码）。
// onEvent({ ev, … })：值得记一笔的事（老表没有 channel_info 退回、重新用上、账号权限过宽）；
// now、deadlineMs、queryTimeoutMs、dbTimeLimitMs：测试里换时钟和时限（dbTimeLimitMs 为 0 表示不带库侧时限）；checkAccount：测试里关掉权限检查
export function createReader(database, { onEvent = () => {}, now = Date.now, deadlineMs = READ_DEADLINE_MS, queryTimeoutMs = QUERY_TIMEOUT_MS, dbTimeLimitMs = DB_TIME_LIMIT_MS, checkAccount = true } = {}) {
  // 没有 channel_info 时 withChannelInfo 为 false，retryFullAt 之后再试一次带这一列的
  let withChannelInfo = true;
  let retryFullAt = 0;
  // 账号检查：null 还没查，true 通过，{ reason } 不通过（以后不再连库，要换账号重启）
  let account = checkAccount ? null : true;
  let accountInfo = {};
  let inflight = null;
  let session = null;
  let closed = false;

  async function fetchRows(current) {
    if (!withChannelInfo && now() >= retryFullAt) {
      try {
        const rows = await current.fetch(true);
        withChannelInfo = true;
        onEvent({ ev: "channel_info_restored" });
        return rows;
      } catch (err) {
        if (!isMissingColumn(err)) throw err;
        retryFullAt = now() + FULL_RETRY_MS;
      }
    }
    try {
      return await current.fetch(withChannelInfo);
    } catch (err) {
      // 老版本没有 channel_info 列：退到不含这一列的那条 SELECT（同一个连接）；隔一阵再试带这一列的
      if (!withChannelInfo || !isMissingColumn(err)) throw err;
      withChannelInfo = false;
      retryFullAt = now() + FULL_RETRY_MS;
      onEvent({ ev: "channel_info_missing" });
      return current.fetch(false);
    }
  }

  async function attempt() {
    const opened = await SESSIONS[database.kind](database, { queryTimeoutMs, dbTimeLimitMs });
    session = opened;
    let failed = true;
    try {
      if (account === null && opened.inspect) {
        const inspected = await opened.inspect();
        if (opened.connectionLimit) accountInfo = { connectionLimit: opened.connectionLimit(inspected) };
        const verdict = opened.judge(inspected);
        if (verdict) {
          account = { reason: verdict };
          onEvent({ ev: "account_too_broad", reason: verdict });
          throw new ReadFailure("ACCOUNT_TOO_BROAD", verdict);
        }
        account = true;
      } else if (account === null) {
        account = true;
      }
      const rows = await fetchRows(opened);
      failed = false;
      return rows;
    } finally {
      session = null;
      // 读完就断；出错或断不干净的直接丢掉 socket
      if (failed) opened.destroy();
      else await Promise.race([opened.end().catch(() => opened.destroy()), sleep(CLOSE_DEADLINE_MS).then(() => opened.destroy())]);
    }
  }

  return {
    kind: database.kind,
    async read() {
      if (closed) throw new ReadFailure("DB_ERROR", "CLOSED");
      // 账号不合格：不再连库（要换账号、重启）
      if (account && account !== true) throw new ReadFailure("ACCOUNT_TOO_BROAD", account.reason);
      // 同一时刻只有一次读；上一次没结束不开下一次
      inflight ??= (async () => {
        try {
          return await withDeadline(attempt(), deadlineMs, () => session?.destroy());
        } catch (err) {
          if (err instanceof ReadFailure) throw err;
          const { code, driver } = classifyError(err);
          throw new ReadFailure(code, err?.code === "READ_DEADLINE" ? "READ_DEADLINE" : driver);
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    // --dry-run 用：现在的状态（读过一次以后才有意义）
    status: () => ({ account: account === true ? "ok" : account ? account.reason : "unchecked", withChannelInfo, ...accountInfo }),
    close: async () => { closed = true; session?.destroy(); },
  };
}
