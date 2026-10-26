// base 和 head 在同一个夹具上各量一次「接口和后台」以后对比：node measure/compare.mjs <base 结果目录> <head 结果目录>
// 只有「可比的数」参与超线判断：请求数（假站点按路由、每轮结账轮询）、SQL 条数、扫描行数、返回体字节、binlog 字节、新出现的语句和它们的 EXPLAIN。
// 毫秒、CPU、内存只做参考（CI 机器快慢不一），表里标「参考」，不算超线。
// 超线规则沿用本机测试台基线报告第 8 节（CONTRIBUTING.md 4.3），阈值可用环境变量调：
//   BODY_PCT=20 BODY_MAX_KB=1024   返回体比 base 涨超过 20%（且多出 2 KB 以上），或超过 1 MB
//   SQL_PCT=20                     一轮余额刷新、每轮结账轮询的 SQL 条数 / 假站点请求 / binlog 比 base 涨超过 20%
//   SCAN_ROWS=10000                新出现的语句每次扫描超过 1 万行，或 EXPLAIN 里有 type=ALL 且 rows > 1000
// 有超线时退出码是 2（结果照样打到标准输出）。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { perRound, INGEST_ROWS, ingestCell, ingestRoundLine } from "../lib/metrics.mjs";

const [baseDir, headDir] = process.argv.slice(2);
if (!baseDir || !headDir) { console.error("用法：node measure/compare.mjs <base 结果目录> <head 结果目录>"); process.exit(1); }
const env = (k, d) => Number(process.env[k] ?? d);
const load = (dir, name) => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null;
const commit = (dir) => (existsSync(join(dir, "commit.txt")) ? readFileSync(join(dir, "commit.txt"), "utf8").trim().slice(0, 7) : "?");
const pct = (a, b) => (a ? Math.round(((b - a) / a) * 100) : (b ? 100 : 0));
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const kb = (b) => (b == null ? "?" : (b / 1024).toFixed(1));
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const out = [`# 性能对比：head ${commit(headDir)} 对 base ${commit(baseDir)}\n`,
  "「可比」的数（请求数、SQL 条数、扫描行数、字节）两边在同一个夹具、同一台机器上量，参与超线判断；「参考」的数（毫秒、CPU、内存）随机器快慢变，只看个大概，不算超线。\n"];
let flags = 0;
const flag = (bad) => (bad ? (flags++, "⚠") : "");
// base 本来就超了绝对线的项：head 比 base 再差才算，否则标「base 已超」不计数
const already = (baseBad, worse) => (baseBad ? (worse ? (flags++, "⚠ 更差") : "base 已超") : null);

// ---- 接口 ----
const [a1, a2] = [load(baseDir, "api.json"), load(headDir, "api.json")];
if (a1 && a2) {
  out.push("## 接口\n", "返回体（可比）和状态码超线才标 ⚠；p95 毫秒只做参考。\n",
    "| 接口 | 状态 base → head | 返回体 KB base | head | 变化 | | p95 ms base（参考） | head（参考） |", "|---|---|--:|--:|--:|---|--:|--:|");
  const base = new Map(a1.results.map((r) => [r.name, r]));
  const maxBytes = env("BODY_MAX_KB", 1024) * 1024;
  for (const r of a2.results) {
    const b = base.get(r.name);
    if (!b) { out.push(`| ${r.name} | 新 → ${r.status} | | ${kb(r.bytes)} | | ${flag(r.bytes > maxBytes || r.status !== 200)} | | ${r.p95} |`); continue; }
    const worse = pct(b.bytes, r.bytes) > env("BODY_PCT", 20) && r.bytes - b.bytes > 2048;
    const broke = b.status === 200 && r.status !== 200;
    const mark = broke ? flag(true) : (already(b.bytes > maxBytes || b.status !== 200, worse) ?? flag(worse || r.bytes > maxBytes));
    out.push(`| ${r.name} | ${b.status === r.status ? r.status : `${b.status} → ${r.status}`} | ${kb(b.bytes)} | ${kb(r.bytes)} | ${pct(b.bytes, r.bytes)}% | ${mark} | ${b.p95} | ${r.p95} |`);
  }
  for (const [name] of base) if (!a2.results.some((r) => r.name === name)) out.push(`| ${name} | head 没量 | | | | | | |`);
  if (a1.killed?.length || a2.killed?.length) out.push("", `看门狗杀掉的慢查询：base ${a1.killed?.length || 0} 条，head ${a2.killed?.length || 0} 条（见各自 api.json 的 killed）。`);
  out.push("");
}

