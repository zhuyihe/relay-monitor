export const BRAND = Object.freeze({
  name: "炬元",
  productName: "炬元控制台",
  productDescriptor: "运营控制台",
  positioning: "AI API 运营与成本管理平台",
  loginTagline: "上游资源、下游用量、成本与告警，一处看清。",
  notificationSignature: "炬元告警中心",
  reportSignature: "由炬元控制台生成",
});

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

// 上游资源页的三个标签（design/ui-copy-spec.md §11）
export const STATION_TABS = Object.freeze({
  list: "上游列表",
  onboarding: "渠道绑定",
  bills: "上游账单",
});

export function formatPageTitle(pageName) {
  return pageName ? `${pageName} · ${BRAND.name}` : BRAND.productName;
}
