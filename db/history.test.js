import test from "node:test";
import assert from "node:assert/strict";
import { History, dailyUsageRows } from "./history.js";

test("日汇总按后一快照归日，充值不计作消耗", () => {
  const start = new Date(2026, 0, 2).getTime();
  const end = start + 86400000;
  const rows = dailyUsageRows([
    { station_id: "a", t: start - 3600000, remaining: 10 },
    { station_id: "a", t: start + 3600000, remaining: 8 },
    { station_id: "a", t: start + 7200000, remaining: 9 },
    { station_id: "a", t: start + 10800000, remaining: 7 },
  ], start, end);

  assert.deepEqual(rows, [{ stationId: "a", date: "2026-01-02", usd: 4 }]);
});

test("日汇总保留零消耗日期，保证长期分析覆盖期诚实", () => {
  const start = new Date(2026, 0, 2).getTime();
  const end = start + 86400000;
  const rows = dailyUsageRows([
    { station_id: "a", t: start - 1000, remaining: 10 },
    { station_id: "a", t: start + 1000, remaining: 10 },
  ], start, end);

  assert.deepEqual(rows, [{ stationId: "a", date: "2026-01-02", usd: 0 }]);
});

test("永久留存完全跳过原始快照清理", async () => {
  const history = new History({ query: async () => assert.fail("永久留存不应查询删除") }, () => null);
  assert.deepEqual(await history.runScheduledCleanup(), { skipped: "permanent" });
});

test("切回永久留存会停止独立的每日清理定时器", () => {
  const history = new History({ query: async () => [[]] }, () => null);
  history._cleanupTimer = setTimeout(() => assert.fail("应已取消历史清理定时器"), 60000);
  history.syncCleanupSchedule();
  assert.equal(history._cleanupTimer, null);
});

test("有限留存每天记录一次清理结果", async () => {
  const calls = [];
  const pool = {
    query: async (sql) => {
      calls.push(sql);
      return sql.startsWith("DELETE FROM history_points") ? [{ affectedRows: 3 }] : [[]];
    },
  };
  const history = new History(pool, () => 90);
  assert.deepEqual(await history.runScheduledCleanup(), { deletedCount: 3 });
  assert.equal(history.cleanup.lastDeletedCount, 3);
  assert.equal(calls.filter((sql) => sql.startsWith("DELETE FROM history_points")).length, 1);
});

test("彻底删除会等待历史行清除，且不会被待写快照复活", async () => {
  const calls = [];
  const history = new History({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return [[]];
    },
  });
  history.data.station = [[1, 10, 0]];
  history._pending.push(["station", 2, 9, 1]);

  await history.purge("station");

  assert.equal(history.data.station, undefined);
  assert.equal(history._pending.length, 0);
  assert.equal(calls.filter(({ sql }) => sql.startsWith("INSERT IGNORE INTO history_points")).length, 0);
  assert.deepEqual(calls.slice(0, 2).map(({ sql }) => sql), [
    "DELETE FROM history_points WHERE station_id IN (?)",
    "DELETE FROM station_daily_usage WHERE station_id IN (?)",
  ]);
  history.append("station", 8, 2);
  assert.equal(history._pending.length, 0);
});

test("彻底删除失败会向调用方报错并保留后台重试", async () => {
  const history = new History({
    query: async (sql) => {
      if (sql.startsWith("DELETE FROM history_points")) throw new Error("database unavailable");
      return [[]];
    },
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(history.purge("station"), /database unavailable/);
  } finally {
    console.error = originalError;
  }
  assert.equal(history._removed.has("station"), true);
  assert.ok(history._saveTimer);
  clearTimeout(history._saveTimer);
  history._saveTimer = null;
});

test("彻底删除的后台重试连续失败时会继续重排，直到成功", async () => {
  let deleteAttempts = 0;
  const history = new History({
    query: async (sql) => {
      if (sql.startsWith("DELETE FROM history_points")) {
        deleteAttempts += 1;
        if (deleteAttempts < 3) throw new Error("database unavailable");
      }
      return [[]];
    },
  });
  const retries = [];
  history.scheduleSave = () => retries.push(() => history.flush());

  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(history.purge("station"), /database unavailable/);
    assert.equal(retries.length, 1);

    await retries.shift()();
    assert.equal(retries.length, 1);
    assert.equal(history._removed.has("station"), true);

    await retries.shift()();
  } finally {
    console.error = originalError;
  }

  assert.equal(deleteAttempts, 3);
  assert.equal(retries.length, 0);
  assert.equal(history._removed.has("station"), false);
});
