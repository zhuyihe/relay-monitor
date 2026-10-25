// 接口测量：服务预热后，每个接口先请求 1 次（冷：服务端缓存还没有这一项），再连续请求 N 次（默认 10）取 p50/p95。
// 参数照页面真实会带的（app/(dashboard)/*/page.tsx 的 api(...) 调用）。带登录 cookie。
// 用法：node measure/api.mjs <结果目录> [次数]
import { mkdirSync, writeFileSync } from "node:fs";
import { login, APP } from "../lib/env.mjs";
import { startWatchdog } from "../lib/ps.mjs";

const outDir = process.argv[2];
const N = Number(process.argv[3] || 10);
mkdirSync(outDir, { recursive: true });
const api = await login();
const loginRes = await fetch(`${APP}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
const cookie = loginRes.headers.get("set-cookie").split(";")[0];

const stations = (await api("/api/stations?includeUnmonitored=true&includeArchived=true")).stations;
const config = await api("/api/reconciliation/configuration");
const rule = (config.rules || []).find((r) => r.enabled) || config.rules?.[0];
const upNa = stations.find((s) => s.type === "newapi" && !s.isOwn);
const upS2 = stations.find((s) => s.type === "sub2api");
const tz = "Asia/Shanghai";
const now = Date.now();

// [名字, 路径, 方法, 请求体, 说明]
const ENDPOINTS = [
  ["stations", "/api/stations"],
  ["stations 全部", "/api/stations?includeUnmonitored=true&includeArchived=true"],
  ["meta", "/api/meta"],
  ["analytics 7 天", "/api/analytics?days=7&includeArchived=true"],
  ["analytics 30 天", "/api/analytics?days=30&includeArchived=true"],
  ["analytics 90 天", "/api/analytics?days=90&includeArchived=true"],
  ["own/analytics 今天", "/api/own/analytics?range=today"],
  ["own/analytics 7 天", "/api/own/analytics?range=7d"],
  ["own/analytics 30 天", "/api/own/analytics?range=30d"],
  ["own/audit 今天 4000 行", "/api/own/audit?range=today&maxRows=4000"],
  ["own/admin-keys", "/api/own/admin-keys"],
  ["usage 今天", `/api/usage?range=today&tz=${encodeURIComponent(tz)}`],
  ["usage 7 天", `/api/usage?range=7d&tz=${encodeURIComponent(tz)}`],
  ["usage 30 天", `/api/usage?range=30d&tz=${encodeURIComponent(tz)}`],
  ["reconciliation/configuration", "/api/reconciliation/configuration"],
  ["reconciliation/configuration 含已解除", "/api/reconciliation/configuration?includeArchived=true"],
  ["reconciliation 今天", "/api/reconciliation?preset=today"],
  ["reconciliation 昨天", "/api/reconciliation?preset=yesterday"],
  ["reconciliation 近 7 天", "/api/reconciliation?preset=7d"],
  ["reconciliation 本月", "/api/reconciliation?preset=month"],
  ["reconciliation/query 昨天（切换范围，不读缓存）", "/api/reconciliation/query", "POST", { preset: "yesterday" }],
  ["reconciliation/query 近 7 天（切换范围，不读缓存）", "/api/reconciliation/query", "POST", { preset: "7d" }],
  ["reconciliation/query 本月（切换范围，不读缓存）", "/api/reconciliation/query", "POST", { preset: "month" }],
  ...(rule ? [
    ["账本列表 一条绑定 默认 31 天 20 行", `/api/reconciliation/rules/${encodeURIComponent(rule.id)}/confirmed?limit=20`],
    ["账本列表 一条绑定 90 天前那 31 天", `/api/reconciliation/rules/${encodeURIComponent(rule.id)}/confirmed?limit=20&startMs=${now - 90 * 86400000}&endMs=${now - 59 * 86400000}`],
    ["绑定倍率时段", `/api/reconciliation/rules/${encodeURIComponent(rule.id)}/segments`],
  ] : []),
  ...(upNa ? [["上游 Key 目录（New API）", `/api/reconciliation/upstreams/${encodeURIComponent(upNa.id)}/keys`]] : []),
  ...(upS2 ? [["上游 Key 目录（Sub2API）", `/api/reconciliation/upstreams/${encodeURIComponent(upS2.id)}/keys`]] : []),
  ["channel-onboarding/accounts", "/api/channel-onboarding/accounts"],
  ["channel-onboarding 渠道列表", "/api/channel-onboarding"],
  ["notifications", "/api/notifications"],
  ["settings", "/api/settings"],
  ["settings/history-preview 30 天", "/api/settings/history-preview?days=30"],
  ...(upNa ? [["station history 48h", `/api/stations/${encodeURIComponent(upNa.id)}/history?hours=48`],
    ["station history 30 天", `/api/stations/${encodeURIComponent(upNa.id)}/history?hours=720`]] : []),
  ["history/overview 24h", "/api/history/overview?hours=24"],
];

// 单次请求最多等 TIMEOUT_MS；数据库里跑了 KILL_SEC 秒还没完的查询由看门狗杀掉（不然会一直占着 MySQL）
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 60000), KILL_SEC = Number(process.env.KILL_SEC || 60);
const watchdog = startWatchdog(KILL_SEC, (k) => console.log(`  看门狗杀掉一条跑了 ${k.seconds} 秒的查询：${k.sql.slice(0, 100)}`));
async function once(path, method = "GET", body) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${APP}${path}`, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const buf = await res.arrayBuffer();
    return { ms: performance.now() - t0, bytes: buf.byteLength, status: res.status };
  } catch (err) {
    return { ms: performance.now() - t0, bytes: 0, status: "超时", error: String(err?.name || err) };
  }
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

const results = [];
for (const [name, path, method, body] of ENDPOINTS) {
  const cold = await once(path, method, body);
  const times = [];
  let bytes = cold.bytes, status = cold.status;
  // 冷请求超时或超过 20 秒就不再重复（重复只会再占 MySQL 几分钟），只记冷的那次
  const repeat = cold.status === "超时" || cold.ms > 20000 ? 0 : N;
  if (!repeat) times.push(cold.ms);
  for (let i = 0; i < repeat; i++) {
    const r = await once(path, method, body);
    times.push(r.ms); bytes = r.bytes; status = r.status;
  }
  const row = { name, path, method: method || "GET", status, coldStatus: cold.status, repeated: repeat, coldMs: Math.round(cold.ms), p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)),
    max: Math.round(Math.max(...times)), bytes, times: times.map(Math.round) };
  results.push(row);
  console.log(`${row.status} ${String(row.coldMs).padStart(6)} ${String(row.p50).padStart(6)} ${String(row.p95).padStart(6)} ${String(bytes).padStart(9)}  ${name}`);
}
await new Promise((r) => setTimeout(r, 6000));
await watchdog.stop();
writeFileSync(`${outDir}/api.json`, JSON.stringify({ at: new Date().toISOString(), app: APP, n: N, timeoutMs: TIMEOUT_MS, killSec: KILL_SEC, killed: watchdog.killed, results }, null, 2));
