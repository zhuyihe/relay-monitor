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
