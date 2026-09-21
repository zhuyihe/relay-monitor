import { json } from "../../../../../../lib/api.js";
import { mockNewApiTokenList } from "../../../../../../server/demo.js";

export async function GET(request) {
  const r = mockNewApiTokenList(request);
  return json(r.body, r.status);
}
