// 测试用的库：按较早版本的 New API 的 channels 表结构（够用的那些列，含 channel_info）建表、灌数据。
// SQLite 一直有；MySQL 要设 KEY_AGENT_TEST_MYSQL_DSN（mysql://用户:密码@主机:端口/库，一个可随便清的库），
// PostgreSQL 要设 KEY_AGENT_TEST_PG_URL。没设就跳过，不报错
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const open = () => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    return db;
  };
  return {
    kind: "sqlite",
    env: { SQLITE_PATH: `${path}?_busy_timeout=30000` },
    path,
    async reset({ withChannelInfo = true } = {}) {
      withInfo = withChannelInfo;
      const db = open();
      db.exec("DROP TABLE IF EXISTS channels");
      db.exec(ddl("sqlite", withChannelInfo));
      db.close();
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
    async close() { rmSync(dir, { recursive: true, force: true }); },
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
    async close() { await admin.end(); },
  };
}

async function postgresDatabase(url) {
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const parsed = new URL(url);
  let withInfo = true;
  return {
    kind: "postgres",
    url,
    password: decodeURIComponent(parsed.password),
    admin,
    env: { SQL_DSN: url },
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
    async close() { await admin.end(); },
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
