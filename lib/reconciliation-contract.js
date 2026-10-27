import { businessTimeZone, sameTimeZone, shiftedDayStartInTz } from "./business-time.js";

export const RECONCILIATION_BILLING_SOURCE = "channel-log-stat";
export const RECONCILIATION_CALCULATION_VERSION = 3;

// 截至查询时刻的窗口（今天、近 7 天、本月）：起点固定、终点随查询时刻后移，同一起点的记录算同一窗口。
// 放在这里而不是 reconciliation-snapshot.js：那个模块引用了 node:crypto，客户端（核算页轮询）不能引入。
const LIVE_RECONCILIATION_PRESETS = Object.freeze(["today", "7d", "month"]);
// 上游账单在自然日结束后还会陆续入账，结束满这么久才结账；没满之前这天还算实时。
export const RECONCILIATION_SETTLE_DELAY_MS = 15 * 60000;
export function isLiveReconciliationPreset(preset) {
  return LIVE_RECONCILIATION_PRESETS.includes(preset);
}

// 两段对账窗口是不是同一段，全站只用这一个判断（页面、服务端、两个仓库）：
// - 起点相同；
// - timezone：默认时区名也要相同；"canonical" 时别名算同一个（上游回填的是规范写法）；false 时不比时区；
// - asRequested：为真并且有一边是今天、近 7 天、本月时，截止点随取数时刻走，只比预设；其余情况比终点。
// 仓库的 selectLatestRecord（旧记录还能不能用）和页面的 sameRange（页面自己选的范围）不是相等判断，不用它。
export function sameReconciliationWindow(a, b, { timezone = true, asRequested = false } = {}) {
  if (!a || !b || a.startMs !== b.startMs) return false;
  if (timezone === "canonical" ? !sameTimeZone(a.timezone, b.timezone) : timezone && a.timezone !== b.timezone) return false;
  return asRequested && (isLiveReconciliationPreset(a.preset) || isLiveReconciliationPreset(b.preset)) ? a.preset === b.preset : a.endMs === b.endMs;
}

