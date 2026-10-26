// 读取服务读真库：SQLite 一直测；MySQL、PostgreSQL 设了环境变量才测（见 test-support/databases.js）。
// 读库用照部署说明建的专用账号（只有 channels 现有列的 SELECT、连接数上限 1），管理员账号读取服务不读
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { once } from "node:events";
import http from "node:http";
import { deriveAgentKeys, normalizeKey } from "../lib/key-fingerprint.js";
import { resolveDatabase } from "./dsn.js";
import { createReader } from "./reader.js";
import { buildSnapshot } from "./snapshot.js";
import { AVAILABLE_KINDS, TEST_KINDS, openTestDatabase } from "./test-support/databases.js";
import { freePort } from "./test-support/server-fixture.js";

const SECRET = "contract-Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE";
const derived = deriveAgentKeys(SECRET);
const AGENT = new URL("./server.js", import.meta.url).pathname;

const snapshotOf = (rows, db) => JSON.parse(buildSnapshot(rows, { db, fingerprintKeyBytes: derived.fingerprintKey, now: 1 }).body);
const readerFor = (env, options) => createReader(resolveDatabase({ ...env }), options);

function httpGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

async function startAgent(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", AGENT], {
    env: { PATH: process.env.PATH, RELAY_KEY_AGENT_SECRET: SECRET, PORT: String(port), HOST: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (c) => { output += c; });
  child.stderr.on("data", (c) => { output += c; });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await httpGet(port, "/healthz")).status === 200) break; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { port, output: () => output, async stop() { child.kill("SIGTERM"); await once(child, "exit"); } };
}

