// 原始/日汇总都只把真实存在快照的日期记为可用；缺口绝不补零。
export function summarizeCoverage(stations, dayList, rows, boundsByStation = new Map()) {
  const datesByStation = new Map(stations.map((station) => [station.id, new Set()]));
  const requestedDates = new Set(dayList.map(({ date }) => date));
  for (const row of rows) {
    if (requestedDates.has(row.date)) datesByStation.get(row.stationId)?.add(row.date);
  }

  const perStation = stations.map((station) => {
    const dates = datesByStation.get(station.id) || new Set();
    const bounds = boundsByStation.get(station.id) || {};
    const availableDays = dates.size;
    return {
      stationId: station.id,
      stationName: station.name,
      archivedAt: station.archivedAt || null,
      earliestDate: bounds.earliestDate || null,
      latestDate: bounds.latestDate || null,
      availableDays,
      missingDays: dayList.length - availableDays,
      isComplete: availableDays === dayList.length,
    };
  });
  const dated = perStation.filter((station) => station.earliestDate || station.latestDate);
  const stationGaps = perStation.filter((station) => !station.isComplete);
  return {
    earliestDate: dated.map((station) => station.earliestDate).filter(Boolean).sort()[0] || null,
    latestDate: dated.map((station) => station.latestDate).filter(Boolean).sort().at(-1) || null,
    // 用最少覆盖天数表示多站点共同可用的窗口，不能使用任一站点的并集冒充完整。
    availableDays: perStation.length ? Math.min(...perStation.map((station) => station.availableDays)) : 0,
    requestedDays: dayList.length,
    monitoredStationCount: perStation.length,
    isComplete: perStation.length > 0 && stationGaps.length === 0,
    stationGaps,
  };
}

export function hasRawWindowCoverage(rawCoverage, stations, rawBounds, startAt) {
  return rawCoverage.isComplete && stations.every(
    (station) => Number(rawBounds.get(station.id)?.earliestAt) <= startAt
  );
}
