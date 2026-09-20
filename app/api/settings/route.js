// GET/PUT /api/settings —— 更新全局设置；历史留存变更可能需要不可逆删除确认。
import { withAuth, json } from "../../../lib/api.js";
import { restartPolling, refreshAll } from "../../../server/refresh.js";

function parseRetentionDays(value) {
  if (value == null) return null;
  const days = Number(value);
  return Number.isSafeInteger(days) && days > 0 ? days : undefined;
}

export const GET = withAuth(async (request, rt) => {
  return json({ settings: rt.store.settings, history: await rt.history.getSummary() });
});

export const PUT = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  const patch = {};
  if (body?.refreshIntervalSec != null)
    patch.refreshIntervalSec = Math.max(10, Number(body.refreshIntervalSec) || 60);
  if (body?.lowBalanceUsd != null)
    patch.lowBalanceUsd = Math.max(0, Number(body.lowBalanceUsd) || 0);
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
  return json({ settings, history: await rt.history.getSummary() });
});
