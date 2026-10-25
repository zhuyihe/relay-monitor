// 读库中途出事时读取服务要活着、下一次能读：PostgreSQL 查询中途连接被掐（假 PG 服务）、
// 老表没有 channel_info 退回以后隔一阵再试（SQLite）、总时限、关闭不挂住。MySQL 的卡锁、连接数、额度见 reader.isolation.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { resolveDatabase } from "./dsn.js";
import { createReader } from "./reader.js";
import { openTestDatabase } from "./test-support/databases.js";
import { startFakePg } from "./test-support/fake-pg.js";
import { freePort } from "./test-support/server-fixture.js";

// 假 PG 答不了权限检查那条语句，这里关掉检查（检查本身在 reader.isolation.test.js 里测）
const pgReader = (fake, options) => createReader(resolveDatabase({ SQL_DSN: `postgres://u:SECRETPW@127.0.0.1:${fake.port}/db` }), { checkAccount: false, ...options });
let pgAvailable = true;
try { await import("pg"); } catch { pgAvailable = false; }

test("PostgreSQL 查询中途连接被掐断：读取服务不崩，回原因码、不带连接串里的密码，下一次读照样能再试", { skip: !pgAvailable && "没装 pg（npm ci --prefix agent）" }, async (t) => {
  const fake = await startFakePg("drop-in-select");
  t.after(() => fake.close());
  const reader = pgReader(fake, { deadlineMs: 4000 });
  t.after(() => reader.close());
  // 没有人听的 error 事件会让整个测试进程崩掉，所以能走到这里就说明有人接住了
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(reader.read(), (err) => err.code === "DB_UNREACHABLE" && !/SECRETPW/.test(JSON.stringify(err)) && !/SECRETPW/.test(err.message));
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

test("PostgreSQL：每次读连一次、读完就断；握手带上库侧时限（statement_timeout、lock_timeout、idle_in_transaction_session_timeout）", { skip: !pgAvailable && "没装 pg" }, async (t) => {
  const fake = await startFakePg("ok");
  t.after(() => fake.close());
  const reader = pgReader(fake);
  t.after(() => reader.close());
  for (let i = 1; i <= 3; i += 1) {
    assert.deepEqual(await reader.read(), []);
    assert.equal(fake.connections, i, `第 ${i} 次读连了一次`);
    for (let w = 0; w < 20 && fake.open > 0; w += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(fake.open, 0, "读完就断，没有空闲连接留着");
  }
  assert.match(fake.startups[0].options, /-c statement_timeout=500\b/);
  assert.match(fake.startups[0].options, /-c lock_timeout=\d+/);
  assert.match(fake.startups[0].options, /-c idle_in_transaction_session_timeout=5000/);
});

test("PostgreSQL 连接被掐的原因码是 DB_UNREACHABLE（不是 DB_ERROR）", { skip: !pgAvailable && "没装 pg" }, async (t) => {
  const fake = await startFakePg("drop-in-select");
  t.after(() => fake.close());
  const reader = pgReader(fake, { deadlineMs: 4000 });
  t.after(() => reader.close());
  await assert.rejects(reader.read(), { code: "DB_UNREACHABLE" });
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

test("SIGTERM：有只发了半截请求头的连接时，进程也在几秒内退出", { timeout: 30000 }, async (t) => {
  const db = await openTestDatabase("sqlite");
  t.after(() => db.close());
  await db.reset();
  await db.seed([{ id: 1, key: `sk-${"a".repeat(30)}` }]);
  const port = await freePort();
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

test("--dry-run（真进程）：读一次、打印渠道数和耗时、不起服务、退出码 0；读不到时打印原因码、退出码 1；KEY_AGENT_PAUSED 时说一句、退出码 0", { timeout: 30000 }, async (t) => {
  const db = await openTestDatabase("sqlite");
  t.after(() => db.close());
  await db.reset();
  await db.seed([{ id: 1, key: `sk-${"a".repeat(30)}KEYBODYSECRET` }, { id: 2, key: `sk-${"b".repeat(30)}` }]);
  const agent = new URL("./server.js", import.meta.url).pathname;
  const run = async (env, args = ["--dry-run"]) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", agent, ...args],
      { env: { PATH: process.env.PATH, RELAY_KEY_AGENT_SECRET: "dryRun-Kd83LmQwRtYx9zPa5vBn7cJf4hGs2", PORT: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c) => { output += c; });
    child.stderr.on("data", (c) => { output += c; });
    const [code] = await once(child, "exit");
    return { code, output };
  };
  const ok = await run(db.env);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, /数据库类型：sqlite/);
  assert.match(ok.output, /读取：成功，2 个渠道，用时 \d+ 毫秒/);
  assert.match(ok.output, /channel_info 列：有/);
  assert.doesNotMatch(ok.output, /KEYBODYSECRET|dryRun-Kd83/);
  const missing = await run({ SQLITE_PATH: `${db.path}.nope` });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /读取：失败，原因码 DB_UNREACHABLE/);
  const paused = await run({ ...db.env, KEY_AGENT_PAUSED: "1" });
  assert.equal(paused.code, 0);
  assert.match(paused.output, /KEY_AGENT_PAUSED/);
});
