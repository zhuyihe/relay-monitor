import { json } from "../../../../../../../lib/api.js";
import { mockNewApiLogStat } from "../../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiLogStat(request);
  return json(r.body, r.status);
}
