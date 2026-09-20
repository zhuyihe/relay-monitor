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
  analytics: "成本与利润",
  reconciliation: "上游渠道对账",
  notifications: "告警中心",
  settings: "系统设置",
});

export function formatPageTitle(pageName) {
  return pageName ? `${pageName} · ${BRAND.name}` : BRAND.productName;
}
