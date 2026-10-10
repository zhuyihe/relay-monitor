import { withAuth } from "../../../lib/api.js";
import { handleChannelOnboardingRequest } from "./handler.js";

export const GET = withAuth((request, rt) => handleChannelOnboardingRequest(request, rt, "list"));
export const POST = withAuth((request, rt) => handleChannelOnboardingRequest(request, rt, "connect"));
