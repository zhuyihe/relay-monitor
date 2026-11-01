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

// 第几次尝试 = admin_info.use_channel（这次请求已经试过的渠道，含这一次）的长度，存成 1、2、3（3 表示 3 次及以上）；
// 读不到 use_channel 当第 1 次（记下来比丢掉好，只会让「被拒过的请求数」多算，不会少算）
export function attemptOf(other) {
  const used = other?.admin_info?.use_channel;
  const n = Array.isArray(used) ? used.length : 0;
  return n >= 3 ? 3 : n === 2 ? 2 : 1;
}

export function parseErrorOther(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

export const errorBucketKeyOf = (b) => JSON.stringify([b.slotMs, b.channelId, b.model, b.group, b.reason, b.status, b.attempt]);

/**
 * rows：/api/log/ 的 items（type 5）。返回 Map(key → 桶)；每个桶：{ slotMs, channelId, model, group, reason, status, attempt, count }。
 * 第二个参数是和消费日志那一条流水线共用的形状（管理员名单这类），这里不用。
 */
export function accumulateErrorBuckets(rows, _context = {}, into = new Map()) {
  for (const row of rows || []) {
    if (Number(row?.type) !== 5) continue;
    const at = num(row.created_at);
    if (!(at > 0)) continue;
    const other = parseErrorOther(row.other);
    const bucket = {
      slotMs: Math.floor(at * 1000 / OWN_ERROR_SLOT_MS) * OWN_ERROR_SLOT_MS,
      channelId: Math.max(0, Math.trunc(num(row.channel ?? row.channel_id ?? other.channel_id))),
      model: String(row.model_name || ""), group: String(row.group || ""),
      status: Math.max(0, Math.trunc(num(other.status_code))),
      reason: classifyError(other.status_code, other.error_code),
      attempt: attemptOf(other),
    };
    const key = errorBucketKeyOf(bucket);
    const target = into.get(key) || { ...bucket, count: 0 };
    target.count += 1;
    into.set(key, target);
  }
  return into;
}
