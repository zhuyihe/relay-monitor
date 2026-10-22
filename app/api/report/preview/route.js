// POST /api/report/preview —— 日报预览（不发送），返回 { title, text, html }
// 生成失败返回 400 { error, code }（例如还没设置自营站点）
import { withAuth, json } from "../../../../lib/api.js";
import { errorCodeOf } from "../../../../lib/error-copy.js";
import { buildReport } from "../../../../server/report.js";

export const POST = withAuth(async (request, rt) => {
  try {
    return json(await buildReport(rt));
  } catch (err) {
    // 带码给页面按码说（lib/error-copy.js）：没设置自营站点 OWN_STATION_UNSET，读自营站点没成带上游给的码，
    // 都认不出时按「自营站点暂时读不到」说
    return json({ error: err?.message || String(err), code: errorCodeOf(err, "OWN_STATION_UNAVAILABLE") }, 400);
  }
});
