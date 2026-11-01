// GET /api/models —— 模型供需页（整页）：哪些模型缺货、每天少收多少、去哪找货。只在有人打开这一页时读自营站点，读完缓存 10 分钟（server/models-page.js）。
// 没设置自营站点是 400 OWN_STATION_UNSET（页面走设置引导）。
import { withAuth, json } from "../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../lib/format.js";
import { modelsPage } from "../../../server/models-page.js";

export const GET = withAuth(async (_request, rt) => {
  const page = await modelsPage(rt);
  if (page.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  return json(page);
});