// 每个系统码在界面上怎么说：唯一来源是 design/ui-copy-spec.md §5，码本身不上界面。
// kind 决定这天显示成哪种状态（§4）：
//   action  需处理：不处理就算不准。title 是标题，detail 是说明。
//   reading 读取类：系统会自己重读。今天和过去 7 天内显示「实时」加 hint；过了 7 天还没读到，才按 title 变成需处理。
//   hint    提示类：不改变状态。hint 是一句提示，tag 是渠道名旁的小标签，ratio 写在倍率格里；display: false 不显示。
// 文案里的 {time} {start} {channel} 由调用方填，填不上时用 plain 那一句。
// action 是按钮对应的动作，见 lib/workflow-actions.js。
// push 表示会推送提醒：A3 统一推送规则之前，仍只推送原来这几种。
// 「去回答」问的那一句，问题标题和填写处的问题共用（§5.2）。
export const COVERAGE_QUESTION = "这把 Key 还给别处用吗？";
// 没回答就绑定、测试读取时那句（§8.2）：渠道绑定抽屉和服务端报错共用
export const COVERAGE_REQUIRED = `请回答「${COVERAGE_QUESTION}」`;
// 旧码和以前的每日记录里没读全的一天，都说这一句（§5.5）。
export const INCOMPLETE_DAY_TEXT = "这天的数据不完整";
// 对方的版本不支持（§8.2）：error-copy 和需处理共用这一句
export const FEATURE_UNSUPPORTED_TEXT = "对方的版本不支持这项功能";
const UNFINISHED = Object.freeze({ kind: "reading", hint: INCOMPLETE_DAY_TEXT, title: INCOMPLETE_DAY_TEXT, action: "retry_bill" });
const OWNER_UNVERIFIED = Object.freeze({ kind: "action", title: "还没确认这把 Key 属于哪个上游账号", detail: "测试读取一次就好", action: "verify_identity" });
// RESETTLE_SHRUNK 说明里的 {what}：少的是哪样（状态行 detail.shrunk.side 记 revenue / cost / both，见 lib/reconciliation-settlement.js 的 resettleShrunkInfo）；
// 不知道是哪样（旧行、没记）时写「收入或上游成本」
export const RESETTLE_SHRUNK_WHAT = Object.freeze({ revenue: "收入", cost: "上游成本", both: "收入和上游成本" });
export const resettleShrunkWhat = (side) => RESETTLE_SHRUNK_WHAT[side] || "收入或上游成本";
export const resettleShrunkDetail = (side) => fillIssueCopy(ISSUES.RESETTLE_SHRUNK.detail, "", { what: resettleShrunkWhat(side) });
// 令牌少了权限、令牌作废的几句：页面、需处理、推送共用这一份（用语规范 §5.2、§10），不各写各的
const TOKEN_LACKING = "令牌少了";
export const ACCESS_TOKEN_SCOPE_FIX = "给令牌补上这项权限，或者换一个带这项权限的令牌";
const ISSUES = Object.freeze({
  KEY_INVALID_OR_DENIED: { kind: "action", title: "上游拒绝读取这把 Key", detail: "Key 可能已被删除，或上游的登录信息过期了", action: "update_authorization", push: true },
  // 新式访问令牌（用语规范 §5.2）：要人换令牌，马上进需处理，自营站点、每个上游各一条，不等 7 天，也不再说成「登录信息不对」「上游拒绝读取这把 Key」「暂时读不到」。
  // {subject}「自营站点」或「上游「X」」、{scopes}新令牌要勾的权限、{scope}New API 说少了的那一项，由 lib/reconciliation-view.js 的 issueParams 填；
  // 填不上时用 plain / detailPlain。权限清单只在 lib/access-token-scopes.js 一处
  // 两个新码过渡期带推送，和 KEY_INVALID_OR_DENIED 一样，随 E 一起去掉（总指挥 10-25：日报里还没有「需处理」那一行，推送是唯一会主动告诉用户令牌坏了的地方）
  ACCESS_TOKEN_LEGACY_RETIRED: { kind: "action", title: "{subject}的访问令牌已经作废了", plain: "访问令牌已经作废了",
    detail: "New API 升级以后旧式的访问令牌不能用了，要换一个新令牌（nap_ 开头），并勾上这些权限：{scopes}", action: "update_authorization", push: true },
  // 标题按拿得到的东西分三档：上游名和少的那一项都有「上游「X」的令牌少了「s」的权限」；只有名字「…的令牌少了权限」（{lost} 是「「s」的权限」或「权限」）；
  // 名字都没有就用 plain「令牌少了权限」。说明也两种：知道少的是哪一项，和 New API 没说时让人照清单勾（detailPlain，{scopes} 这一侧的清单）
  ACCESS_TOKEN_SCOPE_DENIED: { kind: "action", title: `{subject}的${TOKEN_LACKING}{lost}`, plain: `${TOKEN_LACKING}权限`,
    detail: `「{scope}」是 New API 说少了的那一项。${ACCESS_TOKEN_SCOPE_FIX}`,
    detailPlain: "New API 没说少的是哪一项。给令牌勾上这些权限：{scopes}，或者换一个带这些权限的令牌", action: "update_authorization", push: true },
  // 自营站点不记收费记录（用语规范 §5.2、§4 的例外；own-revenue-plan 第二节）：
  // OFF 是现在还关着（窗口碰到了还没开回来的那一段）：渠道的收入读不到，利润先不算，按钮「重新检查」；
  // GAP 是已经开回来了、但这一天碰到过关着的那一段：那段的收入补不回来，这一天永远不固定（persists，reasonKindOf 读成 sticky），没有按钮，不进需处理清单；
  // OPTION_READ_DENIED 是令牌读不到设置（少了 option:read，或账号不是超级管理员）：发现不了站点不记收费记录了，每天的状态不变、照常固定，
  // 不进每条绑定的问题，只在站点这一层说一句（设置自营站点抽屉、需处理清单），{reason} 分两种由 lib/reconciliation-view.js 的 issueParams 不填：说明按「不是超级管理员只写后半句」在这里写成两句。
  OWN_CONSUME_LOG_OFF: { kind: "action", title: "自营站点不记收费记录了",
    detail: "自营站点不记收费记录时，渠道的收入读不到，利润先不算。在自营站点后台打开：系统设置 → 运维 → 日志维护 →「记录配额使用量」（旧版界面是：运营设置 → 日志设置 →「启用额度消费日志记录」）。打开以前那段时间的收入补不回来。",
    action: "recheck_consume_log" },
  OWN_CONSUME_LOG_GAP: { kind: "action", title: "这一天自营站点有一段没记收费记录，那段的收入补不回来", persists: true, action: "consume_log_gap" },
  // 换 Key 冲突（分组、合组、认不出、读不了完整 Key）自己解开、渠道回到原来的 Key 以后，冲突那几天另一把 Key 的用量没进过任何一条绑定：永远不固定，和上面一样写「—」加这一句，
  // 没有按钮，不进需处理清单，不算进汇总（用户 10-25 定自营站点那一种，总指挥 10-27 定这一种）。{days}、{day}：一天写「一天」「天」，几天写「几天」「几天」；几天时说明里写是哪几天（{dates}）
  KEY_CONFLICT_GAP: { kind: "action", title: "这{days}几个渠道换了 Key，分不清哪把 Key 的钱该算给哪个渠道，这{day}没算", plain: "换 Key 分不清，这天没算",
    detail: "没算的是 {dates}", detailPlain: "", persists: true, action: "key_conflict_gap" },
  // 近 7 天、本月这类多天窗口碰到已经开回来的那一段：碰到的那几天不算，其余照算，这一行加这一句（和等式下面那句同一份）
  // 近 7 天、本月这类多天窗口碰到换 Key 冲突期：碰到的几天不算，其余照算，这一行加这一句（和上一条同一个做法）
  KEY_CONFLICT_GAP_PARTIAL: { kind: "hint", hint: "这段时间里有几天几个渠道换了 Key，分不清哪把 Key 的钱该算给哪个渠道，那几天没算进来" },
  OWN_CONSUME_LOG_GAP_PARTIAL: { kind: "hint", hint: "这段时间里自营站点有一段没记收费记录，那段的收入补不回来" },
  OWN_OPTION_READ_DENIED: { kind: "action", title: "自营站点的令牌读不到设置",
    detail: "发现不了自营站点不记收费记录了。给令牌补上「读设置」的权限，或者换超级管理员的访问令牌。", detailPlain: "发现不了自营站点不记收费记录了。换超级管理员的访问令牌。",
    action: "update_authorization" },
  SOURCE_BINDING_UNCONFIRMED: { kind: "action", title: "上游账号或自营站点有变化", detail: "确认这条绑定还对应原来的账号和渠道，利润才会接着算", action: "review_source" },
  COST_OWNER_UNVERIFIED: OWNER_UNVERIFIED,
  LEGACY_IDENTITY_UNVERIFIED: OWNER_UNVERIFIED,
  UPSTREAM_CAPABILITY_UNVERIFIED: { kind: "action", title: "还没确认能读到这个上游的完整账单", detail: "测试读取一次就好", action: "verify_capability" },
  BILLING_TIMEZONE_UNVERIFIED: { kind: "action", title: "还没确认这个上游按哪个时区算一天", detail: "测试读取一次就好", action: "verify_capability" },
  // 对方的版本少了算账要用的东西（比如 Key 目录不带 user_id，认不出 Key 属于哪个账号）：不会自己好，要人处理（§5.2、§8.2 同一句）
  UPSTREAM_FEATURE_UNSUPPORTED: { kind: "action", title: FEATURE_UNSUPPORTED_TEXT, action: "view_detail" },
  CANONICAL_KEY_CONFLICT: { kind: "action", title: "这把 Key 绑了两次", detail: "同一把 Key 的上游成本只能算一次，去掉多余的那条", action: "review_conflict" },
  DUPLICATE_CHANNEL_ASSIGNMENT: { kind: "action", title: "渠道「{channel}」同时绑了两把 Key", plain: "有渠道同时绑了两把 Key", detail: "同一个渠道的收入只能算一次，去掉多余的那条", action: "review_conflict" },
  // 改了切换时间重算（C2b）：不自动再试，等人点「重新读取」确认（persists：不自动重试、也不重判，见 lib/reconciliation-settlement.js 的 reasonKindOf）
  RESETTLE_SHRUNK: { kind: "action", title: "这天重算的数比原来少了一半多", detail: "重算出来的{what}不到原来的一半，可能是记录没读全，所以先没换掉，现在显示的还是原来的数。确认重算的数没错，再重新读取", action: "retry_bill", persists: true },
  RESETTLE_TOO_OLD: { kind: "action", title: "改了时间的这天太早，没自动重算", detail: "这天在 31 天以前，上游和自营站点的记录可能已经清掉了，重算的数会偏少，所以系统没自动重算，现在显示的还是改之前的数。要按新的时间算，就重新读取", action: "retry_bill", persists: true },
  // 改了切换时间的重算请求 7 天还没成就放弃（R6）：不自动再试，页面上还是改之前的数，点「重新读取」再算。不存进状态行的原因栏，由请求时刻和 7 天推出来
  RESETTLE_NOT_DONE: { kind: "action", title: "改了时间的这天没重算成", detail: "现在显示的还是改之前的数；重新读取一次再算", action: "retry_bill" },
  // 过去的日子 7 天还没固定（C①）：系统不再自动读了，不是读取类
  SETTLE_LOOKBACK_EXPIRED: { kind: "action", title: "这天一直没固定", detail: "系统不再自动读这天了；重新读取一次，读到了就会固定", action: "retry_bill" },
  COST_COVERAGE_UNKNOWN: { kind: "action", title: COVERAGE_QUESTION, detail: "别处也在用的话，上游成本会算多；回答之前，利润先不算", action: "confirm_coverage" },
  // K2b：读取服务连续拿不到新结果（例外三，k-plan §6；连续 3 次、约 10～15 分钟才出现，不按天重复）
  // push 这张单子是关着的（§5.2 过渡期那几种，随 E 去掉），这里不再加新的
  KEY_READER_UNREACHABLE: { kind: "action", title: "读不到你站的渠道 Key", plain: "读不到你站的渠道 Key",
    detail: "从 {time} 起各渠道的利润先不算；连上以后接着算", detailPlain: "连上以后接着算", action: "check_connection" },
  // K2b：渠道换成了一把不在已加上游里的 Key（流程稿例外一）
  CHANNEL_KEY_UNMATCHED: { kind: "action", title: "渠道「{channel}」用的 Key 不在已加的上游里", plain: "有渠道用的 Key 不在已加的上游里",
    detail: "从 {time} 起这个渠道的上游成本算不出；把这把 Key 所在的上游加进来就能算。只填了一把 Key 的上游：如果是这个上游换了 Key，在上游列表里改这个上游的 Key",
    detailPlain: "把这把 Key 所在的上游加进来就能算", action: "add_upstream" },
  // K2a 的 reveal（打码撞了、没有 api_key:reveal 权限）；K2b 把 revealIssues 接进需处理用这个码，和别的「令牌少了权限」同一个动作
  KEY_REVEAL_DENIED: { kind: "action", title: "上游的令牌少了读完整 Key 的权限", plain: "上游的令牌少了读完整 Key 的权限",
    detail: "有两把 Key 分不清，从 {time} 起这个渠道的上游成本算不出；给令牌补上「读取完整 Key」的权限，或者换一个带这项权限的令牌",
    detailPlain: "给令牌补上「读取完整 Key」的权限，或者换一个带这项权限的令牌", action: "update_authorization" },

  // K2b：读取服务连不上/读不到新结果（例外三 k-plan §6，含带 X-Agent-Stale 的）：会自己好的那一类，连续 3 次（约 10~15 分钟）
  // 才升成需处理 KEY_READER_UNREACHABLE，不到这个次数先按这条（实时·还在读取）
  KEY_AGENT_UNAVAILABLE: { kind: "reading", hint: "读取服务暂时读不到，系统会自动再读", title: "读不到你站的渠道 Key", action: "check_connection" },
  // K2b：这条绑定这组渠道现在用的 Key 和原来绑的不是同一套了（分组或合组，k-plan §3.3）：留给 K2c 处理渠道怎么分组，
  // K2b 这一版先不结账、不写段，宁可这几天先不算，也不把钱算错（决定记录：划这条线的理由见 PR #133 说明）。
  // 不给「重新读取」：点了也算不出来，会让人以为自己能修；按钮是「查看详细原因」，打开的计算明细写清是分组还是合组。
  // design/ui-copy-spec.md §5.3「7 天以后系统不再自动读、要人点一下的」表；标题不带渠道名，
  // 清单里对象名另起、加粗写在标题前面（两个渠道「「高速 A」「备用 B」」，三个以上「「高速 A」等 3 个渠道」）
  KEY_GROUP_CHANGED: { kind: "reading", hint: "还在读取", title: "换了 Key，系统还没重新分组", plain: "有渠道换了 Key，系统还没重新分组",
    detail: "从 {time} 起，这几个渠道用的 Key 变了（原来共用一把的不再共用，或者原来各用各的、现在用了同一把），系统还没按新的分法算，这几天的利润先不算。更新控制台以后会自己补上；等不及的，把详细原因发给技术同事",
    detailPlain: "系统还没按新的分法算，这几天的利润先不算；更新控制台以后会自己补上，等不及的把详细原因发给技术同事", action: "view_detail" },
  // 结账前的 Key 占用检查（server/reconciliation.js 的 keyOccupancyProblems）：这一天用到的某把 Key，在几条绑定里认领的时间段重叠（上游成本会算两遍），先不固定这天。
  // 只拦重叠，空档只写服务日志（总指挥 10-27 定）。要人处理的一类：一结束、查出重叠就进需处理，不先显示「还在读取」，7 天后也不转成「这天一直没固定」；
  // 不给「重新读取」（点了也一样）；每一轮先做本地的占用检查，过不了就不去读上游，哪天修好了重叠、检查一过照常固定，字里不承诺这一点。
  // 按钮「复制详细原因」（设计 10-27）：复制的是「详细原因」那几行纯文本，开头带站点名和日期；Key、时段、渠道直接写进说明，几段时说明里写第一段、接「等 3 段」，全的放在详细原因里
  KEY_USE_MISMATCH: { kind: "action", title: "这天有把 Key 被两个渠道都算了，先没固定", plain: "有把 Key 被两个渠道算了，这天没固定",
    detail: "Key「{key}」{when} {span}，{names}都算了它的钱。为了不把这段成本算两遍，这天先没固定。不是你设置的问题，把详细原因复制下来发给技术同事。",
    detailPlain: "有一把 Key 在同一段时间被两个渠道都算了，为了不把这段成本算两遍，这天先没固定。不是你设置的问题，把详细原因复制下来发给技术同事。", action: "copy_detail" },
  // Sub2API 换手那天要一条条读用量记录才分得开（k-plan 3.5）：上游限制读的速度（每个账号每分钟 20 页），一天记录很多时一轮翻不完，下一轮接着翻（读取类，会自己好）；
  // 结束满 3 天还没翻完就转成需处理 UPSTREAM_RECORDS_TOO_MANY，系统不再自动读，用户点「重新读取」再试一次（总指挥 10-27 定，设计出的字）。
  // 标题前面照 E 写对象（Key 名）；{time} 是换手的那一刻（读不到时写没有时刻的那句 detailPlain）
  UPSTREAM_RECORDS_PENDING: { kind: "reading", hint: "这天的用量记录还没读完，系统会接着读", action: "retry_bill" },
  UPSTREAM_RECORDS_TOO_MANY: { kind: "action", title: "这天的用量记录太多，没读完", plain: "这天的用量记录太多，没读完",
    detail: "这把 Key 在 {time} 换过渠道，那天要一条条读用量记录才能分开，可上游限制了读的速度，读了 3 天还没读完，系统先停了。那天这几个渠道的利润先不算。点「重新读取」，系统会再接着读一个小时，读完自己固定；常碰到的话，请上游放宽读取次数的限制。",
    detailPlain: "这把 Key 这天换过渠道，要一条条读用量记录才能分开，可上游限制了读的速度，读了 3 天还没读完，系统先停了。那天这几个渠道的利润先不算。点「重新读取」，系统会再接着读一个小时，读完自己固定；常碰到的话，请上游放宽读取次数的限制。",
    persists: true, action: "retry_bill" },
  PENDING: { kind: "reading", hint: "读取中", title: "这天的账单一直没读到", action: "retry_bill" },
  WAITING_FOR_BILL: { kind: "reading", hint: "这天的账单还没读全", title: "这天的账单一直没读全", action: "retry_bill" },
  HISTORY_UNAVAILABLE: { kind: "reading", hint: "固定账暂时读不到，请稍后重新读取", title: "固定账一直读不到，请重新读取", action: "retry_bill" },
  UPSTREAM_DATA_UNAVAILABLE: { kind: "reading", hint: "上游暂时读不到，系统会自动再读", title: "上游这天的用量记录一直读不到", action: "retry_bill", push: true },
  OWN_BILLING_UNAVAILABLE: { kind: "reading", hint: "自营站点暂时读不到，系统会自动再读", title: "自营站点这天的收费记录一直读不到", action: "retry_bill", push: true },
  // 自营站点的设置（收费记录的开关在里面）读不到——5xx、超时、限流这类会自己好的，收费记录本身读得到（R2 审核第二轮中-1）：
  // 结账先等一等（这天结束后读到过开着、或者连续读不到超过 24 小时就照常固定）；超过 24 小时站点这一层进需处理，按钮「重新检查」
  OWN_OPTION_UNREADABLE: { kind: "reading", hint: "自营站点的设置暂时读不到，系统会自动再读", title: "自营站点的设置一直读不到",
    detail: "一天多读不到自营站点的设置，看不出它还记不记收费记录。利润照常算；要是这段时间里收费记录关过，那段的收入会算少。自营站点恢复以后这一条会自己消失。",
    action: "recheck_consume_log", push: true },
  // 上游、自营站点哪一侧都可能对不上，不写「上游」
  BILLING_WINDOW_MISMATCH: { kind: "reading", hint: "读到的日期和这天对不上，系统会再读", title: "读到的日期一直和这天对不上", action: "retry_bill" },
  UPSTREAM_EMPTY_WITH_SALES: { kind: "reading", hint: "有收入，但上游的用量还没到", title: "有收入，但上游一直没有用量记录", detail: "可能绑错了 Key", action: "edit_binding" },
  PERSISTENCE_FAILED: { kind: "reading", hint: "这次结果没存上，系统会再存", title: "这天的结果一直没存上", action: "retry_bill", push: true },
  // 现在不会再产生的旧码（§5.5）：以前的数据里还带着时，统一说这天的数据不完整。
  STALE: UNFINISHED,
  GROUP_OR_RATIO_CHANGED: UNFINISHED,
  BILLING_WINDOW_UNCONFIRMED: UNFINISHED,
  OWN_FLOW_INCOMPLETE: UNFINISHED,

  READY: { kind: "hint", display: false },
  ROUTE_TRANSITION_DETECTED: { kind: "hint", hint: "倍率在 {time} 变了，这天分两段算", plain: "倍率变了，这天分两段算" },
  SEGMENT_TIMING_UNCONFIRMED: { kind: "hint", hint: "倍率变化的时间是系统估的", action: "correct_timing" },
  // K2b：换 Key 那天的一句提示（§5.4）；整句由 lib/reconciliation-view.js 的 reconciliationKeyChange 拼（今天/过去的日子、倍率一起变、换的时刻定不出三种写法）。
  // 不给「改时间」：换 Key 的那一刻是系统读到的，不让人改（流程梳理稿第 3 节）
  KEY_CHANGED: { kind: "hint", hint: "{keyChange}", plain: "换了 Key" },
  BILLING_SCOPE_NOT_EFFECTIVE: { kind: "hint", hint: "从 {start} 开始统计", plain: "还没开始统计" },
  SALES_CHANNEL_MISSING: { kind: "hint", tag: "已删除", hint: "渠道「{channel}」在自营站点里已删除，不用了就从绑定里去掉", plain: "有渠道在自营站点里已删除，不用了就从绑定里去掉", action: "edit_binding", push: true },
  SALES_CHANNEL_DISABLED: { kind: "hint", tag: "已停用" },
  SALES_CHANNEL_STATE_UNKNOWN: { kind: "hint", display: false },
  GROUP_DATA_UNAVAILABLE: { kind: "hint", ratio: "暂时读不到" },
});

