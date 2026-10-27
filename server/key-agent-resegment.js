// K2b：渠道这次识别出来的 Key 和上一次不一样时，这条绑定（以及可能牵连的另一条绑定）接下来该开成什么样的段。
// 只管“段怎么切、每段挂哪几把 Key”这一层决策，是纯函数：不碰 reconciliation_rule_channels（组的事交给 K2c）、
// 不写库、不发请求、不懂上游。调用方拿着这里给的计划，去 server/reconciliation-repository.js 开新段、写
// reconciliation_segment_keys（segment.keys 的格式就是这张表的行：{ upstreamStationId, tokenId, tokenName }）。
//
// 依据：design/ux/binding-flow.md §3「换 Key、换倍率时」最后一段「换 Key 的时刻怎么定」、§2「例外三：读不到你站的
// 渠道 Key」；例外三重连时用的是同一条换 Key 规则，不是另一套。

const keyRefId = (ref) => `${ref.upstreamStationId}:${ref.tokenId}`;
const sameKeyRef = (a, b) => !!a && !!b && keyRefId(a) === keyRefId(b);

// lastSeenAt（a）丢了的时候（比如控制台重启）兜底用哪个时刻：真正换 Key 的那一刻 t 落在
// a、b 之间；a 退得越早越安全——只要 a ≤ t 就不漏钱也不重复算（新 Key 换上以前没有用量，老 Key 本来就是这条绑定
// 自己的，宽出来的那一段，两把 Key 多读到的都是 0，不是多算）；a 只能往前退，不能往后挪，往后挪会把 [t, b) 那段
// 新 Key 的花费漏掉（旧段只有旧 Key、新段从 b 起，两边都不算）。
// 优先用读取服务上一次读成功的时刻（持久化的，旧一点也没关系，只会让过渡窗口更宽）；连这个都没有（没装过读取
// 服务，或者刚装上还没成功读过一次）就用这条绑定当前开着那段的起点，一定不会晚于真正换 Key 的那一刻。
export function safeLastSeenAt({ keyAgentLastSuccessAtMs, segmentEffectiveFrom }) {
  // 不早于开着那段的起点：段不能在自己起点以前结束（这一段是从旧 Key 换上那一刻起开的，t 一定不早于它）
  return Math.max(keyAgentLastSuccessAtMs ?? segmentEffectiveFrom, segmentEffectiveFrom);
}

// 这条绑定的 Key 从 oldRef 变成 newRef，newRef 不是从别的绑定那边挪过来的（凭空出现的新 Key，或者原来就没有 Key）：
// 算要开的段。preciseAt 给了（New API 逐条用量能精确定出新 Key 第一条用量的时刻）就干净切一刀，没有过渡段；
// 定不出就开一个 [lastSeenAt, observedAt) 的过渡段，两把 Key 的账单都读——这段时间只有这一个渠道在用这两把 Key，
// 两把都算是它的钱，不是重复算（design/ux/binding-flow.md §1 第 3 步「系统做了什么」：「这一分钟单独成一段，
// 段里两把 Key 的账单都读，所以换 Key 那一分钟里花的钱算进来了」；§3 说的是过渡段多长时间该怎么标，不是要不要开）
// newKeyFloor：新 Key 在这条绑定里最早从什么时候算（每把 Key 恰好算一次）：这把 Key 之前被别的绑定握过、那条绑定的段到这个时刻才结束，
// 新 Key 不能比它早进这条绑定的窗口（否则 [a, 结束) 里这把 Key 在两条绑定里各算了一次）；全新的 Key 没有上一个持有者，不给。
// 窗口只管新 Key 的起点往后挪：旧 Key 还在这条绑定开着的那段里，挪到窗口起点之前的部分照旧算给这条绑定，不漏
export function planKeyChangeSegments({ lastSeenAt, observedAt, oldRef, newRef, preciseAt = null, newKeyFloor = null }) {
  if (preciseAt != null) return { kind: "precise", cutoverAt: preciseAt, before: oldRef ? [oldRef] : [], after: [newRef] };
  if (!oldRef) return { kind: "precise", cutoverAt: observedAt, before: [], after: [newRef] }; // 原来没有 Key（新渠道、没有用量），没有旧 Key 可以一起算
  const windowStart = Math.max(lastSeenAt, newKeyFloor ?? -Infinity);
  // 起点已经不早于 b：新 Key 从 b 起算，没有过渡窗口可开，干净切一刀
  // b 不早于 a、不早于上一个持有者段的结尾（两台机器的钟差 ≥ 几分钟时 b 可能比它们还早：干净切会少算或多算，审核 #133 第 2 轮 F4）
  if (windowStart >= observedAt) return { kind: "precise", cutoverAt: windowStart, before: [oldRef], after: [newRef] };
  return { kind: "windowed", windowStart, windowEnd: observedAt, windowKeys: [oldRef, newRef], before: [oldRef], after: [newRef] };
}

