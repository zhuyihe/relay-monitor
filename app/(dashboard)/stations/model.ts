// 上游资源页的纯数据部分：连接字段常量、错误描述、固定成本汇总、每行的展示模型。
// 不含 JSX，表格、移动卡片、抽屉共用同一份计算，避免三处口径不一致。
import { fmtEta, rateOf, statusOf, usd } from "../../../lib/client";
import { describeConnectionFailure } from "../../../lib/connection-test";
import { formatDays, formatMonthDay } from "../../../lib/format";
import { LEVEL_ORDER } from "../../components/status";
import type { Level } from "../../components/status";

export const DAY_MS = 86400000;

export const CONNECTION_FIELDS = new Set(["type", "baseUrl", "accessToken", "apiKey", "userId", "email", "password"]);
export const CONNECTION_INPUT_FIELDS = ["baseUrl", "accessToken", "apiKey", "userId", "email", "password"] as const;

export type ConnectionGuidance = {
  title: string;
  credentials: string;
  address: string;
  lifecycle: string;
  test: string;
};

export const CONNECTION_GUIDANCE: Record<string, ConnectionGuidance> = {
  newapi: {
    title: "New API · 系统访问令牌",
    credentials: "需要系统访问令牌和用户 ID。令牌通常在 New API 后台的「个人设置」中获取，用户 ID 可在同页查看。",
    address: "填写站点根地址，例如 https://relay.example.com；不要填写 /api/user/self、管理后台或具体接口路径。",
    lifecycle: "令牌由上游站点管理；过期、撤销或权限变化后，需要手动更新后重新验证。",
    test: "测试只读取当前账户额度，不会保存凭证、刷新资源或触发告警。",
  },
  "newapi-key": {
    title: "New API · sk 密钥",
    credentials: "需要一个可用的 sk- API 密钥，通常从站点的令牌/密钥管理页创建。",
    address: "填写站点根地址，例如 https://relay.example.com；不要填写 /v1 或 /dashboard/billing 等路径。",
    lifecycle: "密钥的有效期和权限由上游站点控制；失效或被撤销后需替换为新的密钥。",
    test: "测试通过 OpenAI 兼容计费接口读取额度，不会写入资源或触发告警。",
  },
  sub2api: {
    title: "Sub2API · 登录令牌",
    credentials: "需要登录后的访问令牌（JWT），通常在浏览器已登录状态下，从站点账户接口请求的 Authorization 头中获取。",
    address: "填写站点根地址，例如 https://relay.example.com；不要填写 /api/v1/auth/me 等具体接口路径。",
    lifecycle: "JWT 过期、退出登录或被吊销后需手动更换。若希望自动续期，请选择账号密码模式。",
    test: "测试会验证 JWT 是否能读取账户余额，不会保存令牌或触发刷新、告警。",
  },
  "sub2api-password": {
    title: "Sub2API · 账号密码自动续期",
    credentials: "需要可登录的邮箱和密码。保存后，平台会在访问令牌临近过期时自动刷新，无法刷新时再重新登录。",
    address: "填写站点根地址，例如 https://relay.example.com；不要填写登录接口或管理后台路径。",
    lifecycle: "测试只临时验证邮箱和密码，不保存测试期间产生的令牌；保存资源后才会启用自动续期。开启两步验证的账号无法自动登录。",
    test: "测试会完成一次临时登录并读取余额，不写入数据库、不刷新资源，也不触发告警。",
  },
  fixed: {
    title: "固定成本 · 不访问接口",
    credentials: "不需要令牌、密钥、邮箱或密码。",
    address: "不需要填写站点地址；成本通过下方的付费记录按天摊销。",
    lifecycle: "没有令牌续期行为；到期后添加新的付费记录即可继续计入成本。",
    test: "固定成本不测试连接，也不会访问任何外部接口。",
  },
};

// 表格里的类型名：接口返回的 label 带括号说明，列表里太长，这里给短名；未知类型退回 label
const SHORT_TYPE: Record<string, string> = {
  newapi: "New API",
  "newapi-key": "New API 密钥",
  sub2api: "Sub2API",
  "sub2api-password": "Sub2API 账密",
  fixed: "固定成本",
};

export type ConnectionIssue = {
  code?: string;
  category: string;
  message: string;
  action: string;
  diagnostic?: string;
};

export type ConnectionTestResult = ConnectionIssue & {
  ok: boolean;
  latencyMs?: number;
  account?: string | null;
  remaining?: number;
  currency?: string | null;
};

