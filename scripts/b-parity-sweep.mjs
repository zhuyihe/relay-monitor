// B1 全量对拍，只跑一次（不进 npm test），结果写在 PR 里：Intl 支持的全部时区、2025–2027 每一天，
// 每天取 0:00、0:30、1:00、12:00、23:30 这几个时刻，用 tests/b-parity-cases.mjs 把合并后的写法和原来那几份逐一对比。
// 允许的不同只有两类：B-T1（某天 0 点新旧算法不同的日子，结果用到了这天）和 D（用量页把日期换成时间点）；其余有不同就以 1 退出。
// 用法：node scripts/b-parity-sweep.mjs [并发数，默认 6] [结果 JSON 的路径，可选]；B_SWEEP_ZONES=逗号分隔的时区 只扫这几个。
// 计划 7c 和 tests/b-legacy.mjs 一起删。
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";

const FIRST_DAY = "2025-01-01", LAST_DAY = "2027-12-31";
const EXTRA_NAMES = ["asia/shanghai", "utc", "Etc/UTC", "GMT", "US/Eastern", "US/Pacific", "Asia/Calcutta", "Asia/Kolkata", "Asia/Saigon",
  "Europe/Kiev", "America/Buenos_Aires", "+08:00", "-03:30", "Mars/Base", " UTC", "", undefined, null, 5];

async function sweepZones(zones) {
  const { dayStartInTz, shiftDayLabel, wallTimeInTz } = await import("../lib/business-time.js");
  const { dayDiffs, dayStartDiffers, instantDiffs, timeZoneNameDiffs } = await import("../tests/b-parity-cases.mjs");
  const out = { instants: 0, days: 0, names: 0, midnightDst: [], parseDateLabel: [], allowed: {}, unexpected: [] };
  for (const tz of zones) {
    out.names += 1;
    out.unexpected.push(...timeZoneNameDiffs(tz));
    const starts = new Set();
    for (let label = FIRST_DAY; label <= LAST_DAY; label = shiftDayLabel(label, 1)) if (dayStartDiffers(tz, label)) starts.add(label);
    out.midnightDst.push(...[...starts].map((label) => `${tz} ${label}`));
    for (let label = FIRST_DAY; label <= LAST_DAY; label = shiftDayLabel(label, 1)) {
      out.days += 1;
      const start = dayStartInTz(label, tz);
      for (const ms of [start, start + 1800000, wallTimeInTz(label, 1, tz), wallTimeInTz(label, 12, tz), wallTimeInTz(label, 23, tz) + 1800000]) {
        out.instants += 1;
        out.unexpected.push(...instantDiffs(tz, ms));
      }
      for (const diff of dayDiffs(tz, label)) {
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
  const { timeZoneNameDiffs, windowPairDiffs, windowSet, rateDiffs } = await import("../tests/b-parity-cases.mjs");
  const total = { instants: 0, days: 0, names: 0, midnightDst: [], parseDateLabel: [], allowed: {}, unexpected: [] };
  for (const result of results) {
    for (const key of ["instants", "days", "names"]) total[key] += result[key];
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
  const parseByZone = {};
  for (const { day, hours } of total.parseDateLabel) {
    const [tz, label] = day.split(" ");
    (parseByZone[tz] ||= []).push(`${label}(${hours > 0 ? "+" : ""}${hours}h)`);
  }
  const summary = {
    seconds: Math.round((Date.now() - startedAt) / 1000), zones: zones.length, days: total.days, instants: total.instants, timeZoneNames: total.names,
    windowPairs, rateValues: rateValues.length,
    midnightDst: total.midnightDst.sort(), allowedByFamily: total.allowed,
    parseDateLabel: { count: total.parseDateLabel.length, zones: Object.keys(parseByZone).length, byZone: parseByZone },
    unexpected: total.unexpected.length, unexpectedSamples: total.unexpected.slice(0, 20),
  };
  if (process.argv[3]) writeFileSync(process.argv[3], `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, parseDateLabel: { count: summary.parseDateLabel.count, zones: summary.parseDateLabel.zones } }, null, 2));
  process.exitCode = total.unexpected.length ? 1 : 0;
}
