// B 全量对拍，只跑一次（不进 npm test），结果写在 PR 里：Intl 支持的全部时区、2025–2027 每一天，
// 每天取 0:00、0:30、1:00、12:00、23:30 这几个时刻，用 tests/b-parity-cases.mjs 把合并后的写法和原来那几份逐一对比。
// B2 另在每天的整天窗口上比结账判定（结束满等待期前后各一刻），在一组账本行上比写不写账。
// 允许的不同只有：B-T1（某天 0 点新旧算法不同的日子，结果用到了这天）、D（用量页把日期换成时间点）、
// B-S1（仓库挑旧确认记录）、B-L1（重结内容相同）；其余有不同就以 1 退出。
// 用法：node scripts/b-parity-sweep.mjs [并发数，默认 6] [结果 JSON 的路径，可选]；B_SWEEP_ZONES=逗号分隔的时区 只扫这几个；
// B_SWEEP_PART=b2 只扫 B2 那几项（B1 那几项 B2 没碰，B1 的 PR 里扫过）。
// 计划 7c 和 tests/b-legacy.mjs 一起删。
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";

const FIRST_DAY = "2025-01-01", LAST_DAY = "2027-12-31";
const EXTRA_NAMES = ["asia/shanghai", "utc", "Etc/UTC", "GMT", "US/Eastern", "US/Pacific", "Asia/Calcutta", "Asia/Kolkata", "Asia/Saigon",
  "Europe/Kiev", "America/Buenos_Aires", "+08:00", "-03:30", "Mars/Base", " UTC", "", undefined, null, 5];

const ONLY_B2 = process.env.B_SWEEP_PART === "b2";

async function sweepZones(zones) {
  const { dayStartInTz, shiftDayLabel, wallTimeInTz } = await import("../lib/business-time.js");
  const { dayDiffs, dayStartDiffers, instantDiffs, settlementDiffs, timeZoneNameDiffs } = await import("../tests/b-parity-cases.mjs");
  const out = { instants: 0, days: 0, names: 0, settlementChecks: 0, midnightDst: [], parseDateLabel: [], allowed: {}, unexpected: [] };
  for (const tz of zones) {
    const starts = new Set();
    if (!ONLY_B2) {
      out.names += 1;
      out.unexpected.push(...timeZoneNameDiffs(tz));
      for (let label = FIRST_DAY; label <= LAST_DAY; label = shiftDayLabel(label, 1)) if (dayStartDiffers(tz, label)) starts.add(label);
      out.midnightDst.push(...[...starts].map((label) => `${tz} ${label}`));
    }
    for (let label = FIRST_DAY; label <= LAST_DAY; label = shiftDayLabel(label, 1)) {
      out.days += 1;
      const start = dayStartInTz(label, tz);
      if (!ONLY_B2) {
        for (const ms of [start, start + 1800000, wallTimeInTz(label, 1, tz), wallTimeInTz(label, 12, tz), wallTimeInTz(label, 23, tz) + 1800000]) {
          out.instants += 1;
          out.unexpected.push(...instantDiffs(tz, ms));
        }
      }
      // B2：这天的整天窗口，结束满等待期前一刻、正好满；旧记录生成在这两刻
      const window = { startMs: start, endMs: dayStartInTz(shiftDayLabel(label, 1), tz), timezone: tz };
      const edges = [window.endMs + 15 * 60000 - 1, window.endMs + 15 * 60000];
      const rules = [{ billingPolicy: "immediate", createdAt: new Date(start - 86400000).toISOString() }];
      for (const now of edges) {
        out.settlementChecks += 1;
        for (const diff of settlementDiffs({ window, now, rules, generatedAts: edges.map((at) => new Date(at).toISOString()) })) {
          if (diff.family === "B-S1") out.allowed["B-S1"] = (out.allowed["B-S1"] || 0) + 1;
          else out.unexpected.push(diff);
        }
      }
      for (const diff of ONLY_B2 ? [] : dayDiffs(tz, label)) {
        if (diff.family === "parseDateLabel") { out.parseDateLabel.push({ day: `${tz} ${label}`, hours: (diff.before - diff.now) / 3600000 }); continue; }
        if (diff.involved.some((day) => starts.has(day))) out.allowed[diff.family] = (out.allowed[diff.family] || 0) + 1;
        else out.unexpected.push(diff);
      }
    }
  }
  return out;
}