// 同一条绑定有多个问题时，只露出最靠前的一条；服务端的 health.code 也按这个顺序取。
// 先排要人动手的（§5.2），再排读取类（§5.3），最后排提示类（§5.4），和页面上「需处理优先」一致（§4）。
// 现在不会再产生的旧码排在读取类末尾，以前的数据里还带着时照样能排上。
export const RECONCILIATION_ISSUE_PRIORITY = Object.freeze([
  "ACCESS_TOKEN_LEGACY_RETIRED", "ACCESS_TOKEN_SCOPE_DENIED", "OWN_CONSUME_LOG_OFF", "OWN_CONSUME_LOG_GAP", "KEY_CONFLICT_GAP", "OWN_OPTION_READ_DENIED", "KEY_INVALID_OR_DENIED", "KEY_READER_UNREACHABLE", "LEGACY_IDENTITY_UNVERIFIED", "SOURCE_BINDING_UNCONFIRMED", "COST_OWNER_UNVERIFIED", "CANONICAL_KEY_CONFLICT",
  "DUPLICATE_CHANNEL_ASSIGNMENT", "BILLING_TIMEZONE_UNVERIFIED", "UPSTREAM_CAPABILITY_UNVERIFIED", "UPSTREAM_FEATURE_UNSUPPORTED", "COST_COVERAGE_UNKNOWN", "CHANNEL_KEY_UNMATCHED", "KEY_REVEAL_DENIED", "KEY_USE_MISMATCH",
  "RESETTLE_SHRUNK", "RESETTLE_TOO_OLD", "RESETTLE_NOT_DONE", "SETTLE_LOOKBACK_EXPIRED", "UPSTREAM_RECORDS_TOO_MANY", "HISTORY_UNAVAILABLE", "BILLING_WINDOW_MISMATCH", "UPSTREAM_RECORDS_PENDING", "WAITING_FOR_BILL", "UPSTREAM_DATA_UNAVAILABLE", "OWN_BILLING_UNAVAILABLE", "OWN_OPTION_UNREADABLE", "PERSISTENCE_FAILED",
  "KEY_AGENT_UNAVAILABLE", "KEY_GROUP_CHANGED",
  "UPSTREAM_EMPTY_WITH_SALES", "PENDING", "STALE", "GROUP_OR_RATIO_CHANGED", "BILLING_WINDOW_UNCONFIRMED", "OWN_FLOW_INCOMPLETE",
  "SALES_CHANNEL_MISSING", "SALES_CHANNEL_DISABLED", "SALES_CHANNEL_STATE_UNKNOWN", "GROUP_DATA_UNAVAILABLE",
  "ROUTE_TRANSITION_DETECTED", "KEY_CHANGED", "SEGMENT_TIMING_UNCONFIRMED", "BILLING_SCOPE_NOT_EFFECTIVE",
  "KEY_CONFLICT_GAP_PARTIAL",
  "OWN_CONSUME_LOG_GAP_PARTIAL", // 不带按钮的一句说明：排在带按钮的那几条后面，health.code 先给带按钮的（审核 R2 第二轮 低-4）
  "READY",
]);
// 表里没有的码（§5.5 兜底）：按需处理显示「这条暂时算不出利润」和「刷新」；码只写进浏览器控制台。
const UNKNOWN_ISSUE = Object.freeze({ kind: "action", title: "这条暂时算不出利润", action: "refresh", known: false });

