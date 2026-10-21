// POST /api/notifications/test —— 发送测试通知
// 两种形态：
// - channelId 指向已保存渠道：可以带上表单里这次填的 config，留空的密钥由服务端用已保存的补齐；
//   类型以已保存的为准，换了地址的站点就不补（lib/notify.js resolveChannelConfig），免得把已保存的密钥发到新地址；
// - type + config 试发还没保存的渠道。
import { withAuth, json } from "../../../../lib/api.js";
import { BRAND } from "../../../../lib/brand.js";
import { errorText } from "../../../../lib/error-copy.js";
import { resolveChannelConfig, sendToChannel } from "../../../../lib/notify.js";

export const POST = withAuth(async (request, rt) => {
  const b = (await request.json().catch(() => null)) || {};
  let channel = null;
  if (b.channelId) {
    const saved = rt.store.channels.find((c) => c.id === b.channelId);
    if (!saved) return json({ error: "未找到渠道" }, 400);
    if (b.type && b.type !== saved.type) return json({ error: "通知方式的类型不能改", code: "INVALID_REQUEST" }, 400);
    try {
      const config = b.config && typeof b.config === "object" ? resolveChannelConfig(saved.type, b.config, saved.config) : saved.config;
      channel = { ...saved, config };
    } catch (error) {
      if (error?.code === "ENDPOINT_CHANGED_SECRET_REQUIRED") return json({ error: errorText(error), code: error.code }, 400);
      throw error;
    }
  } else if (b.type) channel = { type: b.type, config: b.config || {} };
  if (!channel) return json({ error: "未找到渠道" }, 400);
  const r = await sendToChannel(
    channel,
    `【测试通知】${BRAND.notificationSignature}`,
    `这是一条来自${BRAND.productName}的测试消息。\n渠道：${channel.name || channel.type}\n时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    { event: "test" }
  );
  return json(r);
});