if (!isMainThread) {
  parentPort.postMessage(await sweepZones(workerData.zones));
} else {
  const concurrency = Number(process.argv[2]) || Math.min(6, availableParallelism());
  const zones = process.env.B_SWEEP_ZONES ? process.env.B_SWEEP_ZONES.split(",") : Intl.supportedValuesOf("timeZone");
  const chunks = Array.from({ length: concurrency }, (_, index) => zones.filter((_, i) => i % concurrency === index));
  const startedAt = Date.now();
  const results = await Promise.all(chunks.map((chunk) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { zones: chunk } });
    worker.once("message", (result) => { resolve(result); worker.terminate(); });
    worker.once("error", reject);
  })));
  const { timeZoneNameDiffs, windowPairDiffs, windowSet, rateDiffs, ledgerDiffs, decimalDiffs } = await import("../tests/b-parity-cases.mjs");
  const { ledgerInsertValues, RECONCILIATION_LEDGER_COLUMNS } = await import("../lib/reconciliation-ledger.js");
  const total = { instants: 0, days: 0, names: 0, settlementChecks: 0, midnightDst: [], parseDateLabel: [], allowed: {}, unexpected: [] };
  for (const result of results) {
    for (const key of ["instants", "days", "names", "settlementChecks"]) total[key] += result[key];
    total.midnightDst.push(...result.midnightDst);
    total.parseDateLabel.push(...result.parseDateLabel);
    for (const [family, count] of Object.entries(result.allowed)) total.allowed[family] = (total.allowed[family] || 0) + count;
    total.unexpected.push(...result.unexpected);
  }
  for (const name of EXTRA_NAMES) { total.names += 1; total.unexpected.push(...timeZoneNameDiffs(name)); }
  const windows = [...windowSet({ timezones: ["Asia/Shanghai", "asia/shanghai", "UTC", "Asia/Calcutta", "Asia/Kolkata", undefined] }), null, undefined];
  let windowPairs = 0;
  for (const a of windows) for (const b of windows) { windowPairs += 1; total.unexpected.push(...windowPairDiffs(a, b)); }
  const rateValues = [null, undefined, "", 0, -1, "0", "7.2", 7.2, "7.200000", "abc", 0.5, 0.000001, 1e-9, Infinity, "Infinity"];
  total.unexpected.push(...rateDiffs(rateValues));
  // B2 账本：最新一版 × 这次的账 × 是不是重结。金额、汇率各取几个值（含舍入以后相同的），全组合
  const start = Date.UTC(2026, 9, 8, 16), entryOf = (fields) => ({ ruleId: "rr_1", billDate: "2026-10-09", versionId: null, timezone: "Asia/Shanghai",
    startMs: start, endMs: start + 86400000, revenueUsd: 2.25, costUsd: 1, revenueRate: null, costRate: null, costBasis: "usage", source: "settle",
    detail: null, settledAt: "2026-10-09T16:20:00.000Z", ...fields });
  const rowOf = (entry, revision) => {
    const values = ledgerInsertValues({ ...entry, revision });
    const row = Object.fromEntries(RECONCILIATION_LEDGER_COLUMNS.map((column, index) => [column, values[index]]));
    for (const [column, scale] of [["revenue_usd", 8], ["cost_usd", 8], ["revenue_rate", 6], ["cost_rate", 6]]) row[column] = row[column] == null ? null : Number(row[column]).toFixed(scale);
    return row;
  };
  const amounts = [0, 1, 1.000000004, 1.00000001, 2.25], rates = [null, 7.2, 7.2000004, 7.21], bases = ["usage", "fixed", null];
  const windowsOf = [{}, { timezone: "Etc/UTC" }, { startMs: start + 1, endMs: start + 86400000 + 1 }];
  const contents = [];
  for (const revenueUsd of amounts) for (const costUsd of [...amounts, null]) for (const revenueRate of rates) for (const costRate of [null, 7.2]) for (const costBasis of bases)
    contents.push({ revenueUsd, costUsd, revenueRate, costRate, costBasis });
  let ledgerPairs = 0;
  const latestRows = [null, ...contents.filter((_, index) => index % 7 === 0).map((fields, index) => rowOf(entryOf(fields), index + 1))];
  for (const row of latestRows) {
    for (const fields of contents) {
      for (const win of windowsOf) {
        for (const resettle of [false, true]) {
          ledgerPairs += 1;
          for (const diff of ledgerDiffs(row, entryOf({ ...fields, ...win }), resettle)) {
            if (diff.family === "B-L1") total.allowed["B-L1"] = (total.allowed["B-L1"] || 0) + 1;
            else total.unexpected.push(diff);
          }
        }
      }
    }
  }
  // 内存仓库模拟 DECIMAL：一组随机值，记下和原来 toFixed 不同的个数（只该出现在舍入中点上）
  const decimalValues = Array.from({ length: 200000 }, (_, index) => Math.round(Math.sin(index + 1) * 1e12) / 10 ** (6 + (index % 6)));
  const decimalChanged = decimalDiffs(decimalValues);
  const parseByZone = {};
  for (const { day, hours } of total.parseDateLabel) {
    const [tz, label] = day.split(" ");
    (parseByZone[tz] ||= []).push(`${label}(${hours > 0 ? "+" : ""}${hours}h)`);
  }
  const summary = {
    seconds: Math.round((Date.now() - startedAt) / 1000), zones: zones.length, days: total.days, instants: total.instants, timeZoneNames: total.names,
    windowPairs, rateValues: rateValues.length, settlementChecks: total.settlementChecks, ledgerPairs,
    memoryDecimal: { values: decimalValues.length, changed: decimalChanged.length, samples: decimalChanged.slice(0, 5) },
    midnightDst: total.midnightDst.sort(), allowedByFamily: total.allowed,
    parseDateLabel: { count: total.parseDateLabel.length, zones: Object.keys(parseByZone).length, byZone: parseByZone },
    unexpected: total.unexpected.length, unexpectedSamples: total.unexpected.slice(0, 20),
  };
  if (process.argv[3]) writeFileSync(process.argv[3], `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, parseDateLabel: { count: summary.parseDateLabel.count, zones: summary.parseDateLabel.zones } }, null, 2));
  process.exitCode = total.unexpected.length ? 1 : 0;
}
