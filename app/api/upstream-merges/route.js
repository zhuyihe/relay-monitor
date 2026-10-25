import { withAuth, json } from "../../../lib/api.js";
import { businessTimeZone } from "../../../lib/business-time.js";
import { applyUpstreamMerge, previewUpstreamMerges } from "../../../server/upstream-merge.js";

// 合并重复的上游：GET 只出清单和合并前后的成本估算，不改任何数据；POST 才合并（一组一组合，请求里带清单上看到的留下的、被合掉的）。
// 界面在「渠道」页签的合并确认（K2d），这里先只给接口
export const GET = withAuth(async (request, rt) => {
  const estimate = new URL(request.url).searchParams.get("estimate") !== "0";
  // tz：业务时区，页面上合并记录的时间按它写
  return json({ ...(await previewUpstreamMerges(rt, { estimate })), tz: businessTimeZone() });
});

export const POST = withAuth(async (request, rt) => {
  const input = await request.json().catch(() => null);
  try {
    return json(await applyUpstreamMerge(rt, { retainedId: input?.retainedId, mergedIds: input?.mergedIds }));
  } catch (err) {
    const code = String(err?.code || "");
    if (!code.startsWith("UPSTREAM_MERGE_")) throw err;
    return json({ error: err.message, code }, 409);
  }
});
