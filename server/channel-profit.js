// 按渠道开始算利润、停止算利润（K2c，k-plan 第七节）。
//
// 用户看到的是「渠道」：这个渠道在算利润 / 没算利润，按钮是「开始算利润」「停止算利润」；「绑定」只是这里面的叫法
// （一条绑定 = 一组渠道 + 一个上游账号，K-1）。这个模块只做编排，不另写一套建绑定、归档的实现（一个概念一处实现）：
//   - 认出每个渠道现在用的是哪把 Key：server/key-agent-identify.js（K2a）；
//   - 开始：同一个自营站点里用同一把 Key 的渠道连成一组（3.3），每组走接入向导已有的「预览 + 确认」（server/channel-onboarding.js
//     的 probeBatch / connectBatch，它自己按 canonical key 合并同一把 Key 的渠道、建或追加绑定、核对预览依据）；
//   - 停止：归档这条绑定，同一个事务把它的渠道记成「用户停的」（reconciliation_channel_optout），以后不自动开始。
// 没装读取服务、或者渠道的 Key 认不出（不在已加的上游里、打码撞了又没有 api_key:reveal 权限），不能开始（K-9），没有「指定 Key」。
import { randomUUID } from "node:crypto";
import { keyAgentConfigOf } from "./key-agent.js";
import { identifyChannelsCached } from "./key-agent-identify.js";
import { normalizeCoverageDeclaration } from "../lib/channel-onboarding.js";

const BILLING_TYPES = new Set(["newapi", "sub2api", "sub2api-password"]);

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

const groupKeyOf = (upstreamStationId, tokenId) => `${upstreamStationId}:${tokenId}`;

