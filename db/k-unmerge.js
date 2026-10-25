// 把「合并重复的上游」（K1a）改回去：照 upstream_merge_log 一条条改回，上游重新出现、绑定和看余额的关联指回原来的上游。
// 先不带参数运行，列出要改什么；确认后加 --apply 才真的改。要停掉服务再运行（服务把上游文档放在内存里，改完要重启才看得到）。
// 只想改回其中一次：加 --merge <编号>（编号在列出的第一行）。账本不动，改回也不触发重结。
// 用法见 deploy/README.md「合并重复上游以后想改回去」
import { getPool } from "./pool.js";
import { describeUndo, listMerges, undoMergeRows } from "./upstream-merge-repository.js";
import { errorLogLine } from "../lib/log.js";

// 返回 { merges, applied }；apply 时每一次合并各开一个事务，从最新的一次开始改回
export async function undoMerges(pool, { mergeId = null, apply = false, now = Date.now() } = {}) {
  const merges = await listMerges(pool, { mergeId });
  if (!apply) return { merges, applied: [] };
  const applied = [];
  for (const merge of merges) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await undoMergeRows(conn, merge, { nowMs: now });
      await conn.commit();
      applied.push(merge.mergeId);
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  return { merges, applied };
}

export function undoReportLines({ merges, applied }) {
  if (!merges.length) return ["没有可以改回的合并。"];
  const lines = [];
  for (const merge of merges) lines.push(...describeUndo(merge));
  lines.push(applied.length
    ? "已全部改回。现在重启服务，被合并的上游才会重新出现、重新轮询。"
    : "看清楚上面的内容。确认要改回的话，加 --apply 再运行一次：node db/k-unmerge.js --apply（先停掉服务）");
  return lines;
}

// 独立运行：node db/k-unmerge.js [--merge <编号>] [--apply]
if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile(".env"); } catch {}
  try { process.loadEnvFile(".env.local"); } catch {}
  const at = process.argv.indexOf("--merge");
  const mergeId = at >= 0 ? process.argv[at + 1] || null : null;
  const pool = getPool();
  try {
    const report = await undoMerges(pool, { mergeId, apply: process.argv.includes("--apply") });
    for (const line of undoReportLines(report)) console.log(line);
  } catch (err) {
    // 只记码和一句话：mysql2 的报错上挂着整条 SQL
    console.error("没有改回，这一次合并什么都没动：", errorLogLine(err));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
