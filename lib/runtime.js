// 应用运行时单例：连库→建表→载入 Store（解开加密的登录信息和会话密钥）/History→启动后台任务。
// Next.js 下用 globalThis 缓存，HMR/多次 import 不会重复初始化。
// 所有 API 路由通过 getRuntime() 取服务实例（等价 v1 server.js 顶部的全局变量）。
import { getPool, ensureSchema, rehashBillingCapabilities } from "../db/pool.js";
import { Store } from "../db/store.js";
import { loadSecretKey, META_SECRETS, SECRET_TEXT } from "../db/secrets.js";
import { History } from "../db/history.js";
import { BRAND } from "./brand.js";
import { SessionManager, loginLimitSourceText } from "./auth.js";

function logSecretStorage({ encrypted, keyId, converted, rotated }) {
  if (!encrypted) { console.warn(`  ${SECRET_TEXT.plaintext}`); return; }
  console.log(`  登录信息加密保存（密钥编号 ${keyId}）`);
  if (converted) console.log(`  已把 ${converted} 处明文保存的登录信息改成加密保存`);
  for (const item of META_SECRETS) if (rotated.includes(item.key)) console.log(`  ${item.rotated}`);
}

async function init() {
  const pool = getPool();
  await ensureSchema(pool);
  // v1 数据迁移不在此处：db/migrate.js 引用 stations.json 等字面量会被 Next
  // 构建追踪连真实凭证一起拷进 standalone 产物。迁移由部署入口显式执行
  //（Docker CMD 链式 node db/migrate.js，或本地 npm run db:migrate），幂等且库非空即跳过。

  // 主密钥在这里才读（next build 时没有这个变量也不报错）；格式不对、库里有密文却没配、解不开，都会在这一步中止启动
  const store = await new Store(pool, { secretKey: loadSecretKey() }).load();
  logSecretStorage(store.secretReport);
  const loginLimit = loginLimitSourceText();
  console[loginLimit.level](`  ${loginLimit.text}`);
  // 每次启动都处理 legacy 行，包括回滚期间旧程序新写的摘要；已包装的身份不再包装。
  const rehashed = await rehashBillingCapabilities(pool, store.billingIdentityKey);
  if (rehashed.migrated) console.log(`  已包装 ${rehashed.migrated} 条旧格式 Sub2API 账单能力身份`);
  if (rehashed.invalid) console.warn(`  跳过 ${rehashed.invalid} 条格式不对的旧 Sub2API 账单能力记录（BILLING_IDENTITY_INVALID），它们对不上任何上游`);
  const history = await new History(pool, () => store.settings.historyRetentionDays).load();
  const sessions = new SessionManager(null);
  sessions.secret = store.sessionSecret;

  const rt = { pool, store, history, sessions, startedAt: Date.now() };

  // 后台任务：演示站播种 → 全量刷新 → 定时轮询 + 每日日报
  //（模块由 server/ 提供；动态导入使地基阶段也能先行启动）
  try {
    const { seedDemo } = await import("../server/demo.js");
    await seedDemo(rt);
  } catch (err) {
    console.error("  演示站模块未就绪:", err?.message);
  }
  try {
    const { refreshAll, restartPolling } = await import("../server/refresh.js");
    rt.refreshAll = refreshAll;
    rt.restartPolling = restartPolling;
    refreshAll(rt).catch(() => {});
    restartPolling(rt);
  } catch (err) {
    console.error("  后台刷新模块未就绪:", err?.message);
  }
  try {
    const { startReportScheduler } = await import("../server/report.js");
    startReportScheduler(rt);
  } catch (err) {
    console.error("  日报调度模块未就绪:", err?.message);
  }
  try {
    const { startChannelOnboarding } = await import("../server/channel-onboarding.js");
    await startChannelOnboarding(rt);
  } catch (err) {
    console.error("  渠道接入模块未就绪:", err?.message);
  }
  try {
    const { startReconciliationPolling } = await import("../server/reconciliation.js");
    rt.reconciliation = startReconciliationPolling(rt);
  } catch (err) {
    console.error("  渠道对账模块未就绪:", err?.message);
  }

  console.log(`\n  ${BRAND.productName}已就绪（数据服务：${process.env.DB_HOST || "127.0.0.1"}/${process.env.DB_NAME || "relay_monitor"}）\n`);
  return rt;
}

export function getRuntime() {
  // 初始化失败不缓存失败态：下次调用重试（例如 MySQL 短暂不可用）
  if (!globalThis.__RELAY_RT) {
    globalThis.__RELAY_RT = init().catch((err) => {
      globalThis.__RELAY_RT = null;
      throw err;
    });
  }
  return globalThis.__RELAY_RT;
}
