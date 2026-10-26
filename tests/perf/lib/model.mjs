// 性能夹具的确定性数据模型：假站点（fake-site.mjs）和种子脚本（seed/*.mjs）共用这一份。
// 一切数字都由 (事件序号 k, 夹具起点 epoch0) 推出来，不存 900 万行日志：
//   自营站点每天 EVENTS_PER_DAY 条消费日志，第 k 条的时间 t_k = epoch0 + floor(k*0.864) 秒，
//   用户（Zipf）、Key、分组、模型、渠道、token、额度都由 hash(k) 决定。
//   上游 Key 的成本 = 绑定到它的自营渠道收入 × 成本系数；没绑定的 Key 按固定速率花钱。
// 按小时预聚合（渠道、模型、用户），分页和统计都从同一个事件函数算，结果互相对得上。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const PERF_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
// 结果目录（夹具配置、进度、测量结果都写这里，不写进仓库）：PERF_OUT，默认系统临时目录下的 relay-monitor-perf
export const OUT_DIR = resolve(process.env.PERF_OUT || join(tmpdir(), "relay-monitor-perf"));
export const CONFIG_PATH = join(OUT_DIR, "fixture", "config.json");
export const PORT = Number(process.env.FAKE_PORT || 18950);
export const BASE = `http://127.0.0.1:${PORT}`;
// 自营站点单独一个端口（同一个假站点进程）：控制台按「主机:端口」给自营站点记请求额度（lib/own-request-budget.js），
// 和上游共用一个端口的话，读上游的请求也算进自营站点的 180 秒 360 个里，整站读分到的额度就不对了
export const OWN_PORT = Number(process.env.FAKE_OWN_PORT || PORT + 1);
export const QPU = 500000;
export const N_UP = 50;
export const N_CH = 300;
export const N_USERS = 500;
export const EVENTS_PER_DAY = 100000;
const SP_NUM = 864, SP_DEN = 1000; // 事件间隔 0.864 秒 = 每天 10 万条
export const TZ = "Asia/Shanghai";
export const HOUR = 3600;

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`没有夹具配置 ${CONFIG_PATH}，先跑 seed/00-config.mjs`);
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

export function h32(x) {
  x = (x | 0) ^ 0x2545f491;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export const MODELS = ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5", "gpt-5", "gpt-5-mini", "gpt-4o",
  "gemini-2.5-pro", "gemini-2.5-flash", "deepseek-v3.2", "deepseek-r1", "grok-4", "qwen3-coder"];
const MODEL_RATIO = [1.5, 7.5, 0.5, 0.625, 0.125, 1.25, 0.625, 0.15, 0.14, 0.28, 1.5, 0.5];
const COMPLETION_RATIO = [5, 5, 5, 8, 8, 4, 8, 8, 4, 4, 5, 4];
export const OWN_GROUPS = ["default", "vip", "svip", "claude", "claude-max", "gpt", "gemini", "deepseek", "grok", "free"];
const OWN_GROUP_RATIO = [1, 1.2, 1.5, 1.3, 2, 1, 1, 0.8, 1.1, 0.5];
// 每个分组 6 个模型（7j mod 12 在 j=0..5 两两不同）
export const GROUP_MODELS = OWN_GROUPS.map((_, g) => Array.from({ length: 6 }, (_, j) => (g * 5 + j * 7) % 12));
const SLOT_CUM = [40, 65, 80, 92, 100];
export const UP_GROUPS = ["default", "vip", "claude", "gpt", "gemini", "svip"];

