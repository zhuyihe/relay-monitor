// 自营站点错误日志（/api/log/?type=5）按「小时 × 渠道 × 模型 × 分组 × 原因 × 状态码 × 第几次尝试」分桶，只存次数（模型供需第 1 步）。纯函数，不引 node: 模块。
// 错误日志是 New API 的 ERROR_LOG_ENABLED 打开才记的，每次失败的尝试记一行：重试成功的请求，前面失败的那几次也在。
// 进错误日志的是转发给渠道以后出的错（429、5xx、超时、渠道的 Key 失效……）；分发阶段「无可用渠道」、你站对用户的限流、用户没钱、令牌无效不进。
// 所以这里的 429、503、529 都来自上游或渠道，不是你站对用户的限制。
// 只留计数：不存错误原文（里面可能有用户的内容）、用户名、令牌名、请求号。
export const OWN_ERROR_SLOT_MS = 3600000;

// 原因（用语规范 §3.8 的叫法在页面上，这里只是码）：
//   rate_limit   限流（429）
//   upstream     上游故障（5xx、529、超时、读不到响应）
//   auth_quota   没钱或 Key 失效（401、402、403，错误码是余额、额度、Key 无效这一类）
//   bad_request  请求问题（400、413、422、内容审核）
//   other        其他
export const ERROR_REASONS = Object.freeze(["rate_limit", "upstream", "auth_quota", "bad_request", "other"]);

const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

// 错误码里能看出是「没钱或 Key 失效」的：OpenAI 的 insufficient_quota 是 429，所以要排在状态码前面判
const AUTH_QUOTA_CODE = /insufficient|quota|balance|billing|credit|payment|invalid[_-]?(api[_-]?)?key|no_available_key|unauthori[sz]ed|authentication|permission|forbidden|account[_-]?(deactivated|disabled|suspended)|key[_-]?(expired|revoked|disabled)/i;
const RATE_LIMIT_CODE = /rate[_-]?limit|too[_-]?many[_-]?requests/i;
// 超时、读不到响应、响应是空的、渠道回应太慢：上游的问题（这几种 New API 给的状态码常常就是 500，但也可能是 0 或缺）
const UPSTREAM_CODE = /do_request_failed|read_response_body_failed|bad_response$|bad_response_body|empty_response|response_time_exceeded|timeout|timed[_-]?out|overloaded|server_error|service_unavailable|aws_invoke_error/i;
const BAD_REQUEST_CODE = /invalid_request|bad_request_body|convert_request_failed|read_request_body_failed|sensitive_words|prompt_blocked|content[_-]?(policy|filter)|moderation|violation|context_length|request_too_large/i;

// status：HTTP 状态码（没有是 0）；code：错误码（字符串，没有是 ""）。返回 ERROR_REASONS 里的一个
export function classifyError(status, code) {
  const s = Math.trunc(num(status)), c = String(code ?? "");
  if (AUTH_QUOTA_CODE.test(c) && !RATE_LIMIT_CODE.test(c)) return "auth_quota";
  if (s === 401 || s === 402 || s === 403) return "auth_quota";
  if (s === 429 || RATE_LIMIT_CODE.test(c)) return "rate_limit";
  if (s >= 500 || s === 408 || ((s === 0 || s === 404) && UPSTREAM_CODE.test(c))) return "upstream";
  if (s === 400 || s === 413 || s === 422 || BAD_REQUEST_CODE.test(c)) return "bad_request";
  if (UPSTREAM_CODE.test(c)) return "upstream";
  return "other";
}

// 第几次尝试 = admin_info.use_channel（这次请求已经试过的渠道，含这一次）的长度，存确切的 1–10（超过 10 记 10）：最终没买到的请求要靠「最大那一档的条数」来估，
// 所以不能合并成「3 次及以上」。读不到 use_channel 当第 1 次（记下来比丢掉好，只会让「被拒过的请求数」多算，不会少算）
export const MAX_ATTEMPT = 10;
export function attemptOf(other) {
  const used = other?.admin_info?.use_channel;
  const n = Array.isArray(used) ? used.length : 0;
  return Math.min(MAX_ATTEMPT, Math.max(1, n));
}

