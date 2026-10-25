import { withAuth, json } from "../../../../lib/api.js";
import { undoUpstreamMerge } from "../../../../server/upstream-merge.js";

// 退回一次合并（合并记录里的「退回」）：照 upstream_merge_log 改回，和 db/k-unmerge.js --apply 同一段代码
export const POST = withAuth(async (request, rt) => {
  const input = await request.json().catch(() => null);
  try {
    return json(await undoUpstreamMerge(rt, { mergeId: input?.mergeId }));
  } catch (err) {
    const code = String(err?.code || "");
    if (!code.startsWith("UPSTREAM_MERGE_")) throw err;
    // 请求本身不对（缺编号、类型不对）回 400；清单变了、现在不能做回 409
    return json({ error: err.message, code }, code === "UPSTREAM_MERGE_INVALID" ? 400 : 409);
  }
});