// ---- 上游账号 --------------------------------------------------------------
const ALL_UPSTREAMS = Array.from({ length: N_UP }, (_, idx) => {
  const i = idx + 1;
  const kind = i <= 44 ? "newapi" : i <= 48 ? "sub2api" : "newapi-key";
  const prefix = kind === "newapi" ? "na" : kind === "sub2api" ? "s2" : "nk";
  const path = `/${prefix}${String(i).padStart(2, "0")}`;
  const accountId = 1000 + i;
  const tokens = Array.from({ length: kind === "newapi-key" ? 1 : kind === "sub2api" ? 5 : 6 }, (_, j) => ({
    id: i * 100 + j + 1, name: `key-${String(i).padStart(2, "0")}-${j + 1}`,
    group: kind === "sub2api" ? "" : UP_GROUPS[(i + j) % UP_GROUPS.length],
    groupId: kind === "sub2api" ? (j % 3) + 1 : null,
    // 没绑定的 Key 自己花钱：每天 0.3~3 美元
    freeRateUsdPerDay: 0.3 + (h32(i * 31 + j) % 270) / 100,
  }));
  const bound = kind === "newapi-key" ? 0 : (i % 3 === 0 ? 1 : 2);
  return { i, kind, path, baseUrl: `${BASE}${path}`, accountId, name: `上游${String(i).padStart(2, "0")}·${kind === "newapi" ? "NA" : kind === "sub2api" ? "S2" : "KEY"}`,
    accessToken: kind === "newapi" ? `pat-${prefix}${i}-0123456789abcdef` : kind === "sub2api" ? `s2jwt.${i}.0123456789abcdef` : "",
    apiKey: kind === "newapi-key" ? `sk-nk${i}-0123456789abcdef0123456789` : "", userId: kind === "newapi" ? String(accountId) : "",
    tokens, boundTokens: tokens.slice(0, bound),
    lowBalance: [7, 23, 41].includes(i) };
});
export const OWN = { path: "/own", baseUrl: `http://127.0.0.1:${OWN_PORT}/own`, accessToken: "pat-own-root-0123456789abcdef", userId: "1", accountId: 1 };

// ---- 规则（绑定）和自营渠道 --------------------------------------------------
// 80 条规则（48 个能读账单的账号，16 个绑 1 把 Key、32 个绑 2 把），按顺序分 285 个渠道（前 45 条 4 个、后 35 条 3 个）；
// 剩下 15 个渠道走两个只用 Key 的上游，只看余额不算账（「没算进来」）。
const ALL_RULES = [];
for (const up of ALL_UPSTREAMS) for (const token of up.boundTokens) ALL_RULES.push({ r: ALL_RULES.length, up, token });
const channelUp = new Array(N_CH + 1), channelRule = new Array(N_CH + 1).fill(-1);
{
  let c = 1;
  for (const rule of ALL_RULES) {
    const n = rule.r < 45 ? 4 : 3;
    rule.channels = [];
    for (let j = 0; j < n; j++, c++) { rule.channels.push(c); channelUp[c] = rule.up; channelRule[c] = rule.r; }
    rule.costFactor = 0.55 + (h32(rule.r * 13 + 7) % 35) / 100;
    // 约 10% 的绑定没回答「这把 Key 还给别处用吗」——页面上的「需处理」
    rule.coverage = rule.r % 10 === 7 ? "unknown" : "none";
  }
  const keyUps = ALL_UPSTREAMS.filter((up) => up.kind === "newapi-key");
  for (let k = 0; c <= N_CH; c++, k++) channelUp[c] = keyUps[k < 8 ? 0 : 1];
}
// 小夹具：PERF_BINDINGS=N（1–80，默认空 = 全部 80 条）只接入前 N 条绑定、它们所在的上游和两个只用 Key 的上游。
// 模型本身不变（渠道归属、事件、收入、成本都按 80 条算）：没接入的绑定的渠道照旧有消费，只是控制台里没有绑定管它们，
// 像真站点上没配进控制台的渠道。种子、假站点、测量都从这里取 RULES、UPSTREAMS，不设时和原来逐字一样。
const BINDINGS = (() => {
  const raw = String(process.env.PERF_BINDINGS ?? "").trim();
  if (!raw) return ALL_RULES.length;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > ALL_RULES.length) throw new Error(`PERF_BINDINGS=${raw}：要 1–${ALL_RULES.length} 的整数，或者不设`);
  return n;
})();
export const RULES = ALL_RULES.slice(0, BINDINGS);
export const UPSTREAMS = ALL_UPSTREAMS.filter((up) => up.kind === "newapi-key" || RULES.some((rule) => rule.up === up));
export const KEY_UP_CHANNELS = (up) => Array.from({ length: N_CH }, (_, x) => x + 1).filter((c) => channelUp[c] === up && channelRule[c] < 0);
export const CHANNELS = Array.from({ length: N_CH }, (_, x) => {
  const c = x + 1, up = channelUp[c], p = Math.floor((c - 1) / 5);
  const g = Math.floor(p / 6), m = GROUP_MODELS[g][p % 6];
  return { id: c, name: `${up.name}-${MODELS[m]}-${c}`, type: up.kind === "sub2api" ? 14 : 1,
    status: c % 61 === 0 ? 2 : c % 97 === 0 ? 3 : 1, baseUrl: up.baseUrl, group: [OWN_GROUPS[g], c % 4 === 0 ? "vip" : ""].filter(Boolean).join(","),
    upstream: up.i, rule: channelRule[c] };
});
export function channelUpstream(c) { return channelUp[c]; }
export function channelRuleIndex(c) { return channelRule[c]; }

