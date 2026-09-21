import { json } from "../../../../../../lib/api.js";
import { mockNewApiStatus } from "../../../../../../server/demo.js";

export async function GET() {
  const r = mockNewApiStatus();
  return json(r.body, r.status);
}
