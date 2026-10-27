// 假的 Sub2API 上游（测试共用）：只实现我们的 provider（lib/providers.js 的 queryReconciliationMetadata、queryKeyReconciliationStat、
// verifySub2Billing）真正调的接口，按 Key、按天回用量——量钱对不对用：把所有绑定（含已归档的）当天的上游成本加起来，要等于各把 Key 当天用量之和。
//   GET /api/v1/auth/me                       → { id }
//   GET /api/v1/keys?page&page_size           → { total, items: [{ id, user_id, name, status, group_id, key }] }（带完整 Key，和真的一样）
//   GET /api/v1/keys/:id                      → 404（能力核验用：不存在的 Key 要 404）
//   GET /api/v1/usage/stats?api_key_id&start_date&end_date&timezone → { total_cost, total_actual_cost }
//        带 api_key_id：这把 Key 在 [start_date, end_date]（含）每天用量之和，Key 不存在 404；不带：整个账号。
// dayUsageUsd(keyId, "YYYY-MM-DD") 给每把 Key 每天（业务时区的一天）的用量（美元）；还没到的日子回 0（能力核验要求未来的完整日是 0）。
// 用法：const fake = createFakeSub2Api({ keys, dayUsageUsd }); 在 fetch 的假实现里 `const hit = fake.handle(url); if (hit) return hit;`
import { dayKeyInTz } from "../../lib/business-time.js";

export function createFakeSub2Api({ accountId = 42, keys, dayUsageUsd, now = () => Date.now() }) {
  const calls = [];
  const reply = (status, data) => ({ status, text: async () => JSON.stringify({ code: status >= 300 ? status : 0, data }) });
  const byId = new Map(keys.map((key) => [Number(key.id), key]));
  const datesBetween = (start, end) => {
    const days = [];
    for (let day = new Date(`${start}T00:00:00Z`); day <= new Date(`${end}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) days.push(day.toISOString().slice(0, 10));
    return days;
  };
  return {
    calls,
    handle(url) {
      if (!url.pathname.startsWith("/api/v1/")) return null;
      calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
      if (url.pathname === "/api/v1/settings/public") return reply(200, { turnstile_enabled: false });
      if (url.pathname === "/api/v1/auth/me") return reply(200, { id: accountId, email: "user@example.test" });
      if (url.pathname === "/api/v1/keys") {
        return reply(200, { total: keys.length, items: keys.map((key) => ({ id: key.id, user_id: accountId, name: key.name, status: "active", group_id: null, key: key.secret ?? `sk-fake-${key.id}` })) });
      }
      if (url.pathname.startsWith("/api/v1/keys/")) return reply(404, null);
      if (url.pathname === "/api/v1/usage/stats") {
        const timezone = url.searchParams.get("timezone") || "Asia/Shanghai";
        const today = dayKeyInTz(now(), timezone);
        const id = url.searchParams.get("api_key_id");
        if (id != null && !byId.has(Number(id))) return reply(404, null);
        const ids = id != null ? [Number(id)] : [...byId.keys()];
        const days = datesBetween(url.searchParams.get("start_date"), url.searchParams.get("end_date"));
        const total = ids.reduce((sum, keyId) => sum + days.reduce((daySum, day) => daySum + (day > today ? 0 : Number(dayUsageUsd(keyId, day)) || 0), 0), 0);
        return reply(200, { total_cost: total, total_actual_cost: total });
      }
      return reply(404, null);
    },
  };
}

// 每把 Key 的用量窗口 [from, to)（毫秒，to 为 null 是没有尽头）、每秒 1 美元，折成「这一天（业务时区）里有几秒」——测试里造 dayUsageUsd 和算真值都用它
export function secondsInDay(window, dateKey, timezone = "Asia/Shanghai") {
  const startMs = Date.parse(`${dateKey}T00:00:00+08:00`), endMs = startMs + 86400000;
  if (timezone !== "Asia/Shanghai") throw new Error("fake-sub2api 的 secondsInDay 只按 Asia/Shanghai 算");
  const [from, to] = window;
  return Math.max(0, Math.min(endMs, to ?? Infinity) - Math.max(startMs, from)) / 1000;
}