export function createChannelProfitModule(rt, { identify = identifyChannelsCached, randomId = randomUUID } = {}) {
  const onboarding = () => rt.channelOnboarding || rt.onboardingSource;
  const reconciliation = () => rt.reconciliation;

  function ownStationOf(ownStationId) {
    const station = rt.store.get(ownStationId);
    if (!station || !station.isOwn || station.type !== "newapi") throw codedError("OWN_STATION_UNSET", "还没设置自营站点");
    return station;
  }

  // 每个渠道现在的样子。state：running 在算 / startable 认出了 Key、可以开始 / blocked 不能开始（reason 说为什么）；
  // optedOut：用户停过（以后不自动开始，点「开始算利润」才开始）。groups：能开始的渠道按 Key 连成的组，一组一个勾、一起算或一起不算（3.3）
  async function status(ownStationId, { fresh = false } = {}) {
    const own = ownStationOf(ownStationId);
    if (!keyAgentConfigOf(own)) return { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" };
    const catalogue = onboarding()?.getSourceCatalogue?.();
    if (!catalogue?.ownSource || catalogue.stale) return { ok: false, code: "CHANNEL_CATALOGUE_STALE" };
    const identified = await identify(rt, own, { fresh });
    if (!identified.ok) return { ok: false, code: identified.code || "KEY_AGENT_UNAVAILABLE" };
    if (!identified.channels) return { ok: false, code: "KEY_AGENT_UNAVAILABLE" };
    const [rules, optouts] = await Promise.all([reconciliation().listRules(), reconciliation().listChannelOptouts(ownStationId)]);
    const running = new Map();
    for (const rule of rules) if (rule.enabled && !rule.archivedAt && rule.ownStationId === ownStationId) {
      for (const channel of rule.channels) running.set(Number(channel.channelId), rule.id);
    }
    const optedOut = new Set(optouts.map((row) => row.channelId));
    const identifiedById = new Map(identified.channels.map((entry) => [Number(entry.channelId), entry]));
    const revealDenied = new Map((identified.revealIssues || []).flatMap((issue) => (issue.channelIds || []).map((id) => [Number(id), issue.upstreamStationId])));
    const channels = catalogue.channels.filter((channel) => !channel.missing).map((channel) => {
      const channelId = Number(channel.id);
      const base = { channelId, name: channel.name, revision: channel.revision, optedOut: optedOut.has(channelId) };
      if (running.has(channelId)) return { ...base, state: "running", ruleId: running.get(channelId) };
      const entry = identifiedById.get(channelId);
      if (!entry) return { ...base, state: "blocked", reason: "NOT_IDENTIFIED" };
      if (entry.keyless) return { ...base, state: "blocked", reason: "KEYLESS" }; // 这类渠道的 Key 系统认不了（Vertex 账号文件、AWS ak|sk……）
      const slots = entry.slots || [];
      if (slots.length !== 1) return { ...base, state: "blocked", reason: "MULTI_KEY" }; // 多 Key 渠道这一版不能开始
      const [slot] = slots;
      if (slot.state === "identified" && slot.matches?.length === 1) {
        const match = slot.matches[0], upstream = rt.store.get(match.stationId);
        if (!upstream || !BILLING_TYPES.has(upstream.type)) return { ...base, state: "blocked", reason: "UPSTREAM_UNSUPPORTED" };
        return { ...base, state: "startable", upstreamStationId: match.stationId, tokenId: Number(match.tokenId), tokenName: match.tokenName ?? null,
          groupKey: groupKeyOf(match.stationId, match.tokenId) };
      }
      if (slot.state === "not_found") return { ...base, state: "blocked", reason: "KEY_UNMATCHED" }; // 不在已加的上游里：加上游
      if (slot.state === "ambiguous") return { ...base, state: "blocked", reason: "KEY_REVEAL_DENIED", upstreamStationId: revealDenied.get(channelId) ?? null };
      return { ...base, state: "blocked", reason: "KEY_UNRESOLVED" }; // 上游这一轮读不到，会自己好
    });
    const groups = new Map();
    for (const channel of channels) if (channel.state === "startable") {
      const group = groups.get(channel.groupKey) || { groupKey: channel.groupKey, upstreamStationId: channel.upstreamStationId, tokenId: channel.tokenId,
        tokenName: channel.tokenName, channelIds: [] };
      group.channelIds.push(channel.channelId);
      groups.set(channel.groupKey, group);
    }
    return { ok: true, stale: identified.stale ?? false, channels, groups: [...groups.values()] };
  }

  // 开始算利润。channelIds 是用户勾的渠道；同一把 Key 的其他渠道自动带上（一个勾，不会把整把 Key 的成本压到其中一个渠道上）。
  // coverage：每组 { [groupKey]: 回答 }——上游答了「只给我的渠道用」（accountUse = only_mine）的不用回答，别的每把 Key 要答一次
  // （附录 2，沿用现有的 coverageDeclaration）。返回 { started, alreadyRunning, blocked, failed }，没做成的写清楚为什么。
  async function start({ ownStationId, channelIds, coverage = {} }) {
    const ids = [...new Set((Array.isArray(channelIds) ? channelIds : []).map(Number))];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw codedError("CHANNEL_REQUIRED", "请至少选一个渠道");
    const state = await status(ownStationId, { fresh: true });
    if (!state.ok) throw codedError(state.code, state.code === "KEY_AGENT_NOT_CONFIGURED" ? "装好渠道 Key 读取服务才能开始算利润" : "渠道 Key 暂时读不到，稍后再试");
    const byId = new Map(state.channels.map((channel) => [channel.channelId, channel]));
    if (ids.some((id) => !byId.has(id))) throw codedError("CHANNEL_SOURCE_CHANGED", "选的渠道在自营站点里找不到了，请刷新渠道列表后重新选");
    const started = [], alreadyRunning = [], blocked = [], failed = [], wanted = new Map();
    for (const id of ids) {
      const channel = byId.get(id);
      if (channel.state === "running") alreadyRunning.push({ channelId: id, ruleId: channel.ruleId });
      else if (channel.state === "blocked") blocked.push({ channelId: id, code: channel.reason, ...(channel.upstreamStationId ? { upstreamStationId: channel.upstreamStationId } : {}) });
      else wanted.set(channel.groupKey, state.groups.find((group) => group.groupKey === channel.groupKey));
    }
    const ready = [];
    for (const group of wanted.values()) {
      const upstream = rt.store.get(group.upstreamStationId);
      let declaration = null;
      if (upstream?.accountUse === "only_mine") declaration = normalizeCoverageDeclaration({ answer: "none" });
      else if (coverage?.[group.groupKey] != null) declaration = normalizeCoverageDeclaration(coverage[group.groupKey]);
      if (!declaration) {
        for (const channelId of group.channelIds.filter((id) => ids.includes(id))) blocked.push({ channelId, code: "COVERAGE_ANSWER_REQUIRED", groupKey: group.groupKey });
        continue;
      }
      ready.push({ ...group, declaration });
    }
    if (!ready.length) return { started, alreadyRunning, blocked, failed };

    const stationIds = [...new Set(ready.map((group) => group.upstreamStationId))];
    const input = { requestId: randomId(), ownStationId,
      selections: stationIds.map((stationId) => ({ selectionId: `s-${stationId}`, stationId, monitor: false })),
      groups: ready.map((group, index) => ({ groupId: `g-${index}`, selectionId: `s-${group.upstreamStationId}`,
        channels: group.channelIds.map((channelId) => ({ channelId, channelRevision: byId.get(channelId).revision })),
        reconciliation: { tokenId: group.tokenId, coverageDeclaration: group.declaration } })) };
    const probe = await onboarding().probeBatch(input);
    const connected = await onboarding().connectBatch({ ...input, previewId: probe.previewId });
    for (const [index, group] of ready.entries()) {
      const result = connected.groups.find((item) => (item.requestedGroupIds || [item.groupId]).includes(`g-${index}`));
      if (result?.reconciliation?.status === "configured") started.push({ groupKey: group.groupKey, ruleId: result.reconciliation.ruleId, channelIds: group.channelIds });
      else failed.push({ groupKey: group.groupKey, channelIds: group.channelIds, code: result?.code || result?.reconciliation?.code || "ONBOARDING_FAILED",
        reason: result?.reason || result?.reconciliation?.reason || null });
    }
    // 用户点了「开始算利润」：删掉这些渠道的「用户停的」记号（只对真的开始了的）
    if (started.length) await reconciliation().removeChannelOptouts(ownStationId, started.flatMap((item) => item.channelIds));
    return { started, alreadyRunning, blocked, failed };
  }

  // 停止算利润：这几个渠道所在的绑定整条归档（同一把 Key 的渠道一起停，一个勾），同一个事务把它的渠道记成「用户停的」；
  // 没在算的渠道（第 3 步里取消勾的）只记「用户不要算」。已经算出来的日子留着，以后可以再点「开始算利润」
  async function stop({ ownStationId, channelIds }) {
    ownStationOf(ownStationId);
    const ids = [...new Set((Array.isArray(channelIds) ? channelIds : []).map(Number))];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw codedError("CHANNEL_REQUIRED", "请至少选一个渠道");
    const rules = (await reconciliation().listRules()).filter((rule) => rule.enabled && !rule.archivedAt && rule.ownStationId === ownStationId);
    const covered = new Set(), stopped = [];
    for (const rule of rules.filter((item) => item.channels.some((channel) => ids.includes(Number(channel.channelId))))) {
      await reconciliation().archiveRule(rule.id, { optout: true });
      for (const channel of rule.channels) covered.add(Number(channel.channelId));
      stopped.push({ ruleId: rule.id, channelIds: rule.channels.map((channel) => Number(channel.channelId)) });
    }
    const optedOut = ids.filter((id) => !covered.has(id));
    if (optedOut.length) await reconciliation().addChannelOptouts(ownStationId, optedOut, Date.now());
    return { stopped, optedOut };
  }

  return { status, start, stop };
}
