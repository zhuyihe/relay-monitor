import { json } from "../../../../../../../lib/api.js";
import { mockNewApiSelfLogs } from "../../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiSelfLogs(request);
  return json(r.body, r.status);
}
