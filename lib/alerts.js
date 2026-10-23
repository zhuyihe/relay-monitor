// 余额提醒：按余额档位的变化推送，带冷却去重；没送达的按种类各留一份补发任务，最多补发 24 小时。
import { DEFAULT_RULES, alertRuleOfEvent, alertRuleOfState, resetNoRenewalAlertState } from "./alert-rules.js";
import { broadcast } from "./notify.js";
import { balanceStateOf } from "./overview-actions.js";

// 提醒规则表在 lib/alert-rules.js（告警中心页面也要用，那里不能引用这个带 node 依赖的文件）；这里接着导出，老的引用不用改
export { ALERT_EVENT_KEYS, DEFAULT_RULES } from "./alert-rules.js";

// 按事件键筛选目标渠道：未绑定（空数组）时发给所有启用渠道
export function channelsForEvent(channels, rules, key) {
  const ids = rules?.channelsFor?.[key];
  const bound = Array.isArray(ids) ? ids : [];
  return (channels || []).filter(
    (c) => c.enabled !== false && (!bound.length || bound.includes(c.id))
  );
}

// 不足一天用小时表述，避免出现「预计 0.3 天内耗尽」
export function fmtEta(days) {
  return days >= 1 ? `${days} 天` : `${Math.max(1, Math.round(days * 24))} 小时`;
}

const STATE_LABEL = {
  ok: "正常",
  warn: "余额偏低",
  danger: "余额耗尽",
  error: "查询失败",
};

function fmtUsd(n) {
  return "$" + Number(n ?? 0).toFixed(2);
}

// 推送用的余额档位：和页面同一个判断（lib/overview-actions.js balanceStateOf：提醒线用上游自己的，没填用全局的）。
// 还没读到余额时叫 unknown（库里 alertState.state 存的是这几个值，不改名）
export function stateOf(station, globalLowUsd) {
  const state = balanceStateOf(station, { lowBalanceUsd: globalLowUsd });
  return state === "pending" ? "unknown" : state;
}

