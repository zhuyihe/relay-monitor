// 中转站余额查询适配器
// 支持三类中转站架构：
//   - newapi     : new-api / one-api 家族，使用「系统访问令牌 + 用户 ID」查询 /api/user/self
//   - newapi-key : new-api / one-api 家族，使用 OpenAI 兼容计费接口 + sk 密钥
//   - sub2api    : Sub2API，支持两种凭证模式：
//       · token    — 直接给登录 JWT，过期即失效
//       · password — 给邮箱 + 密码，自动登录换取令牌；过期时先用 refresh_token
//                    刷新（POST /api/v1/auth/refresh，令牌会轮换），刷新失败则
//                    用密码重新登录（POST /api/v1/auth/login），全自动恢复。
//
// Sub2API 接口契约（源自 Wei-Shaw/sub2api 后端源码）：
//   POST /api/v1/auth/login    body {email, password, turnstile_token?} → {code:0, data:{access_token, refresh_token, expires_in, user}}
//   POST /api/v1/auth/refresh  body {refresh_token}     → {code:0, data:{access_token, refresh_token, expires_in}}
//   GET  /api/v1/auth/me       Bearer JWT               → {code:0, data:{username, email, balance, total_recharged, ...}}
//   过期：HTTP 401，body {code:"TOKEN_EXPIRED"}；开启 2FA 的账号 login 返回 data.requires_2fa

import { capTokenForLogin } from "./cap.js";
import { createHash } from "node:crypto";
import { connectionDiagnostic } from "./connection-test.js";
import { endpointKey } from "./endpoint.js";
import { ACCESS_TOKEN_LEGACY_RETIRED, ACCESS_TOKEN_SCOPE_DENIED, isAccessTokenError, missingScopeOf } from "./access-token-scopes.js";
import { noteOwnRequest } from "./own-request-budget.js";
import { parseConsumeLogValue } from "./consume-log.js";
import { connectionFailed, errorCodeOf } from "./error-copy.js";
import { UPSTREAM_TYPES, onboardingBaseUrl } from "./channel-onboarding.js";
import { canonicalTimeZone, dayKeyInTz, dayStartInTz, isDayStartInTz } from "./business-time.js";
import {
  RECONCILIATION_BILLING_SOURCE,
  RECONCILIATION_CALCULATION_VERSION,
} from "./reconciliation-contract.js";

// new-api / one-api 的额度单位换算：默认 500000 额度 = 1 美元
const QUOTA_PER_UNIT = 500000;
// 主动刷新缓冲：令牌剩余寿命低于该值就先刷新（与官方客户端一致）
const TOKEN_REFRESH_BUFFER_MS = 120 * 1000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

function trimBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

// 本项目的时间窗统一使用 [startMs, endMs)；new-api 的秒级参数结束值是包含式。
// 只请求完整落在窗口内的秒，避免相邻分段重叠，也不能因它是第几个分段而改变归属。
export function unixSecondWindow(startMs, endMs) {
  const start = Math.ceil(startMs / 1000);
  const inclusiveEnd = Math.floor(endMs / 1000) - 1;
  if (start > inclusiveEnd) return { start, end: inclusiveEnd, empty: true };
  return { start, end: inclusiveEnd };
}

function emptySecondRows() {
  return Object.assign([], { emptySecondWindow: true });
}

// 读上游失败的报错：code 给界面归类（lib/error-copy.js §8.2），message 是脱敏后的原文，只进「查看详细原因」。
function providerError(code, message) {
  return Object.assign(new Error(message), code ? { code } : {});
}

// 发起请求：网络错误/超时抛异常；HTTP 状态由调用方判断
async function request(url, { method = "GET", headers = {}, json = null, timeoutMs = 9000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const credentials = { accessToken: headers.Authorization, password: json?.password,
    email: json?.email, refreshToken: json?.refresh_token };
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(json != null ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: json != null ? JSON.stringify(json) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { __raw: text }; }
    if (body && typeof body === "object" && (res.status >= 300 || body.success === false || typeof body.code === "number" && body.code !== 0)) {
      // 少了权限时 New API 在 message 里点出的那一项要在脱敏之前抓：像 api_key:read、api_key:reveal 这类名字，
      // 和脱敏规则要盖的「api_key: 实际值」撞了字面（都是 api_key 后面一个冒号），脱敏会把 read/reveal 那半截抹掉
      if (body.code === ACCESS_TOKEN_SCOPE_DENIED) body.scope = missingScopeOf(String(body.message || body.error?.message || body.error || ""));
      for (const key of ["message", "msg", "__raw"]) if (typeof body[key] === "string") {
        body[key] = connectionDiagnostic(body[key], credentials);
      }
      if (typeof body.error === "string") body.error = connectionDiagnostic(body.error, credentials);
      else if (typeof body.error?.message === "string") body.error.message = connectionDiagnostic(body.error.message, credentials);
    }
    // 每个请求按站点地址记进额度和断路（lib/own-request-budget.js）：整站日志读取按它决定这轮发几个
    noteOwnRequest(url, { status: res.status, elapsedMs: Date.now() - startedAt });
    return { status: res.status, body, credentials, retryAfter: res.headers?.get?.("retry-after") ?? null };
  } catch (error) {
    noteOwnRequest(url, { status: 0, elapsedMs: Date.now() - startedAt });
    throw providerError(requestErrorCode(error), connectionDiagnostic(error, credentials));
  } finally {
    clearTimeout(timer);
  }
}

// 请求没成的码：地址写得不成样子（解析不了）算地址不对；别的没连上对方（超时、被中止、网络层报错，lib/error-copy.js connectionFailed）算连不上；
// 别的（比如令牌里混进中文字符，请求头发不出去）不给码，按原文归类
function requestErrorCode(error) {
  if ([error?.code, error?.cause?.code].includes("ERR_INVALID_URL")) return "ENDPOINT_MISMATCH";
  return connectionFailed(error) ? "NETWORK_UNREACHABLE" : null;
}

// 上游的 HTTP 状态 → 码：401 登录信息不对，403 没有权限，404 地址或类型不对，429 和 5xx 上游繁忙；其余不给码，按原文归类。
const UPSTREAM_STATUS_CODES = Object.freeze({
  401: "AUTHENTICATION_FAILED", 403: "UPSTREAM_AUTH_DENIED", 404: "ENDPOINT_MISMATCH", 429: "UPSTREAM_REQUEST_FAILED",
});

// New API 新式令牌的两个报错（own-revenue-plan 第三节，只有 rc.41 以上会出现）：响应体里带 code。
//   ACCESS_TOKEN_LEGACY_RETIRED（401）旧式令牌作废；ACCESS_TOKEN_SCOPE_DENIED（403）少了权限，message 里点出少的是哪一项（err.scope）。
// 认出就抛带码的错：它们要人换令牌，不能再当成「登录信息不对」「上游拒绝读取这把 Key」「暂时读不到」等 7 天；说明里不写版本。
// 没带这两个码的 401、403 照旧。
function accessTokenError(r) {
  const code = r?.body?.code ?? r?.body?.error?.code;
  if (code !== ACCESS_TOKEN_LEGACY_RETIRED && code !== ACCESS_TOKEN_SCOPE_DENIED) return null;
  const raw = String(r.body?.message || r.body?.error?.message || r.body?.error || "");
  const err = providerError(code, code === ACCESS_TOKEN_LEGACY_RETIRED ? "访问令牌已作废" : "访问令牌少了权限");
  // request() 已经在脱敏之前抓过一次（见上）；直接构造 r.body 的单测没走那一步，退回现读（多数权限名和脱敏规则不撞字面，现读也对）
  if (code === ACCESS_TOKEN_SCOPE_DENIED) err.scope = r.body?.scope ?? missingScopeOf(raw);
  return err;
}

function httpError(r, prefix = "") {
  const tokenError = accessTokenError(r);
  if (tokenError) return tokenError;
  const b = r.body || {};
  const msg = b.message || b.error?.message || b.error || b.msg || `HTTP ${r.status}`;
  const code = UPSTREAM_STATUS_CODES[r.status] || (r.status >= 500 ? "UPSTREAM_REQUEST_FAILED" : null);
  return providerError(code, prefix + connectionDiagnostic(String(msg), r.credentials).slice(0, 200));
}

// ---- new-api / one-api：访问令牌模式 ---------------------------------------
async function queryNewApi(station) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  const userId = String(station.userId || "").trim();
  if (!base) throw providerError("MISSING_CONFIGURATION", "缺少站点地址");
  if (!token) throw providerError("MISSING_CONFIGURATION", "缺少访问令牌 (系统访问令牌)");

  const headers = { Authorization: token };
  if (userId) headers["New-Api-User"] = userId;

  const r = await request(`${base}/api/user/self`, { headers });
  if (r.status >= 300) throw httpError(r);
  // one-api / new-api 对无效令牌返回 HTTP 200 + {success:false}，不能当作 $0 余额
  if (r.body?.success === false) throw httpError(r);
  const data = r.body?.data ?? r.body ?? {};
  if (data.quota == null || !Number.isFinite(Number(data.quota))) {
    throw providerError("ENDPOINT_MISMATCH", "响应中没有额度数据（quota），请检查站点地址与令牌");
  }
  const remainUnits = num(data.quota);
  const usedUnits = num(data.used_quota);

  return {
    remaining: round2(remainUnits / QUOTA_PER_UNIT),
    used: round2(usedUnits / QUOTA_PER_UNIT),
    total: round2((remainUnits + usedUnits) / QUOTA_PER_UNIT),
    currency: "USD",
    account: data.username || data.display_name || null,
    raw: { quota: remainUnits, used_quota: usedUnits, requests: num(data.request_count) },
  };
}

// ---- new-api / one-api：OpenAI 兼容计费接口 + sk 密钥 ----------------------
async function queryNewApiKey(station) {
  const base = trimBase(station.baseUrl);
  const key = String(station.apiKey || "").trim();
  if (!base) throw providerError("MISSING_CONFIGURATION", "缺少站点地址");
  if (!key) throw providerError("MISSING_CONFIGURATION", "缺少 API 密钥 (sk-...)");

  const headers = { Authorization: `Bearer ${key}` };
  const sub = await request(`${base}/dashboard/billing/subscription`, { headers });
  if (sub.status >= 300) throw httpError(sub);
  // 非 JSON 200（登录页/反代错误页）或异常响应不能当作 $0 额度
  if (sub.body?.hard_limit_usd == null || !Number.isFinite(Number(sub.body.hard_limit_usd))) {
    throw providerError("ENDPOINT_MISMATCH", "响应中没有额度数据（hard_limit_usd），请检查站点地址与密钥");
  }
  const total = num(sub.body.hard_limit_usd);

  let used = 0;
  try {
    const usage = await request(`${base}/dashboard/billing/usage`, { headers });
    if (usage.status < 300) used = num(usage.body.total_usage) / 100; // total_usage 单位为美分
  } catch {
    used = 0; // 部分站点未开放 usage 接口
  }

  return {
    remaining: round2(Math.max(total - used, 0)),
    used: round2(used),
    total: round2(total),
    currency: "USD",
    account: null,
    raw: { hard_limit_usd: total, access_until: sub.body.access_until ?? null },
  };
}

// ---- Sub2API ----------------------------------------------------------------

// 解析 Sub2API 响应包裹 {code, message, data}；code 非 0 视为业务错误
function unwrapEnvelope(r, what) {
  const b = r.body || {};
  if (typeof b.code === "number" && b.code !== 0) {
    throw providerError(null, `${what}失败：${connectionDiagnostic(b.message || "code " + b.code, r.credentials)}`);
  }
  return b.data ?? b;
}

async function sub2apiLogin(base, station, tokens) {
  const email = String(station.email || "").trim();
  const password = String(station.password || "");
  if (!email || !password) throw providerError("MISSING_CONFIGURATION", "缺少邮箱或密码");

  let captchaToken;
  // 连不上时 request 已经带了码；其余是人机验证没解开
  try { captchaToken = await capTokenForLogin(base, request); }
  catch (error) { throw error?.code ? error : providerError("CAPTCHA_REQUIRED", connectionDiagnostic(error)); }
  const r = await request(`${base}/api/v1/auth/login`, {
    method: "POST",
    json: {
      email,
      password,
      ...(captchaToken ? { turnstile_token: captchaToken } : {}),
    },
  });
  if (r.status === 401) throw providerError("AUTHENTICATION_FAILED", "登录失败：邮箱或密码错误");
  if (r.status === 429) throw providerError("UPSTREAM_REQUEST_FAILED", "登录失败：请求过于频繁（站点限流），稍后自动重试");
  // 登录被拒（403）多是账号停用或人机验证没过，不按「没有读取权限」说，交给原文归类
  if (r.status === 403) throw providerError(null, `登录失败：${httpError(r).message}`);
  if (r.status >= 300) throw httpError(r, "登录失败：");
  const data = unwrapEnvelope(r, "登录");

  if (data?.requires_2fa) {
    throw providerError("TWO_FACTOR_ENABLED", "该账号开启了两步验证(2FA)，无法自动登录，请改用「登录令牌」模式");
  }
  if (!data?.access_token) throw providerError("UPSTREAM_RESPONSE_INVALID", "登录响应缺少 access_token");

  tokens.accessToken = data.access_token;
  tokens.refreshToken = data.refresh_token || "";
  tokens.expiresAt = data.expires_in > 0 ? Date.now() + data.expires_in * 1000 : Date.now() + 23 * 3600 * 1000;
  tokens.lastLoginAt = new Date().toISOString();
  return true;
}

// 用 refresh_token 换新令牌；注意令牌会轮换（旧 refresh_token 立即失效）
async function sub2apiRefresh(base, tokens) {
  if (!tokens.refreshToken) return false;
  try {
    const headers = tokens.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {};
    const r = await request(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers,
      json: { refresh_token: tokens.refreshToken },
    });
    if (r.status >= 300) return false;
    const b = r.body || {};
    if (typeof b.code === "number" && b.code !== 0) return false;
    const data = b.data ?? b;
    if (!data?.access_token || !data?.refresh_token || !(data.expires_in > 0)) return false;
    tokens.accessToken = data.access_token;
    tokens.refreshToken = data.refresh_token;
    tokens.expiresAt = Date.now() + data.expires_in * 1000;
    return true;
  } catch {
    return false;
  }
}

function parseSub2ApiMe(data) {
  const balance = num(data.balance);
  const totalRecharged = num(data.total_recharged);
  const quotaTotal = num(data.quota);
  const quotaUsed = num(data.quota_used ?? data.used_quota);

  let remaining, used, total;
  if (quotaTotal > 0) {
    // 配额制：quota / quota_used
    total = quotaTotal;
    used = quotaUsed;
    remaining = Math.max(quotaTotal - quotaUsed, 0);
  } else if (totalRecharged > 0) {
    // 余额制：balance + 历史累充
    remaining = balance;
    total = totalRecharged;
    used = Math.max(totalRecharged - balance, 0);
  } else {
    remaining = balance;
    used = quotaUsed;
    total = balance + quotaUsed;
  }

  return {
    remaining: round2(remaining),
    used: round2(used),
    total: round2(total),
    currency: "USD",
    account: data.username || data.email || data.name || null,
    raw: { balance, total_recharged: totalRecharged, quota: quotaTotal, quota_used: quotaUsed },
  };
}

