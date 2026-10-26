// 对拍（结账）：同一个夹具上让 base 和 head 各把最近 N 天结一遍，比两边写进账本的内容。
// 分几步，由 run.sh 在中间起停服务：
//   node parity.mjs move [天数]     把账本里最近 N 天（默认 PARITY_DAYS 或 14，不含今天）全部绑定的行挪进备份表 perf_parity_backup；
//                                   日子按业务时区（Asia/Shanghai）算好记在 $PERF_OUT/parity/window.json，后面几步都用这一份
//   node parity.mjs settle <标签>   服务在跑：每天一次 POST /api/reconciliation/query {preset:"custom", startMs, endMs, observe:true}
//                                   （和 seed/04 一样），再把这 N 天的账本导出到 $PERF_OUT/parity/<标签>.json
//   node parity.mjs reset           删掉这 N 天账本里的行（回到刚挪走时的样子，下一个版本从同一个起点结）
//   node parity.mjs restore         这 N 天先删掉再从备份表插回去，删掉备份表（夹具恢复成挪走前的样子）
//   node parity.mjs diff <a> <b>    逐行逐字段比较两份导出（不连库），写 $PERF_OUT/parity/parity.md；有不同退出码 1
// 导出时去掉每次都不一样的：settled_at、version_id 两列，detail 里的生成时刻、来源（manual/poll）等（VOLATILE_KEYS）。
// head 启动时 ensureSchema 可能加列：比较时只比两边都有的字段。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { login, progress, OUT_DIR } from "./lib/env.mjs";
import { connect } from "./lib/ps.mjs";
import { TZ, dayStartSec, dateKeyOf, BASE } from "./lib/model.mjs";

const DIR = join(OUT_DIR, "parity");
const WINDOW_FILE = join(DIR, "window.json");
const BACKUP = "perf_parity_backup";
// 每次结账都会变、和账算得对不对无关的列和 detail 里的键
const VOLATILE_COLUMNS = ["settled_at", "version_id"];
// （渠道的 stateObservedAt、倍率的 ratioObservedAt 这类「什么时候读到的」键，名字以 ObservedAt 结尾的一律不比）
// trigger：这天是轮询回看（late）结的还是 parity 手动（manual）结的，只看谁抢先，和钱无关（审核 R2 第二轮、#123 perf 的 15 处假差）
const VOLATILE_KEYS = new Set(["generatedAt", "resultGeneratedAt", "origin", "observedAt", "checkedAt", "fetchedAt", "trigger",
  ...(process.env.PARITY_IGNORE_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean)]);
const isVolatileKey = (key) => VOLATILE_KEYS.has(key) || /ObservedAt$/.test(key);
const [cmd, ...args] = process.argv.slice(2);
mkdirSync(DIR, { recursive: true });

function loadWindow() {
  if (!existsSync(WINDOW_FILE)) throw new Error(`没有 ${WINDOW_FILE}，先跑 parity.mjs move`);
  return JSON.parse(readFileSync(WINDOW_FILE, "utf8"));
}
const where = (w) => ["bill_date >= ? AND bill_date <= ?", [w.days[0], w.days.at(-1)]];
async function hasBackup(conn) {
  const [rows] = await conn.query("SHOW TABLES LIKE ?", [BACKUP]);
  return rows.length > 0;
}

async function restore(conn, w) {
  if (!(await hasBackup(conn))) return false;
  // 只插备份表里有的列（head 的 ensureSchema 给账本加了列也插得回去，新列用默认值）
  const [cols] = await conn.query("SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", [BACKUP]);
  const list = cols.map((r) => `\`${r.c}\``).join(", ");
  const [sql, params] = where(w);
  await conn.beginTransaction();
  await conn.query(`DELETE FROM reconciliation_ledger WHERE ${sql}`, params);
  const [ins] = await conn.query(`INSERT INTO reconciliation_ledger (${list}) SELECT ${list} FROM ${BACKUP}`);
  await conn.commit();
  await conn.query(`DROP TABLE ${BACKUP}`);
  progress(`对拍：账本 ${w.days[0]}…${w.days.at(-1)} 已恢复（插回 ${ins.affectedRows} 行）`);
  return true;
}

// detail 去掉每次都会变的键；对象键排序，导出稳定
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) if (!isVolatileKey(key)) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

