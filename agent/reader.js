// 读 New API 的 channels 表：只发一条固定的 SELECT，会话设成只读，连接池只开 1 个连接。
// 报错只在这里看驱动的错误码，往外只给原因码（DB_UNREACHABLE / DB_DENIED / TABLE_MISSING / DB_ERROR），不带库的报错原文（可能带出主机、账号）
const FULL_COLUMNS = "id, name, type, status, base_url, KEY_COL, channel_info";
const NO_INFO_COLUMNS = "id, name, type, status, base_url, KEY_COL";
const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 8000;
// 一次读库从头到尾的总时限：查询超时、连接超时之外再兜一道（连接卡在排队、驱动不返回时也能放手）
const READ_DEADLINE_MS = 15000;
const CLOSE_DEADLINE_MS = 2000;
// 老表没有 channel_info 退到不含这一列的那条以后，隔多久再试一次带这一列的（New API 升级会补上这一列）
const FULL_RETRY_MS = 10 * 60 * 1000;

export const MYSQL_READ_ONLY_SQL = "SET SESSION TRANSACTION READ ONLY";
export const PG_READ_ONLY_SQL = "SET default_transaction_read_only = on";

export const selectSql = (kind, withChannelInfo) => {
  const quoted = kind === "mysql" ? "`key`" : '"key"';
  return `SELECT ${(withChannelInfo ? FULL_COLUMNS : NO_INFO_COLUMNS).replace("KEY_COL", quoted)} FROM channels ORDER BY id`;
};

