// ---- 经营分析：日汇总支撑长期趋势，原始快照仅保留近期热力图 --------------------------
// GET /api/analytics?days=1..365&includeArchived=true
// 消耗口径与 History.usedSince 一致：相邻快照余额下降计消耗，上升视为充值忽略。
// 日期、星期、小时一律按业务时区（lib/business-time.js）划分：SQL 只按 15 分钟取整，
// 换算在 JS 里做，不依赖 MySQL 会话时区和进程时区。固定成本与「我的站点」同一摊销算法（lib/profit.js）。
import { withAuth, json } from "../../../lib/api.js";
import {
  businessTimeZone, dayKeyInTz, dayRangeInTz, shiftDayLabel, weekdayHourInTz,
} from "../../../lib/business-time.js";
import { amortizeFixedCost, costBasisOf, purchasesOf, rateSnapshotOf } from "../../../lib/profit.js";
import { hasRawWindowCoverage, summarizeCoverage } from "./coverage.js";

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
// 时区偏移都是 15 分钟的整数倍，按 15 分钟分桶再换算，半点时区也不会分错日期和小时
const SLOT_MS = 15 * 60 * 1000;

// 热力图仍需原始快照。关联查询利用 (station_id, t) 主键取前一快照，
// 避免长期留存后 LAG 扫描整张历史表。
const RECENT_DROPS_SQL = `
  SELECT h.station_id, h.t, h.remaining,
         (SELECT previous.remaining
          FROM history_points previous
          WHERE previous.station_id = h.station_id AND previous.t < h.t
          ORDER BY previous.t DESC LIMIT 1) AS prev
  FROM history_points h
  WHERE h.t >= ?
`;

function requestedDays(value) {
  const days = Math.floor(Number(value));
  return Number.isFinite(days) && days >= 1 && days <= 365 ? days : 30;
}

