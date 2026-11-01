// 模型供需页上的字（design 模型供需 v5 字表 models-v5/copy.md）。页面只写结论、数字、该做什么，不讲算法、不讲测法。
// 一个数前面最多带一个「约」，「至少」整页不出现；「缺货失败」只在表名下面那行小字里解释一次。
// 「用户」都是自营站点（用户自己的 New API）上的用户；渠道状态：启用 / 已停用（手动）/ 被自动停用（New API 自己停的，多半是上游出了问题）。
import type { LostCause } from "./headroom-types";

export type ChannelState = "on" | "off" | "auto";

// 次数、个数：千位逗号
const n = (v: number) => Math.round(v).toLocaleString("en-US");

export const COPY = Object.freeze({
  // 没设置自营站点
  setupDesc: "模型供需会看你的站近 24 小时哪些模型缺货、少收了多少、该怎么办。",
  setupFigure: "设置完成后，这里会列出近 24 小时缺货的模型、少收的钱和建议。",
  unreadable: "读不到模型数据",
  asOf: (time: string) => `数据截至 ${time}`,
  dash: "—",
  // 拿不到数据时只写一句（放在表的位置）
  none: Object.freeze({
    noLog: "到现在一条错误日志都没读到，可能你的站没开：在 New API 的环境变量里加 ERROR_LOG_ENABLED=true，再重启。",
    switchOff: "系统设置里关了「读取错误日志」，看不到缺货失败。",
    switchOffLink: "去打开",
    noFailures: "近 24 小时没有缺货失败。",
    notComputed: "这次没算出来，过一会儿再看。",
  }),
  // 顶上三个数
  kpiLabel: "概览",
  kpi: Object.freeze({
    tomorrow: "明天预计会缺", last24: "近 24 小时缺货失败", topup: "快没钱的上游",
    models: (v: number) => `${v} 个模型`,
    tomorrowBefore: (lost: string) => `不处理的话，明天约 ${lost} 次失败 · 最多的是 `,
    tomorrowNone: "照现在的样子，明天不缺",
    times: (v: number) => `${n(v)} 次`,
    last24Lost: (money: string) => `少收约 ${money}`,
    last24Users: (v: number) => `影响 ${v} 个重点用户`,
    last24None: "近 24 小时没有缺货失败",
    outModels: (v: number) => `${v} 个模型断货`,
    tomorrowAllOut: (v: number) => `这 ${v} 个模型在断货`,
    upstreams: (v: number) => `${v} 家`,
    topupOne: (hours: string) => ` ${hours}后没钱`,
    topupMany: (count: number, hours: string) => ` 等 ${count} 家，最早的 ${hours}后没钱`,
    topupNone: "没有上游快没钱",
    dash: "—",
  }),
  // 主表
  tableTitle: "近 24 小时缺货的模型",
  tableCaption: "缺货失败：因为上游限流、没钱、出故障或者没有渠道，重试完还是失败的请求。按少收的钱从多到少排。",
  search: "搜索模型",
  cols: Object.freeze({ model: "模型", lost: "缺货失败", money: "少收", cause: "主要原因", upstream: "出在哪家上游", peak: "最多的时段", tomorrow: "明天预计", reco: "建议" }),
  weekMoney: (money: string) => `近 7 天 ${money}`,
  timesCell: (v: number) => `${n(v)} 次`,
  moneyCell: (money: string) => `约 ${money}`,
  upstreamTail: (count: number) => `等 ${count} 家`,
  tomorrowTimes: (v: string) => `约 ${v} 次`,
  tomorrowNone: "不缺",
  outNow: "断货中",
  outToday: "今天起",
  outSince: (text: string) => text,
  outMoney: (money: string) => `估计每天 ${money}`,
  outTomorrow: "仍断货",
  causes: Object.freeze({ rate_limit: "限流", auth_quota: "没钱", upstream: "故障", no_channel: "没渠道" } as Record<LostCause, string>),
  thatUpstream: "那家上游",
  // 建议：一句话，不加理由行（X 是出问题的上游，Y 是能把量挪过去的上游）
  reco: Object.freeze({
    topup: (x: string) => `先给${x}充值`,
    addKeys: (x: string, y: string) => `给${x}加 Key，或把量挪到${y}`,
    addKeysOnly: (x: string) => `给${x}加 Key`,
    addKeysN: (x: string, count: number, y: string) => `给${x}加约 ${count} 把 Key，或把量挪到${y}`,
    addKeysNOnly: (x: string, count: number) => `给${x}加约 ${count} 把 Key`,
    quota: (x: string, y: string) => `找${x}提额度，或把量挪到${y}`,
    quotaOnly: (x: string) => `找${x}提额度`,
    fault: (x: string, y: string) => `${x}在出错，先把量挪到${y}`,
    faultOnly: (x: string) => `${x}在出错，去它那边看看`,
    openChannel: "这个模型没有开着的渠道，去开一个",
  }),
  quietNote: (count: number) => `另外 ${count} 个模型近 24 小时没有缺货失败`,
  smallNote: (count: number) => `另外 ${count} 个模型量很小，没列`,
  restShow: (count: number) => `显示其余 ${count} 个模型`,
  restHide: (count: number) => `收起其余 ${count} 个模型`,
  noMatch: "没有找到这个模型",
  rowOpen: (name: string) => `打开 ${name} 的详情`,
  // 手机卡片
  cardLost: (v: number) => `失败 ${n(v)} 次`,
  cardMoney: (money: string) => `少收约 ${money}`,
  cardOutMoney: (money: string) => `估计每天少收 ${money}`,
  cardLine: (parts: string[]) => parts.join(" · "),
  cardTomorrow: (text: string) => `明天预计${text}`,
  cardReco: (text: string) => `建议：${text}`,
  // 按上游看
  upstreamsTitle: "按上游看",
  upstreamsNone: "还没有上游供货。",
  upstream: Object.freeze({
    last24: (rate: number, fault: number, quota: number) => `近 24 小时：限流 ${n(rate)} · 故障 ${n(fault)} · 没钱 ${n(quota)}`,
    last24None: "近 24 小时没有失败",
    supplies: (count: number) => `影响 ${count} 个模型：`,
    supplyMore: "等",
    limit: (v: string) => `每小时最多接约 ${v} 次`,
    actions: Object.freeze({ topup: "到上游充值 ↗", addKey: "到上游加 Key ↗", weights: "到你的站调权重 ↗" } as Record<"topup" | "addKey" | "weights", string>),
    unboundName: "没对上上游的渠道",
    foot: "带 ↗ 的到你的站或上游网站去操作，控制台不替你改",
  }),
  // 抽屉
  drawer: Object.freeze({
    notFound: "这个模型近 30 天没有消费了，关掉再看。",
    failed: "读不到这个模型的详情",
    notComputed: "这次没算出来，过一会儿再看。",
    titleLost: (v: number) => `近 24 小时缺货失败 ${n(v)} 次`,
    outChart: "没有开着的渠道，这个模型的请求现在都失败。",
    outUsers: "断货中，数不出受影响的用户。",
    kpiLost: "缺货失败", kpiLostSub: "近 24 小时", kpiMoney: "少收", kpiCause: "主要原因", kpiTomorrow: "明天预计",
    causeLine: (cause: string, upstream: string | null) => (upstream ? `${cause} · ${upstream}` : cause),
    chartTitle: "每小时缺货失败",
    last24: "近 24 小时", clock7d: "近 7 天，按钟点平均",
    chartLabel: "每小时缺货失败的柱状图",
    hour: (h: number) => `${h} 点`,
    chartNone: "近 24 小时没有缺货失败。",
    conclusion: Object.freeze({
      when: (hours: string) => `失败多在 ${hours}`,
      mainly: (why: string) => `主要是${why}`,
      noChannel: "这个模型没有开着的渠道",
      none: "近 24 小时没有缺货失败。",
    }),
    channelsTitle: "哪些渠道在失败", channelsSub: "这个模型现在走哪些渠道",
    channelCols: Object.freeze({ channel: "渠道", upstream: "上游", lost: "缺货失败", cause: "主要原因", status: "状态" }),
    channelState: Object.freeze({ on: "启用", off: "已停用", auto: "被自动停用" } as Record<ChannelState, string>),
    channelLimit: (v: string) => `每小时最多接约 ${v} 次`,
    stateAt: (state: string, time: string) => `${state} · ${time}`,
    channelNone: "没有渠道配了这个模型。",
    unbound: "没绑上游",
    usersTitle: "受影响的用户", usersSub: "近 24 小时，按受影响次数排",
    usersTimes: (v: number) => `受影响 ${n(v)} 次`,
    usersKey: "重点",
    usersOthers: (count: number, times: number) => `其他 ${count} 个人受影响 ${n(times)} 次`,
    usersNone: "近 24 小时没有用户受影响。",
    finderTitle: "找货帮手", finderSub: "已经加了的上游里，谁也卖这个模型：按价格从低到高",
    finderCols: Object.freeze({ upstream: "上游", price: "价格（倍率）", vs: "和现在用的比", runway: "余额够用", supply: "在不在供" }),
    ratio: (v: number) => `${v.toFixed(2)} 倍`,
    perCall: (money: string) => `每次 ${money}`,
    unreadablePrice: "读不到价格",
    cheaper: (pct: string) => `便宜 ${pct}`, pricier: (pct: string) => `贵 ${pct}`, same: "差不多", mainNow: "现在主要用的",
    supplying: "已经在供", notSupplying: "还没在供",
    goBind: "去绑定渠道",
    finderNone: "已经加了的上游里，没有别的上游卖这个模型。",
    finderNote: "只有 New API 上游读得到价格；没加进来的上游不在这里。",
  }),
});

// 柱子从下往上叠的次序：限流、没钱、故障（每小时的数只有这三种，没渠道不是按小时发生的）
export const REASON_ORDER = Object.freeze(["rate_limit", "auth_quota", "upstream"] as const);
