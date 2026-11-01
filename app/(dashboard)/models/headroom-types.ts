// 模型供需第 1 步「高峰余量」的接口形状（设计 models-v4；算法在 lib/models-headroom.js，接口在 server/models-page.js）。
// GET /api/models 多一个字段 headroom: HeadroomPage | null；GET /api/models/detail?name= 多一个字段 headroom: HeadroomDetail | null。
// null = 这一次没算出来（没有数据库、读库出错、这个模型没有成交）：页面当「读不到」处理，老字段照常。
// 老字段（rows、summary……）这一步不动、不删，页面换完以后再清；新页面只读 headroom。形状定了尽量别改，要改同时告诉做页面的人。
//
// 约定：
//   - 量的单位都是「次/小时」（请求数）；钱都是美元，页面按响应里的 rate（汇率）换算，和老字段一样。
//   - 小时 hour 都是业务时区的墙上时钟（0–23）；一段高峰 hours 是连续的 2–3 个小时，按时间先后，可以跨午夜（[23, 0]）。页面写「21–23 点」= hours [21, 22] 的第一个到最后一个加 1。
//   - 「至少」「约」不在这里写：Quantity.kind 说明这个数是什么：measured = 测到的（写「约」）、atLeast = 没碰到过上限只知道至少多少（写「至少」）、
//     accumulating = 数据不够 7 天（写「数据积累中」）、unavailable = 拿不到（没开错误日志或没开整站消费日志，写「—」）。
//   - 错误日志、整站消费日志是用户站点那头的开关，状态见 HeadroomPage.state。

export type QuantityKind = "measured" | "atLeast" | "accumulating" | "unavailable";
export type Quantity = { kind: QuantityKind; value: number | null }; // value 是 null 当且仅当 kind 是 accumulating / unavailable

export type BlockedByReason = { rate_limit: number; upstream: number; auth_quota: number; other: number }; // 被挡过的失败次数，按原因；不含请求问题（用户自己的错）
export type Peak = { hours: number[] };

// 余量：能给 − 今晚要。status：
//   short   缺（value 是负的，能给是测到的）；thin 余量少于 THIN_MARGIN（余量很薄）；ok 余量够；
//   unknown 能给只是「至少」、而且比要的少：不能说缺（写「上限还没测到」）；none 算不出（今晚要的或能给的拿不到）
// kind 跟着能给（supply.kind）：测到的上限算出来的缺口写「约」；能给是「至少」时这个差其实是「最多缺」/「至少余」；accumulating / unavailable 时 value 是 null。
// 今晚要多少里的没买到是下限、按小时测的上限又偏低，两个偏差方向相反：先统一照 kind 写，审核 2 有结论再改
export type Margin = { value: number | null; status: "short" | "thin" | "ok" | "unknown" | "none"; kind: QuantityKind };

// 建议，按这个顺序判，只给数、不替用户改站：
//   topup      先给 X 家充值：主要供这个模型的上游里有撑不到今晚高峰结束的（hoursLeft 是还能撑几小时）
//   switch     换一家，或找 X 提额度：同一家上游的几把 Key 在同一批小时一起被限流（keys 把），是按账号限的，加 Key 没用
//   addKeys    加约 n 把 X 家的 Key：n = ⌈缺口 ÷ perKey⌉；X 是这个模型被挡最少的那家上游；perKey = 那家测到的一把 Key 的上限（中位数）。只在测到上限时给
//   thin       余量很薄，留意
//   unmeasured 上限还没测到（缺但没有测到的上限，不给 n）
//   none       没有建议
export type Reco =
  | { kind: "topup"; upstreamId: string; name: string | null; hoursLeft: number }
  | { kind: "switch"; upstreamId: string; name: string | null; keys: number }
  | { kind: "addKeys"; n: number; upstreamId: string; name: string | null; perKey: number }
  | { kind: "thin" } | { kind: "unmeasured" } | { kind: "none" };