export const RECONCILIATION_ISSUE_CODES = Object.freeze(Object.keys(ISSUES));

// 令牌问题一句话的「状态」：作废写「访问令牌已经作废了」，少了权限写「令牌少了「X」的权限」，不知道少哪一项写「令牌少了权限」（推送正文的「状态」行用）
export function accessTokenStatusText(code, scope = "") {
  const issue = reconciliationIssue(code);
  return code === "ACCESS_TOKEN_SCOPE_DENIED" && scope ? fillIssueCopy(`${TOKEN_LACKING}{lost}`, issue.plain, { lost: `「${scope}」的权限` }) : issue.plain;
}

export function reconciliationIssue(code) {
  // 只认表里自己的键：constructor、toString 这类原型链上的名字按不认识的码处理
  const entry = Object.hasOwn(ISSUES, code) ? ISSUES[code] : null;
  const priority = RECONCILIATION_ISSUE_PRIORITY.indexOf(code);
  return { ...(entry || UNKNOWN_ISSUE), code: String(code || ""), known: !!entry, priority: priority < 0 ? Infinity : priority, push: entry?.push === true };
}

// 填文案里的 {time} {start} {channel}；有一个填不上就用 plain，plain 也没有就不显示（返回空串）。
export function fillIssueCopy(text, plain, params = {}) {
  if (!text) return "";
  let missing = false;
  const filled = text.replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    if (value == null || value === "") { missing = true; return ""; }
    return String(value);
  });
  return missing ? plain || "" : filled;
}

