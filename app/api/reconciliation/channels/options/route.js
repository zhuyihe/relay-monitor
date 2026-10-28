import { withAuth } from "../../../../../lib/api.js";
import { handleChannelProfitRequest } from "../handler.js";

export const GET = withAuth((request, rt) => handleChannelProfitRequest(request, rt, "options"));
