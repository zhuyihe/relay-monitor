// 多天拼装：一段窗口按绑定时区的自然日切成一块一块，已经固定的整天用账本里存的数，没固定的块（和头尾不满一天的）现读，
// 多天的收入就是这几块每一行（渠道）加起来（总指挥 10-25 定；R1 先用在每日利润的收入上，以后 F 的多天汇总、G 的固定成本按天固定直接用）。
// 纯函数，服务端、页面都能用（不引 node 专用模块）。
import { billDayOf, shiftedDayStartInTz } from "./business-time.js";

// 一段窗口切成一块一块：每个自然日一块，头尾不满一天的各一块。wholeDay 是这一块正好是一整天（只有整天的才可能已经固定进账本）。
export function splitWindowByDays(window) {
  const { startMs, endMs, timezone } = window || {};
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || typeof timezone !== "string" || !timezone) return [];
  const pieces = [];
  for (let at = startMs; at < endMs;) {
    const next = Math.min(shiftedDayStartInTz(at, 1, timezone), endMs);
    const piece = { startMs: at, endMs: next, timezone };
    pieces.push({ ...piece, wholeDay: !!billDayOf(piece) });
    at = next;
  }
  return pieces;
}

const finite = (value) => Number.isFinite(Number(value)) && value != null;
const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key]), 0);

/**
 * 几块的收入加起来。每一块是一段窗口的收入（现读的结果，或账本里固定下来的那一天）：
 * { quotaPerUnit, channels: [{ channelId, name?, billingState, quotaUnits, amountUsd, adminUsageQuotaUnits?, adminUsageAmountUsd? }],
 *   adminUsageQuotaUnits?, adminUsageAmountUsd? }。
 * 每个渠道逐块相加；只要有一块这个渠道没读全，这个渠道就是没读全（不拿读到的几块当整段）。金额按各块自己的换算已经是美元，直接加。
 * 管理员自用：某一块是 undefined（R1 以前固定的日子没扣过）当 0，是 null（现读时换算读不到）整个读不到。
 * 每块可以带 startMs：带了的话结果里多给 adminUsageFromMs（第一块扣过管理员自用的开始时刻，没有就是 null）和 adminUsageUndeducted（有没扣过的块），
 * 页面据此写「已扣除…（X 起；更早的日子没扣）」。
 * 返回和 queryOwnChannelRevenue 的结果同一个形状（不含 billingSource、calculationVersion、window、billingTimezone，调用方补）。
 */
export function stitchChannelRevenue(pieces, channelIds) {
  const wanted = [...new Set((channelIds || []).map(Number))];
  const channels = wanted.map((channelId) => {
    const rows = pieces.map((piece) => (piece.channels || []).find((row) => Number(row.channelId) === channelId));
    const ok = (row) => row && row.billingState === "complete" && finite(row.quotaUnits) && finite(row.amountUsd);
    const complete = pieces.length > 0 && rows.every(ok);
    const adminUnits = rows.every((row) => row && row.adminUsageQuotaUnits !== null) ? rows.reduce((total, row) => total + Number(row?.adminUsageQuotaUnits ?? 0), 0) : null;
    const adminUsd = rows.every((row) => row && row.adminUsageAmountUsd !== null) ? rows.reduce((total, row) => total + Number(row?.adminUsageAmountUsd ?? 0), 0) : null;
    return {
      channelId, name: rows.find((row) => row?.name)?.name ?? `渠道 ${channelId}`,
      billingState: complete ? "complete" : rows.some(ok) ? "partial" : "unavailable",
      quotaUnits: complete ? sum(rows, "quotaUnits") : null, amountUsd: complete ? sum(rows, "amountUsd") : null,
      adminUsageQuotaUnits: complete ? adminUnits : null, adminUsageAmountUsd: complete ? adminUsd : null,
    };
  });
  const successful = channels.filter((row) => row.billingState === "complete");
  const complete = channels.length > 0 && successful.length === channels.length;
  const knownAmountUsd = successful.length ? sum(successful, "amountUsd") : null;
  const adminUnits = pieces.every((piece) => piece.adminUsageQuotaUnits !== null) ? pieces.reduce((total, piece) => total + Number(piece.adminUsageQuotaUnits ?? 0), 0) : null;
  const adminUsd = pieces.every((piece) => piece.adminUsageAmountUsd !== null) ? pieces.reduce((total, piece) => total + Number(piece.adminUsageAmountUsd ?? 0), 0) : null;
  const deductedStarts = pieces.filter((piece) => piece.adminUsageQuotaUnits !== undefined && Number.isFinite(piece.startMs)).map((piece) => piece.startMs);
  return {
    quotaPerUnit: pieces.map((piece) => piece.quotaPerUnit).find((value) => finite(value) && Number(value) > 0) ?? null,
    quotaUnits: successful.length ? sum(successful, "quotaUnits") : 0,
    amountUsd: complete ? knownAmountUsd : null, knownAmountUsd,
    state: complete ? "complete" : successful.length ? "partial" : "unavailable",
    successfulCount: successful.length, expectedCount: channels.length, channels,
    adminUsageQuotaUnits: adminUnits, adminUsageAmountUsd: adminUsd,
    adminUsageUndeducted: pieces.some((piece) => piece.adminUsageQuotaUnits === undefined),
    adminUsageFromMs: deductedStarts.length ? Math.min(...deductedStarts) : null,
  };
}
