// 「读取服务不能影响线上的 New API」的那几条，逐条拿真库试：
// 账号权限检查、库自己掐掉卡住的查询（不靠客户端断开）、连接数和每小时语句数到顶、每次读一条语句。
// MySQL 的用例要设 KEY_AGENT_TEST_MYSQL_DSN（见 test-support/databases.js），PostgreSQL 的要设 KEY_AGENT_TEST_PG_URL；没设就跳过
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { resolveDatabase } from "./dsn.js";
import { judgeMysqlAccount, judgePgAccount } from "./account-check.js";
import { createReader } from "./reader.js";
import { openTestDatabase } from "./test-support/databases.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, { tries = 60, ms = 50 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    last = await check();
    if (last) return last;
    await sleep(ms);
  }
  return last;
}

test("账号检查（MySQL 的权限表）：只有 USAGE + channels 那 7 列的 SELECT 才过；别的一律不过，原因只给简短的名字", () => {
  const user = { scope: "user", priv: "USAGE", tbl: "", col: "" };
  const column = (col, priv = "SELECT", tbl = "newapi.channels") => ({ scope: "column", priv, tbl, col });
  const seven = ["id", "name", "type", "status", "base_url", "key", "channel_info"].map((c) => column(c));
  const judge = (rows) => judgeMysqlAccount(rows, { database: "newapi" });
  assert.equal(judge([user, ...seven]), null);
  assert.equal(judge([user, ...seven.slice(0, 6)]), null, "老表 6 列");
  assert.equal(judge([user]), null);
  assert.equal(judge([{ ...user, priv: "SELECT" }, ...seven]), "GLOBAL_PRIVILEGE");
  assert.equal(judge([{ ...user, priv: "PROCESS" }]), "GLOBAL_PRIVILEGE");
  assert.equal(judge([user, { scope: "schema", priv: "SELECT", tbl: "newapi", col: "" }]), "SCHEMA_PRIVILEGE");
  assert.equal(judge([user, { scope: "table", priv: "SELECT", tbl: "newapi.channels", col: "" }]), "TABLE_PRIVILEGE");
  assert.equal(judge([user, ...seven, column("group")]), "COLUMN_PRIVILEGE", "7 列以外的列");
  assert.equal(judge([user, ...seven, column("name", "UPDATE")]), "COLUMN_PRIVILEGE", "SELECT 以外的权限");
  assert.equal(judge([user, column("id", "SELECT", "newapi.users")]), "COLUMN_PRIVILEGE", "别的表");
  assert.equal(judge([user, column("id", "SELECT", "other.channels")]), "COLUMN_PRIVILEGE", "别的库的同名表");
  assert.equal(judge([user, ...["ID", "Key"].map((c) => column(c, "SELECT", "NewApi.Channels"))]), null, "大小写不敏感（库名表名列名）");
  assert.equal(judge(undefined), null);
});

test("账号检查（PostgreSQL 的角色和权限函数）：只有这 7 列的列级 SELECT 才过", () => {
  const ok = { elevated: false, connlimit: 1, other_tables: "0", write_privs: "0", table_select: false, extra_columns: "0" };
  assert.equal(judgePgAccount([ok]), null);
  assert.equal(judgePgAccount([{ ...ok, connlimit: -1 }]), null, "没设连接数上限不算权限过宽，--dry-run 里会提醒");
  assert.equal(judgePgAccount([]), "ROLE_UNKNOWN");
  assert.equal(judgePgAccount([{ ...ok, elevated: true }]), "ROLE_ATTRIBUTES");
  assert.equal(judgePgAccount([{ ...ok, other_tables: "3" }]), "OTHER_TABLES");
  assert.equal(judgePgAccount([{ ...ok, write_privs: "1" }]), "WRITE_PRIVILEGE");
  assert.equal(judgePgAccount([{ ...ok, table_select: true }]), "TABLE_WIDE_SELECT");
  assert.equal(judgePgAccount([{ ...ok, extra_columns: "1" }]), "EXTRA_COLUMNS");
});

const mysql = await openTestDatabase("mysql");
after(() => mysql?.close());
const skipMysql = !mysql && "没设 MySQL 的测试库环境变量";

// 单独一个连接，用来在库里锁表、占用账号的连接（LOCK TABLES 会限制这个连接自己，所以不能和 admin 共用）
async function openLocker() {
  const { default: driver } = await import("mysql2/promise");
  const url = new URL(process.env.KEY_AGENT_TEST_MYSQL_DSN);
  return driver.createConnection({ host: url.hostname, port: Number(url.port) || 3306, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) });
}
const readerOf = (account, options) => createReader(resolveDatabase(account.env), options);
// 库里记着这个账号累计连了几次（只算这个测试自己建的账号，不受别人影响）
const totalConnections = (name) => mysql.totalConnectionsOf(name);

