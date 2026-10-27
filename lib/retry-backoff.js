// 失败后的退避，自动开始（channel-profit.js）和重新分组（reconciliation.js）共用一套：第一次失败等 minMs，之后每次翻倍，最多 maxMs；
// 成功了删掉记录。状态放在调用方给的 Map 里（进程内，重启清零），key 由调用方定。
export const RETRY_BACKOFF_MIN_MS = 10 * 60 * 1000;
export const RETRY_BACKOFF_MAX_MS = 60 * 60 * 1000;

// 这个 key 现在还在退避里（没到下次可以试的时刻）吗
export function retryBlocked(backoff, key, at) {
  return (backoff.get(key)?.nextAt ?? 0) > at;
}

// 记一次失败，返回这一次要等多久（毫秒）
export function recordRetryFailure(backoff, key, at, { minMs = RETRY_BACKOFF_MIN_MS, maxMs = RETRY_BACKOFF_MAX_MS } = {}) {
  const previous = backoff.get(key)?.delayMs ?? minMs / 2;
  const delayMs = Math.min(maxMs, previous * 2);
  backoff.set(key, { nextAt: at + delayMs, delayMs });
  return delayMs;
}
