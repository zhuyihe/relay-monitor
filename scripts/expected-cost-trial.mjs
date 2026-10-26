#!/usr/bin/env node
// 只读试算（应付成本 V1-b，总指挥 10-26 定）：一条绑定、一天，打印应付成本、实付成本、差额和没算进的模型，不写库。
// 用户上线前拿它看噪声有多大。在部署机上跑（读 .env.local / .env 里的 DB_*，或者直接给环境变量）：
//   node scripts/expected-cost-trial.mjs --rule <绑定 id> --day 2026-10-25
// 读的东西：库里的绑定和站点、这一天的账本行（实付成本、分段倍率）、整站日志的小时桶（没读完这一天会说）、上游价目表（现读一次，一个请求）。
// 不建表、不改任何行；输出里不带 Key、令牌、站点地址（只有名字和数）。
import { getPool } from "../db/pool.js";
import { Store } from "../db/store.js";
import { loadSecretKey } from "../db/secrets.js";
import { OwnLogStore } from "../server/own-log-store.js";
import { ReconciliationRepository } from "../server/reconciliation-repository.js";
import { createUpstreamPricing } from "../server/upstream-pricing.js";
import { expectedCostForDay, gapOf } from "../lib/expected-cost-day.js";
import { ledgerSettlement } from "../lib/reconciliation-ledger.js";
import { dayStartInTz, shiftedDayStartInTz } from "../lib/business-time.js";

for (const file of [".env.local", ".env"]) { try { process.loadEnvFile(file); break; } catch { /* 没有这个文件：用环境变量 */ } }

const args = Object.fromEntries(process.argv.slice(2).map((item, index, all) => item.startsWith("--") ? [item.slice(2), all[index + 1]] : null).filter(Boolean));
if (!args.rule || !/^\d{4}-\d{2}-\d{2}$/.test(args.day || "")) {
  console.error("用法：node scripts/expected-cost-trial.mjs --rule <绑定 id> --day YYYY-MM-DD");
  process.exit(2);
}

const pool = getPool();
try {
  // Store.load() 读完会把配置写回一遍（还可能建默认账号）：这里只读，把写关掉
  const store = new Store(pool, { secretKey: loadSecretKey() });
  store.save = async () => store;
  await store.load();
  const rt = { pool, store };
  const repository = new ReconciliationRepository(pool);
  const rule = await repository.getRule(args.rule);
  if (!rule) { console.error("找不到这条绑定"); process.exitCode = 1; }
  else {
    const upstream = store.get(rule.upstreamStationId), own = store.get(rule.ownStationId);
    const startMs = dayStartInTz(args.day, rule.timezone), endMs = shiftedDayStartInTz(startMs, 1, rule.timezone);
    const window = { startMs, endMs, timezone: rule.timezone };
    const entry = await repository.latestLedgerEntry(rule.id, window);
    const settlement = entry ? ledgerSettlement(entry) : null;
    const ownLog = new OwnLogStore(pool);
    const [cursor, buckets] = await Promise.all([ownLog.getCursor(own?.id), ownLog.listBuckets(own?.id, startMs, endMs)]);
    let pricing = null, pricingError = null;
    try { pricing = await createUpstreamPricing(rt).pricingFor(upstream); } catch (error) { pricingError = error; }
    const saved = settlement?.result;
    const segments = (saved?.segments || []).map((segment) => ({ startMs: segment.window?.startMs ?? startMs, endMs: segment.window?.endMs ?? endMs,
      ratio: segment.upstream?.ratio ?? segment.ratio ?? saved?.upstream?.ratio ?? null, group: segment.upstream?.group ?? segment.group ?? null }));
    const expected = expectedCostForDay({ window, buckets, channelIds: (rule.channels || []).map((channel) => channel.channelId),
      segments: segments.length ? segments : [{ startMs, endMs, ratio: saved?.upstream?.ratio ?? null, group: saved?.upstream?.group ?? null }],
      pricing, pricingError, quotaPerUnit: saved?.upstream?.quotaPerUnit ?? null,
      flags: { platform: upstream?.type ?? null, keyShared: rule.costCoverage !== "complete", groupAuto: false, coveredFromMs: cursor?.coveredFromMs ?? null, coveredToMs: cursor?.coveredToMs ?? null } });
    const actual = saved?.upstream?.amountUsd ?? null;
    const gap = gapOf(actual, expected.usd);
    const money = (value) => (value == null ? "—" : `$${Number(value).toFixed(4)}`);
    const stamp = (ms) => new Date(ms).toISOString();
    console.log(`绑定 ${rule.id}（上游「${upstream?.name ?? "?"}」，${(rule.channels || []).length} 个渠道）${args.day}（${rule.timezone}）`);
    console.log(`已固定：${settlement ? `是（第 ${entry.revision} 版，${entry.settledAt}；库里记的应付成本 ${money(entry.expectedCostUsd)}${entry.gapReason ? `，原因 ${entry.gapReason}` : ""}）` : "否（没有账本行，实付成本不知道）"}`);
    console.log(`整站日志读到：${cursor ? stamp(cursor.coveredToMs) : "（没有进度）"}${cursor && cursor.coveredToMs < endMs ? "，这一天还没读完" : ""}`);
    console.log(`应付成本（现算）：${money(expected.usd)}${expected.reason ? `（算不出：${expected.reason}）` : ""}`);
    console.log(`实付成本：${money(actual)}`);
    console.log(`差额：${gap ? `${money(gap.usd)}（${gap.rate == null ? "—" : `${(gap.rate * 100).toFixed(2)}%`}，${gap.state}）` : "—"}`);
    console.log(`Token：${expected.tokens}`);
    for (const row of expected.byModel) console.log(`  ${row.model}${row.upstreamModel ? ` → ${row.upstreamModel}` : ""}：${row.requests} 次，输入 ${row.inputTokens}，输出 ${row.outputTokens}，缓存读 ${row.cacheReadTokens}，缓存写 ${row.cacheWriteTokens}，${money(row.usd)}`);
    for (const row of expected.missingPriceModels) console.log(`  没算进（上游没给价格）：${row.model}${row.upstreamModel ? ` → ${row.upstreamModel}` : ""}，${row.requests} 次`);
    for (const row of expected.segments) console.log(`  分段 ${stamp(row.startMs)} ~ ${stamp(row.endMs)} 倍率 ${row.ratio}${row.group ? `（${row.group}）` : ""}：${money(row.usd)}`);
    for (const row of expected.byChannel) console.log(`  渠道 ${row.channelId}：${money(row.usd)}`);
  }
} finally {
  await pool.end();
}
