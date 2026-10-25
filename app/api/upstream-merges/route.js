import { withAuth, json } from "../../../lib/api.js";
import { businessTimeZone } from "../../../lib/business-time.js";
import { applyUpstreamMerge, previewUpstreamMerges } from "../../../server/upstream-merge.js";

// 合并重复的上游：GET 只出清单和合并前后的成本估算，不改任何数据；POST 才合并（一组一组合，请求里带清单上看到的留下的、被合掉的）。
// 界面：上游列表顶上的提示和「合并重复的上游」抽屉（app/components/merge-upstreams.tsx）
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
    // 请求本身不对（缺编号、类型不对）回 400；清单变了、现在不能做回 409
    return json({ error: err.message, code }, code === "UPSTREAM_MERGE_INVALID" ? 400 : 409);
  }
});
