// 上游列表的纯数据部分：登录信息字段、报错归类、每行的展示模型。
// 不含 JSX，表格、手机列表、编辑页共用同一份计算；余额分档、固定成本笔数、可用天数都用 lib/ 里和运营总览同一份的函数。
import { BALANCE_STATE_TEXT, EMPTY, formatMoney, formatUsd, formatZonedDate } from "../../../lib/format";
import { balanceDaysText, balanceViewOf, etaWindowDays, lowLineOf, WATCH_DAYS } from "../../../lib/overview-actions";
import { balanceMoneyOf, fixedCostNowOf, purchasesOf, rateSnapshotOf } from "../../../lib/profit";
import { noteOf } from "../../components/error-detail";
import { etaWindowText } from "../../components/runway";
import type { ErrorNote } from "../../components/error-detail";
import type { Level } from "../../components/status";

const DAY_MS = 86400000;

// 只在上游列表出现的说法（design/ui-copy-spec.md §3.3、§7）
const COPY = {
  archived: "已归档",
  archivedOn: (date: string) => `归档于 ${date}`,
  fixedNone: "还没有固定成本记录",
  fixedExpired: "已到期",
  fixedRenew: "要续上，再记一笔固定成本",
  fixedUpcoming: "还没开始",
  fixedEndsIn: (days: number) => `${days} 天后到期`,
  fixedNextEnd: (date: string) => `最近一笔 ${date}到期`,
  fixedLeft: (days: number) => `还剩 ${days} 天`,
  noRenewal: "不再续费，不再提醒",
  // 状态格下一行解释余额这一档（ui-copy-spec §3.3）：不写天数，天数在可用天数一格
  tierLow: (line: string) => `低于提醒线 ${line}`,
  tierSoon: (within: string) => `按现在的花法，${within}以内就会用完`,
  tierEmpty: "充值以后才能接着用",
  own: "自营站点，不提醒余额",
};

// 读不到上游类型时（/api/meta 失败）：列表页的横幅和编辑页的提示同一句
export const TYPES_MISSING_TEXT = "读不到上游类型，暂时不能新增或编辑上游";

export const CONNECTION_FIELDS = new Set(["type", "baseUrl", "accessToken", "apiKey", "userId", "email", "password"]);
export const CONNECTION_INPUT_FIELDS = ["baseUrl", "accessToken", "apiKey", "userId", "email", "password"] as const;

// 读不到余额、测试读取没成时界面上的那条：text 是归类后的一句（§8.2），raw 是原文，只进「查看详细原因」
export type ConnectionIssue = ErrorNote;

export type ConnectionTestResult = {
  ok: boolean;
  message?: string;
  latencyMs?: number;
  account?: string | null;
  remaining?: number;
  currency?: string | null;
  issue?: ConnectionIssue;
  // 渠道 Key 读取服务（K2a）：只在自营站点、测主连接成功时顺带带出来，和主结果分开展示
  keyAgent?: { ok: boolean; channelCount?: number; code?: string };
};

export type StationCheck = { issue: ConnectionIssue; checkedAt: string };

// 和别处报错同一套归类（noteOf）。source 是余额 { code, error }、测试读取的结果 { code, diagnostic }，或接口报错
export function resultIssue(source: any): ConnectionIssue {
  if (source instanceof Error || !source || typeof source !== "object") return noteOf(source);
  return noteOf({ code: source.code, message: source.diagnostic ?? source.error });
}

// 测试读取读到的余额，按上游自己的币种写（§3.3）：美元「$12.30」，人民币「¥12.30」，别的只写数
export function testBalanceText(result: ConnectionTestResult) {
  if (result.remaining == null || !Number.isFinite(Number(result.remaining))) return null;
  const amount = Number(result.remaining);
  if (result.currency === "USD") return formatUsd(amount);
  return formatMoney(amount, { symbol: result.currency === "CNY" ? "¥" : "" });
}

export function hostOf(baseUrl: any) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  try {
    return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).host || raw;
  } catch {
    return raw;
  }
}

export type FixedNow = ReturnType<typeof fixedCostNowOf>;

// 可用天数一格：days 给进度条，text 是格子里的字
export type RunwayView = { days: number | null; level: Level; failed?: boolean; text: string } | null;

export type StationView = {
  s: any;
  id: string;
  archived: boolean;
  fixed: boolean;
  host: string;
  level: Level;
  // 状态名；正常时是空串，界面不标（§2 第 5 条）
  statusLabel: string;
  statusNote: string | null;
  issue: ConnectionIssue | null;
  checkedAt: string | null;
  // 折人民币用的汇率，没设置时是 1（§7）
  rate: number;
  // 排序用的可用天数；null 表示算不出，排在最后
  sortDays: number | null;
  runway: RunwayView;
  fx: FixedNow | null;
  attention: boolean;
};