// 今晚高峰要多少：(成交 + 没买到) 取近 7 天同一时段，有上周同一天（错误日志读满 8 天）用上周同一天，否则取第二高的那天；× 涨幅。
// growth：近 3 天日均 ÷ 前 4 天日均，限在 0.8–1.25（页面写「涨幅 +9%」= growth − 1）；basis：用了哪一天
export type Need = { value: number; growth: number; basis: "lastWeek" | "second" };

export type NotBought = {
  f24: number;            // 近 24 小时没买到（最终没买到的请求，至少这么多）
  lostUsd: number;        // 至少少收（F × 同模型同一小时的平均每次收入，各小时相加）
  blockedRetried: number; // 被挡过后靠重试买到的 = max(0, 被挡过的请求 − 没买到)
};
export type KeyUser = { userId: number; name: string; blocked: number }; // blocked：近 24 小时被挡过几次

export type HeadroomRow = {
  name: string;
  weekUsd: number; // 近 7 天消费（模型名下面那行小字），和老 rows 里的 week 同一个数
  // short 缺（排最前）、thin 余量薄、unknown 判不了（上限没测到、数据积累中、没开错误日志，或上游撑不到今晚）、ok 余量够、small 量很小不判（每天卖不到全站千分之一）。
  // 页面默认显示 short、thin、unknown，其余收起写「另外 N 个模型量很小或余量充足」
  group: "short" | "thin" | "unknown" | "ok" | "small";
  peak: Peak | null;           // 这个模型的高峰时段；成交不到 7 天、读不到是 null
  need: Need | null;           // 不够 7 天或读不到是 null
  supply: Quantity;            // 能给
  margin: Margin;
  keyUsers: { count: number; top: KeyUser[] }; // 受影响的重点用户（近 24 小时被挡过的重点用户），没开错误日志时 count 0、top []
  reco: Reco;
  notBought: NotBought | null; // 没开错误日志是 null
  gapUsdPerHour: number | null; // 缺口 × 每次卖多少，排序用（短缺的才有，余的是 null）
};

export type UpstreamHeadroom = {
  upstreamId: string | null;   // null：没对上上游的渠道合成一张
  name: string | null;
  hoursLeft: number | null;    // 余额还能撑几小时（上游监控现成的预测），读不到、固定成本、没有花费是 null
  limit: Quantity;             // 上限：它各渠道相加（同一把 Key 的渠道算一把；按账号限的整家算一个）
  peakUsed: number | null;     // 高峰用了（全站高峰时段平均）
  room: number | null;         // 高峰空多少 = limit − peakUsed，不小于 0；limit 是「至少」时也是下限；null 拿不到
  full: boolean;               // 满了：高峰用了 ≥ limit（只有 limit 是测到的才会 true）
  accountLimited: boolean;     // 几把 Key 一起被限流，按账号限
  blocked24: BlockedByReason | null; // 近 24 小时被挡过，没开错误日志是 null
  models: { count: number; names: string[] }; // 供几个模型，names 是前几个（按近 7 天消费排）
  actions: ("topup" | "addKey" | "weights")[]; // 页面该放的动作链接（都是到你的站或上游网站去操作）
};

