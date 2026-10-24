import { DEFAULT_BUSINESS_TIME_ZONE } from "./business-time.js";
import { EMPTY, formatDays } from "./format.js";
import { fixedCostNowOf, purchasesOf } from "./profit.js";
import { workflowTodo } from "./workflow-actions.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// 上游的显示名；没有名字时写「未命名上游」（design/ui-copy-spec.md §3.1）
export function stationDisplayName(station) {
  const name = String(station?.name || "").trim();
  return name || "未命名上游";
}

// 「快用完」的提醒天数：告警规则里的 etaDays，没设置时 3 天
export function etaWindowDays(rules) {
  const value = Number(rules?.etaDays);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

// 余额提醒线（美元）：上游自己设置的优先，否则用全局设置
export function lowLineOf(station, settings = { lowBalanceUsd: 5 }) {
  return station?.lowBalanceUsd != null && station.lowBalanceUsd !== ""
    ? Number(station.lowBalanceUsd)
    : Number(settings?.lowBalanceUsd);
}

// 余额档位（叫法见 lib/format.js 的 BALANCE_STATE_TEXT）：
// pending 还没读取、error 读不到余额、danger 余额用完、warn 余额偏低、ok 正常
export function balanceStateOf(station, settings) {
  const b = station?.balance;
  if (!b) return "pending";
  if (!b.ok) return "error";
  if (b.remaining <= 0) return "danger";
  if (b.remaining < lowLineOf(station, settings)) return "warn";
  return "ok";
}

// 正在用的固定成本里最早到期的那笔，在提醒天数以内才返回。开始日期按业务时区的 0:00 算，
// 和上游列表的「N 天后到期」、成本估算的摊销同一个算法（lib/profit.js 的 fixedCostNowOf），与浏览器所在时区无关
function fixedExpiry(station, now, windowDays, tz) {
  const { nextEnd } = fixedCostNowOf(purchasesOf(station), { now, tz });
  return nextEnd != null && nextEnd - now <= windowDays * DAY_MS ? { endAt: nextEnd } : null;
}

// 最近在花钱：估算的日均花费大于 0。只有在花钱时才算快用完、才按可用天数分档（§3.3）；
// 页面（balanceViewOf、buildOverviewActions）和推送（lib/alerts.js 的快用完）都按这一个判断
export function isSpending(prediction) {
  return Number(prediction?.burnPerDay) > 0;
}

// 可用天数在提醒天数（规则 etaDays）以外、但 7 天以内的，也算快用完，用黄色（§3.3）。
// 总览、上游列表、成本估算按同一套分档，见 runwayLevel。
export const WATCH_DAYS = 7;
// 可用天数图最多画到 14 天，再长的按 14 天画
export const RUNWAY_MAX_DAYS = 14;

// 可用天数分档：提醒天数以内 crit（红），7 天以内 warn（黄），其余 good。两条线都含端点。
// 算不出天数（空、非数字、无穷）返回 null，页面写「—」，不标颜色。
export function runwayLevel(days, rules) {
  if (typeof days !== "number" || !Number.isFinite(days)) return null;
  const windowDays = etaWindowDays(rules);
  if (days <= windowDays) return "crit";
  if (days <= Math.max(windowDays, WATCH_DAYS)) return "warn";
  return "good";
}

// 一个按余额计费的上游现在怎么显示（§3.3）。上游列表和运营总览的「上游余量」都用它，分档和 buildOverviewActions 一致。
// state 是 lib/format.js BALANCE_STATE_TEXT 的键：pending 还没读取、unreadable 读不到余额、empty 余额用完、
//   low 余额偏低、soon 快用完；正常时 null，界面不标（§2 第 5 条）。
// level：crit 红、warn 黄、good 正常、muted 没有颜色（还没读取、算不出天数）。不再续费的和自营站点不提醒，降成 muted。
// days：可用天数，余额用完是 0，近期没有花费是 Infinity，算不出是 null。
/** @returns {{ state: "pending" | "unreadable" | "empty" | "low" | "soon" | null, level: "crit" | "warn" | "good" | "muted", days: number | null }} */
export function balanceViewOf(station, { settings, rules } = {}) {
  const status = balanceStateOf(station, settings);
  if (status === "pending") return { state: "pending", level: "muted", days: null };
  if (status === "error") return { state: "unreadable", level: "crit", days: null };

  const prediction = station?.prediction;
  const burn = Number(prediction?.burnPerDay);
  const eta = prediction?.etaDays == null ? NaN : Number(prediction.etaDays);
  let days = null;
  if (status === "danger") days = 0;
  else if (prediction && prediction.burnPerDay != null && burn === 0) days = Infinity;
  else if (Number.isFinite(eta)) days = Math.max(0, eta);
  // 只有在花钱时才按可用天数分档
  const etaLevel = isSpending(prediction) && days != null ? runwayLevel(days, rules) : null;

  let state = null, level = days == null ? "muted" : "good";
  if (status === "danger") { state = "empty"; level = "crit"; }
  else if (status === "warn") { state = "low"; level = etaLevel === "crit" ? "crit" : "warn"; }
  else if (etaLevel === "crit" || etaLevel === "warn") { state = "soon"; level = etaLevel; }
  if ((station?.noRenewal || station?.isOwn) && (level === "crit" || level === "warn")) level = "muted";
  return { state, level, days };
}

// 可用天数一格的字（§3.3）：余额用完时写「—」，只看档位名；其余按 formatDays（近期没有花费、算不出写「—」）。
// 运营总览「上游余量」、上游列表、余额趋势都用它，view 是 balanceViewOf 的结果。
/** @param {{ state: string | null, days: number | null } | null | undefined} view */
export function balanceDaysText(view) {
  return view?.state === "empty" ? EMPTY : formatDays(view?.days);
}

const LEVEL_RANK = { crit: 0, warn: 1 };

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
 * statusOf defaults to balanceStateOf; tests may pass a stub.
 * tz 是业务时区（接口返回的 tz），固定成本的开始日期按它算。
 *
 * @param {any[]} stations
 * @param {{ now?: number, tz?: string, rules?: any, settings?: any, statusOf?: (station: any, settings: any) => string, limit?: number, workflowActions?: any[] }} options
 */
export function buildOverviewActions(stations, {
  now = Date.now(),
  tz = DEFAULT_BUSINESS_TIME_ZONE,
  rules = {},
  settings = {},
  statusOf = balanceStateOf,
  limit = 5,
  workflowActions = [],
} = {}) {
  if (typeof statusOf !== "function") throw new TypeError("statusOf must be a function");

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

    const stationId = String(station.id || stationDisplayName(station));
    names.set(stationId, stationDisplayName(station));
    const common = { station, stationId, stationName: stationDisplayName(station) };

    if (station.type === "fixed") {
      // 标记为不再续费的资源不再提示续费或到期，但不会掩盖常规站点的查询失败。
      if (station.noRenewal) continue;
      const expiry = fixedExpiry(station, now, windowDays, tz);
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
    const hasEta = Number.isFinite(etaDays) && etaDays >= 0 && isSpending(station.prediction);
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
    // 哪些事项进总览、先后和是否紧急，都看 lib/workflow-actions.js 那张表。
    const todo = workflowTodo(action?.kind);
    if (!todo || !action.id || !action.href?.startsWith("/") || action.href.startsWith("//")) continue;
    const url = new URL(action.href, "https://workflow.invalid");
    if (!["/stations", "/reconciliation"].includes(url.pathname)) continue;
    url.searchParams.sort();
    const destination = `${action.kind}:${url.pathname}?${url.searchParams}`;
    if (ids.has(action.id) || destinations.has(destination)) continue;
    ids.add(action.id); destinations.add(destination);
    const candidate = {
      ...action, workflow: true, level: todo.urgent ? "crit" : "warn",
      priority: todo.order, urgency: 0, stationName: action.title || action.label,
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
