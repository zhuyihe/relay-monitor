// 测试用的库：按较早版本的 New API 的 channels 表结构（够用的那些列，含 channel_info）建表、灌数据。
// agentEnv()：照部署说明给读取服务建一个专用账号（只有 channels 表现有那几列的 SELECT、连接数上限 1），返回读取服务用的环境变量；
// 读取服务不会用管理员账号读（权限过宽它不读）。账号在 close() 时删掉
// SQLite 一直有；MySQL 要设 KEY_AGENT_TEST_MYSQL_DSN（mysql://用户:密码@主机:端口/库，一个可随便清的库），
// PostgreSQL 要设 KEY_AGENT_TEST_PG_URL。没设就跳过，不报错
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const COLUMNS = ["id", "type", "key", "status", "name", "base_url", "channel_info"];

function ddl(kind, withChannelInfo) {
  const info = withChannelInfo ? { mysql: ", channel_info JSON NULL", postgres: ", channel_info JSON NULL", sqlite: ", channel_info TEXT" }[kind] : "";
  if (kind === "mysql") {
    return `CREATE TABLE channels (id BIGINT NOT NULL PRIMARY KEY, type BIGINT DEFAULT 0, \`key\` LONGTEXT NOT NULL, status BIGINT DEFAULT 1, name VARCHAR(191), base_url VARCHAR(191) DEFAULT '', \`group\` VARCHAR(64) DEFAULT 'default', priority BIGINT DEFAULT 0${info})`;
  }
  if (kind === "postgres") {
    return `CREATE TABLE channels (id BIGINT NOT NULL PRIMARY KEY, type BIGINT DEFAULT 0, "key" TEXT NOT NULL, status BIGINT DEFAULT 1, name VARCHAR(191), base_url VARCHAR(191) DEFAULT '', "group" VARCHAR(64) DEFAULT 'default', priority BIGINT DEFAULT 0${info})`;
  }
  return `CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, type INTEGER DEFAULT 0, key TEXT NOT NULL, status INTEGER DEFAULT 1, name TEXT, base_url TEXT DEFAULT '', "group" TEXT DEFAULT 'default', priority INTEGER DEFAULT 0${info})`;
}

const rowValues = (row, withChannelInfo) => {
  const info = row.channel_info === undefined || row.channel_info === null ? null : typeof row.channel_info === "string" ? row.channel_info : JSON.stringify(row.channel_info);
  const values = [row.id, row.type ?? 1, row.key, row.status ?? 1, row.name ?? `channel-${row.id}`, row.base_url ?? ""];
  return withChannelInfo ? [...values, info] : values;
};

async function sqliteDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "key-agent-"));
  const path = join(dir, "one-api.db");
  let withInfo = true;
  let holder = null;
  const open = () => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    return db;
  };
  return {
    kind: "sqlite",
    env: { SQLITE_PATH: `${path}?_busy_timeout=30000` },
    path,
    async agentEnv() { return this.env; },
    async reset({ withChannelInfo = true } = {}) {
      withInfo = withChannelInfo;
      // 留着一个连接不关：像一直在跑的 New API，-wal 文件就一直在（读取服务在 WAL 库没有 -wal 时不读）
      holder ??= open();
      holder.exec("DROP TABLE IF EXISTS channels");
      holder.exec(ddl("sqlite", withChannelInfo));
    },
    async seed(rows) {
      const db = open();
      db.exec("BEGIN");
      const cols = withInfo ? COLUMNS : COLUMNS.slice(0, -1);
      const stmt = db.prepare(`INSERT INTO channels (${cols.map((c) => (c === "key" ? '"key"' : c)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
      for (const row of rows) stmt.run(...rowValues(row, withInfo));
      db.exec("COMMIT");
      db.close();
    },
    async dropTable() {
      const db = open();
      db.exec("DROP TABLE IF EXISTS channels");
      db.close();
    },
    // 干净关闭 New API：最后一个连接关掉以后 -wal 没了
    stopNewApi() { holder?.close(); holder = null; },
    async close() { holder?.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function mysqlDatabase(url) {
  const { default: mysql } = await import("mysql2/promise");
  const parsed = new URL(url);
  const admin = await mysql.createConnection({ host: parsed.hostname, port: Number(parsed.port) || 3306, user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password), database: parsed.pathname.slice(1) });
  const database = parsed.pathname.slice(1);
  const goDsn = (user, password, port = Number(parsed.port) || 3306) => `${user}:${password}@tcp(${parsed.hostname}:${port})/${database}?charset=utf8mb4&parseTime=True&loc=Local`;
  let withInfo = true;
  const accounts = [];
  let mariadb = null;
  const isMariadb = async () => (mariadb ??= /mariadb/i.test(String((await admin.query("SELECT VERSION() AS v"))[0][0].v)));
  return {
    kind: "mysql",
    database,
    host: parsed.hostname,
    port: Number(parsed.port) || 3306,
    goDsn,
    password: decodeURIComponent(parsed.password),
    adminDsn: goDsn(decodeURIComponent(parsed.username), decodeURIComponent(parsed.password)),
    get env() { return { SQL_DSN: this.adminDsn }; },
    admin,
    // 专用账号：现有的列（老表没有 channel_info 就 6 列）列级 SELECT；limits 是 CREATE USER 的 WITH 子句，默认只限连接数 1
    async agentAccount({ limits = "MAX_USER_CONNECTIONS 1", columns } = {}) {
      const name = `ka_${randomBytes(4).toString("hex")}`, password = `Pw-${randomBytes(9).toString("hex")}-Zq3v`;
      const list = (columns ?? (withInfo ? COLUMNS : COLUMNS.slice(0, -1))).map((c) => (c === "key" ? "`key`" : c)).join(", ");
      if (await isMariadb()) await admin.query("SET GLOBAL userstat = 1");
      await admin.query(`CREATE USER '${name}'@'%' IDENTIFIED BY '${password}' WITH ${limits}`);
      accounts.push(name);
      await admin.query(`GRANT SELECT (${list}) ON \`${database}\`.channels TO '${name}'@'%'`);
      return { name, password, env: { KEY_AGENT_DSN: goDsn(name, password) },
        async drop() { await admin.query(`DROP USER IF EXISTS '${name}'@'%'`); } };
    },
    async agentEnv() { return (await this.agentAccount()).env; },
    // 这个账号累计连过几次：MySQL 看 performance_schema.accounts；MariaDB 的 performance_schema 默认关着（表在但是空的），改看 USER_STATISTICS（agentAccount 里已经开了 userstat）
    async totalConnectionsOf(name) {
      const table = await isMariadb() ? "information_schema.USER_STATISTICS" : "performance_schema.accounts";
      return Number((await admin.query(`SELECT COALESCE(SUM(TOTAL_CONNECTIONS), 0) AS n FROM ${table} WHERE USER = ?`, [name]))[0][0].n);
    },
    // 这个账号在库里现在有几个连接（读取服务一次只许 1 个）
    async connectionsOf(name) { return Number((await admin.query("SELECT COUNT(*) AS n FROM information_schema.processlist WHERE user = ?", [name]))[0][0].n); },
    async reset({ withChannelInfo = true } = {}) {
      withInfo = withChannelInfo;
      await admin.query("DROP TABLE IF EXISTS channels");
      await admin.query(ddl("mysql", withChannelInfo));
    },
    async seed(rows) {
      const cols = withInfo ? COLUMNS : COLUMNS.slice(0, -1);
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        await admin.query(`INSERT INTO channels (${cols.map((c) => (c === "key" ? "`key`" : c)).join(", ")}) VALUES ${chunk.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ")}`,
          chunk.flatMap((row) => rowValues(row, withInfo)));
      }
    },
    async dropTable() { await admin.query("DROP TABLE IF EXISTS channels"); },
    async close() {
      for (const name of accounts) await admin.query(`DROP USER IF EXISTS '${name}'@'%'`).catch(() => {});
      await admin.end();
    },
  };
}

