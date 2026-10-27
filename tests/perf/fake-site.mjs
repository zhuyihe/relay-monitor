// 假站点：一个进程模拟 50 个上游（New API / Sub2API / 只用 Key；PERF_BINDINGS 缩小时只有接入的那几个）和 1 个自营 New API 站点。
// 用法：node fake-site.mjs   （FAKE_PORT 默认 18950，FAKE_DELAY_MS 默认 50）
// 地址：上游 http://127.0.0.1:18950/na01 … /s245 … /nk49；自营 http://127.0.0.1:18951/own（FAKE_OWN_PORT，默认 FAKE_PORT + 1；两个端口同一套路由）
// 控制：GET /__stats[?reset=1] 看/清请求计数；POST /__ctl?delay=50&ratio=old|current&freeze=1|0 改延迟、分组倍率口径、停住「现在」；GET /__health
// 所有数字来自 lib/model.mjs 的确定性模型：分页、按渠道/按天/按 Key 的统计互相对得上。
// 渠道 Key 读取服务（K2a/K2b 量夹具，PERF_KEY_AGENT=on 才接）：GET /key-agent/keys（Bearer、ETag/304、X-Agent-Stale），
// 每 PERF_KEY_AGENT_ROTATE_SEC 秒（默认 600）随机换 2~3 个渠道现在用的 Key（走 New API 整号账号的那些）；/__ctl?key_agent_down=1|0 模拟读取服务读库失败（照真协议
// 沿用上一份成功结果、带 X-Agent-Stale），key_agent_rotate=1 立刻触发一次换 Key（不用等 10 分钟，本机调脚本用），
// key_agent_rotate_pause=1|0 暂停/恢复定时换 Key（默认停着，只在稳态窗口里开；暂停时把换过的渠道都换回绑定的那把 Key）。
// 读取服务走单独的 https 端口 https://127.0.0.1:18952/key-agent（FAKE_KEY_AGENT_PORT，默认 FAKE_PORT + 2；证书见 lib/model.mjs 的 KEY_AGENT_TLS）。
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  loadConfig, makeAggregates, makeBalanceModel, channelQuota, tokenCostQuota, accountCostQuota,
  UPSTREAMS, OWN, CHANNELS, USERS, MODELS, OWN_GROUPS, RULES, QPU, N_CH, N_USERS, HOUR, TZ,
  dayStartSec, dateKeyOf, PORT, OWN_PORT, KEY_AGENT_PORT, KEY_AGENT_TLS, upstreamGroupRatio, tokenKeySecret, channelDefaultToken, channelDefaultSecret, channelUpstream,
} from "./lib/model.mjs";
import { maskKey, fingerprintKey, deriveAgentKeys, KEY_AGENT_SECRET } from "./lib/key-agent-protocol.mjs";

const config = loadConfig();
const epoch0 = config.epoch0Sec;
const agg = makeAggregates(epoch0);
const t0 = Date.now();
agg.ensureHours(Math.floor((Date.now() / 1000 - epoch0) / HOUR));
const balances = makeBalanceModel(agg, config);
console.log(`[fake] 预聚合 ${agg.nh} 小时，用了 ${Date.now() - t0} ms`);

let delayMs = Number(process.env.FAKE_DELAY_MS ?? 50);
let ratioMode = process.env.FAKE_RATIO_MODE || "current";
const stats = { total: 0, bytes: 0, byRoute: Object.create(null), bySite: Object.create(null), startedAt: new Date().toISOString() };
let requestLog = []; // [到达时刻 ms, 路由]，/__stats?detail=1 返回，最多 20 万条；自营 /api/log/ 多一项类别（all / latest / filtered，见下）
// 自营 /api/log/ 分三类计数（整站读场景用）：filtered = 带 username/token_name/channel/model_name/group 任何一个（channel=0 算没筛）；
// 不带筛选的里，page_size=1 的是「上次以后有没有新消费」那一下（latest），别的是整站读（all）
let ownLogKinds = { all: 0, latest: 0, filtered: 0 };
const OWN_LOG_FILTERS = ["username", "token_name", "channel", "model_name", "group"];

