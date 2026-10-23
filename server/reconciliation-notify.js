// 渠道对账使用独立的告警去重状态，但复用已有推送渠道。
import { BRAND } from "../lib/brand.js";
import { broadcast } from "../lib/notify.js";
import { reconciliationIssue } from "../lib/reconciliation-contract.js";

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

  // 过渡期只推送码表里标了 push 的几种（Key 被拒、账单读不到等）；其余只记录状态。整个文件在 E 里删掉，改成日报里的一行。
  const notify = reconciliationIssue(code).push;
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
    // 和余额推送一样，最后一行是落款（design/ui-copy-spec.md §10）：钉钉、飞书设了关键词「炬元」的机器人靠它收下。
    // 这个文件在 E 里整个删掉，这里只加这一行，别的不动
    BRAND.notificationSignature,
  ].filter(Boolean).join("\n");
  await broadcast(rt.store.channels, title, body);
}
