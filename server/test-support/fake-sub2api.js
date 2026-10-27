// 假的 Sub2API 上游（测试共用）：只实现我们的 provider（lib/providers.js 的 queryReconciliationMetadata、queryKeyReconciliationStat、
// verifySub2Billing）真正调的接口，按 Key、按天回用量——量钱对不对用：把所有绑定（含已归档的）当天的上游成本加起来，要等于各把 Key 当天用量之和。
//   GET /api/v1/auth/me                       → { id }
//   GET /api/v1/keys?page&page_size           → { total, items: [{ id, user_id, name, status, group_id, key }] }（带完整 Key，和真的一样）
//   GET /api/v1/keys/:id                      → 404（能力核验用：不存在的 Key 要 404）
//   GET /api/v1/usage/stats?api_key_id&start_date&end_date&timezone → { total_cost, total_actual_cost }
//        带 api_key_id：这把 Key 在 [start_date, end_date]（含）每天用量之和，Key 不存在 404；不带：整个账号。
//   GET /api/v1/usage?api_key_id&start_date&end_date&timezone&sort_order&page&page_size → { items: [{ id, api_key_id, created_at, actual_cost, total_cost }], total, page, page_size, pages }
//        逐条用量，和真的一样：page_size 大于 1000 悄悄变回 20；按 created_at、id 排（sort_order 默认 desc）；不带 api_key_id 是整个账号（已删的 Key 的条数照样带编号）。
//        每天的逐条记录来自 recordsOf(keyId, "YYYY-MM-DD") → [{ atMs, usd }]；不给就由 dayUsageUsd 合成：这一天一条（正午），要按时间切的测试自己给 recordsOf。
//        onUsagePage({ page, query }) 在每一页返回前调用：测试用它在翻页中途让上游多出新用量（total 变了），或数调用次数。
// dayUsageUsd(keyId, "YYYY-MM-DD") 给每把 Key 每天（业务时区的一天）的用量（美元）；还没到的日子回 0（能力核验要求未来的完整日是 0）。
// 用法：const fake = createFakeSub2Api({ keys, dayUsageUsd }); 在 fetch 的假实现里 `const hit = fake.handle(url); if (hit) return hit;`
import { dayKeyInTz } from "../../lib/business-time.js";

export function createFakeSub2Api({ accountId = 42, keys, dayUsageUsd, recordsOf = null, onUsagePage = null, deletedKeyIds = [], now = () => Date.now() }) {
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
      if (url.pathname === "/api/v1/usage") {
        const timezone = url.searchParams.get("timezone") || "Asia/Shanghai";
        const idParam = url.searchParams.get("api_key_id");
        if (idParam != null && !byId.has(Number(idParam))) return reply(404, null); // 已删的 Key 按 id 查会报错（Key 不在目录里）
        const ids = idParam != null ? [Number(idParam)] : [...byId.keys(), ...deletedKeyIds.map(Number)];
        const startMs = Date.parse(`${url.searchParams.get("start_date")}T00:00:00+08:00`), endMs = Date.parse(`${url.searchParams.get("end_date")}T00:00:00+08:00`) + 86400000;
        const pageSize = Number(url.searchParams.get("page_size")) > 1000 ? 20 : Number(url.searchParams.get("page_size")) || 20;
        const page = Number(url.searchParams.get("page")) || 1;
        let rows = [];
        for (const keyId of ids) for (const day of datesBetween(url.searchParams.get("start_date"), url.searchParams.get("end_date"))) {
          if (day > dayKeyInTz(now(), timezone)) continue;
          const dayRecords = recordsOf ? recordsOf(keyId, day) : [{ atMs: Date.parse(`${day}T12:00:00+08:00`), usd: Number(dayUsageUsd(keyId, day)) || 0 }];
          for (const record of dayRecords) if (record.usd > 0 && record.atMs >= startMs && record.atMs < endMs && record.atMs <= now()) rows.push({ keyId, ...record });
        }
        rows.sort((x, y) => x.atMs - y.atMs || x.keyId - y.keyId);
        if (url.searchParams.get("sort_order") !== "asc") rows.reverse();
        const items = rows.slice((page - 1) * pageSize, page * pageSize).map((row, index) => ({ id: (page - 1) * pageSize + index + 1, api_key_id: row.keyId,
          created_at: new Date(row.atMs).toISOString(), actual_cost: row.usd, total_cost: row.usd }));
        onUsagePage?.({ page, query: Object.fromEntries(url.searchParams), rows });
        return reply(200, { items, total: rows.length, page, page_size: pageSize, pages: Math.ceil(rows.length / pageSize) });
      }
      return reply(404, null);
    },
  };
}

// 每把 Key 的用量窗口 [from, to)、每秒 1 美元，折成这一天（业务时区）里每 stepMs 一条的记录（每条的金额 = 这一步里的秒数）——要按时间切的测试用它造 recordsOf
export function recordsInDay(window, dateKey, stepMs = 60000) {
  const dayStart = Date.parse(`${dateKey}T00:00:00+08:00`), [from, to] = window, records = [];
  for (let at = dayStart; at < dayStart + 86400000; at += stepMs) {
    const usd = Math.max(0, Math.min(at + stepMs, to ?? Infinity) - Math.max(at, from)) / 1000;
    if (usd > 0) records.push({ atMs: at, usd });
  }
  return records;
}

// 每把 Key 的用量窗口 [from, to)（毫秒，to 为 null 是没有尽头）、每秒 1 美元，折成「这一天（业务时区）里有几秒」——测试里造 dayUsageUsd 和算真值都用它
export function secondsInDay(window, dateKey, timezone = "Asia/Shanghai") {
  const startMs = Date.parse(`${dateKey}T00:00:00+08:00`), endMs = startMs + 86400000;
  if (timezone !== "Asia/Shanghai") throw new Error("fake-sub2api 的 secondsInDay 只按 Asia/Shanghai 算");
  const [from, to] = window;
  return Math.max(0, Math.min(endMs, to ?? Infinity) - Math.max(startMs, from)) / 1000;
}