export type HeadroomPage = {
  // ok 都有；accumulating 错误日志读了不到 7 天；
  // noErrorLog 没有错误日志可用：switchOff 控制台里关了「读取错误日志」（能给、上限、余量、没买到、被挡都拿不到）；
  //   noRecords 开着但读了 ≥1 天一条错误都没有（可能站没开，也可能真没出过错）：能给、上限照样是「至少 X」（最高成交量是真的），余量、没买到、被挡写「—」
  state: "ok" | "noErrorLog" | "accumulating";
  noErrorLogReason: "switchOff" | "noRecords" | null;
  errorLog: { coveredDays: number | null; needDays: number; daysLeft: number | null }; // 读了几天、要几天、还差几天
  consumeLog: boolean; // 整站消费日志（「算应付成本」）开着：每个渠道每小时成交靠它，没开能给多少是 unavailable
  peak: Peak | null;   // 全站的高峰时段（按上游看用）
  kpis: {
    willShort: { count: number; worst: { name: string; gap: number; peak: Peak | null } | null } | null; // 今晚高峰会缺；没开错误日志是 null（写「—」）
    notBought: { f24: number; lostUsd: number; blockedRetried: number; keyUsers: number } | null;        // 近 24 小时没买到；没开错误日志是 null
    topup: { count: number; first: { upstreamId: string; name: string | null; hoursLeft: number } | null }; // 快没钱的上游（撑不到今晚高峰结束的）
  };
  rows: HeadroomRow[]; // 已经排好：缺的在前按缺口 × 每次卖多少排，余的在后余量越薄越靠前，量很小的最后
  upstreams: UpstreamHeadroom[];
  numbers: HeadroomNumbers; // 「怎么算的」里的数，读 lib/models-headroom.js 的 HEADROOM 同一处
  lost: LostView; // v5（简化版页面）：近 24 小时缺货失败。新页面只读这个和 upstreams，上面的 state / kpis / rows 老页面用，不删
  // 动作链接要去的地方：只有公开地址，没有令牌和账号。own 是自营站点地址（去掉末尾斜杠）；upstreams 的 key 是上游 id，读不到是 null
  links: { own: string | null; upstreams: Record<string, { baseUrl: string; type: string } | null> };
};
export type HeadroomNumbers = {
  needDays: number; minAttempts: number; minSuccessShare: number; minRateLimitShare: number; limitPercentile: number;
  windowDays: number; growthMin: number; growthMax: number; thinMargin: number;
};

export type LostByReason = { rate_limit: number; upstream: number; auth_quota: number }; // 缺货失败（没买到）按原因分：限流 / 故障 / 没钱；加起来是这个小时的 notBought
// lost：这个小时的缺货失败按原因分（抽屉「每小时缺货失败」的图用）；blocked 是被挡过的次数（含后来重试买到的），v5 页面不用
export type HourPoint = { slotMs: number; hour: number; success: number; blocked: BlockedByReason; notBought: number; lost: LostByReason };
export type ClockPoint = { hour: number; success: number; blocked: BlockedByReason; lost: LostByReason }; // 近 7 天按钟点平均（每小时）
export type DetailChannelHeadroom = {
  channelId: number; name: string; upstream: { id: string; name: string | null } | null;
  state: "on" | "off" | "auto";
  limit: Quantity; peakUsed: number | null; room: number | null;
  status: "full" | "room" | "unmeasured" | "auto" | "off"; // 满了 / 空约 room / 上限没测到 / 被自动停用不算 / 手动停用不算
};

export type HeadroomDetail = {
  name: string; asOf: number; tz: string; rate: number;
  peak: Peak | null; need: Need | null; supply: Quantity; margin: Margin; reco: Reco; notBought: NotBought | null;
  lost: LostRow | null; // v5：这个模型近 24 小时的缺货失败，没有失败（或没开错误日志）是 null
  hourly: { last24: HourPoint[]; clock7d: ClockPoint[] } | null; // 读不到是 null
  limitLine: Quantity; // 图上那条上限线，和 supply 同一个数（一个模型的能给）
  // 图下面那句结论要的事实（页面拼字）：哪些钟点超过上限、被挡的主要是什么原因、近 24 小时没买到多少、平时的余量
  facts: { overLimitHours: number[]; topReason: keyof BlockedByReason | null; notBought24: number; typicalRoom: number | null };
  users: { top: (KeyUser & { key: boolean })[]; others: { count: number; blocked: number } | null }; // 受影响最多的用户（近 24 小时，按被挡过几次），key：重点用户
  channels: DetailChannelHeadroom[];
  finderRoom: Record<string, number | null>; // 找货帮手每个上游的「高峰空约」，key 是上游 id
};