test("MySQL 账号权限过宽就不读：管理员账号、多一个全局权限、整库、整表、多一列、多一种权限、别的表，都回 ACCOUNT_TOO_BROAD；之后不再连库", { skip: skipMysql, timeout: 60000 }, async (t) => {
  await mysql.reset();
  await mysql.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  await mysql.admin.query("DROP TABLE IF EXISTS other_table");
  await mysql.admin.query("CREATE TABLE other_table (id BIGINT PRIMARY KEY)");
  t.after(() => mysql.admin.query("DROP TABLE IF EXISTS other_table"));
  const db = mysql.database;
  const cases = [
    ["多一个全局权限", `GRANT PROCESS ON *.* TO '#'@'%'`, "GLOBAL_PRIVILEGE"],
    ["整库 SELECT", `GRANT SELECT ON \`${db}\`.* TO '#'@'%'`, "SCHEMA_PRIVILEGE"],
    ["channels 整表 SELECT", `GRANT SELECT ON \`${db}\`.channels TO '#'@'%'`, "TABLE_PRIVILEGE"],
    ["多一列（group）", `GRANT SELECT (\`group\`) ON \`${db}\`.channels TO '#'@'%'`, "COLUMN_PRIVILEGE"],
    ["多一种权限（UPDATE 一列）", `GRANT UPDATE (name) ON \`${db}\`.channels TO '#'@'%'`, "COLUMN_PRIVILEGE"],
    ["别的表的列", `GRANT SELECT (id) ON \`${db}\`.other_table TO '#'@'%'`, "COLUMN_PRIVILEGE"],
  ];
  for (const [label, grant, reason] of cases) {
    const account = await mysql.agentAccount();
    await mysql.admin.query(grant.replace("'#'", `'${account.name}'`));
    const events = [];
    const reader = readerOf(account, { onEvent: (e) => events.push(e) });
    await assert.rejects(reader.read(), { code: "ACCOUNT_TOO_BROAD", driver: reason }, label);
    assert.deepEqual(events, [{ ev: "account_too_broad", reason }], label);
    // 不再连库：再读几次，库里这个账号累计的连接数不变
    // 库里的累计连接数更新有一点点延迟：先等它记上第一次的那次连接，再比
    assert.equal(await eventually(async () => (await totalConnections(account.name)) >= 1), true, `${label}：第一次读连过库`);
    for (let i = 0; i < 3; i += 1) await assert.rejects(reader.read(), { code: "ACCOUNT_TOO_BROAD", driver: reason });
    await sleep(200);
    assert.equal(await totalConnections(account.name), 1, `${label}：判定以后不再连库`);
    assert.equal(reader.status().account, reason);
    await reader.close();
    await account.drop();
  }
  // 管理员账号（全局权限）也不行：不能直接用 New API 自己的账号
  const admin = { env: mysql.env };
  await assert.rejects(readerOf(admin).read(), { code: "ACCOUNT_TOO_BROAD", driver: "GLOBAL_PRIVILEGE" });
});

test("MySQL 库自己掐断卡住的查询：表被锁时每次读约半秒就回 DB_TIMEOUT，库里这个账号的连接不增长，解锁后同一个 reader 恢复", { skip: skipMysql, timeout: 60000 }, async (t) => {
  await mysql.reset();
  await mysql.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const account = await mysql.agentAccount();
  const locker = await openLocker();
  t.after(() => locker.end().catch(() => {}));
  const reader = readerOf(account);
  t.after(() => reader.close());
  assert.equal((await reader.read()).length, 1);
  await locker.query("LOCK TABLES channels WRITE");
  try {
    let peak = 0;
    for (let i = 1; i <= 5; i += 1) {
      const started = Date.now();
      await assert.rejects(reader.read(), { code: "DB_TIMEOUT" }, `第 ${i} 次`);
      assert.ok(Date.now() - started < 2500, `第 ${i} 次读 ${Date.now() - started} ms：库侧时限没起作用`);
      peak = Math.max(peak, await mysql.connectionsOf(account.name));
    }
    assert.ok(peak <= 1, `库里这个账号最多同时 ${peak} 个连接`);
    assert.equal(await eventually(async () => (await mysql.connectionsOf(account.name)) === 0), true, "掐掉以后连接都收了");
  } finally {
    await locker.query("UNLOCK TABLES");
  }
  assert.equal((await reader.read()).length, 1, "解锁以后同一个 reader 能读");
});

