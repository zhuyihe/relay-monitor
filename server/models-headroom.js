// 模型供需「高峰余量」要的输入：只读库里已经存好的计数（错误日志小时桶、整站消费日志小时桶）和 server/models-page.js 已经读到的数据，不新增对自营站点的读取。
// 读好以后交给 lib/models-headroom.js 的纯函数算；整页和抽屉共用这一份结果（跟着整页一起缓存 10 分钟）。
import { channelUpstreamMap, queryErrorSupply, queryRejectedUsers } from "./own-error-supply.js";
import { HEADROOM, buildHeadroom } from "../lib/models-headroom.js";

const HOUR_MS = 3600000, DAY_MS = 86400000;

// ctx：{ own, now, tz, modelRows（数据看板按模型的小时行）, channels（自营渠道列表）, rules（这个自营站点现在在算的绑定）, upstreams（Map，见 models-page.js）, weekUsd（Map）, small（Set）}
// 返回 { page, detailOf } 或 null（没有数据库，或者读库出错：老页面照常，headroom 是 null）
export async function readHeadroom(rt, ctx) {
  const errors = rt._ownErrorStore, consume = rt._ownLogStore;
  if (!rt.pool || !errors || !consume) return null;
  const { own, now, tz } = ctx;
  try {
    const settings = rt.store?.settings || {};
    const channelUpstream = channelUpstreamMap(ctx.rules, own.id);
    const [supply, rejectedUsers, errorCursor, consumeCursor, latest] = await Promise.all([
      queryErrorSupply({ errors, consume, stationId: own.id, fromMs: now - HEADROOM.WINDOW_DAYS * DAY_MS, toMs: now, channelUpstream, tz, retry: rt.reconciliation?.ownRetrySettings?.(own) ?? null, maxRows: HEADROOM.MAX_BUCKET_ROWS }),
      queryRejectedUsers({ errors, stationId: own.id, fromMs: now - 24 * HOUR_MS, toMs: now }),
      errors.getCursor(own.id), consume.getCursor(own.id), errors.latestSlot(own.id),
    ]);
    // 用户名和重点用户：用户运营页读到的（没有就只有编号）
    const usersById = new Map();
    for (const user of rt.userOps?.getUsers?.() || []) usersById.set(Number(user.id), { name: user.username, key: false });
    for (const id of rt._userOpsView?.bigIds || []) { const user = usersById.get(Number(id)); if (user) user.key = true; }
    const channels = ctx.channels.map((channel) => {
      const info = channelUpstream.get(Number(channel.id));
      return { channelId: Number(channel.id), name: channel.name, state: ({ 1: "on", 3: "auto" })[channel.status] || "off", models: channel.models || [], upstreamId: info?.upstreamStationId != null ? String(info.upstreamStationId) : null, ruleId: info?.ruleId ?? null };
    });
    const result = buildHeadroom({
      now, tz,
      errorLog: { switchOn: settings.ownErrorLog !== false, cursor: errorCursor, hasRecords: latest != null },
      consume: { on: settings.expectedCost === true && !!consumeCursor, cursor: consumeCursor },
      modelHours: ctx.modelRows.map((row) => ({ model: row.key, t: row.t, requests: row.requests || 0, cost: row.cost || 0 })),
      cells: supply.cells, byModelHour: supply.byModelHour, rejectedUsers, usersById, channels, upstreams: ctx.upstreams, weekUsd: ctx.weekUsd, small: ctx.small,
    });
    // 动作链接要去的地方：公开地址，不给令牌和账号
    const links = { own: String(own.baseUrl || "").replace(/\/+$/, "") || null, upstreams: {} };
    for (const card of result.page.upstreams) if (card.upstreamId != null) { const up = ctx.upstreams.get(card.upstreamId); links.upstreams[card.upstreamId] = up?.baseUrl ? { baseUrl: up.baseUrl, type: up.type } : null; }
    result.page.links = links;
    return result;
  } catch (error) {
    console.debug("models-headroom", error?.code || error?.message || "failed"); // TOO_MANY_BUCKETS：桶太多这次不算
    return null;
  }
}
