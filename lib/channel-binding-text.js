// 渠道绑在上游下面（上游资源的抽屉和小窗口）的字，只在这一处写（design/ui-copy-spec.md「渠道和 Key」）。上游资源里不出现利润。
export const CHANNEL_BINDING = Object.freeze({
  column: "渠道",
  cell: Object.freeze({ none: "没有渠道", count: (n) => `${n} 个`, unsupported: "—" }),
  drawerTitle: (upstream) => `${upstream}的渠道`,
  bindButton: "绑定渠道",
  cols: Object.freeze({ channel: "渠道", key: "Key", since: "绑定日期", actions: "操作" }),
  keyOf: (name, group) => [name, group ? `分组 ${group}` : ""].filter(Boolean).join(" · "),
  unbind: "解绑",
  empty: "这个上游下还没有渠道",
  bindModal: Object.freeze({
    title: "绑定渠道", sub: (upstream, address) => [upstream, address].filter(Boolean).join(" · "),
    channel: "渠道", key: "Key", keyPlaceholder: "选这个渠道用的 Key", ok: "绑定", cancel: "取消",
    noChannels: "你站上的渠道都已经绑了",
    onlyOne: "这个上游只剩这一把 Key 没绑渠道，已经替你选好",
    noKeys: "这个上游里没有能绑的 Key", keysFailed: "读不到这个上游的 Key 列表",
  }),
  unbindModal: Object.freeze({
    title: (channel) => `解绑「${channel}」？`,
    body: (channel, upstream) => `解绑后，「${channel}」不再挂在${upstream}下面，以后可以再绑。`,
    ok: "解绑", cancel: "取消",
  }),
  done: Object.freeze({ bound: (channel, upstream) => `已把「${channel}」绑到${upstream}下面`, unbound: (channel) => `已解绑「${channel}」` }),
});
