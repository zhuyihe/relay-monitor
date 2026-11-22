// 首页只读本地结果：用户快照、已记录的整站消费日志、固定账本及后台对账缓存。
// 不因进入首页补历史、不请求主站；没有完整覆盖的消费账单不拿用户用量替代。
import { businessTimeZone, dayKeyInTz, dayStartInTz, shiftDayLabel } from "../lib/business-time.js";
import { rateSnapshotOf } from "../lib/profit.js";
import { consumeLogOffOverlap } from "../lib/consume-log.js";
import { OWN_LOG_SLOT_MS } from "../lib/own-log-bucket.js";
import { ownStationOf, userOpsOf } from "./user-ops.js";
import { localUsersPage } from "./user-ops-page.js";
import { OwnLogStore } from "./own-log-store.js";
import { createReconciliationModule } from "./reconciliation.js";
import { redact } from "./stations.js";

export async function readOverviewIncome(store, own, window, quotaPerUnit) {
  const unread = { amount: null, asOf: null, channels: [], reason: "尚未同步完整的主站消费账单" };
  const off = consumeLogOffOverlap(own.consumeLogOffPeriods, window);
  if (off.open || off.closed) return { ...unread, reason: off.open ? "主站收费记录已关闭，消费金额暂不显示" : "主站曾关闭收费记录，这段消费账单不完整" };
  if (!store || !(quotaPerUnit > 0)) return unread;
  const cursor = await store.getCursor(own.id);
  if (!cursor || cursor.coveredFromMs > window.startMs || window.startMs % OWN_LOG_SLOT_MS !== 0) return unread;
  const toMs = Math.min(cursor.coveredToMs, window.endMs);
  if (toMs <= window.startMs || (window.closed && toMs < window.endMs)
    || (cursor.disabledFromMs != null && cursor.disabledFromMs < toMs && cursor.disabledToMs > window.startMs)) return unread;
  const channels = new Map();
  for (const bucket of await store.listBuckets(own.id, window.startMs, Math.ceil(toMs / OWN_LOG_SLOT_MS) * OWN_LOG_SLOT_MS)) {
    const net = bucket.quota - bucket.adminQuota - bucket.testQuota;
    channels.set(bucket.channelId, (channels.get(bucket.channelId) || 0) + net / quotaPerUnit);
  }
  return { amount: [...channels.values()].reduce((sum, value) => sum + value, 0), asOf: toMs,
    channels: [...channels].map(([channelId, amount]) => ({ channelId, amount })), reason: null };
}

