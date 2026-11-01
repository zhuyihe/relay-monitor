// 给重点用户发的两封邮件（用户运营第三步，design 用户运营 customers-1101 第 8 节）：纯函数，后台（server/user-ops.js）和告警中心的「看邮件样子」「试信」共用。
// 以自营站点的名义发，邮件里不出现控制台的名字；发信人是站长在告警中心选的那个邮件通知方式。
// 每个用户一轮最多两封：
//   第一封：可用天数第一次进提醒天数以内（默认 3 天）；
//   第二封：可用约 1 天以内、或余额用完时，一轮只发一次（1 天以内之后又用完，不再发第三封）；
//   充值以后（预计天数回到提醒天数的 1.2 倍以上，和推给站长的清零同一条线）重新开始一轮。
// 失败的 30 分钟后再试一次；先把级别写进库再发，发的过程中程序重启也不会发两遍。邮箱只在内存里，这里不碰它。
import { USER_MAIL_CHANNEL_TYPES } from "./alert-rules.js";
import { USER_BALANCE } from "./user-balance.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const USER_MAIL = Object.freeze({
  MAX_PER_ROUND: 5, // 一轮（10 分钟）最多发几封，多的下一轮接着发
  RETRY_MS: 30 * 60000, // 没发出去，30 分钟后再试一次
  MAX_TRIES: 2, // 第一次加一次重试
  CHANNEL_TYPES: USER_MAIL_CHANNEL_TYPES, // 只能用这两种邮件通知方式发
});

// 这个状况该发哪一封：0 不发、1 第一封（快用完）、2 第二封（1 天以内或用完）
export const mailLevelOf = (runway) => (runway?.level >= 2 ? 2 : runway?.level === 1 ? 1 : 0);

/**
 * 一位重点用户这一轮该不该发邮件。
 * prev：库里这位的邮件状态 { level, retryAt, tries }（没有是 null）；runway：userRunway 的结果；level1Days：提醒天数
 * 返回 { action, level?, state }：
 *   action: "send"（新的一封）| "retry"（上一封没发出去，隔够 30 分钟再试一次，只试一次）| "clear"（充值以后清零）| "none"
 *   state：这个动作写进库的状态（先写再发）；send 和 retry 的 state 写完才发。
 */
export function decideUserMail({ prev, runway, level1Days = USER_BALANCE.LEVEL1_DAYS, now }) {
  const level = prev?.level ?? 0;
  const comfortable = runway.state === "ok" && runway.days != null && runway.days >= level1Days * USER_BALANCE.CLEAR_FACTOR;
  if (comfortable) return level > 0 || prev?.retryAt != null ? { action: "clear", state: { level: 0, retryAt: null, tries: 0 } } : { action: "none", state: { level: 0, retryAt: null, tries: 0 } };
  const target = mailLevelOf(runway);
  if (target > level) return { action: "send", level: target, state: { level: target, retryAt: now + USER_MAIL.RETRY_MS, tries: 1 } };
  // 没发出去的：写进库的时候已经定了 30 分钟后的重试时刻（发成功才清掉）；到点还没清掉就再试一次，只试一次
  if (prev?.retryAt != null && prev.retryAt <= now && (prev.tries ?? 1) < USER_MAIL.MAX_TRIES) return { action: "retry", level, state: { level, retryAt: null, tries: (prev.tries ?? 1) + 1 } };
  return { action: "none", state: { level, retryAt: prev?.retryAt ?? null, tries: prev?.tries ?? 0 } };
}

// 一个人还够用多久：「2 天」「12 小时」（邮件里写整数，不写「约」，前面的话里有「大约」）
export function mailDaysText(days) {
  if (typeof days !== "number" || !(days >= 0)) return "";
  if (days >= 1 || days * 24 >= 23.5) return `${Math.max(1, Math.round(days))} 天`; // 23.5 小时以上就写 1 天，不写「24 小时」
  return `${Math.max(1, Math.round(days * 24))} 小时`;
}

