// 第 2 步（服务和假站点都在跑）：走页面「接入渠道」同一条接口（/api/channel-onboarding/batch/probe → /batch），
// 一个上游一次：新建上游（看余额）+ 每把要算账的 Key 绑定它那几条自营渠道。只用 Key 的上游只绑看余额。
import { randomUUID } from "node:crypto";
import { login, progress } from "../lib/env.mjs";
import { UPSTREAMS, RULES, KEY_UP_CHANNELS, BASE, FIXED_COST_UPSTREAMS } from "../lib/model.mjs";

const api = await login();
await fetch(`${BASE}/__ctl?ratio=old&delay=5`);
const synced = await api("/api/channel-onboarding/sync", { method: "POST", body: {} });
const revisions = new Map(synced.channels.map((c) => [Number(c.id), c.revision]));
if (revisions.size !== 300) throw new Error(`自营渠道应有 300 条，读到 ${revisions.size}：${synced.error || ""}`);
const ownStationId = synced.ownStation.id;
let rules = 0, failures = 0;
const t0 = Date.now();
for (const up of UPSTREAMS) {
  const newStation = { name: up.name, baseUrl: up.baseUrl, type: up.kind, ...(up.kind === "newapi" ? { accessToken: up.accessToken, userId: up.userId }
    : up.kind === "sub2api" ? { accessToken: up.accessToken } : { apiKey: up.apiKey }), lowBalanceUsd: up.lowBalance ? 20 : null, cnyPerUsd: 7.2 };
  const groups = up.kind === "newapi-key"
    ? [{ groupId: "monitor", selectionId: "primary", channels: KEY_UP_CHANNELS(up).map((c) => ({ channelId: c, channelRevision: revisions.get(c) })), reconciliation: null }]
    : RULES.filter((rule) => rule.up === up).map((rule) => ({ groupId: `key-${rule.token.id}`, selectionId: "primary",
      channels: rule.channels.map((c) => ({ channelId: c, channelRevision: revisions.get(c) })),
      reconciliation: { tokenId: rule.token.id, timezone: "Asia/Shanghai",
        coverageDeclaration: { answer: rule.coverage, otherUse: null, uncoveredOwnChannelIds: [] } } }));
  const input = { requestId: randomUUID(), ownStationId, selections: [{ selectionId: "primary", monitor: true, additionalMonitorStationIds: [],
    updateCredentials: false, newStation }], groups };
  try {
    const probe = await api("/api/channel-onboarding/batch/probe", { method: "POST", body: input });
    const bad = probe.groups.filter((g) => !["ready", "monitor_only"].includes(g.status));
    if (bad.length || probe.selections.some((s) => s.monitor.status !== "verified")) {
      throw new Error(`预览没过：${JSON.stringify(bad.map((g) => [g.groupId, g.status, g.code, g.reason]))} ${JSON.stringify(probe.selections.map((s) => s.monitor))}`);
    }
    const result = await api("/api/channel-onboarding/batch", { method: "POST", body: { ...input, previewId: probe.previewId } });
    if (!result.complete) throw new Error(`没做完：${JSON.stringify(result.groups?.map((g) => [g.groupId, g.remainingActions, g.code, g.reason]))}`);
    rules += result.groups.filter((g) => g.saved?.ruleId).length;
  } catch (err) {
    failures += 1;
    console.error(`上游 ${up.i} 接入失败：`, err.message, err.data ? JSON.stringify(err.data).slice(0, 500) : "");
  }
}
// 固定成本的上游：接入完以后改上游的汇率和购买记录（种子 04 结账时按它们记账）
{
  const { stations } = await api("/api/stations");
  for (const fixed of FIXED_COST_UPSTREAMS) {
    const up = UPSTREAMS.find((item) => item.i === fixed.i), station = up && stations.find((item) => item.baseUrl === up.baseUrl && !item.isOwn);
    if (!station) continue;
    await api(`/api/stations/${station.id}`, { method: "PUT", body: { cnyPerUsd: fixed.cnyPerUsd, fixedPurchases: fixed.fixedPurchases } });
  }
}
await fetch(`${BASE}/__ctl?ratio=current&delay=50`);
progress(`种子 2：接入 ${UPSTREAMS.length} 个上游用了 ${Math.round((Date.now() - t0) / 1000)} 秒，建了 ${rules} 条绑定，失败 ${failures} 个`);
if (failures) process.exit(1);