export async function overviewPage(rt, { preset = "today", now = Date.now() } = {}) {
  const own = ownStationOf(rt);
  if (!own) return { unset: true };
  const tz = businessTimeZone(), today = dayKeyInTz(now, tz), yesterday = shiftDayLabel(today, -1);
  const day = preset === "yesterday" ? yesterday : today;
  const reconciliation = (rt.reconciliation ||= createReconciliationModule(rt));
  const { ops, store } = userOpsOf(rt);
  const localLog = rt._ownLogStore || (rt.pool ? (rt._ownLogStore = new OwnLogStore(rt.pool)) : null);
  const quotaPerUnit = reconciliation.cachedOwnStatus?.(own.id)?.quotaPerUnit ?? null;
  const window = { startMs: dayStartInTz(day, tz), endMs: preset === "today" ? now : dayStartInTz(today, tz), closed: preset === "yesterday" };
  const yesterdayWindow = { startMs: dayStartInTz(yesterday, tz), endMs: dayStartInTz(today, tz), closed: true };
  const reads = await Promise.allSettled([
    localUsersPage(rt, ops, store, { now }),
    reconciliation.profitPage({ preset }, { cacheOnly: true, passive: true }),
    preset === "yesterday" ? null : reconciliation.profitPage({ preset: "yesterday" }, { cacheOnly: true, passive: true }),
    readOverviewIncome(localLog, own, window, quotaPerUnit),
    preset === "yesterday" ? null : readOverviewIncome(localLog, own, yesterdayWindow, quotaPerUnit),
  ]);
  const [users, profit, pastProfit, income, pastIncome] = reads.map((result) => result.status === "fulfilled" ? result.value : null);
  const historyProfit = preset === "yesterday" ? profit : pastProfit;
  const historyIncome = preset === "yesterday" ? income : pastIncome;
  const errors = {};
  for (const [index, name] of [[0, "users"], [1, "profit"], [3, "financial"]]) if (reads[index].status === "rejected") errors[name] = "这部分数据暂时读不到，已同步的数据仍可查看";
  const customers = users?.users || [];
  const usageAt = users?.todaySyncedMs ?? users?.syncedMs ?? null;
  const usageReady = usageAt != null && !users?.starting;
  const readyBalance = users?.ready?.balance === true && !users?.basicOnly;
  const activity = !usageReady ? null : preset === "today"
    ? { users: customers.filter((user) => user.today > 0).length, top: [...customers].filter((user) => user.today > 0).sort((a, b) => b.today - a.today).slice(0, 3).map((user) => ({ username: user.username, cost: user.today })) }
    : users.trend?.find((item) => item.day === day && item.available);
  const reminders = readyBalance ? customers.filter((user) => user.runwayState === "soon" || user.runwayState === "empty") : [];
  const coverageChannels = historyProfit?.coverage?.channels || [];
  const accountedChannels = coverageChannels.filter((channel) => channel.status === "accounted" && channel.ownStationId === own.id);
  const timeWindowState = accountedChannels.some((channel) => !channel.window) ? "unknown"
    : accountedChannels.some((channel) => channel.window.startMs !== yesterdayWindow.startMs || channel.window.endMs !== yesterdayWindow.endMs) ? "different" : "matched";
  const coveredIds = new Set(accountedChannels.map((channel) => channel.channelId));
  const coverageReady = historyIncome?.amount != null && historyProfit?.coverage?.catalogueState === "verified" && timeWindowState === "matched";
  const missingChannels = coverageReady ? historyIncome.channels.filter((channel) => channel.amount > 0 && !coveredIds.has(channel.channelId))
    .map((channel) => {
      const source = coverageChannels.find((item) => item.ownStationId === own.id && item.channelId === channel.channelId);
      return { ...channel, name: source?.name || `渠道 ${channel.channelId}`, status: source?.status || "unknown" };
    }) : [];
  const missing = coverageReady ? missingChannels.reduce((sum, channel) => sum + channel.amount, 0) : null;
  const covered = missing != null ? historyIncome.amount - missing : null;
  return {
    preset, day, today, now, tz,
    own: { id: own.id, name: own.name, rate: rateSnapshotOf(own).cnyPerUsd },
    financial: income || { amount: null, asOf: null, channels: [], reason: "主站消费账单暂时读不到" },
    profit,
    users: { ready: usageReady, balanceReady: readyBalance, usageAt, balanceAt: users?.balanceSyncedMs ?? null,
      activity: activity ? { count: activity.users, top: activity.top } : null,
      customers: usageReady ? customers : customers.map((user) => ({ ...user, today: null })),
      trend: (users?.trend || []).map((item) => item.day === today ? { ...item, available: usageReady } : item),
      reminderCount: readyBalance ? reminders.length : null, paused: users?.paused === true, fresh: users?.fresh === true,
      syncErrors: users?.syncErrors || [] },
    coverage: { day: yesterday, total: historyIncome?.amount ?? null, asOf: historyIncome?.asOf ?? null, covered, missing,
      ratio: covered != null && historyIncome.amount > 0 ? covered / historyIncome.amount : null,
      counted: historyProfit?.coverage?.accountedChannelCount ?? null, known: historyProfit?.coverage?.knownChannelCount ?? null, timeWindowState, missingChannels },
    upstreams: rt.store.list().filter((station) => !station.isOwn && !station.archivedAt && station.monitorEnabled !== false).map((station) => redact(rt, station)),
    rules: rt.store.rules, settings: rt.store.settings, intervalMs: Math.max(30, Number(rt.store.settings?.refreshIntervalSec) || 60) * 1000,
    errors,
  };
}
