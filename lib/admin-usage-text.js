// 每日利润计算明细「收入」下面那一行：收入里减掉的管理员自用（用语规范 §9「管理员自用」）。纯函数，页面和测试共用。
// 管理员账号自己花的钱（含渠道测试）也记收费记录，不是下游用户花的钱，不算收入，和运营总览、自营业务同一个规矩。
// 按账本每一行判断扣没扣（R1 以前固定的账那一行没有这个数）：adminUsageDays 是范围里几天扣了、几天没扣；
// 没有这个字段时（单日账本那一行，或 R1 以前存的多日确认记录）：没有金额就是没扣，按窗口有几天算「几天没扣」。
//   每天都扣了：「已扣除管理员自用 $0.12」（合计 0 不写）；
//   有的扣了有的没扣：「已扣除管理员自用 $0.12（部分日子没扣）」，悬停写全句，金额只加扣过的那些天；合计是 0 时写「收入里可能含管理员自用（部分日子的账是……）」；
//   一天都没扣：「收入里可能含管理员自用（这几天的账是按以前的规矩固定的，那时还不扣管理员自用）」，只有一天时「这几天」换成「这一天」。
const DAY_MS = 86400000;
const OLD_RULE = "的账是按以前的规矩固定的，那时还不扣管理员自用";

// billing：结果里的 downstream；formatUsd：把美元金额写成界面上的钱（按汇率和币种）
export function adminUsageLineOf(billing, formatUsd) {
  if (billing?.state !== "complete") return null;
  const raw = billing?.adminUsageAmountUsd;
  if (raw === null) return null;
  const spanDays = Math.max(1, Math.round((Number(billing?.window?.endMs) - Number(billing?.window?.startMs)) / DAY_MS) || 1);
  const days = billing?.adminUsageDays ?? (raw === undefined ? { deducted: 0, undeducted: spanDays } : { deducted: spanDays, undeducted: 0 });
  if (!days.deducted) return { text: `收入里可能含管理员自用（${days.undeducted > 1 ? "这几天" : "这一天"}${OLD_RULE}）` };
  const usd = Number(raw ?? 0);
  if (!days.undeducted) return usd > 0 ? { text: `已扣除管理员自用 ${formatUsd(usd)}` } : null;
  return usd > 0
    ? { text: `已扣除管理员自用 ${formatUsd(usd)}（部分日子没扣）`, title: "有几天的账是按以前的规矩固定的，那时还不扣管理员自用，这几天的收入里可能含着它" }
    : { text: `收入里可能含管理员自用（部分日子${OLD_RULE}）` };
}
