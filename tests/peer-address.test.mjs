// 登录失败限流按真正连进来的地址算（lib/peer-address.js 预加载、lib/client-address.js、lib/auth.js 的失败计数表）
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { clientIp, normalizeAddress, peerHeaderName } from "../lib/client-address.js";
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_MAX_ENTRIES, LOGIN_FAILURE_TTL_MS, LOGIN_LOCK_MS, SessionManager, loginLimitSourceText } from "../lib/auth.js";

const ROOT = new URL("..", import.meta.url);
const HEADER = `x-relay-peer-${"a".repeat(32)}`;
const req = (headers) => new Request("https://local.test/api/auth/login", { method: "POST", headers });

test("Dockerfile 的 CMD 和 npm start 都预加载 lib/peer-address.js：漏了就退回全站一个计数", () => {
  const cmd = readFileSync(new URL("Dockerfile", ROOT), "utf8").split("\n").filter((line) => line.startsWith("CMD "));
  assert.equal(cmd.length, 1);
  assert.match(cmd[0], /exec node --import \.\/lib\/peer-address\.js server\.js/);
  const start = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")).scripts.start;
  assert.match(start, /NODE_OPTIONS="--import \.\/lib\/peer-address\.js" next start/);
});

test("clientIp：没开 TRUST_PROXY 按连接地址（只认预加载的随机头名）；开了取 X-Forwarded-For 的最后一个", () => {
  const env = { RELAY_PEER_HEADER: HEADER };
  assert.equal(clientIp(req({ [HEADER]: "203.0.113.7" }), env), "203.0.113.7");
  assert.equal(clientIp(req({ [HEADER]: "::FFFF:203.0.113.7" }), env), "203.0.113.7", "IPv4 连进 IPv6 监听算同一个来源");
  assert.equal(clientIp(req({ "x-forwarded-for": "198.51.100.1" }), env), "local", "没开 TRUST_PROXY 不看 X-Forwarded-For");
  assert.equal(clientIp(req({ [HEADER]: "203.0.113.7" }), {}), "local", "没预加载（环境变量里没有头名）：不读这个头，全站一个计数");
  assert.equal(clientIp(req({ "x-relay-peer-": "203.0.113.7" }), { RELAY_PEER_HEADER: "x-relay-peer-" }), "local", "头名不对也不读");
  const proxied = { ...env, TRUST_PROXY: "true" };
  assert.equal(clientIp(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.1", [HEADER]: "10.0.0.2" }), proxied), "198.51.100.1",
    "客户端自己填的在前面，取离我们最近的那层代理追加的最后一个");
  assert.equal(clientIp(req({ [HEADER]: "10.0.0.2" }), proxied), "10.0.0.2", "开了 TRUST_PROXY 但没有这个头：按连接地址");
  assert.equal(clientIp(req({}), proxied), "local");
  assert.equal(normalizeAddress(" ::1 "), "::1");
  assert.equal(peerHeaderName({ RELAY_PEER_HEADER: HEADER }), HEADER);
});

test("启动日志：说清登录限流按什么算，没预加载时警告", (t) => {
  const restore = { ...process.env };
  t.after(() => { for (const key of ["TRUST_PROXY", "RELAY_PEER_HEADER"]) { if (restore[key] == null) delete process.env[key]; else process.env[key] = restore[key]; } });
  delete process.env.TRUST_PROXY; delete process.env.RELAY_PEER_HEADER;
  assert.deepEqual(loginLimitSourceText(), { level: "warn", text: "登录限流全站共用一个计数：启动时没有预加载 lib/peer-address.js（见部署说明「登录失败限流按哪个来源算」）" });
  process.env.RELAY_PEER_HEADER = HEADER;
  assert.deepEqual(loginLimitSourceText(), { level: "log", text: "登录限流按连接地址" });
  process.env.TRUST_PROXY = "true";
  assert.deepEqual(loginLimitSourceText(), { level: "log", text: "登录限流按 X-Forwarded-For 的最后一个地址（TRUST_PROXY 已开）" });
});

test("失败计数：各来源各算各的；一天没再输错的删掉；满了先删最旧的", () => {
  const sessions = new SessionManager("/dev/null");
  const now = Date.parse("2026-10-25T08:00:00Z");
  for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) sessions.recordFailure("203.0.113.7", now);
  assert.equal(sessions.isLocked("203.0.113.7", now), true);
  assert.equal(sessions.isLocked("198.51.100.1", now), false, "别的来源不受影响");
  assert.equal(sessions.isLocked("203.0.113.7", now + LOGIN_LOCK_MS), false, "锁 5 分钟");

  sessions.recordFailure("198.51.100.1", now + 1000);
  sessions.recordFailure("192.0.2.9", now + LOGIN_FAILURE_TTL_MS + 2000);
  assert.deepEqual([...sessions.failures.keys()], ["192.0.2.9"], "一天没再输错（也没在锁着）的删掉");

  const full = new SessionManager("/dev/null");
  for (let i = 0; i <= LOGIN_FAILURE_MAX_ENTRIES; i += 1) full.recordFailure(`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`, now + i);
  assert.equal(full.failures.size, LOGIN_FAILURE_MAX_ENTRIES);
  assert.equal(full.failures.has("10.0.0.0"), false, "满了先删最旧的");
  assert.equal(full.failures.has(`10.0.${LOGIN_FAILURE_MAX_ENTRIES >> 8 & 255}.${LOGIN_FAILURE_MAX_ENTRIES & 255}`), true);
  full.recordFailure("10.0.0.1", now + LOGIN_FAILURE_MAX_ENTRIES + 1);
  assert.equal([...full.failures.keys()].at(-1), "10.0.0.1", "再输错的挪到最新，不会先被删");
});

