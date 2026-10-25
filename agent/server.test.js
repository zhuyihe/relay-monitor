import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConfig } from "./config.js";
import { ReadFailure } from "./reader.js";
import { acceptsGzip, createAgentServer, forwardedAddress, tokenMatches } from "./server.js";

import { ROWS, SECRET, auth, baseConfig, fakeReader, token, withServer } from "./test-support/server-fixture.js";

const FOUR_MIN = 4 * 60_000;
const FIVE_MIN = 5 * 60_000;

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
    clock.t += FIVE_MIN;
    assert.equal((await get("/keys", { ...auth, "If-None-Match": etag })).status, 304, "只有读库时刻变了，ETag 不变");
    reader.state.rows = [{ ...ROWS[0], key: "sk-ZZZZxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9f0c" }];
    clock.t += FIVE_MIN;
    const changed = await get("/keys", { ...auth, "If-None-Match": etag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, etag);
  });
});

test("/keys：读库最多每 4 分钟一次（再多的请求都只读缓存），同一时刻只有一次读库在进行", async () => {
  const reader = fakeReader(ROWS);
  await withServer(reader, {}, async ({ get, clock }) => {
    await Promise.all([get("/keys", auth), get("/keys", auth), get("/keys", auth)]);
    assert.equal(reader.state.reads, 1);
    for (let i = 0; i < 20; i += 1) { clock.t += 10_000; await get("/keys", auth); }
    assert.equal(reader.state.reads, 1, "200 秒内问再多次也不读库");
    clock.t = 1_700_000_000_000 + FOUR_MIN - 1;
    await get("/keys", auth);
    assert.equal(reader.state.reads, 1);
    clock.t += 2;
    await get("/keys", auth);
    assert.equal(reader.state.reads, 2);
  });
});