// ---- 自营站点用户 -----------------------------------------------------------
const zipfCum = new Float64Array(N_USERS);
{
  let s = 0;
  for (let r = 0; r < N_USERS; r++) { s += 1 / Math.pow(r + 1, 1.1); zipfCum[r] = s; }
  for (let r = 0; r < N_USERS; r++) zipfCum[r] /= s;
}
// 排名 r → 用户序号 u（0 起），用户 id = u + 1
const rankUser = (r) => (r * 37 + 5) % N_USERS;
export const USERS = Array.from({ length: N_USERS }, (_, u) => {
  const id = u + 1;
  const role = id === 1 ? 100 : id <= 3 ? 10 : 1;
  const username = id === 1 ? "root" : id === 2 ? "admin2" : id === 3 ? "ops3" : `user${id}`;
  const tokCount = 1 + (h32(u + 77) & 1);
  const groups = [h32(u * 3 + 1) % 10, h32(u * 3 + 2) % 10].slice(0, tokCount);
  const prefs = groups.map((_, t) => { const s = h32(u * 7 + t) % 6; return [s, (s + 1) % 6, (s + 3) % 6]; });
  return { u, id, role, username, status: id % 53 === 0 ? 2 : 1, tokCount, groups, prefs,
    tokens: groups.map((g, t) => ({ id: id * 10 + t + 1, name: `u${id}-k${t + 1}`, group: OWN_GROUPS[g] })),
    quota: 2000000 + (h32(u + 5) % 200) * 1000000 };
});

// ---- 事件 -------------------------------------------------------------------
export function makeEventModel(epoch0) {
  const tOf = (k) => epoch0 + Math.floor((k * SP_NUM) / SP_DEN);
  // 第一个 t_k >= T 的 k
  const kAt = (T) => Math.max(0, Math.ceil(((T - epoch0) * SP_DEN) / SP_NUM));
  const ev = { k: 0, t: 0, u: 0, tok: 0, g: 0, m: 0, c: 0, prompt: 0, completion: 0, cacheRead: 0, quota: 0 };
  function decode(k, out = ev) {
    const h = h32(k), h2 = h32(k + 0x51ed270b), h3 = h32(k ^ 0x68e31da4);
    const z = (h % 1000003) / 1000003;
    let lo = 0, hi = N_USERS - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (zipfCum[mid] < z) lo = mid + 1; else hi = mid; }
    // 头部 50 个用户全天都在用；其余用户每天只有约 1/8 的小时在用，不在用的那一刻这条请求算给头部用户
    const t = tOf(k), hourIdx = Math.floor((t - epoch0) / 3600);
    if (lo >= 50 && h32(lo * 7919 + hourIdx) % 8 !== 0) lo = lo % 50;
    const user = USERS[rankUser(lo)];
    const tok = (h >>> 9) % user.tokCount;
    const g = user.groups[tok];
    const mi = user.prefs[tok][(h >>> 13) % 3];
    const p = g * 6 + mi;
    const r = h2 % 100;
    const slot = r < SLOT_CUM[0] ? 0 : r < SLOT_CUM[1] ? 1 : r < SLOT_CUM[2] ? 2 : r < SLOT_CUM[3] ? 3 : 4;
    const m = GROUP_MODELS[g][mi];
    const prompt = 200 + (h3 % 8000), completion = 50 + ((h3 >>> 13) % 1500);
    const cacheRead = m <= 2 ? prompt * (4 + (h2 >>> 20) % 20) : 0;
    out.k = k; out.t = t; out.u = user.u; out.tok = tok; out.g = g; out.m = m; out.c = p * 5 + slot + 1;
    out.prompt = prompt; out.completion = completion; out.cacheRead = cacheRead;
    out.quota = Math.round((prompt + cacheRead * 0.1 + completion * COMPLETION_RATIO[m]) * MODEL_RATIO[m] * OWN_GROUP_RATIO[g]);
    return out;
  }
  return { epoch0, tOf, kAt, decode };
}

