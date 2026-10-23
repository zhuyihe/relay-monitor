// 余额提醒：按余额档位的变化推送，带冷却去重；没送达的按种类各留一份补发任务，最多补发 24 小时。
import { DEFAULT_RULES, alertRuleOfEvent, alertRuleOfState } from "./alert-rules.js";
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
// 没送达的提醒按种类各留一份补发任务，互不抢占（一个通知方式一直发不出去，也挡不住别的提醒）：
//   state 余额档位变了、持续没处理、恢复（同一时间只会有一件），eta 快用完，noRenewalLow 不再续费的单次提醒。
// 只补发给第一次就在目标里、还没收到的通知方式，按 id 认：改了配置的照样补，后来加的不补。
// 间隔 1、2、4…分钟，封顶 1 小时；从第一次发出起最多补 24 小时，之后回到重复提醒的节奏（renotifyHours，从第一次发出起算）。
// 没有可用的通知方式时不建任务，加上通知方式后也不补发旧的。
// 任务：{ kind, state, eventKey, remaining: [通知方式 id], firstAttemptAt, attempts, retryAt }，只存 id，不存配置和登录信息。
const RETRY_BASE_MS = 60000;
const RETRY_MAX_MS = 3600000;
const RETRY_WINDOW_MS = 24 * 3600000;
const SLOTS = ["state", "eta", "noRenewalLow"];
const slotOf = (kind) => (kind === "eta" || kind === "noRenewalLow" ? kind : "state");
const retryDelay = (attempts) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));

// 读回存着的补发任务；格式不对的不要
function storedTasks(state) {
  const raw = state?.pendingDeliveries;
  const tasks = {};
  if (!raw || typeof raw !== "object") return tasks;
  for (const slot of SLOTS) {
    const task = raw[slot];
    if (task && typeof task.kind === "string" && typeof task.eventKey === "string" && Array.isArray(task.remaining)
      && [task.firstAttemptAt, task.attempts, task.retryAt].every(Number.isFinite)) tasks[slot] = task;
  }
  return tasks;
}

// 补发任务说的那件事还在不在：余额还是那一档、规则还开着。不在了就不补
function stillDue(slot, task, station, prediction, rules, rawState, errorCount, threshold) {
  if (slot === "noRenewalLow") return !!station.noRenewal && !!rules.onLow && (rawState === "warn" || rawState === "danger");
  if (slot === "eta") {
    return !station.noRenewal && !!rules.onEta && rawState !== "error" && rawState !== "danger"
      && prediction?.etaDays != null && prediction.etaDays <= rules.etaDays;
  }
  const rule = alertRuleOfEvent(task.eventKey);
  if (!rule?.state || !rules[rule.key] || rawState !== rule.state) return false;
  // 不再续费的上游，偏低和用完只走那一次单次提醒
  if (station.noRenewal && (rule.ev === "low" || rule.ev === "exhaust")) return false;
  return rawState !== "error" || errorCount >= threshold;
}

// webhook 收到的 event（给机器读的，不改）
const eventName = (kind, state) => (kind === "noRenewalLow" ? "warn" : kind === "eta" ? "eta" : state);

