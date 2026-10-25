// 渠道 Key 读取服务：放在自营 New API 旁边，读 channels 表，只对外给打码和 HMAC 指纹，绝不返回完整 Key。
// GET /keys（要令牌）、GET /healthz（不碰库）。日志只打状态码、渠道数、原因码，不打 Key、令牌、连接串
import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveAgentKeys } from "../lib/key-fingerprint.js";
import { loadConfig } from "./config.js";
import { runDryRun } from "./dry-run.js";
import { createReader } from "./reader.js";
import { PROTOCOL_VERSION, createSnapshotSource } from "./snapshot.js";

const UNAUTHORIZED_LOG_LIMIT = 10;
const UNAUTHORIZED_WINDOW_MS = 60000;
const MAX_TRACKED_SOURCES = 10000;
// 所有来源加起来每分钟最多记这么多行令牌不对的日志：来源可以编（开了 KEY_AGENT_TRUST_PROXY 又没有可信代理时）
const UNAUTHORIZED_GLOBAL_LOG_LIMIT = 100;
const SUMMARY_LINE_LIMIT = 100;
const FLUSH_MIN_INTERVAL_MS = 1000;
const FAILURE_LOG_REPEAT_MS = 10 * 60000;

const defaultLog = (entry) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);

export function tokenMatches(header, expectedToken) {
  const match = /^Bearer (\S+)$/.exec(String(header ?? ""));
  const want = Buffer.from(expectedToken, "utf8");
  const got = Buffer.from(match?.[1] ?? "", "utf8");
  // 长度不对也拿等长的假串比一遍，不提早返回
  const same = got.length === want.length;
  return timingSafeEqual(same ? got : Buffer.alloc(want.length), want) && same && !!match;
}

// Accept-Encoding 里有 gzip（或 *）且质量不是 0；写明了 gzip 的以它为准（gzip;q=0, * 是不要 gzip）
export function acceptsGzip(header) {
  const quality = {};
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name !== "gzip" && name !== "*") continue;
    const q = params.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    quality[name] = q === undefined ? 1 : Number(q);
  }
  return (quality.gzip ?? quality["*"] ?? 0) > 0;
}

// 日志里的「来源」：X-Forwarded-For 末段是代理加的，但开了 TRUST_PROXY 而代理没清外面传进来的头时它可以是任何东西：
// 只认长度不超过 45、只含十六进制数字、冒号、点的合法 IP（带 zone id 的 IPv6 不认），否则用连进来的地址
const MAX_ADDRESS_LENGTH = 45;
export function forwardedAddress(header) {
  const last = String(header ?? "").split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last && last.length <= MAX_ADDRESS_LENGTH && /^[0-9A-Fa-f:.]+$/.test(last) && isIP(last) ? last : null;
}

