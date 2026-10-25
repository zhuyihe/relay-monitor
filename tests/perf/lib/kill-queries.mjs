// 停服务以后，它在 MySQL 里发出去的慢查询还会接着跑（比如经营分析热力图那条），一并 KILL QUERY（只看夹具库 DB_NAME）。
// 用法：node lib/kill-queries.mjs（库还没建时什么也不做）
import { DB_NAME } from "./env.mjs";
import { connect } from "./ps.mjs";

const conn = await connect(null).catch(() => null);
if (conn) {
  try {
    const [rows] = await conn.query("SELECT id FROM information_schema.processlist WHERE db = ? AND command = 'Query' AND id <> CONNECTION_ID()", [DB_NAME]);
    for (const r of rows) await conn.query(`KILL QUERY ${Number(r.id)}`).catch(() => {});
    if (rows.length) console.log(`停服务：KILL 了 ${rows.length} 条还在跑的查询`);
  } finally { await conn.end().catch(() => {}); }
}
