import { withAuth, json } from "../../../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../../../lib/format.js";
import { ownRequestState } from "../../../../../lib/own-request-budget.js";
import { queryOwnUserBalance } from "../../../../../lib/providers.js";
import { USER_OPS, ownStationOf } from "../../../../../server/user-ops.js";

export const POST = withAuth(async (request, rt, { id }) => {
  const userId = Number(id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return json({ code: "USER_NOT_FOUND" }, 404);
  const own = ownStationOf(rt);
  if (!own) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  if (rt.store.settings?.userOpsEnabled === false) return json({ code: "USER_DATA_DISABLED" }, 403);
  const budget = ownRequestState(own.baseUrl);
  if (budget.broken || budget.used >= USER_OPS.BUDGET_MAX_USED) return json({ code: "USER_DATA_BUSY" }, 503);
  const balanceUsd = await queryOwnUserBalance(own, userId);
  if (balanceUsd == null) return json({ code: "USER_NOT_FOUND" }, 404);
  return json({ balanceUsd, readMs: Date.now() });
});