// 邮件的字。siteName：自营站点的名字；money：把美元换成要写的钱（站点设了售价写 ¥，没设写 $）；payUrl：充值页地址
export const USER_MAIL_TEXT = Object.freeze({
  subjectSoon: (site, days) => `${site} 账户余额快用完了，还能用约 ${mailDaysText(days)}`,
  subjectUrgent: (site, days) => `${site} 账户余额快用完了，大约只够用 ${mailDaysText(days)}`,
  subjectEmpty: (site) => `${site} 账户余额已经用完`,
  hello: (name) => `您好，${name}：`,
  soon: (site, balance, days) => `您在 ${site} 的账户余额还剩 ${balance}。按最近 7 天的用量，大约还能用 ${mailDaysText(days)}。`,
  urgent: (site, balance, days) => `您在 ${site} 的账户余额还剩 ${balance}，按最近的用量大约只够用 ${mailDaysText(days)}。`,
  empty: (site) => `您在 ${site} 的账户余额已经用完，接口调用会失败。充值后马上恢复。`,
  pleaseTopUp: "为了不影响使用，请尽快充值。",
  button: "去充值",
  payPage: (url) => `充值页：${url}`,
  ignore: "如果已经充值，请忽略这封邮件。",
  sign: (site) => `—— ${site}`,
  footer: (site) => `这封邮件由 ${site} 自动发送。`,
});

// 充值页地址：站长填了用站长的，没填就是站点地址加 /wallet（New API 的充值页）
export function userMailPayUrl(station, rules) {
  const custom = String(rules?.userMailPayUrl || "").trim();
  if (/^https?:\/\//i.test(custom)) return custom;
  const base = String(station?.baseUrl || "").trim().replace(/\/+$/, "");
  return base ? `${base}/wallet` : "";
}

/**
 * 一封邮件的标题、纯文本和 HTML。
 * kind：soon 第一封 / urgent 第二封（1 天以内）/ empty 第二封（余额用完）
 */
export function buildUserMail({ kind, siteName, username, balanceUsd, days, money, payUrl }) {
  const T = USER_MAIL_TEXT;
  const site = String(siteName || "").trim() || "自营站点";
  const balance = money(balanceUsd);
  const subject = kind === "empty" ? T.subjectEmpty(site) : kind === "urgent" ? T.subjectUrgent(site, days) : T.subjectSoon(site, days);
  const first = kind === "empty" ? T.empty(site) : kind === "urgent" ? T.urgent(site, balance, days) : T.soon(site, balance, days);
  const lines = [T.hello(username), "", first, ...(kind === "empty" ? [] : ["", T.pleaseTopUp]), ...(payUrl ? ["", `${T.button}：${payUrl}`] : []), "", T.ignore, "", T.sign(site), "", T.footer(site)];
  const text = lines.join("\n");
  const p = (value, style = "") => `<p style="margin:0 0 16px;${style}">${value}</p>`;
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1f2933;max-width:560px">',
    p(escapeHtml(T.hello(username))),
    p(escapeHtml(first)),
    kind === "empty" ? "" : p(escapeHtml(T.pleaseTopUp)),
    payUrl ? p(`<a href="${escapeHtml(payUrl)}" style="display:inline-block;padding:8px 20px;background:#3157d5;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(T.button)}</a>&nbsp;&nbsp;<span style="color:#667085">${escapeHtml(T.payPage(payUrl))}</span>`) : "",
    p(escapeHtml(T.ignore)),
    p(escapeHtml(T.sign(site))),
    p(escapeHtml(T.footer(site)), "font-size:12px;color:#98a2b3"),
    "</div>",
  ].join("");
  return { subject, text, html };
}

// 这一刻的状况该用哪个样子：级别 1 是第一封，级别 2 里余额用完写用完，否则写 1 天以内
export const mailKindOf = (level, runway) => (level >= 2 ? (runway?.balanceUsd <= 0 || runway?.state === "empty" ? "empty" : "urgent") : "soon");
