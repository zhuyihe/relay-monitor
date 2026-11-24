import { withAuth, json } from "../../../../lib/api.js";
import { userOpsOf, ownStationOf } from "../../../../server/user-ops.js";
import { localUsersPage } from "../../../../server/user-ops-page.js";
import { userGroupsPage } from "../../../../server/user-groups.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";

async function handle(request, rt) {
  const own = ownStationOf(rt), { ops, store } = userOpsOf(rt);
  if (!own) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  const page = await localUsersPage(rt, ops, store);
  const directory = rt._userOpsDirectory?.stationId === own.id ? rt._userOpsDirectory : await store?.getDirectory(own.id);
  const refresh = request.method === "POST";
  if (refresh && page.paused) return json({ code: "USER_DATA_DISABLED" }, 403);
  const input = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const result = await userGroupsPage(rt, { own, page, directory, ops, input, refresh });
    return json(result);
  } catch (error) {
    if (error.code === "USER_GROUPS_RANGE_INVALID") return json({ error: error.message, code: error.code }, 400);
    throw error;
  }
}
export const GET = withAuth(handle);
export const POST = withAuth(handle);
