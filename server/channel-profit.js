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
import { coverageNeedsAnswer } from "../lib/reconciliation-contract.js";
import { channelKeyLines } from "../lib/channel-key-lines.js";
import { dayKeyInTz } from "../lib/business-time.js";
import { costBasisOf } from "../lib/profit.js";

const BILLING_TYPES = new Set(["newapi", "sub2api", "sub2api-password"]);

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

const groupKeyOf = (upstreamStationId, tokenId) => `${upstreamStationId}:${tokenId}`;

// 自动开始失败（预览依据变了、账单能力没验证……）以后多久再试：10 分钟起，每次翻倍，最多 1 小时——不能每轮轮询都把这一组再预览一遍（读上游）
const AUTO_START_RETRY_MIN_MS = 10 * 60 * 1000, AUTO_START_RETRY_MAX_MS = 60 * 60 * 1000, AUTO_START_MAX_GROUPS = 3;

export function createChannelProfitModule(rt, { identify = identifyChannelsCached, randomId = randomUUID, now = () => Date.now() } = {}) {
  const onboarding = () => rt.channelOnboarding || rt.onboardingSource;
  const reconciliation = () => rt.reconciliation;
  // 同一个自营站点的开始 / 停止一个一个来（同时点两次开始、开始和停止同时点：后一个看到前一个已经提交的结果，不会停止说停了、渠道却还在算）
  const queues = new Map();
  const serialized = (ownStationId, task) => {
    const previous = queues.get(ownStationId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    queues.set(ownStationId, next);
    next.catch(() => {}).finally(() => { if (queues.get(ownStationId) === next) queues.delete(ownStationId); });
    return next;
  };

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
      if (slots.length !== 1) { // 多 Key 渠道这一版不能开始；keyCount、认出的上游（「渠道」页签把它写在这些上游下面）
        const stationIds = [...new Set(slots.flatMap((slot) => (slot.state === "identified" ? slot.matches || [] : []).map((match) => match.stationId)))];
        return { ...base, state: "blocked", reason: "MULTI_KEY", keyCount: slots.length, upstreamStationIds: stationIds };
      }
      const [slot] = slots;
      if (slot.state === "identified" && slot.matches?.length === 1) {
        const match = slot.matches[0], upstream = rt.store.get(match.stationId);
        if (upstream?.archivedAt) return { ...base, state: "blocked", reason: "CHANNEL_KEY_UNMATCHED" }; // 删了的上游（识别缓存最多 4 分钟，还会认）和不在已加的上游里一样
        if (!upstream || !BILLING_TYPES.has(upstream.type)) return { ...base, state: "blocked", reason: "UPSTREAM_UNSUPPORTED" };
        return { ...base, state: "startable", upstreamStationId: match.stationId, tokenId: Number(match.tokenId), tokenName: match.tokenName ?? null,
          groupKey: groupKeyOf(match.stationId, match.tokenId) };
      }
      if (slot.state === "not_found") return { ...base, state: "blocked", reason: "CHANNEL_KEY_UNMATCHED" }; // 不在已加的上游里：加上游（用语规范 §5.2 的码）
      // 打码撞了、读完整 Key 又没有权限（revealIssues 里有这个渠道）才是少权限；reveal 只是暂时失败（限流、网络）的不是，会自己好
      if (slot.state === "ambiguous" && revealDenied.has(channelId)) return { ...base, state: "blocked", reason: "KEY_REVEAL_DENIED", upstreamStationId: revealDenied.get(channelId) ?? null };
      return { ...base, state: "blocked", reason: "KEY_UNRESOLVED" }; // 上游这一轮读不到、reveal 暂时失败，会自己好
    });
    // 几把 Key 的渠道也在用的 Key（它的某个 slot 认出来是这把）：这把 Key 的钱有一部分是那个渠道的，分不到每个渠道，算到这一组头上会把成本压到这几个渠道上、
    // 绑定还被标成全覆盖。这一版多 Key 渠道本来就不能开始，和它共用 Key 的组也先挡住，等多 Key 渠道放开时一起解（k-plan 3.1、3.3：用同一把 Key 的渠道连成一组）
    const multiKeyUse = new Map();
    for (const entry of identified.channels) {
      if (entry.keyless || (entry.slots || []).length <= 1) continue;
      for (const slot of entry.slots) for (const match of slot.matches || []) {
        const key = groupKeyOf(match.stationId, match.tokenId);
        multiKeyUse.set(key, [...new Set([...(multiKeyUse.get(key) || []), Number(entry.channelId)])]);
      }
    }
    for (const [index, channel] of channels.entries()) {
      if (channel.state === "startable" && multiKeyUse.has(channel.groupKey)) {
        channels[index] = { channelId: channel.channelId, name: channel.name, revision: channel.revision, optedOut: channel.optedOut, state: "blocked", reason: "KEY_SHARED_WITH_MULTI_KEY",
          sharedWithChannelIds: multiKeyUse.get(channel.groupKey), upstreamStationId: channel.upstreamStationId, groupKey: channel.groupKey, tokenName: channel.tokenName };
      }
    }
    // 渠道今天早些时候属于一条已经停掉的绑定、现在又要追加进别的在算绑定（这把 Key 已经有在算的绑定）：追加这条路没有「按渠道记核算起点」，
    // 今天开始会把这个渠道今天已经算给停掉的那条绑定的收入再算进在算的那条里（同一笔收入算两遍）——今天不让开始（COUNTED_EARLIER_TODAY），明天 0 点起可以；
    // 自动开始今天不建，明天那一轮自然开始。每个渠道记自己的核算起点（决定 b）留到以后，和多 Key 渠道放开一起做
    const runningKeys = new Set(rules.filter((rule) => rule.enabled && !rule.archivedAt && rule.ownStationId === ownStationId).map((rule) => groupKeyOf(rule.upstreamStationId, rule.tokenId)));
    if (channels.some((channel) => channel.state === "startable" && runningKeys.has(channel.groupKey)) && typeof reconciliation().listRecentlyArchivedRules === "function") {
      // 读不到今天停掉的绑定就不能当没有：这道挡没了，开始的那一刻会把今天已经算给停掉那条绑定的收入再算一遍。先挡着、这一轮不开始（手动的收到读取类的原因，
      // 自动开始这一轮跳过），下一轮再试，宁可晚开始也不算错（审核 #143 第 2 轮低-8）
      let archived;
      try { archived = await reconciliation().listRecentlyArchivedRules(now() - 36 * 3600 * 1000); } catch { return { ok: false, code: "HISTORY_UNAVAILABLE" }; }
      const recent = archived.filter((rule) => rule.ownStationId === ownStationId && rule.archivedAtMs != null
        && dayKeyInTz(rule.archivedAtMs, rule.timezone) === dayKeyInTz(now(), rule.timezone));
      for (const [index, channel] of channels.entries()) {
        if (channel.state !== "startable" || !runningKeys.has(channel.groupKey)) continue;
        const stopped = recent.filter((rule) => rule.channels.some((member) => Number(member.channelId) === channel.channelId)).sort((a, b) => b.archivedAtMs - a.archivedAtMs)[0];
        if (stopped) channels[index] = { channelId: channel.channelId, name: channel.name, revision: channel.revision, optedOut: channel.optedOut, state: "blocked", reason: "COUNTED_EARLIER_TODAY",
          stoppedAtMs: stopped.archivedAtMs, tokenName: stopped.tokenName ?? null, upstreamStationId: channel.upstreamStationId, groupKey: channel.groupKey };
      }
    }
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
  function start(input) { return serialized(input?.ownStationId, () => startNow(input)); }
  async function startNow({ ownStationId, channelIds, coverage = {}, source = "user" }) {
    const ids = [...new Set((Array.isArray(channelIds) ? channelIds : []).map(Number))];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw codedError("CHANNEL_REQUIRED", "请至少选一个渠道");
    const state = await status(ownStationId, { fresh: true });
    if (!state.ok) {
      throw codedError(state.code, state.code === "KEY_AGENT_NOT_CONFIGURED" ? "装好渠道 Key 读取服务才能开始算利润"
        : state.code === "CHANNEL_CATALOGUE_STALE" ? "你站的渠道列表还没读到，稍后再试"
        : state.code === "HISTORY_UNAVAILABLE" ? "今天停掉的绑定暂时读不到，稍后再试" : "渠道 Key 暂时读不到，稍后再试");
    }
    const byId = new Map(state.channels.map((channel) => [channel.channelId, channel]));
    if (ids.some((id) => !byId.has(id))) throw codedError("CHANNEL_SOURCE_CHANGED", "选的渠道在自营站点里找不到了，请刷新渠道列表后重新选");
    const started = [], alreadyRunning = [], blocked = [], failed = [], wanted = new Map();
    for (const id of ids) {
      const channel = byId.get(id);
      if (channel.state === "running") alreadyRunning.push({ channelId: id, ruleId: channel.ruleId });
      else if (channel.state === "blocked") blocked.push({ channelId: id, code: channel.reason, ...(channel.upstreamStationId ? { upstreamStationId: channel.upstreamStationId } : {}),
        ...(channel.stoppedAtMs != null ? { stoppedAtMs: channel.stoppedAtMs, tokenName: channel.tokenName ?? null } : {}) });
      else wanted.set(channel.groupKey, state.groups.find((group) => group.groupKey === channel.groupKey));
    }
    const ready = [];
    const skipped = [];
    for (const group of wanted.values()) {
      const upstream = rt.store.get(group.upstreamStationId);
      // 自动开始：用 fresh 识别的这一组再判断一遍（缓存里的组和 fresh 的组可能不一样：用户停过的渠道可能这时才认出和它们是同一把 Key）——
      // 上游答了「只给我的渠道用」才开；这一组里只要有一个渠道是用户停过的，整组不自动开始（不是失败，也不退避）
      if (source === "auto" && (upstream?.accountUse !== "only_mine" || state.channels.some((channel) => channel.groupKey === group.groupKey && channel.optedOut))) {
        skipped.push({ groupKey: group.groupKey, channelIds: group.channelIds });
        continue;
      }
      let declaration = null;
      if (upstream?.accountUse === "only_mine") declaration = normalizeCoverageDeclaration({ answer: "none" });
      else if (coverage?.[group.groupKey] != null) { try { declaration = normalizeCoverageDeclaration(coverage[group.groupKey]); } catch { declaration = null; } } // 格式不对只算这一组没答
      if (!declaration) {
        for (const channelId of group.channelIds.filter((id) => ids.includes(id))) blocked.push({ channelId, code: "COVERAGE_ANSWER_REQUIRED", groupKey: group.groupKey });
        continue;
      }
      ready.push({ ...group, declaration });
    }
    if (!ready.length) return { started, alreadyRunning, blocked, failed, skipped };

    const stationIds = [...new Set(ready.map((group) => group.upstreamStationId))];
    const input = { requestId: randomId(), ownStationId,
      selections: stationIds.map((stationId) => ({ selectionId: `s-${stationId}`, stationId, monitor: false })),
      groups: ready.map((group, index) => ({ groupId: `g-${index}`, selectionId: `s-${group.upstreamStationId}`,
        channels: group.channelIds.map((channelId) => ({ channelId, channelRevision: byId.get(channelId).revision })),
        reconciliation: { tokenId: group.tokenId, coverageDeclaration: group.declaration } })) };
    // 自动开始只给新建的绑定记来源：新渠道追加进已有的绑定（用户点开始建的）时，connect 返回的是旧绑定的编号，那条不动
    const existingRuleIds = source === "auto" ? new Set((await reconciliation().listRules()).map((rule) => rule.id)) : null;
    const probe = await onboarding().probeBatch(input);
    const connected = await onboarding().connectBatch({ ...input, previewId: probe.previewId });
    for (const [index, group] of ready.entries()) {
      const result = connected.groups.find((item) => (item.requestedGroupIds || [item.groupId]).includes(`g-${index}`));
      if (result?.reconciliation?.status === "configured") started.push({ groupKey: group.groupKey, ruleId: result.reconciliation.ruleId, channelIds: group.channelIds });
      else failed.push({ groupKey: group.groupKey, channelIds: group.channelIds, code: result?.code || result?.reconciliation?.code || "ONBOARDING_FAILED",
        reason: result?.reason || result?.reconciliation?.reason || null });
    }
    // 用户点了「开始算利润」：删掉这些渠道的「用户停的」记号（只对真的开始了的）；自动开始（source: "auto"）不碰这些记号，记下来源
    if (started.length && source !== "auto") await reconciliation().removeChannelOptouts(ownStationId, started.flatMap((item) => item.channelIds));
    if (started.length && source === "auto") for (const item of started) if (!existingRuleIds.has(item.ruleId)) await reconciliation().markRuleStartSource?.(item.ruleId, "auto");
    return { started, alreadyRunning, blocked, failed, skipped };
  }

  // 自动开始（k-plan 第七节）：上游答了「只给我的渠道用」（accountUse = only_mine），读取服务认出一个新渠道用了它的 Key，就从认出的这一刻起自动建绑定
  // （和用户点「开始算利润」同一条路：预览 + 确认，核算起点也一样是今天 0 点），来源记 auto。轮询每轮调一次。
  // 不自动开始的：用户停过的渠道（reconciliation_channel_optout，只有用户点「开始算利润」才开始）、别处也在用/没回答的上游（要先回答每把 Key）、
  // 认不出的渠道；同一把 Key 的几个渠道里只要有一个是用户停过的，这一组整组不自动开始（一起算或一起不算）。
  // 上游从别处也在用改成只给我的渠道用以后，已经在等的渠道下一轮就进来（每轮重新判断，不用另外触发）。失败的组按 groupKey 退避
  async function autoStart(ownStationId) {
    const state = await status(ownStationId);
    if (!state.ok) return { started: [], skipped: "NOT_READY" };
    const backoff = (rt._autoStartBackoff ||= new Map());
    const at = now();
    // 已经不在能开始的组里的退避记录清掉（退避表不会只涨不缩）
    const liveKeys = new Set(state.groups.map((group) => `${ownStationId}:${group.groupKey}`));
    for (const key of backoff.keys()) if (key.startsWith(`${ownStationId}:`) && !liveKeys.has(key)) backoff.delete(key);
    // 每轮每个自营站点最多 AUTO_START_MAX_GROUPS 组，合成一次 start()（一次识别、一次预览、一次确认）：第一次把一个有几十个渠道的上游答成
    // 「只给我的渠道用」时不会一轮对自营站点和上游发几十次预览；剩下的下一轮接着来
    const candidates = [];
    for (const group of state.groups) {
      if (candidates.length >= AUTO_START_MAX_GROUPS) break;
      if (rt.store.get(group.upstreamStationId)?.accountUse !== "only_mine") continue;
      if (group.channelIds.some((id) => state.channels.find((channel) => channel.channelId === id)?.optedOut)) continue;
      if ((backoff.get(`${ownStationId}:${group.groupKey}`)?.nextAt ?? 0) > at) continue;
      candidates.push(group);
    }
    if (!candidates.length) return { started: [] };
    const fail = (key) => {
      const previous = backoff.get(key)?.delayMs ?? AUTO_START_RETRY_MIN_MS / 2;
      const delayMs = Math.min(AUTO_START_RETRY_MAX_MS, previous * 2);
      backoff.set(key, { nextAt: at + delayMs, delayMs });
    };
    const result = await start({ ownStationId, channelIds: candidates.flatMap((group) => group.channelIds), source: "auto" })
      .catch((error) => ({ started: [], failed: candidates.map((group) => ({ groupKey: group.groupKey, code: error?.code || "AUTO_START_FAILED" })), blocked: [] }));
    const startedKeys = new Set(result.started.map((item) => item.groupKey));
    for (const group of candidates) {
      const key = `${ownStationId}:${group.groupKey}`;
      if (startedKeys.has(group.groupKey)) backoff.delete(key);
      else if ((result.skipped || []).some((item) => item.groupKey === group.groupKey)) continue; // fresh 识别里又不该自动开始了：不算失败
      else fail(key);
    }
    return { started: result.started };
  }

  // 回答「这把 Key 还给别处用吗？」（「渠道」页签的「去回答」，在算的渠道、没回答或要改答案时）：走绑定编辑已有的「预览 + 保存」（预览依据核对），
  // 渠道、Key 都不变，只改回答。回答「只给这些渠道用」以后，绑定上没算的几天（从开始算起）靠回看补结
  async function answerCoverage({ ownStationId, ruleId, coverage }) {
    ownStationOf(ownStationId);
    const rule = (await reconciliation().listRules()).find((item) => item.id === ruleId && item.enabled && !item.archivedAt && item.ownStationId === ownStationId);
    if (!rule) throw codedError("RULE_NOT_FOUND", "这个渠道已经停止算利润了，请刷新");
    let declaration;
    try { declaration = normalizeCoverageDeclaration(coverage); } catch { throw codedError("INVALID_REQUEST", "请回答「这把 Key 还给别处用吗？」"); }
    const body = { upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId, salesChannelIds: rule.channels.map((channel) => Number(channel.channelId)),
      timezone: rule.timezone, enabled: true, coverageDeclaration: declaration };
    const proof = await onboarding().probeRuleEdit(ruleId, body);
    const previewGuard = onboarding().getPreviewGuard(proof.previewId, proof.groupId);
    await reconciliation().updateRule(ruleId, body, { previewGuard });
    return { ruleId, answer: declaration.answer };
  }

  // 停止算利润：这几个渠道所在的绑定整条归档（同一把 Key 的渠道一起停，一个勾），同一个事务把它的渠道记成「用户停的」；
  // 没在算的渠道（第 3 步里取消勾的）只记「用户不要算」。已经算出来的日子留着，以后可以再点「开始算利润」
  function stop(input) { return serialized(input?.ownStationId, () => stopNow(input)); }
  const MAX_STOP_CHANNELS = 1000;
  async function stopNow({ ownStationId, channelIds }) {
    ownStationOf(ownStationId);
    const ids = [...new Set((Array.isArray(channelIds) ? channelIds : []).map(Number))];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw codedError("CHANNEL_REQUIRED", "请至少选一个渠道");
    if (ids.length > MAX_STOP_CHANNELS) throw codedError("INVALID_REQUEST", "一次选的渠道太多了");
    const rules = (await reconciliation().listRules()).filter((rule) => rule.enabled && !rule.archivedAt && rule.ownStationId === ownStationId);
    // 只认你站渠道目录里的渠道和在算的绑定里的渠道，别的编号不往「用户不要算」里写
    const known = new Set(rules.flatMap((rule) => rule.channels.map((channel) => Number(channel.channelId))));
    for (const channel of onboarding()?.getSourceCatalogue?.()?.channels || []) known.add(Number(channel.id));
    if (ids.some((id) => !known.has(id))) throw codedError("CHANNEL_SOURCE_CHANGED", "选的渠道在自营站点里找不到了，请刷新渠道列表后重新选");
    const covered = new Set(), stopped = [];
    for (const rule of rules.filter((item) => item.channels.some((channel) => ids.includes(Number(channel.channelId))))) {
      // 别处刚好也停了这条（同时点两次）：已经停了，当成功，接着处理后面的
      try { await reconciliation().archiveRule(rule.id, { optout: true }); } catch (error) { if (error?.code !== "RULE_NOT_FOUND") throw error; }
      for (const channel of rule.channels) covered.add(Number(channel.channelId));
      stopped.push({ ruleId: rule.id, channelIds: rule.channels.map((channel) => Number(channel.channelId)) });
    }
    const optedOut = ids.filter((id) => !covered.has(id));
    if (optedOut.length) await reconciliation().addChannelOptouts(ownStationId, optedOut, Date.now());
    return { stopped, optedOut };
  }

  // 「渠道」页签要的整份数据（K2d，binding-flow 第 4 节、ui-copy-spec §5.5「渠道」页签）：上游 → 渠道 → 用过的 Key。
  // 一个渠道只显示一种：需处理 > 在算利润 > 没算利润；同一把 Key 的几个渠道是一张卡片（在算的按绑定、没在算的按 Key 连成组）。
  // 读取服务没装好、读不到时照样列出在算的渠道（从绑定读），不能开始的原因写在 reader 里。
  //   reader  { state: "ok" | "not_configured" | "unavailable", code? }
  //   upstreams  左边的上游列表，每个 { id, name, type, accountUse, noBills, channelCount, runningCount, attentionCount }
  //   cards  { id, state: "attention" | "running" | "stopped", upstreamStationId, channelIds, names, ruleId, startedBy, startedAtMs,
  //            issues: [码], keys: 用过的 Key（lib/channel-key-lines.js）, startGroupKey, needsCoverage, optedOut }
  //   unmatched  没对上上游的渠道 { channelId, name, reason }（reason 同 status 的 blocked 原因）
  async function overview(ownStationId) {
    const own = ownStationOf(ownStationId);
    const catalogue = onboarding()?.getSourceCatalogue?.();
    const catalogueOk = !!catalogue?.ownSource && !catalogue.stale;
    const nameOf = new Map((catalogueOk ? catalogue.channels : []).filter((channel) => !channel.missing).map((channel) => [Number(channel.id), channel.name]));
    const state = keyAgentConfigOf(own) ? await status(ownStationId).catch(() => ({ ok: false, code: "KEY_AGENT_UNAVAILABLE" })) : { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" };
    const reader = state.ok ? { state: "ok", stale: state.stale === true } : { state: state.code === "KEY_AGENT_NOT_CONFIGURED" ? "not_configured" : "unavailable", code: state.code };
    const allRules = (await reconciliation().listRules({ includeArchived: true })).filter((rule) => rule.ownStationId === ownStationId);
    const live = allRules.filter((rule) => rule.enabled && !rule.archivedAt);
    // 「用过的 Key」要的分段：这个自营站点的绑定（在算的和已停的）一次读出来，不按绑定逐条读
    const segmentsOf = await reconciliation().listSegmentsForRules(allRules.map((rule) => rule.id)).catch(() => ({}));
    const keysOf = (channelIds) => channelKeyLines(allRules.filter((rule) => rule.channels.some((channel) => channelIds.includes(Number(channel.channelId))))
      .map((rule) => ({ ...rule, segments: segmentsOf[rule.id] || [] }))).reverse().slice(0, 50);
    const channelName = (channelId, fallback) => nameOf.get(channelId) ?? fallback ?? `渠道 #${channelId}`;
    const optedOut = new Set((state.ok ? state.channels : []).filter((channel) => channel.optedOut).map((channel) => channel.channelId));

    const cards = live.map((rule) => {
      const channelIds = rule.channels.map((channel) => Number(channel.channelId));
      // 没回答（或答了不确定）：COST_COVERAGE_UNKNOWN；答了「别处也在用」：COST_SHARED_ELSEWHERE（用语规范 §5.2 回答以后这条事换成什么）
      const issues = [...(rule.keyIssue ? [rule.keyIssue.code] : []),
        ...(coverageNeedsAnswer(rule, costBasisOf(rt.store.get(rule.upstreamStationId))) ? [rule.coverageDeclaration?.answer === "other_use" ? "COST_SHARED_ELSEWHERE" : "COST_COVERAGE_UNKNOWN"] : [])];
      return { id: `rule:${rule.id}`, state: issues.length ? "attention" : "running", upstreamStationId: rule.upstreamStationId, channelIds,
        names: rule.channels.map((channel) => channelName(Number(channel.channelId), channel.name)), ruleId: rule.id, tokenName: rule.tokenName ?? null,
        startedBy: rule.startSource === "auto" ? "auto" : "user", startedAtMs: Number.isFinite(rule.billingEffectiveFrom) ? rule.billingEffectiveFrom : Date.parse(rule.createdAt) || null,
        issues, keys: keysOf(channelIds), startGroupKey: null, needsCoverage: false, optedOut: false };
    });
    const unmatched = [];
    if (state.ok) {
      for (const group of state.groups) {
        const upstream = rt.store.get(group.upstreamStationId);
        cards.push({ id: `key:${group.groupKey}`, state: "stopped", upstreamStationId: group.upstreamStationId, channelIds: group.channelIds,
          names: group.channelIds.map((channelId) => channelName(channelId)), ruleId: null, tokenName: group.tokenName ?? null, startedBy: null, startedAtMs: null,
          issues: [], keys: keysOf(group.channelIds), startGroupKey: group.groupKey, needsCoverage: upstream?.accountUse !== "only_mine",
          optedOut: group.channelIds.some((channelId) => optedOut.has(channelId)) });
      }
      // 几把 Key 的渠道、和它共用 Key 的组：写在各自的卡片上（用语规范 §5.6），不进「没对上上游的渠道」
      const sharedGroups = new Map();
      for (const channel of state.channels) {
        if (channel.state !== "blocked") continue;
        if (channel.reason === "COUNTED_EARLIER_TODAY") { // 今天上午在别的绑定下算过：卡片上写停的时刻和原来那把 Key，「开始算利润」今天灰着（明天 0 点起可以）
          const group = sharedGroups.get(`today:${channel.groupKey}`) || { channel, channelIds: [], today: true };
          group.channelIds.push(channel.channelId);
          sharedGroups.set(`today:${channel.groupKey}`, group);
          continue;
        }
        if (channel.reason === "KEY_SHARED_WITH_MULTI_KEY") {
          const group = sharedGroups.get(channel.groupKey) || { channel, channelIds: [] };
          group.channelIds.push(channel.channelId);
          sharedGroups.set(channel.groupKey, group);
          continue;
        }
        const multiUpstreams = channel.reason === "MULTI_KEY" && channel.keyCount >= 2 ? channel.upstreamStationIds.filter((id) => rt.store.get(id)) : [];
        if (multiUpstreams.length) {
          for (const upstreamStationId of multiUpstreams) cards.push({ id: `multi:${channel.channelId}:${upstreamStationId}`, state: "blocked", upstreamStationId, channelIds: [channel.channelId],
            names: [channelName(channel.channelId, channel.name)], ruleId: null, tokenName: null, startedBy: null, startedAtMs: null, issues: [], keys: keysOf([channel.channelId]),
            startGroupKey: null, needsCoverage: false, optedOut: false, blocked: { code: "MULTI_KEY", keyCount: channel.keyCount } });
          continue;
        }
        unmatched.push({ channelId: channel.channelId, name: channelName(channel.channelId, channel.name), reason: channel.reason,
          ...(channel.upstreamStationId ? { upstreamStationId: channel.upstreamStationId } : {}) });
      }
      for (const [groupKey, { channel, channelIds, today }] of sharedGroups) {
        if (today) {
          cards.push({ id: `${groupKey}`, state: "blocked", upstreamStationId: channel.upstreamStationId, channelIds, names: channelIds.map((channelId) => channelName(channelId)), ruleId: null,
            tokenName: channel.tokenName ?? null, startedBy: null, startedAtMs: null, issues: [], keys: keysOf(channelIds), startGroupKey: null, needsCoverage: false,
            optedOut: channelIds.some((channelId) => optedOut.has(channelId)), blocked: { code: "COUNTED_EARLIER_TODAY", stoppedAtMs: channel.stoppedAtMs, tokenName: channel.tokenName ?? null } });
          continue;
        }
        cards.push({ id: `shared:${groupKey}`, state: "blocked", upstreamStationId: channel.upstreamStationId, channelIds, names: channelIds.map((channelId) => channelName(channelId)),
          ruleId: null, tokenName: channel.tokenName ?? null, startedBy: null, startedAtMs: null, issues: [], keys: keysOf(channelIds), startGroupKey: null, needsCoverage: false,
          optedOut: channelIds.some((channelId) => optedOut.has(channelId)),
          blocked: { code: "KEY_SHARED_WITH_MULTI_KEY", sharedWith: channel.sharedWithChannelIds.map((channelId) => channelName(channelId)) } });
      }
    }
    // 左边的上游列表：在算 / 能开始的渠道数和要处理的数（要处理 = 卡片上的事；读取服务读不全 Key 是上游的事，算在这个上游上，一个上游一件）
    const revealDenied = new Set(unmatched.filter((item) => item.reason === "KEY_REVEAL_DENIED" && item.upstreamStationId).map((item) => item.upstreamStationId));
    const upstreams = rt.store.list({ includeUnmonitored: true }).filter((station) => !station.isOwn && station.type !== "fixed" && !station.archivedAt).map((station) => {
      const mine = cards.filter((card) => card.upstreamStationId === station.id);
      return { id: station.id, name: station.name ?? station.id, type: station.type, accountUse: station.accountUse ?? null, noBills: !BILLING_TYPES.has(station.type),
        channelCount: mine.reduce((total, card) => total + card.channelIds.length, 0), runningCount: mine.filter((card) => card.state === "running" || card.state === "attention").reduce((total, card) => total + card.channelIds.length, 0),
        attentionCount: mine.filter((card) => card.state === "attention").length + (revealDenied.has(station.id) ? 1 : 0) };
    });
    return { ok: true, reader, upstreams, cards, unmatched };
  }

  return { status, overview, start, stop, answerCoverage, autoStart };
}
