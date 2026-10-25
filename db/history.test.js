import test from "node:test";
import assert from "node:assert/strict";
import { History, dailyUsageRows, forEachPointWithBaseline, readPointsWithBaseline, usageDrops } from "./history.js";
import { dayStartInTz } from "../lib/business-time.js";

test("日汇总按后一快照归日，充值不计作消耗", () => {
  const start = dayStartInTz("2026-01-02", "Asia/Shanghai");
  const end = start + 86400000;
  const rows = dailyUsageRows([
    { station_id: "a", t: start - 3600000, remaining: 10 },
    { station_id: "a", t: start + 3600000, remaining: 8 },
    { station_id: "a", t: start + 7200000, remaining: 9 },
    { station_id: "a", t: start + 10800000, remaining: 7 },
  ], start, end, "Asia/Shanghai");

  assert.deepEqual(rows, [{ stationId: "a", date: "2026-01-02", usd: 4 }]);
});

test("日汇总保留零消耗日期，保证长期分析覆盖期诚实", () => {
  const start = dayStartInTz("2026-01-02", "Asia/Shanghai");
  const end = start + 86400000;
  const rows = dailyUsageRows([
    { station_id: "a", t: start - 1000, remaining: 10 },
    { station_id: "a", t: start + 1000, remaining: 10 },
  ], start, end, "Asia/Shanghai");

  assert.deepEqual(rows, [{ stationId: "a", date: "2026-01-02", usd: 0 }]);
});

test("日汇总按业务时区划日，与进程时区无关", () => {
  // 北京时间 1 月 2 日 07:00 = UTC 1 月 1 日 23:00：按业务时区应归入 1 月 2 日
  const start = dayStartInTz("2026-01-02", "Asia/Shanghai");
  const points = [
    { station_id: "a", t: start - 2 * 3600000, remaining: 10 },
    { station_id: "a", t: start + 7 * 3600000, remaining: 9 },
  ];
  const rows = dailyUsageRows(points, start - 3600000, start + 86400000, "Asia/Shanghai");
  assert.deepEqual(rows, [{ stationId: "a", date: "2026-01-02", usd: 1 }]);
  const utc = dailyUsageRows(points, start - 3600000, start + 86400000, "UTC");
  assert.deepEqual(utc, [{ stationId: "a", date: "2026-01-01", usd: 1 }]);
});