const fixtureRows = () => [
  { id: 1, type: 1, key: "sk-AbC1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9f0c", base_url: "https://up.example.com", channel_info: { is_multi_key: false } },
  { id: 2, type: 1, key: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", channel_info: { is_multi_key: true, multi_key_size: 2, multi_key_status_list: { 1: 2 } } },
  { id: 3, type: 1, key: '["sk-cccccccccccccccccccccccccccccc","sk-dddddddddddddddddddddddddddddd"]', channel_info: { is_multi_key: true } },
  { id: 4, type: 41, key: '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----secret"}', channel_info: null },
  { id: 5, type: 1, key: "sk-eeeeeeeeeeeeeeeeeeeeeeeeeeeeee", channel_info: null },
  { id: 6, type: 1, key: "", status: 2 },
  { id: 7, type: 1, key: "AKIAEXAMPLE|secretsecretsecret", channel_info: null },
];

for (const kind of TEST_KINDS) {
  const available = AVAILABLE_KINDS.includes(kind);
  test(`读取服务读真库 ${kind}`, { skip: !available && `没设 ${kind} 的测试库环境变量` }, async (t) => {
    const db = await openTestDatabase(kind);
    t.after(() => db.close());

    await t.test("读出单 Key、多 Key（换行、JSON 数组）、keyless、空 Key；响应里只有打码和指纹", async (st) => {
      await db.reset();
      await db.seed(fixtureRows());
      const reader = readerFor(await db.agentEnv());
      st.after(() => reader.close());
      const snapshot = snapshotOf(await reader.read(), kind);
      assert.equal(snapshot.db, kind);
      assert.deepEqual(snapshot.channels.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7]);
      const [one, newline, array, vertex, nullInfo, empty, pipe] = snapshot.channels;
      assert.equal(one.baseUrl, "https://up.example.com");
      assert.deepEqual(one.keys.map((k) => k.m), ["AbC1…9f0c"]);
      assert.equal(one.keys[0].f.length, 22);
      assert.deepEqual(newline.keys.map((k) => [k.i, k.m]), [[0, "aaaa…aaaa"], [1, "bbbb…bbbb"]]);
      assert.deepEqual(array.keys.map((k) => [k.i, k.m]), [[0, "cccc…cccc"], [1, "dddd…dddd"]]);
      assert.deepEqual(vertex, { id: 4, name: "channel-4", type: 41, status: 1, baseUrl: "", keyless: true });
      assert.equal(nullInfo.keys.length, 1);
      assert.deepEqual(empty.keys, []);
      assert.equal(empty.status, 2);
      assert.equal(pipe.keyless, true);
      assert.ok(!("keys" in pipe));
      assert.doesNotMatch(JSON.stringify(snapshot), /secretsecret|BEGIN PRIVATE|xxxxxxxx|eeeeeeeeeeee/);
    });

    await t.test(kind === "mysql" ? "老版本没有 channel_info 列：MySQL 的列级授权下库回 1143（不管列存不存在），分不清是缺列还是没授权，一律 DB_DENIED，不退回" : "老版本没有 channel_info 列：照样读，全当单 Key", async (st) => {
      await db.reset({ withChannelInfo: false });
      await db.seed([{ id: 1, key: "sk-AbC1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9f0c" }, { id: 2, key: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }]);
      const reader = readerFor(await db.agentEnv());
      st.after(() => reader.close());
      if (kind === "mysql") {
        await assert.rejects(reader.read(), { code: "DB_DENIED", driver: "ER_COLUMNACCESS_DENIED_ERROR" });
        return;
      }
      const snapshot = snapshotOf(await reader.read(), kind);
      assert.equal(snapshot.channels.length, 2);
      assert.equal(snapshot.channels[1].keys.length, 1);
      assert.equal((await reader.read()).length, 2);
    });

    await t.test("表不存在 → TABLE_MISSING", async (st) => {
      await db.reset();
      const env = await db.agentEnv();
      await db.dropTable();
      const reader = readerFor(env);
      st.after(() => reader.close());
      await assert.rejects(reader.read(), { code: "TABLE_MISSING" });
    });

    await t.test("1000 个渠道一次读完", async (st) => {
      await db.reset();
      await db.seed(Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, key: `sk-${randomBytes(24).toString("base64url")}` })));
      const reader = readerFor(await db.agentEnv());
      st.after(() => reader.close());
      assert.equal((await reader.read()).length, 1000);
    });

    if (kind === "sqlite") {
      await t.test("库文件不存在 → DB_UNREACHABLE，而且不会把它建出来", async (st) => {
        const missing = `${db.path}.nope`;
        const reader = readerFor({ SQLITE_PATH: missing });
        st.after(() => reader.close());
        await assert.rejects(reader.read(), { code: "DB_UNREACHABLE" });
        assert.equal(existsSync(missing), false);
      });
      await t.test("WAL 模式下另一个连接在写时，也读得到新写的", async (st) => {
        await db.reset();
        await db.seed([{ id: 1, key: "sk-first-first-first-first" }]);
        const reader = readerFor(await db.agentEnv());
        st.after(() => reader.close());
        assert.equal((await reader.read()).length, 1);
        await db.seed([{ id: 2, key: "sk-second-second-second" }]);
        assert.equal((await reader.read()).length, 2);
      });
      await t.test("WAL 模式的库没有 -wal（New API 干净关闭了）：不读，也不会把空的 -wal / -shm 建出来；不是 WAL 模式的库没有 -wal 照样读", async (st) => {
        await db.reset();
        await db.seed([{ id: 1, key: "sk-first-first-first-first" }]);
        db.stopNewApi();
        assert.equal(existsSync(`${db.path}-wal`), false, "前提：最后一个连接关了以后 -wal 没了");
        const reader = readerFor(db.env);
        st.after(() => reader.close());
        await assert.rejects(reader.read(), { code: "DB_UNREACHABLE", driver: "SQLITE_NO_WAL" });
        assert.equal(existsSync(`${db.path}-wal`), false);
        assert.equal(existsSync(`${db.path}-shm`), false);
        // 同一个库换成默认的日志模式（不是 WAL）：没有 -wal 是正常的，照样读
        const plain = new DatabaseSync(db.path);
        plain.exec("PRAGMA journal_mode=DELETE");
        plain.close();
        assert.equal((await reader.read()).length, 1);
        assert.equal(existsSync(`${db.path}-wal`), false);
        await db.reset();
      });
    } else {
      await t.test("读一次连一次、读完就断：每次读完库里这个账号一个连接都没有", async (st) => {
        await db.reset();
        await db.seed(fixtureRows().slice(0, 1));
        const account = await db.agentAccount();
        const reader = readerFor(account.env);
        st.after(() => reader.close());
        for (let i = 0; i < 3; i += 1) {
          assert.equal((await reader.read()).length, 1);
          assert.equal(await db.connectionsOf(account.name), 0, `第 ${i + 1} 次读完还有连接`);
        }
      });
    }

    if (kind === "mysql") {
      await t.test("密码不对 → DB_DENIED；端口不通 → DB_UNREACHABLE", async (st) => {
        const user = db.adminDsn.split(":")[0];
        const denied = readerFor({ SQL_DSN: db.goDsn(user, `wrong-${randomUUID()}`) });
        st.after(() => denied.close());
        await assert.rejects(denied.read(), { code: "DB_DENIED" });
        const down = readerFor({ SQL_DSN: db.goDsn(user, "x", 1) });
        st.after(() => down.close());
        await assert.rejects(down.read(), { code: "DB_UNREACHABLE" });
      });

      await t.test("专用账号（7 列列级 SELECT）能读；表有 channel_info 却没给它授权是 DB_DENIED（不退回、不悄悄当单 Key）；少给 key 也是 DB_DENIED", async (st) => {
        await db.reset();
        await db.seed(fixtureRows().slice(0, 2));
        const full = await db.agentAccount();
        const reader = readerFor(full.env);
        st.after(() => reader.close());
        assert.equal((await reader.read()).length, 2);
        const noInfo = await db.agentAccount({ columns: ["id", "type", "key", "status", "name", "base_url"] });
        const narrow = readerFor(noInfo.env);
        st.after(() => narrow.close());
        await assert.rejects(narrow.read(), { code: "DB_DENIED" });
        const noKey = await db.agentAccount({ columns: ["id", "type", "status", "name", "base_url", "channel_info"] });
        const missingKey = readerFor(noKey.env);
        st.after(() => missingKey.close());
        await assert.rejects(missingKey.read(), { code: "DB_DENIED" });
      });
    }

    if (kind === "postgres") {
      await t.test("端口不通 → DB_UNREACHABLE；密码不对 → DB_DENIED", async (st) => {
        const url = new URL(db.url);
        const down = new URL(db.url);
        down.port = "1";
        const downReader = readerFor({ SQL_DSN: down.toString() });
        st.after(() => downReader.close());
        await assert.rejects(downReader.read(), { code: "DB_UNREACHABLE" });
        url.password = `wrong-${randomUUID()}`;
        const denied = readerFor({ SQL_DSN: url.toString() });
        st.after(() => denied.close());
        await assert.rejects(denied.read(), { code: "DB_DENIED" });
      });
    }

    await t.test("泄漏：随机 1000 把 Key 灌进库，响应、日志、报错里不能出现任何一把 Key 的中间段，也不能出现 secret、令牌、连接串", async (st) => {
      await db.reset();
      const keys = [];
      const rows = [];
      for (let i = 1; i <= 1000; i += 1) {
        const body = randomBytes(30 + (i % 50)).toString("base64url");
        const raw = i % 3 === 0 ? `sk-${body}` : i % 7 === 0 ? `  ${body}\n` : body;
        keys.push(raw);
        rows.push({ id: i, type: 1, key: raw, base_url: `https://u${i}.example.com`, channel_info: { is_multi_key: false } });
      }
      for (let i = 0; i < 50; i += 1) {
        const group = Array.from({ length: 3 }, () => randomBytes(40).toString("base64url"));
        keys.push(...group);
        rows.push({ id: 2000 + i, type: 1, key: group.join("\n"), channel_info: { is_multi_key: true } });
      }
      await db.seed(rows);
      const agentEnv = await db.agentEnv();
      const agent = await startAgent(agentEnv);
      try {
        const plain = await httpGet(agent.port, "/keys", { Authorization: `Bearer ${derived.token}` });
        const zipped = await httpGet(agent.port, "/keys", { Authorization: `Bearer ${derived.token}`, "Accept-Encoding": "gzip" });
        const notModified = await httpGet(agent.port, "/keys", { Authorization: `Bearer ${derived.token}`, "If-None-Match": plain.headers.etag });
        await httpGet(agent.port, "/keys", { Authorization: "Bearer wrong-token" });
        await httpGet(agent.port, "/nope");
        assert.equal(plain.status, 200);
        assert.equal(notModified.status, 304);
        const bodies = [plain.body.toString("utf8"), gunzipSync(zipped.body).toString("utf8")];
        const parsed = JSON.parse(bodies[0]);
        assert.equal(parsed.channels.length, 1050);
        assert.equal(parsed.channels.reduce((n, c) => n + c.keys.length, 0), 1000 + 150);
        const fixedText = [...bodies, agent.output()].join("\n");
        for (const raw of keys) {
          const key = normalizeKey(raw);
          assert.ok(key.length >= 16);
          assert.ok(!fixedText.includes(key.slice(4, -4)), "出现了一把 Key 的中间段");
          assert.ok(!fixedText.includes(key));
        }
        const secrets = [SECRET, derived.token, derived.fingerprintKey.toString("hex"), derived.fingerprintKey.toString("base64url"), derived.fingerprintKey.toString("base64"),
          ...Object.values(agentEnv).map(String), ...Object.values(db.env).map(String), ...(db.password ? [db.password] : [])];
        for (const secret of secrets) assert.ok(!agent.output().includes(secret), "日志里出现了不该出现的东西");
        assert.ok(!bodies.join("").includes("Bearer"));
      } finally {
        await agent.stop();
      }
    });
  });
}

