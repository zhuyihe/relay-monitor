// 提醒规则和通知方式前后端共用的东西（design/ui-copy-spec.md §12）：不带 node 依赖，告警中心页面、db/store.js 都能引用。
// A3-2 把提醒规则表（事件键、开关键、默认规则）也收到这里。

// 通知方式没起名字时的名字（§3.1：不写「未命名渠道」）
export const UNNAMED_CHANNEL = "未命名通知方式";