async function exportLedger(conn, w) {
  const [sql, params] = where(w);
  const [rows] = await conn.query(`SELECT *, DATE_FORMAT(bill_date, '%Y-%m-%d') AS bill_date FROM reconciliation_ledger WHERE ${sql} ORDER BY rule_id, bill_date, revision`, params);
  return rows.map((row) => {
    const out = {};
    for (const key of Object.keys(row).sort()) {
      if (VOLATILE_COLUMNS.includes(key)) continue;
      let v = row[key];
      if (key === "detail" && v != null) v = normalize(typeof v === "string" ? JSON.parse(v) : v);
      else if (v instanceof Date) v = v.toISOString();
      else if (typeof v === "bigint") v = String(v);
      out[key] = v;
    }
    return out;
  });
}

// 两个 JSON 值不同的叶子路径
function leafDiffs(a, b, path = "", out = []) {
  if (out.length >= 20) return out;
  const isObj = (x) => x && typeof x === "object";
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) leafDiffs(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, a, b });
  return out;
}

const conn = cmd === "diff" ? null : await connect();
try {
  if (cmd === "move") {
    const n = Number(args[0] || process.env.PARITY_DAYS || 14);
    // 上次没恢复成（备份表还在）就先恢复，绝不覆盖备份
    if (await hasBackup(conn)) await restore(conn, loadWindow());
    const todayKey = dateKeyOf(Math.floor(Date.now() / 1000), TZ);
    const keyOf = (offset) => new Date(Date.parse(todayKey + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
    const days = Array.from({ length: n }, (_, i) => keyOf(i - n));
    const w = { tz: TZ, days, movedAt: new Date().toISOString() };
    const [sql, params] = where(w);
    await conn.query(`CREATE TABLE ${BACKUP} AS SELECT * FROM reconciliation_ledger WHERE ${sql}`, params);
    const [del] = await conn.query(`DELETE FROM reconciliation_ledger WHERE ${sql}`, params);
    w.moved = del.affectedRows;
    writeFileSync(WINDOW_FILE, JSON.stringify(w, null, 2));
    progress(`对拍：账本 ${days[0]}…${days.at(-1)}（${n} 天）挪走 ${del.affectedRows} 行到 ${BACKUP}`);
  } else if (cmd === "settle") {
    const label = args[0];
    if (!label) throw new Error("用法：parity.mjs settle <标签>");
    const w = loadWindow();
    const api = await login();
    await fetch(`${BASE}/__ctl?delay=5`);
    const t0 = Date.now();
    const perDay = [];
    try {
      for (const day of w.days) {
        const next = new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
        const startMs = dayStartSec(day, w.tz) * 1000, endMs = dayStartSec(next, w.tz) * 1000;
        const t1 = Date.now();
        const res = await api("/api/reconciliation/query", { method: "POST", body: { preset: "custom", startMs, endMs, observe: true } });
        const results = res.results || [];
        const settled = results.filter((row) => row.calculation?.profitUsd != null).length;
        perDay.push({ day, rules: results.length, settled, ms: Date.now() - t1 });
      }
    } finally { await fetch(`${BASE}/__ctl?delay=50`).catch(() => {}); }
    const rows = await exportLedger(conn, w);
    writeFileSync(join(DIR, `${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), window: w, perDay, rows }, null, 1));
    const totalMs = Date.now() - t0;
    progress(`对拍：${label} 结了 ${w.days.length} 天（每天 ${perDay.map((d) => `${d.settled}/${d.rules}`).join(" ")}），${Math.round(totalMs / 1000)} 秒，账本 ${rows.length} 行`);
  } else if (cmd === "reset") {
    const w = loadWindow();
    const [sql, params] = where(w);
    const [del] = await conn.query(`DELETE FROM reconciliation_ledger WHERE ${sql}`, params);
    progress(`对拍：删掉这 ${w.days.length} 天账本里刚写的 ${del.affectedRows} 行`);
  } else if (cmd === "restore") {
    const done = await restore(conn, existsSync(WINDOW_FILE) ? loadWindow() : { days: ["0000-01-01", "0000-01-01"] });
    if (!done) progress("对拍：没有备份表，不用恢复");
  } else if (cmd === "diff") {
    const [la, lb] = args;
    // 导出时已经去过一遍；这里再去一遍，改了 VOLATILE_KEYS / PARITY_IGNORE_KEYS 以后不用重结就能重比
    const read = (label) => { const x = JSON.parse(readFileSync(join(DIR, `${label}.json`), "utf8")); x.rows = x.rows.map((r) => ({ ...r, detail: normalize(r.detail) })); return x; };
    const A = read(la), B = read(lb);
    const key = (r) => `${r.rule_id} ${r.bill_date} r${r.revision}`;
    const mapA = new Map(A.rows.map((r) => [key(r), r])), mapB = new Map(B.rows.map((r) => [key(r), r]));
    const colsA = new Set(A.rows.flatMap((r) => Object.keys(r))), colsB = new Set(B.rows.flatMap((r) => Object.keys(r)));
    const common = [...colsA].filter((c) => colsB.has(c)).sort();
    const onlyA = [...colsA].filter((c) => !colsB.has(c)), onlyB = [...colsB].filter((c) => !colsA.has(c));
    const missing = [...mapA.keys()].filter((k) => !mapB.has(k)), extra = [...mapB.keys()].filter((k) => !mapA.has(k));
    const changed = [];
    for (const [k, ra] of mapA) {
      const rb = mapB.get(k);
      if (!rb) continue;
      const fields = [];
      for (const c of common) {
        if (JSON.stringify(ra[c]) === JSON.stringify(rb[c])) continue;
        fields.push(c === "detail" ? { field: c, paths: leafDiffs(ra[c], rb[c]) } : { field: c, a: ra[c], b: rb[c] });
      }
      if (fields.length) changed.push({ key: k, fields });
    }
    const differences = missing.length + extra.length + changed.length;
    const show = (v) => `\`${JSON.stringify(v)?.slice(0, 120)}\``;
    const md = [`# 对拍（结账）：${la} 对 ${lb}\n`,
      `- 日子：${A.window.days[0]} … ${A.window.days.at(-1)}（${A.window.days.length} 天，${A.window.tz}），挪走再重结的账本行：${A.window.moved ?? "?"}`,
      `- 账本行数：${la} ${A.rows.length}，${lb} ${B.rows.length}`,
      `- 结出毛利的绑定（每天）：${la} ${A.perDay.map((d) => d.settled).join(" ")}；${lb} ${B.perDay.map((d) => d.settled).join(" ")}`,
      `- 比的字段（两边都有的）：${common.join("、")}；不比：${VOLATILE_COLUMNS.join("、")}，detail 里的 ${[...VOLATILE_KEYS].join("、")} 和以 ObservedAt 结尾的键`,
      ...(onlyA.length || onlyB.length ? [`- 只有一边有的字段（不比）：${la} ${onlyA.join("、") || "无"}；${lb} ${onlyB.join("、") || "无"}`] : []),
      `- 结账用时：${la} ${Math.round(A.perDay.reduce((s, d) => s + d.ms, 0) / 1000)} 秒，${lb} ${Math.round(B.perDay.reduce((s, d) => s + d.ms, 0) / 1000)} 秒（参考）`,
      "", `**${differences ? `${differences} 处不同` : "0 处不同"}**`, ""];
    if (missing.length) md.push(`## ${lb} 少了的行（${missing.length}）\n`, ...missing.slice(0, 50).map((k) => `- ${k}`), "");
    if (extra.length) md.push(`## ${lb} 多出的行（${extra.length}）\n`, ...extra.slice(0, 50).map((k) => `- ${k}`), "");
    if (changed.length) {
      md.push(`## 内容不同的行（${changed.length}）\n`, `| 行（rule_id 日子 版本） | 字段 | ${la} | ${lb} |`, "|---|---|---|---|");
      for (const c of changed.slice(0, 100)) for (const f of c.fields) {
        if (f.paths) for (const p of f.paths) md.push(`| ${c.key} | detail.${p.path} | ${show(p.a)} | ${show(p.b)} |`);
        else md.push(`| ${c.key} | ${f.field} | ${show(f.a)} | ${show(f.b)} |`);
      }
      md.push("");
    }
    writeFileSync(join(DIR, "parity.md"), md.join("\n"));
    writeFileSync(join(DIR, "parity-result.json"), JSON.stringify({ differences, missing: missing.length, extra: extra.length, changed: changed.length, rows: [A.rows.length, B.rows.length] }));
    console.log(md.join("\n"));
    if (differences) process.exitCode = 1;
  } else {
    console.error("用法：node parity.mjs move [天数] | settle <标签> | reset | restore | diff <标签a> <标签b>");
    process.exitCode = 1;
  }
} finally {
  await conn?.end();
}
