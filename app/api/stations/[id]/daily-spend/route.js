// POST /api/stations/:id/daily-spend（余额趋势里「读不到每天花了多少」后面的「重新读取」）：马上读一次这个上游每天的花费，不等退避和「不给读」的一周。
// 返回 { outcome, dailySpend }：outcome 是 read 读到了 / denied 对方不给读 / failed 还是没读到（会再试）/ skipped 上游断路或请求快到限流，这会儿不读 /
// busy 正在读 / none 这种上游没有这个数、或没有要读的；dailySpend 是读完以后的 { state, source, days, since, todayEstimate }（和 /api/stations 里的同一份）
import { withAuth, json } from "../../../../../lib/api.js";
import { dailySpendOf } from "../../../../../server/stations.js";

export const POST = withAuth(async (request, rt, params) => {
  const s = rt.store.get(params.id);
  if (!s) return json({ error: "找不到这个上游", code: "UPSTREAM_NOT_FOUND" }, 404);
  const { outcome } = (await rt.upstreamSpend?.refresh(s.id)) ?? { outcome: "none" };
  return json({ outcome, dailySpend: dailySpendOf(rt, s) });
});
