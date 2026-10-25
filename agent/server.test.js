import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { deriveAgentKeys } from "../lib/key-fingerprint.js";
import { loadConfig } from "./config.js";
import { ReadFailure } from "./reader.js";
import { createAgentServer, tokenMatches } from "./server.js";

const SECRET = "unit-test-secret-0123456789-abcdefghijklmnop";
const { token } = deriveAgentKeys(SECRET);
const baseConfig = { secret: SECRET, trustProxy: false, tls: null };

function fakeReader(rows, { kind = "mysql" } = {}) {
  const state = { reads: 0, rows, error: null };
  return { state, kind, async read() { state.reads += 1; if (state.error) throw state.error; return state.rows; }, async close() {} };
}

async function withServer(reader, options, fn) {
  const logs = [];
  const clock = { t: 1_700_000_000_000 };
  const server = createAgentServer({ config: { ...baseConfig, ...options }, reader, now: () => clock.t, log: (entry) => logs.push(entry) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const get = (path, headers = {}, method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  try { await fn({ get, logs, clock }); } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}

const auth = { Authorization: `Bearer ${token}` };
const ROWS = [{ id: 1, name: "A", type: 1, status: 1, base_url: "https://x", key: "sk-AbC1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9f0c", channel_info: null }];

test("令牌比较：对的过，缺头、格式不对、长度不对、不对都不过", () => {
  assert.equal(tokenMatches(`Bearer ${token}`, token), true);
  for (const bad of [undefined, "", token, `Bearer ${token}x`, `Bearer ${token.slice(1)}`, `bearer ${token}`, `Bearer ${"a".repeat(token.length)}`, `Bearer  ${token}`, `Basic ${token}`])
    assert.equal(tokenMatches(bad, token), false, String(bad));
});

test("/keys：令牌错了一律 401，不说原因；不碰库", async () => {
  const reader = fakeReader(ROWS);
  await withServer(reader, {}, async ({ get }) => {
    for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: `Bearer ${token}x` }, { Authorization: token }]) {
      const res = await get("/keys", headers);
      assert.equal(res.status, 401);
      assert.deepEqual(JSON.parse(res.body), { error: "unauthorized" });
    }
    assert.equal(reader.state.reads, 0);
  });
});

test("/keys：200 带 ETag 和打码、指纹；If-None-Match 对上回 304；内容变了换 ETag", async () => {
  const reader = fakeReader(ROWS);
  await withServer(reader, {}, async ({ get, clock }) => {
    const res = await get("/keys", auth);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.v, 1);
    assert.equal(body.db, "mysql");
    assert.equal(body.readAt, clock.t);
    assert.equal(body.channels[0].keys[0].m, "AbC1…9f0c");
    assert.equal(body.channels[0].keys[0].f.length, 22);
    assert.equal(res.headers["cache-control"], "no-store");
    const etag = res.headers.etag;
    assert.match(etag, /^"[A-Za-z0-9_-]{22}"$/);
    const again = await get("/keys", { ...auth, "If-None-Match": etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal((await get("/keys", { ...auth, "If-None-Match": `W/${etag}, "other"` })).status, 304);
    clock.t += 11000;
    assert.equal((await get("/keys", { ...auth, "If-None-Match": etag })).status, 304, "只有读库时刻变了，ETag 不变");
    reader.state.rows = [{ ...ROWS[0], key: "sk-ZZZZxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9f0c" }];
    clock.t += 11000;
    const changed = await get("/keys", { ...auth, "If-None-Match": etag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, etag);
  });
});

test("/keys：读库最多 10 秒一次，同一时刻只有一次读库在进行", async () => {
  const reader = fakeReader(ROWS);
  await withServer(reader, {}, async ({ get, clock }) => {
    await Promise.all([get("/keys", auth), get("/keys", auth), get("/keys", auth)]);
    assert.equal(reader.state.reads, 1);
    clock.t += 9999;
    await get("/keys", auth);
    assert.equal(reader.state.reads, 1);
    clock.t += 2;
    await get("/keys", auth);
    assert.equal(reader.state.reads, 2);
  });
});

test("/keys：Accept-Encoding: gzip 回 gzip，内容一样", async () => {
  await withServer(fakeReader(ROWS), {}, async ({ get }) => {
    const plain = await get("/keys", auth);
    const zipped = await get("/keys", { ...auth, "Accept-Encoding": "gzip" });
    assert.equal(zipped.headers["content-encoding"], "gzip");
    assert.deepEqual(gunzipSync(zipped.body), plain.body);
  });
});

test("读库失败：503 带原因码，不带驱动报错原文；失败也缓存 10 秒；好了以后恢复", async () => {
  const reader = fakeReader(ROWS);
  reader.state.error = new ReadFailure("DB_DENIED", "ER_ACCESS_DENIED_ERROR");
  await withServer(reader, {}, async ({ get, clock, logs }) => {
    const res = await get("/keys", auth);
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body), { error: "unavailable", code: "DB_DENIED" });
    await get("/keys", auth);
    assert.equal(reader.state.reads, 1);
    assert.equal(logs.filter((l) => l.ev === "read_failed").length, 1);
    assert.deepEqual(logs.find((l) => l.ev === "read_failed"), { ev: "read_failed", code: "DB_DENIED", driver: "ER_ACCESS_DENIED_ERROR" });
    reader.state.error = new Error("password=hunter2 host=10.1.2.3");
    clock.t += 11000;
    const unknown = await get("/keys", auth);
    assert.deepEqual(JSON.parse(unknown.body), { error: "unavailable", code: "DB_ERROR" });
    assert.doesNotMatch(JSON.stringify(logs), /hunter2|10\.1\.2\.3/);
    reader.state.error = null;
    clock.t += 11000;
    assert.equal((await get("/keys", auth)).status, 200);
  });
});