/**
 * 评估一个上游的余额提醒。
 * alertState 由调用方持久化在 station 记录上：
 * { state, errorCount, notifiedAt, etaNotifiedAt, noRenewalLowNotifiedAt, pendingDeliveries, lastResults }
 * notifiedAt 这几个是那种提醒最近一次第一次发出的时间（不论送没送到），重复提醒从它起算。
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

  const next = { ...prev };
  // 连续读不到的次数：只有 error 累加，其余清零
  next.errorCount = rawState === "error" ? (prev.errorCount || 0) + 1 : 0;

  // 次数没到阈值前不算「读不到余额」——沿用旧档位，既不误报，也不在恢复时误发「恢复通知」
  const threshold = Math.max(1, Math.floor(Number(r.errorThreshold) || 1));
  const state = (rawState === "error" && next.errorCount < threshold) ? prev.state : rawState;
  const stateConfirmed = state === rawState && (rawState !== "error" || next.errorCount >= threshold);
  next.state = state;
  let notify = null; // 这一轮新发的提醒：{ kind, state, eventKey }

  const isBad = ["warn", "danger", "error"].includes(state);
  const wasBad = ["warn", "danger", "error"].includes(prev.state);
  const renotifyDue = (at) => r.renotifyHours > 0 && now - (at || 0) > r.renotifyHours * 3600000;
  // 档位对应的规则开没开、走哪个事件键（每种提醒单独选发到哪些通知方式，channelsFor）
  const ruleOn = (s) => !!r[alertRuleOfState(s)?.key];
  const eventOf = (s) => alertRuleOfState(s)?.ev;

  if (station.noRenewal) {
    // 不再续费的上游只发一次余额提醒：直接从正常跳到用完也按偏低那一次提醒算。
    // 读不到余额照常提醒，免得登录信息失效、上游出故障时没人知道。
    const isLowBalance = rawState === "warn" || rawState === "danger";
    if (isLowBalance && r.onLow && !prev.noRenewalLowNotifiedAt) {
      notify = { kind: "noRenewalLow", state: rawState, eventKey: "low" };
    } else if (stateConfirmed && state === "error" && state !== prev.state && r.onError) {
      notify = { kind: "state", state: "error", eventKey: "error" };
    } else if (stateConfirmed && state === "error" && state === prev.state && r.onError && renotifyDue(prev.notifiedAt)) {
      notify = { kind: "repeat", state: "error", eventKey: "error" };
    } else if (state === "ok" && prev.state === "error" && r.onRecover) {
      notify = { kind: "recover", state: "ok", eventKey: "recover" };
    }
  } else {
    if (stateConfirmed && isBad && state !== prev.state && ruleOn(state)) {
      notify = { kind: "state", state, eventKey: eventOf(state) };
    } else if (stateConfirmed && isBad && state === prev.state && ruleOn(state) && renotifyDue(prev.notifiedAt)) {
      notify = { kind: "repeat", state, eventKey: eventOf(state) };
    } else if (state === "ok" && wasBad && r.onRecover) {
      notify = { kind: "recover", state: "ok", eventKey: "recover" };
    }
  }

  // 快用完（独立去重；余额没偏低但花得太快也要提醒）。余额已经用完时不再推（原来会补推「预计 1 小时内耗尽」，透支的上游一直推）。
  // renotifyHours = 0 表示只提醒一次，与上面持续告警的语义一致
  if (!station.noRenewal && !notify && r.onEta && rawState !== "error" && rawState !== "danger" && prediction?.etaDays != null &&
      prediction.etaDays <= r.etaDays && (!prev.etaNotifiedAt || renotifyDue(prev.etaNotifiedAt))) {
    notify = { kind: "eta", state, eventKey: "eta" };
  }

  // 补发任务。#42 存的是只有一份的 pendingDelivery，没记第一次发出的时间、套不上 24 小时上限：升级后不再补发，
  // 那件事还没好的，下一轮按重复提醒的节奏重新发
  const tasks = storedTasks(prev);
  delete next.pendingDelivery;
  // 读不到余额、还没到连续失败次数：先停着，等重新读到余额再说（不发、不丢）
  const awaitingBalance = rawState === "error" && next.errorCount < threshold;
  const due = [];
  for (const slot of SLOTS) {
    const task = tasks[slot];
    if (!task) continue;
    // 补满 24 小时；或者同一种提醒这一轮重新发给所有目标，旧任务作废
    if (now - task.firstAttemptAt >= RETRY_WINDOW_MS || notify && slotOf(notify.kind) === slot) { delete tasks[slot]; continue; }
    if (awaitingBalance && task.eventKey !== "error") continue;
    if (!stillDue(slot, task, station, prediction, r, rawState, next.errorCount, threshold)) { delete tasks[slot]; continue; }
    if (now < task.retryAt) continue;
    const recipients = channelsForEvent(channels, r, task.eventKey).filter((channel) => task.remaining.includes(channel.id));
    if (!recipients.length) { delete tasks[slot]; continue; }
    due.push({ slot, task, recipients });
  }

  const results = [];
  const send = async (kind, alertState, recipients) => {
    const sent = await broadcast(recipients, alertTitle(kind, station, alertState, prediction), buildMessage(station, state, prediction), {
      event: eventName(kind, alertState),
      station: { id: station.id, name: station.name, type: station.type },
      remaining: station.balance?.remaining ?? null,
    });
    results.push(...sent);
    return recipients.filter((_, index) => !sent[index]?.ok).map((channel) => channel.id);
  };

  // 先补发旧的，再发新的
  for (const { slot, task, recipients } of due) {
    const failed = new Set(await send(task.kind, task.state, recipients));
    const delivered = new Set(recipients.map((channel) => channel.id).filter((id) => !failed.has(id)));
    const remaining = task.remaining.filter((id) => !delivered.has(id));
    const attempts = task.attempts + 1;
    const retryAt = Date.now() + retryDelay(attempts);
    if (remaining.length && retryAt - task.firstAttemptAt < RETRY_WINDOW_MS) tasks[slot] = { ...task, remaining, attempts, retryAt };
    else delete tasks[slot];
  }

  if (notify) {
    // 记下这次发出的时间，不论送没送到：重复提醒从这里起算
    if (notify.kind === "noRenewalLow") next.noRenewalLowNotifiedAt = now;
    else if (notify.kind === "eta") next.etaNotifiedAt = now;
    else next.notifiedAt = now;
    const targets = channelsForEvent(channels, r, notify.eventKey);
    // 没有可用的通知方式时不发、不攒：加上通知方式后也不补发这一条
    if (targets.length) {
      const remaining = await send(notify.kind, notify.state, targets);
      if (remaining.length) {
        tasks[slotOf(notify.kind)] = { kind: notify.kind, state: notify.state, eventKey: notify.eventKey, remaining,
          firstAttemptAt: now, attempts: 1, retryAt: Date.now() + retryDelay(1) };
      }
    }
  }

  // 发送期间改了「不再续费」：store 已经清掉单次提醒的记录（db/store.js resetNoRenewalAlertState），这里照着清，不把旧的写回去
  if (!!station.noRenewal !== noRenewal) {
    delete next.noRenewalLowNotifiedAt;
    delete tasks.noRenewalLow;
  }

  if (Object.keys(tasks).length) next.pendingDeliveries = tasks;
  else delete next.pendingDeliveries;
  if (results.length) next.lastResults = results.map((x) => ({ name: x.name, ok: x.ok, error: x.error || null }));

  // 档位、发出时间、失败次数或补发任务有变化才需要写回
  const changed = next.state !== prev.state || next.notifiedAt !== prev.notifiedAt || next.etaNotifiedAt !== prev.etaNotifiedAt
    || next.noRenewalLowNotifiedAt !== prev.noRenewalLowNotifiedAt || next.errorCount !== (prev.errorCount || 0)
    || JSON.stringify(next.pendingDeliveries) !== JSON.stringify(prev.pendingDeliveries) || "pendingDelivery" in prev;
  return changed ? next : null;
}
