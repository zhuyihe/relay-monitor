// POST /api/stations/test —— 使用临时连接信息验证上游，不写库、不刷新、不触发告警。
import { withAuth, json } from "../../../../lib/api.js";
import { describeError } from "../../../../lib/error-copy.js";
import { sameEndpoint, staleSecrets } from "../../../../lib/endpoint.js";
import { queryStation, STATION_TYPES } from "../../../../lib/providers.js";
import { UPSTREAM_SECRET_FIELDS, UPSTREAM_TYPES } from "../../../../lib/channel-onboarding.js";

const CONNECTION_FIELDS = ["baseUrl", "accessToken", "apiKey", "userId", "email", "password"];
const PRESERVED_SECRET_FIELDS = new Set(UPSTREAM_SECRET_FIELDS);

function text(value) {
  return String(value || "").trim();
}

function connectionValue(field, value) {
  // 密码中的首尾空格可能是有效字符，不能像 URL/令牌一样做标准化。
  return field === "password" ? String(value || "") : text(value);
}

function findSavedStation(store, stationId) {
  if (!stationId) return null;
  return store.list().find((station) => station.id === stationId) || null;
}

// 返回 { station, droppedSecret }：droppedSecret 表示换了站点、这种类型要填的已保存密钥没有重新给出，这次测试不发出去
function testStation(body, saved) {
  const type = text(body.type || saved?.type);
  const sameType = !!saved && type === saved.type;
  // 换了站点（协议、主机、端口）就不再沿用已保存的密钥，免得把它发到新地址（lib/endpoint.js）
  const sameSite = !!saved && (!Object.hasOwn(body, "baseUrl") || sameEndpoint(body.baseUrl, saved.baseUrl));
  const keepSecrets = sameType && sameSite;
  const station = { type };

  for (const field of CONNECTION_FIELDS) {
    const secret = PRESERVED_SECRET_FIELDS.has(field);
    if (Object.hasOwn(body, field)) {
      const value = connectionValue(field, body[field]);
      // 编辑既有资源时，表单中空的敏感凭证代表“保持不变”；其他连接字段的空值会参与测试。
      station[field] = value || (secret && keepSecrets ? connectionValue(field, saved?.[field]) : "");
    } else if (sameType) {
      station[field] = secret && !keepSecrets ? "" : connectionValue(field, saved?.[field]);
    }
  }

  // 只看这种类型要填的密钥：老数据里残留的、用不到的字段照样不发，但不因此卡住
  const needs = UPSTREAM_TYPES.find((item) => item.value === type)?.needs || [];
  const droppedSecret = sameType && !sameSite
    && staleSecrets(UPSTREAM_SECRET_FIELDS.filter((field) => needs.includes(field)), saved, body).length > 0;
  return { station, droppedSecret };
}

export const POST = withAuth(async (request, rt) => {
  const body = (await request.json().catch(() => null)) || {};
  const saved = findSavedStation(rt.store, text(body.stationId));
  if (body.stationId && !saved) return json({ error: "找不到这个上游", code: "UPSTREAM_NOT_FOUND" }, 404);

  const { station, droppedSecret } = testStation(body, saved);
  if (!STATION_TYPES.some((item) => item.value === station.type)) {
    return json({ error: "请选上游类型", code: "UNSUPPORTED_UPSTREAM_TYPE" }, 400);
  }
  if (station.type === "fixed") {
    return json({ ok: true, message: "固定成本不访问外部接口，无需测试连接。" });
  }
  if (droppedSecret) {
    const code = "ENDPOINT_CHANGED_SECRET_REQUIRED";
    const { category, text, action } = describeError({ code });
    return json({ ok: false, code, category, message: text, action });
  }

  const { result } = await queryStation(station);
  if (!result.ok) {
    // 归类和界面同一套（lib/error-copy.js §8.2）：category 类名、message 界面上那一句、action 下一步按钮的动作键；
    // diagnostic 是脱敏后的原文（lib/providers.js 已打码），只进「查看详细原因」
    const { category, text, action } = describeError({ code: result.code, message: result.error });
    return json({ ok: false, code: result.code, category, message: text, action, diagnostic: result.error });
  }

  return json({
    ok: true,
    message: "连接成功，可以保存。",
    latencyMs: result.latencyMs,
    account: result.account || null,
    remaining: result.remaining,
    currency: result.currency || null,
  });
});