test("MySQL 库侧时限没起作用时（客户端那一道兜底）：回 PROTOCOL_SEQUENCE_TIMEOUT（不是总时限），库里的查询还卡着时新连接被连接数上限挡回（DB_LIMIT），连接数始终不超过 1，解锁后同一个 reader 恢复", { skip: skipMysql, timeout: 60000 }, async (t) => {
  await mysql.reset();
  await mysql.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const account = await mysql.agentAccount();
  const locker = await openLocker();
  t.after(() => locker.end().catch(() => {}));
  // dbTimeLimitMs: 0 = 不带库侧时限，模拟老版本（没有语句级时限）的 MySQL
  const reader = readerOf(account, { dbTimeLimitMs: 0, queryTimeoutMs: 600, deadlineMs: 5000 });
  t.after(() => reader.close());
  assert.equal((await reader.read()).length, 1);
  await locker.query("LOCK TABLES channels WRITE");
  try {
    await assert.rejects(reader.read(), { code: "DB_UNREACHABLE", driver: "PROTOCOL_SEQUENCE_TIMEOUT" });
    assert.equal(await mysql.connectionsOf(account.name), 1, "库里的那条查询还卡着（客户端 destroy 停不了它）");
    let peak = 1;
    for (let i = 0; i < 4; i += 1) {
      await assert.rejects(reader.read(), { code: "DB_LIMIT" }, "旧连接还在，新连接被账号的连接数上限挡回");
      peak = Math.max(peak, await mysql.connectionsOf(account.name));
    }
    assert.equal(peak, 1, "连接数始终是 1，不会越漏越多");
  } finally {
    await locker.query("UNLOCK TABLES");
  }
  assert.equal(await eventually(async () => (await mysql.connectionsOf(account.name)) === 0, { tries: 100 }), true, "解锁后卡着的查询跑完、连接收掉");
  assert.equal((await reader.read()).length, 1, "同一个 reader 恢复");
});

test("MySQL 账号的连接数上限 1：别处占着这个账号的连接时，读取服务回 DB_LIMIT，占着的连接不受影响", { skip: skipMysql, timeout: 30000 }, async (t) => {
  await mysql.reset();
  await mysql.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const account = await mysql.agentAccount();
  const { default: driver } = await import("mysql2/promise");
  const url = new URL(process.env.KEY_AGENT_TEST_MYSQL_DSN);
  const holder = await driver.createConnection({ host: url.hostname, port: Number(url.port) || 3306, user: account.name, password: account.password, database: url.pathname.slice(1) });
  t.after(() => holder.end().catch(() => {}));
  const reader = readerOf(account);
  t.after(() => reader.close());
  await assert.rejects(reader.read(), { code: "DB_LIMIT" });
  assert.equal((await holder.query("SELECT 1 AS one"))[0][0].one, 1);
  await holder.end();
  assert.equal((await reader.read()).length, 1);
});

test("MySQL 每小时语句额度：每次读正好 1 条语句（第一次多 1 条权限检查）；额度用完回 DB_LIMIT", { skip: skipMysql, timeout: 30000 }, async (t) => {
  await mysql.reset();
  await mysql.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  // 额度 3：第 1 次读 = 权限检查 + SELECT（2 条），第 2 次读 = SELECT（1 条），第 3 次读就超了
  const account = await mysql.agentAccount({ limits: "MAX_USER_CONNECTIONS 1 MAX_QUERIES_PER_HOUR 3" });
  const reader = readerOf(account);
  t.after(() => reader.close());
  assert.equal((await reader.read()).length, 1);
  assert.equal((await reader.read()).length, 1, "第二次读只多 1 条语句");
  await assert.rejects(reader.read(), { code: "DB_LIMIT" });
  assert.equal(await mysql.connectionsOf(account.name), 0);
});

test("MySQL 每次读连一次：5 次读，账号累计连接数正好多 5 次", { skip: skipMysql, timeout: 30000 }, async (t) => {
  await mysql.reset();
  await mysql.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const account = await mysql.agentAccount();
  const reader = readerOf(account);
  t.after(() => reader.close());
  for (let i = 0; i < 5; i += 1) await reader.read();
  assert.equal(await eventually(async () => (await totalConnections(account.name)) === 5), true, `累计连了 ${await totalConnections(account.name)} 次`);
  await sleep(200);
  assert.equal(await totalConnections(account.name), 5);
});