const UNREACHABLE_NET = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ENOENT", "EACCES",
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_SEQUENCE_TIMEOUT"]);
const MYSQL_DENIED = new Set(["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "ER_HOST_NOT_PRIVILEGED", "ER_HOST_IS_BLOCKED", "ER_ACCESS_DENIED_NO_PASSWORD_ERROR"]);
const MYSQL_NO_DB = new Set(["ER_BAD_DB_ERROR"]);
const SAFE_DRIVER_CODE = /^[A-Za-z0-9_]{1,40}$/;

// 缺 channel_info 这一列：MySQL 1054（列不存在）、PostgreSQL 42703、SQLite no such column；
// 老表上只给 6 列授权的账号，MySQL 报的是 1143（没有这一列的权限），也一样退回。都要报错里点名 channel_info：别的列缺了不算，不能悄悄退
export function isMissingColumn(err) {
  const named = /channel_info/i.test(String(err?.message ?? ""));
  if (!named) return false;
  return err?.code === "ER_BAD_FIELD_ERROR" || err?.errno === 1054 || err?.code === "42703" || /no such column/i.test(String(err?.message ?? ""))
    || err?.code === "ER_COLUMNACCESS_DENIED_ERROR" || err?.errno === 1143;
}

// { code: 给外面的原因码, driver: 驱动自己的错误码（只用来记日志，只认字母数字下划线）}
export function classifyError(err) {
  const raw = String(err?.code ?? err?.errno ?? "UNKNOWN");
  const driver = SAFE_DRIVER_CODE.test(raw) ? raw : "UNKNOWN";
  const c = String(err?.code ?? "");
  const timedOut = err?.name === "TimeoutError" || /timeout|timed out/i.test(String(err?.message ?? ""));
  if (UNREACHABLE_NET.has(c) || MYSQL_NO_DB.has(c) || c === "3D000" || c.startsWith("08") || c === "57P03" || (timedOut && !c.startsWith("ER_"))) return { code: "DB_UNREACHABLE", driver };
  if (MYSQL_DENIED.has(c) || c.startsWith("28") || c === "42501") return { code: "DB_DENIED", driver };
  if (c === "ER_NO_SUCH_TABLE" || c === "42P01") return { code: "TABLE_MISSING", driver };
  if (err?.errcode !== undefined || err?.code === "ERR_SQLITE_ERROR") {
    const message = String(err?.message ?? "");
    // SQLite 的扩展错误码低 8 位才是主码（1544 = READONLY 的扩展，266 = IOERR 的扩展）
    const primary = Number(err.errcode) & 0xff;
    const named = `SQLITE_${Number.isFinite(primary) ? primary : "UNKNOWN"}`;
    if (/no such table/i.test(message)) return { code: "TABLE_MISSING", driver: named };
    if (primary === 14) return { code: "DB_UNREACHABLE", driver: "SQLITE_CANTOPEN" };
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

async function mysqlDriver(database, { queryTimeoutMs = QUERY_TIMEOUT_MS } = {}) {
  const { default: mysql } = await import("mysql2/promise");
  const pool = mysql.createPool({
    ...(database.socketPath ? { socketPath: database.socketPath } : { host: database.host, port: database.port }),
    user: database.user, password: database.password, database: database.database,
    ...(database.ssl ? { ssl: database.ssl } : {}),
    connectionLimit: 1, maxIdle: 1, idleTimeout: 60000, waitForConnections: true, queueLimit: 4, connectTimeout: CONNECT_TIMEOUT_MS,
    multipleStatements: false,
  });
  return {
    async read(withChannelInfo) {
      const conn = await pool.getConnection();
      let bad = false;
      try {
        if (!conn.connection.__readOnly) {
          await conn.query(MYSQL_READ_ONLY_SQL);
          conn.connection.__readOnly = true;
        }
        const [rows] = await conn.query({ sql: selectSql("mysql", withChannelInfo), timeout: queryTimeoutMs });
        return rows;
      } catch (err) {
        // 超时、断线这类不是库明确回的错（ER_ 开头）：这个连接上可能还挂着没跑完的查询，放回池里下一次读会排在它后面一直等，直接丢掉
        if (!String(err?.code ?? "").startsWith("ER_")) bad = true;
        throw err;
      } finally {
        if (bad) conn.destroy(); else conn.release();
      }
    },
    // 只给测试用：同一个（唯一的）连接上会话是不是只读
    async inspectReadOnly() {
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.query("SELECT @@session.transaction_read_only AS ro");
        return Number(rows[0].ro) === 1;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
}

async function postgresDriver(database, { queryTimeoutMs = QUERY_TIMEOUT_MS } = {}) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 1, connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: queryTimeoutMs, query_timeout: queryTimeoutMs, idleTimeoutMillis: 60000 });
  // 空闲连接被对方断开时会发 error 事件；没人听会让进程崩掉。原因下次读的时候自然会报
  pool.on("error", () => {});
  return {
    async read(withChannelInfo) {
      const client = await pool.connect();
      let broken = false;
      // 借出去以后池不再替这个连接听 error：查询中途被掐断时 pg 会发 error 事件，没人听就是进程崩溃
      const onError = () => { broken = true; };
      client.on("error", onError);
      try {
        if (!client.__readOnly) {
          await client.query(PG_READ_ONLY_SQL);
          client.__readOnly = true;
        }
        const result = await client.query(selectSql("postgres", withChannelInfo));
        return result.rows;
      } catch (err) {
        broken = true;
        throw err;
      } finally {
        client.removeListener("error", onError);
        client.release(broken);
      }
    },
    async inspectReadOnly() {
      const result = await pool.query("SHOW default_transaction_read_only");
      return result.rows[0].default_transaction_read_only === "on";
    },
    close: () => pool.end(),
  };
}

// SQLite 每次读开、读完关：New API 搬家、替换库文件时，长连接会盯着旧文件
async function sqliteDriver(database, { queryTimeoutMs = QUERY_TIMEOUT_MS } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  return {
    async read(withChannelInfo) {
      const db = new DatabaseSync(database.path, { readOnly: true, timeout: Math.min(CONNECT_TIMEOUT_MS, queryTimeoutMs) });
      try {
        return db.prepare(selectSql("sqlite", withChannelInfo)).all();
      } finally {
        db.close();
      }
    },
    close: async () => {},
  };
}

const DRIVERS = { mysql: mysqlDriver, postgres: postgresDriver, sqlite: sqliteDriver };

// 返回 { kind, read(): Promise<行数组>, close() }。read 失败抛 ReadFailure（带原因码）。
// onEvent({ ev, … })：值得记一笔的事（老表没有 channel_info 退回、重新用上）；now、deadlineMs、queryTimeoutMs：测试里换时钟和时限
export function createReader(database, { onEvent = () => {}, now = Date.now, deadlineMs = READ_DEADLINE_MS, queryTimeoutMs = QUERY_TIMEOUT_MS } = {}) {
  let driver = null;
  // 没有 channel_info 时 withChannelInfo 为 false，retryFullAt 之后再试一次带这一列的
  let withChannelInfo = true;
  let retryFullAt = 0;

  // 放手时把整个驱动丢掉，下一次读重新建：卡住的连接留在池里，后面的读都会排在它后面
  function reset() {
    const stale = driver;
    driver = null;
    stale?.close()?.catch?.(() => {});
  }

  async function readOnce() {
    driver ??= await DRIVERS[database.kind](database, { queryTimeoutMs });
    if (!withChannelInfo && now() >= retryFullAt) {
      try {
        const rows = await driver.read(true);
        withChannelInfo = true;
        onEvent({ ev: "channel_info_restored" });
        return rows;
      } catch (err) {
        if (!isMissingColumn(err)) throw err;
        retryFullAt = now() + FULL_RETRY_MS;
      }
    }
    try {
      return await driver.read(withChannelInfo);
    } catch (err) {
      // 老版本没有 channel_info 列：退到不含这一列的那条 SELECT；隔一阵再试带这一列的
      if (!withChannelInfo || !isMissingColumn(err)) throw err;
      withChannelInfo = false;
      retryFullAt = now() + FULL_RETRY_MS;
      onEvent({ ev: "channel_info_missing" });
      return driver.read(false);
    }
  }

  return {
    kind: database.kind,
    async read() {
      try {
        return await withDeadline(readOnce(), deadlineMs, reset);
      } catch (err) {
        if (err instanceof ReadFailure) throw err;
        // 连接断了、超时：连接池里那个连接可能已经不能用，丢掉重建
        if (classifyError(err).code === "DB_UNREACHABLE" && driver) reset();
        const { code, driver: driverCode } = classifyError(err);
        throw new ReadFailure(code, err?.code === "READ_DEADLINE" ? "READ_DEADLINE" : driverCode);
      }
    },
    async inspectReadOnly() {
      driver ??= await DRIVERS[database.kind](database, { queryTimeoutMs });
      return driver.inspectReadOnly ? driver.inspectReadOnly() : null;
    },
    // 查询卡住时也不挂住：最多等 2 秒
    async close() {
      const stale = driver;
      driver = null;
      try { await Promise.race([stale?.close(), sleep(CLOSE_DEADLINE_MS)]); } catch { /* 关不掉也不影响退出 */ }
    },
  };
}