// 起一个真的 node 进程：预加载 lib/peer-address.js，再用 Node 自己的 http 服务（Next 的 standalone 和 next start 一样走它）
function startServer(env = {}) {
  const script = `
    import http from "node:http";
    import { clientIp } from "./lib/client-address.js";
    import { SessionManager } from "./lib/auth.js";
    const sessions = new SessionManager("/dev/null");
    const server = http.createServer((req, res) => {
      const ip = clientIp({ headers: new Headers(req.headers) });
      if (req.url === "/fail") sessions.recordFailure(ip);
      res.end(JSON.stringify({ ip, locked: sessions.isLocked(ip), header: process.env.RELAY_PEER_HEADER, seen: req.headers[process.env.RELAY_PEER_HEADER] ?? null }));
    });
    server.listen(0, "::", () => console.log("PORT " + server.address().port));
  `;
  const child = spawn(process.execPath, ["--import", "./lib/peer-address.js", "--input-type=module", "-e", script],
    { cwd: ROOT, env: { ...process.env, TRUST_PROXY: "", RELAY_PEER_HEADER: "", ...env }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = out.match(/PORT (\d+)/);
      if (match) resolve({ child, port: Number(match[1]) });
    });
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
}

function get(port, host, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host, port, path, headers, family: host.includes(":") ? 6 : 4 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(JSON.parse(body)));
    });
    r.on("error", reject);
    r.end();
  });
}

test("预加载以后：连接地址写进随机名字的私有头，客户端带的同名头和 X-Forwarded-For 都冒充不了；两个来源各锁各的", async (t) => {
  const { child, port } = await startServer();
  t.after(() => child.kill());
  const first = await get(port, "127.0.0.1", "/");
  assert.match(first.header, /^x-relay-peer-[0-9a-f]{32}$/, "每个部署随机一个头名");
  assert.equal(first.ip, "127.0.0.1");
  const spoofed = await get(port, "127.0.0.1", "/", { [first.header]: "6.6.6.6", "x-forwarded-for": "7.7.7.7" });
  assert.deepEqual([spoofed.ip, spoofed.seen], ["127.0.0.1", "127.0.0.1"], "客户端知道头名也冒充不了：每个请求都覆盖写");

  for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) await get(port, "127.0.0.1", "/fail");
  assert.equal((await get(port, "127.0.0.1", "/")).locked, true, "这个来源锁了");
  const other = await get(port, "::1", "/");
  assert.deepEqual([other.ip, other.locked], ["::1", false], "另一个来源照常能登录");
});

test("预加载时环境变量里已有合法的头名（Next 的子进程）：沿用，不另起一个", async (t) => {
  const { child, port } = await startServer({ RELAY_PEER_HEADER: HEADER });
  t.after(() => child.kill());
  assert.deepEqual(await get(port, "127.0.0.1", "/"), { ip: "127.0.0.1", locked: false, header: HEADER, seen: "127.0.0.1" });
});
