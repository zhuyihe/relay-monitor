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

// 预计耗尽在“紧急”窗口（规则 etaDays）之外、但 7 天内的，算“注意”（与上游余量跑道、上游资源页同一口径）
export const WATCH_DAYS = 7;
const LEVEL_RANK = { crit: 0, warn: 1 };
const WORKFLOW_PRIORITY = { update_authorization: 0, review_conflict: 0, review_source: 0, verify_identity: 1, verify_capability: 1, confirm_coverage: 2, retry_bill: 2, connect_channels: 3, wait_effective: 4 };
// 授权失效、销售归属冲突、来源待复核会让账单直接算错，按紧急处理；其余是待补充的信息
const WORKFLOW_CRIT = new Set(["update_authorization", "review_conflict", "review_source"]);

// 先比等级；同级时余额与查询问题（有明确的耗尽时间）排在账号与账单待办前面
const compareSeverity = (a, b) => (
  LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
  || Number(!!a.workflow) - Number(!!b.workflow)
  || a.priority - b.priority
  || a.urgency - b.urgency
);

const compareActions = (a, b) => (
  compareSeverity(a, b)
  || a.stationName.localeCompare(b.stationName, "zh-CN")
  || a.id.localeCompare(b.id)
);

/**
 * Derives the ordered operational action list from the station payload and the
 * account / bill workflow actions. One row per resource: the most severe issue
 * leads and the rest are kept in `others`. Every row carries `level`
 * ("crit" | "warn") so the sidebar count, the overview list and the resources
 * page agree on what needs attention.
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
  const watchDays = Math.max(windowDays, WATCH_DAYS);
  const byStation = new Map();
  const names = new Map();
  const add = (action) => {
    const list = byStation.get(action.stationId);
    if (list) list.push(action);
    else byStation.set(action.stationId, [action]);
  };

  for (const station of Array.isArray(stations) ? stations : []) {
    // 自营 root 账号余额不属于上游续费与资金风险的处置范围。
    if (!station || station.isOwn) continue;

    const stationId = String(station.id || actionStationName(station));
    names.set(stationId, actionStationName(station));
    const common = { station, stationId, stationName: actionStationName(station) };

    if (station.type === "fixed") {
      // 标记为不再续费的资源不再提示续费或到期，但不会掩盖常规站点的查询失败。
      if (station.noRenewal) continue;
      const expiry = fixedExpiry(station, now, windowDays);
      if (expiry) {
        add({
          ...common,
          kind: "fixed-expiring",
          level: "warn",
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
      add({ ...common, kind: "query-failed", level: "crit", priority: 0, urgency: 0 });
      continue;
    }

    // “不再续费”是明确的运营意图；保留查询失败，但不再因余额或 ETA 打扰。
    if (station.noRenewal || !balance?.ok) continue;

    const etaDays = Number(station.prediction?.etaDays);
    const hasEta = Number.isFinite(etaDays) && etaDays >= 0 && Number(station.prediction?.burnPerDay) > 0;
    const status = statusOf(station, settings);
    if (status === "danger" || status === "warn") {
      add({
        ...common,
        kind: status === "danger" ? "balance-danger" : "balance-low",
        // 余额低于提醒线且预计在紧急窗口内用完，与“即将耗尽”同为紧急
        level: status === "danger" || (hasEta && etaDays <= windowDays) ? "crit" : "warn",
        priority: status === "danger" ? 1 : 2,
        urgency: Number(balance.remaining) || 0,
        ...(hasEta ? { etaDays } : {}),
      });
      continue;
    }

    if (hasEta && etaDays <= watchDays) {
      add({ ...common, kind: "eta-soon", level: etaDays <= windowDays ? "crit" : "warn", priority: 3, urgency: etaDays, etaDays });
    }
  }

  const rows = [];
  const ids = new Set(), destinations = new Set();
  for (const action of workflowActions) {
    if (!(action?.kind in WORKFLOW_PRIORITY) || !action.id || !action.href?.startsWith("/") || action.href.startsWith("//")) continue;
    const url = new URL(action.href, "https://workflow.invalid");
    if (!["/stations", "/reconciliation"].includes(url.pathname)) continue;
    url.searchParams.sort();
    const destination = `${action.kind}:${url.pathname}?${url.searchParams}`;
    if (ids.has(action.id) || destinations.has(destination)) continue;
    ids.add(action.id); destinations.add(destination);
    const candidate = {
      ...action, workflow: true, level: WORKFLOW_CRIT.has(action.kind) ? "crit" : "warn",
      priority: WORKFLOW_PRIORITY[action.kind], urgency: 0, stationName: action.label,
    };
    if (action.stationId && url.searchParams.get("stationId") === String(action.stationId)
        && !["ruleId", "accountKey", "ownStationId", "channelIds"].some((key) => url.searchParams.has(key))) add(candidate);
    else rows.push({ ...candidate, others: [] });
  }
  for (const list of byStation.values()) {
    const [lead, ...others] = list.map((action) => action.workflow ? action : {
      ...action, id: `monitor:${action.stationId}:${action.kind}`, href: `/stations?stationId=${encodeURIComponent(action.stationId)}`,
    }).sort(compareSeverity);
    // 账号待办的 stationName 是待办标题；挂在资源上时换回资源名，便于按名称排序与展示
    rows.push({ ...lead, stationName: names.get(lead.stationId) || lead.stationName, anchored: true, others });
  }
  const all = rows.sort(compareActions);
  return { all, visible: all.slice(0, Math.max(1, limit)) };
}

/**
 * Resources that have at least one open item, including account / bill todos
 * that name the resource. The overview "其余 N 个正常" note and the resources
 * page "需处理 / 正常" split both read from this so they stay in step.
 *
 * @param {any[]} actions the `all` list from buildOverviewActions
 */
export function attentionStationIds(actions) {
  const ids = new Set();
  for (const action of actions || []) {
    if (action?.stationId) ids.add(String(action.stationId));
  }
  return ids;
}

/**
 * Every open item per resource: the merged row (lead + others) plus account /
 * bill todos addressed by rule, account or channel that still name the resource.
 *
 * @param {any[]} actions the `all` list from buildOverviewActions
 */
export function actionsByStation(actions) {
  const byStation = new Map();
  for (const action of actions || []) {
    if (!action?.stationId) continue;
    const id = String(action.stationId);
    const list = byStation.get(id) || [];
    list.push(...(action.anchored ? [action, ...(action.others || [])] : [action]));
    byStation.set(id, list);
  }
  return byStation;
}
