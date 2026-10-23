// POST /api/notifications/test —— 发送测试通知
// 两种形态：
// - channelId 指向已保存的通知方式：可以带上表单里这次填的 config，留空的密钥由服务端用已保存的补齐；
//   类型以已保存的为准，换了地址的站点就不补（lib/notify.js resolveChannelConfig），免得把已保存的密钥发到新地址；
// - type + config 试发还没保存的通知方式。
// name 是表单里填的名字，写进测试消息的「通知方式：」；没填时用已保存的名字，再没有就写类型名（design/ui-copy-spec.md §10）。
// 存库时没起名字的存成「未命名通知方式」（lib/alert-rules.js），这里也当作没起名字。
// 发没发出去都回 200：{ ok }，没发出去时带 code（lib/error-copy.js 按它说那一句），原文在 error 里只进「查看详细原因」
import { withAuth, json } from "../../../../lib/api.js";
import { UNNAMED_CHANNEL } from "../../../../lib/alert-rules.js";
import { BRAND } from "../../../../lib/brand.js";
import { businessTimeZone } from "../../../../lib/business-time.js";
import { errorText } from "../../../../lib/error-copy.js";
import { formatZonedDateTime } from "../../../../lib/format.js";
import { CHANNEL_TYPES, resolveChannelConfig, sendToChannel } from "../../../../lib/notify.js";

const fail = (code) => json({ error: errorText({ code }), code }, 400);
const named = (name) => {
  const text = String(name ?? "").trim();
  return text === UNNAMED_CHANNEL ? "" : text;
};

export const POST = withAuth(async (request, rt) => {
  const b = (await request.json().catch(() => null)) || {};
  let channel = null;
  if (b.channelId) {
    const saved = rt.store.channels.find((c) => c.id === b.channelId);
    if (!saved) return fail("NOTIFY_NOT_FOUND");
    if (b.type && b.type !== saved.type) return json({ error: "通知方式的类型不能改", code: "INVALID_REQUEST" }, 400);
    try {
      const config = b.config && typeof b.config === "object" ? resolveChannelConfig(saved.type, b.config, saved.config) : saved.config;
      channel = { ...saved, config };
    } catch (error) {
      if (error?.code === "ENDPOINT_CHANGED_SECRET_REQUIRED") return json({ error: errorText(error), code: error.code }, 400);
      throw error;
    }
  } else if (b.type) channel = { type: b.type, config: b.config || {} };
  if (!channel) return fail("INVALID_REQUEST");
  const name = named(b.name) || named(channel.name) || CHANNEL_TYPES.find((t) => t.value === channel.type)?.label || UNNAMED_CHANNEL;
  const r = await sendToChannel(
    channel,
    `【测试通知】${BRAND.notificationSignature}`,
    // 最后一行和推送一样是落款（§10），测试能过，真推送也能过
    [`这是一条来自${BRAND.productName}的测试消息。`, `通知方式：${name}`, `时间：${formatZonedDateTime(Date.now(), businessTimeZone())}`, BRAND.notificationSignature].join("\n"),
    { event: "test" }
  );
  return json(r);
});