// 服务端 health.label：只是一句给人看的话，界面不再读它，推送在 A3 改用同一张表之前沿用。
export function reconciliationIssueLabel(code) {
  const issue = reconciliationIssue(code);
  if (issue.kind === "reading") return issue.hint;
  if (issue.kind === "hint") return issue.display === false ? "" : issue.plain || fillIssueCopy(issue.hint, "", {}) || issue.tag || issue.ratio || "";
  return issue.plain || issue.title;
}

// 渠道列表里的状态（§5.6）。键是 deriveKnownChannelCoverage 给出的 status。
const CHANNEL_STATUS = Object.freeze({
  accounted: { label: "已算进利润", counted: true },
  bound: { label: "已绑定" },
  unlinked: { label: "没绑定", action: "connect_channels" },
  not_effective: { label: "从 {start} 开始统计", plain: "还没开始统计" },
  duplicate: { label: "需处理", needsAction: true },
  source_unverified: { label: "需处理", needsAction: true },
  coverage_unknown: { label: "需处理", needsAction: true },
  // 绑定那一行这天是需处理、渠道自己说不出原因时：原因和按钮取那一行的状态（lib/reconciliation-view.js 给 reason）
  row_attention: { label: "需处理", needsAction: true },
  billing_missing: { label: "还在读取" },
  monitor_only: { label: "只看余额" },
  unsupported: { label: "读不到账单" },
});