export type StationCheck = { issue: ConnectionIssue; checkedAt: string };

export function resultIssue(result: Partial<ConnectionIssue> | null | undefined, fallback: unknown, station: any = {}): ConnectionIssue {
  const described = describeConnectionFailure(fallback, station);
  return {
    code: result?.code || described.code,
    category: result?.category || described.category,
    message: result?.message || described.message,
    action: result?.action || described.action,
    diagnostic: result?.diagnostic || described.diagnostic,
  };
}

export function testBalanceText(result: ConnectionTestResult) {
  if (!Number.isFinite(Number(result.remaining))) return null;
  const amount = Number(result.remaining);
  return result.currency === "USD"
    ? `余额 ${usd(amount)}`
    : `余额 ${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${result.currency ? ` ${result.currency}` : ""}`;
}

export function relTime(iso: any) {
  if (!iso) return "从未";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.max(0, Math.floor(d))} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  return `${Math.floor(d / 3600)} 小时前`;
}

export function fmtClock(ts: any) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 最近同步列：当天只写时分，跨天补日期，免得把昨天的数据看成刚同步
export function syncTime(ts: any) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
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

// 与总览 buildOverviewActions 的窗口一致：规则里的 etaDays，缺省 3 天
export function critDaysOf(rules: any) {
  const v = Number(rules?.etaDays);
  return Number.isFinite(v) && v > 0 ? v : 3;
}
export const WARN_DAYS = 7;
export const MAX_DAYS = 14;

// 固定成本汇总（逐笔判断生效 / 待生效 / 到期，与旧版口径一致）
export type FixedSummary = {
  total: number;
  daily: number;
  active: number;
  pendingStart: number;
  nextEnd: number | null;
  remain: number | null;
  expiredAll: boolean;
};
export function fixedSummary(s: any, now = Date.now()): FixedSummary {
  const ps = Array.isArray(s.fixedPurchases) ? s.fixedPurchases : [];
  let daily = 0, active = 0, pendingStart = 0, nextEnd: number | null = null;
  for (const p of ps) {
    const d = p.amount > 0 && p.days > 0 ? p.amount / p.days : 0;
    if (!p.startDate) { daily += d; active++; continue; }
    const st = Date.parse(p.startDate + "T00:00:00");
    const end = st + p.days * DAY_MS;
    if (st > now) { pendingStart++; continue; }
    if (end > now) {
      daily += d; active++;
      if (nextEnd == null || end < nextEnd) nextEnd = end;
    }
  }
  return {
    total: ps.length,
    daily,
    active,
    pendingStart,
    nextEnd,
    remain: nextEnd == null ? null : Math.ceil((nextEnd - now) / DAY_MS),
    expiredAll: ps.length > 0 && active === 0 && pendingStart === 0,
  };
}

export type RunwayView = { days: number | null; level: Level; failed?: boolean; text: string } | null;

export type StationView = {
  s: any;
  id: string;
  archived: boolean;
  fixed: boolean;
  typeLabel: string;
  host: string;
  level: Level;
  statusLabel: string;
  statusNote: string | null;
  issue: ConnectionIssue | null;
  checkedAt: string | null;
  rate: number;
  // 排序用的可用天数；null 表示无法计算，排在最后
  sortDays: number | null;
  runway: RunwayView;
  fx: FixedSummary | null;
  attention: boolean;
};

const runwayLevel = (days: number, critDays: number): Level => (days <= critDays ? "crit" : days <= WARN_DAYS ? "warn" : "good");

