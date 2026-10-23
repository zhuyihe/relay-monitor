// 提醒规则和通知方式前后端共用的东西（design/ui-copy-spec.md §12）：不带 node 依赖，告警中心页面、db/store.js、lib/alerts.js 都从这里取。

// 提醒规则（§11 规则名），只有这一张表。库里存着的键不能改名：
// ev 是事件键（rules.channelsFor 的键，每种提醒单独选发到哪些通知方式），key 是开关（rules 的字段），
// state 是对应的余额档位（alertState.state 的值，lib/alerts.js 的 stateOf），text 是规则名在 lib/format.js BALANCE_STATE_TEXT 里的键。
// 「恢复正常」不是余额档位，规则名写在告警中心的 copy.ts；快用完不对应档位（state 为 null）。
export const ALERT_RULES = Object.freeze([
  Object.freeze({ ev: "low", key: "onLow", state: "warn", text: "low" }),
  Object.freeze({ ev: "exhaust", key: "onExhaust", state: "danger", text: "empty" }),
  Object.freeze({ ev: "error", key: "onError", state: "error", text: "unreadable" }),
  Object.freeze({ ev: "recover", key: "onRecover", state: "ok", text: null }),
  Object.freeze({ ev: "eta", key: "onEta", state: null, text: "soon" }),
]);

export const ALERT_EVENT_KEYS = Object.freeze(ALERT_RULES.map((rule) => rule.ev));
export const ALERT_RULE_KEYS = Object.freeze(ALERT_RULES.map((rule) => rule.key));

// 余额档位（warn / danger / error / ok）对应的那条规则；没有对应的返回 null
export const alertRuleOfState = (state) => ALERT_RULES.find((rule) => rule.state === state) || null;
// 事件键对应的那条规则；认不出的返回 null
export const alertRuleOfEvent = (ev) => ALERT_RULES.find((rule) => rule.ev === ev) || null;

export const DEFAULT_RULES = {
  onLow: true, // 余额低于余额提醒线
  onExhaust: true, // 余额用完
  onError: true, // 读不到余额
  onRecover: true, // 恢复正常
  onEta: true, // 快用完：可用天数在提醒天数以内
  etaDays: 3, // 提醒天数（统一按天存，可以是小数）
  etaUnit: "days", // 告警中心显示的单位：days | hours
  renotifyHours: 24, // 同一件事一直没好时，每隔几小时再提醒一次（0 = 只提醒一次）
  errorThreshold: 1, // 连续读不到几次才提醒（1 = 第一次读不到就提醒）
  errorRetrySec: 30, // 读不到余额后隔几秒马上再读一次（0 = 不再读，等下次自动刷新）
  // 每种提醒发到哪些通知方式（id 列表）；空数组 = 所有启用的通知方式（和日报的 channelIds 一样）
  channelsFor: { low: [], exhaust: [], error: [], recover: [], eta: [] },
};

// 重新标记「不再续费」时开启一轮新的单次提醒：清掉单次提醒的发出时间和它那件事的记录（lib/alerts.js），其他记录不动。
// db/store.js 改设置时、lib/alerts.js 发现发送期间改了设置时都用这一个
export function resetNoRenewalAlertState(state) {
  if (!state) return state;
  const { noRenewalLowNotifiedAt, ...next } = state;
  // #42 存的旧格式，只有一份
  if (next.pendingDelivery?.kind === "noRenewalLow") delete next.pendingDelivery;
  if (next.incidents?.noRenewalLow) {
    const { noRenewalLow, ...rest } = next.incidents;
    if (Object.keys(rest).length) next.incidents = rest;
    else delete next.incidents;
  }
  return next;
}

// 通知方式没起名字时的名字（§3.1：不写「未命名渠道」）
export const UNNAMED_CHANNEL = "未命名通知方式";
