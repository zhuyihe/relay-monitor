// 给重点用户发邮件的运行时部分（用户运营第三步）：用哪个通知方式、钱怎么写、真正发出去、「看邮件样子」和给自己的试信。
// 邮件的字和什么时候发在 lib/user-mail.js（纯函数）；什么时候发、状态怎么写在 server/user-ops.js。
// 邮箱只在内存里：这里不写日志、不进返回值、不进库；发不出去只留错误码，不留服务器回的原话（原话里常常带着收件人地址）。
import { USER_MAIL_CHANNEL_TYPES } from "../lib/alert-rules.js";
import { formatMoney, formatUsd } from "../lib/format.js";
import { sendToChannel } from "../lib/notify.js";
import { isConfiguredRate, rateSnapshotOf } from "../lib/profit.js";
import { buildUserMail, userMailPayUrl } from "../lib/user-mail.js";

// 站长选的那个邮件通知方式；没选、被删、停用、不是邮件类都是 null
export function userMailChannel(rt) {
  const id = rt.store?.rules?.userMailChannelId;
  if (!id) return null;
  return (rt.store?.channels || []).find((channel) => channel.id === id && channel.enabled !== false && USER_MAIL_CHANNEL_TYPES.includes(channel.type)) || null;
}

// 邮件里写的钱：自营站点设了售价写 ¥（美元额度按售价换算），没设写 $
export function mailMoneyOf(own) {
  const rate = rateSnapshotOf(own);
  return isConfiguredRate(rate) ? (usd) => formatMoney(usd * rate.cnyPerUsd) : (usd) => formatUsd(usd);
}

// 发一封：收件人换成这位用户的邮箱，别的（服务器、发信人、密钥）用站长配好的；返回 { ok, code }，不带原话
export async function sendUserMail(channel, to, mail) {
  try {
    const result = await sendToChannel({ ...channel, config: { ...(channel.config || {}), to } }, mail.subject, mail.text, { html: mail.html });
    return { ok: !!result.ok, code: result.ok ? undefined : result.code || "ERROR" };
  } catch {
    return { ok: false, code: "ERROR" };
  }
}

// 三封样子：第一封、第二封（1 天以内）、第二封（余额用完）；用真的站点名、钱的写法和充值页地址，用户名和数是样例
export function sampleMails(rt, own) {
  const rules = rt.store?.rules || {};
  const rate = rateSnapshotOf(own);
  const unit = isConfiguredRate(rate) ? rate.cnyPerUsd : 1; // 样例里的钱按「¥12.40」写，换回美元额度
  const money = mailMoneyOf(own), payUrl = userMailPayUrl(own, rules);
  const base = { siteName: own?.name, username: "alice", money, payUrl };
  return [
    { key: "soon", label: "第一封：快用完", ...buildUserMail({ ...base, kind: "soon", balanceUsd: 12.4 / unit, days: 2 }) },
    { key: "urgent", label: "第二封：只够用不到 1 天", ...buildUserMail({ ...base, kind: "urgent", balanceUsd: 3.1 / unit, days: 0.5 }) },
    { key: "empty", label: "第二封：余额用完", ...buildUserMail({ ...base, kind: "empty", balanceUsd: 0, days: 0 }) },
  ];
}

// 给自己发一封试信：第一封的样子，发到站长在这个通知方式里填的收件人（不是任何用户）；标题前加「试信」
export async function sendTestMail(rt, own, { send = sendToChannel } = {}) {
  const channel = userMailChannel(rt);
  if (!channel) return { ok: false, code: "NOTIFY_CONFIG_MISSING" };
  const mail = sampleMails(rt, own)[0];
  const result = await send(channel, `试信：${mail.subject}`, mail.text, { html: mail.html });
  return result;
}