async function querySub2Api(station) {
  const base = trimBase(station.baseUrl);
  if (!base) throw providerError("MISSING_CONFIGURATION", "缺少站点地址");

  const passwordMode = station.type === "sub2api-password" || station.authMode === "password";
  // 密码模式：令牌缓存在 station.s2Tokens（由 server 持久化）
  const tokens = passwordMode ? sub2Tokens(station, base) : null;
  let tokensChanged = false;

  const ensureToken = async () => {
    if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) return;
    if (await sub2apiRefresh(base, tokens)) { tokensChanged = true; return; }
    await sub2apiLogin(base, station, tokens);
    tokensChanged = true;
  };

  const bearerOf = () =>
    passwordMode ? tokens.accessToken : String(station.accessToken || station.apiKey || "").trim();

  if (passwordMode) {
    await ensureToken();
  } else if (!bearerOf()) {
    throw providerError("MISSING_CONFIGURATION", "缺少登录令牌 (Sub2API JWT)");
  }

  const fetchMe = () =>
    request(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${bearerOf()}` } });

  let r = await fetchMe();

  // 401（TOKEN_EXPIRED / 令牌被吊销等）→ 密码模式自动恢复：先刷新，再重登录，重试一次
  if (r.status === 401 && passwordMode) {
    tokens.accessToken = "";
    if (!(await sub2apiRefresh(base, tokens))) {
      await sub2apiLogin(base, station, tokens);
    }
    tokensChanged = true;
    r = await fetchMe();
  }
  if (r.status === 401) {
    throw providerError("AUTHENTICATION_FAILED", passwordMode ? "登录后仍被拒绝（401），请检查账号状态" : "令牌无效或已过期，请更新令牌或改用账号密码模式");
  }
  if (r.status >= 300) throw httpError(r);

  const data = unwrapEnvelope(r, "查询");

  // 今日消耗：读取站点用户仪表盘同款接口（today_actual_cost = 今日实际扣费），
  // 与站点页面显示完全一致；老版本没有该接口时静默降级为历史推算
  let todayUsed = null, todayRequests = null, todayTokens = null;
  try {
    const st = await request(`${base}/api/v1/usage/dashboard/stats`, {
      headers: { Authorization: `Bearer ${bearerOf()}` },
    });
    if (st.status < 300 && st.body?.code === 0 && st.body.data) {
      const d = st.body.data;
      if (Number.isFinite(Number(d.today_actual_cost))) {
        todayUsed = round2(Number(d.today_actual_cost));
        todayRequests = Number.isFinite(Number(d.today_requests)) ? Number(d.today_requests) : null;
        todayTokens = Number.isFinite(Number(d.today_tokens)) ? Number(d.today_tokens) : null;
      }
    }
  } catch { /* 不影响余额查询 */ }

  return { ...parseSub2ApiMe(data), todayUsed, todayRequests, todayTokens, tokensChanged };
}

// ---- 用量明细（分模型 / 分时间）--------------------------------------------

// 小时级趋势的时区推断：站点返回的小时标签不带时区，且不同部署对 timezone
// 参数的处理不一致。把「最后一个小时桶 = 当前小时」作为锚点反推偏移，
// 得到真实时间戳（偏移取整到 15 分钟，容忍半点时区）。
function inferHourlyTimes(trend) {
  let lastNaive = null;
  for (let i = trend.length - 1; i >= 0; i--) {
    if (trend[i]._naiveUtc != null) { lastNaive = trend[i]._naiveUtc; break; }
  }
  if (lastNaive == null) return trend.map(({ _naiveUtc, ...p }) => ({ ...p, t: null }));
  const nowHour = Math.floor(Date.now() / 3600000) * 3600000;
  const offset = Math.round((lastNaive - nowHour) / 900000) * 900000;
  return trend.map(({ _naiveUtc, ...p }) => ({ ...p, t: _naiveUtc != null ? _naiveUtc - offset : null }));
}

// 密码模式缓存的登录令牌，记下是哪个站点发的（lib/endpoint.js）：站点对不上就作废、重新登录。
// 改地址时正在跑的查询会用旧地址登录、把旧站点的令牌写回来，这样它就不会被带到新地址去
function sub2Tokens(station, base) {
  const tokens = (station.s2Tokens ||= {});
  const site = endpointKey(base);
  if (tokens.site && tokens.site !== site) for (const key of Object.keys(tokens)) delete tokens[key];
  tokens.site = site;
  return tokens;
}

// 取可用的 Sub2API bearer；密码模式沿用 s2Tokens 缓存并自动登录/刷新
async function sub2apiBearer(station, base, force = false) {
  const passwordMode = station.type === "sub2api-password" || station.authMode === "password";
  if (!passwordMode) {
    const t = String(station.accessToken || station.apiKey || "").trim();
    if (!t) throw providerError("MISSING_CONFIGURATION", "缺少登录令牌 (Sub2API JWT)");
    return t;
  }
  const tokens = sub2Tokens(station, base);
  if (!force && tokens.accessToken && tokens.expiresAt &&
      tokens.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return tokens.accessToken;
  }
  if (force) tokens.accessToken = "";
  if (!(await sub2apiRefresh(base, tokens))) await sub2apiLogin(base, station, tokens);
  return tokens.accessToken;
}

function normSub2Models(models) {
  return (models || []).map((m) => ({
    model: m.model || "unknown",
    tokens: num(m.total_tokens),
    cost: num(m.actual_cost ?? m.cost),
    requests: num(m.requests),
    inputTokens: num(m.input_tokens),
    outputTokens: num(m.output_tokens),
  })).sort((a, b) => b.tokens - a.tokens);
}

function normSub2Trend(trend, tz, granularity) {
  const rows = (trend || []).map((p) => ({
    // 按天的标签是 YYYY-MM-DD：取 tz 下那天的 0 点（切夏令时那天也归到当天）；认不出的给 null
    t: granularity === "hour" ? null : dayStartInTz(p.date, tz),
    _naiveUtc: granularity === "hour"
      ? (Number.isNaN(Date.parse(String(p.date ?? "").replace(" ", "T") + "Z")) ? null : Date.parse(String(p.date).replace(" ", "T") + "Z"))
      : null,
    label: String(p.date ?? ""),
    tokens: num(p.total_tokens),
    cost: num(p.actual_cost ?? p.cost),
    requests: num(p.requests),
  }));
  return granularity === "hour" ? inferHourlyTimes(rows) : rows.map(({ _naiveUtc, ...p }) => p);
}

async function sub2apiUsage(station, { startMs, endMs, granularity, tz, exactWindow, wantToday }) {
  const base = trimBase(station.baseUrl);
  if (!base) throw providerError("MISSING_CONFIGURATION", "缺少站点地址");
  const lastMs = Math.max(startMs, endMs - 1);
  const params = {
    start_date: dayKeyInTz(startMs, tz),
    end_date: dayKeyInTz(lastMs, tz),
    granularity,
    timezone: tz,
  };
  // Sub2API 的用量接口只支持自然日参数：滚动窗口（近 24 小时）时查两天、
  // 小时趋势截取到窗口内；模型明细无法按小时截取，标记后由前端注明口径
  const finish = async (models, trend) => {
    const out = {
      models,
      trend: exactWindow ? trend.filter((p) => p.t == null || p.t >= startMs - 3600000) : trend,
      modelsWindow: exactWindow ? "date" : "exact",
    };
    // 「今天」的合计直接取站点仪表盘同款数字（today_actual_cost 等），
    // 各部署对 timezone 参数处理不一，这是唯一和站点页面显示逐字一致的口径
    if (wantToday) {
      try {
        const st = await get("/api/v1/usage/dashboard/stats", {});
        if (st.status < 300 && st.body?.code === 0 && st.body.data) {
          const d = st.body.data;
          out.summary = {
            cost: num(d.today_actual_cost),
            tokens: num(d.today_tokens),
            requests: num(d.today_requests),
          };
        }
      } catch { /* 拿不到就用 models 求和兜底 */ }
    }
    return out;
  };
  const get = async (path, extra) => {
    let bearer = await sub2apiBearer(station, base);
    let r = await request(`${base}${path}?${new URLSearchParams({ ...params, ...extra })}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (r.status === 401 && station.type === "sub2api-password") {
      bearer = await sub2apiBearer(station, base, true);
      r = await request(`${base}${path}?${new URLSearchParams({ ...params, ...extra })}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
    }
    return r;
  };

  // 首选 snapshot-v2 一次拿全；老版本站点回退到 trend + models 两个接口
  const snap = await get("/api/v1/usage/dashboard/snapshot-v2", {
    include_trend: "true", include_model_stats: "true",
  });
  if (snap.status < 300 && snap.body?.code === 0 && snap.body.data) {
    const d = snap.body.data;
    return finish(normSub2Models(d.models), normSub2Trend(d.trend, tz, granularity));
  }
  const [tr, mo] = await Promise.all([
    get("/api/v1/usage/dashboard/trend"),
    get("/api/v1/usage/dashboard/models"),
  ]);
  if (tr.status >= 300 && mo.status >= 300) throw httpError(tr);
  return finish(
    mo.status < 300 && mo.body?.code === 0 ? normSub2Models(mo.body.data?.models) : [],
    tr.status < 300 && tr.body?.code === 0 ? normSub2Trend(tr.body.data?.trend, tz, granularity) : []
  );
}

async function newApiUsage(station, { startMs, endMs }) {
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) {
    return {
      models: [], trend: [], modelsWindow: "exact",
      summary: { cost: 0, tokens: 0, requests: 0 },
      emptySecondWindow: true,
    };
  }
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw providerError("MISSING_CONFIGURATION", "缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const qs = `start_timestamp=${window.start}&end_timestamp=${window.end}`;
  const r = await request(`${base}/api/data/self?${qs}`, { headers });
  if (r.status >= 300) throw httpError(r);
  // 数据看板没开：自营站点到 New API 后台打开；上游的由对方决定，按「对方不支持」说
  const featureOff = station.isOwn ? "OWN_FEATURE_DISABLED" : "UPSTREAM_FEATURE_UNSUPPORTED";
  if (r.body?.success === false) throw providerError(r.body?.message ? null : featureOff, r.body?.message || "站点未开启数据看板");
  const rows = Array.isArray(r.body?.data) ? r.body.data : null;
  if (!rows) throw providerError(featureOff, "站点未开启数据看板（DataExportEnabled）");

  const models = new Map(), trend = new Map();
  for (const row of rows) {
    const tokens = num(row.token_used);
    const cost = num(row.quota) / QUOTA_PER_UNIT;
    const reqs = num(row.count);
    const name = row.model_name || "unknown";
    const m = models.get(name) || { model: name, tokens: 0, cost: 0, requests: 0, inputTokens: null, outputTokens: null };
    m.tokens += tokens; m.cost += cost; m.requests += reqs;
    models.set(name, m);
    const t = num(row.created_at) * 1000;
    const tr = trend.get(t) || { t, label: "", tokens: 0, cost: 0, requests: 0 };
    tr.tokens += tokens; tr.cost += cost; tr.requests += reqs;
    trend.set(t, tr);
  }
  const modelList = [...models.values()].sort((a, b) => b.tokens - a.tokens);
  return {
    models: modelList,
    trend: [...trend.values()].sort((a, b) => a.t - b.t),
    modelsWindow: "exact", // data/self 按精确时间戳过滤，模型明细与窗口完全一致
    summary: {
      cost: modelList.reduce((a, m) => a + m.cost, 0),
      tokens: modelList.reduce((a, m) => a + m.tokens, 0),
      requests: modelList.reduce((a, m) => a + m.requests, 0),
    },
  };
}

/**
 * 「我的站点」下游数据：new-api 管理员数据看板接口。
 * kind = "model" → GET /api/data/     行按 (model_name, created_at) 聚合
 * kind = "user"  → GET /api/data/users 行按 (username, created_at) 聚合
 * 返回归一化行 [{key, t(ms), tokens, cost($), requests}]
 */
export async function queryOwnData(station, startMs, endMs, kind, { includeQuotaUnits = false } = {}) {
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) return emptySecondRows();
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw providerError("MISSING_CONFIGURATION", "缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const path = kind === "user" ? "/api/data/users" : "/api/data/";
  const qs = `start_timestamp=${window.start}&end_timestamp=${window.end}`;
  const r = await request(`${base}${path}?${qs}`, { headers, timeoutMs: 20000 });
  if (r.status >= 300) throw httpError(r);
  if (r.body?.success === false) {
    const tokenError = accessTokenError(r);
    if (tokenError) throw tokenError;
    const msg = String(r.body?.message || "");
    const denied = /privileg|unauthorized/i.test(msg);
    throw providerError(denied ? "UPSTREAM_AUTH_DENIED" : null, denied
      ? "该令牌没有管理员权限：请使用管理员（root）账号的系统访问令牌与用户 ID"
      : msg || "查询失败");
  }
  const rows = Array.isArray(r.body?.data) ? r.body.data : [];
  return rows.map((row) => ({
    key: (kind === "user" ? row.username : row.model_name) || "unknown",
    t: num(row.created_at) * 1000,
    tokens: num(row.token_used),
    ...(includeQuotaUnits ? { quotaUnits: num(row.quota) } : {}),
    cost: num(row.quota) / QUOTA_PER_UNIT,
    requests: num(row.count),
  }));
}

/**
 * 「我的站点」流向数据：new-api 管理员 GET /api/data/flow。
 * 窗内按 (用户, 分组, 模型, 渠道) 聚合，没有时间维度（要环比就查两个窗口）。
 * 看板的 /api/data/ 只有模型维度，看不出「哪个分组涨了」「换到了哪个上游渠道」；
 * 分组倍率与渠道单价差异是消费突变的常见原因，所以这里单独取一份流向数据。
 * ⚠ new-api 侧 SQL 带 use_group <> '' 过滤：没有分组字段的历史行不会出现，
 * 合计可能小于 /api/data/，覆盖率由调用方计算并提示。
 * 返回 [{user, group, model, channelId, channelName, tokenName, tokens, quotaUnits, cost($), requests}]
 */
export async function queryOwnFlow(station, startMs, endMs, { includeQuotaUnits = false } = {}) {
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) return emptySecondRows();
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw providerError("MISSING_CONFIGURATION", "缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const qs = `start_timestamp=${window.start}&end_timestamp=${window.end}`;
  const r = await request(`${base}/api/data/flow?${qs}`, { headers, timeoutMs: 20000 });
  if (r.status === 404) throw providerError("UPSTREAM_FEATURE_UNSUPPORTED", "该 new-api 版本没有 /api/data/flow（分组与渠道口径需要较新版本）");
  if (r.status >= 300) throw httpError(r);
  if (r.body?.success === false) {
    const tokenError = accessTokenError(r);
    if (tokenError) throw tokenError;
    const msg = String(r.body?.message || "");
    const denied = /privileg|unauthorized/i.test(msg);
    throw providerError(denied ? "UPSTREAM_AUTH_DENIED" : null, denied
      ? "该令牌没有管理员权限：分组/渠道口径需要管理员（root）令牌"
      : msg || "查询失败");
  }
  const rows = Array.isArray(r.body?.data) ? r.body.data : [];
  return rows.map((row) => ({
    user: String(row.username || ""),
    group: String(row.use_group || ""),
    model: String(row.model_name || "unknown"),
    channelId: num(row.channel_id),
    channelName: String(row.channel_name || ""),
    tokenName: String(row.token_name || ""),
    tokens: num(row.token_used),
    ...(includeQuotaUnits ? { quotaUnits: num(row.quota) } : {}),
    cost: num(row.quota) / QUOTA_PER_UNIT,
    requests: num(row.count),
  }));
}

function newApiStationAuth(station) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw providerError("MISSING_CONFIGURATION", "缺少站点地址或访问令牌");
  const headers = { Authorization: /^Bearer\s+/i.test(token) ? token : `Bearer ${token}` };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;
  return { base, headers };
}

async function newApiReconciliationAuth(station, knownUserId = null) {
  const { base, headers } = newApiStationAuth(station);
  if (headers["New-Api-User"]) return { base, headers };
  // 调用方已用这把 PAT 解析过身份（对账元数据）时直接复用，不再逐次探测；身份与 PAT 不符时上游会拒绝请求。
  const userId = String(knownUserId || "").trim();
  if (userId) {
    headers["New-Api-User"] = userId;
    return { base, headers };
  }
  const probeHeaders = { Authorization: headers.Authorization };
  const self = await request(`${base}/api/user/self`, { headers: probeHeaders, timeoutMs: 15000 });
  if (self.status >= 300 || self.body?.success === false) {
    throw newApiResponseError(self, "读取上游 PAT 身份失败");
  }
  const derivedUserId = Number(self.body?.data?.id ?? self.body?.id);
  if (!Number.isFinite(derivedUserId) || derivedUserId <= 0) {
    const err = new Error("上游 PAT 身份响应格式不正确");
    err.code = "UPSTREAM_AUTH_DENIED";
    throw err;
  }
  headers["New-Api-User"] ||= String(derivedUserId);
  return { base, headers };
}

function newApiResponseError(result, fallback) {
  const tokenError = accessTokenError(result);
  if (tokenError) return tokenError;
  const status = Number(result?.status) || 0;
  const raw = String(result?.body?.message || result?.body?.error?.message || result?.body?.error || "");
  const denied = status === 401 || status === 403 || /(privileg|permission|unauthorized|forbidden|denied|未授权|无权|权限)/i.test(raw);
  const err = new Error(denied ? "上游 PAT 无权读取对账数据" : `${fallback}${status ? `（HTTP ${status}）` : ""}`);
  err.code = denied ? "UPSTREAM_AUTH_DENIED" : "UPSTREAM_REQUEST_FAILED";
  return err;
}

function newApiQuotaPerUnit(body) {
  const raw = body?.data?.quota_per_unit ?? body?.quota_per_unit;
  const value = (typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "")) ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw providerError("UPSTREAM_RESPONSE_INVALID", "上游未返回有效的 quota_per_unit");
  }
  return value;
}

async function newApiStatus(base) {
  const r = await request(`${base}/api/status`, { timeoutMs: 12000 });
  if (r.status >= 300 || r.body?.success === false) throw newApiResponseError(r, "读取上游站点状态失败");
  return {
    quotaPerUnit: newApiQuotaPerUnit(r.body),
    version: String(r.body?.data?.version || r.body?.version || ""),
  };
}

// 复用已读到的 /api/status 时仍按真实响应的规则校验：quota_per_unit 缺失或无效就报错，绝不回退默认值。
function reusedNewApiStatus(status) {
  return {
    quotaPerUnit: newApiQuotaPerUnit({ quota_per_unit: status?.quotaPerUnit }),
    version: String(status?.version || ""),
  };
}

/** 读取 NewAPI 站点的 /api/status（quota_per_unit 与版本），供一轮对账内的多个分段共用。 */
export async function queryNewApiStatus(station) {
  return newApiStatus(newApiStationAuth(station).base);
}

/**
 * 对账用的上游账户目录：仅使用既有 PAT，返回的 Key 始终是掩码后的元数据。
 * group ratio 为当前观察值，不能用于重算历史消费。
 */
export async function queryNewApiReconciliationMetadata(station, { timezone, status: knownStatus = null } = {}) {
  const zone = reconciliationTimezone(timezone);
  const { base, headers } = await newApiReconciliationAuth({ ...station });
  const [status, groupsResult] = await Promise.all([
    knownStatus ? reusedNewApiStatus(knownStatus) : newApiStatus(base),
    request(`${base}/api/user/self/groups`, { headers, timeoutMs: 15000 })
      .then((value) => ({ value }), (error) => ({ error })),
  ]);
  const groups = {};
  let groupError = null;
  const rawGroups = groupsResult.value?.body?.data;
  if (groupsResult.error || groupsResult.value.status >= 300 || groupsResult.value.body?.success === false) {
    groupError = "读不到上游分组目录";
  } else if (!rawGroups || typeof rawGroups !== "object" || Array.isArray(rawGroups)) {
    groupError = "上游分组目录格式不对";
  } else {
    for (const [name, value] of Object.entries(rawGroups)) {
      const rawRatio = value && typeof value === "object" ? value.ratio : value;
      const ratio = (typeof rawRatio === "number" || (typeof rawRatio === "string" && rawRatio.trim() !== "")) ? Number(rawRatio) : NaN;
      groups[String(name)] = {
        ratio: Number.isFinite(ratio) ? ratio : null,
        description: String(value && typeof value === "object" ? value.desc || "" : ""),
      };
    }
  }

  const tokens = [];
  const seen = new Set();
  const maxPages = 100;
  // 与本站渠道目录同一套页码规则：老版 data[] 的 p 从 0 开始；新版 data.items[] 的 p 从 1 开始，且把 p<1 当成第 1 页。
  // 先请求 p=0 识别格式并锁定：老版接着请求 1、2…，新版跳过与 p=0 重复的 p=1，从 2 开始。
  // 从 p=1 读起会让老版漏掉第一页，Key 不足一页时整张列表读成空的。
  let format = null;
  // 同名 Key 检查要看到完整列表：翻页期间有人删 Key，后面的 Key 整体前移，下一页开头那把会被漏掉，而新的 total 恰好对得上。
  // 新版每页都带 total，前后不一致就说明列表变了，报错重试；老版没有 total，只能靠空页和重复检测兜底。
  let listTotal = null;
  let hasTotal = null;
  for (let page = 0; page < maxPages; page++) {
    const p = format === "items" ? page + 1 : page;
    const r = await request(`${base}/api/token/?p=${p}&page_size=100`, { headers, timeoutMs: 20000 });
    if (r.status >= 300 || r.body?.success === false) throw newApiResponseError(r, "读取上游 Key 列表失败");
    const pageFormat = Array.isArray(r.body?.data) ? "array"
      : Array.isArray(r.body?.data?.items) ? "items" : null;
    if (!pageFormat) throw providerError("UPSTREAM_RESPONSE_INVALID", "上游 Key 列表格式异常，请检查 NewAPI 接口");
    if (format && pageFormat !== format) throw providerError("UPSTREAM_RESPONSE_INVALID", "上游 Key 列表分页格式中途变化，请重试");
    format = pageFormat;
    const items = format === "array" ? r.body.data : r.body.data.items;
    const totalValue = r.body?.data?.total;
    const total = totalValue == null ? null : Number(totalValue);
    if (total != null && (typeof totalValue !== "number" && typeof totalValue !== "string" ||
        String(totalValue).trim() === "" || !Number.isSafeInteger(total) || total < 0)) {
      throw providerError("UPSTREAM_RESPONSE_INVALID", "上游 Key 列表总量格式异常，请重试");
    }
    if (hasTotal != null && hasTotal !== (total != null)) throw providerError("UPSTREAM_RESPONSE_INVALID", "上游 Key 列表总量格式中途变化，请重试");
    hasTotal = total != null;
    if (total != null) {
      if (listTotal != null && total !== listTotal) throw providerError("UPSTREAM_LIST_CHANGED", "上游 Key 列表在翻页期间发生变化，请重试");
      listTotal = total;
    }
    if (!items.length) {
      if (total != null && Number.isFinite(total) && seen.size < total) throw providerError("UPSTREAM_LIST_CHANGED", "上游 Key 列表分页不完整，请重试");
      break;
    }
    const before = seen.size;
    for (const item of items) {
      const id = stableProviderId(item?.id);
      if (id == null) throw providerError("UPSTREAM_RESPONSE_INVALID", "上游 Key 列表条目格式异常，请重试");
      // 和 Sub2API 一样核对每把 Key 的归属：沿用身份时不再现读账号，有的分支不校验 New-Api-User，
      // Key id 刚好撞上时会把别人的用量记进账本
      // 不带 user_id 的分支认不出归属，不会自己好：报「对方的版本不支持」（要人处理），不说「会自动再读」
      if (item?.user_id == null) throw providerError("UPSTREAM_FEATURE_UNSUPPORTED", "上游 Key 目录不带 user_id，认不出 Key 属于哪个账号");
      if (String(item.user_id) !== String(headers["New-Api-User"])) throw providerError("UPSTREAM_KEY_CATALOGUE_INVALID", "上游 Key 目录里有不属于这个账号的 Key");
      if (seen.has(id)) throw providerError("UPSTREAM_LIST_CHANGED", "上游 Key 列表分页重复，请重试");
      seen.add(id);
      tokens.push({
        id,
        name: String(item?.name || "未命名 Key"),
        status: Number(item?.status) || 0,
        group: String(item?.group || ""),
        crossGroupRetry: item?.cross_group_retry === true || item?.cross_group_retry === 1,
        maskedKey: String(item?.key || ""),
      });
    }
    if (seen.size === before) throw providerError("UPSTREAM_LIST_CHANGED", "上游 Key 列表分页重复，请重试");
    if (total != null && seen.size > total) throw providerError("UPSTREAM_LIST_CHANGED", "上游 Key 列表数量超过总量，请重试");
    if (total != null && seen.size === total) break;
    if (page === maxPages - 1) throw providerError("UPSTREAM_LIST_TOO_LARGE", "上游 Key 列表超过可读取上限");
  }
  return { ...status, userId: headers["New-Api-User"], groups, groupsAvailable: !groupError, groupError, tokens,
    billingTimezone: billingTimezone(zone) };
}

const REVEAL_BATCH_MAX = 100;
// 一次调用最多发几批：上游对这个接口限流很严（20 分钟 20 次），一轮识别（至少隔 4 分钟）一个上游最多 3 批，
// 5 轮才 15 次，守得住；超过的 id 这一轮不取（不在返回里），调用方按「没读全、下一轮再试」处理，不能当成「没有这把」
export const REVEAL_MAX_BATCHES = 3;

/**
 * 渠道 Key 读取服务认出的打码对上不止一把候选时，取这几把的完整 Key 再精确分（K2a，k-plan §2.2）。
 * POST /api/token/batch/keys，一次最多 100 个 id，超过 100 个按 100 一批分批发（最多 REVEAL_MAX_BATCHES 批）；
 * 没有 api_key:reveal 权限时上游报 ACCESS_TOKEN_SCOPE_DENIED（和别的权限检查同一条路，
 * httpError/accessTokenError 已经认得这个码），被限流（CriticalRateLimit）归成普通的 UPSTREAM_REQUEST_FAILED。
 * 返回 { [tokenId]: 完整Key }：调用方算完指纹要立刻扔掉，不缓存、不写日志、不进库（k-plan §11.3）。
 * 没发出去的（超过批数上限）和上游没给的 id 都不在返回里——调用方要把「返回里没有」当成没读全，不是「没有这把」（审核 #131 低项）。
 */
export async function queryRevealedTokenKeys(station, tokenIds) {
  const ids = [...new Set((tokenIds || []).map(Number))].filter(Number.isFinite);
  if (!ids.length) return {};
  const { base, headers } = await newApiReconciliationAuth({ ...station });
  const result = {};
  for (let start = 0, sent = 0; start < ids.length && sent < REVEAL_MAX_BATCHES; start += REVEAL_BATCH_MAX, sent += 1) {
    const batch = ids.slice(start, start + REVEAL_BATCH_MAX);
    const r = await request(`${base}/api/token/batch/keys`, { method: "POST", headers, json: { ids: batch }, timeoutMs: 15000 });
    if (r.status >= 300 || r.body?.success === false) throw newApiResponseError(r, "读取完整 Key 失败");
    const keys = r.body?.data?.keys;
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw providerError("UPSTREAM_RESPONSE_INVALID", "读取完整 Key 的响应格式不对");
    Object.assign(result, keys);
  }
  return result;
}

/**
 * 按固定 Key 名称读取上游窗口统计。调用方必须先用 token ID 元数据确认 Key
 * 仍是创建规则时的那一把，避免同名 Key 被替换后混入聚合结果。不要以分组过滤：
 * Key 切组后旧组日志不能可靠地用当前目录回查；分段的半开时间窗本身负责隔离成本。
 * userId / status 可传入对账元数据已读到的 PAT 身份和 /api/status，避免每个分段重复探测。
 */
export async function queryNewApiTokenStat(station, { tokenName, startMs, endMs, userId = null, status: knownStatus = null }) {
  const name = String(tokenName || "").trim();
  if (!name) throw new Error("上游 Key 名称无效");
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) {
    return {
      quotaUnits: 0,
      quotaPerUnit: null,
      emptySecondWindow: true,
      actualGroups: [],
      tokenIds: [],
      latestLogAtMs: null,
    };
  }
  const { base, headers } = await newApiReconciliationAuth(station, userId);
  const qs = new URLSearchParams({
    // 两侧都只核算消费日志；部分 NewAPI 分支会把 type=0 解释为全部日志。
    type: "2",
    token_name: name,
    start_timestamp: String(window.start),
    end_timestamp: String(window.end),
  });
  const [status, stat] = await Promise.all([
    knownStatus ? reusedNewApiStatus(knownStatus) : newApiStatus(base),
    request(`${base}/api/log/self/stat?${qs}`, { headers, timeoutMs: 25000 }),
  ]);
  if (stat.status === 404) {
    const err = new Error("上游不支持日志统计接口");
    err.code = "UPSTREAM_STAT_UNAVAILABLE";
    throw err;
  }
  if (stat.status >= 300 || stat.body?.success === false) throw newApiResponseError(stat, "读取上游日志统计失败");
  const rawQuota = stat.body?.data?.quota;
  const quotaUnits = (typeof rawQuota === "number" || (typeof rawQuota === "string" && rawQuota.trim() !== "")) ? Number(rawQuota) : NaN;
  if (!Number.isFinite(quotaUnits) || quotaUnits < 0) {
    const err = new Error("上游日志统计未返回有效 quota");
    err.code = "UPSTREAM_STAT_UNAVAILABLE";
    throw err;
  }
  return {
    ...status,
    quotaUnits,
    emptySecondWindow: false,
    // The stat endpoint does not expose individual log identity. Reconciliation
    // validates Key ID/name/group/status from metadata before invoking it.
    actualGroups: [],
    tokenIds: [],
    latestLogAtMs: null,
  };
}

// New API 一页最深翻到的位置：总数不超过它时直接取最后一页（最早的一条），超过就先按时间缩小范围（K 设计稿第五节）
const FIRST_USAGE_MAX_DEEP_PAGE = 10000;
const FIRST_USAGE_MAX_REQUESTS = 24;

/**
 * 一把 Key 在 [startMs, endMs] 里第一条消费日志的时刻（毫秒；一条都没有返回 null）。
 * 换 Key 时只用来写「几点换的」，不改钱：钱按 [a, b) 两把 Key 相加算，和这个时刻无关。
 * GET /api/log/self?type=2&token_name=…&page_size=1，日志按 id 倒序、带总数：
 * 总数不超过 FIRST_USAGE_MAX_DEEP_PAGE 时翻到最后一页就是最早的一条（2 次请求）；超过就按时间二分，找到「到哪一秒为止有日志」再取。
 * 读失败（含 429）直接抛，调用方当「定不出」。
 */
export async function queryNewApiKeyFirstUsage(station, { tokenName, startMs, endMs, userId = null }) {
  const name = String(tokenName || "").trim();
  if (!name) throw new Error("上游 Key 名称无效");
  const start = Math.ceil(startMs / 1000), end = Math.floor(endMs / 1000);
  if (!(start <= end)) return null;
  const { base, headers } = await newApiReconciliationAuth(station, userId);
  let requests = 0;
  const page = async (hi, p) => {
    if (++requests > FIRST_USAGE_MAX_REQUESTS) throw providerError("UPSTREAM_REQUEST_FAILED", "找第一条用量的请求次数超限");
    const qs = new URLSearchParams({ p: String(p), page_size: "1", type: "2", token_name: name, start_timestamp: String(start), end_timestamp: String(hi) });
    const r = await request(`${base}/api/log/self?${qs}`, { headers, timeoutMs: 25000 });
    if (r.status === 429) throw providerError("UPSTREAM_REQUEST_FAILED", "上游限流（429）");
    if (r.status >= 300 || r.body?.success === false) throw newApiResponseError(r, "读取上游消费日志失败");
    const data = r.body?.data;
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null;
    const rawTotal = Array.isArray(data) ? null : data?.total;
    const total = Number(rawTotal);
    if (!items || rawTotal == null || rawTotal === "" || !Number.isSafeInteger(total) || total < 0) throw providerError("UPSTREAM_RESPONSE_INVALID", "上游消费日志格式异常");
    return { items, total };
  };
  let upper = end;
  let { total } = await page(upper, 1);
  if (total === 0) return null;
  // 第一条用量一定在 [lo, upper] 里；count(start..upper) = total > 0
  for (let lo = start; total > FIRST_USAGE_MAX_DEEP_PAGE && lo < upper;) {
    const mid = Math.floor((lo + upper) / 2);
    const { total: inHalf } = await page(mid, 1);
    if (inHalf > 0) { upper = mid; total = inHalf; } else lo = mid + 1;
  }
  const { items } = await page(upper, Math.min(total, FIRST_USAGE_MAX_DEEP_PAGE));
  const createdAt = Number(items[0]?.created_at);
  if (!Number.isFinite(createdAt) || createdAt < start || createdAt > end) return null;
  return createdAt * 1000;
}

function stableProviderId(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Sub2API 账单过滤能力的核验结果。调用方提供 capabilityStore（持久化，重启后仍有效）时以它为准；
// 未提供时只用进程内缓存。能力 7 天后在下一次可写的取数中重新核验。
const sub2BillingCapabilities = new Map();
const SUB2_CAPABILITY_REVERIFY_MS = 7 * 24 * 60 * 60 * 1000;
// 实时窗口 [00:00, now) 的结束点允许落后当前时刻的最大值；更早结束的非自然日区间上游无法按日过滤。
const SUB2_LIVE_END_SKEW_MS = 5 * 60 * 1000;
// 核验没通过（上游不支持过滤）1 小时内、核验请求出错 10 分钟内不再重发对照请求，免得每轮轮询都打上游。
const SUB2_VERIFY_REJECTED_BACKOFF_MS = 60 * 60 * 1000;
const SUB2_VERIFY_FAILED_BACKOFF_MS = 10 * 60 * 1000;
const sub2VerifyBackoff = new Map();
const sub2VerifyInflight = new Map();
// 存储删除失败时进程内记下作废：不能让存储里残留的旧能力继续把参考扣费算成完整账单，下次观测时重试删除。
const sub2RevokedCapabilities = new Set();
// 每个身份发出过几次保存：删除没成时，期间这个身份又存过新结果（核验通过推翻了作废），就不再记作废。
// 表满了把身份挤掉时查不到，按期间没存过算，照样记作废
const sub2CapabilitySaves = new Map();
const CAPABILITY_STORE_WARN_INTERVAL_MS = 10 * 60 * 1000;
const capabilityStoreWarnings = new Map();

function storedSub2Capability(value) {
  return value?.state === "supported" && Number.isFinite(value.verifiedAt)
    ? Object.freeze({ state: "supported", currency: "USD", window: "natural-day", verifiedAt: value.verifiedAt,
      reason: "RUNTIME_FILTERS_VERIFIED" })
    : null;
}

function boundedPut(collection, key, value) {
  collection.delete(key);
  if (collection.size >= 100) collection.delete(collection.keys().next().value);
  if (collection instanceof Set) collection.add(key);
  else collection.set(key, value);
}

// 存储出错时照常降级为未核验，但要留下痕迹，否则能力永远核验不上也无从排查；同类错误 10 分钟只记一次。
function warnCapabilityStore(operation, error) {
  const now = Date.now();
  if (now - (capabilityStoreWarnings.get(operation) || 0) < CAPABILITY_STORE_WARN_INTERVAL_MS) return;
  capabilityStoreWarnings.set(operation, now);
  console.warn(`  Sub2API 账单能力存储${operation}失败，按未核验处理:`, error?.code || error?.message || error);
}

// 存储读写失败只会让能力退回未核验，不影响已读金额。
function sub2CapabilityCache(store) {
  if (!store) {
    return {
      get: async (identity) => sub2BillingCapabilities.get(identity) || null,
      revokePending: () => false,
      set: async (identity, capability) => { boundedPut(sub2BillingCapabilities, identity, capability); },
      delete: async (identity) => { sub2BillingCapabilities.delete(identity); },
    };
  }
  return {
    async get(identity) {
      if (sub2RevokedCapabilities.has(identity)) return null;
      try { return storedSub2Capability(await store.get(identity)); }
      catch (error) { warnCapabilityStore("读取", error); return null; }
    },
    revokePending: (identity) => sub2RevokedCapabilities.has(identity),
    // 这次核验通过，推翻了之前的作废：发出保存前就清掉作废标记，保存没成也不放回（库里留着的旧结果和这次结论一致，
    // 只是核验时间早一些）。同一身份并发的观测不会再去补删这次要存的新结果
    async set(identity, capability) {
      sub2RevokedCapabilities.delete(identity);
      boundedPut(sub2CapabilitySaves, identity, (sub2CapabilitySaves.get(identity) || 0) + 1);
      try { await store.set(identity, capability); }
      catch (error) { warnCapabilityStore("保存", error); }
    },
    async delete(identity) {
      const saves = sub2CapabilitySaves.get(identity);
      try { await store.delete(identity); sub2RevokedCapabilities.delete(identity); }
      catch (error) {
        const now = sub2CapabilitySaves.get(identity);
        if (now === undefined || now === saves) boundedPut(sub2RevokedCapabilities, identity);
        warnCapabilityStore("删除", error);
      }
    },
  };
}

// 同一身份同时只发一组对照请求；结果按身份退避，凭据或时区变了就是新身份，不受旧退避影响。
async function verifySub2BillingOnce(identity, connection, metadata, params, observedAt) {
  if (sub2VerifyInflight.has(identity)) return sub2VerifyInflight.get(identity);
  const pending = (async () => {
    try {
      const verified = await verifySub2Billing(connection, metadata, params);
      if (verified) sub2VerifyBackoff.delete(identity);
      else boundedPut(sub2VerifyBackoff, identity, observedAt + SUB2_VERIFY_REJECTED_BACKOFF_MS);
      return verified;
    } catch (error) {
      boundedPut(sub2VerifyBackoff, identity, observedAt + SUB2_VERIFY_FAILED_BACKOFF_MS);
      throw error;
    }
  })();
  sub2VerifyInflight.set(identity, pending);
  try { return await pending; } finally { if (sub2VerifyInflight.get(identity) === pending) sub2VerifyInflight.delete(identity); }
}

function reconciliationTimezone(timezone) {
  try { return canonicalTimeZone(timezone); }
  catch { throw providerError("UPSTREAM_WINDOW_UNSUPPORTED", "账单时区无效，请重新确认"); }
}

// New API 按秒取数；Sub2API 的 date/timezone 过滤按业务时区（默认 Asia/Shanghai）解释，两者都视为已核验。
function billingTimezone(timezone) {
  return { state: "verified", timezone };
}

// 账单能力的连接身份：上游地址、账号、时区、登录信息的 sha256，只在进程内用。存进库时由能力存储
//（lib/billing-capability-storage.js）再用账单身份密钥包一层 HMAC，拿到库也撞不出密码；这里不管存储怎么存
function sub2BillingIdentity(station, accountId, timezone) {
  const passwordMode = station.type === "sub2api-password" || station.authMode === "password";
  return createHash("sha256").update(JSON.stringify([
    trimBase(station.baseUrl), accountId, timezone,
    passwordMode ? "password" : "token",
    passwordMode ? station.email : station.accessToken || station.apiKey,
    passwordMode ? station.password : null,
  ])).digest("hex");
}

function sub2ActualCost(data) {
  const raw = data?.total_actual_cost;
  const value = typeof raw === "number" || typeof raw === "string" && /^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function verifySub2Billing(connection, metadata, params) {
  // 完整目录证明候选 ID 不属于已读集合，再单独确认不存在；不使用真实其他账号的 Key。
  const missingId = Number.MAX_SAFE_INTEGER;
  if (metadata.tokens.some((item) => item.id === missingId)) return null;
  const missing = await sub2ReconciliationGet(connection, `/api/v1/keys/${missingId}`);
  if (!missing.unsupported) return null;
  const missingParams = new URLSearchParams(params);
  missingParams.set("api_key_id", String(missingId));
  const keyControl = await sub2ReconciliationGet(connection, `/api/v1/usage/stats?${missingParams}`);
  if (!keyControl.unsupported && sub2ActualCost(keyControl.data) !== 0) return null;
  // 用未来完整日检查旧部署是否忽略 date；正向必须非零，因此整账号/全时间总量不能混过。
  const future = new Date(`${dayKeyInTz(Date.now(), params.get("timezone"))}T00:00:00Z`);
  future.setUTCDate(future.getUTCDate() + 2);
  const futureDate = future.toISOString().slice(0, 10);
  const futureParams = new URLSearchParams(params);
  futureParams.set("start_date", futureDate);
  futureParams.set("end_date", futureDate);
  const dateControl = await sub2ReconciliationGet(connection, `/api/v1/usage/stats?${futureParams}`);
  if (dateControl.unsupported || sub2ActualCost(dateControl.data) !== 0) return null;
  return storedSub2Capability({ state: "supported", verifiedAt: Date.now() });
}

// 查账用临时连接，不轮换或修改监控资源持有的 s2Tokens。
function sub2ReconciliationConnection(station) {
  return {
    type: station.type, authMode: station.authMode, authVersion: station.authVersion, baseUrl: trimBase(station.baseUrl),
    accessToken: station.accessToken, apiKey: station.apiKey,
    email: station.email, password: station.password, s2Tokens: {},
  };
}

async function sub2ReconciliationGet(station, path) {
  if (!station.baseUrl) throw providerError("MISSING_CONFIGURATION", "缺少上游站点地址");
  let result;
  try {
    let bearer = await sub2apiBearer(station, station.baseUrl);
    result = await request(`${station.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${bearer}` }, timeoutMs: 25000,
    });
    if (result.status === 401 && (station.type === "sub2api-password" || station.authMode === "password")) {
      bearer = await sub2apiBearer(station, station.baseUrl, true);
      result = await request(`${station.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${bearer}` }, timeoutMs: 25000,
      });
    }
  } catch {
    // 登录接口和反向代理错误可能回显凭证，不能透传到公开接入结果。
    throw providerError("UPSTREAM_REQUEST_FAILED", "上游对账连接验证失败，请检查授权或稍后重试");
  }
  if (result.status === 401 || result.status === 403) {
    throw providerError("UPSTREAM_AUTH_DENIED", "上游账号无权读取对账数据");
  }
  if (result.status === 404) return { unsupported: true };
  if (result.status >= 300 || result.body?.code !== 0 || !result.body?.data || typeof result.body.data !== "object") {
    throw providerError("UPSTREAM_REQUEST_FAILED", "上游对账接口请求失败");
  }
  return { data: result.body.data };
}

async function sub2ReconciliationAccount(station) {
  const result = await sub2ReconciliationGet(station, "/api/v1/auth/me");
  const id = stableProviderId(result.data?.id);
  if (result.unsupported || id == null) {
    throw providerError("UPSTREAM_IDENTITY_UNAVAILABLE", "上游未提供可验证的稳定账号身份");
  }
  return String(id);
}

// 身份核验独立于 Key/账单权限；密码登录只修改临时连接。
export async function queryAccountIdentity(station) {
  const baseUrl = onboardingBaseUrl(station.baseUrl);
  if (!baseUrl) throw providerError("UPSTREAM_IDENTITY_UNAVAILABLE", "缺少有效的上游面板地址");
  if (station.type === "newapi") {
    const { headers } = newApiStationAuth(station);
    const self = await request(`${baseUrl}/api/user/self`, { headers, timeoutMs: 15000 });
    if (self.status >= 300 || self.body?.success === false) throw newApiResponseError(self, "读取上游账号身份失败");
    const id = stableProviderId(self.body?.data?.id ?? self.body?.id);
    if (id == null) throw providerError("UPSTREAM_IDENTITY_UNAVAILABLE", "上游未提供可验证的稳定账号身份");
    if (station.userId && String(station.userId).trim() !== String(id)) {
      throw providerError("UPSTREAM_IDENTITY_CHANGED", "上游授权与配置的账号身份不一致");
    }
    return { provider: "newapi", baseUrl, accountId: String(id) };
  }
  if (station.type === "sub2api" || station.type === "sub2api-password") {
    const connection = sub2ReconciliationConnection({ ...station, baseUrl });
    return { provider: "sub2api", baseUrl, accountId: await sub2ReconciliationAccount(connection) };
  }
  throw providerError("UPSTREAM_IDENTITY_UNAVAILABLE", "该监控类型不提供账号身份核验");
}

/** 同一账单入口的最小 Key 目录；New API 旧接口保持原有消费者兼容。 */
// known：调用方不久前读到的账号身份和 /api/status（{ accountId, status }），给了就不再读这两样，只读分组和 Key 目录。
// 多久重读一次由调用方定（server/reconciliation.js 的 metadataFor）。
export async function queryReconciliationMetadata(station, { timezone, capabilityStore = null, known = null } = {}) {
  const zone = reconciliationTimezone(timezone);
  station = { ...station };
  if (station.type === "newapi") {
    const { base, headers } = newApiStationAuth(station);
    let id = known?.accountId != null ? String(known.accountId) : null;
    if (id == null) {
      const self = await request(`${base}/api/user/self`, { headers, timeoutMs: 15000 });
      if (self.status >= 300 || self.body?.success === false) throw newApiResponseError(self, "读取上游账号身份失败");
      id = stableProviderId(self.body?.data?.id ?? self.body?.id);
    }
    if (id == null) {
      throw providerError("UPSTREAM_IDENTITY_UNAVAILABLE", "上游未提供可验证的稳定账号身份");
    }
    if (station.userId && String(station.userId) !== String(id)) {
      throw providerError("UPSTREAM_IDENTITY_CHANGED", "上游授权与配置的账号身份不一致");
    }
    const metadata = await queryNewApiReconciliationMetadata({ ...station, userId: String(id) }, { timezone: zone, status: known?.status || null });
    return { ...metadata, tokens: metadata.tokens.map((item) => ({ ...item, maskedKey: "" })),
      platform: "newapi", accountId: String(id), baseUrl: base,
      capability: { state: "supported", currency: "USD", window: "second" } };
  }
  if (station.type !== "sub2api" && station.type !== "sub2api-password") {
    throw providerError("UPSTREAM_STAT_UNAVAILABLE", "该监控类型不提供账号账单授权");
  }
  const connection = sub2ReconciliationConnection(station);
  const accountId = known?.accountId != null ? String(known.accountId) : await sub2ReconciliationAccount(connection);
  const tokens = [];
  const seen = new Set();
  let total = null;
  let unsupported = false;
  for (let page = 1; page <= 100; page++) {
    const params = new URLSearchParams({ page: String(page), page_size: "100", sort_by: "id", sort_order: "asc" });
    const result = await sub2ReconciliationGet(connection, `/api/v1/keys?${params}`);
    if (result.unsupported) {
      if (page > 1) throw providerError("UPSTREAM_KEY_CATALOGUE_INVALID", "上游 Key 目录读取中断");
      unsupported = true;
      break;
    }
    const data = result.data;
    const count = Number(data.total);
    if (!Array.isArray(data.items) || !Number.isSafeInteger(count) || count < 0 ||
        data.total == null || typeof data.total === "boolean" || String(data.total).trim() === "" ||
        total != null && count !== total) {
      throw providerError("UPSTREAM_KEY_CATALOGUE_INVALID", "上游 Key 目录格式异常或在翻页期间发生变化");
    }
    total = count;
    for (const item of data.items) {
      const id = stableProviderId(item?.id);
      const groupId = item?.group_id == null ? null : stableProviderId(item.group_id);
      if (id == null || String(item?.user_id) !== accountId || seen.has(id) || item?.group_id != null && groupId == null) {
        throw providerError("UPSTREAM_KEY_CATALOGUE_INVALID", "上游 Key 目录重复或账号归属无法确认");
      }
      seen.add(id);
      tokens.push({ id, name: String(item.name || "未命名 Key"), status: item.status === "active" ? 1 : 2,
        group: item.group_id == null ? "" : String(item.group_id), crossGroupRetry: false,
        maskedKey: "", platform: "sub2api" });
    }
    if (tokens.length > total || !data.items.length && tokens.length !== total) {
      throw providerError("UPSTREAM_KEY_CATALOGUE_INVALID", "上游 Key 目录分页不完整");
    }
    if (tokens.length === total) break;
    if (page === 100) throw providerError("UPSTREAM_LIST_TOO_LARGE", "上游 Key 目录超过安全读取上限");
  }
  // 刚读过身份时（known）不再核对第二次；身份多久重读一次由调用方定
  if (known?.accountId == null && await sub2ReconciliationAccount(connection) !== accountId) {
    throw providerError("UPSTREAM_IDENTITY_CHANGED", "上游账号身份在读取目录期间发生变化");
  }
  const capability = !unsupported && await sub2CapabilityCache(capabilityStore).get(sub2BillingIdentity(connection, accountId, zone));
  return { platform: "sub2api", accountId, userId: accountId, baseUrl: connection.baseUrl,
    tokens, groups: {}, groupsAvailable: true, groupError: null, quotaPerUnit: null, version: "",
    billingTimezone: billingTimezone(zone),
    capability: capability ||
      { state: unsupported ? "unsupported" : "unverified", currency: "USD", window: "natural-day",
      reason: unsupported ? "KEY_ENDPOINT_UNSUPPORTED" : "DEPLOYMENT_NOT_VERIFIED",
      message: unsupported ? "上游未开放 Key 目录接口" : "实际部署的 Key 和日期过滤尚未验证" } };
}

/**
 * 明确 Key 与真实窗口；Sub2API 未核验过滤时只提供参考扣费。
 * readOnly（页面只读查询）只读取已有能力，不发起能力核验、也不改写能力缓存或存储。
 */
// 已删的 Sub2API Key 这一天的用量：账号总量（不带 api_key_id）减去这个账号当天别的 Key 的量。
// 请求数：1 次总量 + 目录里别的每把 Key 各 1 次；只在这一天要结的段里有已删的 Key 时才走，平时不走。不翻明细（忙的账号一天几万条）。
// 能力（按 Key 读账单）按上游账号记，不是这把 Key 的东西：没核验过就只当参考，不在这里核验、不写能力
async function querySub2DeletedKeyStat(station, { token, metadata, startDate, endDate, zone, window, observedAt, capabilityStore }) {
  const expectedAccountId = String(metadata.accountId);
  const connection = sub2ReconciliationConnection(station);
  const accountId = await sub2ReconciliationAccount(connection);
  if (accountId !== expectedAccountId) throw providerError("UPSTREAM_IDENTITY_CHANGED", "上游账号身份与对账关联不一致");
  const base = { start_date: startDate, end_date: endDate, timezone: zone };
  const total = sub2ActualCost((await sub2ReconciliationGet(connection, `/api/v1/usage/stats?${new URLSearchParams(base)}`)).data);
  const others = (metadata.tokens || []).filter((item) => item.id !== Number(token.id));
  const otherCosts = await Promise.all(others.map(async (item) => sub2ActualCost((await sub2ReconciliationGet(connection,
    `/api/v1/usage/stats?${new URLSearchParams({ ...base, api_key_id: String(item.id) })}`)).data)));
  if (await sub2ReconciliationAccount(connection) !== accountId) throw providerError("UPSTREAM_IDENTITY_CHANGED", "上游账号身份在读取账单期间发生变化");
  const capability = await sub2CapabilityCache(capabilityStore).get(sub2BillingIdentity(connection, accountId, zone));
  const valid = total != null && otherCosts.every((cost) => cost != null);
  const otherTotal = otherCosts.reduce((sum, value) => sum + value, 0);
  // 别的 Key 加起来比总量还大（读的先后之间又有新用量）：这一天的数不可信，当读不到——
  // 不止 amountUsd，knownAmountUsd/actualCostUsd 也不能是 Math.max(0, …) 夹出来的 0（否则 sumKeyStats 会把它当真的 0 吸收进合计）
  const subtractionReliable = valid && total - otherTotal >= -1e-9;
  const cost = subtractionReliable ? Math.max(0, total - otherTotal) : null;
  const complete = subtractionReliable && capability?.state === "supported";
  return { platform: "sub2api", state: complete ? "complete" : valid ? "partial" : "unavailable", complete,
    amountUsd: complete ? cost : null, knownAmountUsd: cost, actualCostUsd: cost, deletedKey: true,
    quotaUnits: null, quotaPerUnit: null, window, observedAt, currency: "USD", billingTimezone: billingTimezone(zone),
    capability: capability || { state: "unverified", reason: "DEPLOYMENT_NOT_VERIFIED", message: "已读取参考扣费，实际部署的 Key 和日期过滤尚未验证" } };
}

export async function queryKeyReconciliationStat(station, { token, metadata, startMs, endMs, timezone, tz,
  capabilityStore = null, readOnly = false }) {
  const zone = reconciliationTimezone(timezone || tz);
  const window = { startMs, endMs, timezone: zone };
  const observedAt = Date.now();
  if (station.type === "newapi") {
    const raw = await queryNewApiTokenStat(station, { tokenName: token?.name, startMs, endMs,
      userId: metadata?.userId, status: metadata });
    const complete = !raw.emptySecondWindow;
    const amountUsd = complete ? raw.quotaUnits / raw.quotaPerUnit : null;
    return { ...raw, state: complete ? "complete" : "pending", complete, amountUsd, knownAmountUsd: amountUsd,
      window, observedAt, platform: "newapi", billingTimezone: billingTimezone(zone) };
  }
  if (station.type !== "sub2api" && station.type !== "sub2api-password") {
    throw providerError("UPSTREAM_STAT_UNAVAILABLE", "该监控类型不提供账号账单授权");
  }
  // Sub2API 只能按自然日过滤：接受完整自然日，或从零点到当前时刻的实时区间（结束日的统计本身就截至当前）。
  let startDate, endDate, live;
  try {
    startDate = dayKeyInTz(startMs, zone);
    endDate = dayKeyInTz(endMs - 1, zone);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !isDayStartInTz(startMs, zone)) {
      throw new Error("not a natural-day window");
    }
    live = !isDayStartInTz(endMs, zone);
    if (live && (endMs > observedAt || observedAt - endMs > SUB2_LIVE_END_SKEW_MS)) throw new Error("stale live window");
  } catch {
    throw providerError("UPSTREAM_WINDOW_UNSUPPORTED", "Sub2API 账单仅支持完整自然日或截至当前的今日区间");
  }
  if (!live && endMs > observedAt) {
    throw providerError("UPSTREAM_WINDOW_PENDING", "Sub2API 账单自然日尚未结束");
  }
  const matchedKey = metadata?.tokens?.find((item) => item.id === Number(token?.id)), key = matchedKey && { ...matchedKey };
  // 已删的 Key（token.deleted，分段里记着、上游 Key 列表里已经没有）：按 id 查会报错，改成账号这一天的总量减去这一天别的 Key 的量（K1c，k-plan 3.5）
  if (token?.deleted === true && !key && metadata?.accountId) return querySub2DeletedKeyStat(station, { token, metadata, startDate, endDate, zone, window, observedAt, live, capabilityStore });
  if (!key || key.name !== token?.name || key.status !== 1 || !metadata?.accountId) {
    throw providerError("UPSTREAM_KEY_UNVERIFIED", "实际 Key 身份或账号尚未确认");
  }
  const expectedAccountId = String(metadata.accountId);
  const connection = sub2ReconciliationConnection(station);
  const accountId = await sub2ReconciliationAccount(connection);
  if (accountId !== expectedAccountId) {
    throw providerError("UPSTREAM_IDENTITY_CHANGED", "上游账号身份与对账关联不一致");
  }
  const params = new URLSearchParams({ api_key_id: String(key.id), start_date: startDate, end_date: endDate, timezone: zone });
  const result = await sub2ReconciliationGet(connection, `/api/v1/usage/stats?${params}`);
  const cost = sub2ActualCost(result.data);
  const identity = sub2BillingIdentity(connection, accountId, zone);
  const capabilities = sub2CapabilityCache(capabilityStore);
  let capability = await capabilities.get(identity);
  let change = null;
  if (result.unsupported || cost == null) {
    if (capability) change = "forget";
    capability = null;
  } else if (!readOnly && cost > 0 && (!capability || observedAt - capability.verifiedAt >= SUB2_CAPABILITY_REVERIFY_MS)
      && !(sub2VerifyBackoff.get(identity) > observedAt)) {
    // 核验需要正向非零金额；暂时探测失败不抹去正向已读金额，也不保存未经验证的能力，到期的旧能力继续沿用。
    try {
      const verified = await verifySub2BillingOnce(identity, connection, metadata, params, observedAt);
      change = verified ? "remember" : capability ? "forget" : null;
      capability = verified;
    } catch {
      capability ||= { state: "unverified", reason: "CAPABILITY_CHECK_FAILED", message: "暂时没确认上游能不能按 Key 读账单，可稍后重试" };
    }
  }
  if (await sub2ReconciliationAccount(connection) !== accountId) {
    if (!readOnly) await capabilities.delete(identity);
    throw providerError("UPSTREAM_IDENTITY_CHANGED", "上游账号身份在读取账单期间发生变化");
  }
  // 上次作废没删成（进程内记着）：这次不是要记下新的核验结果，就再删一次。零消费、核验没通过、退避期间也删，
  // 不然进程一重启，存储里残留的旧能力又会被当成已确认。紧挨着删除再看：等上游的时候别的观测可能已经存下新结果
  if (!readOnly && change !== "remember" && capabilities.revokePending(identity)) change = "forget";
  if (!readOnly && change === "forget") await capabilities.delete(identity);
  if (!readOnly && change === "remember") await capabilities.set(identity, capability);
  const valid = cost != null;
  const complete = valid && capability?.state === "supported";
  return { platform: "sub2api", state: complete ? "complete" : valid ? "partial" : "unavailable", complete,
    amountUsd: complete ? cost : null, knownAmountUsd: cost, actualCostUsd: cost,
    quotaUnits: null, quotaPerUnit: null, window, observedAt, currency: "USD", billingTimezone: billingTimezone(zone),
    capability: capability || { state: result.unsupported || !valid ? "unsupported" : "unverified",
      reason: result.unsupported ? "STAT_ENDPOINT_UNSUPPORTED" : valid ? "DEPLOYMENT_NOT_VERIFIED" : "ACTUAL_COST_UNAVAILABLE",
      message: result.unsupported ? "上游未开放按 Key 账单统计" : valid
        ? "已读取参考扣费，实际部署的 Key 和日期过滤尚未验证" : "上游未提供有效的实际扣费字段" } };
}

// /api/log/stat 的 quota：数字或数字字符串、有限、不小于 0；否则抛错（label 说是哪一次读的）
function statQuota(result, label) {
  if (result.status >= 300 || result.body?.success === false) {
    const tokenError = accessTokenError(result);
    if (tokenError) throw tokenError;
    throw new Error(`${label}账单统计查询失败${result.status ? `（HTTP ${result.status}）` : ""}`);
  }
  const rawQuota = result.body?.data?.quota;
  const quotaText = typeof rawQuota === "string" ? rawQuota.trim() : null;
  const numericText = quotaText != null && /^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(quotaText);
  const quotaUnits = typeof rawQuota === "number" ? rawQuota : numericText ? Number(quotaText) : null;
  if (quotaUnits == null || !Number.isFinite(quotaUnits) || quotaUnits < 0) throw new Error(`${label}账单统计未返回有效 quota`);
  return quotaUnits;
}

/**
 * 自营站点从 sinceSec 起的消费日志（type=2）：最新的那一条（编号、站点自己记的时刻，没有就是 null）和这段时间一共几条（total）。
 * 用来判断「上一次以后有没有新的消费」（计划 P1a，审核第二轮）：三样（编号、时刻、条数）在同一个起点下都没变，才算没有新的消费。
 * - 列表按「时刻倒序、再按编号倒序」排（New API model/log.go GetAllLogs），不按编号排：晚写进去、时刻更早的那条排不到第一，
 *   只能靠条数看出来。日志库是 ClickHouse 时编号是显示序号（第一条永远是 1），编号不能用，也靠时刻和条数。
 * - 这个接口每次都数一遍起点以后的条数，所以起点要收小（调用方定）。
 * - 老版本 data 直接是数组、没有条数：total 为 null，调用方就不当成没有新的消费。
 * - p=0：老版从 0 起，新版把 p<1 当成第 1 页。
 */
export async function queryOwnLatestLog(station, { sinceSec }) {
  const { base, headers } = newApiStationAuth(station);
  const qs = new URLSearchParams({ p: "0", page_size: "1", type: "2", start_timestamp: String(Math.max(0, Math.floor(sinceSec))) });
  const r = await request(`${base}/api/log/?${qs}`, { headers, timeoutMs: 20000 });
  if (r.status >= 300 || r.body?.success === false) throw newApiResponseError(r, "读取自营站点最新的消费日志失败");
  const items = Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body?.data?.items) ? r.body.data.items : null;
  if (!items) throw providerError("UPSTREAM_RESPONSE_INVALID", "自营站点消费日志格式异常");
  const first = items[0];
  const id = Number(first?.id), createdAtSec = Number(first?.created_at);
  if (first && (!Number.isSafeInteger(id) || !Number.isFinite(createdAtSec))) throw providerError("UPSTREAM_RESPONSE_INVALID", "自营站点消费日志格式异常");
  const rawTotal = Array.isArray(r.body?.data) ? null : r.body?.data?.total;
  const total = rawTotal == null || rawTotal === "" || !Number.isSafeInteger(Number(rawTotal)) || Number(rawTotal) < 0 ? null : Number(rawTotal);
  return { latest: first ? { id, createdAtSec } : null, total };
}

// 自营站点记不记收费记录（own-revenue-plan 第二节）：GET /api/option/ 只取 LogConsumeEnabled，其余设置读完就扔——不进返回值、不进日志、
// 不进报错原文。返回 { state: "on" | "off" } 或 { state: "denied", reason: "scope" | "not_root" }（令牌少了 option:read，
// 或账号不是超级管理员，这个接口要 root）；读不到（网络、5xx、版本认不出）抛错，调用方当作这一次没读到。
// 令牌作废（ACCESS_TOKEN_LEGACY_RETIRED）照样抛带码的错，不当成没权限。
export async function queryOwnConsumeLog(station) {
  const { base, headers } = newApiStationAuth(station);
  const r = await request(`${base}/api/option/`, { headers, timeoutMs: 20000 });
  const tokenError = accessTokenError(r);
  if (tokenError) {
    if (tokenError.code === ACCESS_TOKEN_SCOPE_DENIED) return { state: "denied", reason: "scope" };
    throw tokenError;
  }
  const message = String(r.body?.message || r.body?.error?.message || "");
  // 不是超级管理员：403，或者 200 加 success:false 说权限不够。401（令牌无效、过期）是登录的事，当读不到，不说成「不是超级管理员」
  if (r.status === 403 || (r.status < 300 && r.body?.success === false && /权限|privilege|forbidden|root/i.test(message))) return { state: "denied", reason: "not_root" };
  if (r.status >= 300 || r.body?.success === false) throw httpError(r, "读取自营站点设置失败");
  const items = Array.isArray(r.body?.data) ? r.body.data : null;
  const value = items?.find((item) => item?.key === "LogConsumeEnabled")?.value;
  const enabled = parseConsumeLogValue(value);
  if (enabled == null) throw providerError("UPSTREAM_RESPONSE_INVALID", "自营站点的设置里没有认得出的收费记录开关");
  return { state: enabled ? "on" : "off" };
}

// 每日利润每个渠道的收入 = 渠道的收费统计 − 这个渠道上不算收入的消费（和运营总览、自营业务同一个规矩）：
// - 管理员账号（用户列表里 role ≥ 10）自己花的钱不算收入，渠道测试大多记在管理员名下，也在里面；标成转售的管理员 Key 照样算收入；
// - 兜底：渠道测试记录 type 2、token_id 0、token_name 是固定的一串（v0.8.0 到 v1.0.0-rc.42 是「模型测试」，rc.43 起是「Model test」，
//   日志表里旧日志的名字不会跟着升级改，所以两个名字都认），不在管理员名下的才扣，管理员名下的已经在上一条里了，不扣两次。
// 两样都是读管理端日志列表按渠道本地加（stat 不能按渠道分组，管理员数 × 渠道数的请求太多），今天按编号接着翻，结账用全站 stat 对账。
export const OWN_CHANNEL_TEST_TOKEN_NAMES = Object.freeze(["模型测试", "Model test"]);
const OWN_LOG_PAGE_SIZE = 100; // new-api 的 page_size 上限（common/page_info.go）

function ownLogItems(r, what) {
  if (r.status >= 300 || r.body?.success === false) throw newApiResponseError(r, what);
  const items = Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body?.data?.items) ? r.body.data.items : null;
  if (!items) throw providerError("UPSTREAM_RESPONSE_INVALID", "自营站点消费日志格式异常");
  return items;
}

const addTo = (map, key, quota) => map.set(key, (map.get(key) ?? 0) + quota);
const sourceFilter = (kind, name) => kind === "user" ? { username: name } : { token_name: name };

// 限流（New API 默认全站同一个来源 180 秒最多 360 个请求，超了回 429）：照它给的 Retry-After 等一等再发同一页，
// 最多等 MAX_BACKOFF_MS 一次、一共 BACKOFF_TOTAL_MS；还不行就带着进度抛出去，下一轮接着翻
const LOG_RATE_LIMIT_MAX_WAIT_MS = 30000;
const LOG_RATE_LIMIT_TOTAL_WAIT_MS = 90000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 没带 Retry-After（或解析不出来）按 10 秒等；最少等 1 秒，不然 0 秒立刻重发，总等待时间不涨，会一直重发下去（审核 R1 中-1）
const LOG_RATE_LIMIT_DEFAULT_WAIT_MS = 10000;
const retryAfterMs = (value) => {
  const clamp = (ms) => Math.min(LOG_RATE_LIMIT_MAX_WAIT_MS, Math.max(1000, ms));
  if (value == null || String(value).trim() === "") return LOG_RATE_LIMIT_DEFAULT_WAIT_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return clamp(Math.ceil(seconds * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? clamp(at - Date.now()) : LOG_RATE_LIMIT_DEFAULT_WAIT_MS;
};

/**
 * 一个来源（kind: "user" 某个用户名下的消费，或 "token" 某个渠道测试名字）在一段窗口里的消费日志，按渠道加起来。
 * previous：上一次读到的这个来源（只读比 previous.maxId 大的，加到它上面）；全站的数用 queryOwnLogSourceTotal 对账。
 * 返回 { byChannel, byToken（user：每个令牌名在各渠道的额度，转售 Key 要单独减回来）, byUser（token：每个用户名在各渠道的额度，管理员名下的要单独剔掉）,
 * seen（读到的所有行的额度合计，和接口返回的 stat 同一个筛法，对账用）, maxId }。
 * 只留 type = 2；token 来源只把 token_id 为 0、名字逐字相等的算进去（MySQL 默认排序规则不分大小写，接口可能把 model test 筛回来；
 * 用户自己的 Key 起了同名 token_id 不是 0）。其余的行也算进 seen，让 seen 和 stat 同口径。
 * 按页码翻、按时刻倒序：翻的过程中有新记录写进来，页边上那条会再出现一次，所以按编号去重（同一次读取里见过的编号不再数）。
 * shouldContinue({ total })：第一页读完调用，返回 false 就停下返回 null（改用别的办法）。
 * 失败（限流等了还不行、网络错、格式不对）抛出的错上带着 resume = { part, nextPage, ids }：窗口已经在过去的（翻页不会再被新记录挤歪），
 * 调用方可以把它交回来（resume 参数）从 nextPage 接着翻，不用从头；今天的窗口也记（调用方接着翻时沿用当时的终点，翻完再按编号补到现在）。
 * maxPages 防御：翻到这么多页还没翻完，当读不到，不拿翻了一半的数去扣收入。sleep 给测试换掉等待。
 */
export async function queryOwnLogSource(station, { kind, name, startMs, endMs, previous = null, resume = null, maxPages = 2000, sleep = defaultSleep, onPage = null, shouldContinue = null }) {
  const clone = (from) => ({
    byChannel: new Map(from?.byChannel || []),
    byToken: new Map([...(from?.byToken || [])].map(([key, value]) => [key, new Map(value)])),
    byUser: new Map([...(from?.byUser || [])].map(([key, value]) => [key, new Map(value)])),
    seen: from?.seen ?? 0, maxId: from?.maxId ?? null,
  });
  const part = resume ? resume.part : clone(previous);
  const ids = resume ? resume.ids : new Set();
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) return part;
  const { base, headers } = newApiStationAuth(station);
  // 从 previous 接着翻时，afterId 是 previous 的最大编号；从 resume 接着翻时沿用当时的
  const afterId = resume ? resume.afterId : previous?.maxId ?? null;
  let maxId = part.maxId, waited = 0;
  const fail = (err, nextPage) => { part.maxId = maxId; throw Object.assign(err, { resume: { part, nextPage, ids, afterId } }); };
  for (let page = resume?.nextPage ?? 1; page <= maxPages; page += 1) {
    const qs = new URLSearchParams({ p: String(page), page_size: String(OWN_LOG_PAGE_SIZE), type: "2", ...sourceFilter(kind, name),
      start_timestamp: String(window.start), end_timestamp: String(window.end) });
    let items, pageTotal = null;
    try {
      for (;;) {
        const r = await request(`${base}/api/log/?${qs}`, { headers, timeoutMs: OWN_LOG_SOURCE_TIMEOUT_MS });
        if (r.status === 429 && waited < LOG_RATE_LIMIT_TOTAL_WAIT_MS) {
          const wait = retryAfterMs(r.retryAfter);
          waited += wait;
          await sleep(wait);
          continue;
        }
        if (r.status === 429) throw providerError("UPSTREAM_REQUEST_FAILED", "自营站点限流（429），稍后接着读");
        items = ownLogItems(r, "读取自营站点消费日志失败");
        const raw = Array.isArray(r.body?.data) ? null : r.body?.data?.total;
        pageTotal = raw == null || raw === "" || !Number.isSafeInteger(Number(raw)) || Number(raw) < 0 ? null : Number(raw);
        break;
      }
    } catch (err) { return fail(err, page); }
    onPage?.({ page, rows: items.length });
    // 读完第一页就知道一共多少行（total），翻页要 ⌈行数 ÷ 100⌉ 页：调用方觉得页数太多、别的办法更省请求时返回 false，这里停下返回 null，
    // 不再翻（第一页已经读了，没有额外的请求）。老版本不给 total 时是 null，shouldContinue 自己决定
    if (page === 1 && !resume && shouldContinue && shouldContinue({ total: pageTotal }) === false) return null;
    let reachedOld = false, fresh = 0;
    try {
      for (const row of items) {
        const id = Number(row?.id);
        // 列表按 created_at、id 倒序：翻到不大于上次编号的就停
        if (afterId != null && Number.isFinite(id) && id <= afterId) { reachedOld = true; continue; }
        if (Number.isFinite(id)) { if (ids.has(id)) continue; ids.add(id); }
        fresh += 1;
        if (Number(row?.type) !== 2) continue;
        const channel = Number(row.channel ?? row.channel_id), quota = Number(row.quota);
        if (!Number.isSafeInteger(channel) || !Number.isFinite(quota) || quota < 0) throw providerError("UPSTREAM_RESPONSE_INVALID", "自营站点消费日志格式异常");
        part.seen += quota;
        if (Number.isFinite(id) && (maxId == null || id > maxId)) maxId = id;
        if (kind === "user") {
          if (String(row.username ?? "").toLowerCase() !== String(name).toLowerCase()) continue; // 接口按名字筛不分大小写，和 stat 同口径
          addTo(part.byChannel, channel, quota);
          const token = String(row.token_name ?? "");
          if (!part.byToken.has(token)) part.byToken.set(token, new Map());
          addTo(part.byToken.get(token), channel, quota);
        } else {
          if (row.token_name !== name || row.token_id == null || Number(row.token_id) !== 0) continue;
          addTo(part.byChannel, channel, quota);
          const user = String(row.username ?? "");
          if (!part.byUser.has(user)) part.byUser.set(user, new Map());
          addTo(part.byUser.get(user), channel, quota);
        }
      }
    } catch (err) { return fail(err, page + 1); }
    // 一整页都是见过的行：翻页没有往前走（对方不认页码，或翻的过程中一下子写进来整整一页）。不接着翻下去（最多 2000 页的请求白发），
    // 带着进度抛出去，下一轮再接着来
    if (!reachedOld && items.length >= OWN_LOG_PAGE_SIZE && fresh === 0 && page > (resume?.nextPage ?? 1)) {
      return fail(providerError("UPSTREAM_RESPONSE_INVALID", "自营站点消费日志翻页没有往前走"), page + 1);
    }
    if (reachedOld || items.length < OWN_LOG_PAGE_SIZE) { part.maxId = maxId; return part; }
  }
  return fail(providerError("UPSTREAM_RESPONSE_INVALID", "自营站点消费日志太多，一个窗口翻不完"), maxPages + 1);
}

// 整站消费日志的一页（应付成本 V1-a 的整站读）：不带用户名、Key 名筛选，只按时间窗口和页码；返回 { items, total }。
// 调用方（server/own-log-ingest.js）自己控制窗口大小和每轮页数，这里不翻页、不等限流（429 照样抛带码的错，由断路器处理）
// 两条读自营站点日志的路各自的超时：R1 结账读管理员日志（queryOwnLogSource）照旧 25 秒；整站读（queryOwnLogWindow）10 秒，慢了就停这一轮（审核 #123 中-3）。
// 别混：审核第二轮抓到过把 10 秒改到 R1 那条路上，lib/providers.test.js 锁住两边
export const OWN_LOG_SOURCE_TIMEOUT_MS = 25000;
export const OWN_LOG_WINDOW_TIMEOUT_MS = 10000;
export async function queryOwnLogWindow(station, { startMs, endMs, page = 1 }) {
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) return { items: [], total: 0 };
  const { base, headers } = newApiStationAuth(station);
  const qs = new URLSearchParams({ p: String(page), page_size: String(OWN_LOG_PAGE_SIZE), type: "2", start_timestamp: String(window.start), end_timestamp: String(window.end) });
  const r = await request(`${base}/api/log/?${qs}`, { headers, timeoutMs: OWN_LOG_WINDOW_TIMEOUT_MS });
  if (r.status === 429) throw providerError("UPSTREAM_REQUEST_FAILED", "自营站点限流（429），稍后接着读");
  const items = ownLogItems(r, "读取自营站点消费日志失败");
  const raw = Array.isArray(r.body?.data) ? null : r.body?.data?.total;
  const total = raw == null || raw === "" || !Number.isSafeInteger(Number(raw)) || Number(raw) < 0 ? null : Number(raw);
  return { items, total };
}

// 上游的价目表（应付成本 V1-a）：GET /api/pricing，只挂「模型广场」开关、不要求登录；带令牌时按这个账号的可用分组给，group_ratio 也是这个账号的。
// 关了模型广场回 403 → 抛带码的错（MODEL_PRICE_UNREADABLE），调用方给「—」
export async function queryUpstreamPricing(station) {
  const { base, headers } = newApiStationAuth(station);
  const r = await request(`${base}/api/pricing`, { headers, timeoutMs: 20000 });
  if (r.status === 403 || r.status === 404) throw providerError("MODEL_PRICE_UNREADABLE", `上游没开放模型价格表（HTTP ${r.status}）`);
  if (r.status >= 300 || r.body?.success === false) throw newApiResponseError(r, "读取上游价目表失败");
  if (!Array.isArray(r.body?.data)) throw providerError("UPSTREAM_RESPONSE_INVALID", "上游价目表格式异常");
  return r.body;
}

// 全站这段窗口里这个来源的 type 2 总额度（和上面列表同一个筛法），结账对账用：和逐条累计的 seen 相等说明一条没漏
export async function queryOwnLogSourceTotal(station, { kind, name, startMs, endMs, username = null }) {
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) return 0;
  const { base, headers } = newApiStationAuth(station);
  // username：渠道测试名字这个来源再按用户名筛一遍（stat 两个条件同时支持，都是等号筛选）：算这个测试名字里有多少在某个管理员名下
  const qs = new URLSearchParams({ type: "2", ...sourceFilter(kind, name), ...(username ? { username } : {}), start_timestamp: String(window.start), end_timestamp: String(window.end) });
  return statQuota(await request(`${base}/api/log/stat?${qs}`, { headers, timeoutMs: 20000 }), `${kind === "user" ? "用户" : "渠道测试"}「${name}」`);
}

// 一个用户在一个渠道上的 type 2 总额度（/api/log/stat 带 username 和 channel，转售 Key 再带 token_name）。
// 翻页要翻很多页时，改成对要算的渠道每个查一次，这样请求数只和渠道数、转售 Key 数有关，和日志条数无关
export async function queryOwnUserChannelStat(station, { name, channel, tokenName = null, startMs, endMs }) {
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) return 0;
  const { base, headers } = newApiStationAuth(station);
  const qs = new URLSearchParams({ type: "2", username: name, channel: String(channel), ...(tokenName == null ? {} : { token_name: tokenName }),
    start_timestamp: String(window.start), end_timestamp: String(window.end) });
  return statQuota(await request(`${base}/api/log/stat?${qs}`, { headers, timeoutMs: 20000 }), `用户「${name}」渠道 ${channel} `);
}

/**
 * 本站管理端渠道收费汇总。财务真值只来自每个渠道的日志账单统计；
 * /api/data/flow 是分析口径，不能用于收费、覆盖率或失败降级。
 * loadStatus 可让一轮对账的各分段共用一次 /api/status 读取；只在确实要取数时才调用。
 */
// exclusion：这段窗口各渠道不算收入的额度（{ byChannel: Map<渠道, 额度> }，或返回它的函数）：管理员自己花的钱（转售的管理员 Key 不在里面）加上
// 兜底的渠道测试，从各渠道收入里减掉（own-revenue-plan 第一节，和运营总览、自营业务同一个规矩）。必须由调用方（server/reconciliation.js）
// 传进来：管理员名单、转售 Key 的判断和「今天」接着翻、结账对账的缓存都在那边。读不到：这一段所有渠道都算读不到，不拿没减的数当收入
// （算出来的收入会固定进账本）。
export async function queryOwnChannelRevenue(station, { channelIds, startMs, endMs, timezone, loadStatus = null, exclusion }) {
  const zone = reconciliationTimezone(timezone), actualWindow = { startMs, endMs, timezone: zone };
  const wanted = new Set((channelIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0));
  if (!wanted.size) throw new Error("至少选择一个本站销售渠道");
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) {
    return {
      quotaUnits: 0,
      quotaPerUnit: null,
      amountUsd: null,
      knownAmountUsd: null,
      state: "pending",
      successfulCount: 0,
      expectedCount: wanted.size,
      billingSource: RECONCILIATION_BILLING_SOURCE,
      calculationVersion: RECONCILIATION_CALCULATION_VERSION,
      channels: [],
      emptySecondWindow: true,
      window: actualWindow,
      billingTimezone: billingTimezone(zone),
    };
  }
  const { base, headers } = newApiStationAuth(station);
  const ids = [...wanted];
  const statusResult = await (loadStatus ? Promise.resolve(loadStatus()).then(reusedNewApiStatus) : newApiStatus(base))
    .then((value) => ({ value }), (error) => ({ error }));
  if (exclusion == null) throw new Error("缺少不算收入的消费（管理员自用）");
  const testRead = await Promise.resolve(typeof exclusion === "function" ? exclusion() : exclusion).then((value) => ({ value }), (error) => ({ error }));
  const testByChannel = testRead.value?.byChannel || new Map();
  // 令牌作废或少了权限：整个站点都读不了，不是哪个渠道的事，直接抛带码的错（要人换令牌，不等重试）
  const tokenCause = [testRead.error, testRead.error?.cause].find((error) => isAccessTokenError(error?.code));
  if (tokenCause) throw tokenCause;
  const limit = testRead.error ? 0 : Math.min(6, ids.length);
  let cursor = 0;
  const channels = new Array(ids.length);
  let tokenFailure = null;
  if (testRead.error) ids.forEach((channelId, index) => { channels[index] = { channelId, name: `渠道 ${channelId}`, billingState: "unavailable", quotaUnits: null, amountUsd: null, issue: "读不到管理员自用的消费" }; });
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < ids.length) {
      const index = cursor++;
      const channelId = ids[index];
      try {
        const qs = new URLSearchParams({
          type: "2",
          channel: String(channelId),
          start_timestamp: String(window.start),
          end_timestamp: String(window.end),
        });
        const billed = statQuota(await request(`${base}/api/log/stat?${qs}`, { headers, timeoutMs: 20000 }), `渠道 ${channelId} `);
        // 管理员自用和渠道测试也记收费日志，这个渠道的统计里含这一部分；减不出非负数说明读到的两个数对不上，按读不到
        const testUnits = testByChannel.get(channelId) ?? 0;
        if (testUnits > billed) throw new Error("不算收入的额度大于渠道收费");
        channels[index] = { channelId, name: `渠道 ${channelId}`, billingState: "complete", quotaUnits: billed - testUnits, adminUsageQuotaUnits: testUnits, amountUsd: null };
      } catch (error) {
        if (isAccessTokenError(error?.code)) tokenFailure ||= error;
        channels[index] = { channelId, name: `渠道 ${channelId}`, billingState: "unavailable", quotaUnits: null, amountUsd: null, issue: "读不到这个渠道的账单统计" };
      }
    }
  }));
  if (tokenFailure) throw tokenFailure;
  const successful = channels.filter((row) => row.billingState === "complete");
  const quotaUnits = successful.reduce((sum, row) => sum + row.quotaUnits, 0);
  const successfulCount = successful.length;
  const expectedCount = ids.length;
  const status = statusResult.value || null;
  if (status) {
    for (const channel of successful) {
      channel.amountUsd = channel.quotaUnits / status.quotaPerUnit;
      channel.adminUsageAmountUsd = channel.adminUsageQuotaUnits / status.quotaPerUnit;
    }
  }
  const summedAmountUsd = Number.isFinite(quotaUnits) && status && successful.length
    ? successful.reduce((sum, row) => sum + row.amountUsd, 0)
    : null;
  const knownAmountUsd = Number.isFinite(summedAmountUsd) ? summedAmountUsd : null;
  const complete = !!status && Number.isFinite(quotaUnits) && successful.length === ids.length && Number.isFinite(knownAmountUsd);
  return {
    ...(status || {}),
    quotaUnits,
    // 这一段从收入里减掉的管理员自用（美元），计算明细「其中管理员自用」用；换算读不到时是 null
    adminUsageQuotaUnits: successful.reduce((sum, row) => sum + row.adminUsageQuotaUnits, 0),
    adminUsageAmountUsd: status && successful.length ? successful.reduce((sum, row) => sum + row.adminUsageAmountUsd, 0) : null,
    amountUsd: complete ? knownAmountUsd : null,
    knownAmountUsd,
    state: complete ? "complete" : successful.length ? "partial" : "unavailable",
    successfulCount,
    expectedCount,
    billingSource: RECONCILIATION_BILLING_SOURCE,
    calculationVersion: RECONCILIATION_CALCULATION_VERSION,
    channels,
    window: actualWindow,
    billingTimezone: billingTimezone(zone),
  };
}

// 一条消费日志的 token 口径拆解（字段口径取自 new-api service/text_quota.go）：
//   · 看板 quota_data.token_used 只写 prompt_tokens + completion_tokens
//   · Claude（usage_semantic=anthropic）语义下 prompt_tokens 是「未命中缓存的输入」，
//     缓存读 cache_tokens 与缓存写 cache_write_tokens/cache_creation_tokens 额外计费，
//     所以真实 token 要把两者加回来——这正是「token 栏几乎为空、额度栏很大」的成因
//   · OpenAI 语义下缓存 token 本就含在 prompt_tokens 里（计费时再拆出来乘系数），
//     加回去会重复计数，只做展示拆分
export function auditRowTokens(row, other) {
  const prompt = num(row.prompt_tokens);
  const completion = num(row.completion_tokens);
  const cacheRead = num(other.cache_tokens);
  const cacheWrite = num(other.cache_write_tokens ?? other.cache_creation_tokens);
  const anthropic = other.usage_semantic === "anthropic" || other.claude === true;
  const billed = prompt + completion;
  const input = anthropic
    ? prompt + cacheRead + cacheWrite
    : Math.max(prompt, num(other.input_tokens_total));
  return {
    prompt, completion, cacheRead, cacheWrite, billed, input, anthropic,
    total: anthropic ? billed + cacheRead + cacheWrite : billed,
  };
}

function auditBucket() {
  return {
    requests: 0, cost: 0,
    billedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, trueTokens: 0,
    longRequests: 0, longCost: 0,
    anthropicRequests: 0, tiers: {},
    ratioWeight: 0, modelRatioSum: 0, groupRatioSum: 0, completionRatioSum: 0,
  };
}

function auditAdd(map, key, t, other, cost, isLong) {
  if (!key) return;
  const b = map.get(key) || auditBucket();
  b.requests++;
  b.cost += cost;
  b.billedTokens += t.billed;
  b.cacheReadTokens += t.cacheRead;
  b.cacheWriteTokens += t.cacheWrite;
  b.trueTokens += t.total;
  if (t.anthropic) b.anthropicRequests++;
  if (isLong) { b.longRequests++; b.longCost += cost; }
  const tier = other.matched_tier ? String(other.matched_tier) : "";
  if (tier) b.tiers[tier] = (b.tiers[tier] || 0) + 1;
  if (num(other.model_ratio) > 0) {
    b.ratioWeight++;
    b.modelRatioSum += num(other.model_ratio);
    b.groupRatioSum += num(other.group_ratio);
    b.completionRatioSum += num(other.completion_ratio);
  }
  map.set(key, b);
}

function auditFinish(map, field) {
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return [...map.entries()]
    .map(([key, b]) => ({
      [field]: key,
      requests: b.requests,
      cost: r4(b.cost),
      billedTokens: b.billedTokens,
      cacheReadTokens: b.cacheReadTokens,
      cacheWriteTokens: b.cacheWriteTokens,
      trueTokens: b.trueTokens,
      longRequests: b.longRequests,
      longCost: r4(b.longCost),
      // 缓存额外计费的行占比：判断这一行的 token 栏能不能当真
      anthropicPct: b.requests ? Math.round((b.anthropicRequests / b.requests) * 100) : 0,
      tiers: Object.entries(b.tiers).sort((a, c) => c[1] - a[1]).map(([name, n]) => ({ name, requests: n })),
      avgModelRatio: b.ratioWeight ? Math.round((b.modelRatioSum / b.ratioWeight) * 1000) / 1000 : null,
      avgGroupRatio: b.ratioWeight ? Math.round((b.groupRatioSum / b.ratioWeight) * 1000) / 1000 : null,
      avgCompletionRatio: b.ratioWeight ? Math.round((b.completionRatioSum / b.ratioWeight) * 1000) / 1000 : null,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * 「我的站点」日志精算：翻 new-api 消费日志明细（GET /api/log/?type=2），把看板漏计的
 * 缓存读/缓存写 token 与长上下文请求算出来。看板只有 prompt+completion，
 * 于是 Claude 这类「缓存占九成」的模型会显示成 token 近零、消费很大。
 * 日志按时间倒序，maxRows 截断时覆盖的是最近的若干条，返回 from/to 说明实际覆盖窗口。
 * 返回 {scanned, total, truncated, fromMs, toMs, longContextTokens, totals, byModel/byUser/byGroup/byChannel}
 */
export async function queryOwnLogAudit(station, {
  startMs, endMs, model = "", username = "", group = "",
  maxRows = 4000, longContextTokens = 200000, concurrency = 4,
} = {}) {
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) {
    return {
      scanned: 0, total: 0, truncated: false, fromMs: null, toMs: null, longContextTokens,
      totals: null, byModel: [], byUser: [], byGroup: [], byChannel: [], emptySecondWindow: true,
    };
  }
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw providerError("MISSING_CONFIGURATION", "缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const PAGE = 100; // new-api 的 page_size 上限就是 100（common/page_info.go）
  const baseQs = {
    type: "2",
    start_timestamp: String(window.start),
    end_timestamp: String(window.end),
    ...(model ? { model_name: model } : {}),
    ...(username ? { username } : {}),
    ...(group ? { group } : {}),
  };
  const fetchPage = async (p) => {
    const qs = new URLSearchParams({ ...baseQs, p: String(p), page_size: String(PAGE) });
    const r = await request(`${base}/api/log/?${qs}`, { headers, timeoutMs: 25000 });
    if (r.status >= 300) throw httpError(r);
    if (r.body?.success === false) {
      const tokenError = accessTokenError(r);
      if (tokenError) throw tokenError;
      const msg = String(r.body?.message || "");
      const denied = /privileg|unauthorized/i.test(msg);
      throw providerError(denied ? "UPSTREAM_AUTH_DENIED" : null, denied
        ? "该令牌没有管理员权限，无法读取消费日志" : msg || "日志查询失败");
    }
    // 新版 data.items[]，老版 data[]
    const items = Array.isArray(r.body?.data) ? r.body.data
      : Array.isArray(r.body?.data?.items) ? r.body.data.items : [];
    const total = Number(r.body?.data?.total);
    return { items, total: Number.isFinite(total) ? total : null };
  };

  const first = await fetchPage(1);
  const total = first.total;
  const wanted = Math.max(PAGE, Math.min(maxRows, total ?? maxRows));
  const lastPage = Math.ceil(wanted / PAGE);
  const rows = [...first.items];
  for (let p = 2; p <= lastPage && rows.length < wanted; p += concurrency) {
    const batch = [];
    for (let i = 0; i < concurrency && p + i <= lastPage; i++) batch.push(fetchPage(p + i));
    const done = await Promise.all(batch);
    let empty = false;
    for (const d of done) {
      if (!d.items.length) empty = true;
      rows.push(...d.items);
    }
    if (empty) break; // 日志被清理或 total 不准，提前收尾
  }

  const byModel = new Map(), byUser = new Map(), byGroup = new Map(), byChannel = new Map();
  const totalsMap = new Map();
  let fromMs = null, toMs = null;
  for (const row of rows) {
    let other = {};
    if (row.other) {
      if (typeof row.other === "object") other = row.other;
      else { try { other = JSON.parse(row.other) || {}; } catch { other = {}; } }
    }
    const t = auditRowTokens(row, other);
    const cost = num(row.quota) / QUOTA_PER_UNIT;
    const isLong = t.input >= longContextTokens;
    const at = num(row.created_at) * 1000;
    if (at > 0) {
      if (fromMs == null || at < fromMs) fromMs = at;
      if (toMs == null || at > toMs) toMs = at;
    }
    auditAdd(byModel, String(row.model_name || "unknown"), t, other, cost, isLong);
    auditAdd(byUser, String(row.username || "unknown"), t, other, cost, isLong);
    auditAdd(byGroup, String(row.group || "（无分组）"), t, other, cost, isLong);
    auditAdd(byChannel, String(row.channel_name || `渠道 ${num(row.channel)}`), t, other, cost, isLong);
    auditAdd(totalsMap, "all", t, other, cost, isLong); // 合计与分维度走同一套累加
  }

  const [summary] = auditFinish(totalsMap, "key");
  return {
    scanned: rows.length,
    total,
    // total 缺失（老版本不返回）时，扫到上限就按「可能被截断」报，宁可保守
    truncated: total != null ? rows.length < total : rows.length >= wanted,
    fromMs, toMs,
    longContextTokens,
    totals: summary || null,
    byModel: auditFinish(byModel, "model"),
    byUser: auditFinish(byUser, "user"),
    byGroup: auditFinish(byGroup, "group"),
    byChannel: auditFinish(byChannel, "channel"),
  };
}

/**
 * 「我的站点」渠道列表（new-api 管理员接口，分页拉全）。
 * 返回 [{id, name, type, status, baseUrl, groups}]，status: 1=启用 2=手动禁用 3=自动禁用
 */
export async function queryOwnChannels(station) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw providerError("MISSING_CONFIGURATION", "缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const out = [];
  const seen = new Set();
  const maxPages = 100;
  // 老版 data[] 的 p 从 0 开始；新版 data.items[] 的 p 从 1 开始，且把 p<1 当成第 1 页。
  // 先请求 p=0 识别格式并锁定：老版接着请求 1、2…，新版跳过与 p=0 重复的 p=1，从 2 开始。
  // 默认按优先级排序，翻页期间有人调优先级就会漏页或重页；id_sort=true 改按 id 排序，翻页顺序稳定。
  let format = null;
  let listTotal = null;
  let hasTotal = null;
  const catalogueError = (message) => Object.assign(new Error(message), { code: "CHANNEL_CATALOGUE_INVALID" });
  const requestError = (error) => Object.assign(providerError(error?.code, connectionDiagnostic(error, { accessToken: token })), error?.scope != null ? { scope: error.scope } : {});
  for (let page = 0; page < maxPages; page++) {
    const p = format === "items" ? page + 1 : page;
    const r = await request(`${base}/api/channel/?p=${p}&page_size=100&id_sort=true`, { headers, timeoutMs: 15000 })
      .catch((error) => { throw requestError(error); });
    if (r.status >= 300) throw requestError(httpError(r));
    if (r.body?.success === false) {
      const tokenError = accessTokenError(r);
      if (tokenError) throw tokenError;
      const msg = String(r.body?.message || "");
      const denied = /privileg|unauthorized/i.test(msg);
      throw requestError(providerError(denied ? "UPSTREAM_AUTH_DENIED" : null, denied
        ? "该令牌没有管理员权限，无法读取渠道列表" : msg || "获取渠道失败"));
    }
    const pageFormat = Array.isArray(r.body?.data) ? "array"
      : Array.isArray(r.body?.data?.items) ? "items" : null;
    if (!pageFormat) throw catalogueError("本站渠道列表格式异常，请检查 NewAPI 接口");
    if (format && pageFormat !== format) throw catalogueError("本站渠道列表分页格式中途变化，请重试");
    format = pageFormat;
    const items = format === "array" ? r.body.data : r.body.data.items;
    const totalValue = r.body?.data?.total;
    const pageHasTotal = totalValue != null;
    const total = pageHasTotal ? Number(totalValue) : null;
    if (pageHasTotal && (typeof totalValue !== "number" && typeof totalValue !== "string" ||
        String(totalValue).trim() === "" || !Number.isSafeInteger(total) || total < 0)) {
      throw catalogueError("本站渠道列表总量格式异常，请重试");
    }
    if (hasTotal != null && pageHasTotal !== hasTotal || listTotal != null && total !== listTotal) {
      throw providerError("UPSTREAM_LIST_CHANGED", "本站渠道列表在翻页期间发生变化，请重试");
    }
    hasTotal = pageHasTotal;
    listTotal = total;
    if (!items.length) {
      if (total != null && out.length !== total) throw providerError("UPSTREAM_LIST_CHANGED", "本站渠道列表分页不完整，请重试");
      break;
    }
    for (const c of items) {
      const id = stableProviderId(c?.id);
      if (!c || typeof c !== "object" || id == null) {
        throw catalogueError("本站渠道列表条目格式异常，请重试");
      }
      if (seen.has(id)) throw providerError("UPSTREAM_LIST_CHANGED", "本站渠道列表分页重复，请重试");
      seen.add(id);
      out.push({
        id, name: String(c.name || ""), type: Number(c.type) || 0,
        status: Number(c.status) || 0, baseUrl: String(c.base_url || ""),
        groups: [...new Set(String(c.group || "").split(",").map((group) => group.trim()).filter(Boolean))],
      });
    }
    if (total != null && out.length > total) throw providerError("UPSTREAM_LIST_CHANGED", "本站渠道列表数量超过总量，请重试");
    if (total != null && out.length === total) break;
    if (page === maxPages - 1) throw providerError("UPSTREAM_LIST_TOO_LARGE", "本站渠道过多，超出安全读取上限");
  }
  // 旧接口没有 total，只证明读到了结束页；调用方不能据一次缺项确认删除。
  Object.defineProperties(out, {
    totalValidated: { value: hasTotal === true },
    catalogueTotal: { value: listTotal },
  });
  return out;
}

/**
 * 「我的站点」用户列表（new-api 管理员接口，分页拉全）。
 * 返回 [{id, username, displayName, role, status, quotaUsd, usedUsd}]
 * role: 1=普通用户 10=管理员 100=root；quota 按 500000=$1 换算
 */
export async function queryOwnUsers(station) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw providerError("MISSING_CONFIGURATION", "缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const out = [];
  const seen = new Set();
  const names = new Set();
  // 旧版 data[] 从 p=0 开始；新版 data.items 从 p=1 开始，并把 p=0 当成第一页。
  // 先读 p=0 判格式，随后按各自协议推进，不能漏第一页或把它重复算一次。
  const maxPages = 100;
  let format = null, listTotal = null;
  for (let page = 0; page < maxPages; page++) {
    const p = format === "items" ? page + 1 : page;
    const r = await request(`${base}/api/user/?p=${p}&page_size=100`, { headers, timeoutMs: 15000 });
    if (r.status >= 300) throw httpError(r);
    if (r.body?.success === false) throw new Error(r.body?.message || "获取用户列表失败");
    const pageFormat = Array.isArray(r.body?.data) ? "array"
      : Array.isArray(r.body?.data?.items) ? "items" : null;
    if (!pageFormat || format && pageFormat !== format) throw providerError("UPSTREAM_RESPONSE_INVALID", "用户列表格式异常或分页格式中途变化");
    format = pageFormat;
    const items = format === "array" ? r.body.data : r.body.data.items;
    const totalValue = r.body?.data?.total;
    const total = totalValue == null ? null : Number(totalValue);
    if (total != null && (!Number.isSafeInteger(total) || total < 0)) throw providerError("UPSTREAM_RESPONSE_INVALID", "用户列表总数无效");
    if (page > 0 && total !== listTotal) throw providerError("UPSTREAM_LIST_CHANGED", "用户列表总数中途变化，请重试");
    listTotal = total;
    if (!items.length) {
      if (total != null && out.length !== total) throw providerError("UPSTREAM_LIST_CHANGED", "用户列表没读全，请重试");
      return out;
    }
    for (const u of items) {
      const id = String(u?.id ?? ""), username = String(u?.username || "");
      const rawRole = u?.role;
      const role = typeof rawRole === "number" || typeof rawRole === "string" && rawRole.trim() ? Number(rawRole) : NaN;
      if (!id || !username || !Number.isInteger(role)) throw providerError("UPSTREAM_RESPONSE_INVALID", "用户身份或角色缺失或无效");
      if (seen.has(id) || names.has(username)) throw providerError("UPSTREAM_LIST_CHANGED", "用户列表分页重复，请重试");
      seen.add(id); names.add(username);
      out.push({
        id: u.id,
        username,
        displayName: String(u.display_name || ""),
        role,
        status: Number(u.status) || 0,
        quotaUsd: num(u.quota) / QUOTA_PER_UNIT,
        usedUsd: num(u.used_quota) / QUOTA_PER_UNIT,
      });
    }
    if (total != null && out.length > total) throw providerError("UPSTREAM_LIST_CHANGED", "用户列表超过总数，请重试");
    if (total != null && out.length === total) return out;
  }
  throw providerError("UPSTREAM_LIST_TOO_LARGE", "用户列表超过安全读取上限，尚未读全");
}

/**
 * 「我的站点」某个账号的 API Key 列表（new-api 管理员接口）。
 * new-api 的 /api/token/ 按「当前操作用户」返回其名下 Key，通过 New-Api-User 头切换目标账号。
 * 返回 [{id, name, usedUsd, remainUsd, status}]，status: 1=启用 其它=禁用/过期
 */
export async function queryAdminTokens(station, targetUserId) {
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw providerError("MISSING_CONFIGURATION", "缺少站点地址或访问令牌");
  const headers = { Authorization: token, "New-Api-User": String(targetUserId) };

  const out = [];
  const seen = new Set();
  // 最多读 5 页，读满即返回已读到的部分（新版 page_size=100 即 500 个 Key），沿用原有上限口径。
  const maxPages = 5;
  // 与本站渠道目录同一套页码规则：老版 data[] 的 p 从 0 开始；新版 data.items[] 的 p 从 1 开始，且把 p<1 当成第 1 页。
  // 先请求 p=0 识别格式并锁定：老版接着请求 1、2…，新版跳过与 p=0 重复的 p=1，从 2 开始。
  // 从 p=1 读起会让老版漏掉第一页，Key 不足一页时整张列表读成空的。
  let format = null;
  for (let page = 0; page < maxPages; page++) {
    const p = format === "items" ? page + 1 : page;
    const r = await request(`${base}/api/token/?p=${p}&page_size=100`, { headers, timeoutMs: 15000 });
    if (r.status >= 300) throw httpError(r);
    if (r.body?.success === false) throw new Error(r.body?.message || "获取 Key 列表失败");
    const pageFormat = Array.isArray(r.body?.data) ? "array"
      : Array.isArray(r.body?.data?.items) ? "items" : null;
    if (!pageFormat) throw providerError("UPSTREAM_RESPONSE_INVALID", "Key 列表格式异常，请检查 NewAPI 接口");
    if (format && pageFormat !== format) throw providerError("UPSTREAM_RESPONSE_INVALID", "Key 列表分页格式中途变化，请重试");
    format = pageFormat;
    const items = format === "array" ? r.body.data : r.body.data.items;
    const totalValue = r.body?.data?.total;
    const total = totalValue == null ? null : Number(totalValue);
    if (!items.length) {
      if (total != null && Number.isFinite(total) && out.length < total) throw providerError("UPSTREAM_LIST_CHANGED", "Key 列表分页不完整，请重试");
      break;
    }
    const before = out.length;
    for (const t of items) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({
        id: t.id,
        name: String(t.name || ""),
        status: Number(t.status) || 0,
        usedUsd: num(t.used_quota) / QUOTA_PER_UNIT,
        remainUsd: t.unlimited_quota ? null : num(t.remain_quota) / QUOTA_PER_UNIT,
      });
    }
    if (out.length === before) throw providerError("UPSTREAM_LIST_CHANGED", "Key 列表分页重复，请重试");
    if (total != null && Number.isFinite(total) && out.length >= total) break;
  }
  return out;
}

/**
 * 用日志统计接口聚合某个 (用户名 + Key 名) 在时间窗内的消费额度（new-api 管理员接口）。
 * GET /api/log/stat?type=2 返回 {quota, rpm, tpm}——quota 为窗内消费额度总和。
 * ⚠ Key 名会跨用户重名，必须同时带 username 与 token_name 才能唯一定位。
 * 返回消费金额（美元）；无数据返回 0。
 */
export async function queryLogStat(station, { username, tokenName, startMs, endMs }) {
  const window = unixSecondWindow(startMs, endMs);
  if (window.empty) return 0;
  const base = trimBase(station.baseUrl);
  const token = String(station.accessToken || "").trim();
  if (!base || !token) throw providerError("MISSING_CONFIGURATION", "缺少站点地址或访问令牌");
  const headers = { Authorization: token };
  const userId = String(station.userId || "").trim();
  if (userId) headers["New-Api-User"] = userId;

  const qs = new URLSearchParams({
    type: "2",
    username: String(username || ""),
    token_name: String(tokenName || ""),
    start_timestamp: String(window.start),
    end_timestamp: String(window.end),
  });
  const r = await request(`${base}/api/log/stat?${qs}`, { headers, timeoutMs: 20000 });
  if (r.status >= 300) throw httpError(r);
  if (r.body?.success === false) throw new Error(r.body?.message || "日志统计查询失败");
  const quota = r.body?.data?.quota;
  if (!(typeof quota === "number" || typeof quota === "string" && quota.trim()) || !Number.isFinite(Number(quota))) {
    throw providerError("UPSTREAM_RESPONSE_INVALID", "转售记录没有有效的消费金额");
  }
  return Number(quota) / QUOTA_PER_UNIT;
}

/**
 * 查询站点的用量明细（分模型 + 分时间），返回 {models, trend}。
 * 与余额查询不同，出错直接 throw，由调用方汇总每个站点的错误。
 */
export async function queryStationUsage(station, opts) {
  const originalCredentials = { ...station, s2Tokens: station.s2Tokens && { ...station.s2Tokens } };
  try {
    switch (station.type) {
      case "newapi": return await newApiUsage(station, opts);
      case "newapi-key": throw providerError("UPSTREAM_FEATURE_UNSUPPORTED", "sk 密钥模式没有用量明细接口");
      case "sub2api":
      case "sub2api-password": return await sub2apiUsage(station, opts);
      default: throw providerError("UNSUPPORTED_UPSTREAM_TYPE", `未知的中转站类型：${station.type}`);
    }
  } catch (error) {
    throw providerError(error?.code, connectionDiagnostic(error, [originalCredentials, station]));
  }
}

const HANDLERS = {
  newapi: queryNewApi,
  "newapi-key": queryNewApiKey,
  sub2api: querySub2Api,
  "sub2api-password": querySub2Api,
};

// 查询单个中转站，永远 resolve，出错时返回 ok:false
export async function queryStation(station) {
  const startedAt = Date.now();
  const originalCredentials = { ...station, s2Tokens: station.s2Tokens && { ...station.s2Tokens } };
  const handler = HANDLERS[station.type];
  try {
    if (!handler) throw providerError("UNSUPPORTED_UPSTREAM_TYPE", `未知的中转站类型：${station.type}`);
    const { tokensChanged, ...balance } = await handler(station);
    return {
      result: {
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        ...balance,
      },
      tokensChanged: !!tokensChanged,
    };
  } catch (err) {
    return {
      result: {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        error: connectionDiagnostic(err, [originalCredentials, station]),
        // 给界面归类用（§8.2）；error 是原文，只进「查看详细原因」
        code: errorCodeOf(err),
      },
      tokensChanged: false,
    };
  }
}

// 类型表只有 lib/channel-onboarding.js 的一张，/api/meta 和接口校验沿用这个名字
export const STATION_TYPES = UPSTREAM_TYPES;