// ---- 按小时预聚合 -----------------------------------------------------------
// hour H 覆盖 [epoch0 + H*3600, epoch0 + (H+1)*3600)；epoch0 是 UTC 零点，和上海时区的整点对齐。
export function makeAggregates(epoch0) {
  const em = makeEventModel(epoch0);
  let nh = 0;
  let chanQ = new Float64Array(0), chanN = new Float64Array(0), modelA = new Float64Array(0), userA = new Float64Array(0);
  const grow = (arr, size) => { const next = new Float64Array(size); next.set(arr); return next; };
  // 补算到第 hEnd 个小时（不含）；只算已经完全过去的小时
  function ensureHours(hEnd) {
    if (hEnd <= nh) return;
    chanQ = grow(chanQ, hEnd * N_CH); chanN = grow(chanN, hEnd * N_CH);
    modelA = grow(modelA, hEnd * 12 * 3); userA = grow(userA, hEnd * N_USERS * 3);
    const e = { ...em.decode(0) };
    for (let H = nh; H < hEnd; H++) {
      const k0 = em.kAt(epoch0 + H * HOUR), k1 = em.kAt(epoch0 + (H + 1) * HOUR);
      for (let k = k0; k < k1; k++) {
        em.decode(k, e);
        const ci = H * N_CH + e.c - 1;
        chanQ[ci] += e.quota; chanN[ci] += 1;
        const mi = (H * 12 + e.m) * 3; modelA[mi] += 1; modelA[mi + 1] += e.quota; modelA[mi + 2] += e.prompt + e.completion;
        const ui = (H * N_USERS + e.u) * 3; userA[ui] += 1; userA[ui + 1] += e.quota; userA[ui + 2] += e.prompt + e.completion;
      }
    }
    nh = hEnd;
  }
  const completeHoursAt = (nowSec) => Math.floor((nowSec - epoch0) / HOUR);
  const hourOf = (t) => Math.floor((t - epoch0) / HOUR);
  // 遍历 [s, e]（秒，含两端）内的事件：整小时走聚合 full(H)，零头逐条 each(event)
  function scan(s, e, full, each) {
    if (e < s) return;
    s = Math.max(s, epoch0);
    const nowH = completeHoursAt(Math.floor(Date.now() / 1000));
    ensureHours(nowH);
    const kFirst = em.kAt(s), kLast = em.kAt(e + 1) - 1;
    if (kLast < kFirst) return;
    const hS = hourOf(em.tOf(kFirst)), hE = hourOf(em.tOf(kLast));
    const ev = { ...em.decode(0) };
    const partial = (ka, kb) => { for (let k = ka; k <= kb; k++) each(em.decode(k, ev)); };
    for (let H = hS; H <= hE; H++) {
      const hk0 = em.kAt(epoch0 + H * HOUR), hk1 = em.kAt(epoch0 + (H + 1) * HOUR) - 1;
      const a = Math.max(hk0, kFirst), b = Math.min(hk1, kLast);
      if (a === hk0 && b === hk1 && H < nh && full) full(H);
      else partial(a, b);
    }
  }
  return { em, ensureHours, scan, hourOf, get nh() { return nh; }, chanQ: () => chanQ, chanN: () => chanN, modelA: () => modelA, userA: () => userA };
}

