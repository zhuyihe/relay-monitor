// GET /api/models/detail?name=claude-sonnet-4.6 —— 点开一个模型的抽屉。模型名里可能有「/」（deepseek-ai/DeepSeek-V3），不放进路径里，用 ?name=。
// 整页的数用同一份 10 分钟缓存；这里多读这个模型的成功率序列（自营站点 1 个请求）和各上游的价目表（缓存 1 小时）。
import { withAuth, json } from "../../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { modelDetail } from "../../../../server/models-page.js";
import { modelsModuleEnabled } from "../../../../lib/features.js";

export const GET = withAuth(async (request, rt) => {
  // 模块隐藏中：当作没有这个接口
  if (!modelsModuleEnabled()) return json({ error: "not found" }, 404);
  const name = new URL(request.url).searchParams.get("name") || "";
  if (!name) return json({ error: "请选一个模型", code: "MODEL_REQUIRED" }, 400);
  const detail = await modelDetail(rt, name);
  if (detail.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  if (detail.notFound) return json({ error: "找不到这个模型", code: "MODEL_NOT_FOUND" }, 404);
  return json(detail);
});