// ---- 后台 ----
const [b1, b2] = [load(baseDir, "background.json"), load(headDir, "background.json")];
if (b1 && b2) {
  const r1 = perRound(b1) || {}, r2 = perRound(b2) || {};
  out.push("## 后台（没开页面，稳态）\n",
    `窗口：base ${b1.windowSec} 秒（余额刷新 ${b1.steady.balanceRounds} 轮、结账轮询 ${b1.steady.reconRounds.length} 轮），head ${b2.windowSec} 秒（${b2.steady.balanceRounds} 轮、${b2.steady.reconRounds.length} 轮）。「每轮」是稳态窗口减去余额刷新后按结账轮询轮数平均。\n`,
    "| 指标 | 类别 | base | head | 变化 | |", "|---|---|--:|--:|--:|---|");
  const sqlPct = env("SQL_PCT", 20);
  // [名字, 类别, base, head, 超线规则]
  const rows = [
    ["每轮结账轮询 SQL 条数", "可比", r1.sql, r2.sql, (x, y) => pct(x, y) > sqlPct],
    ["每轮结账轮询 假站点请求", "可比", r1.fake, r2.fake, (x, y) => pct(x, y) > sqlPct],
    ["每轮结账轮询 binlog KB", "可比", Math.round((r1.binlog || 0) / 1024), Math.round((r2.binlog || 0) / 1024), (x, y) => pct(x, y) > sqlPct],
    ["每轮结账轮询 扫描行数", "可比", r1.rowsExamined, r2.rowsExamined, null],
    ["一轮余额刷新 SQL 条数", "可比", b1.refreshRound.sqlStatements, b2.refreshRound.sqlStatements, (x, y) => pct(x, y) > sqlPct],
    ["一轮余额刷新 假站点请求", "可比", b1.refreshRound.fakeRequests, b2.refreshRound.fakeRequests, (x, y) => pct(x, y) > sqlPct],
    ["一轮余额刷新 stations 表写入行数", "可比", b1.refreshRound.stationRowsWritten, b2.refreshRound.stationRowsWritten, (x, y) => y > x],
    ["一轮余额刷新 扫描行数", "可比", b1.refreshRound.rowsExamined, b2.refreshRound.rowsExamined, null],
    ["一轮余额刷新 binlog KB", "可比", Math.round((b1.refreshRound.binlogBytes || 0) / 1024), Math.round((b2.refreshRound.binlogBytes || 0) / 1024), null],
    ["稳态 SQL 条数/分钟", "可比", b1.steady.sqlPerMin, b2.steady.sqlPerMin, null],
    ["稳态 扫描行数/分钟", "可比", b1.steady.rowsExaminedPerMin, b2.steady.rowsExaminedPerMin, null],
    ["稳态 假站点请求/分钟", "可比", b1.steady.fakeRequestsPerMin, b2.steady.fakeRequestsPerMin, null],
    ["稳态 binlog KB/分钟", "可比", Math.round((b1.steady.binlogBytesPerMin || 0) / 1024), Math.round((b2.steady.binlogBytesPerMin || 0) / 1024), null],
    ["稳态 SQL 耗时 ms/分钟", "参考", b1.steady.sqlMsPerMin, b2.steady.sqlMsPerMin, null],
    ["一轮余额刷新 ms", "参考", b1.refreshRound.ms, b2.refreshRound.ms, null],
    ["服务 CPU 平均 %", "参考", b1.steady.proc.cpuAvg, b2.steady.proc.cpuAvg, null],
    ["服务内存最高 MB", "参考", b1.steady.proc.rssMbMax, b2.steady.proc.rssMbMax, null],
  ];
  for (const [name, kind, x, y, rule] of rows) {
    const mark = rule && x != null && y != null ? flag(rule(x, y)) : "";
    out.push(`| ${name} | ${kind} | ${x ?? "?"} | ${y ?? "?"} | ${x != null && y != null ? pct(x, y) + "%" : ""} | ${mark} |`);
  }
  // 假站点按路由（稳态窗口总数，按结账轮询轮数折成每轮）：只列两边不一样的路由
  const per = (bg, route) => (bg.steady.fakeByRoute[route] || 0) / Math.max(1, bg.steady.reconRounds.length);
  const routes = [...new Set([...Object.keys(b1.steady.fakeByRoute), ...Object.keys(b2.steady.fakeByRoute)])].sort();
  const changed = routes.filter((k) => Math.round(per(b1, k)) !== Math.round(per(b2, k)));
  out.push("", "假站点请求按路由（稳态窗口的总数 ÷ 结账轮询轮数，可比；只列两边不一样的）：\n");
  if (changed.length) {
    out.push("| 路由 | base 每轮 | head 每轮 | 变化 |", "|---|--:|--:|--:|");
    for (const k of changed) out.push(`| ${k} | ${Math.round(per(b1, k))} | ${Math.round(per(b2, k))} | ${signed(Math.round(per(b2, k)) - Math.round(per(b1, k)))} |`);
  } else out.push("（全部一样）");
  out.push("");
}