// issues 是渠道上的问题码：「需处理」时 reason 取最要紧的一条要处理的问题（§5.2），其余状态为空串。
export function reconciliationChannelStatus(status, params = {}, issues = []) {
  const entry = CHANNEL_STATUS[status] || { label: "需处理", needsAction: true };
  const issue = entry.needsAction ? issues.map(reconciliationIssue).filter((item) => item.kind === "action").sort((a, b) => a.priority - b.priority)[0] : null;
  return { ...entry, label: fillIssueCopy(entry.label, entry.plain, params) || entry.label, reason: issue ? fillIssueCopy(issue.title, issue.plain, params) : "" };
}

// 渠道汇总一句（§5.6）：「5 个渠道里 4 个已算进利润」，都算进了写「5 个渠道都已算进利润」；没有渠道时为空。
export function reconciliationCoverageText(coverage) {
  const known = Number(coverage?.knownChannelCount), accounted = Number(coverage?.accountedChannelCount);
  if (!Number.isFinite(known) || known <= 0 || !Number.isFinite(accounted)) return "";
  return accounted >= known ? `${known} 个渠道都已算进利润` : `${known} 个渠道里 ${accounted} 个已算进利润`;
}

// 「这把 Key 还给别处用吗？」的回答（§5.2「去回答」）：上游账单的改绑定、渠道绑定和接口校验共用这一张表。
// value 对应 CoverageDeclaration 的 answer 和 otherUse；只有 none 算「只给这些渠道用」，别的回答都先不算利润。
export const COVERAGE_ANSWERS = Object.freeze([
  { value: "none", answer: "none", otherUse: null, label: "只给这些渠道用" },
  { value: "own_channels", answer: "other_use", otherUse: "own_channels", label: "自营站点的其他渠道也在用" },
  { value: "external", answer: "other_use", otherUse: "external", label: "站外也在用（测试、自用、给别人）" },
  { value: "unspecified", answer: "other_use", otherUse: "unspecified", label: "别处也在用，说不清是哪" },
  { value: "unknown", answer: "unknown", otherUse: null, label: "不确定" },
]);