// newRef 这把 Key 是从另一条「还在算」的绑定那边挪过来的：两边都按读到变化的那一刻 b 切开，不开过渡段——
// 这段钱只能算给其中一条绑定，两条绑定各开一段都把这段算进去，就是把同一笔钱算了两次（design/ux/binding-flow.md
// §3：「按读到变化的那一刻 b 切开：到 b 为止算给原来的渠道，b 起算给后来的渠道，不问你」）。
// after 带着挪过来的这把 Key（调用方开段要用，参见 server/reconciliation-repository.js 的 applyKeyChangePlans）
export function planMovedKeySegments({ observedAt, newRef, newKeyFloor = null }) {
  return { kind: "moved", cutoverAt: Math.max(observedAt, newKeyFloor ?? -Infinity), after: [newRef] };
}

// 批量：这一轮识别，每条绑定从 before（上一次确认时握着的 Key，没有就是 null）变成 after（这一次识别到的 Key）。
// 没变的绑定不出现在结果里——「没换 Key 时结果逐字不变」在这一层天然成立：没有计划，调用方就不会去改任何段。
// moved 的判断：这条绑定新握着的 Key，是不是本轮 before 时刻另一条绑定正握着的那把——是，就是挪过来的，不是凭空出现的。
// lastSeenAt 是这一批共用的（一般是同一个 own 站点、同一个持久化的「读取服务上一次读成功的时刻」）；
// 个别绑定要用不一样的（比如那个站点从没读成功过，退到这条绑定自己开着段的起点，参见 safeLastSeenAt），
// 用 lastSeenAtByBinding 按 bindingId 覆盖
export function planSegmentChanges({ bindings, lastSeenAt, observedAt, preciseAtByBinding = {}, lastSeenAtByBinding = {}, newKeyFloorByBinding = {} }) {
  const ownerBefore = new Map();
  for (const binding of bindings) if (binding.before) ownerBefore.set(keyRefId(binding.before), binding.id);
  const plans = [];
  for (const binding of bindings) {
    if (!binding.after || sameKeyRef(binding.before, binding.after)) continue;
    const movedFromBindingId = ownerBefore.get(keyRefId(binding.after));
    if (movedFromBindingId != null && movedFromBindingId !== binding.id) {
      plans.push({ bindingId: binding.id, movedFromBindingId, ...planMovedKeySegments({ observedAt, newRef: binding.after, newKeyFloor: newKeyFloorByBinding[binding.id] ?? null }), before: binding.before ? [binding.before] : [] });
    } else {
      plans.push({ bindingId: binding.id, ...planKeyChangeSegments({
        lastSeenAt: lastSeenAtByBinding[binding.id] ?? lastSeenAt, observedAt, oldRef: binding.before, newRef: binding.after,
        preciseAt: preciseAtByBinding[binding.id] ?? null, newKeyFloor: newKeyFloorByBinding[binding.id] ?? null,
      }) });
    }
  }
  return plans;
}

// Sub2API 没有实时信号，同一天换 Key（或者 Key 挪了位置）只能翻这一天这把 Key 的逐条用量，按 b 精确切开
// （design/ux/binding-flow.md §3 最后一段：「翻这一天、这一把 Key 的逐条用量，按 b 那一刻精确切开（这把 Key
// 已经删了的，翻整个账号这一天的逐条用量，在本地挑出来）」）：cutoverAt 之前的记归旧绑定，cutoverAt 起的记归新绑定
export function splitSub2RecordsAtCutover(records, cutoverAt) {
  const before = [], after = [];
  for (const record of records) (record.at < cutoverAt ? before : after).push(record);
  const sum = (list) => list.reduce((total, record) => total + record.amountUsd, 0);
  return { before: { records: before, amountUsd: sum(before) }, after: { records: after, amountUsd: sum(after) } };
}

