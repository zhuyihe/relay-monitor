// 读 New API 的 channels 表：只发一条固定的 SELECT，会话设成只读，连接池只开 1 个连接。
// 报错只在这里看驱动的错误码，往外只给原因码（DB_UNREACHABLE / DB_DENIED / TABLE_MISSING / DB_ERROR），不带库的报错原文（可能带出主机、账号）
const FULL_COLUMNS = "id, name, type, status, base_url, KEY_COL, channel_info";
const NO_INFO_COLUMNS = "id, name, type, status, base_url, KEY_COL";
const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 8000;

export const MYSQL_READ_ONLY_SQL = "SET SESSION TRANSACTION READ ONLY";
export const PG_READ_ONLY_SQL = "SET default_transaction_read_only = on";

export const selectSql = (kind, withChannelInfo) => {
  const quoted = kind === "mysql" ? "`key`" : '"key"';
  return `SELECT ${(withChannelInfo ? FULL_COLUMNS : NO_INFO_COLUMNS).replace("KEY_COL", quoted)} FROM channels ORDER BY id`;
};

const UNREACHABLE_NET = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "PROTOCOL_CONNECTION_LOST", "PROTOCOL_SEQUENCE_TIMEOUT"]);
const MYSQL_DENIED = new Set(["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "ER_HOST_NOT_PRIVILEGED", "ER_HOST_IS_BLOCKED", "ER_ACCESS_DENIED_NO_PASSWORD_ERROR"]);
const MYSQL_NO_DB = new Set(["ER_BAD_DB_ERROR"]);

// 缺列：MySQL 1054 / PostgreSQL 42703 / SQLite no such column（SQLite 只能看文字）
export function isMissingColumn(err) {
  return err?.code === "ER_BAD_FIELD_ERROR" || err?.errno === 1054 || err?.code === "42703" || /no such column/i.test(String(err?.message ?? ""));
}

// { code: 给外面的原因码, driver: 驱动自己的错误码（只用来记日志）}
export function classifyError(err) {
  const driver = String(err?.code ?? err?.errno ?? "UNKNOWN").slice(0, 40);
  const c = String(err?.code ?? "");
  const timedOut = err?.name === "TimeoutError" || /timeout|timed out/i.test(String(err?.message ?? ""));
  if (UNREACHABLE_NET.has(c) || MYSQL_NO_DB.has(c) || c === "3D000" || c.startsWith("08") || c === "57P03" || (timedOut && !c.startsWith("ER_"))) return { code: "DB_UNREACHABLE", driver };
  if (MYSQL_DENIED.has(c) || c.startsWith("28") || c === "42501") return { code: "DB_DENIED", driver };
  if (c === "ER_NO_SUCH_TABLE" || c === "42P01") return { code: "TABLE_MISSING", driver };
  if (err?.errcode !== undefined || err?.code === "ERR_SQLITE_ERROR") {
    const message = String(err?.message ?? "");
    if (/no such table/i.test(message)) return { code: "TABLE_MISSING", driver: `SQLITE_${err.errcode}` };
    if (err.errcode === 14) return { code: "DB_UNREACHABLE", driver: "SQLITE_CANTOPEN" };
    if (err.errcode === 8 || err.errcode === 23 || err.errcode === 3) return { code: "DB_DENIED", driver: `SQLITE_${err.errcode}` };
    return { code: "DB_ERROR", driver: `SQLITE_${err.errcode}` };
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

async function mysqlDriver(database) {
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
      try {
        if (!conn.connection.__readOnly) {
          await conn.query(MYSQL_READ_ONLY_SQL);
          conn.connection.__readOnly = true;
        }
        const [rows] = await conn.query({ sql: selectSql("mysql", withChannelInfo), timeout: QUERY_TIMEOUT_MS });
        return rows;
      } finally {
        conn.release();
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

async function postgresDriver(database) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: database.connectionString, max: 1, connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS, query_timeout: QUERY_TIMEOUT_MS, idleTimeoutMillis: 60000 });
  // 空闲连接被对方断开时会发 error 事件；没人听会让进程崩掉。原因下次读的时候自然会报
  pool.on("error", () => {});
  return {
    async read(withChannelInfo) {
      const client = await pool.connect();
      let broken = false;
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
async function sqliteDriver(database) {
  const { DatabaseSync } = await import("node:sqlite");
  return {
    async read(withChannelInfo) {
      const db = new DatabaseSync(database.path, { readOnly: true, timeout: CONNECT_TIMEOUT_MS });
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

// 返回 { kind, read(): Promise<行数组>, close() }。read 失败抛 ReadFailure（带原因码）
export function createReader(database) {
  let driver = null;
  let withChannelInfo = true;
  return {
    kind: database.kind,
    async read() {
      try {
        driver ??= await DRIVERS[database.kind](database);
        try {
          return await driver.read(withChannelInfo);
        } catch (err) {
          // 老版本没有 channel_info 列：退到不含这一列的那条 SELECT，以后都这样
          if (!withChannelInfo || !isMissingColumn(err)) throw err;
          withChannelInfo = false;
          return await driver.read(false);
        }
      } catch (err) {
        if (err instanceof ReadFailure) throw err;
        const { code, driver: driverCode } = classifyError(err);
        throw new ReadFailure(code, driverCode);
      }
    },
    async inspectReadOnly() {
      driver ??= await DRIVERS[database.kind](database);
      return driver.inspectReadOnly ? driver.inspectReadOnly() : null;
    },
    async close() {
      try { await driver?.close(); } catch { /* 关不掉也不影响退出 */ }
      driver = null;
    },
  };
}
