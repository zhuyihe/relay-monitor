// 把一次测量（<结果目录>/*.json）写成 markdown 表格，打到标准输出。
// 用法：node measure/summarize.mjs <结果目录>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { perRound } from "../lib/metrics.mjs";

const dir = process.argv[2];
const load = (name) => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null;
const api = load("api.json"), bg = load("background.json"), pages = load("pages.json"), bundle = load("bundle.json"), db = load("db.json");
const kb = (b) => (b / 1024).toFixed(b < 10240 ? 1 : 0);
const out = [];
const commit = existsSync(join(dir, "commit.txt")) ? readFileSync(join(dir, "commit.txt"), "utf8").trim() : "?";
out.push(`# 性能测量 ${dir.split("/").pop()}（提交 ${commit.slice(0, 7)}）\n`);

if (api) {
  out.push(`## 接口（冷 = 服务预热后第一次；p50/p95 = 接着 ${api.n} 次）\n`);
  out.push("| 接口 | 冷 ms | p50 ms | p95 ms | 返回体 KB | 状态 |", "|---|--:|--:|--:|--:|--:|");
  for (const r of api.results) out.push(`| ${r.name} \`${r.method} ${r.path.replace(/\|/g, "%7C").slice(0, 90)}\` | ${r.coldMs} | ${r.p50} | ${r.p95} | ${kb(r.bytes)} | ${r.status} |`);
  out.push("");
}
if (bg) {
  const s = bg.steady, r = bg.refreshRound;
  out.push("## 后台（没开页面，稳态）\n");
  out.push("| 指标 | 数值 |", "|---|--:|");
  out.push(`| 窗口 | ${bg.windowSec} 秒（余额刷新 ${s.balanceRounds} 轮、结账轮询 ${s.reconRounds.length} 轮） |`);
  out.push(`| 对假站点请求 / 分钟 | ${s.fakeRequestsPerMin} |`);
  out.push(`| SQL 条数 / 分钟 | ${s.sqlPerMin} |`);
  out.push(`| SQL 耗时 / 分钟 | ${s.sqlMsPerMin} ms |`);
  out.push(`| 扫描行数 / 分钟 | ${s.rowsExaminedPerMin} |`);
  out.push(`| binlog 写入 / 分钟 | ${s.binlogBytesPerMin == null ? "?" : kb(s.binlogBytesPerMin) + " KB"} |`);
  out.push(`| 服务进程 CPU 平均 / 最高 | ${s.proc.cpuAvg}% / ${s.proc.cpuMax}% |`);
  out.push(`| 服务进程内存最高 | ${s.proc.rssMbMax} MB |`);
  out.push(`| 一轮余额刷新（POST /api/refresh） | ${r.ms} ms，假站点请求 ${r.fakeRequests}，SQL ${r.sqlStatements} 条（${r.sqlMs} ms；存站点 ${r.stationSaves ?? "?"} 次，stations 表改动行 ${r.stationRowsWritten ?? "?"}），binlog ${r.binlogBytes == null ? "?" : kb(r.binlogBytes) + " KB"} |`);
  for (const x of s.reconRounds) out.push(`| 一轮结账轮询（${x.startAt.slice(11, 19)}） | 首末请求相隔 ${x.spanMs} ms，假站点请求 ${x.requests}（渠道账单 ${x.channelStats}） |`);
  const pr = perRound(bg);
  if (pr) out.push(`| 折算：每轮结账轮询 | SQL ≈ ${pr.sql} 条，扫描行 ≈ ${pr.rowsExamined ?? "?"}，假站点请求 ≈ ${pr.fake}，binlog ≈ ${kb(pr.binlog)} KB（稳态窗口减去 ${s.balanceRounds} 轮余额刷新后按 ${s.reconRounds.length} 轮平均） |`,
    `| 折算：两个循环各跑一轮（≈ 每分钟） | SQL ≈ ${pr.sql + r.sqlStatements} 条，binlog ≈ ${kb(pr.binlog + (r.binlogBytes || 0))} KB |`);
  out.push("", "稳态 SQL 按语句类型和表：\n", "| 语句 | 条数 | 耗时 ms | 扫描行 | 改动行 |", "|---|--:|--:|--:|--:|");
  for (const [k, v] of Object.entries(s.byTable).sort((a, b) => b[1].count - a[1].count).slice(0, 15)) out.push(`| ${k} | ${v.count} | ${Math.round(v.totalMs)} | ${v.rowsExamined} | ${v.rowsAffected} |`);
  out.push("", "稳态对假站点的请求（按路由，窗口内总数）：\n", "| 路由 | 次数 |", "|---|--:|");
  for (const [k, v] of Object.entries(s.fakeByRoute).sort((a, b) => b[1] - a[1])) out.push(`| ${k} | ${v} |`);
  out.push("");
}
if (pages) {
  out.push(`## 页面（1440×900，冷缓存，${pages.runs} 次中位数；停留 = 假时钟拨 ${pages.dwellMs / 1000} 秒）\n`);
  out.push("| 页面 | 首屏 ms | /api 请求 | 传输 KB | 其中 JS KB | 其中 API KB | 停留期间 /api 请求 |", "|---|--:|--:|--:|--:|--:|--:|");
  for (const p of pages.results) out.push(`| ${p.path} | ${p.readyMs}${p.readyTimeouts ? `（${p.readyTimeouts} 次超时）` : ""} | ${p.apiRequests} | ${p.transferKb} | ${p.jsKb} | ${p.apiKb} | ${p.dwellApiRequests} |`);
  out.push("");
}
if (bundle) {
  out.push("## 打包体积（首次打开要下载的 JS = 根 + 布局 + 页面入口）\n");
  out.push("| 页面 | JS 文件数 | 原始 KB | gzip KB | 页面独有 gzip KB |", "|---|--:|--:|--:|--:|");
  for (const p of bundle.pages) out.push(`| ${p.route} | ${p.files} | ${p.rawKb} | ${p.gzKb} | ${p.pageOnlyGzKb} |`);
  out.push("", `全部 JS 块：${bundle.allChunks.count} 个，原始 ${bundle.allChunks.rawKb} KB，gzip ${bundle.allChunks.gzKb} KB。最大的 10 个：\n`);
  out.push("| 块 | 原始 KB | gzip KB |", "|---|--:|--:|");
  for (const c of bundle.topChunks) out.push(`| ${c.file} | ${c.rawKb} | ${c.gzKb} |`);
  out.push("");
}
if (db) {
  out.push("## 数据库\n", "| 表 | 行数 | 数据 MB | 索引 MB |", "|---|--:|--:|--:|");
  for (const t of db.tables) out.push(`| ${t.table} | ${t.rows} | ${t.dataMb} | ${t.indexMb} |`);
  out.push("", `这次测量期间：${db.session.statements} 条语句，${db.session.digests} 种，共 ${db.session.totalMs} ms。`, "");
  const plan = (d) => d.explain?.plan ? d.explain.plan.map((p) => `${p.table}:${p.type}/${p.key || "无索引"}/${p.rows}`).join("<br>") : (d.explain?.skipped || d.explain?.error || "");
  out.push("最慢的 10 种语句（按平均耗时）：\n", "| 平均 ms | 最慢 ms | 次数 | 每次扫描行 | EXPLAIN（表:type/key/rows） | 语句 |", "|--:|--:|--:|--:|---|---|");
  for (const d of db.slowest) out.push(`| ${d.avgMs} | ${d.maxMs} | ${d.count} | ${d.rowsExaminedPerCall} | ${plan(d)} | \`${d.text.slice(0, 160).replace(/\|/g, "\\|")}\` |`);
  out.push("", "碰到会增长的表的查询：\n", "| 平均 ms | 次数 | 每次扫描行 | EXPLAIN | 语句 |", "|--:|--:|--:|---|---|");
  for (const d of db.growing) out.push(`| ${d.avgMs} | ${d.count} | ${d.rowsExaminedPerCall} | ${plan(d)} | \`${d.text.slice(0, 160).replace(/\|/g, "\\|")}\` |`);
  out.push("");
}
console.log(out.join("\n"));