test("/healthz 不要令牌、不碰库；不对的路径 404；/keys 的方法不对 405", async () => {
  const reader = fakeReader(ROWS);
  await withServer(reader, {}, async ({ get, logs }) => {
    const health = await get("/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, v: 1 });
    assert.equal((await get("/healthz", {}, "HEAD")).status, 200);
    assert.equal((await get("/other")).status, 404);
    assert.equal((await get("/keys", auth, "POST")).status, 405);
    assert.equal((await get("/keys", {}, "POST")).status, 401);
    assert.equal(reader.state.reads, 0);
    assert.equal(logs.filter((l) => l.path === "/healthz").length, 0);
  });
});

test("401 的限流只管日志：每个来源每分钟只记前 10 次，之后照样验令牌，对的照答；一分钟结束补一行「又有 N 次」", async () => {
  await withServer(fakeReader(ROWS), {}, async ({ get, clock, logs }) => {
    for (let i = 0; i < 25; i += 1) assert.equal((await get("/keys", { Authorization: "Bearer bad" })).status, 401);
    assert.equal(logs.filter((l) => l.ev === "unauthorized").length, 10);
    assert.equal(logs.filter((l) => l.ev === "unauthorized_suppressed").length, 0);
    assert.equal((await get("/keys", auth)).status, 200);
    clock.t += 60001;
    await get("/keys", { Authorization: "Bearer bad" });
    assert.deepEqual(logs.filter((l) => l.ev === "unauthorized_suppressed").map(({ count }) => count), [15]);
    assert.equal(logs.filter((l) => l.ev === "unauthorized").length, 11);
  });
});

test("401 补记：没有新请求进来时，flushLogs（定时器）也会补", async () => {
  const logs = [];
  const clock = { t: 1_700_000_000_000 };
  const server = createAgentServer({ config: baseConfig, reader: fakeReader(ROWS), now: () => clock.t, log: (entry) => logs.push(entry) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (let i = 0; i < 13; i += 1) {
      await new Promise((resolve) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/keys", agent: false }, (res) => { res.resume(); res.on("end", resolve); }));
    }
    server.flushLogs();
    assert.equal(logs.filter((l) => l.ev === "unauthorized_suppressed").length, 0, "窗口还没结束");
    clock.t += 60001;
    server.flushLogs();
    assert.deepEqual(logs.filter((l) => l.ev === "unauthorized_suppressed").map(({ count }) => count), [3]);
    server.flushLogs();
    assert.equal(logs.filter((l) => l.ev === "unauthorized_suppressed").length, 1, "补过的不再补");
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
});

test("401 的来源：开了 KEY_AGENT_TRUST_PROXY 取 X-Forwarded-For 最后一个", async () => {
  await withServer(fakeReader(ROWS), { trustProxy: true }, async ({ get, logs }) => {
    await get("/keys", { "X-Forwarded-For": "1.1.1.1, 203.0.113.9" });
    assert.equal(logs[0].from, "203.0.113.9");
  });
});

test("日志里没有令牌、secret、Key", async () => {
  await withServer(fakeReader(ROWS), {}, async ({ get, logs }) => {
    await get("/keys", auth);
    await get("/keys", { Authorization: `Bearer ${token}x` });
    const text = JSON.stringify(logs);
    for (const secret of [token, SECRET, "AbC1xxxx", "9f0c"]) assert.ok(!text.includes(secret));
  });
});

test("配置：secret 太短、没设、TLS 只设一个、端口不对都起不来，报错不带 secret 和连接串", () => {
  const ok = { RELAY_KEY_AGENT_SECRET: SECRET };
  assert.equal(loadConfig(ok).port, 8790);
  assert.equal(loadConfig(ok).database.kind, "sqlite");
  assert.throws(() => loadConfig({}), { code: "CONFIG_INVALID" });
  assert.throws(() => loadConfig({ RELAY_KEY_AGENT_SECRET: "short-secret-value" }), (e) => e.code === "CONFIG_INVALID" && /令牌太短/.test(e.message) && !e.message.includes("short-secret-value"));
  assert.throws(() => loadConfig({ ...ok, TLS_CERT_FILE: "/x" }), { code: "CONFIG_INVALID" });
  assert.throws(() => loadConfig({ ...ok, TLS_CERT_FILE: "/nope", TLS_KEY_FILE: "/nope" }), { code: "CONFIG_INVALID" });
  assert.throws(() => loadConfig({ ...ok, PORT: "99999" }), { code: "CONFIG_INVALID" });
  assert.throws(() => loadConfig({ ...ok, SQL_DSN: "u:hunter2@bad" }), (e) => e.code === "CONFIG_INVALID" && !e.message.includes("hunter2"));
});

test("开 TLS：配了证书和私钥就走 HTTPS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "key-agent-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    const config = loadConfig({ RELAY_KEY_AGENT_SECRET: SECRET, TLS_CERT_FILE: join(dir, "cert.pem"), TLS_KEY_FILE: join(dir, "key.pem") });
    assert.ok(config.tls);
    const server = createAgentServer({ config, reader: fakeReader(ROWS), log: () => {} });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const status = await new Promise((resolve, reject) => {
        https.get({ host: "127.0.0.1", port: server.address().port, path: "/healthz", rejectUnauthorized: false, agent: false }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
      });
      assert.equal(status, 200);
    } finally {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
