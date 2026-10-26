// 后台测量：服务空闲（没有页面打开）时，后台余额刷新循环 + 结账轮询的稳态开销，以及单独一轮全量刷新的耗时。
//   · 稳态窗口 W 秒（默认 185 秒，约 3 轮）：假站点收到的请求（按路由）、SQL 条数和耗时（按语句摘要）、binlog 写入量、服务进程 CPU/内存；
//   · 按假站点请求时间线切出每一轮结账轮询（own:/api/log/stat 的一串请求），报每轮耗时、请求数；
//   · 单独一轮余额刷新：POST /api/refresh 的耗时（和后台那轮的 SQL 一起按表归类估每轮条数）；
//   · 整站读（「算应付成本」开关，应付成本 V1）：每轮对自营站点不带筛选的 /api/log/ 几个、自营站点全部几个；任意 180 秒里对自营站点的请求数 ÷ 360（限流）；
//     own_log_cursor 在窗口两头各读一次，算落后多少、每分钟追多少、从刚打开到追平要多久。结果在 background.json 的 steady.ingest。
// 用法：node measure/background.mjs <结果目录> [窗口秒数]
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { login, appPid } from "../lib/env.mjs";
import { BASE, RULES, TZ, dateKeyOf, dayStartSec } from "../lib/model.mjs";
import { connect, digestSnapshot, digestDiff, binlogBytes, tableOf, kindOf } from "../lib/ps.mjs";

const outDir = process.argv[2];
const W = Number(process.argv[3] || 185);
mkdirSync(outDir, { recursive: true });
const api = await login();
// 「算应付成本」开关（应付成本 V1）：产品默认关着，默认场景也关着；只有 PERF_EXPECTED_COST=on 才打开（整站读场景，见 README）
const EXPECTED_COST = process.env.PERF_EXPECTED_COST === "on";
if (EXPECTED_COST) await api("/api/settings", { method: "PUT", body: { expectedCost: true } });
const conn = await connect();
// 整站读进度：own_log_cursor（base 是没有这张表的旧版时 table=false，报「不适用」）；GET /api/settings 的 ownLog 一起记下来对照
async function ingestProgress() {
  const at = Date.now();
  let table = true, cursor = null;
  try {
    const [rows] = await conn.query("SELECT station_id, covered_from_ms, covered_to_ms FROM own_log_cursor ORDER BY station_id LIMIT 1");
    if (rows[0]) cursor = { stationId: rows[0].station_id, coveredFromMs: Number(rows[0].covered_from_ms), coveredToMs: Number(rows[0].covered_to_ms) };
  } catch (err) { if (err?.code === "ER_NO_SUCH_TABLE") table = false; else throw err; }
  let buckets = null;
  if (table) { try { buckets = Number((await conn.query("SELECT COUNT(*) n FROM own_log_buckets"))[0][0].n); } catch { buckets = null; } }
  const ownLog = await api("/api/settings").then((r) => r.ownLog ?? null).catch(() => null);
  return { at, table, cursor, buckets, ownLog };
}
// 打开开关后等第一轮整站读建好进度（最多 150 秒），稳态窗口从有进度开始量，窗口开头那次读数才有意义
if (EXPECTED_COST) {
  for (const t = Date.now(); Date.now() - t < 150000; await new Promise((r) => setTimeout(r, 3000))) {
    const p = await ingestProgress();
    if (!p.table || p.cursor) break;
  }
}
const pid = appPid();
const sampleProc = () => { if (!pid) return null; try { const [cpu, rss] = execSync(`ps -o %cpu=,rss= -p ${pid}`).toString().trim().split(/\s+/).map(Number); return { cpu, rssMb: Math.round(rss / 1024) }; } catch { return null; } };

// ---- 稳态窗口 ----
await fetch(`${BASE}/__stats?reset=1`);
const ingest0 = await ingestProgress();
const d0 = await digestSnapshot(conn), b0 = await binlogBytes(conn), t0 = Date.now();
const procSamples = [];
while (Date.now() - t0 < W * 1000) { await new Promise((r) => setTimeout(r, 5000)); const s = sampleProc(); if (s) procSamples.push(s); }
const d1 = await digestSnapshot(conn), b1 = await binlogBytes(conn), elapsed = (Date.now() - t0) / 1000;
const fake = await (await fetch(`${BASE}/__stats?detail=1&reset=1`)).json();
const ingest1 = await ingestProgress();
const steady = digestDiff(d0, d1);
const perMin = (x) => Math.round((x / elapsed) * 60 * 10) / 10;

// 结账轮询的轮次：own:/api/log/stat 请求之间隔 > 15 秒就算新的一轮
const reconTimes = fake.log.filter(([, k]) => k === "own:/api/log/stat").map(([t]) => t);
const rounds = [];
for (const t of reconTimes) { const last = rounds.at(-1); if (last && t - last.end < 15000) { last.end = t; last.n++; } else rounds.push({ start: t, end: t, n: 1 }); }
const reconRounds = rounds.map((r) => ({ startAt: new Date(r.start).toISOString(), spanMs: r.end - r.start,
  requests: fake.log.filter(([t]) => t >= r.start - 2000 && t <= r.end + 500).length, channelStats: r.n }));
const balanceRounds = fake.log.filter(([, k]) => k === "nk:/dashboard/billing/subscription").length / 2;

