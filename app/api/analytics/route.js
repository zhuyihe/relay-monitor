// ---- 经营分析：日汇总支撑长期趋势，原始快照仅保留近期热力图 --------------------------
// GET /api/analytics?days=1..365&includeArchived=true
// 消耗口径与 History.usedSince 一致：相邻快照余额下降计消耗，上升视为充值忽略。
// SQL 日期分桶跟随 MySQL 会话时区；部署统一为 Asia/Shanghai。
import { withAuth, json } from "../../../lib/api.js";
import { fixedPurchases } from "../../../lib/providers.js";
import { hasRawWindowCoverage, summarizeCoverage } from "./coverage.js";

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const pad2 = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

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

  // 窗口 = 今天（本地自然日）往前共 days 天，起点取本地零点。
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const start = dayKey(startDate);
  const end = dayKey(now);
  const dayList = Array.from({ length: days }, (_, index) => {
    const date = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + index);
    return { date: dayKey(date), ms: date.getTime() };
  });

  // 归档资源默认不进入经营分析，需要由已认证客户端明确选择。
  const stations = store.list({ includeArchived });
  const stationIds = stations.map((station) => station.id);
  const monitoredStations = stations.filter((station) => station.type !== "fixed");
  const monitoredStationIds = monitoredStations.map((station) => station.id);
  const byId = new Map(stations.map((station) => [station.id, station]));
  const rateOf = (station) => (station.cnyPerUsd != null && station.cnyPerUsd > 0 ? station.cnyPerUsd : 1);

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
  const heatmapStations = monitoredStations.filter((station) => !station.isOwn && station.includeInProfit !== false);
  let heatmap = [];
  let heatmapAvailability = {
    available: false,
    reason: days > 30 ? "range-not-supported" : "no-cost-stations",
    coverage: null,
  };
  if (days <= 30 && heatmapStations.length) {
    const heatmapStationIds = heatmapStations.map((station) => station.id);
    const [rawDateRows] = await pool.query(
      `SELECT station_id AS stationId,
              DATE_FORMAT(FROM_UNIXTIME(t / 1000), '%Y-%m-%d') AS date
       FROM history_points
       WHERE station_id IN (?) AND t >= ? AND t <= ?
       GROUP BY station_id, date`,
      [heatmapStationIds, startDate.getTime(), now.getTime()]
    );
    const [rawBoundsRows] = await pool.query(
      `SELECT station_id AS stationId,
              MIN(t) AS earliestAt,
              DATE_FORMAT(FROM_UNIXTIME(MIN(t) / 1000), '%Y-%m-%d') AS earliestDate,
              DATE_FORMAT(FROM_UNIXTIME(MAX(t) / 1000), '%Y-%m-%d') AS latestDate
       FROM history_points
       WHERE station_id IN (?)
       GROUP BY station_id`,
      [heatmapStationIds]
    );
    const rawBounds = new Map(rawBoundsRows.map((row) => [row.stationId, row]));
    const rawCoverage = summarizeCoverage(heatmapStations, dayList, rawDateRows, rawBounds);
    // 有一天的快照不等于能计算整段热力图：还需保留窗口起点前的基线。
    const available = hasRawWindowCoverage(rawCoverage, heatmapStations, rawBounds, startDate.getTime());
    heatmapAvailability = {
      available,
      reason: available ? null : "incomplete-raw-history",
      coverage: rawCoverage,
    };
    if (available) {
      const [heatRows] = await pool.query(
        `SELECT station_id AS stationId,
                WEEKDAY(FROM_UNIXTIME(t / 1000)) AS weekday,
                HOUR(FROM_UNIXTIME(t / 1000)) AS hour,
                SUM(prev - remaining) AS usd
         FROM (${RECENT_DROPS_SQL}) x
         WHERE station_id IN (?) AND prev IS NOT NULL AND prev > remaining
         GROUP BY stationId, weekday, hour`,
        [startDate.getTime(), heatmapStationIds]
      );
      const heatMap = new Map();
      for (const row of heatRows) {
        const station = byId.get(row.stationId);
        if (!station) continue;
        const key = `${row.weekday}|${row.hour}`;
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

  // 固定成本日摊销：每笔付费金额÷天数，摊到生效区间与查询窗口的重叠日。
  const fixedDaily = [];
  const fixedTotal = new Map();
  for (const station of stations) {
    const purchases = fixedPurchases(station);
    if (!purchases.length) continue;
    for (const { date, ms } of dayList) {
      let cny = 0;
      for (const purchase of purchases) {
        if (!(purchase.amount > 0) || !(purchase.days > 0)) continue;
        if (purchase.startDate) {
          const [year, month, day] = purchase.startDate.split("-").map(Number);
          const purchaseStart = new Date(year, month - 1, day).getTime();
          if (ms < purchaseStart || ms >= purchaseStart + purchase.days * 86400000) continue;
        }
        cny += purchase.amount / purchase.days;
      }
      if (cny > 0) {
        fixedDaily.push({ date, stationId: station.id, cny: r2(cny) });
        fixedTotal.set(station.id, (fixedTotal.get(station.id) || 0) + cny);
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
