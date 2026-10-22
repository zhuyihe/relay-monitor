// 告警引擎：按状态迁移触发通知，带冷却去重
import { broadcast } from "./notify.js";

// 告警事件键：每类通知可单独绑定推送渠道（channelsFor）
export const ALERT_EVENT_KEYS = ["low", "exhaust", "error", "recover", "eta"];

export const DEFAULT_RULES = {
  onLow: true, // 余额低于阈值
  onExhaust: true, // 余额耗尽
  onError: true, // 查询失败
  onRecover: true, // 恢复正常
  onEta: true, // 预计耗尽天数过近
  etaDays: 3, // 预计 N 天内耗尽则告警（内部统一按天存储，支持小数）
  etaUnit: "days", // 界面展示单位：days | hours
  renotifyHours: 24, // 同一异常状态的重复提醒间隔
  errorThreshold: 1, // 查询连续失败达到该次数才通知（1 = 首次失败即通知）
  errorRetrySec: 30, // 查询失败后隔 N 秒立即重试一次（0 = 关闭快速重试，等下次轮询）
  // 每类告警的推送渠道 id 列表；空数组 = 所有启用渠道（与日报 channelIds 同语义）
  channelsFor: { low: [], exhaust: [], error: [], recover: [], eta: [] },
};

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

