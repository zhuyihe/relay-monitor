// 后台测量：服务空闲（没有页面打开）时，后台余额刷新循环 + 结账轮询的稳态开销，以及单独一轮全量刷新的耗时。
//   · 稳态窗口 W 秒（默认 185 秒，约 3 轮）：假站点收到的请求（按路由）、SQL 条数和耗时（按语句摘要）、binlog 写入量、服务进程 CPU/内存；
//   · 按假站点请求时间线切出每一轮结账轮询（own:/api/log/stat 的一串请求），报每轮耗时、请求数；
//   · 单独一轮余额刷新：POST /api/refresh 的耗时（和后台那轮的 SQL 一起按表归类估每轮条数）。
// 用法：node measure/background.mjs <结果目录> [窗口秒数]
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { login, appPid } from "../lib/env.mjs";
import { BASE } from "../lib/model.mjs";
import { connect, digestSnapshot, digestDiff, binlogBytes, tableOf, kindOf } from "../lib/ps.mjs";

const outDir = process.argv[2];
const W = Number(process.argv[3] || 185);
mkdirSync(outDir, { recursive: true });
const api = await login();
// 「算应付成本」开关（应付成本 V1）：V1-a 默认关着，量压力时要打开才读整站日志；PERF_EXPECTED_COST=off 时不开
if (process.env.PERF_EXPECTED_COST !== "off") await api("/api/settings", { method: "PUT", body: { expectedCost: true } });
const conn = await connect();
const pid = appPid();
const sampleProc = () => { if (!pid) return null; try { const [cpu, rss] = execSync(`ps -o %cpu=,rss= -p ${pid}`).toString().trim().split(/\s+/).map(Number); return { cpu, rssMb: Math.round(rss / 1024) }; } catch { return null; } };

// ---- 稳态窗口 ----
await fetch(`${BASE}/__stats?reset=1`);
const d0 = await digestSnapshot(conn), b0 = await binlogBytes(conn), t0 = Date.now();
const procSamples = [];
while (Date.now() - t0 < W * 1000) { await new Promise((r) => setTimeout(r, 5000)); const s = sampleProc(); if (s) procSamples.push(s); }
const d1 = await digestSnapshot(conn), b1 = await binlogBytes(conn), elapsed = (Date.now() - t0) / 1000;
const fake = await (await fetch(`${BASE}/__stats?detail=1&reset=1`)).json();
const steady = digestDiff(d0, d1);
const perMin = (x) => Math.round((x / elapsed) * 60 * 10) / 10;

// 结账轮询的轮次：own:/api/log/stat 请求之间隔 > 15 秒就算新的一轮
const reconTimes = fake.log.filter(([, k]) => k === "own:/api/log/stat").map(([t]) => t);
const rounds = [];
for (const t of reconTimes) { const last = rounds.at(-1); if (last && t - last.end < 15000) { last.end = t; last.n++; } else rounds.push({ start: t, end: t, n: 1 }); }
const reconRounds = rounds.map((r) => ({ startAt: new Date(r.start).toISOString(), spanMs: r.end - r.start,
  requests: fake.log.filter(([t]) => t >= r.start - 2000 && t <= r.end + 500).length, channelStats: r.n }));
const balanceRounds = fake.log.filter(([, k]) => k === "nk:/dashboard/billing/subscription").length / 2;

const byTable = {};
for (const d of steady) {
  const key = `${kindOf(d.text)} ${tableOf(d.text)}`;
  const e = (byTable[key] ||= { count: 0, totalMs: 0, rowsExamined: 0, rowsAffected: 0 });
  e.count += d.count; e.totalMs += d.totalMs; e.rowsExamined += d.rowsExamined; e.rowsAffected += d.rowsAffected;
}

