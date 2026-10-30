// 渠道绑在上游下面（上游资源的抽屉和小窗口）的字，只在这一处写（design/ui-copy-spec.md「渠道和 Key」）。上游资源里不出现利润。
export const CHANNEL_BINDING = Object.freeze({
  column: "渠道",
  cell: Object.freeze({ none: "没有渠道", count: (n) => `${n} 个`, unsupported: "—" }),
  drawerTitle: (upstream) => `${upstream}的渠道`,
  bindButton: "绑定渠道",
  cols: Object.freeze({ channel: "渠道", key: "Key", since: "绑定日期", actions: "操作" }),
  keyOf: (name, group) => [name, group ? `分组 ${group}` : ""].filter(Boolean).join(" · "),
  unbind: "解绑",
  swap: "换 Key",
  empty: "这个上游下还没有渠道",
  bindModal: Object.freeze({
    title: "绑定渠道", sub: (upstream, address) => [upstream, address].filter(Boolean).join(" · "),
    channel: "渠道", key: "Key", keyPlaceholder: "选这个渠道用的 Key", ok: "绑定", cancel: "取消",
    noChannels: "你站上的渠道都已经绑了",
    search: "搜渠道名或地址", searchAria: "搜渠道",
    groupMatch: "地址对得上这个上游", groupOther: "其他渠道",
    noMatch: "没有渠道的地址对得上这个上游，用上面的搜索按名字或地址找。",
    notFound: "没有这个名字或地址的渠道",
    showDisabled: (count) => `显示已禁用的 ${count} 个`, hideDisabled: "收起已禁用的", disabledTag: "已禁用",
    onlyOne: "这个上游只剩这一把 Key 没绑渠道，已经替你选好",
    noKeys: "这个上游里没有能绑的 Key", keysFailed: "读不到这个上游的 Key 列表",
  }),
  // 挑 Key 的下拉里不能选的 Key：灰着、点不了，后面一句原因
  keyReason: Object.freeze({
    duplicate: (count, name) => `上游里有 ${count} 把叫「${name}」，系统分不清，到上游把要用的那把改个不重复的名字`,
    used: (channel) => `已绑在「${channel}」`,
    disabled: "已停用", expired: "已过期", exhausted: "额度用完了",
    none: "这个上游里没有能选的 Key，原因写在每一把后面",
  }),
  unbindModal: Object.freeze({
    title: (channel) => `解绑「${channel}」？`,
    body: (channel, upstream) => `解绑后，「${channel}」不再挂在${upstream}下面；今天的数照样算完，以前的数都留着。以后可以再绑。`,
    ok: "解绑", cancel: "取消",
  }),
  // 「换 Key」小窗口和换好以后的提示（设计 10-29）。fromDay 是系统查到新 Key 第一天有用量的那天；recomputed 是补算了几天（换 Key 那天重算的 + 被挡住补上的）
  swapModal: Object.freeze({
    title: "换 Key", ok: "换 Key", cancel: "取消",
    sub: (channel, upstream) => `${channel} · ${upstream}`,
    current: "现在的 Key", next: "新 Key", nextPlaceholder: "选新的 Key",
    note: "不用记几点换的：系统会查新 Key 从哪天开始有用量，从那天起按新 Key 算，没算进来的日子自动补上。",
    working: "正在查新 Key 最近的用量，要几秒",
    noKeys: "这个上游里没有别的能用的 Key", keysFailed: "读不到这个上游的 Key 列表",
  }),
  swapDone: Object.freeze({
    plain: (key) => `已换成 ${key}`,
    from: (key, day) => `已换成 ${key}，从 ${day}起按新 Key 算`,
    fromToday: (key) => `已换成 ${key}，从今天起按新 Key 算`,
    recomputed: (n) => `，补算了 ${n} 天`,
    tooOld: (from, to) => `${from}${from === to ? "" : `–${to}`} 在 31 天以前，没自动补算；要按新 Key 算，到每日利润选那天点「重新读取」。`,
    noRecentUsage: (key) => `已换成 ${key}。往前查没找到新 Key 的用量，从今天起按新 Key 算`,
  }),
  // boundFrom：绑定时系统往前查到新 Key 从哪天开始有用量（重新绑回最近解绑的渠道时才有），day 是那天（已写成「10月27日」）
  done: Object.freeze({ bound: (channel, upstream) => `已把「${channel}」绑到${upstream}下面`, boundFrom: (day) => `，从 ${day}起按这把 Key 算`, boundRecomputed: (n) => `，补算了 ${n} 天`, unbound: (channel) => `已解绑「${channel}」` }),
});
