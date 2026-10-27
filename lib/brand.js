export const BRAND = Object.freeze({
  name: "炬元",
  productName: "炬元控制台",
  productDescriptor: "运营控制台",
  // 品牌名不改（design/ui-copy-spec.md §11）；定位语照 §3.7 不写英文
  positioning: "大模型用量的运营与成本管理平台",
  loginTagline: "上游资源、用户用量、成本与告警，一处看清。",
  notificationSignature: "炬元告警中心",
  reportSignature: "由炬元控制台生成",
});

// 这套控制台的版本号叫「软件版本」（§11）：侧栏底部和系统设置共用
export const VERSION_LABEL = "软件版本";

// 推荐给钉钉、飞书群机器人设的「自定义关键词」（design/ui-copy-spec.md §8.2、§10）：取品牌名。
// 每条推送、测试消息、日报都要带它——告警中心落款「炬元告警中心」、日报标题「【炬元日报】」和落款都含这两个字
export const NOTIFY_KEYWORD = BRAND.name;

export const NAV_LABELS = Object.freeze({
  home: "运营总览",
  stations: "上游资源",
  my: "自营业务",
  usage: "用量分析",
  analytics: "成本估算",
  reconciliation: "每日利润",
  notifications: "告警中心",
  settings: "系统设置",
});

// 上游资源页的两个标签（design/ui-copy-spec.md §11）
export const STATION_TABS = Object.freeze({
  list: "上游列表",
  channels: "渠道",
});

export function formatPageTitle(pageName) {
  return pageName ? `${pageName} · ${BRAND.name}` : BRAND.productName;
}