// 例外三（design/ux/binding-flow.md §2）：读取服务连续拿不到新结果，几次以后才算「需处理」。计次本身在
// server/key-agent-identify.js 的 keyAgentReachability 里（按真的检查次数记，不按调用次数记）；这里只管
// 「这个次数该挂哪个码」：没到门槛是「实时·还在读取」（KEY_AGENT_UNAVAILABLE），到了门槛升成需处理（KEY_READER_UNREACHABLE）
export const KEY_READER_UNREACHABLE_THRESHOLD = 3; // 连续 3 次，读取服务按分钟轮询时约等于 binding-flow.md 说的「连续 10 分钟」
export function keyAgentExceptionIssueOf(reachability) {
  if (!reachability || reachability.consecutiveFailures <= 0) return null;
  return reachability.consecutiveFailures >= KEY_READER_UNREACHABLE_THRESHOLD ? "KEY_READER_UNREACHABLE" : "KEY_AGENT_UNAVAILABLE";
}

// 一条绑定名下不止一个渠道（组）时，这些渠道现在读到的 Key 不再是同一把了：组散了（分组）。K2b 不处理（不碰
// reconciliation_rule_channels），只检测、记一条自愈的 retry_reason（KEY_GROUP_CHANGED），交给 K2c 去重新分组，
// 这几天先不结账、不写段，宁可先不算也不把钱算错（这个场景在 K2c 上线前不会在生产环境出现——用户不会在那之前装读取服务）
export function detectGroupSplit(channelRefs) {
  const refs = channelRefs.filter(Boolean);
  if (refs.length < 2) return false;
  return refs.some((ref) => !sameKeyRef(ref, refs[0]));
}

// 合组：这一轮识别，有两条不同的、原本各自分开在算的绑定，现在的 Key 变成了同一把——这把 Key 的钱该算给哪条分不清，
// 两条都不结账、不写段，等 K2c 重新分组。传入 { bindingId, ref } 的列表（这一轮每条绑定现在握着的 Key，没有 Key 的不传）；
// 返回每一组冲突的 bindingId 列表（长度 > 1 才是真的冲突）
export function detectGroupMerges(currentRefsByBinding) {
  const byRef = new Map();
  for (const { bindingId, ref } of currentRefsByBinding) {
    if (!ref) continue;
    const id = keyRefId(ref);
    if (!byRef.has(id)) byRef.set(id, []);
    byRef.get(id).push(bindingId);
  }
  return [...byRef.values()].filter((bindingIds) => bindingIds.length > 1);
}