test("KEY_AGENT_PAUSED：一次库都不读，/keys 回 503 PAUSED；令牌错了照样 401", async () => {
  const reader = fakeReader(ROWS);
  assert.equal(loadConfig({ RELAY_KEY_AGENT_SECRET: SECRET, KEY_AGENT_PAUSED: "1" }).paused, true);
  assert.equal(loadConfig({ RELAY_KEY_AGENT_SECRET: SECRET }).paused, false);
  await withServer(reader, { paused: true }, async ({ get, clock }) => {
    for (let i = 0; i < 3; i += 1) {
      const res = await get("/keys", auth);
      assert.equal(res.status, 503);
      assert.deepEqual(JSON.parse(res.body), { error: "unavailable", code: "PAUSED" });
      clock.t += FIVE_MIN;
    }
    assert.equal((await get("/keys", {})).status, 401);
    assert.equal(reader.state.reads, 0);
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

test("读库失败：503 带原因码，不带驱动报错原文；失败后断路停 10 分钟，再错翻倍；好了以后恢复", async () => {
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
    clock.t += 10 * 60_000 - 1;
    await get("/keys", auth);
    assert.equal(reader.state.reads, 1, "断路没到时间不读");
    reader.state.error = new Error("password=hunter2 host=10.1.2.3");
    clock.t += 2;
    const unknown = await get("/keys", auth);
    assert.deepEqual(JSON.parse(unknown.body), { error: "unavailable", code: "DB_ERROR" });
    assert.doesNotMatch(JSON.stringify(logs), /hunter2|10\.1\.2\.3/);
    reader.state.error = null;
    clock.t += 20 * 60_000 - 1;
    assert.equal((await get("/keys", auth)).status, 503, "第二次错停 20 分钟");
    clock.t += 2;
    assert.equal((await get("/keys", auth)).status, 200);
  });
});

test("读库出错、上一份成功的结果还不到 30 分钟：/keys 照样回 200 和那份结果，带 X-Agent-Stale: 1；If-None-Match 对得上回 304 也带；超过 30 分钟回 503", async () => {
  const reader = fakeReader(ROWS);
  await withServer(reader, {}, async ({ get, clock, logs }) => {
    const good = await get("/keys", auth);
    assert.equal(good.status, 200);
    assert.equal(good.headers["x-agent-stale"], undefined);
    reader.state.error = new ReadFailure("DB_TIMEOUT", "ER_QUERY_TIMEOUT");
    clock.t += FIVE_MIN;
    const stale = await get("/keys", auth);
    assert.equal(stale.status, 200);
    assert.equal(stale.headers["x-agent-stale"], "1");
    assert.equal(stale.headers["x-agent-stale-reason"], "DB_TIMEOUT", "控制台看得到这次读库为什么失败");
    assert.deepEqual(stale.body, good.body, "readAt 是原来那次读库的时刻");
    assert.equal(stale.headers.etag, good.headers.etag);
    const notModified = await get("/keys", { ...auth, "If-None-Match": good.headers.etag });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.headers["x-agent-stale"], "1");
    assert.equal(notModified.headers["x-agent-stale-reason"], "DB_TIMEOUT", "304 也带");
    assert.ok(logs.some((l) => l.ev === "req" && l.status === 200 && l.stale === true && l.reason === "DB_TIMEOUT"), "日志里这一行标 stale");
    assert.ok(logs.some((l) => l.ev === "req" && l.status === 304 && l.stale === true));
    assert.equal(logs.filter((l) => l.ev === "breaker").length, 1);
    clock.t += 30 * 60_000;
    const gone = await get("/keys", auth);
    assert.equal(gone.status, 503);
    assert.equal(JSON.parse(gone.body).code, "DB_TIMEOUT");
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

test("401 的汇总行：每个来源一行，一次最多 100 行，再多的合成一行「others」", async () => {
  await withServer(fakeReader(ROWS), { trustProxy: true }, async ({ get, logs, clock }) => {
    // 150 个来源各 12 次（每个来源记前 10 条、压下 2 条）；全局每分钟只记 100 条
    for (let source = 0; source < 150; source += 1) for (let i = 0; i < 12; i += 1) await get("/keys", { "X-Forwarded-For": `10.1.${Math.floor(source / 200)}.${source % 200}` });
    clock.t += 61000;
    await get("/keys", { Authorization: "Bearer bad" });
    const summaries = logs.filter((l) => l.ev === "unauthorized_suppressed" && l.from !== "*");
    assert.ok(summaries.length <= 101, `一次汇总最多 100 行外加 others，实际 ${summaries.length}`);
    assert.ok(summaries.some((l) => l.from === "others"));
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

test("X-Forwarded-For：开了 TRUST_PROXY 也只认合法地址，其余用连进来的地址，随便编的写不进日志和内存", async () => {
  await withServer(fakeReader(ROWS), { trustProxy: true }, async ({ get, logs }) => {
    await get("/keys", { "X-Forwarded-For": `1.1.1.1, ${"x".repeat(15000)}` });
    await get("/keys", { "X-Forwarded-For": "not-an-address" });
    await get("/keys", { "X-Forwarded-For": "2001:db8::7" });
    const from = logs.filter((l) => l.ev === "unauthorized").map((l) => l.from);
    assert.equal(from[0], "127.0.0.1");
    assert.equal(from[1], "127.0.0.1");
    assert.equal(from[2], "2001:db8::7");
  });
});

test("X-Forwarded-For 的取法：长度不超过 45、只含十六进制数字冒号点；带 zone id 的 IPv6、超长、混了别的字符都不认", () => {
  assert.equal(forwardedAddress("1.1.1.1, 203.0.113.9"), "203.0.113.9");
  assert.equal(forwardedAddress("2001:db8::7"), "2001:db8::7");
  assert.equal(forwardedAddress("::ffff:192.0.2.128"), "::ffff:192.0.2.128");
  assert.equal(forwardedAddress(`::1%${"A".repeat(15000)}`), null, "isIP 认的带 zone id 的 IPv6，超长");
  assert.equal(forwardedAddress("fe80::1%eth0"), null);
  assert.equal(forwardedAddress("1.1.1.1, ::1%A"), null);
  assert.equal(forwardedAddress("0000:0000:0000:0000:0000:ffff:255.255.255.255"), "0000:0000:0000:0000:0000:ffff:255.255.255.255");
  assert.equal(forwardedAddress("0000:0000:0000:0000:0000:ffff:255.255.255.255.1"), null);
  assert.equal(forwardedAddress(""), null);
  assert.equal(forwardedAddress(undefined), null);
});

test("X-Forwarded-For 带超长 zone id：日志里的来源仍是连进来的地址，不超过 45 个字符", async () => {
  await withServer(fakeReader(ROWS), { trustProxy: true }, async ({ get, logs }) => {
    await get("/keys", { "X-Forwarded-For": `::1%${"A".repeat(7000)}` });
    assert.equal(logs[0].from, "127.0.0.1");
    assert.ok(logs.every((l) => !l.from || l.from.length <= 45));
  });
});

test("401 日志：所有来源加起来每分钟最多 100 行，多的补一行「*」的汇总", async () => {
  await withServer(fakeReader(ROWS), { trustProxy: true }, async ({ get, logs, clock }) => {
    for (let i = 0; i < 130; i += 1) await get("/keys", { "X-Forwarded-For": `10.0.${Math.floor(i / 200)}.${i % 200}` });
    assert.equal(logs.filter((l) => l.ev === "unauthorized").length, 100);
    clock.t += 61000;
    await get("/keys", { Authorization: "Bearer bad" });
    assert.deepEqual(logs.filter((l) => l.ev === "unauthorized_suppressed" && l.from === "*").map((l) => l.count), [30]);
  });
});

test("Accept-Encoding：gzip 或 * 且质量不是 0 才压缩", () => {
  for (const yes of ["gzip", "gzip, deflate", "deflate, gzip;q=0.5", "*", "GZIP", "gzip;q=1", "*;q=0, gzip", "gzip, *;q=0"]) assert.equal(acceptsGzip(yes), true, yes);
  for (const no of ["", undefined, "deflate", "gzip;q=0", "gzip; q=0.0", "identity", "br", "gzip;q=0, *", "*, gzip;q=0", "*;q=0"]) assert.equal(acceptsGzip(no), false, String(no));
});

test("配置：太弱的 secret 起不来（不同字符少于 10 个、整串重复、全数字、全小写、全大写、连着 8 位递增），日志只写一句、不带令牌", () => {
  for (const weak of ["x".repeat(32), "12345678901234567890123456789012", "abcdefghijklmnopqrstuvwxyzabcdef", "password".repeat(5), "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGH", "Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE01234567"]) {
    assert.throws(() => loadConfig({ RELAY_KEY_AGENT_SECRET: weak }), (e) => e.code === "CONFIG_INVALID" && e.message === "令牌太弱，请用 openssl rand -base64 32 生成" && !e.message.includes(weak));
  }
  assert.equal(loadConfig({ RELAY_KEY_AGENT_SECRET: "Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE" }).port, 8790);
});

test("账号权限不合格（ACCOUNT_TOO_BROAD）：不给上一份结果，直接 503；别的失败才给 stale", async () => {
  const reader = fakeReader(ROWS);
  await withServer(reader, {}, async ({ get, clock }) => {
    assert.equal((await get("/keys", auth)).status, 200);
    reader.state.error = new ReadFailure("ACCOUNT_TOO_BROAD", "GRANT_OPTION");
    clock.t += FIVE_MIN;
    const res = await get("/keys", auth);
    assert.equal(res.status, 503, "不安全的状态下不继续给旧结果");
    assert.equal(JSON.parse(res.body).code, "ACCOUNT_TOO_BROAD");
    assert.equal(res.headers["x-agent-stale"], undefined);
  });
});
