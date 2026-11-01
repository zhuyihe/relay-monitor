// GET /api/users/mail-preview —— 告警中心「看邮件样子」：三封邮件（第一封、第二封 1 天以内、第二封余额用完）的标题和正文。
// 站点名、钱的写法、充值页地址是真的，用户名和数是样例。没设置自营站点是 400 OWN_STATION_UNSET。
import { withAuth, json } from "../../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { sampleMails } from "../../../../server/user-ops-mail.js";

export const GET = withAuth(async (request, rt) => {
  const own = rt.store.list().find((station) => station.isOwn && station.type === "newapi" && !station.archivedAt);
  if (!own) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  return json({ mails: sampleMails(rt, own).map(({ key, label, subject, text }) => ({ key, label, subject, text })) });
});
