import { json } from "../../../../../../../../lib/api.js";
import { mockNewApiSelfLogStat } from "../../../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiSelfLogStat(request);
  return json(r.body, r.status);
}
