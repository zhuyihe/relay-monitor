// 读库中途出事时读取服务要活着、下一次能读：PostgreSQL 查询中途连接被掐（假 PG 服务）、MySQL 查询超时以后连接不能留在池里（真库，设了环境变量才跑）、
// 老表没有 channel_info 退回以后隔一阵再试（SQLite）、总时限、关闭不挂住
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabase } from "./dsn.js";
import { createReader } from "./reader.js";
import { openTestDatabase } from "./test-support/databases.js";
import { startFakePg } from "./test-support/fake-pg.js";

const pgReader = (fake, options) => createReader(resolveDatabase({ SQL_DSN: `postgres://u:SECRETPW@127.0.0.1:${fake.port}/db` }), options);
let pgAvailable = true;
try { await import("pg"); } catch { pgAvailable = false; }

test("PostgreSQL 查询中途连接被掐断：读取服务不崩，回原因码、不带连接串里的密码，下一次读照样能再试", { skip: !pgAvailable && "没装 pg（npm ci --prefix agent）" }, async (t) => {
  const fake = await startFakePg("drop-in-select");
  t.after(() => fake.close());
  const reader = pgReader(fake, { deadlineMs: 4000 });
  t.after(() => reader.close());
  // 没有人听的 error 事件会让整个测试进程崩掉，所以能走到这里就说明有人接住了
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(reader.read(), (err) => ["DB_UNREACHABLE", "DB_ERROR"].includes(err.code) && !/SECRETPW/.test(JSON.stringify(err)) && !/SECRETPW/.test(err.message));
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
});

test("PostgreSQL 读完以后空闲连接被掐断：读取服务不崩，下一次读要么读到要么回原因码", { skip: !pgAvailable && "没装 pg" }, async (t) => {
  const fake = await startFakePg("idle-drop");
  t.after(() => fake.close());
  const reader = pgReader(fake, { deadlineMs: 4000 });
  t.after(() => reader.close());
  assert.deepEqual(await reader.read(), []);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await reader.read().then((rows) => assert.deepEqual(rows, []), (err) => assert.ok(["DB_UNREACHABLE", "DB_ERROR"].includes(err.code)));
});

test("PostgreSQL 查询卡住：总时限一到就放手回 DB_UNREACHABLE，close() 不挂住", { skip: !pgAvailable && "没装 pg" }, async (t) => {
  const fake = await startFakePg("hang");
  t.after(() => fake.close());
  const reader = pgReader(fake, { deadlineMs: 600, queryTimeoutMs: 60000 });
  const started = Date.now();
  await assert.rejects(reader.read(), { code: "DB_UNREACHABLE", driver: "READ_DEADLINE" });
  assert.ok(Date.now() - started < 3000);
  const closing = Date.now();
  await reader.close();
  assert.ok(Date.now() - closing < 3000, "close() 最多等 2 秒");
});

test("老表没有 channel_info：先退回不含它的 SELECT，隔 10 分钟再试带它的，列补上以后用上多 Key 信息", async (t) => {
  const db = await openTestDatabase("sqlite");
  t.after(() => db.close());
  await db.reset({ withChannelInfo: false });
  await db.seed([{ id: 1, key: `sk-${"a".repeat(30)}\nsk-${"b".repeat(30)}` }]);
  const events = [];
  const clock = { t: 1_000_000 };
  const reader = createReader(resolveDatabase(db.env), { onEvent: (event) => events.push(event.ev), now: () => clock.t });
  t.after(() => reader.close());
  assert.equal((await reader.read()).length, 1);
  assert.deepEqual(events, ["channel_info_missing"]);
  // 10 分钟内不再试：就算列已经补上了
  const raw = new DatabaseSync(db.path);
  raw.exec("ALTER TABLE channels ADD COLUMN channel_info TEXT");
  raw.prepare("UPDATE channels SET channel_info = ? WHERE id = 1").run(JSON.stringify({ is_multi_key: true }));
  raw.close();
  clock.t += 9 * 60 * 1000;
  assert.equal("channel_info" in (await reader.read())[0], false);
  clock.t += 2 * 60 * 1000;
  const rows = await reader.read();
  assert.equal(rows[0].channel_info, JSON.stringify({ is_multi_key: true }));
  assert.deepEqual(events, ["channel_info_missing", "channel_info_restored"]);
});

