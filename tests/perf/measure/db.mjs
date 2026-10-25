// 数据库测量：
//   node measure/db.mjs snap <结果目录>    测量开始前存一份语句摘要快照
//   node measure/db.mjs report <结果目录>  测量结束：表行数和大小、这次测量期间所有语句（按摘要）的条数/耗时/扫描行数，
//                                          最慢的语句和碰到会增长的表的语句逐条 EXPLAIN（type、key、rows）
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { connect, digestSnapshot, digestDiff, tableOf, kindOf } from "../lib/ps.mjs";

const [mode, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const conn = await connect();
if (mode === "snap") {
  const snap = await digestSnapshot(conn);
  writeFileSync(`${outDir}/digest-start.json`, JSON.stringify([...snap.entries()]));
  await conn.end();
  process.exit(0);
}

// 先取结束快照，再跑下面统计表大小的查询（不然这些 COUNT(*) 会混进「测量期间的语句」）
const start = new Map(JSON.parse(readFileSync(`${outDir}/digest-start.json`, "utf8")));
const end = await digestSnapshot(conn);
const GROWING = ["history_points", "station_daily_usage", "reconciliation_snapshots", "reconciliation_ledger", "reconciliation_alert_state", "channel_monitor_links"];
const [tables] = await conn.query(`SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY DATA_LENGTH + INDEX_LENGTH DESC`);
const tableStats = [];
for (const t of tables) {
  const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t.TABLE_NAME}\``);
  tableStats.push({ table: t.TABLE_NAME, rows: Number(n), dataMb: Math.round(Number(t.DATA_LENGTH) / 1048576 * 10) / 10, indexMb: Math.round(Number(t.INDEX_LENGTH) / 1048576 * 10) / 10 });
}
const [[docSize]] = await conn.query("SELECT COUNT(*) n, ROUND(AVG(LENGTH(doc))) avgBytes, SUM(LENGTH(doc)) totalBytes FROM stations");
const [[ledgerInfo]] = await conn.query("SELECT COUNT(*) n, COUNT(DISTINCT rule_id, bill_date) days, MAX(revision) maxRev, ROUND(AVG(LENGTH(detail))) avgDetailBytes FROM reconciliation_ledger");
const [[snapInfo]] = await conn.query("SELECT COUNT(*) n, ROUND(AVG(LENGTH(source))) avgSourceBytes, SUM(window_kind='today') today, SUM(window_kind='custom') custom, SUM(window_kind='yesterday') yesterday FROM reconciliation_snapshots");

const session = digestDiff(start, end).filter((d) => !/performance_schema|information_schema|EXPLAIN|SHOW /i.test(d.text));

async function explain(sample) {
  if (!sample || sample.length >= 1020 || !/^\s*(SELECT|UPDATE|DELETE|INSERT\s+INTO\s+\w+\s*\(?[^)]*\)?\s*SELECT)/i.test(sample)) return { skipped: sample?.length >= 1020 ? "语句被截断" : "不是查询" };
  try {
    const [rows] = await conn.query(`EXPLAIN ${sample}`);
    return { plan: rows.map((r) => ({ table: r.table, type: r.type, key: r.key, rows: Number(r.rows), filtered: Number(r.filtered), extra: r.Extra })) };
  } catch (err) { return { error: err.message.slice(0, 160) }; }
}

const slowest = [...session].map((d) => ({ ...d, avgMs: d.totalMs / d.count })).sort((a, b) => b.avgMs - a.avgMs).slice(0, 10);
const heaviest = [...session].sort((a, b) => b.totalMs - a.totalMs).slice(0, 10);
const growing = session.filter((d) => GROWING.some((t) => d.text?.includes(`\`${t}\``)) && /^\s*(SELECT|UPDATE|DELETE)/i.test(d.text));
// 所有查询语句都 EXPLAIN 一遍（几百种，很快）：和另一次测量比「新出现的语句」时，新语句的计划都在手边
const explained = new Map();
for (const d of [...slowest, ...heaviest, ...growing, ...session]) if (!explained.has(d.digest) && /^\s*(SELECT|UPDATE|DELETE)/i.test(d.text || "")) explained.set(d.digest, await explain(d.sample));
const fmt = (d) => ({ digest: d.digest, text: d.text.slice(0, 400), sample: (d.sample || "").slice(0, 300), count: d.count, avgMs: Math.round(d.totalMs / d.count * 100) / 100,
  totalMs: Math.round(d.totalMs), maxMs: Math.round(d.maxMs), rowsExaminedPerCall: Math.round(d.rowsExamined / d.count), rowsSentPerCall: Math.round(d.rowsSent / d.count),
  noIndex: d.noIndex, kind: kindOf(d.text), table: tableOf(d.text), explain: explained.get(d.digest) || null });

const result = { at: new Date().toISOString(), tables: tableStats, stationsDoc: docSize, ledger: ledgerInfo, snapshots: snapInfo,
  session: { statements: session.reduce((a, d) => a + d.count, 0), totalMs: Math.round(session.reduce((a, d) => a + d.totalMs, 0)), digests: session.length },
  slowest: slowest.map(fmt), heaviest: heaviest.map(fmt), growing: growing.map(fmt),
  // 这次测量期间出现过的每一种语句（按摘要），compare.mjs 用它找「新出现的语句」
  all: session.map(fmt) };
writeFileSync(`${outDir}/db.json`, JSON.stringify(result, null, 2));
console.table(tableStats);
for (const d of result.slowest) console.log(d.avgMs, "ms", d.count, "次", d.explain?.plan?.map((p) => `${p.table}:${p.type}:${p.key}:${p.rows}`).join(" "), d.text.slice(0, 120));
await conn.end();
