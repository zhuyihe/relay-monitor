// ---- 经营分析：日汇总支撑长期趋势，原始快照仅保留近期热力图 --------------------------
// GET /api/analytics?days=1..365&includeArchived=true，或 ?start=YYYY-MM-DD（自定义范围：从这天到今天）
// 消耗口径见 db/history.js 的 usageDrops（日汇总和这里的花费时段共用）：相邻快照余额下降计消耗，上升视为充值忽略。
// 日期、星期、小时一律按业务时区（lib/business-time.js）划分：先按 15 分钟取整，
// 换算在 JS 里做，不依赖 MySQL 会话时区和进程时区。固定成本与「我的站点」同一摊销算法（lib/profit.js）。
import { withAuth, json } from "../../../lib/api.js";
import {
  businessTimeZone, dayKeyInTz, dayRangeInTz, shiftDayLabel, weekdayHourInTz,
} from "../../../lib/business-time.js";
import { amortizeFixedCost, costBasisOf, countsInProfit, purchasesOf, rateSnapshotOf } from "../../../lib/profit.js";
import { hasRawWindowCoverage, summarizeCoverage } from "./coverage.js";
import { forEachPointWithBaseline, usageDropsAccumulator } from "../../../db/history.js";

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
// 时区偏移都是 15 分钟的整数倍，按 15 分钟分桶再换算，半点时区也不会分错日期和小时
const SLOT_MS = 15 * 60 * 1000;

// 花费时段（热力图）要读窗口里全部原始快照（30 天约 200 万行、1.7 秒），页面每 30 秒轮询一次：
// 读出来算好的「哪几天有快照」和每个上游 168 格（星期 × 小时）的美元合计按时间缓存 10 分钟，键是上游集合 + 窗口起点 + 时区。
// 格子按小时，晚 10 分钟没关系；汇率在每次请求时再乘，改了马上生效。重启或过期以后第一次照旧现读。
// 计划 P2 加按小时的汇总表以后删掉这个缓存。
const HEAT_CACHE_TTL_MS = 10 * 60 * 1000;
const HEAT_CACHE_MAX = 32;

function heatSource(rt, stationIds, startMs, nowMs, tz) {
  const cache = (rt._analyticsHeatCache ||= new Map());
  const key = JSON.stringify([[...stationIds].sort(), startMs, tz]);
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < HEAT_CACHE_TTL_MS) return hit.value;
  for (const [cachedKey, entry] of cache) if (nowMs - entry.at >= HEAT_CACHE_TTL_MS) cache.delete(cachedKey);
  while (cache.size >= HEAT_CACHE_MAX) cache.delete(cache.keys().next().value);
  // 存的是 Promise：同一时刻几个请求只读一次；读失败不留在缓存里
  const value = readHeatSource(rt.pool, stationIds, startMs, nowMs, tz);
  cache.set(key, { at: nowMs, value });
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  return value;
}

// 窗口里的原始快照只读一次，外加每站窗口开始前的最后一个点（db/history.js 的 forEachPointWithBaseline，只扫窗口）：
// 边读边算哪几天有快照、每个 15 分钟的余额下降，不把两百多万行留在内存里。
// 原来每个点做一次相关子查询找前一个点，会把整段历史读一遍。
async function readHeatSource(pool, stationIds, startMs, nowMs, tz) {
  const rawDates = new Set();
  // 每个 15 分钟算完就按业务时区的「星期 × 24 + 小时」加到这个上游的 168 格里（乘汇率之前的美元），不留各个时段。
  // cells 记下各格第一次出现的先后，请求时按这个顺序出结果，和原来按时段逐个累加时的顺序一样。
  const hours = new Map(), cells = [], seen = new Set();
  const slotDrops = usageDropsAccumulator(startMs, Number.MAX_SAFE_INTEGER, (t) => Math.floor(t / SLOT_MS), { onBucket: ({ stationId, bucket: slot, usd }) => {
    if (!(usd > 0)) return;
    const { weekday, hour } = weekdayHourInTz(slot * SLOT_MS, tz);
    const cell = weekday * 24 + hour;
    if (!seen.has(cell)) { seen.add(cell); cells.push(cell); }
    if (!hours.has(stationId)) hours.set(stationId, new Float64Array(168));
    hours.get(stationId)[cell] += usd;
  } });
  let lastSlot = null, lastDay = null;
  await forEachPointWithBaseline(pool, stationIds, startMs, Number.MAX_SAFE_INTEGER, (row) => {
    slotDrops.add(row);
    const t = Number(row.t);
    if (t < startMs || t > nowMs) return;
    const slot = Math.floor(t / SLOT_MS);
    // 同一个 15 分钟里的点同一天，不逐点换算日期
    if (slot !== lastSlot) { lastSlot = slot; lastDay = dayKeyInTz(slot * SLOT_MS, tz); }
    rawDates.add(`${row.station_id}|${lastDay}`);
  });
  slotDrops.finish();
  const rawDateRows = [...rawDates].map((key) => {
    const cut = key.lastIndexOf("|");
    return { stationId: key.slice(0, cut), date: key.slice(cut + 1) };
  });
  return { rawDateRows, hours, cells };
}