// 能不能重试：照 New API rc.30 的 shouldRetry（controller/relay.go）——不能重试的失败，第几次尝试都是这个请求最后一次失败（最终没买到的单）。
// 站点的「自动重试状态码」（设置 AutomaticRetryStatusCodes）能读到就按它，读不到按 rc.30 的默认。
//   - 错误码 channel: 开头（渠道的 Key 不可用、响应太慢……）：一直重试，直到次数用完；
//   - 带「不重试」标记的错误（读请求体失败、预扣额度失败……）：标记在站点内存里，日志看不到，这里按错误码认最常见的几个；
//   - 状态码不在 100–599（没有状态码）：重试；bad_response_body、状态码 504、524：不重试；其余看状态码范围。
export const DEFAULT_RETRY_RANGES = Object.freeze([[100, 199], [300, 399], [401, 407], [409, 499], [500, 503], [505, 523], [525, 599]].map((range) => Object.freeze(range)));
const SKIP_RETRY_CODES = new Set(["read_request_body_failed", "pre_consume_token_quota_failed", "insufficient_user_quota", "bad_response_body"]);
const ALWAYS_SKIP_STATUS = new Set([504, 524]);

// 解析「100-199,300-399,401,429」这种写法（全角逗号也认）；空字符串是「没有任何范围」（什么状态码都不重试）；写不出来的片段丢掉；不是字符串返回 null（当没读到）
export function parseStatusRanges(text) {
  if (typeof text !== "string") return null;
  const ranges = [];
  for (const raw of text.replaceAll("，", ",").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const match = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(token);
    if (!match) continue;
    const start = Number(match[1]), end = match[2] == null ? start : Number(match[2]);
    if (start <= end) ranges.push([start, end]);
  }
  return ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// ranges 是 parseStatusRanges 的结果；null / 不传 = 读不到，按默认
export function isRetryable(status, code, ranges = null) {
  const s = Math.trunc(num(status)), c = String(code ?? "");
  if (c.startsWith("channel:")) return true;
  if (SKIP_RETRY_CODES.has(c)) return false;
  if (s >= 200 && s < 300) return false;
  if (s < 100 || s > 599) return true;
  if (ALWAYS_SKIP_STATUS.has(s)) return false;
  return (ranges || DEFAULT_RETRY_RANGES).some(([start, end]) => s >= start && s <= end);
}

export function parseErrorOther(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

// 两种桶放在同一个暂存、同一个窗口事务里，靠 table 分开：channel（小时 × 渠道 × 模型 × 分组 × 原因 × 状态码 × 第几次尝试 × 能不能重试 → 次数）和
// user（小时 × 用户 ID × 模型 × 原因 → 次数、第 1 次的次数；用户 ID 是日志里的 user_id，不存用户名）
export const errorBucketKeyOf = (b) => (b.table === "user"
  ? JSON.stringify(["user", b.slotMs, b.userId, b.model, b.reason])
  : JSON.stringify([b.slotMs, b.channelId, b.model, b.group, b.reason, b.status, b.attempt, b.retryable]));

/**
 * rows：/api/log/ 的 items（type 5）。context.retryRanges：站点的自动重试状态码范围（parseStatusRanges 的结果，读不到是 null，按默认）。
 * 返回 Map(key → 桶)；每个渠道桶：{ table: "channel", slotMs, channelId, model, group, reason, status, attempt, retryable, count }；
 * 每个用户桶：{ table: "user", slotMs, userId, model, reason, count, firstCount }（firstCount 只数第 1 次尝试）。
 */
export function accumulateErrorBuckets(rows, context = {}, into = new Map()) {
  for (const row of rows || []) {
    if (Number(row?.type) !== 5) continue;
    const at = num(row.created_at);
    if (!(at > 0)) continue;
    const other = parseErrorOther(row.other);
    const slotMs = Math.floor(at * 1000 / OWN_ERROR_SLOT_MS) * OWN_ERROR_SLOT_MS;
    const model = String(row.model_name || "");
    const reason = classifyError(other.status_code, other.error_code);
    const attempt = attemptOf(other);
    const bucket = {
      table: "channel", slotMs,
      channelId: Math.max(0, Math.trunc(num(row.channel ?? row.channel_id ?? other.channel_id))),
      model, group: String(row.group || ""),
      status: Math.max(0, Math.trunc(num(other.status_code))),
      reason, attempt, retryable: isRetryable(other.status_code, other.error_code, context.retryRanges) ? 1 : 0,
    };
    const key = errorBucketKeyOf(bucket);
    const target = into.get(key) || { ...bucket, count: 0 };
    target.count += 1;
    into.set(key, target);
    const userBucket = { table: "user", slotMs, userId: Math.max(0, Math.trunc(num(row.user_id))), model, reason };
    const userKey = errorBucketKeyOf(userBucket);
    const userTarget = into.get(userKey) || { ...userBucket, count: 0, firstCount: 0 };
    userTarget.count += 1;
    if (attempt === 1) userTarget.firstCount += 1;
    into.set(userKey, userTarget);
  }
  return into;
}
