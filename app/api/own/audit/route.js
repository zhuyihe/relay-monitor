// ---- 「我的站点」日志精算（补上看板漏计的缓存 token 与长上下文）----------------
// 看板（/api/data/）的 token_used 只写 prompt+completion，缓存读写与倍率都不在里面，
// 于是 Claude 这类缓存占九成的模型会显示成「token 近零、消费很大」。本接口翻消费日志
// 明细把真实 token 与长上下文请求算出来，开销大，按需触发并缓存 5 分钟。
import { withAuth, json } from "../../../../lib/api.js";
import { ownStationErrorCode } from "../../../../lib/error-copy.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { queryOwnLogAudit } from "../../../../lib/providers.js";
import { resolveOwnWindow } from "../../../../server/own-helpers.js";

const MAX_ROWS_CAP = 20000;

export const GET = withAuth(async (request, rt) => {
  const { store } = rt;
  const own = store.list().find((s) => s.isOwn && s.type === "newapi");
  if (!own) {
    return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  }
  const sp = new URL(request.url).searchParams;
  const { range, tz, now, startMs } = resolveOwnWindow(sp);
  const model = String(sp.get("model") || "").slice(0, 100);
  const username = String(sp.get("user") || "").slice(0, 100);
  const group = String(sp.get("group") || "").slice(0, 100);
  const maxRows = Math.min(MAX_ROWS_CAP, Math.max(100, Number(sp.get("maxRows")) || 4000));
  const longContextTokens = Math.max(1000, Number(sp.get("longCtx")) || 200000);

  const cache = (rt._ownAuditCache ||= new Map());
  const cacheKey = [range, tz, model, username, group, maxRows, longContextTokens].join("|");
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 300000) return json(hit.payload);

  try {
    const audit = await queryOwnLogAudit(own, {
      startMs, endMs: now, model, username, group, maxRows, longContextTokens,
    });
    const payload = {
      range, tz, startMs, endMs: now,
      station: { id: own.id, name: own.name, cnyPerUsd: own.cnyPerUsd ?? null },
      filters: { model, user: username, group },
      maxRows, maxRowsCap: MAX_ROWS_CAP,
      ...audit,
      generatedAt: new Date().toISOString(),
    };
    // 缓存只留最近几组过滤条件，避免长期占内存
    if (cache.size > 12) cache.clear();
    cache.set(cacheKey, { at: Date.now(), payload });
    return json(payload);
  } catch (err) {
    // 读自营站点没成：码由 ownStationErrorCode 给（lib/error-copy.js，§8.2）——通用的繁忙、连不上和认不出的说「自营站点暂时读不到」，
    // 内容不对的说「自营站点返回的内容不对」，有自己那句话的码照旧
    return json({ error: err?.message || String(err), code: ownStationErrorCode(err) }, 502);
  }
});