// K2c 重新分组（k-plan 3.3）：K2b 认出「组散了」（一条绑定名下的渠道现在用的 Key 不再是同一把）或「合组了」（几条绑定的渠道现在用同一把 Key）以后，
// 这里算该怎么重新分：
//   - 先把牵连的绑定找全（closure）：被标记的绑定，加上和它们的 Key 有关的——现在的 Key 在别的绑定名下（渠道读到的 Key 是它的）、或者别的绑定握着的 Key
//     （rules 上的 token，唯一约束，要建新绑定得先让它归档）——一直找到不再有新的为止；
//   - 牵连的绑定的渠道必须都认出了 Key（没认出来的不能分，原样留着，K2b 照旧不结账），而且 Key 都在原来的上游里
//     （换到另一个上游的 Key 是 K2c-3 的事）；
//   - 新的组：牵连的渠道按现在用的 Key 连成组，一组一条新绑定，从 b 起算；
//   - 旧绑定都在 b 归档；[a, b) 里每把 Key 恰好算一次：b 以前已经属于某条牵连的旧绑定的 Key 由那条算、别人的过渡段不放；
//     全新的 Key 放进恰好一条旧绑定的过渡段（用到它的绑定里排第一的那条，见下面的注释）。
// rules：这个自营站点下在算的绑定 [{ id, upstreamStationId, tokenId, tokenName, channelIds, channels? }]；refByChannelId：Number(channelId) -> { upstreamStationId, tokenId, tokenName }
// （只有认出了的单把 Key 渠道才有）；flaggedIds：K2b 标记了的绑定。
// 返回 { ok: true, closes: [{ ruleId, windowKeys: [ref] | null }], groups: [{ ref, channelIds, fromRuleIds }] }，
// 或 { ok: false, reason: "UNIDENTIFIED", ruleIds }（这一轮不分，保持原样）
// closes 里 { ruleId, windowKeys: [ref] | null, windowUsers: [ruleId] }
export function planRegroup({ rules, refByChannelId, flaggedIds }) {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const ownRef = (rule) => ({ upstreamStationId: rule.upstreamStationId, tokenId: Number(rule.tokenId), tokenName: rule.tokenName ?? null });
  const refsOf = (rule) => rule.channelIds.map((channelId) => refByChannelId.get(Number(channelId)) ?? null);
  const involved = new Set(flaggedIds.filter((id) => byId.has(id)));
  if (!involved.size) return { ok: false, reason: "NOTHING_TO_DO", ruleIds: [] };
  for (let changed = true; changed;) {
    changed = false;
    const keys = new Set();
    for (const id of involved) for (const ref of refsOf(byId.get(id))) if (ref) keys.add(keyRefId(ref));
    for (const rule of rules) {
      if (involved.has(rule.id)) continue;
      const holds = keys.has(keyRefId(ownRef(rule)));
      const uses = refsOf(rule).some((ref) => ref && keys.has(keyRefId(ref)));
      if (holds || uses) { involved.add(rule.id); changed = true; }
    }
  }
  const members = [...involved].sort().map((id) => byId.get(id));
  const unidentified = members.filter((rule) => refsOf(rule).some((ref) => !ref)).map((rule) => rule.id);
  if (unidentified.length) return { ok: false, reason: "UNIDENTIFIED", ruleIds: unidentified };
  // 换到另一个上游的 Key（K2c-3b）不再在这里拦：新的组带着自己的上游，换走的 Key 放进旧绑定的过渡段（段里的 Key 本来就带上游编号），
  // 调用方（server/reconciliation.js 的 regroupFor）按两边上游的类型决定做不做、过渡段截到哪

  // 新的组：牵连的渠道按现在用的 Key 连成组
  const groupsByKey = new Map();
  for (const rule of members) rule.channelIds.forEach((channelId, index) => {
    const ref = refsOf(rule)[index], id = keyRefId(ref);
    if (!groupsByKey.has(id)) groupsByKey.set(id, { ref: { ...ref }, channelIds: [], fromRuleIds: [] });
    const group = groupsByKey.get(id);
    group.channelIds.push(Number(channelId));
    if (!group.fromRuleIds.includes(rule.id)) group.fromRuleIds.push(rule.id);
  });
  const groups = [...groupsByKey.values()].map((group) => ({ ...group, channelIds: group.channelIds.sort((a, b) => a - b) }));

  // 旧绑定都在 b 归档。[a, b) 这段里，每把 Key 恰好算一次（总指挥 10-27 定）：
  //   - b 以前已经属于某条牵连的旧绑定的 Key（它们各自 rules 上握着的）：由那条旧绑定算，别人的过渡段里不放它；
  //   - 全新的 Key（a 以前哪条在算的绑定都没握过，渠道换到它）：放进恰好一条旧绑定的过渡段——用到它的绑定里排第一的那条
  //     （按建的先后、再按 id，规则固定），几条绑定的渠道都换到它时只放一次。不管是分组（一条绑定的渠道换走到新 Key），还是合组
  //     （几条绑定的渠道都换到同一把新 Key：t 到 b 之间新 Key 的用量，不放进来谁都不算）；
  //   过渡段放「这条绑定原来握着的那把 + 它负责的全新 Key」；windowUsers 是用到这些全新 Key 的绑定（调用方据此定过渡段的起点：
  //   这些绑定里最早的 a，不早于这条绑定开着那段的起点）
  const heldByInvolved = new Set(members.map((rule) => keyRefId(ownRef(rule))));
  const order = [...members].sort((x, y) => String(x.createdAt ?? "").localeCompare(String(y.createdAt ?? "")) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const ownerOfNewKey = new Map(); // 全新的 Key -> 负责它的绑定 id
  const usersOfNewKey = new Map(); // 全新的 Key -> 用到它的绑定 id 们
  const newKeyRefs = new Map();
  for (const rule of order) for (const ref of refsOf(rule)) {
    const id = keyRefId(ref);
    if (heldByInvolved.has(id)) continue;
    if (!ownerOfNewKey.has(id)) { ownerOfNewKey.set(id, rule.id); usersOfNewKey.set(id, []); newKeyRefs.set(id, { ...ref }); }
    if (!usersOfNewKey.get(id).includes(rule.id)) usersOfNewKey.get(id).push(rule.id);
  }
  const closes = members.map((rule) => {
    const owned = [...ownerOfNewKey].filter(([, owner]) => owner === rule.id).map(([id]) => id);
    if (!owned.length) return { ruleId: rule.id, windowKeys: null, windowUsers: [] };
    return { ruleId: rule.id, windowKeys: [ownRef(rule), ...owned.map((id) => newKeyRefs.get(id))],
      windowUsers: [...new Set([rule.id, ...owned.flatMap((id) => usersOfNewKey.get(id))])] };
  });
  return { ok: true, closes, groups };
}