// ---- 单独一轮余额刷新（手动「刷新全部」同一个函数 refreshAll） ----
// 错开结账轮询：等一轮结账（own:/api/log/stat 那一串请求）结束 2 秒后再刷新，下一轮结账至少 60 秒后才来
await fetch(`${BASE}/__stats?reset=1`);
for (let waited = 0; waited < 90000; waited += 500) {
  const log = (await (await fetch(`${BASE}/__stats?detail=1`)).json()).log.filter(([, k]) => k === "own:/api/log/stat");
  if (log.length >= 200 && Date.now() - log.at(-1)[0] > 2000) break;
  await new Promise((r) => setTimeout(r, 500));
}
await fetch(`${BASE}/__stats?reset=1`);
const r0 = await digestSnapshot(conn), rb0 = await binlogBytes(conn);
const tr = performance.now();
await api("/api/refresh", { method: "POST", body: {} });
const refreshMs = Math.round(performance.now() - tr);
await new Promise((r) => setTimeout(r, 2500)); // 历史写库是 1.5 秒合并一批
const r1 = await digestSnapshot(conn), rb1 = await binlogBytes(conn);
const refreshFake = await (await fetch(`${BASE}/__stats?reset=1`)).json();
const refreshSql = digestDiff(r0, r1);
// 只算余额刷新那条路径碰的表（万一和后台那轮叠上了，结账轮询的语句不算进来）
const BALANCE_TABLES = /`(stations|meta|history_points|station_daily_usage)`/;
const refreshOwn = refreshSql.filter((d) => BALANCE_TABLES.test(d.text || ""));
const txPairs = refreshOwn.filter((d) => /`stations`/.test(d.text) && /^INSERT/i.test(d.text)).reduce((a, d) => a + d.count, 0);

const result = {
  at: new Date().toISOString(), windowSec: Math.round(elapsed),
  steady: {
    fakeRequests: fake.total, fakeRequestsPerMin: perMin(fake.total), fakeByRoute: fake.byRoute, fakeBytes: fake.bytes,
    sqlStatements: steady.reduce((a, d) => a + d.count, 0), sqlPerMin: perMin(steady.reduce((a, d) => a + d.count, 0)),
    sqlMsPerMin: perMin(steady.reduce((a, d) => a + d.totalMs, 0)),
    rowsExamined: steady.reduce((a, d) => a + d.rowsExamined, 0), rowsExaminedPerMin: perMin(steady.reduce((a, d) => a + d.rowsExamined, 0)),
    binlogBytes: b1 != null && b0 != null ? b1 - b0 : null, binlogBytesPerMin: b1 != null && b0 != null ? perMin(b1 - b0) : null,
    balanceRounds, reconRounds, byTable,
    proc: { samples: procSamples.length, cpuAvg: Math.round(procSamples.reduce((a, s) => a + s.cpu, 0) / Math.max(1, procSamples.length) * 10) / 10,
      cpuMax: Math.max(0, ...procSamples.map((s) => s.cpu)), rssMbMax: Math.max(0, ...procSamples.map((s) => s.rssMb)) },
    topDigests: steady.slice(0, 25).map(({ sample, ...d }) => d),
  },
  refreshRound: {
    ms: refreshMs, fakeRequests: refreshFake.total, fakeByRoute: refreshFake.byRoute,
    sqlStatementsAll: refreshSql.reduce((a, d) => a + d.count, 0),
    // 余额刷新自己的语句 + 每次存站点的那个事务的 START/COMMIT
    sqlStatements: refreshOwn.reduce((a, d) => a + d.count, 0) + 2 * txPairs, stationSaves: txPairs,
    sqlMs: Math.round(refreshOwn.reduce((a, d) => a + d.totalMs, 0)),
    rowsAffected: refreshOwn.reduce((a, d) => a + d.rowsAffected, 0), rowsExamined: refreshOwn.reduce((a, d) => a + d.rowsExamined, 0),
    stationRowsWritten: refreshOwn.filter((d) => /INSERT INTO `stations`/.test(d.text)).reduce((a, d) => a + d.rowsAffected, 0),
    binlogBytes: rb1 != null && rb0 != null ? rb1 - rb0 : null,
    digests: refreshSql.map(({ sample, ...d }) => d),
  },
};
writeFileSync(`${outDir}/background.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ steady: { ...result.steady, topDigests: undefined, fakeByRoute: undefined }, refreshRound: { ...result.refreshRound, digests: undefined, fakeByRoute: undefined } }, null, 2));
await conn.end();
