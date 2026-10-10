const DAY_MS = 24 * 60 * 60 * 1000;

function actionStationName(station) {
  const name = String(station?.name || "").trim();
  return name || "未命名资源";
}

function etaWindowDays(rules) {
  const value = Number(rules?.etaDays);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function fixedExpiry(station, now, windowDays) {
  let nearest = null;

  for (const purchase of Array.isArray(station?.fixedPurchases) ? station.fixedPurchases : []) {
    const days = Number(purchase?.days);
    if (!purchase?.startDate || !Number.isFinite(days) || days <= 0) continue;

    const startAt = Date.parse(`${purchase.startDate}T00:00:00`);
    if (!Number.isFinite(startAt)) continue;

    const endAt = startAt + days * DAY_MS;
    if (startAt > now || endAt <= now || endAt - now > windowDays * DAY_MS) continue;
    if (!nearest || endAt < nearest.endAt) nearest = { endAt };
  }

  return nearest;
}

/**
 * Derives the short, ordered operational action list from the station payload.
 * The caller supplies statusOf so this stays exactly aligned with the current
 * per-station low-balance threshold behavior in the client.
 *
 * @param {any[]} stations
 * @param {{ now?: number, rules?: any, settings?: any, statusOf: (station: any, settings: any) => string, limit?: number, workflowActions?: any[] }} options
 */
export function buildOverviewActions(stations, {
  now = Date.now(),
  rules = {},
  settings = {},
  statusOf,
  limit = 5,
  workflowActions = [],
} = {}) {
  if (typeof statusOf !== "function") throw new TypeError("statusOf is required");

  const windowDays = etaWindowDays(rules);
  const byStation = new Map();
  const add = (action) => {
    const current = byStation.get(action.stationId);
    if (!current || action.priority < current.priority || (action.priority === current.priority && action.urgency < current.urgency)) {
      byStation.set(action.stationId, action);
    }
  };

  for (const station of Array.isArray(stations) ? stations : []) {
    // 自营 root 账号余额不属于上游续费与资金风险的处置范围。
    if (!station || station.isOwn) continue;

    const stationId = String(station.id || actionStationName(station));
    const common = { station, stationId, stationName: actionStationName(station) };

    if (station.type === "fixed") {
      // 标记为不再续费的资源不再提示续费或到期，但不会掩盖常规站点的查询失败。
      if (station.noRenewal) continue;
      const expiry = fixedExpiry(station, now, windowDays);
      if (expiry) {
        add({
          ...common,
          kind: "fixed-expiring",
          priority: 4,
          urgency: expiry.endAt - now,
          endAt: expiry.endAt,
          daysRemaining: Math.max(1, Math.ceil((expiry.endAt - now) / DAY_MS)),
        });
      }
      continue;
    }

    const balance = station.balance;
    if (balance && !balance.ok) {
      add({ ...common, kind: "query-failed", priority: 0, urgency: 0 });
      continue;
    }

    // “不再续费”是明确的运营意图；保留查询失败，但不再因余额或 ETA 打扰。
    if (station.noRenewal || !balance?.ok) continue;

    const status = statusOf(station, settings);
    if (status === "danger" || status === "warn") {
      add({
        ...common,
        kind: status === "danger" ? "balance-danger" : "balance-low",
        priority: status === "danger" ? 1 : 2,
        urgency: Number(balance.remaining) || 0,
      });
      continue;
    }

    const etaDays = Number(station.prediction?.etaDays);
    if (Number.isFinite(etaDays) && etaDays >= 0 && etaDays <= windowDays && Number(station.prediction?.burnPerDay) > 0) {
      add({ ...common, kind: "eta-soon", priority: 3, urgency: etaDays, etaDays });
    }
  }

  const actions = [];
  const workflowPriorities = { update_authorization: 0, review_conflict: 0, review_source: 0, verify_identity: 1, verify_capability: 1, confirm_coverage: 2, retry_bill: 2, connect_channels: 3, wait_effective: 4 };
  const ids = new Set(), destinations = new Set();
  for (const action of workflowActions) {
    if (!(action?.kind in workflowPriorities) || !action.id || !action.href?.startsWith("/") || action.href.startsWith("//")) continue;
    const url = new URL(action.href, "https://workflow.invalid");
    if (!["/stations", "/reconciliation"].includes(url.pathname)) continue;
    url.searchParams.sort();
    const destination = `${action.kind}:${url.pathname}?${url.searchParams}`;
    if (ids.has(action.id) || destinations.has(destination)) continue;
    ids.add(action.id); destinations.add(destination);
    const candidate = { ...action, workflow: true, priority: workflowPriorities[action.kind], urgency: 0, stationName: action.label };
    if (action.stationId && url.searchParams.get("stationId") === String(action.stationId)
        && !["ruleId", "accountKey", "ownStationId", "channelIds"].some((key) => url.searchParams.has(key))) add(candidate);
    else actions.push(candidate);
  }
  const stationWinners = [...byStation.values()].map((action) => action.workflow ? action : {
    ...action, id: `monitor:${action.stationId}:${action.kind}`, href: `/stations?stationId=${encodeURIComponent(action.stationId)}`,
  });
  actions.push(...stationWinners);
  const all = actions.sort((a, b) => (
    a.priority - b.priority
    || a.urgency - b.urgency
    || a.stationName.localeCompare(b.stationName, "zh-CN")
    || a.id.localeCompare(b.id)
  ));
  return { all, visible: all.slice(0, Math.max(1, limit)) };
}
