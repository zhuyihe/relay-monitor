// （换 Key 怎么记、怎么算：server/reconciliation.js 的 keyAgentRoundFor；每天用过的 Key：reconciliation_rule_day_keys）
// 例外三（design/ux/binding-flow.md §2）：读取服务连续拿不到新结果，几次以后才算「需处理」。计次本身在
// server/key-agent-identify.js 的 keyAgentReachability 里（按真的检查次数记，不按调用次数记）；这里只管
// 「这个次数该挂哪个码」：没到门槛是「实时·还在读取」（KEY_AGENT_UNAVAILABLE），到了门槛升成需处理（KEY_READER_UNREACHABLE）
export const KEY_READER_UNREACHABLE_THRESHOLD = 3; // 连续 3 次，读取服务按分钟轮询时约等于 binding-flow.md 说的「连续 10 分钟」
// 地址不是 https、令牌被读取服务拒了（401）：等不来自己好，第一次就升成需处理，提示怎么改；其余读不到按连续次数
const CONFIG_WRONG = new Set(["KEY_AGENT_URL_INVALID", "KEY_AGENT_UNAUTHORIZED"]); // 挂自己的码，提示分别改地址、改令牌
export function keyAgentExceptionIssueOf(reachability) {
  if (!reachability || reachability.consecutiveFailures <= 0) return null;
  if (CONFIG_WRONG.has(reachability.lastCode)) return reachability.lastCode;
  return reachability.consecutiveFailures >= KEY_READER_UNREACHABLE_THRESHOLD ? "KEY_READER_UNREACHABLE" : "KEY_AGENT_UNAVAILABLE";
}