async function postgresDatabase(url) {
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const parsed = new URL(url);
  let withInfo = true;
  const roles = [];
  return {
    kind: "postgres",
    url,
    password: decodeURIComponent(parsed.password),
    admin,
    env: { SQL_DSN: url },
    // 专用角色：现有的列列级 SELECT、连接数上限 1、查询时限（照部署说明）
    async agentAccount({ columns } = {}) {
      const name = `ka_${randomBytes(4).toString("hex")}`, password = `Pw${randomBytes(9).toString("hex")}`;
      const list = (columns ?? (withInfo ? COLUMNS : COLUMNS.slice(0, -1))).map((c) => `"${c}"`).join(", ");
      await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' CONNECTION LIMIT 1`);
      roles.push(name);
      await admin.query(`ALTER ROLE ${name} SET statement_timeout = '500ms'`);
      await admin.query(`GRANT SELECT (${list}) ON channels TO ${name}`);
      const own = new URL(url);
      own.username = name;
      own.password = password;
      return { name, password, env: { KEY_AGENT_DSN: own.toString() }, async drop() { await admin.query(`DROP OWNED BY ${name}`); await admin.query(`DROP ROLE IF EXISTS ${name}`); } };
    },
    async agentEnv() { return (await this.agentAccount()).env; },
    async connectionsOf(name) { return Number((await admin.query("SELECT count(*) AS n FROM pg_stat_activity WHERE usename = $1", [name])).rows[0].n); },
    async reset({ withChannelInfo = true } = {}) {
      withInfo = withChannelInfo;
      await admin.query("DROP TABLE IF EXISTS channels");
      await admin.query(ddl("postgres", withChannelInfo));
    },
    async seed(rows) {
      const cols = withInfo ? COLUMNS : COLUMNS.slice(0, -1);
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const width = cols.length;
        await admin.query(`INSERT INTO channels (${cols.map((c) => (c === "key" ? '"key"' : c)).join(", ")}) VALUES ${chunk.map((_, r) => `(${cols.map((__, c) => `$${r * width + c + 1}`).join(", ")})`).join(", ")}`,
          chunk.flatMap((row) => rowValues(row, withInfo)));
      }
    },
    async dropTable() { await admin.query("DROP TABLE IF EXISTS channels"); },
    async close() {
      for (const name of roles) { await admin.query(`DROP OWNED BY ${name}`).catch(() => {}); await admin.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {}); }
      await admin.end();
    },
  };
}

// 返回 null 表示这台机器没配这种库，用例该跳过
export async function openTestDatabase(kind) {
  if (kind === "sqlite") return sqliteDatabase();
  if (kind === "mysql") return process.env.KEY_AGENT_TEST_MYSQL_DSN ? mysqlDatabase(process.env.KEY_AGENT_TEST_MYSQL_DSN) : null;
  if (kind === "postgres") return process.env.KEY_AGENT_TEST_PG_URL ? postgresDatabase(process.env.KEY_AGENT_TEST_PG_URL) : null;
  throw new Error(`unknown kind ${kind}`);
}

export const TEST_KINDS = ["sqlite", "mysql", "postgres"];
export const AVAILABLE_KINDS = [
  "sqlite",
  ...(process.env.KEY_AGENT_TEST_MYSQL_DSN ? ["mysql"] : []),
  ...(process.env.KEY_AGENT_TEST_PG_URL ? ["postgres"] : []),
];
