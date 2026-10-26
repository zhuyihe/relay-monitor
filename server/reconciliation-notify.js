// 渠道对账使用独立的告警去重状态，但复用已有推送渠道。
import { BRAND } from "../lib/brand.js";
import { ALERT_TEXT } from "../lib/alerts.js";
import { ACCESS_TOKEN_LEGACY_RETIRED, accessTokenScopeText, isAccessTokenError } from "../lib/access-token-scopes.js";
import { businessTimeZone } from "../lib/business-time.js";
import { formatZonedDateTime } from "../lib/format.js";
import { stationDisplayName } from "../lib/overview-actions.js";
import { broadcast } from "../lib/notify.js";
import { ACCESS_TOKEN_SCOPE_FIX, accessTokenStatusText, fillIssueCopy, reconciliationIssue } from "../lib/reconciliation-contract.js";

// 令牌坏了的推送（过渡期，随 E 去掉；用语规范 §10「令牌坏了的推送」，总指挥 10-25）：按站点只推一条，不管下面有几个渠道在算。
// 一个上游、或者自营站点的访问令牌作废、少了权限：第一次发现时推一条，写清是哪个站点、几个渠道的利润先不算；
// 之后每条绑定再碰到同一个站点的同一个问题都不再推。换好令牌以后（这个站点下有一条绑定读通了）去掉记录，不推恢复。
// 告警状态记在「站点」上（rule_id 位置放 tk:站点id），不是绑定上。轮询是几条绑定并发跑的：检查「推过没有」和写下「推过了」
// 要一步做完，不然同一轮里同一个站点下的几条绑定会同时看到「没推过」各推一条，所以按站点键串起来（进程内的锁）。
// 「作废」「少了权限」「少了「X」的权限」「说明」用 contract 那一份（lib/reconciliation-contract.js），推送自己的话在 lib/alerts.js 的 ALERT_TEXT。
const siteKey = (side, rule) => `tk:${side === "upstream" ? rule.upstreamStationId : rule.ownStationId}`;
const siteLocks = new Map();
function withSiteLock(key, run) {
  const previous = siteLocks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  siteLocks.set(key, next);
  const release = () => { if (siteLocks.get(key) === next) siteLocks.delete(key); };
  next.then(release, release);
  return next;
}

const issueSide = (issue, health) => ((issue?.side ?? health?.side) === "upstream" ? "upstream" : "own");

async function notifyTokenProblem(rt, repo, rule, result, code) {
  const issue = (result.health?.issues || []).find((item) => item.code === code) || {};
  const side = issueSide(issue, result.health);
  const key = siteKey(side, rule);
  const first = await withSiteLock(key, async () => {
    const now = Date.now();
    const previous = await repo.getAlertState(key, code);
    if (previous?.active) {
      await repo.setAlertState(key, code, { active: true, firstSeenAt: Number(previous.first_seen_at), lastSeenAt: now,
        lastNotifiedAt: previous.last_notified_at == null ? null : Number(previous.last_notified_at), recoveredAt: null });
      return false;
    }
    await repo.setAlertState(key, code, { active: true, firstSeenAt: now, lastSeenAt: now, lastNotifiedAt: now, recoveredAt: null });
    return true;
  });
  if (!first) return;
  const now = Date.now();
  const stationId = side === "upstream" ? rule.upstreamStationId : rule.ownStationId;
  const station = rt.store.get?.(stationId) || null;
  const name = station?.name ? stationDisplayName(station) : "";
  const scope = issue.missingScope || result.health?.missingScope || "";
  const lacking = code !== ACCESS_TOKEN_LEGACY_RETIRED;
  const status = accessTokenStatusText(code, scope);
  const subject = side === "upstream" ? (name || ALERT_TEXT.unnamedUpstream) : `${ALERT_TEXT.ownLabel}${name ? ` ${name}` : ""}`;
  // 标题里不写少的是哪一项（那一项写在正文里）
  const title = `【${BRAND.name}告警】${subject} ${accessTokenStatusText(code)}`;
  const channelCount = side === "upstream"
    ? (await repo.listRules()).filter((item) => item.enabled && !item.archivedAt && item.upstreamStationId === rule.upstreamStationId)
      .reduce((sum, item) => sum + (item.channels?.length || 0), 0)
    : 0;
  const params = { scopes: accessTokenScopeText(side) };
  const issueCopy = reconciliationIssue(code);
  const note = !lacking ? fillIssueCopy(issueCopy.detail, "", params) : scope ? ACCESS_TOKEN_SCOPE_FIX : fillIssueCopy(issueCopy.detailPlain, "", params);
  const line = (label, value) => `${label}：${value}`;
  const body = [
    side === "upstream" ? line(ALERT_TEXT.upstream, name || ALERT_TEXT.unnamedUpstream) : name ? line(ALERT_TEXT.ownLabel, name) : "",
    line(ALERT_TEXT.status, status),
    line(ALERT_TEXT.impact, side === "upstream" ? ALERT_TEXT.impactUpstream(channelCount) : ALERT_TEXT.impactOwn),
    line(ALERT_TEXT.note, note),
    line(ALERT_TEXT.time, formatZonedDateTime(now, businessTimeZone())),
    BRAND.notificationSignature,
  ].filter(Boolean).join("\n");
  await broadcast(rt.store.channels, title, body);
}