const upByPath = new Map(UPSTREAMS.map((up) => [up.path, up]));
// freeze：POST /__ctl?freeze=1 以后「现在」停在那一秒，之后不再有新消费、余额不再变（测 P1a 那种「没有新消费就沿用」的轮次）；freeze=0 恢复
let frozenSec = null;
// 积压场景用：这些站点（"/na01" 这种路径前缀）一律回 503，像上游挂了；/__ctl?down=/na01,/na02 设、down= 清空
let downSites = new Set();
const nowSec = () => frozenSec ?? Math.floor(Date.now() / 1000);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ---- 渠道 Key 读取服务（K2a/K2b 量夹具用；PERF_KEY_AGENT=on 才接，照真协议：指纹、打码、304、X-Agent-Stale）----
// 只装在自营站点这一侧，和真实部署「装在自营 New API 旁边」一个道理，地址指到这个假站点自己的 /key-agent。
const KEY_AGENT_ON = /^(1|on|true)$/i.test(String(process.env.PERF_KEY_AGENT ?? ""));
const keyAgentAuth = KEY_AGENT_ON ? deriveAgentKeys(KEY_AGENT_SECRET) : null;
// 渠道 → 现在用哪个 token id（只记换过的；查不到用 model.mjs 的默认绑定）。只在走 New API 整号账号的渠道里换：
// 走只用 Key 的上游、Sub2API 的渠道这一版 K2a 本来就认不出（候选只收 type=newapi），换了也看不出区别，不浪费一次随机
const keyAgentOverride = new Map();
let keyAgentRotations = 0; // /__stats 报的「换了几次」，量的时候确认真的在换
let keyAgentDown = false; // POST /__ctl?key_agent_down=1｜0：模拟读取服务那一侧读库失败，照真协议沿用上一份成功结果、带 X-Agent-Stale
let keyAgentLastGood = null; // { body, etag }
// 定时换 Key 只在稳态窗口里开（measure/background.mjs 窗口开头 pause=0、结尾 pause=1），平时和对拍时都停着：
// 按墙钟一直换的话，base、head 的稳态窗口里各换几次全看运气（实测一边 3 次、一边 0 次，同一份代码 SQL/分钟差 48%），量出来不可比。
// 每次恢复都从头计时、用同一个种子挑渠道和 Key，base、head 的窗口里换的次数、换的渠道都一样
let keyAgentRotatePaused = true; // POST /__ctl?key_agent_rotate_pause=1｜0；暂停时把换过的渠道都换回绑定的那把 Key
let keyAgentStatus = Object.create(null); // GET /key-agent/keys 按状态码计数（200、304……），/__stats 报
const ROTATABLE = KEY_AGENT_ON ? CHANNELS.filter((ch) => channelUpstream(ch.id).kind === "newapi" && channelDefaultToken(ch.id)).map((ch) => ch.id) : [];
// 换 Key 用的随机数：固定种子（mulberry32），每次恢复定时换 Key 时重置，base、head 换的是同一批渠道、同一批 Key
let rotateSeed = 0;
function rotateRandom() {
  rotateSeed = (rotateSeed + 0x6D2B79F5) | 0;
  let t = rotateSeed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rotateKeyAgentChannels() {
  const n = 2 + Math.floor(rotateRandom() * 2); // 2 或 3 个
  for (let i = 0; i < n && ROTATABLE.length; i++) {
    const c = ROTATABLE[Math.floor(rotateRandom() * ROTATABLE.length)];
    const up = channelUpstream(c);
    const token = up.tokens[Math.floor(rotateRandom() * up.tokens.length)];
    keyAgentOverride.set(c, token.id);
    keyAgentRotations += 1;
  }
}
// 换 Key 的间隔：默认 600 秒（真实读取服务的节奏）；CI 的稳态窗口只有 185 秒，量「换了 Key 以后重新认、写段」那一段要调小（比如 60）
const KEY_AGENT_ROTATE_SEC = Math.max(1, Math.floor(num(process.env.PERF_KEY_AGENT_ROTATE_SEC || undefined, 600)));
let rotateTimer = null;
function setKeyAgentRotatePaused(paused) {
  keyAgentRotatePaused = paused;
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  if (paused) { keyAgentOverride.clear(); return; }
  rotateSeed = 20261027; // 每个窗口从同一个种子、同一个相位开始
  if (KEY_AGENT_ON) rotateTimer = setInterval(rotateKeyAgentChannels, KEY_AGENT_ROTATE_SEC * 1000);
  rotateTimer?.unref?.();
}

function keyAgentChannelKeys(c) {
  const up = channelUpstream(c), overrideId = keyAgentOverride.get(c);
  const tokenId = overrideId ?? channelDefaultToken(c)?.id ?? null;
  const secret = tokenId != null ? tokenKeySecret(up, tokenId) : channelDefaultSecret(c);
  return [{ i: 0, m: maskKey(secret), f: fingerprintKey(secret, keyAgentAuth.fingerprintKey) }];
}
function keyAgentBuild() {
  const channels = CHANNELS.map((ch) => ({ id: ch.id, name: ch.name, type: ch.type, status: ch.status, baseUrl: ch.baseUrl, keys: keyAgentChannelKeys(ch.id) }));
  const body = { v: 1, db: "mysql", readAt: Date.now(), channels };
  const etag = `"${createHash("sha256").update(JSON.stringify(channels)).digest("hex").slice(0, 16)}"`;
  return { body, etag };
}
function keyAgentSite(req) {
  if (!KEY_AGENT_ON) return [404, { message: "unknown site" }]; // PERF_KEY_AGENT 没开：和原来一样，这条路不存在
  if (req.headers.authorization !== `Bearer ${keyAgentAuth.token}`) return [401, { error: "unauthorized" }];
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/key-agent/healthz") return [200, { ok: true }];
  if (url.pathname !== "/key-agent/keys") return [404, { error: "not found" }];
  if (keyAgentDown && keyAgentLastGood) {
    return [200, keyAgentLastGood.body, { ETag: keyAgentLastGood.etag, "X-Agent-Stale": "1", "X-Agent-Stale-Reason": "DB_ERROR" }];
  }
  const { body, etag } = keyAgentBuild();
  keyAgentLastGood = { body, etag };
  if (req.headers["if-none-match"] === etag) return [304, {}, { ETag: etag }];
  return [200, body, { ETag: etag }];
}

// 上游分组倍率：部分 (上游, 分组) 在 ratioChangeAt 换过倍率；ratio=old 时返回旧倍率（种子脚本建绑定时用）
const upGroupRatio = (up, group) => upstreamGroupRatio(config, up, group, ratioMode);

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  stats.bytes += text.length;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(text);
}
const ok = (data, extra = {}) => ({ success: true, message: "", data, ...extra });
const s2 = (data) => ({ code: 0, message: "success", data });

// ---- 通用：窗口参数（New API 秒级、含两端） ----
function secWindow(q) {
  // 和 New API 一样：end_timestamp 没传或是 0 就不限终点（Number(null) 是 0，不能直接用 num 的默认值）
  const s = num(q.get("start_timestamp"), 0), e = num(q.get("end_timestamp"), 0) || nowSec();
  return [s, Math.min(e, nowSec())];
}
function pageOf(q) {
  const p = Math.max(1, num(q.get("p"), 1) || 1);
  const size = Math.min(100, Math.max(1, num(q.get("page_size"), 10) || 10));
  return { p, size };
}

// ---- 余额 ----
function upstreamBalance(up) {
  const st = balances.state(up, nowSec());
  return st;
}

