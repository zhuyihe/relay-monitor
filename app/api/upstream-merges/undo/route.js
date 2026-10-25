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
    return json({ error: err.message, code }, 409);
  }
});
