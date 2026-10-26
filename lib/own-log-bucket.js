// 自营站点整站消费日志按「小时 × 渠道 × 模型 × 上游模型 × 分组 × 缓存口径」分桶（应付成本 V1-a，计划 v1-plan 第 3 节）。纯函数，不引 node: 模块。
// 一行日志进一个桶，桶里的数都是加起来的：请求数、各种 Token、自营额度，再多两列「管理员自用额度」「不在管理员名下的渠道测试额度」——
// 它们就是 R1 要从渠道收入里扣掉的两样，所以桶对得上 R1（V1 先只对账，不替换 R1）。
// 缓存口径：日志 other 里 usage_semantic 是 anthropic 的，prompt_tokens 不含缓存；别的（openai 口径）prompt_tokens 含缓存读，算应付成本时要减掉。
// 桶按 UTC 整点切：天界线是整点的时区（上海、纽约、洛杉矶……）可以从小时桶重组；不是整点的时区（印度等）重组不了，V1-b 写「—」。
export const OWN_LOG_SLOT_MS = 3600000;

const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const OWN_TEST_TOKEN_NAMES = ["模型测试", "Model test"];

export function parseLogOther(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

export const bucketKeyOf = (b) => JSON.stringify([b.slotMs, b.channelId, b.model, b.upstreamModel, b.group, b.semantic]);

/**
 * rows：/api/log/ 的 items（type 2）。adminSet：管理员用户名；resoldKeys：[{ username, tokenName }]，转售的管理员 Key 照算收入，不进管理员自用。
 * 返回 Map(key → 桶)；每个桶：{ slotMs, channelId, model, upstreamModel, group, semantic, requests, promptTokens, completionTokens,
 * cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens, quota, adminQuota, testQuota }。
 */
export function accumulateBuckets(rows, { adminSet = new Set(), resoldKeys = [] } = {}, into = new Map()) {
  const resold = new Set(resoldKeys.map((key) => `${String(key.username).toLowerCase()}\u0000${String(key.tokenName).toLowerCase()}`));
  for (const row of rows || []) {
    if (Number(row?.type) !== 2) continue;
    const at = num(row.created_at), channelId = num(row.channel ?? row.channel_id);
    if (!(at > 0) || !(channelId > 0)) continue;
    const other = parseLogOther(row.other);
    const bucket = {
      slotMs: Math.floor(at * 1000 / OWN_LOG_SLOT_MS) * OWN_LOG_SLOT_MS, channelId,
      model: String(row.model_name || ""), upstreamModel: other.is_model_mapped && other.upstream_model_name ? String(other.upstream_model_name) : "",
      group: String(row.group || ""), semantic: other.usage_semantic === "anthropic" || other.claude === true ? "anthropic" : "openai",
    };
    const key = bucketKeyOf(bucket);
    const target = into.get(key) || { ...bucket, requests: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, quota: 0, adminQuota: 0, testQuota: 0 };
    const quota = num(row.quota);
    target.requests += 1;
    target.promptTokens += num(row.prompt_tokens);
    target.completionTokens += num(row.completion_tokens);
    target.cacheReadTokens += num(other.cache_tokens);
    target.cacheWriteTokens += num(other.cache_creation_tokens);
    target.cacheWrite1hTokens += num(other.cache_creation_tokens_1h);
    target.quota += quota;
    const user = String(row.username ?? "");
    const isAdmin = adminSet.has(user);
    if (isAdmin && !resold.has(`${user.toLowerCase()}\u0000${String(row.token_name ?? "").toLowerCase()}`)) target.adminQuota += quota;
    else if (!isAdmin && num(row.token_id) === 0 && OWN_TEST_TOKEN_NAMES.includes(String(row.token_name ?? ""))) target.testQuota += quota;
    into.set(key, target);
  }
  return into;
}
