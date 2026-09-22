export const RECONCILIATION_BILLING_SOURCE = "channel-log-stat";
export const RECONCILIATION_CALCULATION_VERSION = 2;
export const RECONCILIATION_BILLING_SOURCE_LABEL = "NewAPI 渠道账单统计";

const HEALTH = Object.freeze({
  READY: { label: "数据正常", tone: "success" },
  GROUP_OR_RATIO_CHANGED: { label: "分组或倍率已变化", tone: "warning" },
  ROUTE_TRANSITION_DETECTED: { label: "已检测到上游分组或倍率变化", tone: "warning" },
  SEGMENT_TIMING_UNCONFIRMED: { label: "分段切换时间待确认", tone: "warning" },
  SALES_CHANNEL_DISABLED: { label: "本站销售渠道已禁用", tone: "warning" },
  SALES_CHANNEL_MISSING: { label: "本站销售渠道已缺失", tone: "error" },
  SALES_CHANNEL_STATE_UNKNOWN: { label: "本站销售渠道状态未知", tone: "warning" },
  KEY_INVALID_OR_DENIED: { label: "Key 不可用或无权限", tone: "error" },
  UPSTREAM_DATA_UNAVAILABLE: { label: "上游账单数据不可用", tone: "error" },
  OWN_BILLING_UNAVAILABLE: { label: "本站渠道账单不可用", tone: "error" },
  OWN_FLOW_INCOMPLETE: { label: "旧版本站收费数据不完整", tone: "warning" },
  UPSTREAM_EMPTY_WITH_SALES: { label: "本站有收费但上游无消费", tone: "warning" },
  STALE: { label: "数据已过期", tone: "default" },
});

export function reconciliationHealthMeta(code) {
  return HEALTH[code] || { label: String(code || ""), tone: "default" };
}

export function isCurrentReconciliationBillingContract(source) {
  const billingSource = source?.billingSource ?? source?.downstream?.billingSource;
  const calculationVersion = Number(source?.calculationVersion ?? source?.downstream?.calculationVersion);
  return billingSource === RECONCILIATION_BILLING_SOURCE
    && calculationVersion === RECONCILIATION_CALCULATION_VERSION;
}