// 余额这一档的说明（上游列表状态格的下一行，ui-copy-spec §3.3）：余额偏低说提醒线，快用完说按哪条线算快，用完说要充值
function tierNoteOf(s: any, view: { state: string | null; level: string }, settings: any, rules: any): string | null {
  if (view.state === "low") return COPY.tierLow(balanceMoneyOf(s, lowLineOf(s, settings)).text);
  if (view.state === "soon") {
    // 红色按告警中心设的提醒天数（按它的单位写，和告警中心一样）；黄色是固定的 7 天（提醒天数比 7 天长时就是提醒天数）
    const windowDays = etaWindowDays(rules);
    return COPY.tierSoon(view.level === "crit" || windowDays >= WATCH_DAYS ? etaWindowText(rules) : `${WATCH_DAYS} 天`);
  }
  if (view.state === "empty") return COPY.tierEmpty;
  return null;
}

export function buildStationView(
  s: any,
  ctx: { settings: any; rules: any; tz: string; check?: StationCheck; attention: boolean; now: number },
): StationView {
  const { settings, rules, tz, check, attention, now } = ctx;
  const archived = !!s.archivedAt;
  const fixed = s.type === "fixed";
  const base = { s, id: String(s.id), archived, fixed, host: hostOf(s.baseUrl), rate: rateSnapshotOf(s).cnyPerUsd, attention };
  const archivedRow = {
    level: "muted" as Level,
    statusLabel: COPY.archived,
    statusNote: Number.isFinite(Date.parse(s.archivedAt)) ? COPY.archivedOn(formatZonedDate(s.archivedAt, tz, now)) : null,
    issue: null,
    sortDays: null,
    runway: null,
  };

  if (fixed) {
    const fx = fixedCostNowOf(purchasesOf(s), { now, tz });
    if (archived) return { ...base, ...archivedRow, checkedAt: null, fx };
    const remain = fx.nextEnd == null ? null : Math.ceil((fx.nextEnd - now) / DAY_MS);
    const soon = remain != null && remain <= etaWindowDays(rules);
    let level: Level = "good";
    let statusLabel = "";
    let statusNote: string | null = fx.note || (fx.nextEnd != null ? COPY.fixedNextEnd(formatZonedDate(fx.nextEnd, tz, now)) : null);
    if (!fx.total) {
      level = "muted";
      statusLabel = COPY.fixedNone;
      statusNote = null;
    } else if (!fx.active && !fx.upcoming) {
      level = "muted";
      statusLabel = COPY.fixedExpired;
      statusNote = COPY.fixedRenew;
    } else if (!fx.active) {
      level = "muted";
      statusLabel = COPY.fixedUpcoming;
    } else if (soon) {
      // 不再续费的不提醒到期（和运营总览一致）
      level = s.noRenewal ? "muted" : "warn";
      statusLabel = COPY.fixedEndsIn(remain);
    }
    const runway: RunwayView = remain == null
      ? null
      : { days: remain, level: soon ? (s.noRenewal ? "muted" : "warn") : "good", text: COPY.fixedLeft(remain) };
    return { ...base, level, statusLabel, statusNote, issue: null, checkedAt: null, sortDays: remain, runway, fx };
  }

  const b = s.balance;
  const issue = check?.issue || (b && !b.ok ? resultIssue(b) : null);
  const checkedAt = check?.checkedAt || b?.checkedAt || null;
  if (archived) return { ...base, ...archivedRow, checkedAt, fx: null };
  if (issue) {
    return {
      ...base, level: "crit", statusLabel: BALANCE_STATE_TEXT.unreadable, statusNote: issue.text, issue, checkedAt, sortDays: null,
      runway: { days: null, level: "crit", failed: true, text: EMPTY }, fx: null,
    };
  }
  const view = balanceViewOf(s, { settings, rules });
  if (view.state === "pending" || view.state === "unreadable") {
    return { ...base, level: view.level, statusLabel: BALANCE_STATE_TEXT[view.state], statusNote: null, issue: null, checkedAt, sortDays: null, runway: null, fx: null };
  }
  const { days, level } = view;
  // 天数只在可用天数一格里写，状态格不重复（ui-copy-spec §3.3、ui-design-spec §5.2）。
  // 不再续费的和自营站点不提醒余额（balanceViewOf 已把颜色降掉），这里交代一句
  const statusNote: string | null = view.state && level === "muted" && (s.noRenewal || s.isOwn) ? (s.noRenewal ? COPY.noRenewal : COPY.own) : tierNoteOf(s, view, settings, rules);
  const runway: RunwayView = days == null
    ? { days: null, level: "muted", text: EMPTY }
    : { days, level, text: balanceDaysText(view) };
  return {
    ...base,
    level,
    statusLabel: view.state ? BALANCE_STATE_TEXT[view.state] : "",
    statusNote,
    issue: null,
    checkedAt,
    sortDays: days,
    runway,
    fx: null,
  };
}

// 决定要不要重新测试读取、能不能保存的指纹：只含登录信息，其它字段改动不要求重新测试
export function connectionFingerprint(values: any, stationId: any, needs: string[]) {
  const type = String(values.type || "").trim();
  const fingerprint: Record<string, string | null> = {
    stationId: stationId || null,
    type,
  };
  if (type !== "fixed") fingerprint.baseUrl = String(values.baseUrl || "").trim();
  for (const field of needs) {
    fingerprint[field] = field === "password"
      ? String(values[field] || "")
      : String(values[field] || "").trim();
  }
  return JSON.stringify(fingerprint);
}
