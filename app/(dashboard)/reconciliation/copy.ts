// 每日利润页（一张对账表）的文字：只在这一页出现的话都在这里，用语按 design/ui-copy-spec.md §3.2、§5.7、§6、§7、§8.1，
// 样子按 design/ux/daily-profit-a.md。页面文件不能导出常量，界面测试要引用这些话，所以放在同目录的 copy.ts（§12）；
// 导入带 .js 后缀，node 可以直接读。按钮名、「刷新失败」「没设置汇率」这些共用的话从 lib 取，这里不另写。
import { NAV_LABELS } from "../../../lib/brand.js";

export const COPY = Object.freeze({
  // 时间范围（§6）
  presets: Object.freeze({ today: "今天", yesterday: "昨天", "7d": "近 7 天", month: "本月", since: "开始算以来", custom: "自定义" }),
  rangeLabel: "时间范围",
  customRangeLabel: "自定义时间范围",
  query: "查询",
  pickRange: "请选开始和结束日期",
  // 页顶一句（设计稿 §2）：今天 / 已固定 / 几天已固定，今天实时 / 还在读取
  todayCaption: "今天的数还会变，过了零点自动固定",
  fixed: "已固定",
  live: "实时",
  daysFixed: (n: number) => `${n} 天已固定`,
  daysReading: (n: number) => `${n} 天还在读取`,
  todayLive: "今天实时",
  // 页顶一句后面接的：需处理的渠道没算进来（用语规范 §4）；多天时写有几天
  caption: Object.freeze({
    attention: (channels: number) => `其中 ${channels} 个渠道需处理，没算进来`,
    attentionDays: (channels: number, days: number) => channels === 1 ? `其中 1 个渠道有 ${days} 天需处理，没算进来` : `其中 ${channels} 个渠道共 ${days} 天需处理，没算进来`,
    // 提示类的（今天提醒换 Key）：这一行照常算进来，只提醒
    notice: (channels: number) => `其中 ${channels} 个渠道成本可能少算了`,
  }),
  // 顶上四个数
  summary: Object.freeze({ income: "收入", actual: "上游成本", gross: "毛利", margin: "毛利率" }),
  // 毛利那一格（运营总览的利润卡片还在用：毛利、收入 − 上游成本、毛利率、净利）
  metric: Object.freeze({
    grossToday: "今天到现在的毛利",
    gross: "毛利",
    grossRange: (range: string) => `${range}毛利`,
    equation: (income: string, cost: string) => `收入 ${income} − 上游成本 ${cost}`,
    margin: (pct: string) => `毛利率 ${pct}`,
    netToday: (fixedCost: string, net: string) => `扣今天的固定成本 ${fixedCost} 后，净利 ${net}`,
    net: (fixedCost: string, net: string) => `扣固定成本 ${fixedCost} 后，净利 ${net}`,
    netUnknown: "固定成本算不出，净利先不算",
    // 按人民币显示时固定成本是按自营站点的汇率换的（用语规范 §7）
    approx: (money: string) => `≈ ${money}`,
  }),
  // 每天的毛利小柱状图
  chart: Object.freeze({
    title: "每天的毛利",
    legend: "浅色的还没固定",
    label: "每天的毛利柱状图",
    tip: (day: string, weekday: string, state: string) => `${day} ${weekday} · ${state}`,
  }),
  // 渠道表和点开以后每天一行
  table: Object.freeze({
    title: "渠道",
    col: Object.freeze({ channel: "渠道", income: "收入", actual: "上游成本", gross: "毛利", margin: "毛利率" }),
    day: Object.freeze({ date: "日期", state: "状态", detail: "计算明细", live: "实时", fixed: "已固定", attention: "需处理", today: "今天" }),
    mobileSort: (column: string, desc: boolean) => `按${column} ${desc ? "▼" : "▲"}`,
    // 渠道表的分组小标题（只在看今天时有三组；看多天只有「已解绑」）
    groupActive: (n: number) => `最近 1 小时有收入 · ${n}`,
    groupIdle: (n: number) => `最近 1 小时没收入 · ${n}`,
    groupUnbound: (n: number) => `已解绑 · ${n}`,
    unboundTag: "已解绑",
    mobileLine: (income: string, margin: string) => `收入 ${income} · 毛利率 ${margin}`,
    mobileDay: (income: string, actual: string) => `收入 ${income} · 成本 ${actual}`,
    mobileGross: (gross: string) => `毛利 ${gross}`,
    totals: (n: number) => `合计（算进来的 ${n} 个渠道）`,
    // 已固定、又因为重算的事需处理、照算进了合计的行（设计 10-26 定）
    totalsHeld: (n: number, held: number) => `合计（算进来的 ${n} 个渠道；其中 ${held} 个还没重算，先按原来固定的数算）`,
    emptyTitle: "还没有在算利润的渠道",
    emptyDesc: "在上游资源里把渠道绑到上游，就能算出今天从 0 点到现在的毛利。",
    goUpstreams: "去上游资源",
    setupOwnStation: "设置自营站点",
    expand: (name: string) => `展开 ${name}`,
    collapse: (name: string) => `收起 ${name}`,
    issueTip: (name: string, title: string) => `${name}：${title}`,
    unreadable: "读不到",
  }),
  // 差额那一格（用语规范 §5.7）
  gap: Object.freeze({
    over: (usd: string) => `多扣 ${usd}`,
    under: (usd: string) => `少扣 ${usd}`,
    overRate: (pct: string) => `比应付多 ${pct}`,
    underRate: (pct: string) => `比应付少 ${pct}`,
    tomorrow: "明天出",
    reading: "还在读取",
    // 原因码 → 字（§5.7；码见 lib/expected-cost-day.js 顶部注释和 lib/profit-page.js）
    reason: Object.freeze({
      UPSTREAM_PRICE_UNSUPPORTED: "Sub2API 上游读不到价格",
      MODEL_PRICE_UNREADABLE: "读不到上游的模型价格",
      CACHE_FIELDS_UNKNOWN: "自营站点的记录看不出缓存用了多少",
      KEY_SHARED: "这把 Key 别处也在用",
      GROUP_AUTO: "这把 Key 的分组会自动换",
      NOT_STARTED: "还没开始算",
      // 这天在整站日志第一次开始读之前（总指挥 10-26 定第三轮：和「这个渠道还没开始算利润」不是同一回事，字也不一样）
      EXPECTED_COST_NOT_RECORDED: "这天在开始算应付成本以前，没算",
      // 「算应付成本」关着：已固定的日子写这一句（关着时固定的、或者关→开跳过的缺口都是这一句），今天、还没固定的写 disabledNow（§5.7）
      EXPECTED_COST_DISABLED: "「算应付成本」关了，这天没算，以后打开也不补",
      // 收费记录还没读到这天（读到了会补上）
      EXPECTED_COST_LAGGING: "收费记录还没读到这天",
      // 当天换绑、停止算利润那天：实际记账的时段不从整点开始/结束，收费记录按整点记，切不开（总指挥 10-26 定，决定 C）。
      // 设计给的是按具体时刻分三种写法的版本（「这天从 14:23 起算」「这天算到 14:23」「这天只算 9:10–14:23」），
      // 接口（A1）现在没有把那个时刻单独带出来，先用这句不分情况的；时刻那版等 A1 补数据再接（design/ui-copy-spec.md §5.7）
      PARTIAL_HOUR_UNSUPPORTED: "这天算的时段不是整点开始或结束，收费记录按整点记，切不开，算不了应付成本",
      // 这天换了 Key、新旧倍率不一样（用语规范 §5.7，设计 10-27 定）；换 Key 的时刻带得到时用 keyChangeRatio（见下）
      KEY_CHANGE_RATIO_DIFFERS: "这天换了 Key，新旧倍率不一样，换的那一段分不清该按哪个倍率算，这天不比差额",
    }),
    keyChangeRatio: (when: string) => `这天 ${when} 换了 Key，新旧倍率不一样，换的那一段分不清该按哪个倍率算，这天不比差额`,
    disabledNow: "「算应付成本」关着",
    // 这个上游的一天不从整点开始（时差按这一行上游的时区现算）
    dayBoundary: (offset: string) => `这个上游按 ${offset} 算一天，算不了应付成本`,
    missingPrice: (model: string) => `上游没给 ${model} 的价格`,
    missingPrices: (model: string, n: number) => `上游没给 ${model} 等 ${n} 个模型的价格`,
    missingPriceUnnamed: "有模型上游没给价格",
    // 按用量分档计价（billing_mode: tiered_expr）的模型：公式套不上，不硬算（设计 10-26 定，MODEL_PRICE_TIERED）
    tieredPrice: (model: string) => `上游的 ${model} 按用量分档计价，算不了应付成本`,
    tieredPrices: (model: string, n: number) => `上游的 ${model} 等 ${n} 个模型按用量分档计价，算不了应付成本`,
    tieredPriceUnnamed: "有模型上游按用量分档计价，算不了应付成本",
    unknown: "算不出",
  }),
  // 需处理的感叹号气泡（标题、说明、按钮都从问题码来，这里只放几句固定的）
  attention: Object.freeze({
    more: (n: number) => `还有 ${n} 个问题`,
    retryFailed: "重新读取没完成，请稍后再试",
  }),
  // 点开渠道里的链接
  expanded: Object.freeze({ upstreamKey: "到上游后台查这把 Key" }),
  // 计算明细抽屉（设计稿 §5、用语规范 §9）
  detail: Object.freeze({
    group: (group: string, ratio: string) => `${group} 分组 ×${ratio}`,
    // 「核对上游扣费」一节：平时收起，右边一句结论，对不上的那天默认展开（设计 10-29）
    verify: Object.freeze({
      title: "核对上游扣费",
      match: "对得上",
      mismatch: (over: string) => `${over}，对不上`,
      keyChange: "这天换了 Key，不比差额",
    }),
    title: (name: string, day: string) => `计算明细 · ${name} · ${day}`,
    readFailed: "读不到计算明细",
    income: "收入",
    incomeFrom: (name: string) => `来自自营站点「${name}」的收费记录`,
    incomeFromMany: (n: number) => `来自自营站点 ${n} 个渠道的收费记录`,
    adminAll: (usd: string) => `已扣除管理员自用 ${usd}`,
    adminSome: (usd: string) => `已扣除管理员自用 ${usd}（部分日子没扣）`,
    adminNone: "收入里可能含管理员自用（这一天的账是按以前的规矩固定的，那时还不扣管理员自用）",
    expected: "应付成本",
    expectedIntro: (upstream: string, group: string) => `这个渠道这天的用量，按上游「${upstream}」的价格和 ${group} 算：`,
    expectedIntroMany: (upstream: string, group: string) => `这些渠道这天的用量，按上游「${upstream}」的价格和 ${group} 算：`,
    col: Object.freeze({ model: "模型", usage: "用量", price: "按上游价格", ratio: (ratio: string) => `× ${ratio}` }),
    usage: (input: string, output: string) => `输入 ${input}、输出 ${output} Token`,
    usageCache: (input: string, output: string, cache: string) => `输入 ${input}、输出 ${output}、缓存 ${cache} Token`,
    unitPrice: (input: string, output: string) => `每百万 Token ${input} / ${output}`,
    total: "合计",
    totalTokens: (tokens: string) => `${tokens} Token`,
    pricingNote: "用了缓存的，缓存那部分按上游的缓存价格算。价格是上游的模型价格表，每小时读一次；倍率是这天用的分组倍率。",
    // 整页按人民币时这张表仍按美元（用语规范 §7）
    usdTable: "这张表按美元原价",
    // 补算过的那一天（expected.backfilledAt）：两个日期都是补算那天
    backfilled: (day: string) => `这天的应付成本是 ${day} 补算的：这天固定时收费记录还没读完。价格按 ${day} 上游的模型价格表，倍率还是这天用的分组倍率。`,
    missing: "没算进的模型",
    missingOne: (model: string, input: string, output: string) => `${model}（输入 ${input}、输出 ${output} Token）`,
    missingHint: "这一天的应付成本、差额写「—」。",
    actual: "上游成本",
    unavailableUnknown: "这天还没算出来",
    actualFrom: (key: string) => `来自上游这把 Key「${key}」这天的用量记录。`,
    gap: "差额",
    gapFormula: "上游成本 − 应付成本",
    gapNote: (usd: string, pct: string) => `同时超过 ${usd} 和应付成本的 ${pct}，算对不上。正常也会差一点（两边记录的时刻不一样、请求重试），超过这条线才标出来。`,
    gross: "毛利",
    grossFormula: "收入 − 上游成本。",
    ratio: "倍率",
    ratioSame: (group: string) => `${group}，这天没变过`,
    ratioChanged: (time: string, from: string, to: string) => `倍率在 ${time} 从 ${from} 变成 ${to}，分两段算`,
    ratioChangedMany: (n: number) => `倍率这天变过 ${n} 次，每一段各算一遍`,
    fixedAt: "固定于",
    revised: "改过",
    revisedTimes: (n: number) => `改过 ${n} 次`,
    notRevised: "没有",
    notFixed: "今天还没固定",
    expectedToday: "今天过了零点、固定以后才算",
  }),
  // 页顶的提示条、表下面那一行（设计稿 §6、用语规范 §8.1、§5.4）
  notice: Object.freeze({
    unaccounted: (usd: string) => `另有 ${usd} 上游成本没算进利润`,
    seeUpstreams: "查看各上游",
    unlinked: (n: number) => `还有 ${n} 个渠道没绑定上游，没算进来。`,
    notCounted: (n: number) => `有 ${n} 天还没固定，没算进来`,
    // 这种接法这一版还不算利润：只提示，没有按钮（用语规范 §5.6）；最多点三个名，再多写「等 N 个渠道」
    unsupported: (items: string[], total: number) => `这一版还不算利润的渠道：${items.join("；")}${total > items.length ? `；等 ${total} 个渠道` : ""}`,
    unsupportedKeyInUpstreams: (name: string, upstreams: string[]) => `「${name}」它的 Key 在上游${upstreams.map((upstream) => `「${upstream}」`).join("")}里${upstreams.length > 1 ? "都有" : ""}`,
    logLagging: (at: string) => `自营站点的收费记录读得慢，只读到 ${at}，这以后的应付成本还没算。`,
    goSettings: "去设置",
    readFailed: `读不到${NAV_LABELS.reconciliation}`,
  }),
});
