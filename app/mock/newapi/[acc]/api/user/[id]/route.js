import { json } from "../../../../../../../lib/api.js";
import { mockNewApiUserList } from "../../../../../../../server/demo.js";

export async function GET(request, { params }) {
  const result = mockNewApiUserList(request);
  if (result.status !== 200) return json(result.body, result.status);
  const { id } = await params;
  const user = result.body.data.items.find((item) => item.id === Number(id));
  return user ? json({ success: true, data: user }) : json({ success: false }, 404);
}
