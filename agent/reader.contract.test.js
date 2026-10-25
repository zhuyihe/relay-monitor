// 读取服务读真库：SQLite 一直测；MySQL、PostgreSQL 设了环境变量才测（见 test-support/databases.js）
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { once } from "node:events";
import http from "node:http";
import { deriveAgentKeys, normalizeKey } from "../lib/key-fingerprint.js";
import { resolveDatabase } from "./dsn.js";
import { createReader } from "./reader.js";
import { buildSnapshot } from "./snapshot.js";
import { AVAILABLE_KINDS, TEST_KINDS, openTestDatabase } from "./test-support/databases.js";

const SECRET = `contract-secret-${"x".repeat(32)}`;
const derived = deriveAgentKeys(SECRET);
const AGENT = new URL("./server.js", import.meta.url).pathname;

const snapshotOf = (rows, db) => JSON.parse(buildSnapshot(rows, { db, fingerprintKeyBytes: derived.fingerprintKey, now: 1 }).body);
const readerFor = (env) => createReader(resolveDatabase({ ...env }));

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
  const port = 20000 + Math.floor(Math.random() * 20000);
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
  { id: 2, type: 1, key: "sk-aaaaaaaaaaaaaaaaaaaa\nsk-bbbbbbbbbbbbbbbbbbbb\n", channel_info: { is_multi_key: true, multi_key_size: 2, multi_key_status_list: { 1: 2 } } },
  { id: 3, type: 1, key: '["sk-cccccccccccccccccccc","sk-dddddddddddddddddddd"]', channel_info: { is_multi_key: true } },
  { id: 4, type: 41, key: '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----secret"}', channel_info: null },
  { id: 5, type: 1, key: "sk-eeeeeeeeeeeeeeeeeeee", channel_info: null },
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
      const reader = readerFor(db.env);
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

    await t.test("老版本没有 channel_info 列：照样读，全当单 Key", async (st) => {
      await db.reset({ withChannelInfo: false });
      await db.seed([{ id: 1, key: "sk-AbC1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9f0c" }, { id: 2, key: "sk-aaaaaaaaaaaaaaaaaaaa\nsk-bbbbbbbbbbbbbbbbbbbb" }]);
      const reader = readerFor(db.env);
      st.after(() => reader.close());
      const snapshot = snapshotOf(await reader.read(), kind);
      assert.equal(snapshot.channels.length, 2);
      assert.equal(snapshot.channels[1].keys.length, 1);
      assert.equal((await reader.read()).length, 2);
    });

    await t.test("表不存在 → TABLE_MISSING", async (st) => {
      await db.dropTable();
      const reader = readerFor(db.env);
      st.after(() => reader.close());
      await assert.rejects(reader.read(), { code: "TABLE_MISSING" });
    });

    await t.test("1000 个渠道一次读完", async (st) => {
      await db.reset();
      await db.seed(Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, key: `sk-${randomBytes(24).toString("base64url")}` })));
      const reader = readerFor(db.env);
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
        const reader = readerFor(db.env);
        st.after(() => reader.close());
        assert.equal((await reader.read()).length, 1);
        await db.seed([{ id: 2, key: "sk-second-second-second" }]);
        assert.equal((await reader.read()).length, 2);
      });
    } else {
      await t.test("会话是只读的，连接池只有一个连接", async (st) => {
        await db.reset();
        await db.seed(fixtureRows().slice(0, 1));
        const reader = readerFor(db.env);
        st.after(() => reader.close());
        await reader.read();
        assert.equal(await reader.inspectReadOnly(), true);
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

      await t.test("只读账号：只给 7 列的列级授权能读；少给 channel_info 就是 DB_DENIED", async (st) => {
        const name = `ka_${randomBytes(4).toString("hex")}`;
        const password = randomBytes(12).toString("hex");
        try {
          await db.admin.query(`CREATE USER '${name}'@'%' IDENTIFIED BY '${password}'`);
        } catch {
          st.diagnostic("建不了账号，跳过列级授权的用例");
          return;
        }
        st.after(() => db.admin.query(`DROP USER IF EXISTS '${name}'@'%'`));
        await db.reset();
        await db.seed(fixtureRows().slice(0, 2));
        await db.admin.query(`GRANT SELECT (id, name, type, status, base_url, \`key\`, channel_info) ON \`${db.database}\`.channels TO '${name}'@'%'`);
        const reader = readerFor({ KEY_AGENT_DSN: db.goDsn(name, password) });
        st.after(() => reader.close());
        assert.equal((await reader.read()).length, 2);
        assert.equal(await reader.inspectReadOnly(), true);
        await db.admin.query(`REVOKE SELECT (channel_info) ON \`${db.database}\`.channels FROM '${name}'@'%'`);
        const narrow = readerFor({ KEY_AGENT_DSN: db.goDsn(name, password) });
        st.after(() => narrow.close());
        await assert.rejects(narrow.read(), { code: "DB_DENIED" });
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
      const agent = await startAgent(db.env);
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
          ...Object.values(db.env).map(String), ...(db.password ? [db.password] : [])];
        for (const secret of secrets) assert.ok(!agent.output().includes(secret), "日志里出现了不该出现的东西");
        assert.ok(!bodies.join("").includes("Bearer"));
      } finally {
        await agent.stop();
      }
    });
  });
}