// ---- 整站读（算应付成本）：只列数，不判超线 ----
if (b1 && b2 && (b1.steady.ingest || b2.steady.ingest)) {
  const g1 = b1.steady.ingest, g2 = b2.steady.ingest;
  out.push("## 整站读（「算应付成本」开着时，自营站点不带筛选的 /api/log/）\n",
    `开关：base ${g1?.expectedCost ? "开" : "关"}，head ${g2?.expectedCost ? "开" : "关"}；绑定 ${g2?.bindings ?? "?"} 条。限流按 New API 默认：同一来源 180 秒 360 个请求。请求数、占比可比；落后、追平用时只做参考（随机器快慢和夹具起点变）。只列数，不判超线。开关关着时整站读应该是 0。\n`,
    "| 指标 | 类别 | base | head |", "|---|---|--:|--:|");
  for (const [name, kind, get] of INGEST_ROWS) out.push(`| ${name} | ${kind} | ${cell(ingestCell(b1, get))} | ${cell(ingestCell(b2, get))} |`);
  for (const [label, g] of [["base", g1], ["head", g2]]) if (g?.rounds?.length) out.push("", `${label} 每轮：`, ...g.rounds.map((x) => `- ${ingestRoundLine(x)}`));
  out.push("");
}

// ---- 新出现的语句 ----
const [d1, d2] = [load(baseDir, "db.json"), load(headDir, "db.json")];
if (d1 && d2) {
  const list = (db) => db.all || [...db.slowest, ...db.heaviest, ...db.growing];
  const known = new Set(list(d1).map((d) => d.digest || d.text));
  const knownText = new Set(list(d1).map((d) => d.text));
  const fresh = list(d2).filter((d) => !known.has(d.digest || d.text) && !knownText.has(d.text));
  const gone = list(d1).filter((d) => !list(d2).some((x) => (x.digest || x.text) === (d.digest || d.text) || x.text === d.text));
  const scanRows = env("SCAN_ROWS", 10000);
  const isScan = (d) => d.explain?.plan?.some((p) => p.type === "ALL" && p.rows > 1000) || d.rowsExaminedPerCall > scanRows;
  const plan = (d) => d.explain?.plan ? d.explain.plan.map((p) => `${p.table}:${p.type}/${p.key || "无索引"}/${p.rows}${p.extra ? ` ${p.extra}` : ""}`).join("<br>")
    : (d.explain?.skipped || d.explain?.error || "（没 EXPLAIN）");
  out.push("## 新出现的语句（head 有、base 没有，可比）\n",
    `测量期间（接口 + 后台）的语句种类：base ${list(d1).length}，head ${list(d2).length}；总条数 base ${d1.session.statements}，head ${d2.session.statements}。\n`);
  if (fresh.length) {
    out.push("| | 次数 | 每次扫描行 | 平均 ms（参考） | EXPLAIN（表:type/key/rows） | 语句 |", "|---|--:|--:|--:|---|---|");
    for (const d of fresh) out.push(`| ${flag(isScan(d))} | ${d.count} | ${d.rowsExaminedPerCall} | ${d.avgMs} | ${cell(plan(d))} | \`${cell(d.text.slice(0, 220))}\` |`);
  } else out.push("（没有）");
  if (gone.length) {
    out.push("", `head 里不再出现的语句：${gone.length} 种。\n`, "| 次数（base） | 语句 |", "|--:|---|");
    for (const d of gone.slice(0, 30)) out.push(`| ${d.count} | \`${cell(d.text.slice(0, 220))}\` |`);
  }
  out.push("");
}

out.push(`\n**超线 ${flags} 项**`);
console.log(out.join("\n"));
process.exitCode = flags ? 2 : 0;
