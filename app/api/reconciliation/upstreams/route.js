import { withAuth, json } from "../../../../lib/api.js";
import { connectNewApiUpstream } from "../../../../server/channel-onboarding.js";
import { refreshStation } from "../../../../server/refresh.js";

export const POST = withAuth(async (request, rt) => {
  const input = await request.json().catch(() => null);
  try {
    const result = await connectNewApiUpstream(rt, input);
    if (result.created) refreshStation(rt, rt.store.get(result.station.id)).catch(() => {});
    return json(result);
  } catch (err) {
    return json({ error: err?.message || "接入账号失败，请稍后重试" }, 400);
  }
});