test("老表上第二次试带 channel_info 仍然缺列：继续不含它，再等 10 分钟，不重复记事件", async (t) => {
  const db = await openTestDatabase("sqlite");
  t.after(() => db.close());
  await db.reset({ withChannelInfo: false });
  await db.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const events = [];
  const clock = { t: 5_000_000 };
  const reader = createReader(resolveDatabase(db.env), { onEvent: (event) => events.push(event.ev), now: () => clock.t });
  t.after(() => reader.close());
  await reader.read();
  clock.t += 11 * 60 * 1000;
  assert.equal((await reader.read()).length, 1);
  clock.t += 5 * 60 * 1000;
  assert.equal((await reader.read()).length, 1);
  assert.deepEqual(events, ["channel_info_missing"]);
});

// MySQL：查询卡住（表被锁）超时以后，连接要丢掉、下一次读重新建连接，不能排在卡住的那条后面一直等
const mysql = await openTestDatabase("mysql");
after(() => mysql?.close());
test("MySQL 查询超时：连接被丢掉，下一次读不会排在卡住的那条后面；解锁后恢复；卡住时 close() 不挂住", { skip: !mysql && "没设 MySQL 的测试库环境变量", timeout: 30000 }, async (t) => {
  await mysql.reset();
  await mysql.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const mysqlModule = (await import("mysql2/promise")).default;
  const url = new URL(process.env.KEY_AGENT_TEST_MYSQL_DSN);
  const locker = await mysqlModule.createConnection({ host: url.hostname, port: Number(url.port) || 3306, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) });
  t.after(() => locker.end().catch(() => {}));
  const reader = createReader(resolveDatabase(mysql.env), { queryTimeoutMs: 500, deadlineMs: 4000 });
  t.after(() => reader.close());
  assert.equal((await reader.read()).length, 1);
  await locker.query("LOCK TABLES channels WRITE");
  try {
    for (let i = 0; i < 3; i += 1) {
      const started = Date.now();
      await assert.rejects(reader.read(), { code: "DB_UNREACHABLE" });
      assert.ok(Date.now() - started < 4500, `第 ${i + 1} 次读 ${Date.now() - started} ms，没有永久挂住`);
    }
    const closing = Date.now();
    const pending = reader.read().catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await reader.close();
    assert.ok(Date.now() - closing < 3500);
    await pending;
  } finally {
    await locker.query("UNLOCK TABLES");
  }
  const fresh = createReader(resolveDatabase(mysql.env), { queryTimeoutMs: 500, deadlineMs: 4000 });
  t.after(() => fresh.close());
  assert.equal((await fresh.read()).length, 1);
});

test("MySQL 老表只给 6 列授权（没有 channel_info 的权限）：1143 也退回，能读", { skip: !mysql && "没设 MySQL 的测试库环境变量", timeout: 30000 }, async (t) => {
  await mysql.reset({ withChannelInfo: false });
  await mysql.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const name = `ka_${Math.random().toString(16).slice(2, 10)}`, password = `Pw-${Math.random().toString(16).slice(2)}-Zq3v9L`;
  try { await mysql.admin.query(`CREATE USER '${name}'@'%' IDENTIFIED BY '${password}'`); } catch { t.diagnostic("建不了账号，跳过"); return; }
  t.after(() => mysql.admin.query(`DROP USER IF EXISTS '${name}'@'%'`));
  await mysql.admin.query(`GRANT SELECT (id, name, type, status, base_url, \`key\`) ON \`${mysql.database}\`.channels TO '${name}'@'%'`);
  const events = [];
  const reader = createReader(resolveDatabase({ KEY_AGENT_DSN: mysql.goDsn(name, password) }), { onEvent: (event) => events.push(event.ev) });
  t.after(() => reader.close());
  assert.equal((await reader.read()).length, 1);
  assert.deepEqual(events, ["channel_info_missing"]);
});

test("SIGTERM：有只发了半截请求头的连接时，进程也在几秒内退出", { timeout: 30000 }, async (t) => {
  const db = await openTestDatabase("sqlite");
  t.after(() => db.close());
  await db.reset();
  await db.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", new URL("./server.js", import.meta.url).pathname],
    { env: { PATH: process.env.PATH, RELAY_KEY_AGENT_SECRET: "sigterm-Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE", PORT: String(port), HOST: "127.0.0.1", ...db.env }, stdio: "ignore" });
  for (let i = 0; i < 100; i += 1) {
    const up = await new Promise((resolve) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
    if (up) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const half = net.connect(port, "127.0.0.1");
  half.on("error", () => {});
  await once(half, "connect");
  half.write("GET /keys HTTP/1.1\r\nHost: x\r\n");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = Date.now();
  child.kill("SIGTERM");
  await once(child, "exit");
  half.destroy();
  assert.ok(Date.now() - started < 9000, `退出用了 ${Date.now() - started} ms`);
});
