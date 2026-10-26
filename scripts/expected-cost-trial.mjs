#!/usr/bin/env node
// 只读试算（应付成本 V1-b，总指挥 10-26 定）：一条绑定、一天，打印应付成本、实付成本、差额和没算进的模型，不写库。
// 用户上线前拿它看噪声有多大。在服务器上跑（读 .env 里的库）：
//   node scripts/expected-cost-trial.mjs --rule <绑定 id> --day 2026-10-25
// 读的东西：库里的绑定和站点、这一天的账本行（实付成本、分段倍率）、整站日志的小时桶（没读完这一天会说）、上游价目表（现读一次）。
// 输出里不带 Key、令牌、站点地址（只有名字和数）。
import { loadRuntime } from "../lib/runtime.js";
import { createReconciliationModule } from "../server/reconciliation.js";
import { OwnLogStore } from "../server/own-log-store.js";
import { expectedCostForDay, gapOf } from "../lib/expected-cost-day.js";
import { ledgerSettlement } from "../lib/reconciliation-ledger.js";
import { dayStartInTz, shiftedDayStartInTz } from "../lib/business-time.js";

const args = Object.fromEntries(process.argv.slice(2).map((item, index, all) => item.startsWith("--") ? [item.slice(2), all[index + 1]] : null).filter(Boolean));
if (!args.rule || !/^\d{4}-\d{2}-\d{2}$/.test(args.day || "")) {
  console.error("用法：node scripts/expected-cost-trial.mjs --rule <绑定 id> --day YYYY-MM-DD");
  process.exit(2);
}

const rt = await loadRuntime();
const module = createReconciliationModule(rt, { ownLogIngest: false });
const repository = module.repository;
const rule = await repository.getRule(args.rule);
if (!rule) { console.error("找不到这条绑定"); process.exit(1); }
const upstream = rt.store.get(rule.upstreamStationId), own = rt.store.get(rule.ownStationId);
const startMs = dayStartInTz(args.day, rule.timezone), endMs = shiftedDayStartInTz(startMs, 1, rule.timezone);
const window = { startMs, endMs, timezone: rule.timezone };
const entry = await repository.latestLedgerEntry(rule.id, window);
const settlement = entry ? ledgerSettlement(entry) : null;
const store = new OwnLogStore(rt.pool);
const [cursor, buckets] = await Promise.all([store.getCursor(own.id), store.listBuckets(own.id, startMs, endMs)]);
let pricing = null, pricingError = null;
try { pricing = await module.upstreamPricing(upstream); } catch (error) { pricingError = error; }
const segments = (settlement?.result?.segments || []).map((segment) => ({ startMs: segment.window?.startMs ?? startMs, endMs: segment.window?.endMs ?? endMs,
  ratio: segment.upstream?.ratio ?? segment.ratio ?? settlement?.result?.upstream?.ratio ?? null, group: segment.upstream?.group ?? segment.group ?? null }));
const expected = expectedCostForDay({ window, buckets, channelIds: (rule.channels || []).map((c) => c.channelId),
  segments: segments.length ? segments : [{ startMs, endMs, ratio: settlement?.result?.upstream?.ratio ?? null, group: settlement?.result?.upstream?.group ?? null }],
  pricing, pricingError, quotaPerUnit: settlement?.result?.upstream?.quotaPerUnit ?? null,
  flags: { platform: upstream?.type ?? null, keyShared: rule.costCoverage !== "complete",
    groupAuto: false, coveredToMs: cursor?.coveredToMs ?? null } });
const actual = settlement?.result?.upstream?.amountUsd ?? null;
const gap = gapOf(actual, expected.usd);
const money = (value) => (value == null ? "—" : `$${Number(value).toFixed(4)}`);
console.log(`绑定 ${rule.id}（上游「${upstream?.name ?? "?"}」，${(rule.channels || []).length} 个渠道）${args.day}（${rule.timezone}）`);
console.log(`已固定：${settlement ? `是（第 ${entry.revision} 版，${entry.settledAt}）` : "否（没有账本行）"}`);
console.log(`整站日志读到：${cursor ? new Date(cursor.coveredToMs).toISOString() : "（没有进度）"}${cursor && cursor.coveredToMs < endMs ? "，这一天还没读完" : ""}`);
console.log(`应付成本：${money(expected.usd)}${expected.reason ? `（算不出：${expected.reason}）` : ""}`);
console.log(`实付成本：${money(actual)}`);
console.log(`差额：${gap ? `${money(gap.usd)}（${gap.rate == null ? "—" : `${(gap.rate * 100).toFixed(2)}%`}，${gap.state}）` : "—"}`);
console.log(`Token：${expected.tokens}`);
for (const row of expected.byModel) console.log(`  ${row.model}${row.upstreamModel ? ` → ${row.upstreamModel}` : ""}：${row.requests} 次，输入 ${row.inputTokens}，输出 ${row.outputTokens}，缓存读 ${row.cacheReadTokens}，缓存写 ${row.cacheWriteTokens}，${money(row.usd)}`);
for (const row of expected.missingPriceModels) console.log(`  没算进（上游没给价格）：${row.model}${row.upstreamModel ? ` → ${row.upstreamModel}` : ""}，${row.requests} 次`);
for (const row of expected.segments) console.log(`  分段 ${new Date(row.startMs).toISOString()} ~ ${new Date(row.endMs).toISOString()} 倍率 ${row.ratio}${row.group ? `（${row.group}）` : ""}：${money(row.usd)}`);
await rt.pool?.end?.();