export function buildStationView(
  s: any,
  ctx: { settings: any; critDays: number; typeName: (t: string) => string; check?: StationCheck; attention: boolean; now: number },
): StationView {
  const { settings, critDays, check, attention, now } = ctx;
  const archived = !!s.archivedAt;
  const fixed = s.type === "fixed";
  const base = {
    s,
    id: String(s.id),
    archived,
    fixed,
    typeLabel: SHORT_TYPE[s.type] || ctx.typeName(s.type),
    host: hostOf(s.baseUrl),
    rate: rateOf(s),
    attention,
  };

  if (fixed) {
    const fx = fixedSummary(s, now);
    let level: Level = "good";
    let statusLabel = "生效中";
    let statusNote: string | null = fx.nextEnd != null ? `最近一笔 ${formatMonthDay(fx.nextEnd)}到期` : null;
    if (fx.expiredAll) {
      level = "muted";
      statusLabel = "已到期";
      statusNote = "已全部到期，续费请追加付费记录";
    } else if (!fx.total) {
      level = "muted";
      statusLabel = "无付费记录";
      statusNote = null;
    } else if (fx.active === 0 && fx.pendingStart > 0) {
      level = "muted";
      statusLabel = "待生效";
    } else if (fx.remain != null && fx.remain <= critDays) {
      // 标记为不再续费的不再提醒到期（与运营总览一致）
      level = s.noRenewal ? "muted" : "warn";
      statusLabel = `${fx.remain} 天后到期`;
    }
    const runway: RunwayView = fx.remain != null
      ? { days: fx.remain, level: fx.remain <= critDays ? "warn" : "good", text: `剩 ${fx.remain} 天` }
      : { days: null, level: "muted", text: fx.expiredAll ? "已到期" : fx.active === 0 && fx.pendingStart > 0 ? "待生效" : "暂无到期日" };
    if (archived) return { ...base, level: "muted", statusLabel: "已归档", statusNote: archivedNote(s), issue: null, checkedAt: null, sortDays: null, runway: null, fx };
    return { ...base, level, statusLabel, statusNote, issue: null, checkedAt: null, sortDays: fx.remain, runway, fx };
  }

  const b = s.balance;
  const issue = check?.issue || (b && !b.ok ? resultIssue(null, b.error) : null);
  const checkedAt = check?.checkedAt || b?.checkedAt || null;
  if (archived) {
    return { ...base, level: "muted", statusLabel: "已归档", statusNote: archivedNote(s), issue: null, checkedAt, sortDays: null, runway: null, fx: null };
  }
  if (issue) {
    return {
      ...base, level: "crit", statusLabel: "查询失败", statusNote: issue.message, issue, checkedAt, sortDays: null,
      runway: { days: null, level: "crit", failed: true, text: "无法计算" }, fx: null,
    };
  }
  if (!b) {
    return { ...base, level: "muted", statusLabel: "待刷新", statusNote: "尚未查询", issue: null, checkedAt, sortDays: null, runway: null, fx: null };
  }
  const st = statusOf(s, settings);
  const p = s.prediction;
  const burn = p?.burnPerDay;
  const eta = p?.etaDays;
  let runway: RunwayView;
  if (st === "danger") runway = { days: 0, level: "crit", text: "已耗尽" };
  else if (burn === 0) runway = { days: Infinity, level: "good", text: "无消耗" };
  else if (eta != null && Number.isFinite(Number(eta))) runway = { days: Number(eta), level: runwayLevel(Number(eta), critDays), text: formatDays(eta) };
  else runway = { days: null, level: "muted", text: "无法计算" };

  let level: Level = "good";
  let statusLabel = "正常";
  let statusNote: string | null = null;
  if (st === "danger") {
    level = "crit";
    statusLabel = "已耗尽";
  } else if (st === "warn") {
    level = "warn";
    statusLabel = "余额偏低";
  }
  // 再看耗尽预测，取两者中更严重的：阈值内算紧急，7 天内算注意（与运营总览、上游余量同一口径）
  if (burn > 0 && eta != null) {
    const etaLevel = runwayLevel(Number(eta), critDays);
    if (etaLevel !== "good" && LEVEL_ORDER[etaLevel] < LEVEL_ORDER[level]) {
      level = etaLevel;
      if (st !== "warn") statusLabel = etaLevel === "crit" ? "即将耗尽" : "7 天内耗尽";
    }
  }
  if (burn > 0 && eta != null) statusNote = `预计 ${fmtEta(eta)}后耗尽`;
  // 不再续费的资源与自营站点不做余额提醒（与运营总览一致），只保留文字
  if ((s.noRenewal || s.isOwn) && (level === "crit" || level === "warn")) {
    level = "muted";
    statusNote = s.noRenewal ? "已标记不再续费，不再提醒" : "自营站点不做余额提醒";
  }
  const sortDays = runway && runway.days != null ? runway.days : null;
  return { ...base, level, statusLabel, statusNote, issue: null, checkedAt, sortDays, runway, fx: null };
}

function archivedNote(s: any) {
  const t = Date.parse(s.archivedAt);
  return Number.isFinite(t) ? `归档于 ${formatMonthDay(t)}` : null;
}

// 驱动连接测试 / 保存门槛的指纹：只含连接字段，其它字段改动不要求重新测试
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