// ---- New API 上游 ----
function newApiUpstream(up, rest, q, req) {
  // /api/status 是公开接口（应用读 quota_per_unit 时不带令牌）
  if (rest === "/api/status") return [200, ok({ version: "v0.9.6-perf", quota_per_unit: QPU, system_name: up.name })];
  if (!req.headers.authorization) return [401, { success: false, message: "未授权" }];
  switch (rest) {
    case "/api/user/self": {
      const b = upstreamBalance(up);
      return [200, ok({ id: up.accountId, username: `acct${up.i}`, display_name: up.name, quota: Math.round(b.remaining),
        used_quota: Math.round(b.used), request_count: Math.round(b.used / 15000), group: "default" })];
    }
    case "/api/pricing": {
      // 价目表（应付成本 V1-a 审核用）：照 New API 的形状，data 是每个模型一项（按量 quota_type 0，倍率 model_ratio/completion_ratio/cache_ratio），
      // group_ratio 是这个账号可用分组的倍率。不要求登录（真站点只挂「模型广场」开关）
      const data = MODELS.map((model, index) => ({ model_name: model, quota_type: 0, model_ratio: 0.5 + (index % 4), completion_ratio: 1 + (index % 5),
        cache_ratio: 0.1, create_cache_ratio: 1.25, enable_groups: ["all"] }));
      const groupRatio = {};
      for (const g of ["default", "vip", "claude", "gpt", "gemini", "svip", "auto"]) groupRatio[g] = upGroupRatio(up, g);
      return [200, { success: true, data, group_ratio: groupRatio, vendors: [], usable_group: groupRatio }];
    }
    case "/api/user/self/groups": {
      const groups = {};
      for (const g of ["default", "vip", "claude", "gpt", "gemini", "svip", "auto"]) groups[g] = { ratio: upGroupRatio(up, g), desc: `${g} 分组` };
      return [200, ok(groups)];
    }
    case "/api/token/": {
      const { p, size } = pageOf(q);
      // 单数号上游给打码（New API v0.11.4 起）、双数号给完整 Key（旧版）：读取服务那一侧两条认法都要量到（K2a 的指纹/打码两条路）
      const items = up.tokens.slice((p - 1) * size, p * size).map((t) => { const secret = tokenKeySecret(up, t.id);
        return { id: t.id, user_id: up.accountId, name: t.name, status: 1, group: t.group,
          cross_group_retry: false, key: up.i % 2 ? maskKey(secret) : secret, used_quota: 0, remain_quota: 0, unlimited_quota: true }; });
      return [200, ok({ page: p, page_size: size, total: up.tokens.length, items })];
    }
    case "/api/log/self/stat": {
      const [s, e] = secWindow(q);
      const name = q.get("token_name") || "";
      const token = up.tokens.find((t) => t.name === name);
      const quota = token ? tokenCostQuota(agg, up, token, s, e) : 0;
      return [200, ok({ quota, rpm: 0, tpm: 0 })];
    }
    case "/api/data/self": {
      const [s, e] = secWindow(q);
      return [200, ok(accountHourlyRows(up, s, e))];
    }
    default: return [404, { success: false, message: "not found" }];
  }
}

// 上游账号按小时、按模型的用量行（/api/data/self 形状）：账号花费按 50/30/20 拆给 3 个模型
function accountHourlyRows(up, s, e) {
  const rows = [];
  const models = [MODELS[up.i % 12], MODELS[(up.i + 3) % 12], MODELS[(up.i + 7) % 12]], shares = [0.5, 0.3, 0.2];
  const h0 = Math.max(0, agg.hourOf(s)), h1 = agg.hourOf(e);
  for (let H = h0; H <= h1; H++) {
    const hs = epoch0 + H * HOUR;
    if (hs < s || hs > e) continue;
    const quota = accountCostQuota(agg, up, hs, Math.min(hs + HOUR - 1, nowSec()));
    if (quota <= 0) continue;
    models.forEach((model, i) => {
      const qq = Math.round(quota * shares[i]);
      rows.push({ model_name: model, created_at: hs, token_used: Math.round(qq * 0.45), quota: qq, count: Math.max(1, Math.round(qq / 15000)) });
    });
  }
  return rows;
}

// ---- 只用 Key 的上游（OpenAI 兼容计费接口） ----
function keyUpstream(up, rest, req) {
  if (!req.headers.authorization) return [401, { error: { message: "missing key" } }];
  const b = upstreamBalance(up);
  if (rest === "/dashboard/billing/subscription") return [200, { object: "billing_subscription", hard_limit_usd: Math.round(b.granted / QPU * 100) / 100, access_until: 0 }];
  if (rest === "/dashboard/billing/usage") return [200, { object: "list", total_usage: Math.round(b.used / QPU * 100) }];
  return [404, { error: { message: "not found" } }];
}

