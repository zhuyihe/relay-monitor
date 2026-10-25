// 每站每日消耗（$）：从日汇总读取，不随原始历史规模增长而变慢。成本估算页（app/api/analytics/route.js）和合并上游清单里的
// 「合并前后成本估算」读的是这一份，两处的数分毫不差。start、end 是业务时区的日期（YYYY-MM-DD，含两头）。
export async function dailyUsageRows(pool, stationIds, start, end) {
  if (!stationIds.length) return [];
  const [rows] = await pool.query(
    `SELECT station_id AS stationId,
            DATE_FORMAT(date, '%Y-%m-%d') AS date,
            used_usd AS usd
     FROM station_daily_usage
     WHERE station_id IN (?) AND date >= ? AND date <= ?
     ORDER BY date, stationId`,
    [stationIds, start, end]
  );
  return rows;
}