// 自定义范围传开始日期，天数由服务端按业务时区的今天算：前端拿到业务时区之前也能发出同一个请求，
// 不会因浏览器与业务时区差一天而多拉一次。早于 365 天前按 365 天，晚于今天按 1 天（只看今天）。
function requestedDays(sp, todayLabel) {
  const start = sp.get("start");
  if (start && shiftDayLabel(start, 0) === start) {
    const diff = Math.round((Date.parse(todayLabel) - Date.parse(start)) / 86400000);
    return Math.min(365, Math.max(1, diff + 1));
  }
  const days = Math.floor(Number(sp.get("days")));
  return Number.isFinite(days) && days >= 1 && days <= 365 ? days : 30;
}

export const GET = withAuth(async (request, rt) => {
  const { pool, store, history } = rt;
  const sp = new URL(request.url).searchParams;
  const includeArchived = sp.get("includeArchived") === "true";

  // 窗口 = 今天（业务时区自然日）往前共 days 天，起点取业务时区零点。
  const tz = businessTimeZone();
  const nowMs = Date.now();
  const end = dayKeyInTz(nowMs, tz);
  const days = requestedDays(sp, end);
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
    (station) => countsInProfit(station) && costBasisOf(station) === "usage"
  );
  let heatmap = [];
  let heatmapAvailability = {
    available: false,
    reason: days > 30 ? "range-not-supported" : "no-cost-stations",
    coverage: null,
  };
  if (days <= 30 && heatmapStations.length) {
    const heatmapStationIds = heatmapStations.map((station) => station.id);
    const { rawDateRows, hours, cells } = await heatSource(rt, heatmapStationIds, startMs, nowMs, tz);
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
      // 每格：各上游这一格的美元合计乘它现在的汇率，再相加（汇率改了马上生效）
      const rated = [...hours].map(([stationId, usd]) => [usd, rateOf(byId.get(stationId))]);
      heatmap = cells.map((cell) => {
        let cny = 0;
        for (const [usd, rate] of rated) if (usd[cell] > 0) cny += usd[cell] * rate;
        return { weekday: Math.floor(cell / 24), hour: cell % 24, cny: r2(cny) };
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

  // 固定成本：站点合计与「我的站点」完全同一次调用（整段 [窗口起点, 现在) 摊销），两页分毫不差；
  // 逐日值按生效区间与当天的重叠毫秒摊、今天只摊到现在，保留四位，只用来画逐日走势
  // （前端按它的累计占比把合计分回每天，见 splitByCumulative）。
  const fixedDaily = [];
  const fixedTotal = new Map();
  for (const station of stations) {
    const purchases = purchasesOf(station);
    if (!purchases.length) continue;
    fixedTotal.set(station.id, amortizeFixedCost(purchases, { startMs, endMs: nowMs, tz }).cny);
    for (const { date, startMs: dayStart, endMs: dayEnd } of dayList) {
      const { exact } = amortizeFixedCost(purchases, { startMs: dayStart, endMs: Math.min(dayEnd, nowMs), tz });
      if (exact > 0) fixedDaily.push({ date, stationId: station.id, cny: r4(exact) });
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
      fixedCny: fixedTotal.get(station.id) || 0,
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