test("usedBetween 按 [起点, 终点) 计、与日汇总同一边界，usedSince 不设终点", () => {
  const history = new History({ query: async () => [[]] });
  history.data.a = [[1000, 10], [2000, 9], [3000, 9.5], [4000, 8], [5000, 6]];
  assert.equal(history.usedBetween("a", 1500, 4500), 2.5);
  // 正好落在终点的快照算下一段
  assert.equal(history.usedBetween("a", 1500, 4000), 1);
  assert.equal(history.usedBetween("a", 4000, 6000), 3.5);
  // 基线取起点之前的最后一个快照；正好落在起点的快照算本段
  assert.equal(history.usedBetween("a", 2500, 4500), 1.5);
  assert.equal(history.usedBetween("a", 2000, 2500), 1);
  // 相邻两段不重不漏
  assert.equal(history.usedBetween("a", 1500, 4000) + history.usedBetween("a", 4000, 6000), history.usedBetween("a", 1500, 6000));
  assert.equal(history.usedSince("a", 1500), 4.5);
  assert.equal(history.covers("a", 1500, 4500), true);
  assert.equal(history.covers("a", 1000, 4500), false, "起点之前没有基线");
  assert.equal(history.covers("a", 5500, 6000), false, "窗口内没有快照");
  assert.equal(history.covers("missing", 1500, 4500), false);
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

test("预测：日均花费舍到分以后是 0（每天不到半分钱）就算近期没有花费，不给可用天数；半分钱以上照算", () => {
  const now = Date.parse("2026-10-24T02:00:00Z");
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const history = new History({ query: async () => [[]] });
    // 近 2.5 小时每 30 分钟一个快照，按每天 perDay 美元匀速花，最后剩 $0.01
    const series = (perDay) => Array.from({ length: 6 }, (_, i) => {
      const hoursAgo = 2.5 - i * 0.5;
      return [now - hoursAgo * 3600000, 0.01 + perDay * hoursAgo / 24, 0];
    });
    history.data.slow = series(0.004);
    assert.deepEqual(
      (({ burnPerDay, etaDays, etaAt }) => ({ burnPerDay, etaDays, etaAt }))(history.predict("slow")),
      { burnPerDay: 0, etaDays: null, etaAt: null },
      "原来是日均 0、可用 2.5 天"
    );
    history.data.fast = series(0.006);
    const fast = history.predict("fast");
    assert.equal(fast.burnPerDay, 0.01);
    assert.equal(fast.etaDays, 1.7, "天数按没舍的速率算：0.01 ÷ 0.006");
    assert.ok(fast.etaAt);
  } finally {
    Date.now = realNow;
  }
});

test("余额消耗按组相加：窗口里第一个点和窗口前的基线比，充值不算，窗口外的点只当基线；几个上游互不串", () => {
  const SLOT = 15 * 60000, start = 10 * SLOT;
  const rows = [
    { station_id: "a", t: start - 60000, remaining: 100 }, // 基线
    { station_id: "a", t: start, remaining: 99 }, // 和基线比：掉 1
    { station_id: "a", t: start + 60000, remaining: 98.5 }, // 同一组再掉 0.5
    { station_id: "a", t: start + SLOT, remaining: 120 }, // 充值：不算，但这一组也出现（0）
    { station_id: "a", t: start + SLOT + 60000, remaining: 119 }, // 掉 1
    { station_id: "b", t: start + 30000, remaining: 50 }, // 没有基线：第一个点不算
    { station_id: "b", t: start + 90000, remaining: 49.75 },
    { station_id: "b", t: start + 3 * SLOT, remaining: 40 }, // 窗口以外：只更新基线，不计
  ];
  const drops = [...usageDrops(rows, start, start + 2 * SLOT, (t) => Math.floor(t / SLOT)).values()];
  assert.deepEqual(drops, [{ stationId: "a", bucket: 10, usd: 1.5 }, { stationId: "a", bucket: 11, usd: 1 }, { stationId: "b", bucket: 10, usd: 0.25 }]);
  // 日汇总是同一个算法按自然日分组
  assert.deepEqual(dailyUsageRows(rows, start, start + 2 * SLOT, "UTC"), [{ stationId: "a", date: "1970-01-01", usd: 2.5 }, { stationId: "b", date: "1970-01-01", usd: 0.25 }]);
});

test("窗口内的原始快照：窗口按主键顺序读，基线每站一行，合并后基线排在这一站窗口里的点前面；不用 UNION 再排一次序", async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("MAX(t)")) return [[{ station_id: "b", t: 5, remaining: 9 }, { station_id: "a", t: 4, remaining: 8 }, { station_id: "z", t: 3, remaining: 7 }]];
    return [[{ station_id: "a", t: 100, remaining: 7 }, { station_id: "a", t: 101, remaining: 6 }, { station_id: "b", t: 102, remaining: 5 }, { station_id: "c", t: 103, remaining: 4 }]];
  } };
  const rows = await readPointsWithBaseline(pool, ["a", "b", "c", "z"], 100);
  assert.deepEqual(rows.map((row) => `${row.station_id}@${row.t}`), ["a@4", "a@100", "a@101", "b@5", "b@102", "c@103", "z@3"]);
  assert.equal(calls.length, 2);
  const [base, window] = [calls.find((c) => c.sql.includes("MAX(t)")), calls.find((c) => !c.sql.includes("MAX(t)"))];
  assert.deepEqual(base.params, [["a", "b", "c", "z"], 100]);
  assert.deepEqual(window.params, [["a", "b", "c", "z"], 100, Number.MAX_SAFE_INTEGER]);
  assert.match(window.sql, /WHERE station_id IN \(\?\) AND t >= \? AND t < \?\s*ORDER BY station_id, t/);
  for (const { sql } of calls) {
    assert.doesNotMatch(sql, /UNION/);
    assert.doesNotMatch(sql, /ORDER BY previous\.t DESC LIMIT 1/, "不再每个点一次相关子查询");
  }
});

test("真的 mysql2 连接池走流式读：窗口那条一行一行交，不一次读完；基线照样排在这一站最前", async () => {
  const streamed = [];
  const pool = {
    query: async (sql) => {
      assert.match(sql, /MAX\(t\)/, "窗口那条不走一次读完的 query");
      return [[{ station_id: "a", t: 4, remaining: 8 }]];
    },
    pool: { query: (sql, params) => {
      streamed.push({ sql, params });
      return { stream: () => (async function* () { yield { station_id: "a", t: 100, remaining: 7 }; yield { station_id: "b", t: 101, remaining: 6 }; })() };
    } },
  };
  const seen = [];
  await forEachPointWithBaseline(pool, ["a", "b"], 100, 200, (row) => seen.push(`${row.station_id}@${row.t}`));
  assert.deepEqual(seen, ["a@4", "a@100", "b@101"]);
  assert.equal(streamed.length, 1);
  assert.deepEqual(streamed[0].params, [["a", "b"], 100, 200]);
});
