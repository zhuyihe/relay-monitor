// POST /api/users/mail-test —— 告警中心「给自己发一封试信」：用站长选的那个邮件通知方式，把第一封邮件的样子发到这个通知方式里填的收件人（站长自己，不是任何用户）。
// 发没发出去都回 200：{ ok }，没发出去时带 code（lib/error-copy.js 按它说那一句），原文在 error 里只进「查看详细原因」；
// 没选通知方式是 400 NOTIFY_CONFIG_MISSING；没设置自营站点是 400 OWN_STATION_UNSET。
import { withAuth, json } from "../../../../lib/api.js";
import { errorText } from "../../../../lib/error-copy.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { sendTestMail, userMailChannel } from "../../../../server/user-ops-mail.js";

export const POST = withAuth(async (request, rt) => {
  const own = rt.store.list().find((station) => station.isOwn && station.type === "newapi" && !station.archivedAt);
  if (!own) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  if (!userMailChannel(rt)) return json({ error: errorText({ code: "NOTIFY_CONFIG_MISSING" }), code: "NOTIFY_CONFIG_MISSING" }, 400);
  return json(await sendTestMail(rt, own));
});