test("MySQL --dry-run：读一次、打印耗时和渠道数，不打 Key；账号过宽时退出码 1 并说明", { skip: skipMysql, timeout: 30000 }, async (t) => {
  const { runDryRun } = await import("./dry-run.js");
  await mysql.reset();
  await mysql.seed([{ id: 1, key: `sk-${"a".repeat(30)}SECRETKEYBODY` }, { id: 2, key: `sk-${"b".repeat(30)}` }]);
  const out = [];
  const account = await mysql.agentAccount();
  assert.equal(await runDryRun({ reader: readerOf(account), write: (line) => out.push(line) }), 0);
  assert.match(out.join("\n"), /读取：成功，2 个渠道/);
  assert.match(out.join("\n"), /只有 channels 表那几列的 SELECT/);
  assert.doesNotMatch(out.join("\n"), /SECRETKEYBODY|channel-1/);
  const broad = [];
  assert.equal(await runDryRun({ reader: readerOf({ env: mysql.env }), write: (line) => broad.push(line) }), 1);
  assert.match(broad.join("\n"), /ACCOUNT_TOO_BROAD/);
  assert.match(broad.join("\n"), /账号有全局权限/);
});

const pg = await openTestDatabase("postgres");
after(() => pg?.close());
const skipPg = !pg && "没设 PostgreSQL 的测试库环境变量";

test("PostgreSQL 账号权限过宽就不读：超级用户、能建库、多一列、整表 SELECT、写权限、别的表；专用角色能读", { skip: skipPg, timeout: 60000 }, async (t) => {
  await pg.reset();
  await pg.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  await pg.admin.query("DROP TABLE IF EXISTS other_table");
  await pg.admin.query("CREATE TABLE other_table (id BIGINT PRIMARY KEY)");
  t.after(() => pg.admin.query("DROP TABLE IF EXISTS other_table"));
  const good = await pg.agentAccount();
  const goodReader = readerOf(good);
  t.after(() => goodReader.close());
  assert.equal((await goodReader.read()).length, 1);
  assert.equal(goodReader.status().connectionLimit, 1);
  assert.equal(await pg.connectionsOf(good.name), 0, "读完就断");
  const cases = [
    ["能建库", (name) => `ALTER ROLE ${name} CREATEDB`, "ROLE_ATTRIBUTES"],
    ["整表 SELECT", (name) => `GRANT SELECT ON channels TO ${name}`, "TABLE_WIDE_SELECT"],
    ["多一列（group）", (name) => `GRANT SELECT ("group") ON channels TO ${name}`, "EXTRA_COLUMNS"],
    ["写权限", (name) => `GRANT INSERT (name) ON channels TO ${name}`, "WRITE_PRIVILEGE"],
    ["别的表", (name) => `GRANT SELECT ON other_table TO ${name}`, "OTHER_TABLES"],
  ];
  for (const [label, grant, reason] of cases) {
    const account = await pg.agentAccount();
    await pg.admin.query(grant(account.name));
    const reader = readerOf(account);
    await assert.rejects(reader.read(), { code: "ACCOUNT_TOO_BROAD", driver: reason }, label);
    await reader.close();
  }
  // 管理员（超级用户）也不行
  await assert.rejects(readerOf({ env: pg.env }).read(), { code: "ACCOUNT_TOO_BROAD", driver: "ROLE_ATTRIBUTES" });
});

test("PostgreSQL 库自己掐断卡住的查询（表被锁，角色的 statement_timeout / 连接的启动参数）：回 DB_TIMEOUT，连接不增长，解锁后恢复；连接数上限 1 挡回新连接（DB_LIMIT）", { skip: skipPg, timeout: 60000 }, async (t) => {
  await pg.reset();
  await pg.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const account = await pg.agentAccount();
  const { default: driver } = await import("pg");
  const locker = new driver.Client({ connectionString: process.env.KEY_AGENT_TEST_PG_URL });
  await locker.connect();
  t.after(() => locker.end().catch(() => {}));
  const reader = readerOf(account);
  t.after(() => reader.close());
  assert.equal((await reader.read()).length, 1);
  await locker.query("BEGIN");
  await locker.query("LOCK TABLE channels IN ACCESS EXCLUSIVE MODE");
  try {
    for (let i = 1; i <= 3; i += 1) {
      const started = Date.now();
      await assert.rejects(reader.read(), { code: "DB_TIMEOUT" }, `第 ${i} 次`);
      assert.ok(Date.now() - started < 2500);
      assert.ok((await pg.connectionsOf(account.name)) <= 1);
    }
  } finally {
    await locker.query("ROLLBACK");
  }
  assert.equal((await reader.read()).length, 1);
  // 连接数上限：别处占着这个角色的连接时
  const holder = new driver.Client({ connectionString: account.env.KEY_AGENT_DSN });
  await holder.connect();
  t.after(() => holder.end().catch(() => {}));
  await assert.rejects(reader.read(), { code: "DB_LIMIT" });
});

