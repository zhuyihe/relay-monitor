import { forgetOwnLog } from "../../../../server/own-log-store.js";

// 历史必须先物理清除再移除资源文档。清除失败时资源仍在，管理员可以安全重试。
export async function purgeStation(rt, stationId) {
  if (!rt.store.get(stationId)) return { ok: false, alreadyPurged: false };
  await rt.history.purge(stationId);
  await forgetOwnLog(rt, stationId); // 整站日志的进度和桶（应付成本 V1）
  return { ok: await rt.store.remove(stationId), alreadyPurged: false };
}
