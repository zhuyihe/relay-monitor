import test from "node:test";
import assert from "node:assert/strict";
import { hasRawWindowCoverage, summarizeCoverage } from "./coverage.js";

const days = [
  { date: "2026-09-18" },
  { date: "2026-09-19" },
  { date: "2026-09-20" },
];

test("经营分析覆盖率以每个受监控资源为准，不用任一资源并集冒充完整", () => {
  const stations = [{ id: "a", name: "完整" }, { id: "b", name: "缺口" }];
  const bounds = new Map([
    ["a", { earliestDate: "2026-09-18", latestDate: "2026-09-20" }],
    ["b", { earliestDate: "2026-09-18", latestDate: "2026-09-20" }],
  ]);
  const coverage = summarizeCoverage(stations, days, [
    { stationId: "a", date: "2026-09-18" },
    { stationId: "a", date: "2026-09-19" },
    { stationId: "a", date: "2026-09-20" },
    { stationId: "b", date: "2026-09-18" },
    // b 在 19 日没有快照，不得被 a 的同日记录补成 0 成本。
    { stationId: "b", date: "2026-09-20" },
  ], bounds);

  assert.equal(coverage.isComplete, false);
  assert.equal(coverage.availableDays, 2);
  assert.deepEqual(coverage.stationGaps, [{
    stationId: "b",
    stationName: "缺口",
    archivedAt: null,
    earliestDate: "2026-09-18",
    latestDate: "2026-09-20",
    availableDays: 2,
    missingDays: 1,
    isComplete: false,
  }]);
});

test("热力图需要完整原始日期和窗口起点基线", () => {
  const stations = [{ id: "a", name: "成本资源" }];
  const rawBounds = new Map([["a", {
    earliestAt: new Date("2026-09-18T12:00:00").getTime(),
    earliestDate: "2026-09-18",
    latestDate: "2026-09-20",
  }]]);
  const rawCoverage = summarizeCoverage(stations, days, days.map(({ date }) => ({ stationId: "a", date })), rawBounds);

  assert.equal(rawCoverage.isComplete, true);
  assert.equal(hasRawWindowCoverage(rawCoverage, stations, rawBounds, new Date("2026-09-18T00:00:00").getTime()), false);
});
