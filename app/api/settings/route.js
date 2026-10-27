// GET/PUT /api/settings —— 更新全局设置；历史留存变更可能需要不可逆删除确认。
// 返回带业务时区 tz：页面上历史记录的日期时间按它写（design/ui-copy-spec.md §6）；
// secretsEncrypted：登录信息是否加密保存（没配 RELAY_SECRET_KEY 时为 false，页顶提示一条，§8.1）
import { withAuth, json } from "../../../lib/api.js";
import { businessTimeZone } from "../../../lib/business-time.js";
import { restartPolling, refreshAll } from "../../../server/refresh.js";
import { OwnLogStore } from "../../../server/own-log-store.js";
import { dayKeyInTz, dayStartInTz, shiftDayLabel } from "../../../lib/business-time.js";

function parseRetentionDays(value) {
  if (value == null) return null;
  const days = Number(value);
  return Number.isSafeInteger(days) && days > 0 ? days : undefined;
}

// ownLog（应付成本 V1-a，审核 #123 第二轮）：自营站点的收费记录读到哪儿了——coveredFromMs / coveredToMs 进度两头，behindMs 落后多少，
// incompleteDays 哪几天还没读全（业务时区，从读到的那天到昨天）；设置页「算应付成本」开关下面那一行和每日利润表下面的提示用。没有自营站点、没有进度、读不到都是 null
async function ownLogProgress(rt, now = Date.now()) {
  try {
    const own = rt.store.list?.().find((station) => station.isOwn && station.type === "newapi");
    if (!own || !rt.pool) return null;
    const cursor = await (rt._ownLogStore ||= new OwnLogStore(rt.pool)).getCursor(own.id);
    if (!cursor) return null;
    const tz = businessTimeZone();
    const today = dayKeyInTz(now, tz), incompleteDays = [];
    for (let day = dayKeyInTz(cursor.coveredToMs, tz), guard = 0; day < today && guard < 400; day = shiftDayLabel(day, 1), guard += 1) incompleteDays.push(day);
    // 读到的那一天如果正好读到了天结束（进度 = 第二天 0 点），这一天是全的
    if (incompleteDays.length && dayStartInTz(shiftDayLabel(incompleteDays[0], 1), tz) <= cursor.coveredToMs) incompleteDays.shift();
    return { coveredFromMs: cursor.coveredFromMs, coveredToMs: cursor.coveredToMs, behindMs: Math.max(0, now - cursor.coveredToMs), incompleteDays };
  } catch { return null; }
}

export const GET = withAuth(async (request, rt) => {
  return json({ settings: rt.store.settings, history: await rt.history.getSummary(), tz: businessTimeZone(), secretsEncrypted: rt.store.secretsEncrypted, ownLog: await ownLogProgress(rt) });
});

export const PUT = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  const patch = {};
  if (body?.refreshIntervalSec != null)
    patch.refreshIntervalSec = Math.max(10, Number(body.refreshIntervalSec) || 60);
  if (body?.lowBalanceUsd != null)
    patch.lowBalanceUsd = Math.max(0, Number(body.lowBalanceUsd) || 0);
  if (body && "expectedCost" in body) patch.expectedCost = body.expectedCost === true; // 「算应付成本」开关（应付成本 V1，用语规范 §8.3）：只认真正的 true / false
  if (body?.dailyReport && typeof body.dailyReport === "object")
    patch.dailyReport = body.dailyReport; // store 内部做字段校验合并

  const hasRetention = Object.prototype.hasOwnProperty.call(body || {}, "historyRetentionDays");
  let previousRetention = null;
  if (hasRetention) {
    const nextRetention = parseRetentionDays(body.historyRetentionDays);
    if (nextRetention === undefined)
      return json({ error: "历史留存天数必须是正整数，或设为永久保留" }, 400);
    previousRetention = rt.store.settings.historyRetentionDays ?? null;
    const isShortening = nextRetention != null &&
      (previousRetention == null || nextRetention < previousRetention);
    if (isShortening && body.confirmRetentionCleanup !== true) {
      const preview = await rt.history.previewCleanup(nextRetention);
      return json({
        error: "缩短历史留存期限会删除超期监测快照，请确认后重试",
        code: "HISTORY_CLEANUP_CONFIRMATION_REQUIRED",
        preview,
      }, 409);
    }
    patch.historyRetentionDays = nextRetention;
  }

  const refreshIntervalChanged = "refreshIntervalSec" in patch &&
    patch.refreshIntervalSec !== rt.store.settings.refreshIntervalSec;
  const needsImmediateCleanup = hasRetention && patch.historyRetentionDays != null &&
    (previousRetention == null || patch.historyRetentionDays < previousRetention);
  const settings = await rt.store.updateSettings(patch);
  if (hasRetention) rt.history.syncCleanupSchedule();
  if (refreshIntervalChanged) {
    restartPolling(rt);
    // 重置定时器后第一次触发要等满整个周期，不主动刷会显得设置没生效。
    refreshAll(rt).catch(() => {});
  }
  // 新设或缩短为有限期限时立即执行一次；同一策略的普通保存仍遵守每日一次的节奏。
  if (needsImmediateCleanup) await rt.history.runScheduledCleanup({ force: true });
  return json({ settings, history: await rt.history.getSummary(), tz: businessTimeZone(), secretsEncrypted: rt.store.secretsEncrypted });
});
