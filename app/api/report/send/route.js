// POST /api/report/send —— 立即发送日报到日报的通知方式（settings.dailyReport.channelIds，
// 为空表示全部启用的通知方式；筛选逻辑在 server/report.js 内），返回 { ok: true, results }；
// results 每项 { id, name, ok, error?, code? }，没发出去的按 code 说（lib/notify.js sendToChannel）
import { withAuth, json } from "../../../../lib/api.js";
import { ownStationErrorCode } from "../../../../lib/error-copy.js";
import { sendReport } from "../../../../server/report.js";

export const POST = withAuth(async (request, rt) => {
  try {
    // sendReport 已经返回 { ok: true, results }，原样交给页面；再包一层页面就读不到 results 列表
    return json(await sendReport(rt));
  } catch (err) {
    // 带码给页面按码说（lib/error-copy.js）：没设置自营站点 OWN_STATION_UNSET、没有能发日报的通知方式 REPORT_NO_CHANNELS 照旧；
    // 读自营站点没成的码由 ownStationErrorCode 给（§8.2）
    return json({ error: err?.message || String(err), code: ownStationErrorCode(err) }, 400);
  }
});