export const GET = withAuth(async (request, rt) => {
  const { pool, store, history } = rt;
  const sp = new URL(request.url).searchParams;
  const days = requestedDays(sp.get("days"));
  const includeArchived = sp.get("includeArchived") === "true";

  // 窗口 = 今天（业务时区自然日）往前共 days 天，起点取业务时区零点。
  const tz = businessTimeZone();
  const nowMs = Date.now();
  const end = dayKeyInTz(nowMs, tz);
  const start = shiftDayLabel(end, -(days - 1));
  const dayList = dayRangeInTz(start, end, tz);
  const startMs = dayList[0].startMs;

  // 归档资源默认不进入经营分析，需要由已认证客户端明确选择。
  const stations = store.list({ includeArchived });
  const stationIds = stations.map((station) => station.id);
  const monitoredStations = stations.filter((station) => station.type !== "fixed");
  const monitoredStationIds = monitoredStations.map((station) => station.id);
  const byId = new Map(stations.map((station) => [station.id, station]));
  const rateOf = (station) => rateSnapshotOf(station).cnyPerUsd;

  // 每站每日消耗（$）：从日汇总读取，不随原始历史规模增长而变慢。
  let dailyRows = [];
  if (stationIds.length) {
    [dailyRows] = await pool.query(
      `SELECT station_id AS stationId,
              DATE_FORMAT(date, '%Y-%m-%d') AS date,
              used_usd AS usd
       FROM station_daily_usage
       WHERE station_id IN (?) AND date >= ? AND date <= ?
       ORDER BY date, stationId`,
      [stationIds, start, end]
    );
  }

  let coverageBoundsRows = [];
  if (monitoredStationIds.length) {
    [coverageBoundsRows] = await pool.query(
      `SELECT station_id AS stationId,
              DATE_FORMAT(MIN(date), '%Y-%m-%d') AS earliestDate,
              DATE_FORMAT(MAX(date), '%Y-%m-%d') AS latestDate
       FROM station_daily_usage
       WHERE station_id IN (?)
       GROUP BY station_id`,
      [monitoredStationIds]
    );
  }
  const coverage = summarizeCoverage(
    monitoredStations,
    dayList,
    dailyRows,
    new Map(coverageBoundsRows.map((row) => [row.stationId, row]))
  );

  // 热力图仅有短周期价值，且必须由完整的原始快照覆盖来支撑。
  // 只画按用量计成本的上游：配了固定付费的上游余额下降不算成本（见 costBasisOf）。
  const heatmapStations = monitoredStations.filter(
    (station) => !station.isOwn && station.includeInProfit !== false && costBasisOf(station) === "usage"
  );
  let heatmap = [];
  let heatmapAvailability = {
    available: false,
    reason: days > 30 ? "range-not-supported" : "no-cost-stations",
    coverage: null,
  };
  if (days <= 30 && heatmapStations.length) {
    const heatmapStationIds = heatmapStations.map((station) => station.id);
    const [rawSlotRows] = await pool.query(
      `SELECT station_id AS stationId, FLOOR(t / ${SLOT_MS}) AS slot
       FROM history_points
       WHERE station_id IN (?) AND t >= ? AND t <= ?
       GROUP BY station_id, slot`,
      [heatmapStationIds, startMs, nowMs]
    );
    const rawDates = new Set();
    for (const row of rawSlotRows) rawDates.add(`${row.stationId}|${dayKeyInTz(Number(row.slot) * SLOT_MS, tz)}`);
    const rawDateRows = [...rawDates].map((key) => {
      const cut = key.lastIndexOf("|");
      return { stationId: key.slice(0, cut), date: key.slice(cut + 1) };
    });
    const [rawBoundsRows] = await pool.query(
      `SELECT station_id AS stationId, MIN(t) AS earliestAt, MAX(t) AS latestAt
       FROM history_points
       WHERE station_id IN (?)
       GROUP BY station_id`,
      [heatmapStationIds]
    );
    const rawBounds = new Map(rawBoundsRows.map((row) => [row.stationId, {
      earliestAt: Number(row.earliestAt),
      earliestDate: row.earliestAt != null ? dayKeyInTz(Number(row.earliestAt), tz) : null,
      latestDate: row.latestAt != null ? dayKeyInTz(Number(row.latestAt), tz) : null,
    }]));
    const rawCoverage = summarizeCoverage(heatmapStations, dayList, rawDateRows, rawBounds);
    // 有一天的快照不等于能计算整段热力图：还需保留窗口起点前的基线。
    const available = hasRawWindowCoverage(rawCoverage, heatmapStations, rawBounds, startMs);
    heatmapAvailability = {
      available,
      reason: available ? null : "incomplete-raw-history",
      coverage: rawCoverage,
    };
    if (available) {
      const [heatRows] = await pool.query(
        `SELECT station_id AS stationId,
                FLOOR(t / ${SLOT_MS}) AS slot,
                SUM(prev - remaining) AS usd
         FROM (${RECENT_DROPS_SQL}) x
         WHERE station_id IN (?) AND prev IS NOT NULL AND prev > remaining
         GROUP BY stationId, slot`,
        [startMs, heatmapStationIds]
      );
      const heatMap = new Map();
      for (const row of heatRows) {
        const station = byId.get(row.stationId);
        if (!station) continue;
        const { weekday, hour } = weekdayHourInTz(Number(row.slot) * SLOT_MS, tz);
        const key = `${weekday}|${hour}`;
        heatMap.set(key, (heatMap.get(key) || 0) + Number(row.usd) * rateOf(station));
      }
      heatmap = [...heatMap.entries()].map(([key, cny]) => {
        const [weekday, hour] = key.split("|").map(Number);
        return { weekday, hour, cny: r2(cny) };
      });
    }
  }

  const daily = [];
  const totalUsd = new Map();
  for (const row of dailyRows) {
    const station = byId.get(row.stationId);
    if (!station) continue;
    const usd = Number(row.usd);
    daily.push({ date: row.date, stationId: row.stationId, usd: r4(usd), cny: r2(usd * rateOf(station)) });
    totalUsd.set(row.stationId, (totalUsd.get(row.stationId) || 0) + usd);
  }

  // 固定成本日摊销：与「我的站点」同一算法，按生效区间与当天的重叠毫秒摊；今天只摊到现在。
  // 逐日值保留四位、合计用未舍入值累加，站点合计才与「我的站点」整段摊销一致（不会每天舍入丢几分钱）。
  const fixedDaily = [];
  const fixedTotal = new Map();
  for (const station of stations) {
    const purchases = purchasesOf(station);
    if (!purchases.length) continue;
    for (const { date, startMs: dayStart, endMs: dayEnd } of dayList) {
      const { exact } = amortizeFixedCost(purchases, { startMs: dayStart, endMs: Math.min(dayEnd, nowMs), tz });
      if (exact > 0) {
        fixedDaily.push({ date, stationId: station.id, cny: r4(exact) });
        fixedTotal.set(station.id, (fixedTotal.get(station.id) || 0) + exact);
      }
    }
  }

  const outStations = stations.map((station) => {
    const usd = totalUsd.get(station.id) || 0;
    const prediction = history.predict(station.id);
    return {
      id: station.id,
      name: station.name,
      archivedAt: station.archivedAt || null,
      isOwn: !!station.isOwn,
      includeInProfit: station.includeInProfit !== false,
      // fixed：只按固定付费摊销计成本，余额下降（totalUsd/totalCny 与 daily）不再算成本
      costBasis: costBasisOf(station),
      cnyPerUsd: station.cnyPerUsd ?? null,
      totalUsd: r4(usd),
      totalCny: r2(usd * rateOf(station)),
      fixedCny: r2(fixedTotal.get(station.id) || 0),
      runway: prediction ? { etaDays: prediction.etaDays, burnPerDay: prediction.burnPerDay, basis: prediction.basis } : null,
    };
  });

  return json({
    days,
    start,
    end,
    tz,
    selection: {
      includeArchived,
      stationCount: stations.length,
      archivedStationCount: stations.filter((station) => station.archivedAt).length,
    },
    coverage,
    stations: outStations,
    daily,
    fixedDaily,
    heatmap,
    // 兼容旧客户端；新客户端可读 reason/coverage 提示不可用原因。
    heatmapAvailable: heatmapAvailability.available,
    heatmapAvailability,
    generatedAt: new Date().toISOString(),
  });
});
