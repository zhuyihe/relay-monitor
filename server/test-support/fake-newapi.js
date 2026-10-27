// 假的 New API 上游（测试共用，第二个上游用）：只实现对账读上游的几个接口，按 Key 名字、按时间回用量（量钱对不对用）。
//   GET /api/user/self                   → { id }
//   GET /api/status                      → { quota_per_unit }
//   GET /api/user/self/groups            → { <组>: { ratio } }
//   GET /api/token/                      → { total, items: [{ id, user_id, name, status, group, key（打码） }] }
//   GET /api/log/self/stat?token_name&start_timestamp&end_timestamp → { quota }
// usageQuota(tokenName, startSec, endSec（含）) 给用量（额度）；quota_per_unit 是 100，所以额度 / 100 = 美元。
export function createFakeNewApi({ accountId = 7, keys, usageQuota, group = "g1", ratio = 1, quotaPerUnit = 100 }) {
  const reply = (data) => ({ status: 200, text: async () => JSON.stringify({ success: true, data }) });
  const calls = [];
  return {
    calls,
    handle(url) {
      calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
      if (url.pathname === "/api/user/self") return reply({ id: accountId });
      if (url.pathname === "/api/status") return reply({ quota_per_unit: quotaPerUnit, version: "v" });
      if (url.pathname === "/api/user/self/groups") return reply({ [group]: { ratio } });
      if (url.pathname === "/api/token/") {
        return reply({ total: keys.length, items: keys.map((key) => ({ id: key.id, user_id: accountId, name: key.name, status: 1, group, cross_group_retry: false, key: key.masked })) });
      }
      if (url.pathname === "/api/log/self/stat") {
        return reply({ quota: usageQuota(url.searchParams.get("token_name"), Number(url.searchParams.get("start_timestamp")), Number(url.searchParams.get("end_timestamp"))) });
      }
      return { status: 404, text: async () => JSON.stringify({ success: false }) };
    },
  };
}
