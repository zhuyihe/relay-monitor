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
export type Margin = { value: number | null; status: "short" | "thin" | "ok" | "unknown" | "none" };

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
  // ok 都有；noErrorLog 没开错误日志（reason：switchOff 控制台里关了、noRecords 开着但读到现在一条错误都没有）；accumulating 错误日志读了不到 7 天
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
};
export type HeadroomNumbers = {
  needDays: number; minAttempts: number; minSuccessShare: number; minRateLimitShare: number; limitPercentile: number;
  windowDays: number; growthMin: number; growthMax: number; thinMargin: number;
};

export type HourPoint = { slotMs: number; hour: number; success: number; blocked: BlockedByReason; notBought: number };
export type ClockPoint = { hour: number; success: number; blocked: BlockedByReason }; // 近 7 天按钟点平均（每小时）
export type DetailChannelHeadroom = {
  channelId: number; name: string; upstream: { id: string; name: string | null } | null;
  state: "on" | "off" | "auto";
  limit: Quantity; peakUsed: number | null; room: number | null;
  status: "full" | "room" | "unmeasured" | "auto" | "off"; // 满了 / 空约 room / 上限没测到 / 被自动停用不算 / 手动停用不算
};

export type HeadroomDetail = {
  name: string; asOf: number; tz: string; rate: number;
  peak: Peak | null; need: Need | null; supply: Quantity; margin: Margin; reco: Reco; notBought: NotBought | null;
  hourly: { last24: HourPoint[]; clock7d: ClockPoint[] } | null; // 读不到是 null
  limitLine: Quantity; // 图上那条上限线，和 supply 同一个数（一个模型的能给）
  // 图下面那句结论要的事实（页面拼字）：哪些钟点超过上限、被挡的主要是什么原因、近 24 小时没买到多少、平时的余量
  facts: { overLimitHours: number[]; topReason: keyof BlockedByReason | null; notBought24: number; typicalRoom: number | null };
  users: { top: (KeyUser & { key: boolean })[]; others: { count: number; blocked: number } | null }; // 受影响最多的用户（近 24 小时，按被挡过几次），key：重点用户
  channels: DetailChannelHeadroom[];
  finderRoom: Record<string, number | null>; // 找货帮手每个上游的「高峰空约」，key 是上游 id
};
