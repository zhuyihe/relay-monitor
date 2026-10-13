// 渠道对账使用独立的告警去重状态，但复用已有推送渠道。
import { broadcast } from "../lib/notify.js";
import { reconciliationHealthMeta } from "../lib/reconciliation-contract.js";

export async function notifyReconciliationHealth(rt, repo, rule, result) {
  const now = Date.now();
  const code = result?.health?.code || "READY";
  if (code === "READY") {
    await repo.clearActiveAlerts(rule.id, now);
    return;
  }

  const previous = await repo.getAlertState(rule.id, code);
  if (previous?.active) {
    await repo.setAlertState(rule.id, code, {
      active: true,
      firstSeenAt: Number(previous.first_seen_at),
      lastSeenAt: now,
      lastNotifiedAt: previous.last_notified_at == null ? null : Number(previous.last_notified_at),
      recoveredAt: null,
    });
    return;
  }

  // 过渡期只推送 error 色调（Key 失效、账单不可用等）；提醒类只记录状态，第 5 阶段并入告警中心后按开关处理。
  const notify = reconciliationHealthMeta(code).tone === "error";
  await repo.setAlertState(rule.id, code, {
    active: true,
    firstSeenAt: now,
    lastSeenAt: now,
    lastNotifiedAt: notify ? now : null,
    recoveredAt: null,
  });
  if (!notify) return;
  const channels = rule.channels || [];
  const affected = channels.length ? channels.map((channel) => channel.name).join("、") : "未配置渠道";
  const window = result.window || {};
  const title = "上游渠道对账异常";
  const body = [
    `上游 Key：${rule.tokenName} · ${rule.fixedGroup}`,
    `状态：${result.health.label || code}`,
    `影响渠道：${affected}`,
    `窗口：${new Date(window.startMs || now).toLocaleString("zh-CN", { hour12: false })} — ${new Date(window.endMs || now).toLocaleString("zh-CN", { hour12: false })}`,
    result.health.detail ? `说明：${result.health.detail}` : "",
  ].filter(Boolean).join("\n");
  await broadcast(rt.store.channels, title, body);
}