// 自营站点的设置一直读不到（R2 审核第二轮；用语规范 §10 同一套格式）：按自营站点只推一条，和令牌坏了的推送一样记在站点键上；读通了随 READY 一起清
// 记在自己的站点键 opt:站点id 上（不用 tk:），因为「今天」每轮的 READY 结果会把 tk: 键整个清掉，这条要留到设置读得到那一刻（server/reconciliation.js 的 refreshConsumeLog 清）
// 什么时候推：对账模块算出「连续读不到超过 24 小时」那一刻（server/reconciliation.js 的 syncOptionUnreadableSince），不是跟着某条绑定某天的结果——
// 结账中的日子（还没过等待期的窗口）persistResult 不推告警，所以这条由站点那一层直接调
export const optionAlertKey = (ownStationId) => `opt:${ownStationId}`;
// 一发现读不到（不管多久、不管会不会推）就记一行：active、first_seen_at 是这一刻，last_notified_at 留空。已经有一行在 active 就不动
// （保留它原来的 first_seen_at，不会因为重启、按天粒度的账本状态行而往后漂）——重启后第一次检测也会走到这里，不看内存里上一次是什么
// （审核 R2 第二轮 中-E，总指挥 10-26 定）。推送仍然只在 syncOptionUnreadableSince 看到满 24 小时、这一段还没推过时才做。
export async function markOptionUnreadableSeen(repo, ownStationId, now = Date.now(), code = "OWN_OPTION_UNREADABLE") {
  const key = optionAlertKey(ownStationId);
  return withSiteLock(key, async () => {
    const previous = await repo.getAlertState(key, code);
    if (previous?.active) return Number(previous.first_seen_at);
    await repo.setAlertState(key, code, { active: true, firstSeenAt: now, lastSeenAt: now, lastNotifiedAt: null, recoveredAt: null });
    return now;
  });
}
export async function notifyOptionUnreadable(rt, repo, ownStationId, code = "OWN_OPTION_UNREADABLE") {
  const key = optionAlertKey(ownStationId);
  const first = await withSiteLock(key, async () => {
    const now = Date.now();
    const previous = await repo.getAlertState(key, code);
    const firstSeenAt = previous?.active && previous.first_seen_at != null ? Number(previous.first_seen_at) : now;
    // 这一段已经推过（markOptionUnreadableSeen 先写的行，或者上一轮已经推了）：只续 last_seen_at，不再推
    if (previous?.active && previous.last_notified_at != null) {
      await repo.setAlertState(key, code, { active: true, firstSeenAt, lastSeenAt: now, lastNotifiedAt: Number(previous.last_notified_at), recoveredAt: null });
      return false;
    }
    await repo.setAlertState(key, code, { active: true, firstSeenAt, lastSeenAt: now, lastNotifiedAt: now, recoveredAt: null });
    return true;
  });
  if (!first) return;
  const station = rt.store.get?.(ownStationId) || null;
  const name = station?.name ? stationDisplayName(station) : "";
  const line = (label, value) => `${label}：${value}`;
  const body = [
    name ? line(ALERT_TEXT.ownLabel, name) : "",
    line(ALERT_TEXT.status, ALERT_TEXT.optionUnreadableStatus),
    line(ALERT_TEXT.impact, ALERT_TEXT.optionUnreadableImpact),
    line(ALERT_TEXT.note, ALERT_TEXT.optionUnreadableNote),
    line(ALERT_TEXT.time, formatZonedDateTime(Date.now(), businessTimeZone())),
    BRAND.notificationSignature,
  ].filter(Boolean).join("\n");
  await broadcast(rt.store.channels || [], `【${BRAND.name}告警】${ALERT_TEXT.ownLabel}${name ? ` ${name}` : ""} ${ALERT_TEXT.optionUnreadableStatus}`, body);
}

export async function notifyReconciliationHealth(rt, repo, rule, result) {
  const now = Date.now();
  const code = result?.health?.code || "READY";
  if (code === "READY") {
    await repo.clearActiveAlerts(rule.id, now);
    // 这条绑定读通了：站点上的令牌记录去掉（不推恢复）。但固定成本的上游读不到只当参考、不挡结账，这条可能照样 READY——
    // 它这一轮的问题里还带着某一侧的令牌码时，那一侧的记录不能清（不然按用量那条又推一次，每轮都推）
    const stillBroken = new Set((result?.health?.issues || []).filter((issue) => isAccessTokenError(issue.code)).map((issue) => issueSide(issue, result.health)));
    for (const side of ["own", "upstream"]) if (!stillBroken.has(side)) await repo.clearActiveAlerts(siteKey(side, rule), now);
    return;
  }
  if (isAccessTokenError(code)) return notifyTokenProblem(rt, repo, rule, result, code);
  if (code === "OWN_OPTION_UNREADABLE") return notifyOptionUnreadable(rt, repo, rule.ownStationId, code);

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
