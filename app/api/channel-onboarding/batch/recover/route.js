import { withAuth } from "../../../../../lib/api.js";
import { handleChannelOnboardingRequest } from "../../handler.js";

export const POST = withAuth((request, rt) => handleChannelOnboardingRequest(request, rt, "recoverBatch"));
