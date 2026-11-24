import { withAuth, json } from "../../../lib/api.js";
import { overviewPage } from "../../../server/overview-page.js";

export const GET = withAuth(async (request, rt) => {
  const preset = new URL(request.url).searchParams.get("preset") || "today";
  if (!["today", "yesterday"].includes(preset)) return json({ error: "请选择今天或昨天", code: "INVALID_REQUEST" }, 400);
  return json(await overviewPage(rt, { preset }));
});
