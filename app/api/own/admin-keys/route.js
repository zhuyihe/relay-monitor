// ---- 管理员/root API Key 转售标记 ---------------------------------------------
import { withAuth, json } from "../../../../lib/api.js";
import { ownStationErrorCode } from "../../../../lib/error-copy.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { queryAdminTokens } from "../../../../lib/providers.js";
import { ownCache, getOwnUsers } from "../../../../server/own-helpers.js";

// 列出所有管理员/root 账号（role>=10）名下的 API Key，标注哪些已被标记为转售。
export const GET = withAuth(async (request, rt) => {
  const { store } = rt;
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  try {
    const users = await getOwnUsers(rt, own);
    const admins = (users || []).filter((u) => u.role >= 10);
    const resold = own.resoldAdminKeys || [];
    const flagged = new Set(resold.map((k) => `${k.username} ${k.tokenName}`));
    const accounts = [];
    for (const u of admins) {
      // new-api 的 /api/token/ 只能列「当前登录账号」名下的 Key，无法用 New-Api-User
      // 越权枚举其它账号（如 root）；此时 enumerable=false，前端退回手动填 Key 名。
      try {
        const tokens = (await queryAdminTokens(own, u.id)).map((t) => ({
          name: t.name,
          status: t.status,
          usedUsd: Math.round(t.usedUsd * 100) / 100,
          flagged: flagged.has(`${u.username} ${t.name}`),
        }));
        accounts.push({ username: u.username, role: u.role, enumerable: true, tokens: tokens.sort((a, b) => b.usedUsd - a.usedUsd) });
      } catch (err) {
        // 无法枚举：仍回显该账号已标记的 Key，让用户能看到/取消
        const names = resold.filter((k) => k.username === u.username).map((k) => k.tokenName);
        accounts.push({
          username: u.username, role: u.role, enumerable: false,
          error: err?.message || String(err),
          errorCode: ownStationErrorCode(err),
          tokens: names.map((name) => ({ name, flagged: true, usedUsd: null })),
        });
      }
    }
    return json({ accounts });
  } catch (err) {
    // 读自营站点没成：码由 ownStationErrorCode 给（lib/error-copy.js，§8.2）——通用的繁忙、连不上和认不出的说「自营站点暂时读不到」，
    // 内容不对的说「自营站点返回的内容不对」，有自己那句话的码照旧
    return json({ error: err?.message || String(err), code: ownStationErrorCode(err) }, 502);
  }
});

// 保存转售 Key 标记：body { keys: [{username, tokenName}] }
export const PUT = withAuth(async (request, rt) => {
  const { store } = rt;
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  const body = await request.json().catch(() => ({}));
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  await store.update(own.id, { resoldAdminKeys: keys });
  ownCache(rt).clear(); // 影响利润口径，清缓存让下次分析重算
  return json({ resoldAdminKeys: own.resoldAdminKeys });
});