// 渠道收入（额度）：[s, e] 秒
export function channelQuota(agg, channelIds, s, e) {
  const want = new Uint8Array(N_CH + 1);
  for (const c of channelIds) want[c] = 1;
  const out = new Float64Array(N_CH + 1);
  const chanQ = () => agg.chanQ();
  agg.scan(s, e, (H) => { const q = chanQ(); for (const c of channelIds) out[c] += q[H * N_CH + c - 1]; },
    (ev) => { if (want[ev.c]) out[ev.c] += ev.quota; });
  return out;
}

// 上游某把 Key 在 [s, e] 的成本（额度）
export function tokenCostQuota(agg, up, token, s, e) {
  const rule = ALL_RULES.find((r) => r.up === up && r.token.id === token.id);
  if (rule) {
    const q = channelQuota(agg, rule.channels, s, e);
    let sum = 0;
    for (const c of rule.channels) sum += q[c];
    return Math.round(sum * rule.costFactor);
  }
  // 只用 Key 的上游：它下面的渠道按 0.8 记成本
  if (up.kind === "newapi-key") {
    const chans = KEY_UP_CHANNELS(up), q = channelQuota(agg, chans, s, e);
    let sum = 0; for (const c of chans) sum += q[c];
    return Math.round(sum * 0.8);
  }
  const lo = Math.max(s, agg.em.epoch0), span = Math.max(0, e - lo + 1);
  return Math.round(token.freeRateUsdPerDay * QPU * span / 86400);
}

export function accountCostQuota(agg, up, s, e) {
  let sum = 0;
  for (const token of up.tokens) sum += tokenCostQuota(agg, up, token, s, e);
  return sum;
}

// 余额：起始额度 + 定期充值 - 累计花费（额度单位）。日均花费由近 7 天估出来，夹具起点固定后不变。
export function makeBalanceModel(agg, config) {
  const epoch0 = config.epoch0Sec;
  const daily = new Map();
  for (const up of UPSTREAMS) {
    const ref = epoch0 + 7 * 86400;
    daily.set(up.i, Math.max(QPU, accountCostQuota(agg, up, epoch0, ref - 1) / 7));
  }
  function grants(up, t) {
    const d = daily.get(up.i);
    const r0 = up.lowBalance ? d * 3 : d * 20;
    const period = 15 * 86400, offset = (up.lowBalance ? 2 : 10) * 86400 + up.i * 3600;
    let total = r0;
    for (let at = epoch0 + offset; at <= t; at += period) total += d * 15;
    return total;
  }
  return {
    daily: (up) => daily.get(up.i),
    state(up, t, used = accountCostQuota(agg, up, epoch0, t)) {
      const granted = grants(up, t);
      return { granted, used, remaining: Math.max(0, granted - used) };
    },
  };
}

// 时区日界：YYYY-MM-DD 在 tz 的零点（秒）
export function dayStartSec(dateKey, tz = TZ) {
  const [y, mo, d] = dateKey.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d) / 1000;
  const off = tzOffsetSec(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetSec(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}
const offsetFmt = new Map();
export function tzOffsetSec(tSec, tz = TZ) {
  let f = offsetFmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); offsetFmt.set(tz, f); }
  const parts = Object.fromEntries(f.formatToParts(new Date(tSec * 1000)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) / 1000;
  return asUtc - tSec;
}
export function dateKeyOf(tSec, tz = TZ) {
  const o = tzOffsetSec(tSec, tz);
  return new Date((tSec + o) * 1000).toISOString().slice(0, 10);
}

// 上游分组倍率：config.ratioChanges 里的 (上游, 分组) 在 ratioChangeAtMs 涨过 25%；mode=old 返回旧倍率
export function upstreamGroupRatio(config, up, group, mode = "current") {
  const base = 1 + (up.i % 5) * 0.1 + group.length * 0.01;
  const changed = (config.ratioChanges || []).some((x) => x.upstream === up.i && x.group === group);
  return Math.round((changed && mode === "current" ? base * 1.25 : base) * 1000) / 1000;
}