// ---- Sub2API 上游 ----
function sub2Upstream(up, rest, q, req) {
  if (rest === "/api/v1/settings/public") return [200, s2({ turnstile_enabled: false })];
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return [401, { code: "UNAUTHORIZED", message: "missing token" }];
  const tz = q.get("timezone") || TZ;
  const dayWindow = () => {
    const s = dayStartSec(q.get("start_date"), tz);
    const endDay = new Date(Date.parse(q.get("end_date") + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
    const e = Math.min(dayStartSec(endDay, tz) - 1, nowSec());
    return [s, e];
  };
  if (rest === "/api/v1/auth/me") {
    const b = upstreamBalance(up);
    return [200, s2({ id: up.accountId, username: `s2user${up.i}`, email: `s2user${up.i}@example.com`, balance: Math.round(b.remaining / QPU * 100) / 100,
      total_recharged: Math.round(b.granted / QPU * 100) / 100, frozen_balance: 0 })];
  }
  if (rest === "/api/v1/usage/dashboard/stats") {
    const s = dayStartSec(dateKeyOf(nowSec(), TZ), TZ);
    const cost = accountCostQuota(agg, up, s, nowSec()) / QPU;
    return [200, s2({ today_actual_cost: Math.round(cost * 10000) / 10000, today_cost: Math.round(cost * 1.1 * 10000) / 10000,
      today_requests: Math.round(cost * 50), today_tokens: Math.round(cost * 300000), total_actual_cost: Math.round(upstreamBalance(up).used / QPU * 100) / 100 })];
  }
  if (rest === "/api/v1/usage/dashboard/snapshot-v2") {
    const [s, e] = dayWindow();
    const hourly = q.get("granularity") === "hour";
    const trend = [];
    let total = 0;
    for (let a = s; a <= e;) {
      const label = hourly ? new Date((a + 8 * 3600) * 1000).toISOString().slice(0, 13).replace("T", " ") + ":00" : dateKeyOf(a, tz);
      const b = hourly ? Math.min(a + HOUR - 1, e) : Math.min(dayStartSec(new Date(Date.parse(label + "T00:00:00Z") + 86400000).toISOString().slice(0, 10), tz) - 1, e);
      const cost = accountCostQuota(agg, up, a, b) / QPU;
      total += cost;
      trend.push({ date: label, total_tokens: Math.round(cost * 300000), actual_cost: Math.round(cost * 10000) / 10000, cost: Math.round(cost * 1.1 * 10000) / 10000, requests: Math.round(cost * 50) });
      a = b + 1;
    }
    const models = [0.55, 0.3, 0.15].map((share, i) => ({ model: MODELS[(up.i + i * 4) % 12], total_tokens: Math.round(total * share * 300000),
      actual_cost: Math.round(total * share * 10000) / 10000, cost: Math.round(total * share * 1.1 * 10000) / 10000, requests: Math.round(total * share * 50),
      input_tokens: Math.round(total * share * 250000), output_tokens: Math.round(total * share * 50000) }));
    return [200, s2({ trend, models })];
  }
  if (rest === "/api/v1/keys") {
    const page = Math.max(1, num(q.get("page"), 1)), size = Math.min(100, Math.max(1, num(q.get("page_size"), 20)));
    const items = up.tokens.slice((page - 1) * size, page * size).map((t) => ({ id: t.id, user_id: up.accountId, name: t.name, status: "active", group_id: t.groupId, key: "sk-****" }));
    return [200, s2({ items, total: up.tokens.length, page, page_size: size })];
  }
  const keyMatch = rest.match(/^\/api\/v1\/keys\/(\d+)$/);
  if (keyMatch) {
    const t = up.tokens.find((x) => x.id === Number(keyMatch[1]));
    return t ? [200, s2({ id: t.id, user_id: up.accountId, name: t.name, status: "active", group_id: t.groupId })] : [404, { code: 404, message: "key not found" }];
  }
  if (rest === "/api/v1/usage/stats") {
    const id = Number(q.get("api_key_id"));
    const t = up.tokens.find((x) => x.id === id);
    const [s, e] = dayWindow();
    const cost = t && e >= s ? tokenCostQuota(agg, up, t, s, e) / QPU : 0;
    return [200, s2({ total_actual_cost: Math.round(cost * 1e6) / 1e6, total_cost: Math.round(cost * 1.1 * 1e6) / 1e6, total_requests: Math.round(cost * 50), total_tokens: Math.round(cost * 300000) })];
  }
  return [404, { code: 404, message: "not found" }];
}

// ---- 自营站点（New API 管理员） ----
const LOG_FIELDS_OTHER = (ev) => JSON.stringify({ model_ratio: 1, group_ratio: 1, completion_ratio: 4, cache_tokens: ev.cacheRead, cache_ratio: 0.1,
  ...(ev.m <= 2 ? { usage_semantic: "anthropic", claude: true } : {}) });
// 渠道测试日志（R1 审核用，默认关；FAKE_TEST_LOGS=1 打开）：照 New API 的写法——type 2，token_name 和 content 都是
// 「模型测试」，token_id 0、user_id 1。按「开了定时自动测试、每 10 分钟测一遍全部 300 个渠道」的量：第 n 轮第 c 个渠道在 epoch0 + n*600 + c 秒，
// 一天 4.32 万条。只在自营站点的 /api/log/、/api/log/stat 里出现；不带筛选、只按渠道筛时算进去，按「模型测试」筛时只出它们
const TEST_LOGS = process.env.FAKE_TEST_LOGS === "1";
const TEST_NAME = "模型测试", TEST_PERIOD = 600, TEST_ID_BASE = 2_000_000_000;
const testQuota = (c) => 2000 + (c % 7) * 500;
// [s, e] 里的测试日志，时刻从新到旧；channel 不为 0 时只要这个渠道
function* testEvents(s, e, channel = 0) {
  if (!TEST_LOGS) return;
  const lo = Math.max(s, epoch0), hi = Math.min(e, nowSec());
  if (hi < lo) return;
  for (let n = Math.floor((hi - epoch0) / TEST_PERIOD); n >= 0 && epoch0 + n * TEST_PERIOD + N_CH >= lo; n--) {
    for (let c = channel || N_CH; c >= (channel || 1); c--) {
      const t = epoch0 + n * TEST_PERIOD + c;
      if (t >= lo && t <= hi) yield { n, c, t };
    }
  }
}
// 用户列表里的角色可以覆盖（R1 审核用）：FAKE_USER_ROLES="1:1,450:100" 把 root 列成普通用户、user450 列成超级管理员，
// 用来量「管理员很少自己用」的站（夹具默认 root、admin2、ops3 是管理员；按用量 root 排第 135、admin2 第 108、ops3 第 81，
// admin2、ops3 唯一的 Key 都标了转售）。只改 /api/user/ 列表里的 role
const ROLE_OVERRIDES = new Map((process.env.FAKE_USER_ROLES || "").split(",").filter(Boolean).map((x) => x.split(":").map(Number)));
const roleOf = (u) => ROLE_OVERRIDES.get(u.id) ?? u.role;
const testLogItem = ({ n, c, t }) => ({ id: TEST_ID_BASE + n * N_CH + c, user_id: 1, created_at: t, type: 2, content: TEST_NAME, username: "root",
  token_name: TEST_NAME, token_id: 0, model_name: MODELS[c % MODELS.length], quota: testQuota(c), prompt_tokens: 10, completion_tokens: 1,
  use_time: 1, is_stream: false, channel: c, channel_name: CHANNELS[c - 1].name, group: OWN_GROUPS[0], ip: "", other: "" });
// 带筛选的查询里测试日志算不算在内：测试日志记在 root（user_id 1）名下、token_name「模型测试」，没有别的模型、分组筛选时，
// 按 username=root 查（可以再加 channel、token_name=模型测试）也要查得到它们，和真 New API 一样
const testInFilter = (q) => TEST_LOGS && q.get("username") === "root" && !q.get("model_name") && !q.get("group")
  && (!q.get("token_name") || q.get("token_name") === TEST_NAME);
// 按 username 筛时，从新到旧逐条给出这个用户的事件；整小时里这个用户一条都没有的（按小时预聚合看）整段跳过，
// 不然 7 天约 70 万条、30 天约 300 万条每个请求都要逐条解一遍，假站点自己就慢到让应用超时（真站点有索引）
function* userEventsDesc(kFirst, kLast, filter, userIdx) {
  if (kLast < kFirst) return;
  agg.ensureHours(Math.floor((nowSec() - epoch0) / HOUR));
  const userA = agg.userA(), ev = {};
  for (let H = agg.hourOf(agg.em.tOf(kLast)); H >= agg.hourOf(agg.em.tOf(kFirst)); H--) {
    if (userIdx >= 0 && H < agg.nh && userA[(H * N_USERS + userIdx) * 3] === 0) continue;
    const hk0 = Math.max(agg.em.kAt(epoch0 + H * HOUR), kFirst), hk1 = Math.min(agg.em.kAt(epoch0 + (H + 1) * HOUR) - 1, kLast);
    for (let k = hk1; k >= hk0; k--) { agg.em.decode(k, ev); if (filter(ev)) yield ev; }
  }
}
const userIdxOf = (q) => { const name = q.get("username"); return name ? USERS.findIndex((u) => u.username === name) : -1; };
const testQuotaIn = (s, e, channel = 0) => { let q = 0; for (const ev of testEvents(s, e, channel)) q += testQuota(ev.c); return q; };

function logItem(ev) {
  const user = USERS[ev.u], token = user.tokens[ev.tok], ch = CHANNELS[ev.c - 1];
  return { id: ev.k + 1, user_id: user.id, created_at: ev.t, type: 2, content: "", username: user.username, token_name: token.name,
    token_id: token.id, model_name: MODELS[ev.m], quota: ev.quota, prompt_tokens: ev.prompt, completion_tokens: ev.completion,
    use_time: 1 + (ev.k % 30), is_stream: ev.k % 3 !== 0, channel: ev.c, channel_name: ch.name, group: OWN_GROUPS[ev.g], ip: "", other: LOG_FIELDS_OTHER(ev) };
}
function eventFilter(q) {
  const model = q.get("model_name"), username = q.get("username"), group = q.get("group"), tokenName = q.get("token_name");
  const channel = num(q.get("channel"), 0);
  const userIdx = username ? USERS.findIndex((u) => u.username === username) : -1;
  if (!model && !username && !group && !tokenName && !channel) return null;
  const mi = model ? MODELS.indexOf(model) : -1, gi = group ? OWN_GROUPS.indexOf(group) : -1;
  return (ev) => (!model || ev.m === mi) && (!username || ev.u === userIdx) && (!group || ev.g === gi)
    && (!channel || ev.c === channel) && (!tokenName || USERS[ev.u].tokens[ev.tok].name === tokenName);
}
// 自营站点的全站限流（R1 审核用，默认关；FAKE_OWN_RATE_LIMIT=1 打开）：照 New API 默认 GLOBAL_API_RATE_LIMIT，
// 同一个来源 180 秒内最多 360 个请求（滑动窗口），超了回 429，带 Retry-After（秒）。被拒的请求数在 /__stats 的 ownRateLimited 里
const OWN_RATE_LIMIT = process.env.FAKE_OWN_RATE_LIMIT === "1";
const ownHits = [];
let ownRateLimited = 0;
function ownRateLimit() {
  if (!OWN_RATE_LIMIT) return null;
  const now = Date.now();
  while (ownHits.length && now - ownHits[0] >= 180000) ownHits.shift();
  if (ownHits.length >= 360) { ownRateLimited += 1; return Math.ceil((180000 - (now - ownHits[0])) / 1000); }
  ownHits.push(now);
  return null;
}

// 站点设置里的大 JSON：按「几百个模型 × 每项约 40 字节」造倍率表，补全倍率表、分组倍率表同理；小项几十个。大小由条数定，不依赖具体版本
const CONSUME_LOG_OFF = process.env.FAKE_CONSUME_LOG_OFF === "1";
const bigTable = (prefix, n, value) => JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}-model-${String(i).padStart(4, "0")}-preview`, value(i)])));
let optionCache = null;
function OPTION_ITEMS() {
  if (!optionCache) optionCache = [
    { key: "ModelRatio", value: bigTable("m", 420, (i) => 0.5 + (i % 40) / 8) },
    { key: "CompletionRatio", value: bigTable("c", 380, (i) => 1 + (i % 6)) },
    { key: "CacheRatio", value: bigTable("k", 260, () => 0.1) },
    { key: "ModelPrice", value: bigTable("p", 120, (i) => (i % 9) / 100) },
    { key: "GroupRatio", value: JSON.stringify(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`group-${i}`, 1 + (i % 5) / 10]))) },
    ...Array.from({ length: 60 }, (_, i) => ({ key: `Setting${i}`, value: i % 3 ? "true" : "some-value-" + i })),
  ];
  return [...optionCache, { key: "LogConsumeEnabled", value: CONSUME_LOG_OFF ? "false" : "true" }];
}
function ownSite(rest, q, req) {
  const retryAfter = ownRateLimit();
  if (retryAfter != null) return [429, { success: false, message: "请求过于频繁" }, { "Retry-After": String(retryAfter) }];
  if (rest === "/api/status") return [200, ok({ version: "v0.9.6-perf", quota_per_unit: QPU, system_name: "自营站点" })];
  if (!req.headers.authorization) return [401, { success: false, message: "无权进行此操作，未登录且未提供 access token" }];
  switch (rest) {
    case "/api/option/": {
      // 站点设置（R2 审核用）：data 是 [{ key, value }]，LogConsumeEnabled 的值是 "true" / "false"。真站点把全部设置一起返回，其中几项是大 JSON
      // （模型倍率表、补全倍率表、分组倍率表等，每项几 KB 到十几 KB）；这里照这个形状造，整个响应落在 20–60 KB 之间，
      // 量「每个自营站点每 5 分钟多读一次」的字节数才像真的。只认超级管理员（这个假站点的登录就是 root）
      return [200, ok(OPTION_ITEMS())];
    }
    case "/api/user/self": return [200, ok({ id: 1, username: "root", display_name: "Root", role: 100, quota: 99000000000, used_quota: 1200000000, request_count: 123456 })];
    case "/api/channel/": {
      const { p, size } = pageOf(q);
      const items = CHANNELS.slice((p - 1) * size, p * size).map((c) => ({ id: c.id, name: c.name, type: c.type, status: c.status, base_url: c.baseUrl,
        group: c.group, models: "", priority: 0, weight: 0, balance: 0, used_quota: 0, created_time: epoch0 }));
      return [200, ok({ page: p, page_size: size, total: CHANNELS.length, items })];
    }
    case "/api/user/": {
      const { p, size } = pageOf(q);
      const items = USERS.slice((p - 1) * size, p * size).map((u) => ({ id: u.id, username: u.username, display_name: "", role: roleOf(u), status: u.status,
        quota: u.quota, used_quota: u.quota * 3, request_count: 1000, group: OWN_GROUPS[u.groups[0]] }));
      return [200, ok({ page: p, page_size: size, total: USERS.length, items })];
    }
    case "/api/token/": {
      const target = USERS.find((u) => String(u.id) === String(req.headers["new-api-user"])) || USERS[0];
      const { p, size } = pageOf(q);
      const items = target.tokens.slice((p - 1) * size, p * size).map((t) => ({ id: t.id, name: t.name, status: 1, group: t.group,
        used_quota: 5000000, remain_quota: 1000000, unlimited_quota: false, key: "sk-****" }));
      return [200, ok({ page: p, page_size: size, total: target.tokens.length, items })];
    }
    case "/api/log/stat": {
      const [s, e] = secWindow(q);
      const filter = eventFilter(q);
      let quota = 0;
      const channel = num(q.get("channel"), 0);
      const onlyChannel = channel && !q.get("model_name") && !q.get("username") && !q.get("group") && !q.get("token_name");
      const tokenName = q.get("token_name");
      // 测试日志全记在 root 名下（testLogItem 的 username）：带 username 的只有 root 有，别的用户是 0。真 New API 的 stat 两个条件一起筛；
      // 原来这里不看 username，每个管理员都回全部测试额度，「各管理员合计 = 全部」永远对不上（审核 R1 CI）
      if (TEST_LOGS && tokenName === TEST_NAME) return [200, ok({ quota: q.get("username") && q.get("username") !== "root" ? 0 : testQuotaIn(s, e, channel), rpm: 0, tpm: 0 })];
      if (onlyChannel) quota = channelQuota(agg, [channel], s, e)[channel] + testQuotaIn(s, e, channel);
      else if (!filter) { const all = channelQuota(agg, CHANNELS.map((c) => c.id), s, e); for (let c = 1; c <= N_CH; c++) quota += all[c]; quota += testQuotaIn(s, e); }
      else {
        const ui = userIdxOf(q), userOnly = ui >= 0 && !channel && !q.get("model_name") && !q.get("group") && !tokenName;
        // 只按 username 筛：整小时走按用户的预聚合，零头逐条
        agg.scan(s, e, userOnly ? (H) => { quota += agg.userA()[(H * N_USERS + ui) * 3 + 1]; } : null, (ev) => { if (filter(ev)) quota += ev.quota; });
        if (testInFilter(q)) quota += testQuotaIn(s, e, channel);
      }
      return [200, ok({ quota, rpm: 0, tpm: 0 })];
    }
    case "/api/log/": {
      const [s, e] = secWindow(q);
      const { p, size } = pageOf(q);
      const filter = eventFilter(q);
      const kFirst = agg.em.kAt(Math.max(s, epoch0)), kLast = agg.em.kAt(e + 1) - 1;
      let items = [], total = 0;
      if (TEST_LOGS && q.get("token_name") === TEST_NAME) {
        // 只要测试日志：从新到旧分页；测试日志全记在 root 名下，按别的用户筛是空的
        const from = (p - 1) * size;
        if (q.get("username") && q.get("username") !== "root") return [200, ok({ page: p, page_size: size, total: 0, items: [] })];
        for (const ev of testEvents(s, e, num(q.get("channel"), 0))) { if (total >= from && total < from + size) items.push(testLogItem(ev)); total++; }
      } else if (!filter) {
        total = Math.max(0, kLast - kFirst + 1);
        const ev = {};
        for (let i = (p - 1) * size; i < p * size && kLast - i >= kFirst; i++) items.push(logItem(agg.em.decode(kLast - i, ev)));
        if (TEST_LOGS) {
          // 不带筛选时测试日志也在里面：条数加上；第一页按时刻（同一秒按编号）从新到旧合进去。第二页以后只给普通日志（近似，应用只读第一页）
          let tests = 0; const head = [];
          for (const ev of testEvents(s, e)) { if (head.length < size) head.push(testLogItem(ev)); tests++; }
          total += tests;
          if (p === 1) items = [...items, ...head].sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, size);
        }
      } else if (testInFilter(q)) {
        // root 名下：普通日志和测试日志按时刻（同一秒按编号）从新到旧合起来分页
        const from = (p - 1) * size;
        const regular = (function* () { for (const ev of userEventsDesc(kFirst, kLast, filter, userIdxOf(q))) yield logItem(ev); })();
        const tests = (function* () { for (const ev of testEvents(s, e, num(q.get("channel"), 0))) yield testLogItem(ev); })();
        let a = regular.next(), b = tests.next();
        while (!a.done || !b.done) {
          const takeA = b.done || (!a.done && (a.value.created_at > b.value.created_at || (a.value.created_at === b.value.created_at && a.value.id > b.value.id)));
          const item = takeA ? a.value : b.value;
          if (takeA) a = regular.next(); else b = tests.next();
          if (total >= from && total < from + size) items.push(item);
          total++;
        }
      } else {
        const from = (p - 1) * size;
        for (const ev of userEventsDesc(kFirst, kLast, filter, userIdxOf(q))) {
          if (total >= from && total < from + size) items.push(logItem(ev));
          total++;
        }
      }
      return [200, ok({ page: p, page_size: size, total, items })];
    }
    case "/api/data/": case "/api/data/users": {
      const [s, e] = secWindow(q);
      const users = rest === "/api/data/users";
      const rows = [];
      const nowH = Math.floor((nowSec() - epoch0) / HOUR);
      const h0 = Math.max(0, Math.ceil((s - epoch0) / HOUR)), h1 = Math.floor((e - epoch0) / HOUR);
      for (let H = h0; H <= h1; H++) {
        const hs = epoch0 + H * HOUR;
        const dims = users ? N_USERS : 12;
        let vals;
        if (H < nowH) { agg.ensureHours(H + 1); const arr = users ? agg.userA() : agg.modelA(); vals = (d) => [arr[(H * dims + d) * 3], arr[(H * dims + d) * 3 + 1], arr[(H * dims + d) * 3 + 2]]; }
        else {
          const acc = new Float64Array(dims * 3);
          agg.scan(hs, Math.min(hs + HOUR - 1, nowSec()), null, (ev) => { const d = users ? ev.u : ev.m; acc[d * 3] += 1; acc[d * 3 + 1] += ev.quota; acc[d * 3 + 2] += ev.prompt + ev.completion; });
          vals = (d) => [acc[d * 3], acc[d * 3 + 1], acc[d * 3 + 2]];
        }
        for (let d = 0; d < dims; d++) {
          const [count, quota, tokens] = vals(d);
          if (!count) continue;
          rows.push({ ...(users ? { username: USERS[d].username, user_id: USERS[d].id } : { model_name: MODELS[d] }), created_at: hs, token_used: tokens, count, quota });
        }
      }
      return [200, ok(rows)];
    }
    case "/api/data/flow": {
      const [s, e] = secWindow(q);
      if (!s || e < s) return [200, { success: false, message: "invalid start_timestamp" }];
      return [200, ok(flowRows(s, e))];
    }
    case "/api/data/self": return [200, ok([])];
    default: return [404, { success: false, message: "not found" }];
  }
}

// 流向（用户, 分组, 模型, 渠道）：整天缓存，零头逐条
const flowDayCache = new Map();
function flowKey(ev) { return ((ev.u * 2 + ev.tok) * 12 + ev.m) * (N_CH + 1) + ev.c; }
function addFlow(map, ev) {
  const key = flowKey(ev);
  let v = map.get(key);
  if (!v) { v = [0, 0, 0, ev.g]; map.set(key, v); }
  v[0] += 1; v[1] += ev.quota; v[2] += ev.prompt + ev.completion;
}
function flowDay(d) {
  let m = flowDayCache.get(d);
  if (m) return m;
  m = new Map();
  const ds = epoch0 + d * 86400;
  agg.scan(ds, ds + 86399, null, (ev) => addFlow(m, ev));
  flowDayCache.set(d, m);
  return m;
}
function flowRows(s, e) {
  const total = new Map();
  const merge = (m) => { for (const [k, v] of m) { const t = total.get(k); if (t) { t[0] += v[0]; t[1] += v[1]; t[2] += v[2]; } else total.set(k, [...v]); } };
  const nowD = Math.floor((nowSec() - epoch0) / 86400);
  let a = Math.max(s, epoch0);
  while (a <= e) {
    const d = Math.floor((a - epoch0) / 86400), ds = epoch0 + d * 86400, de = ds + 86399;
    if (a === ds && de <= e && d < nowD) { merge(flowDay(d)); a = de + 1; continue; }
    const b = Math.min(de, e), part = new Map();
    agg.scan(a, b, null, (ev) => addFlow(part, ev));
    merge(part);
    a = b + 1;
  }
  const rows = [];
  for (const [key, v] of total) {
    const c = key % (N_CH + 1), rest = Math.floor(key / (N_CH + 1)), m = rest % 12, ut = Math.floor(rest / 12), u = Math.floor(ut / 2), tok = ut % 2;
    const user = USERS[u];
    rows.push({ username: user.username, use_group: OWN_GROUPS[v[3]], model_name: MODELS[m], channel_id: c, channel_name: CHANNELS[c - 1].name,
      token_name: user.tokens[tok]?.name || "", count: v[0], quota: v[1], token_used: v[2] });
  }
  return rows.sort((x, y) => y.quota - x.quota);
}

function route(req, url) {
  const path = url.pathname, q = url.searchParams;
  if (path === "/__health") return [200, { ok: true, epoch0, nh: agg.nh }];
  if (path === "/__stats") {
    const snapshot = { ...JSON.parse(JSON.stringify(stats)), ownRateLimited, ownLogKinds: { ...ownLogKinds }, keyAgentRotations, keyAgentDown, keyAgentRotatePaused, keyAgentStatus: { ...keyAgentStatus } };
    if (q.get("detail") === "1") snapshot.log = requestLog;
    if (q.get("reset") === "1") { stats.total = 0; stats.bytes = 0; stats.byRoute = Object.create(null); stats.bySite = Object.create(null); stats.startedAt = new Date().toISOString(); requestLog = []; ownLogKinds = { all: 0, latest: 0, filtered: 0 }; keyAgentRotations = 0; keyAgentStatus = Object.create(null); }
    return [200, snapshot];
  }
  if (path === "/__ctl") {
    if (q.has("delay")) delayMs = num(q.get("delay"), delayMs);
    if (q.has("ratio")) ratioMode = q.get("ratio") === "old" ? "old" : "current";
    if (q.has("freeze")) frozenSec = q.get("freeze") === "1" ? Math.floor(Date.now() / 1000) : null;
    if (q.has("down")) downSites = new Set((q.get("down") || "").split(",").filter(Boolean));
    if (q.has("key_agent_down")) keyAgentDown = q.get("key_agent_down") === "1";
    if (q.has("key_agent_rotate")) rotateKeyAgentChannels(); // 手动触发一次换 Key，不用等 10 分钟（本机调脚本用）
    // 暂停时顺带把换过的渠道换回绑定的那把 Key：对拍里 base、head 看到的读取服务和绑定对得上，不因为之前换过 Key 而不同
    if (q.has("key_agent_rotate_pause")) setKeyAgentRotatePaused(q.get("key_agent_rotate_pause") === "1");
    return [200, { delayMs, ratioMode, frozenSec, down: [...downSites], keyAgentDown, keyAgentRotatePaused }];
  }
  if (path.startsWith("/hook/")) return [200, { errcode: 0, errmsg: "ok", code: 0 }];
  const m = path.match(/^(\/(?:na|s2|nk)\d\d|\/own|\/key-agent)(\/.*)?$/);
  if (!m) return [404, { message: "unknown site" }];
  const site = m[1], rest = m[2] || "/";
  const key = `${site === "/own" ? "own" : site === "/key-agent" ? "key-agent" : site.slice(1, 3)}:${rest.replace(/\/\d+$/, "/:id")}`;
  stats.total += 1;
  stats.byRoute[key] = (stats.byRoute[key] || 0) + 1;
  stats.bySite[site] = (stats.bySite[site] || 0) + 1;
  const ownLogKind = key === "own:/api/log/" ? (OWN_LOG_FILTERS.some((f) => q.get(f) && q.get(f) !== "0") ? "filtered" : q.get("page_size") === "1" ? "latest" : "all") : null;
  if (ownLogKind) ownLogKinds[ownLogKind] += 1;
  if (requestLog.length < 200000) requestLog.push(ownLogKind ? [Date.now(), key, ownLogKind] : [Date.now(), key]);
  if (site === "/key-agent") {
    const r = keyAgentSite(req);
    if (rest === "/keys") keyAgentStatus[r[0]] = (keyAgentStatus[r[0]] || 0) + 1;
    return r;
  }
  if (downSites.has(site)) return [503, { success: false, message: "upstream down (fake)" }];
  if (site === "/own") return ownSite(rest, q, req);
  const up = upByPath.get(site);
  if (!up) return [404, { message: "unknown upstream" }];
  if (up.kind === "newapi") return newApiUpstream(up, rest, q, req);
  if (up.kind === "sub2api") return sub2Upstream(up, rest, q, req);
  return keyUpstream(up, rest, req);
}

const handler = (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const finish = () => {
    let status, body, headers;
    try { [status, body, headers] = route(req, url); }
    catch (err) { status = 500; body = { success: false, message: String(err?.message || err) }; console.error("[fake]", req.url, err); }
    send(res, status, body, headers);
  };
  const internal = url.pathname.startsWith("/__");
  req.resume();
  req.on("end", () => { if (!internal && delayMs > 0) setTimeout(finish, delayMs); else finish(); });
};
const server = createServer(handler);
server.keepAliveTimeout = 30000;
const ownServer = createServer(handler);
ownServer.keepAliveTimeout = 30000;
ownServer.listen(OWN_PORT, "127.0.0.1");
// 读取服务的 https 端口：只在 PERF_KEY_AGENT=on 时开（证书由 run.sh 生成，没有就报错退出——宁可起不来，也不要悄悄量不到）
if (KEY_AGENT_ON) {
  const tls = { cert: readFileSync(KEY_AGENT_TLS.cert), key: readFileSync(KEY_AGENT_TLS.key) };
  const keyAgentServer = createHttpsServer(tls, handler);
  keyAgentServer.keepAliveTimeout = 30000;
  keyAgentServer.listen(KEY_AGENT_PORT, "127.0.0.1", () => console.log(`[fake] 渠道 Key 读取服务 https://127.0.0.1:${KEY_AGENT_PORT}/key-agent`));
}
server.listen(PORT, "127.0.0.1", () => console.log(`[fake] 假站点 http://127.0.0.1:${PORT}（自营站点 ${OWN_PORT}），延迟 ${delayMs} ms，倍率口径 ${ratioMode}`));
