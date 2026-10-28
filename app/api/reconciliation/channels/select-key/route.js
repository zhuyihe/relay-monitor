import { withAuth } from "../../../../../lib/api.js";
import { handleChannelProfitRequest } from "../handler.js";

export const POST = withAuth((request, rt) => handleChannelProfitRequest(request, rt, "select-key"));