function buildMessage(station, state, prediction) {
  const b = station.balance || {};
  const lines = [];
  lines.push(`站点：${station.name}`);
  lines.push(`状态：${STATE_LABEL[state] || state}`);
  if (b.ok) {
    lines.push(`剩余余额：${fmtUsd(b.remaining)}（已用 ${fmtUsd(b.used)} / 共 ${fmtUsd(b.total)}）`);
  } else if (b.error) {
    lines.push(`错误：${b.error}`);
  }
  if (prediction?.etaDays != null) {
    lines.push(`日均消耗：${fmtUsd(prediction.burnPerDay)}/天，预计 ${fmtEta(prediction.etaDays)}后耗尽`);
  }
  if (station.noRenewal) {
    lines.push("续费计划：不再续费（余额提醒仅此一次）");
  }
  lines.push(`时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  return lines.join("\n");
}

// 提醒标题，只有这一处（新发的和补发的都用）。kind：state 余额档位变了、repeat 持续没处理、recover 恢复、
// eta 快用完、noRenewalLow 不再续费的上游第一次偏低；state 是这条提醒说的余额档位
function alertTitle(kind, station, state, prediction) {
  if (kind === "noRenewalLow") return `【低余额提醒】${station.name} 已进入不再续费阶段`;
  if (kind === "eta") return `【耗尽预警】${station.name}${prediction?.etaDays != null ? ` 预计 ${fmtEta(prediction.etaDays)}内耗尽` : ""}`;
  if (kind === "recover") return `【恢复通知】${station.name} 已恢复正常`;
  if (kind === "repeat") return `【持续告警】${station.name} 仍处于「${STATE_LABEL[state]}」`;
  return `【中转站告警】${station.name} ${STATE_LABEL[state]}`;
}

// ---- 补发 -------------------------------------------------------------------------------------
// 每件事一份记录（alertState.incidents），按种类分开、互不抢占（一个通知方式一直发不出去，也挡不住别的提醒）。
// 一件事 = 同一种提醒说的同一种情况：余额偏低、余额用完、读不到余额、恢复正常、快用完、不再续费的单次提醒各算一种。
// 情况一直在，或者离开不到 24 小时又回来，都算同一件事；离开满 24 小时再出现才是新的一件事。
//   离开：那种情况不在了（余额不在那一档、关掉了这种提醒、不再算快用完、改了「不再续费」），读不到余额的那段时间也算；
//   「读不到余额」本身没到连续次数时不算离开也不算在。恢复正常：上游一直正常，也算这件事还在。
// 一件事第一次发出的那一条（不管是第一次提醒还是持续告警）没送到才补：间隔 1、2、4…分钟，封顶 1 小时，
// 从第一次发出起最多补 24 小时，离开的那段时间不补、照样算在 24 小时里。之后同一件事再发的（重复提醒、回到这一档时的提醒）
// 每次只发一次，没送到也不另外补；收到的不再补第一条，没收到的这次也算补过一次。
// 只补给这种提醒现在还会发给它、第一次就要发但还没收到的通知方式，按 id 认：改了配置的照样补；后来加的不补；
// 停用的、从这种提醒里去掉的，每一轮都划掉，再启用也不补。没有可用的通知方式时不算发过，也不攒。
// 记录：{ kind, state, eventKey, firstAttemptAt, remaining: [通知方式 id], attempts, retryAt, leftAt }，只存 id，不存配置和登录信息。
const RETRY_BASE_MS = 60000;
const RETRY_MAX_MS = 3600000;
const RETRY_WINDOW_MS = 24 * 3600000;
const INCIDENT_GAP_MS = 24 * 3600000;
const retryDelay = (attempts) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
// 一件事的键：余额提醒那几种就是事件键（low / exhaust / error / recover），另外两种是 eta、noRenewalLow
const incidentKeyOf = (kind, eventKey) => (kind === "noRenewalLow" ? "noRenewalLow" : eventKey);

// 读回存着的记录；格式不对的不要
function storedIncidents(state) {
  const raw = state?.incidents;
  const incidents = {};
  if (!raw || typeof raw !== "object") return incidents;
  for (const [key, item] of Object.entries(raw)) {
    const known = key === "eta" || key === "noRenewalLow" || !!alertRuleOfEvent(key)?.state;
    if (known && item && typeof item.kind === "string" && typeof item.eventKey === "string" && typeof item.state === "string"
      && Array.isArray(item.remaining) && item.remaining.every((id) => typeof id === "string")
      && [item.firstAttemptAt, item.attempts, item.retryAt].every(Number.isFinite)
      && (item.leftAt == null || Number.isFinite(item.leftAt))) incidents[key] = item;
  }
  return incidents;
}

// 余额提醒（偏低、用完、读不到余额、恢复正常）这一种该不该发，新发和补发都按这一个判断：
// 规则开着；不再续费的上游，偏低和用完只走那一次单次提醒
function stateAlertOn(station, rules, ev) {
  const rule = alertRuleOfEvent(ev);
  return !!rule && !!rules[rule.key] && !(station.noRenewal && (ev === "low" || ev === "exhaust"));
}

// 快用完该不该提醒，新发和补发都按这一个判断：不再续费的不提醒；读不到余额、余额已经用完的不提醒（§10 的例外）
function etaApplies(station, prediction, rules, rawState) {
  return !station.noRenewal && !!rules.onEta && rawState !== "error" && rawState !== "danger"
    && prediction?.etaDays != null && prediction.etaDays <= rules.etaDays;
}

// 不再续费的上游那一次余额提醒该不该发：偏低或用完（直接从正常跳到用完也算），新发和补发都按这一个判断
function noRenewalLowApplies(station, rules, rawState) {
  return !!station.noRenewal && !!rules.onLow && (rawState === "warn" || rawState === "danger");
}

// 这一轮这件事在不在：在 true、不在 false（读不到余额的那段时间，别的几种都算不在）；
// 「读不到余额」本身没到连续次数时判断不了，返回 null
function incidentHolds(key, station, prediction, rules, rawState, errorCount, threshold) {
  if (key === "error") {
    if (rawState !== "error") return false;
    return errorCount >= threshold ? stateAlertOn(station, rules, "error") : null;
  }
  if (key === "eta") return etaApplies(station, prediction, rules, rawState);
  if (key === "noRenewalLow") return noRenewalLowApplies(station, rules, rawState);
  return stateAlertOn(station, rules, key) && rawState === alertRuleOfEvent(key)?.state;
}

// webhook 收到的 event（给机器读的，不改）
const eventName = (kind, state) => (kind === "noRenewalLow" ? "warn" : kind === "eta" ? "eta" : state);

/**
 * 评估一个上游的余额提醒。
 * alertState 由调用方持久化在 station 记录上：
 * { state, errorCount, notifiedAt, etaNotifiedAt, noRenewalLowNotifiedAt, incidents, lastResults }
 * notifiedAt 这几个是那种提醒上一次发出的时间（不论送没送到），重复提醒从它起算；incidents 见上面「补发」。
 * 返回需要更新的 alertState；没有变化返回 null。
 */
export async function evaluateStation(station, prediction, rules, channels, globalLowUsd) {
  if (station.monitorEnabled === false || station.archivedAt) return null;
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  const now = Date.now();
  const noRenewal = !!station.noRenewal;
  const prev = station.alertState || { state: "unknown", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0 };
  const rawState = stateOf(station, globalLowUsd);
  if (rawState === "unknown") return null;

  let next = { ...prev };
  // 连续读不到的次数：只有 error 累加，其余清零
  next.errorCount = rawState === "error" ? (prev.errorCount || 0) + 1 : 0;

  // 次数没到阈值前不算「读不到余额」——沿用旧档位，既不误报，也不在恢复时误发「恢复通知」
  const threshold = Math.max(1, Math.floor(Number(r.errorThreshold) || 1));
  const state = (rawState === "error" && next.errorCount < threshold) ? prev.state : rawState;
  const stateConfirmed = state === rawState && (rawState !== "error" || next.errorCount >= threshold);
  next.state = state;
  // 这一轮新发的提醒：{ kind, state, eventKey }。给谁发、什么时候发只看这里，补发不影响
  let notify = null;

  const isBad = ["warn", "danger", "error"].includes(state);
  const wasBad = ["warn", "danger", "error"].includes(prev.state);
  const renotifyDue = (at) => r.renotifyHours > 0 && now - (at || 0) > r.renotifyHours * 3600000;
  const eventOf = (s) => alertRuleOfState(s)?.ev;
  const alertOn = (ev) => stateAlertOn(station, r, ev);

  if (noRenewalLowApplies(station, r, rawState) && !prev.noRenewalLowNotifiedAt) {
    // 不再续费的上游只发一次余额提醒；读不到余额照常提醒，免得登录信息失效、上游出故障时没人知道
    notify = { kind: "noRenewalLow", state: rawState, eventKey: "low" };
  } else if (stateConfirmed && isBad && state !== prev.state && alertOn(eventOf(state))) {
    notify = { kind: "state", state, eventKey: eventOf(state) };
  } else if (stateConfirmed && isBad && state === prev.state && alertOn(eventOf(state)) && renotifyDue(prev.notifiedAt)) {
    notify = { kind: "repeat", state, eventKey: eventOf(state) };
  } else if (state === "ok" && (station.noRenewal ? prev.state === "error" : wasBad) && alertOn("recover")) {
    // 不再续费的上游只在读不到余额恢复后提醒（充了值不算）
    notify = { kind: "recover", state: "ok", eventKey: "recover" };
  }

  // 快用完（独立去重；余额没偏低但花得太快也要提醒）。renotifyHours = 0 表示只提醒一次，与上面持续告警的语义一致
  if (!notify && etaApplies(station, prediction, r, rawState) && (!prev.etaNotifiedAt || renotifyDue(prev.etaNotifiedAt))) {
    notify = { kind: "eta", state, eventKey: "eta" };
  }

  // 每件事的记录。#42 存的 pendingDelivery（只有一份、没记第一次发出的时间，套不上 24 小时上限）升级后丢掉，见 PR 说明
  const incidents = storedIncidents(prev);
  delete next.pendingDelivery;
  const targetIds = (eventKey) => new Set(channelsForEvent(channels, r, eventKey).map((channel) => channel.id));
  const notifyKey = notify ? incidentKeyOf(notify.kind, notify.eventKey) : null;
  const sends = []; // 这一轮要发的：补发 { key, incident, recipients } 和新提醒 { key, notify, recipients }
  for (const [key, incident] of Object.entries(incidents)) {
    // 停用的、从这种提醒里去掉的通知方式，每一轮都划掉
    const ids = targetIds(incident.eventKey);
    const remaining = incident.remaining.filter((id) => ids.has(id));
    // 离开满 24 小时：这件事结束。先看存着的离开时间：中间停机、暂停监控没有刷新，回来时又在也不算同一件事
    if (incident.leftAt != null && now - incident.leftAt >= INCIDENT_GAP_MS) { delete incidents[key]; continue; }
    const holds = incidentHolds(key, station, prediction, r, rawState, next.errorCount, threshold);
    const leftAt = holds === true ? null : holds === false ? (incident.leftAt ?? now) : incident.leftAt ?? null;
    incidents[key] = { ...incident, remaining, leftAt };
    if (holds !== true || !remaining.length || key === notifyKey || now < incident.retryAt || now - incident.firstAttemptAt >= RETRY_WINDOW_MS) continue;
    sends.push({ key, incident: incidents[key], recipients: channelsForEvent(channels, r, incident.eventKey).filter((channel) => remaining.includes(channel.id)) });
  }

  if (notify) {
    // 记下这次发出的时间，不论送没送到：重复提醒从这里起算
    if (notify.kind === "noRenewalLow") next.noRenewalLowNotifiedAt = now;
    else if (notify.kind === "eta") next.etaNotifiedAt = now;
    else next.notifiedAt = now;
    const targets = channelsForEvent(channels, r, notify.eventKey);
    // 没有可用的通知方式时不发、不攒、也不算这件事发过：加上通知方式后也不补发这一条
    if (targets.length) sends.push({ key: notifyKey, notify, recipients: targets });
  }

  // 补发和新提醒一起发：一个通知方式连不上，只等它自己那一次的超时，不拖后别的
  const outcomes = await Promise.all(sends.map(async (item) => {
    const { kind, state: alertState } = item.notify || item.incident;
    const sent = await broadcast(item.recipients, alertTitle(kind, station, alertState, prediction), buildMessage(station, state, prediction), {
      event: eventName(kind, alertState),
      station: { id: station.id, name: station.name, type: station.type },
      remaining: station.balance?.remaining ?? null,
    });
    return { ...item, sent };
  }));

  // 补过一次（或者同一件事又发了一条）：收到的不再补；这次试过又没收到的，退避后再补；补满 24 小时就不再补
  const tried = (key, recipients, delivered) => {
    const incident = incidents[key];
    const attemptedIds = new Set(recipients.map((channel) => channel.id));
    const remaining = incident.remaining.filter((id) => !delivered.has(id));
    if (!incident.remaining.some((id) => attemptedIds.has(id))) return;
    const attempts = incident.attempts + 1;
    const retryAt = Date.now() + retryDelay(attempts);
    const expired = retryAt - incident.firstAttemptAt >= RETRY_WINDOW_MS;
    incidents[key] = { ...incident, remaining: expired ? [] : remaining, attempts, retryAt };
  };
  const results = [];
  for (const { key, notify: fresh, recipients, sent } of outcomes) {
    results.push(...sent);
    const delivered = new Set(recipients.filter((_, index) => sent[index]?.ok).map((channel) => channel.id));
    if (!fresh || incidents[key]) tried(key, recipients, delivered);
    else {
      // 这件事第一次发出：没收到的从 1 分钟起补
      incidents[key] = { kind: fresh.kind, state: fresh.state, eventKey: fresh.eventKey, firstAttemptAt: now,
        remaining: recipients.filter((channel) => !delivered.has(channel.id)).map((channel) => channel.id),
        attempts: 1, retryAt: Date.now() + retryDelay(1), leftAt: null };
    }
  }

  if (Object.keys(incidents).length) next.incidents = incidents;
  else delete next.incidents;
  if (results.length) next.lastResults = results.map((x) => ({ name: x.name, ok: x.ok, error: x.error || null }));
  // 发送期间改了「不再续费」：store 已经清掉单次提醒的记录，这里照同一个做法清，不把旧的写回去
  if (!!station.noRenewal !== noRenewal) next = resetNoRenewalAlertState(next);

  // 档位、发出时间、失败次数或记录有变化才需要写回
  const changed = next.state !== prev.state || next.notifiedAt !== prev.notifiedAt || next.etaNotifiedAt !== prev.etaNotifiedAt
    || next.noRenewalLowNotifiedAt !== prev.noRenewalLowNotifiedAt || next.errorCount !== (prev.errorCount || 0)
    || JSON.stringify(next.incidents) !== JSON.stringify(prev.incidents) || "pendingDelivery" in prev;
  return changed ? next : null;
}
