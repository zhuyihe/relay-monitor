// GET /api/notifications —— 渠道列表 + 规则 + 可用渠道类型
// 密钥不回传：换成空串，另给 hasSecret（lib/notify.js publicChannel）；编辑时留空表示不变，由 store.updateChannel 保证
import { withAuth, json } from "../../../lib/api.js";
import { CHANNEL_TYPES, publicChannel } from "../../../lib/notify.js";

export const GET = withAuth(async (request, rt) => {
  return json({ channels: rt.store.channels.map(publicChannel), rules: rt.store.rules, channelTypes: CHANNEL_TYPES });
});
