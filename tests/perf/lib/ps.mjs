// performance_schema 语句摘要的快照与差值（只看夹具库 DB_NAME）；binlog 总大小。
// 不清空全局统计（别的会话可能在用），用前后两次快照相减。
import { APP_DIR, DB_ENV, DB_NAME } from "./env.mjs";

const { default: mysql } = await import(`${APP_DIR}/node_modules/mysql2/promise.js`);
export async function connect(database = DB_NAME) {
  return mysql.createConnection({ host: DB_ENV.DB_HOST, port: Number(DB_ENV.DB_PORT), user: DB_ENV.DB_USER, password: DB_ENV.DB_PASSWORD,
    database, multipleStatements: false });
}

export async function digestSnapshot(conn) {
  const [rows] = await conn.query(`SELECT DIGEST, DIGEST_TEXT, QUERY_SAMPLE_TEXT, COUNT_STAR, SUM_TIMER_WAIT, MAX_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_ROWS_SENT,
    SUM_ROWS_AFFECTED, SUM_NO_INDEX_USED, SUM_NO_GOOD_INDEX_USED, SUM_CREATED_TMP_DISK_TABLES, SUM_SORT_ROWS
    FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME = ?`, [DB_NAME]);
  return new Map(rows.map((r) => [r.DIGEST, r]));
}

const N = (v) => Number(v || 0);
export function digestDiff(before, after) {
  const out = [];
  for (const [digest, b] of after) {
    const a = before.get(digest);
    const count = N(b.COUNT_STAR) - N(a?.COUNT_STAR);
    if (count <= 0) continue;
    out.push({ digest, text: b.DIGEST_TEXT, sample: b.QUERY_SAMPLE_TEXT, count,
      totalMs: (N(b.SUM_TIMER_WAIT) - N(a?.SUM_TIMER_WAIT)) / 1e9, maxMs: N(b.MAX_TIMER_WAIT) / 1e9,
      rowsExamined: N(b.SUM_ROWS_EXAMINED) - N(a?.SUM_ROWS_EXAMINED), rowsSent: N(b.SUM_ROWS_SENT) - N(a?.SUM_ROWS_SENT),
      rowsAffected: N(b.SUM_ROWS_AFFECTED) - N(a?.SUM_ROWS_AFFECTED),
      noIndex: N(b.SUM_NO_INDEX_USED) - N(a?.SUM_NO_INDEX_USED), noGoodIndex: N(b.SUM_NO_GOOD_INDEX_USED) - N(a?.SUM_NO_GOOD_INDEX_USED),
      tmpDisk: N(b.SUM_CREATED_TMP_DISK_TABLES) - N(a?.SUM_CREATED_TMP_DISK_TABLES), sortRows: N(b.SUM_SORT_ROWS) - N(a?.SUM_SORT_ROWS) });
  }
  return out.sort((x, y) => y.totalMs - x.totalMs);
}

export async function binlogBytes(conn) {
  try {
    const [rows] = await conn.query("SHOW BINARY LOGS");
    return rows.reduce((sum, r) => sum + N(r.File_size), 0);
  } catch { return null; }
}

// 语句按表归类（看是哪个后台任务）
export function tableOf(text) {
  const m = String(text || "").match(/(?:FROM|INTO|UPDATE|JOIN)\s+`?(\w+)`?/i);
  return m ? m[1] : (String(text || "").split(/\s+/)[0] || "?");
}
export function kindOf(text) {
  const t = String(text || "").trim().toUpperCase();
  for (const k of ["SELECT", "INSERT", "UPDATE", "DELETE", "START", "COMMIT", "ROLLBACK", "SET", "SHOW"]) if (t.startsWith(k)) return k;
  return t.split(/\s+/)[0];
}

// 看门狗：夹具库里跑了 maxSec 秒还没完的查询直接 KILL QUERY（只会是 APP_PORT 上自己起的服务发的），
// 返回杀掉的语句（证据写进结果）。测量期间每 5 秒查一次。
export function startWatchdog(maxSec, onKill = () => {}) {
  const killed = [];
  let conn = null, busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      conn ||= await connect();
      const [rows] = await conn.query("SELECT id, time, info FROM information_schema.processlist WHERE db = ? AND command = 'Query' AND time >= ? AND info NOT LIKE '%processlist%'", [DB_NAME, maxSec]);
      for (const r of rows) {
        await conn.query(`KILL QUERY ${Number(r.id)}`).catch(() => {});
        const item = { at: new Date().toISOString(), seconds: Number(r.time), sql: String(r.info || "").replace(/\s+/g, " ").slice(0, 300) };
        killed.push(item); onKill(item);
      }
    } catch { /* 下次再查 */ }
    busy = false;
  }, 5000);
  return { killed, stop: async () => { clearInterval(timer); await conn?.end().catch(() => {}); } };
}