function etagMatches(header, etag) {
  return String(header ?? "").split(",").some((part) => part.trim().replace(/^W\//, "") === etag);
}

export function createAgentServer({ config, reader, now = Date.now, log = defaultLog }) {
  const { token, fingerprintKey } = deriveAgentKeys(config.secret);
  const source = createSnapshotSource({ reader, db: reader.kind, fingerprintKeyBytes: fingerprintKey, now, paused: !!config.paused,
    onBreaker: (info) => log({ ev: "breaker", ...info }) });
  const failedBySource = new Map();
  let lastFailureLog = { code: null, at: 0 };

  // 401 的限流只管日志：藏在反向代理后面时「来源」就是代理本身，停答会让路人把控制台一起挡在外面。令牌是 256 位，猜不出（secret 太弱起不来）。
  // 每个来源每分钟只记前 10 条，所有来源加起来每分钟最多 100 条，这一分钟结束时补一行「又有 N 次」，免得刷屏把重要的日志挤掉
  const globalWindow = { start: 0, count: 0 };
  let lastFlushAt = 0;
  function flushSuppressed(t, force = false) {
    if (!force && t - lastFlushAt < FLUSH_MIN_INTERVAL_MS) return;
    lastFlushAt = t;
    // 每个来源一行「又有 N 次」，一次最多 100 行，再多的合成一行
    let lines = 0, rest = 0;
    for (const [from, entry] of failedBySource) {
      if (!force && t - entry.start < UNAUTHORIZED_WINDOW_MS) continue;
      if (entry.count > UNAUTHORIZED_LOG_LIMIT) {
        if (lines < SUMMARY_LINE_LIMIT) { log({ ev: "unauthorized_suppressed", from, count: entry.count - UNAUTHORIZED_LOG_LIMIT }); lines += 1; }
        else rest += entry.count - UNAUTHORIZED_LOG_LIMIT;
      }
      failedBySource.delete(from);
    }
    if (rest) log({ ev: "unauthorized_suppressed", from: "others", count: rest });
    if (globalWindow.count > UNAUTHORIZED_GLOBAL_LOG_LIMIT && (force || t - globalWindow.start >= UNAUTHORIZED_WINDOW_MS)) {
      log({ ev: "unauthorized_suppressed", from: "*", count: globalWindow.count - UNAUTHORIZED_GLOBAL_LOG_LIMIT });
    }
    if (force || t - globalWindow.start >= UNAUTHORIZED_WINDOW_MS) Object.assign(globalWindow, { start: t, count: 0 });
  }

  function noteUnauthorized(req) {
    const forwarded = config.trustProxy ? forwardedAddress(req.headers["x-forwarded-for"]) : null;
    const from = forwarded ?? String(req.socket.remoteAddress ?? "unknown").slice(0, MAX_ADDRESS_LENGTH + 20);
    const t = now();
    flushSuppressed(t);
    if (!globalWindow.start) globalWindow.start = t;
    globalWindow.count += 1;
    let entry = failedBySource.get(from);
    if (!entry) {
      entry = { start: t, count: 0 };
      if (failedBySource.size >= MAX_TRACKED_SOURCES) failedBySource.delete(failedBySource.keys().next().value);
      failedBySource.set(from, entry);
    }
    entry.count += 1;
    if (entry.count <= UNAUTHORIZED_LOG_LIMIT && globalWindow.count <= UNAUTHORIZED_GLOBAL_LOG_LIMIT) log({ ev: "unauthorized", from });
  }

  function send(req, res, status, body, headers = {}) {
    res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers, ...(body ? { "Content-Length": body.length } : {}) });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  const sendJson = (req, res, status, object) => send(req, res, status, Buffer.from(JSON.stringify(object)), { "Content-Type": "application/json; charset=utf-8" });

  async function handle(req, res) {
    const started = now();
    const path = (req.url ?? "").split("?")[0];
    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(req, res, 405, { error: "method_not_allowed" });
      return sendJson(req, res, 200, { ok: true, v: PROTOCOL_VERSION });
    }
    if (path !== "/keys") return sendJson(req, res, 404, { error: "not_found" });
    if (!tokenMatches(req.headers.authorization, token)) {
      noteUnauthorized(req);
      return sendJson(req, res, 401, { error: "unauthorized" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(req, res, 405, { error: "method_not_allowed" });
    const snapshot = await source.get();
    if (!snapshot.ok) {
      if (lastFailureLog.code !== snapshot.code || now() - lastFailureLog.at >= FAILURE_LOG_REPEAT_MS) {
        lastFailureLog = { code: snapshot.code, at: now() };
        log({ ev: "read_failed", code: snapshot.code, driver: snapshot.driver });
      }
      log({ ev: "req", path, status: 503, code: snapshot.code, ms: now() - started });
      return send(req, res, 503, snapshot.body, { "Content-Type": "application/json; charset=utf-8" });
    }
    lastFailureLog = { code: null, at: 0 };
    const headers = { ETag: snapshot.etag, Vary: "Accept-Encoding" };
    if (etagMatches(req.headers["if-none-match"], snapshot.etag)) {
      log({ ev: "req", path, status: 304, channels: snapshot.channelCount, ms: now() - started });
      return send(req, res, 304, null, headers);
    }
    const gzip = acceptsGzip(req.headers["accept-encoding"]);
    log({ ev: "req", path, status: 200, channels: snapshot.channelCount, ms: now() - started });
    return send(req, res, 200, gzip ? snapshot.gzip : snapshot.body,
      { ...headers, "Content-Type": "application/json; charset=utf-8", ...(gzip ? { "Content-Encoding": "gzip" } : {}) });
  }

  const onRequest = (req, res) => {
    handle(req, res).catch(() => {
      // 兜底：任何没想到的错都只回 500，不把报错原文往外送
      log({ ev: "error", code: "INTERNAL" });
      if (!res.headersSent) sendJson(req, res, 500, { error: "internal" });
      else res.destroy();
    });
  };
  const server = config.tls ? https.createServer(config.tls, onRequest) : http.createServer(onRequest);
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  // 只发半截请求头的连接 10 秒时限、每 5 秒查一次（默认 30 秒查一次），实际最多约 15 秒被收掉，连接数上限放宽些；直接对外时还是建议放在反向代理后面（部署说明）
  server.connectionsCheckingInterval = 5000;
  server.maxConnections = 256;
  // 没有新请求进来时，上一分钟被压下的条数也要补记
  const sweeper = setInterval(() => flushSuppressed(now()), UNAUTHORIZED_WINDOW_MS);
  sweeper.unref();
  server.on("close", () => { clearInterval(sweeper); flushSuppressed(now(), true); });
  server.flushLogs = () => flushSuppressed(now());
  return server;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`[致命] 读取服务起不来：${err.message}\n`);
    process.exit(1);
  }
  const reader = createReader(config.database, { onEvent: defaultLog });
  if (process.argv.includes("--dry-run")) process.exit(await runDryRun({ reader, paused: config.paused }));
  const server = createAgentServer({ config, reader });
  // 端口被占用这类起不来的事：说一句、退出，不带别的
  server.on("error", (err) => { process.stderr.write(`[致命] 读取服务起不来：端口 ${config.port} 打不开（${/^[A-Z0-9_]{1,30}$/.test(String(err?.code)) ? err.code : "UNKNOWN"}）\n`); process.exit(1); });
  server.listen(config.port, config.host, () => defaultLog({ ev: "start", db: reader.kind, port: config.port, tls: !!config.tls, paused: !!config.paused }));
  // 停的时候：先不再收新连接、收掉空闲的；还有半截请求的连接最多再等 3 秒就强行关掉，整个最多 10 秒，不让它拖着进程不退出
  const stop = () => {
    server.close(() => reader.close().finally(() => process.exit(0)));
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 3000).unref();
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// 直接运行才起服务（测试里 import 它时不起）。argv[1] 可能是软链接路径，两边都取真实路径再比
const isMain = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) main();