// 这条绑定要不要回答「这把 Key 还给别处用吗？」：没答成「只给这些渠道用」，上游成本可能算多，要人回答（§5.2 去回答）。
// 只有这一处判断，每日利润那一行、汇总、渠道绑定、上游账单「去回答」都调它。costBasis 用 costBasisOf（lib/profit.js）或结果里记下的成本计法。
// 不用回答的：固定成本的上游（成本记 0，答什么都不影响利润）；旧规则（legacy-v3，不是 isScopedBillingPolicy），照每日利润一直以来的做法。
// 旧规则这条分支等 C 按生产核实（C-3）再定，没有旧规则了就删掉
// 没存回答的旧对象按 costCoverage 推（和 normalizeRuleSourceBinding 一样：complete 就是「只给这些渠道用」）
export function coverageNeedsAnswer(rule, costBasis) {
  const answer = rule?.coverageDeclaration?.answer ?? (rule?.costCoverage === "complete" ? "none" : "unknown");
  return costBasis !== "fixed" && isScopedBillingPolicy(rule?.billingPolicy) && (rule?.costCoverage !== "complete" || answer !== "none");
}

// 一份回答在表里的那一项；answer 为 other_use 时按 otherUse 找，没有 otherUse 的按「说不清是哪」。
export function coverageAnswerOption(declaration) {
  const answer = declaration?.answer;
  if (answer === "other_use") return COVERAGE_ANSWERS.find((item) => item.otherUse === (declaration.otherUse || "unspecified")) || null;
  return COVERAGE_ANSWERS.find((item) => item.answer === answer && item.otherUse === null) || null;
}

