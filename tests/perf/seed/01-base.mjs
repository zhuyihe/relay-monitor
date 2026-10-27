// 第 1 步（服务没起）：重建夹具库（DB_NAME，名字里要带 perf），建表，用应用自己的 Store 写自营站点、面板账号、通知方式。
// 上游和绑定在第 2 步走接入接口建（和页面上「接入渠道」同一条路）。
import { DB_ENV, DB_NAME, APP_DIR, progress, assertPerfDatabase } from "../lib/env.mjs";
import { OWN, BASE, OWN_PORT } from "../lib/model.mjs";
import { KEY_AGENT_SECRET } from "../lib/key-agent-protocol.mjs";

// 渠道 Key 读取服务（K2a/K2b 量夹具，PERF_KEY_AGENT=on 才配）：读取服务就在假站点自己身上（和真实部署「装在自营 New API 旁边」
// 一个道理），地址指到 OWN_PORT 的 /key-agent。被测版本没有这两个字段时 Store.add 会原样丢掉，不报错——量的就是这个差
const KEY_AGENT_ON = /^(1|on|true)$/i.test(process.env.PERF_KEY_AGENT ?? "");

const { default: mysql } = await import(`${APP_DIR}/node_modules/mysql2/promise.js`);
assertPerfDatabase();
const admin = await mysql.createConnection({ host: DB_ENV.DB_HOST, port: Number(DB_ENV.DB_PORT), user: DB_ENV.DB_USER, password: DB_ENV.DB_PASSWORD });
await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
await admin.query(`CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await admin.end();

const { getPool, ensureSchema } = await import(`${APP_DIR}/db/pool.js`);
const { Store } = await import(`${APP_DIR}/db/store.js`);
const pool = getPool();
await ensureSchema(pool);
const store = await new Store(pool, { secretKey: null }).load();
await store.setPassword("admin", "admin123");
await store.updateSettings({ refreshIntervalSec: 60, lowBalanceUsd: 5, dailyReport: { enabled: false, time: "09:00", channelIds: [] } });
const own = await store.add({ name: "自营站点", type: "newapi", baseUrl: OWN.baseUrl, accessToken: OWN.accessToken, userId: OWN.userId,
  isOwn: true, includeInProfit: true, cnyPerUsd: 7.2,
  resoldAdminKeys: [{ username: "admin2", tokenName: "u2-k1" }, { username: "ops3", tokenName: "u3-k1" }],
  ...(KEY_AGENT_ON ? { keyAgentUrl: `http://127.0.0.1:${OWN_PORT}/key-agent`, keyAgentSecret: KEY_AGENT_SECRET } : {}) });
const wecom = await store.addChannel({ type: "wecom", name: "运营群", config: { webhook: `${BASE}/hook/wecom` } });
const ntfy = await store.addChannel({ type: "ntfy", name: "值班 ntfy", config: { topic: "relay-perf", server: `${BASE}/hook/ntfy` } });
await store.updateRules({ etaDays: 3, errorThreshold: 3, errorRetrySec: 60, renotifyHours: 12 });
await store.updateSettings({ dailyReport: { enabled: true, time: "09:00", channelIds: [wecom.id] } });
progress(`种子 1：库 ${DB_NAME} 已重建，自营站点 ${own.id}，通知方式 ${wecom.id} ${ntfy.id}${KEY_AGENT_ON ? "，渠道 Key 读取服务已配（量 K2a/K2b 用）" : ""}`);
await pool.end();