// 服务器端状态判定（与前端 statusOf 一致）
export function stateOf(station, globalLowUsd) {
  const b = station.balance;
  if (!b) return "unknown";
  if (!b.ok) return "error";
  const th = station.lowBalanceUsd != null ? Number(station.lowBalanceUsd) : Number(globalLowUsd);
  if (b.remaining <= 0) return "danger";
  if (b.remaining < th) return "warn";
  return "ok";
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

const DELIVERY_RETRY_BASE_MS = 60000;
const DELIVERY_RETRY_MAX_MS = 3600000;
const deliveryKind = (notify) => notify.isNoRenewalLow ? "noRenewalLow" : notify.isEta ? "eta" : "state";
// 只存渠道身份和配置版本，不对包含密码的配置做摘要，也不在告警状态里复制登录信息。
const deliveryTarget = (channel) => JSON.stringify([channel.id, channel.type, channel.deliveryVersion || 1]);
const deliveryTargets = (channels) => channels.map(deliveryTarget).sort();
const sameDelivery = (a, b) => deliveryKind(a) === deliveryKind(b) && a.eventKey === b.eventKey;

function pendingNotification(pending, station, prediction, rules, rawState, errorCount, threshold, awaitingBalance = false) {
  if (!pending || !Array.isArray(pending.targetKeys) || !Array.isArray(pending.remainingKeys) || !Array.isArray(pending.deliveredKeys)) return null;
  if (pending.kind === "noRenewalLow") {
    return station.noRenewal && rules.onLow && ["warn", "danger"].includes(rawState)
      ? { title: `【低余额提醒】${station.name} 已进入不再续费阶段`, isNoRenewalLow: true, eventKey: "low" } : null;
  }
  if (pending.kind === "eta") {
    return !station.noRenewal && rules.onEta && rawState !== "error" && (awaitingBalance || prediction?.etaDays != null && prediction.etaDays <= rules.etaDays)
      ? { title: `【耗尽预警】${station.name}${prediction?.etaDays != null ? ` 预计 ${fmtEta(prediction.etaDays)}内耗尽` : ""}`, isEta: true, eventKey: "eta" } : null;
  }
  if (pending.kind !== "state") return null;
  const states = { low: "warn", exhaust: "danger", error: "error", recover: "ok" };
  const enabled = { low: rules.onLow && !station.noRenewal, exhaust: rules.onExhaust && !station.noRenewal, error: rules.onError, recover: rules.onRecover };
  if (!enabled[pending.eventKey] || rawState !== states[pending.eventKey] || rawState === "error" && errorCount < threshold) return null;
  return { title: pending.eventKey === "recover" ? `【恢复通知】${station.name} 已恢复正常`
    : `【中转站告警】${station.name} ${STATE_LABEL[rawState]}`, eventKey: pending.eventKey };
}

/**
 * 评估一个中转站的告警。
 * alertState 由调用方持久化在 station 记录上：
 * { state, notifiedAt, etaNotifiedAt, noRenewalLowNotifiedAt, pendingDelivery }
 * 返回需要更新的 alertState，若无需通知返回 null 表示状态未变。
 */
export async function evaluateStation(station, prediction, rules, channels, globalLowUsd) {
  if (station.monitorEnabled === false || station.archivedAt) return null;
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  const now = Date.now();
  const originalAlertState = station.alertState, noRenewal = !!station.noRenewal;
  const prev = station.alertState || { state: "unknown", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0 };
  const rawState = stateOf(station, globalLowUsd);
  if (rawState === "unknown") return null;

  const next = { ...prev };
  // 连续查询失败计数：仅 error 累加，其余状态清零
  next.errorCount = rawState === "error" ? (prev.errorCount || 0) + 1 : 0;

  // 失败次数未达阈值前不视为「查询失败」异常——沿用旧状态，
  // 这样既不会误报，也不会在恢复时误发「恢复通知」
  const threshold = Math.max(1, Math.floor(Number(r.errorThreshold) || 1));
  const state = (rawState === "error" && next.errorCount < threshold) ? prev.state : rawState;
  const stateConfirmed = state === rawState && (rawState !== "error" || next.errorCount >= threshold);
  next.state = state;
  let notify = null; // {title}

  const isBad = ["warn", "danger", "error"].includes(state);
  const wasBad = ["warn", "danger", "error"].includes(prev.state);
  const ruleFor = { warn: r.onLow, danger: r.onExhaust, error: r.onError };

  // 每类告警按 eventKey 单独绑定推送渠道（channelsFor）
  const keyFor = { warn: "low", danger: "exhaust", error: "error" };

  if (station.noRenewal) {
    // 不再续费的站点只发一次余额提醒：直接从正常跳到耗尽也按低余额提醒处理。
    // 查询失败仍按常规策略通知，避免凭证失效或站点离线被静默。
    const isLowBalance = rawState === "warn" || rawState === "danger";
    if (isLowBalance && r.onLow && !prev.noRenewalLowNotifiedAt) {
      notify = { title: `【低余额提醒】${station.name} 已进入不再续费阶段`, isNoRenewalLow: true, eventKey: "low" };
    } else if (stateConfirmed && state === "error" && state !== prev.state && r.onError) {
      notify = { title: `【中转站告警】${station.name} ${STATE_LABEL.error}`, eventKey: "error" };
    } else if (stateConfirmed && state === "error" && state === prev.state && r.onError && r.renotifyHours > 0 &&
               now - (prev.notifiedAt || 0) > r.renotifyHours * 3600000) {
      notify = { title: `【持续告警】${station.name} 仍处于「${STATE_LABEL.error}」`, eventKey: "error" };
    } else if (state === "ok" && prev.state === "error" && r.onRecover) {
      notify = { title: `【恢复通知】${station.name} 已恢复正常`, eventKey: "recover" };
    }
  } else {
    if (stateConfirmed && isBad && state !== prev.state && ruleFor[state]) {
      notify = { title: `【中转站告警】${station.name} ${STATE_LABEL[state]}`, eventKey: keyFor[state] };
    } else if (stateConfirmed && isBad && state === prev.state && ruleFor[state] && r.renotifyHours > 0 &&
               now - (prev.notifiedAt || 0) > r.renotifyHours * 3600000) {
      notify = { title: `【持续告警】${station.name} 仍处于「${STATE_LABEL[state]}」`, eventKey: keyFor[state] };
    } else if (state === "ok" && wasBad && r.onRecover) {
      notify = { title: `【恢复通知】${station.name} 已恢复正常`, eventKey: "recover" };
    }
  }

  // 预计耗尽告警（独立去重；状态正常但烧钱太快也要提醒）
  // renotifyHours = 0 表示只提醒一次，与上面持续告警的语义一致
  if (!station.noRenewal && !notify && r.onEta && rawState !== "error" && prediction?.etaDays != null &&
      prediction.etaDays <= r.etaDays &&
      (!prev.etaNotifiedAt ||
        (r.renotifyHours > 0 && now - prev.etaNotifiedAt > r.renotifyHours * 3600000))) {
    notify = { title: `【耗尽预警】${station.name} 预计 ${fmtEta(prediction.etaDays)}内耗尽`, isEta: true, eventKey: "eta" };
  }

  // 未送达的提醒独立于重复提醒间隔；即使 renotifyHours=0，也应补发失败渠道。
  const pending = prev.pendingDelivery;
  // 未达错误阈值的暂时不可读不是已确认的余额变化：暂停原任务，等重新读到余额再继续。
  const awaitingBalance = rawState === "error" && next.errorCount < threshold && pending?.eventKey !== "error";
  const retry = pendingNotification(pending, station, prediction, r, awaitingBalance ? prev.state : rawState, next.errorCount, threshold, awaitingBalance);
  let retrying = null;
  delete next.pendingDelivery;
  // 已有成功收件人的普通提醒到期后开启新周期；尚未送达的整轮任务继续退避，不能每次从零开始。
  const repeatDue = retry && notify && sameDelivery(notify, retry) && !notify.isNoRenewalLow && pending.deliveredKeys.length > 0
    && r.renotifyHours > 0 && now - (notify.isEta ? prev.etaNotifiedAt || 0 : prev.notifiedAt || 0) > r.renotifyHours * 3600000;
  if (retry && !repeatDue && (!notify || sameDelivery(notify, retry) || notify.isEta && !retry.isEta)) {
    const currentTargets = deliveryTargets(channelsForEvent(channels, r, retry.eventKey));
    const sameTargets = JSON.stringify(currentTargets) === JSON.stringify(pending.targetKeys);
    if (awaitingBalance) {
      if (sameTargets) next.pendingDelivery = pending;
      notify = null;
    } else if (sameTargets) {
      notify = retry;
      retrying = pending;
    } else if (!pending.deliveredKeys.length) {
      // 从未送达（包括原来没有渠道）且当前仍需提醒：按现在的目标重新建立任务。
      notify = retry;
    }
    // 已有渠道收到了提醒后，目标变化会取消旧任务；不把旧提醒补到新收件人。
  }

  if (notify && retrying && now < retrying.retryAt) {
    next.pendingDelivery = retrying;
  } else if (notify) {
    const targets = channelsForEvent(channels, r, notify.eventKey);
    const recipients = retrying ? targets.filter((channel) => retrying.remainingKeys.includes(deliveryTarget(channel))) : targets;
    const targetKeys = deliveryTargets(targets);
    const body = buildMessage(station, state, prediction);
    const results = await broadcast(recipients, notify.title, body, {
      event: notify.isNoRenewalLow ? "warn" : notify.isEta ? "eta" : state,
      station: { id: station.id, name: station.name, type: station.type },
      remaining: station.balance?.remaining ?? null,
    });
    // 发送期间续费计划、余额状态或去重状态被修改时，不把过期任务写回、复活。
    if (station.monitorEnabled === false || station.archivedAt || !!station.noRenewal !== noRenewal
      || station.alertState !== originalAlertState || stateOf(station, globalLowUsd) !== rawState
      || JSON.stringify(deliveryTargets(channelsForEvent(channels, r, notify.eventKey))) !== JSON.stringify(targetKeys)) return null;
    const succeeded = results.some((result) => result.ok);
    const deliveredAt = Date.now();
    if (succeeded && !retrying?.deliveredKeys.length) {
      if (notify.isNoRenewalLow) next.noRenewalLowNotifiedAt = deliveredAt;
      else if (notify.isEta) next.etaNotifiedAt = deliveredAt;
      else next.notifiedAt = deliveredAt;
    }
    const remainingKeys = recipients.filter((_, index) => !results[index]?.ok).map(deliveryTarget).sort();
    if (remainingKeys.length || !targets.length) {
      const attempts = (retrying?.attempts || 0) + 1;
      next.pendingDelivery = { kind: deliveryKind(notify), eventKey: notify.eventKey, targetKeys, remainingKeys,
        deliveredKeys: [...(retrying?.deliveredKeys || []), ...recipients.filter((_, index) => results[index]?.ok).map(deliveryTarget)].sort(),
        attempts, retryAt: deliveredAt + Math.min(DELIVERY_RETRY_MAX_MS, DELIVERY_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6)) };
    }
    next.lastResults = results.map((x) => ({ name: x.name, ok: x.ok, error: x.error || null }));
  }

  // 状态、通知时间或失败计数有变化才需要持久化
  if (next.state !== prev.state || next.notifiedAt !== prev.notifiedAt ||
      next.etaNotifiedAt !== prev.etaNotifiedAt ||
      next.noRenewalLowNotifiedAt !== prev.noRenewalLowNotifiedAt ||
      JSON.stringify(next.pendingDelivery) !== JSON.stringify(prev.pendingDelivery) ||
      next.errorCount !== (prev.errorCount || 0)) {
    return next;
  }
  return null;
}
