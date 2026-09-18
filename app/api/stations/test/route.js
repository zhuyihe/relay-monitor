// POST /api/stations/test —— 使用临时连接信息验证上游，不写库、不刷新、不触发告警。
import { withAuth, json } from "../../../../lib/api.js";
import { describeConnectionFailure } from "../../../../lib/connection-test.js";
import { queryStation, STATION_TYPES } from "../../../../lib/providers.js";

const CONNECTION_FIELDS = ["baseUrl", "accessToken", "apiKey", "userId", "email", "password"];

function text(value) {
  return String(value || "").trim();
}

function findSavedStation(store, stationId) {
  if (!stationId) return null;
  return store.list().find((station) => station.id === stationId) || null;
}

function testStation(body, saved) {
  const type = text(body.type || saved?.type);
  const sameType = !!saved && type === saved.type;
  const station = { type };

  for (const field of CONNECTION_FIELDS) {
    if (Object.hasOwn(body, field)) {
      const value = text(body[field]);
      // 编辑既有资源时，表单中空的凭证代表“保持不变”，只用于本次内存测试。
      station[field] = value || (sameType && field !== "baseUrl" ? text(saved?.[field]) : "");
    } else if (sameType) {
      station[field] = text(saved?.[field]);
    }
  }

  return station;
}

export const POST = withAuth(async (request, rt) => {
  const body = (await request.json().catch(() => null)) || {};
  const saved = findSavedStation(rt.store, text(body.stationId));
  if (body.stationId && !saved) return json({ error: "未找到要编辑的上游资源" }, 404);

  const station = testStation(body, saved);
  if (!STATION_TYPES.some((item) => item.value === station.type)) {
    return json({ error: "无效的中转站类型" }, 400);
  }
  if (station.type === "fixed") {
    return json({ ok: true, message: "固定成本不访问外部接口，无需测试连接。" });
  }

  const { result } = await queryStation(station);
  if (!result.ok) return json({ ok: false, ...describeConnectionFailure(result.error, station) });

  return json({
    ok: true,
    message: "连接成功，可以保存。",
    latencyMs: result.latencyMs,
    account: result.account || null,
    remaining: result.remaining,
    currency: result.currency || null,
  });
});