// 选中的一项 → 要保存的回答；「自营站点的其他渠道也在用」时带上是哪几个渠道。
export function coverageDeclarationOf(value, uncoveredOwnChannelIds = []) {
  const option = COVERAGE_ANSWERS.find((item) => item.value === value);
  if (!option) return null;
  return { answer: option.answer, otherUse: option.otherUse,
    uncoveredOwnChannelIds: option.otherUse === "own_channels" ? [...new Set(uncoveredOwnChannelIds.map(Number))] : [] };
}

export function isCurrentReconciliationBillingContract(source) {
  const billingSource = source?.billingSource ?? source?.downstream?.billingSource;
  const calculationVersion = Number(source?.calculationVersion ?? source?.downstream?.calculationVersion);
  return billingSource === RECONCILIATION_BILLING_SOURCE
    && calculationVersion === RECONCILIATION_CALCULATION_VERSION;
}

// 早期的成功记录只存了 differenceUsd：健康为 READY 时它就是毛利，否则只是参考差额。
export function normalizeSuccessfulResult(result, healthCode) {
  const calculation = result?.calculation;
  if (!calculation || calculation.profitUsd !== undefined || calculation.riskDifferenceUsd !== undefined) return result;
  const differenceUsd = calculation.differenceUsd ?? null;
  const confirmed = (result.health?.code || healthCode) === "READY" && differenceUsd != null;
  return {
    ...result,
    calculation: {
      ...calculation,
      profitUsd: confirmed ? differenceUsd : null,
      riskDifferenceUsd: confirmed ? null : differenceUsd,
      marginRate: confirmed ? calculation.marginRate ?? null : null,
    },
  };
}

// next-complete-day 是旧版"次日零点生效"的规则；immediate 是确认即生效的新规则。两者都按 Key 整体取数、带完整来源声明。
export function isScopedBillingPolicy(policy) {
  return policy === "next-complete-day" || policy === "immediate";
}

// 核算起点：关联最早开始计账的那一天，在这条绑定自己的时区里的 0 点（用户 10-26：上游加好、渠道绑上以后，
// 算出从今天 0 点到现在的利润，不从「点的那一刻」起；New API 和 Sub2API 一样，决定记录第 8 条后来那一列）。
// 修改关联不会推迟起点（过渡期按新配置重算修改之前的时段），旧版次日生效规则也从创建那天起算。
export function reconciliationAccountingStart(rule) {
  if (!isScopedBillingPolicy(rule?.billingPolicy)) return null;
  const candidates = [rule.billingEffectiveFrom, Date.parse(rule.createdAt)].filter(Number.isFinite);
  if (!candidates.length) return null;
  const earliest = Math.min(...candidates);
  let start;
  try { start = shiftedDayStartInTz(earliest, 0, rule.timezone || businessTimeZone()); } catch { start = earliest; }
  // 同一天里更早解除了一条占着同一个渠道（或同一把 Key）的 New API 绑定：从那一刻起算，那一刻以前是它的（只在当天换绑时才晚于 0 点）
  const floor = rule.accountingFloorMs == null ? NaN : Number(rule.accountingFloorMs);
  return Number.isFinite(floor) && floor > start ? floor : start;
}