// ---- 整站读：每轮请求数、限流占比、追平用时 ----
const LIMIT = 360, LIMIT_WINDOW_MS = 180000;
const ownTimes = fake.log.filter(([, k]) => k.startsWith("own:")).map(([t]) => t);
const allLogTimes = fake.log.filter(([, k, kind]) => k === "own:/api/log/" && kind === "all").map(([t]) => t);
// 每轮：从这一轮第一个 own:/api/log/stat 前 2 秒到下一轮同一点（整站读跟在结账后面，可能比最后一个渠道账单晚好几秒）
const roundEdges = rounds.map((r) => r.start - 2000);
const ingestRounds = rounds.map((r, i) => {
  const from = roundEdges[i], to = roundEdges[i + 1] ?? Infinity;
  const inRound = (t) => t >= from && t < to;
  const own = ownTimes.filter(inRound), all = allLogTimes.filter(inRound);
  // 整站读这一轮问额度时，前 180 秒对自营站点已经发了多少（这一轮第一个整站读之前；没有整站读就按这一轮最后一个自营请求）：
  // 推算额度 = min(90, 360 − 120 − used)（lib/own-request-budget.js 的规矩），读不到页时看这两个数。窗口开头不满 180 秒的标 usedPartial
  const askAt = all[0] ?? own.at(-1) ?? r.end;
  const used = ownTimes.filter((t) => t < askAt && t >= askAt - LIMIT_WINDOW_MS).length;
  return { startAt: new Date(r.start).toISOString(), ownRequests: own.length, ownLogAll: all.length,
    usedBefore: used, allowanceEstimate: Math.max(0, Math.min(Math.floor(LIMIT * 0.25), LIMIT - 120 - used)), usedPartial: askAt - LIMIT_WINDOW_MS < t0 };
});
// 任意 180 秒（滑动）里的最多请求数；窗口不到 180 秒时就是整个窗口的数
const maxIn = (times) => { let best = 0; for (let i = 0, j = 0; j < times.length; j++) { while (times[j] - times[i] >= LIMIT_WINDOW_MS) i++; best = Math.max(best, j - i + 1); } return best; };
const share = (n) => Math.round((n / LIMIT) * 1000) / 10;
const avg180 = (n) => Math.round((n / elapsed) * 180 * 10) / 10;
const behindAt = (p) => (p.cursor ? Math.max(0, p.at - 120000 - p.cursor.coveredToMs) : null);
let catchUp = null;
if (ingest0.table && ingest1.table && ingest1.cursor) {
  // 窗口开头还没有进度（第一轮整站读没赶上）：起点按进度的起点（昨天 0 点）算
  const startCovered = ingest0.cursor?.coveredToMs ?? ingest1.cursor.coveredFromMs;
  const wallMs = ingest1.at - ingest0.at, advancedMs = ingest1.cursor.coveredToMs - startCovered;
  const speed = wallMs > 0 ? advancedMs / wallMs : 0; // 每过 1 分钟读完多少分钟的日志
  // 刚打开开关：进度从昨天 0 点（业务时区）起，落后 = 现在 − 120 秒 − 昨天 0 点；每分钟净追 speed − 1 分钟
  const yesterdayStartMs = (dayStartSec(dateKeyOf(Math.floor(ingest1.at / 1000), TZ), TZ) - 86400) * 1000;
  const freshBehindMs = ingest1.at - 120000 - yesterdayStartMs;
  const eta = (behind) => (behind == null ? null : behind <= 0 ? 0 : speed > 1 ? Math.round(behind / (speed - 1)) : null);
  catchUp = { startCovered, startFromCursor: Boolean(ingest0.cursor), endCovered: ingest1.cursor.coveredToMs, wallMs, advancedMs,
    minutesPerMinute: Math.round(speed * 100) / 100, behindStartMs: Math.max(0, ingest0.at - 120000 - startCovered),
    behindEndMs: behindAt(ingest1), freshBehindMs, etaFromFreshMs: eta(freshBehindMs), etaFromNowMs: eta(behindAt(ingest1)) };
}
const ingest = {
  expectedCost: EXPECTED_COST, bindings: RULES.length, cursorTable: ingest1.table,
  perRound: { ownLogAll: rounds.length ? Math.round(allLogTimes.length / rounds.length * 10) / 10 : null,
    ownRequests: rounds.length ? Math.round(ownTimes.length / rounds.length * 10) / 10 : null },
  rounds: ingestRounds,
  rateLimit: { limit: LIMIT, windowSec: LIMIT_WINDOW_MS / 1000, fullWindow: elapsed >= LIMIT_WINDOW_MS / 1000,
    ownLogAllMax: maxIn(allLogTimes), ownLogAllMaxPct: share(maxIn(allLogTimes)), ownLogAllAvg: avg180(allLogTimes.length), ownLogAllAvgPct: share(avg180(allLogTimes.length)),
    ownMax: maxIn(ownTimes), ownMaxPct: share(maxIn(ownTimes)), ownAvg: avg180(ownTimes.length), ownAvgPct: share(avg180(ownTimes.length)) },
  ownLogKinds: fake.ownLogKinds ?? null,
  progress: { start: ingest0, end: ingest1 }, catchUp,
};

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
  if (log.length >= Math.max(1, Math.round(200 * RULES.length / 80)) && Date.now() - log.at(-1)[0] > 2000) break;
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
    balanceRounds, reconRounds, byTable, ingest,
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
console.log(JSON.stringify({ steady: { ...result.steady, topDigests: undefined, fakeByRoute: undefined, ingest: { ...ingest, rounds: undefined, progress: undefined } }, refreshRound: { ...result.refreshRound, digests: undefined, fakeByRoute: undefined } }, null, 2));
await conn.end();
