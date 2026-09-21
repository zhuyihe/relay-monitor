import { json } from "../../../../../../../../lib/api.js";
import { mockNewApiSelfGroups } from "../../../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiSelfGroups(request);
  return json(r.body, r.status);
}