// ================= v5：缺货失败（简化版页面读这一块）=================
// 「缺货失败」= 近 24 小时最终没买到的请求（下限，用户自己重试、客户端放弃的看不到）。接口里没有「至少 / 约」的叠写：页面直接写数。
// 钱都是美元，页面按响应里的 rate 换算；钟点是业务时区的墙上时钟（可以跨午夜）。
export type LostCause = "auth_quota" | "rate_limit" | "upstream" | "no_channel"; // 没钱 / 限流 / 故障 / 没渠道
export type UpstreamRef = { upstreamId: string; name: string | null };
// 建议，按主要原因给，只给数、不替用户改站（字由页面拼）：
//   topup       没钱 → 先给 X 充值（upstreamId / name 是失败最多的那家，没有对上是 null；hoursLeft 是它的余额还能撑几小时，读不到是 null）
//   rateLimit   限流 → 给 X 加 Key，或把量挪到 Y：addKeys 只在测到上限、算出缺口时有（n 把，一把 Key 约 perKey 次/小时），否则 null，页面不写几把；
//               accountLimited：X 是按账号限的，加 Key 没用，页面写「找它提额度」；moveTo：挪到哪家（这个模型被挡最少、还有开着的渠道在供的那家），没有可挪的是 null
//   fault       故障 → X 在出错，先把量挪到 Y（moveTo，没有是 null）
//   openChannel 没渠道 → 这个模型没有开着的渠道，去开一个
//   none        没有建议
export type LostReco =
  | { kind: "topup"; upstreamId: string | null; name: string | null; hoursLeft: number | null }
  | { kind: "rateLimit"; upstreamId: string | null; name: string | null; accountLimited: boolean; addKeys: { n: number; perKey: number } | null; moveTo: UpstreamRef | null }
  | { kind: "fault"; upstreamId: string | null; name: string | null; moveTo: UpstreamRef | null }
  | { kind: "openChannel" } | { kind: "none" };
export type LostRow = {
  name: string;
  weekUsd: number;                 // 近 7 天消费（模型名下面那行小字）
  lost24: number;                  // 近 24 小时缺货失败次数（F）
  lostMoney24: number;             // 少收的钱（美元）= 缺货失败 × 同一模型同一小时的平均每次收入，各小时相加
  mainCause: LostCause | null;     // 主要原因：没有开着的渠道就是 no_channel，否则按缺货失败的原因拆，最多的那个
  mainUpstream: UpstreamRef | null; // 失败最多的那家上游（按主要原因的被拒次数），渠道没绑上游或没渠道是 null
  peakFailHours: { hours: number[] } | null; // 失败最多的时段，连续 1–3 个钟点，可以跨午夜（[23, 0]）；页面写「21–23 点」= 第一个到最后一个加 1
  tomorrowLost: number;            // 明天预计失败次数 = lost24 × 涨幅（近 3 天 ÷ 前 4 天，限在 0.8–1.25），前提是什么都不改；成交不够算涨幅时按 1
  reco: LostReco;
  keyUsers: { count: number; top: KeyUser[] }; // 受影响的重点用户（近 24 小时被挡过的重点用户）
};
export type LostView = {
  // ok 有失败；noFailures 近 24 小时没有缺货失败（页面写一句话）；noErrorLog 没有错误日志可看（noErrorLogReason：switchOff 控制台里关了读取，noRecords 开着但站点没开或一直没出过错，页面写打开方法一句话）
  status: "ok" | "noFailures" | "noErrorLog";
  noErrorLogReason: "switchOff" | "noRecords" | null;
  kpis: {
    tomorrow: { count: number; lost: number } | null;          // 明天预计会缺：几个模型（预计失败 ≥ 1 次）、预计失败总数；没有错误日志是 null
    last24: { lost: number; lostUsd: number; keyUsers: number } | null; // 近 24 小时：缺货失败总数、少收总额（美元）、影响的重点用户数；没有错误日志是 null
    topup: { count: number; first: { upstreamId: string | null; name: string | null; hoursLeft: number | null } | null }; // 快没钱的上游，不变
  };
  rows: LostRow[];    // 主表：近 24 小时有缺货失败的模型，少收的钱从多到少排
  quietCount: number; // 另外几个模型近 24 小时没有缺货失败（没有错误日志时是 0）
};
