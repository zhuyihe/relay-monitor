// 按渠道开始 / 停止算利润的钱（K2c-1）：真接入向导 + 真对账模块（内存仓库）+ 假上游，走 channel-profit 的 start / stop，逐天核——
// 每天所有行（含已归档的）的成本之和 = 各 Key 当天（按下限和整天规则该算的那部分）用量之和。
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../db/store.js";
import { createReconciliationModule } from "./reconciliation.js";
import { createChannelOnboardingModule } from "./channel-onboarding.js";
import { MemoryReconciliationRepository } from "./test-support/reconciliation-memory-repository.js";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";
import { createFakeSub2Api } from "./test-support/fake-sub2api.js";
import { createChannelProfitModule } from "./channel-profit.js";
import { canonicalBillingKey } from "../lib/reconciliation-scope-policy.js";
import { reconciliationIssue } from "../lib/reconciliation-contract.js";

const SH = (iso) => Date.parse(`${iso}+08:00`);
const KEY_AGENT_SECRET = "K7m2-xP9q" + "R4t".repeat(10);
const DAY = 86400;

async function setup(t, { upstreamType, keys = [9, 10, 11, 12], channelKey = { 1: 9, 2: 9, 3: 9, 4: 10, 5: 11, 6: 12 }, windows = {}, elsewhere = {}, rates = {}, noAgent = false, standardRatio = null, tokenGroups = {}, groupRatios = { g1: 1 }, secondKeys = null }) {
  const state = { now: SH("2026-10-10T09:00:00") };
  t.mock.method(Date, "now", () => state.now);
  // windows[keyId] = [fromMs, toMs)：这把 Key 有用量的时段（每秒 1 美元）；没给就是一直在用
  const used = (keyId, fromMs, toMs) => { const [a, b] = windows[keyId] || [-Infinity, Infinity]; return Math.max(0, Math.min(toMs, b, state.now) - Math.max(fromMs, a)) / 1000 * (rates[keyId] ?? 1); };
  const fake = upstreamType === "sub2api" ? createFakeSub2Api({ keys: keys.map((id) => ({ id, name: `Key ${id}` })),
    dayUsageUsd: (id, day) => { const start = SH(`${day}T00:00:00`); return used(Number(id), start, start + DAY * 1000); }, now: () => state.now,
    // standardRatio：标准计费（total_cost）= 实际扣除 × 这个数（倍率 = 实际 ÷ 标准）；不给就和实际扣除一样
    standardUsd: standardRatio ? (id, day) => { const start = SH(`${day}T00:00:00`); return used(Number(id), start, start + DAY * 1000) * standardRatio; } : undefined }) : null;
  const reply = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push(`${url.host}${url.pathname}`);
    if (url.host === "up.test" || (secondKeys && url.host === "up2.test")) {
      const ids = url.host === "up.test" ? keys : secondKeys;
      if (fake) { const hit = fake.handle(url); if (hit) return hit; return reply({ code: 404 }, 404); }
      if (url.pathname === "/api/user/self") return reply({ success: true, data: { id: 42, quota: 100, used_quota: 1 } });
      if (url.pathname === "/api/status") return reply({ success: true, data: { quota_per_unit: 100 } });
      if (url.pathname === "/api/user/self/groups") return reply({ success: true, data: Object.fromEntries(Object.entries(groupRatios).map(([group, ratio]) => [group, { ratio }])) });
      if (url.pathname === "/api/token/") return reply({ success: true, data: { total: ids.length, items: ids.map((id) => ({ id, user_id: 42, name: `Key ${id}`, status: 1, group: tokenGroups[id] ?? "g1", cross_group_retry: false })) } });
      if (url.pathname === "/api/log/self/stat") {
        // 每把 Key 每秒 1 美元（quota_per_unit 100），一直在用；未来的秒不算
        const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
        const id = Number(String(url.searchParams.get("token_name")).replace("Key ", ""));
        return reply({ success: true, data: { quota: 100 * used(id, start * 1000, (end + 1) * 1000) } });
      }
      return reply({ success: true, data: { quota: 0 } });
    }
    if (url.host === "own.test") {
      if (url.pathname === "/api/user/self") return reply({ success: true, data: { id: 1, quota: 100, used_quota: 1 } });
      if (url.pathname === "/api/status") return reply({ success: true, data: { quota_per_unit: 100 } });
      if (url.pathname === "/api/channel/") return reply({ success: true, data: { total: 7, items: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `Channel ${id}`, type: 1, status: 1, base_url: "https://up.test", group: "g1" })) } });
      if (url.pathname === "/api/log/stat" && url.searchParams.get("channel") && !url.searchParams.get("username") && !url.searchParams.get("token_name")) {
        // 收入：每个渠道每秒 2 美元（quota_per_unit 100），一直有；未来的秒不算
        const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
        return reply({ success: true, data: { quota: 200 * Math.max(0, Math.min((end + 1) * 1000, state.now) - start * 1000) / 1000 } });
      }
      if (url.pathname === "/api/option/") return reply({ success: true, data: [{ key: "LogConsumeEnabled", value: "true" }] });
      if (url.pathname === "/api/log/") return reply({ success: true, data: { items: [], total: 0 } });
      if (url.pathname === "/api/user/") { const page = Math.max(1, Number(url.searchParams.get("p") || 1)); const users = [{ id: 1, username: "root", display_name: "Root", role: 100, status: 1 }, { id: 2, username: "alice", display_name: "", role: 1, status: 1 }]; return reply({ success: true, data: { total: users.length, items: page === 1 ? users : [] } }); }
      return reply({ success: true, data: { quota: 0 } });
    }
    return reply({ success: false }, 404);
  });
  const storePool = { query: async () => [[]], getConnection: async () => ({ beginTransaction: async () => {}, query: async () => [[]], commit: async () => {}, rollback: async () => {}, release() {} }) };
  const store = new Store(storePool);
  store._metaSecrets.billing_identity_key = "channel-profit-billing-key";
  const own = await store.add({ type: "newapi", baseUrl: "https://own.test", accessToken: "admin", isOwn: true, ...(noAgent ? {} : { keyAgentUrl: "https://own.test/key-agent", keyAgentSecret: KEY_AGENT_SECRET }) });
  const supplier = await store.add(upstreamType === "sub2api" ? { name: "Up", type: "sub2api", baseUrl: "https://up.test", accessToken: "jwt", accountUse: "only_mine" }
    : { name: "Up", type: "newapi", baseUrl: "https://up.test", accessToken: "pat", accountUse: "only_mine" });
  const supplier2 = secondKeys ? await store.add({ name: "Up2", type: "newapi", baseUrl: "https://up2.test", accessToken: "pat2", accountUse: "only_mine" }) : null;
  const persisted = { catalogue: null, links: [] };
  const linkRepo = { getCatalogue: async () => persisted.catalogue, listLinks: async () => structuredClone(persisted.links),
    saveCatalogue: async (value) => { persisted.catalogue = structuredClone(value); },
    saveLinks: async (values) => { persisted.links.push(...structuredClone(values)); return structuredClone(values); } };
  const repository = new MemoryReconciliationRepository({ now: () => state.now });
  const rt = { store, pool: storePool };
  rt.reconciliation = createReconciliationModule(rt, { repository, ownLogStore: new MemoryOwnLogStore(), ownLogIngest: false });
  rt.channelOnboarding = rt.onboardingSource = await createChannelOnboardingModule(rt, { repository: linkRepo, now: () => state.now, refresh: async () => {} }).load();
  await rt.channelOnboarding.sync();
  const identified = () => ({ ok: true, status: 200, stale: false, fetchedAtMs: state.now, revealIssues: [],
    channels: Object.entries(channelKey).filter(([, tokenId]) => tokenId != null).map(([id, tokenId]) => ({ channelId: Number(id), keyless: false,
      slots: [{ index: 0, state: "identified", matches: [{ stationId: elsewhere[tokenId] ?? supplier.id, tokenId, tokenName: `Key ${tokenId}`, via: "fingerprint" }] }] })) });
  const inject = () => { const result = identified(); rt._keyAgentIdentifyCache = { at: state.now, stationId: own.id, result, lastGood: { etag: null, result, snapshotChannels: null, comparedAt: state.now } }; };
  const profit = createChannelProfitModule(rt, { identify: async () => identified() });
  const at = async (iso) => { state.now = SH(iso); inject(); await rt.channelOnboarding.sync(); };
  const round = async (iso) => { await at(iso); await rt.reconciliation.refreshDue(state.now); };
  const costOn = (day) => repository.tables.ledger.filter((row) => row.bill_date === day);
  return { state, rt, store, own, supplier, supplier2, repository, profit, at, round, costOn, requests, channelKey, used, elsewhere };
}

for (const upstreamType of ["newapi", "sub2api"]) {
  test(`开始 / 停止算利润的钱（${upstreamType}）：开始（只勾一个、两把 Key）→ 停 → 当天再开始 → 当天开始当天停 → 跨零点开始；每天各条绑定按整天算（解绑那天也整天）`, async (t) => {
    const f = await setup(t, { upstreamType });
    await f.round("2026-10-10T09:30:00");
    // D1 10:00 只勾渠道 1（Key 9 的三个渠道一起带上）、渠道 4（Key 10）
    await f.at("2026-10-10T10:00:00");
    const s1 = await f.profit.start({ ownStationId: f.own.id, channelIds: [1, 4] });
    assert.deepEqual(s1.failed, [], JSON.stringify(s1));
    assert.deepEqual(s1.started.map((item) => item.channelIds), [[1, 2, 3], [4]]);
    let rules = await f.rt.reconciliation.listRules();
    assert.equal(rules.length, 2);
    assert.ok(rules.every((rule) => rule.billingPolicy === "immediate"), JSON.stringify(rules.map((rule) => rule.billingPolicy)));
    for (const hour of ["12", "18", "23"]) await f.round(`2026-10-10T${hour}:00:00`);
    // D2 15:00 停渠道 2：Key 9 那条整条归档、三个渠道都记 optout；18:00 点渠道 3 再开始
    for (const hour of ["01", "09", "12"]) await f.round(`2026-10-11T${hour}:00:00`);
    await f.at("2026-10-11T15:00:00");
    const stop = await f.profit.stop({ ownStationId: f.own.id, channelIds: [2] });
    assert.deepEqual(stop.stopped.map((item) => item.channelIds), [[1, 2, 3]]);
    assert.deepEqual((await f.rt.reconciliation.listChannelOptouts(f.own.id)).map((row) => row.channelId), [1, 2, 3]);
    const statusAfterStop = await f.profit.status(f.own.id);
    assert.deepEqual(statusAfterStop.channels.filter((c) => c.channelId <= 3).map((c) => [c.state, c.optedOut]), [["startable", true], ["startable", true], ["startable", true]]);
    await f.round("2026-10-11T16:00:00");
    await f.at("2026-10-11T18:00:00");
    const s2 = await f.profit.start({ ownStationId: f.own.id, channelIds: [3] });
    assert.deepEqual(s2.started.map((item) => item.channelIds), [[1, 2, 3]], JSON.stringify(s2));
    assert.deepEqual(await f.rt.reconciliation.listChannelOptouts(f.own.id), []);
    // 重复点停止/开始：幂等
    const again = await f.profit.start({ ownStationId: f.own.id, channelIds: [1, 2] });
    assert.deepEqual([again.started.length, again.alreadyRunning.map((item) => item.channelId)], [0, [1, 2]]);
    await f.round("2026-10-11T23:00:00");
    // D3 10:00 开始渠道 5（Key 11），20:00 停；23:50 开始渠道 6（Key 12，跨零点）
    for (const hour of ["01", "09"]) await f.round(`2026-10-12T${hour}:00:00`);
    await f.at("2026-10-12T10:00:00");
    assert.equal((await f.profit.start({ ownStationId: f.own.id, channelIds: [5] })).started.length, 1);
    await f.round("2026-10-12T15:00:00");
    await f.at("2026-10-12T20:00:00");
    assert.equal((await f.profit.stop({ ownStationId: f.own.id, channelIds: [5] })).stopped.length, 1);
    const stopAgain = await f.profit.stop({ ownStationId: f.own.id, channelIds: [5] });
    assert.deepEqual(stopAgain, { stopped: [], optedOut: [5] }, "重复停止：没在算的只记不要算");
    await f.at("2026-10-12T23:50:00");
    assert.equal((await f.profit.start({ ownStationId: f.own.id, channelIds: [6] })).started.length, 1);
    for (const iso of ["2026-10-13T00:10:00", "2026-10-13T01:00:00", "2026-10-13T09:00:00", "2026-10-13T20:00:00", "2026-10-14T01:00:00", "2026-10-14T09:00:00", "2026-10-15T01:00:00", "2026-10-15T09:00:00", "2026-10-16T09:00:00"]) await f.round(iso);

    rules = await f.rt.reconciliation.listRules({ includeArchived: true });
    const byKey = {};
    for (const rule of rules) (byKey[rule.tokenId] ||= []).push(rule.id);
    const expected = upstreamType === "newapi" ? {
      "2026-10-10": { 9: DAY, 10: DAY },
      "2026-10-11": { 9: DAY, 10: DAY }, // 停掉的那条这天被「同一把 Key 同一天在两条绑定里」挡住（CANONICAL_KEY_CONFLICT，和以前一样），Key 只在后绑的新条上算一次；挡住的日子自动解开留给「一把 Key 一天只算在一个渠道上」的下一个 PR
      "2026-10-12": { 9: DAY, 10: DAY, 11: DAY, 12: DAY }, // Key 11 当天开始当天停：解绑那天整天算
      "2026-10-13": { 9: DAY, 10: DAY, 12: DAY },
      "2026-10-14": { 9: DAY, 10: DAY, 12: DAY },
    } : {
      "2026-10-10": { 9: DAY, 10: DAY },
      "2026-10-11": { 9: DAY, 10: DAY }, // 同 New API：旧的那条被同一把 Key 挡住，Key 只算一次
      "2026-10-12": { 9: DAY, 10: DAY, 11: DAY, 12: DAY }, // Key 11 当天开始当天停：解绑那天整天算
      "2026-10-13": { 9: DAY, 10: DAY, 12: DAY },
      "2026-10-14": { 9: DAY, 10: DAY, 12: DAY },
    };
    const report = [];
    for (const [day, perKey] of Object.entries(expected)) {
      const rows = f.costOn(day);
      for (const tokenId of [9, 10, 11, 12]) {
        const got = rows.filter((row) => (byKey[tokenId] || []).includes(row.rule_id)).reduce((sum, row) => sum + Number(row.cost_usd || 0), 0);
        report.push([day, tokenId, got, perKey[tokenId] || 0, rows.filter((row) => (byKey[tokenId] || []).includes(row.rule_id)).map((row) => `${row.rule_id}:${row.cost_usd}:${row.state ?? row.status ?? ""}`).join(",")]);
      }
    }
    const bad = report.filter(([, , got, want]) => Math.abs(got - want) > 1e-6);
    assert.deepEqual(bad, [], JSON.stringify(report, null, 1));
  });
}

test("channel-profit.start 建出的绑定和接入向导直接建的逐项相同（同一输入）", async (t) => {
  const pick = (rule) => ({ tokenId: rule.tokenId, upstream: rule.upstreamStationId, channels: rule.channels.map((c) => c.channelId).sort(), policy: rule.billingPolicy, tz: rule.timezone,
    coverage: rule.coverageDeclaration, costCoverage: rule.costCoverage, from: rule.billingEffectiveFrom, provider: rule.provider, canonical: rule.canonicalKey, floor: rule.accountingFloorMs, enabled: rule.enabled });
  const a = await setup(t, { upstreamType: "newapi" });
  await a.at("2026-10-10T10:00:00");
  await a.profit.start({ ownStationId: a.own.id, channelIds: [1] });
  const viaProfit = (await a.rt.reconciliation.listRules()).map(pick);
  const b = await setup(t, { upstreamType: "newapi" });
  await b.at("2026-10-10T10:00:00");
  const catalogue = b.rt.channelOnboarding.getSourceCatalogue();
  const input = { requestId: "11111111-1111-4111-8111-111111111111", ownStationId: b.own.id, selections: [{ selectionId: "s", stationId: b.supplier.id, monitor: true }],
    groups: [{ groupId: "g", selectionId: "s", channels: [1, 2, 3].map((channelId) => ({ channelId, channelRevision: catalogue.channels.find((c) => c.id === channelId).revision })),
      reconciliation: { tokenId: 9, coverageDeclaration: { answer: "none" } } }] };
  const probe = await b.rt.channelOnboarding.probeBatch(input);
  await b.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  const viaWizard = (await b.rt.reconciliation.listRules()).map(pick);
  assert.deepEqual(viaProfit.map((r) => ({ ...r, upstream: null, canonical: !!r.canonical })), viaWizard.map((r) => ({ ...r, upstream: null, canonical: !!r.canonical })));
});

test("同时点两次开始只建一条绑定；同时停止不报错、每个渠道只记一次不要算", async (t) => {
  const f = await setup(t, { upstreamType: "newapi" });
  await f.at("2026-10-10T10:00:00");
  const both = await Promise.allSettled([f.profit.start({ ownStationId: f.own.id, channelIds: [1] }), f.profit.start({ ownStationId: f.own.id, channelIds: [2] })]);
  assert.ok(both.every((item) => item.status === "fulfilled"));
  assert.equal((await f.rt.reconciliation.listRules()).length, 1, "同一把 Key 的渠道同一组，只建 1 条");
  const stops = await Promise.allSettled([f.profit.stop({ ownStationId: f.own.id, channelIds: [1] }), f.profit.stop({ ownStationId: f.own.id, channelIds: [3] })]);
  assert.ok(stops.every((item) => item.status === "fulfilled"), JSON.stringify(stops.map((item) => item.reason?.code)));
  const optouts = (await f.rt.reconciliation.listChannelOptouts(f.own.id)).map((row) => row.channelId);
  assert.deepEqual([...optouts].sort(), [1, 2, 3]);
});

for (const upstreamType of ["newapi", "sub2api"]) {
  test(`A 在算、当天 9 点换 Key，旧 Key 挪给新渠道 B，手动开始 B——一把 Key 一天只算在一个渠道上：换 Key 那天 Key 9 先在 A、后在 B，只算在后绑的 B 上，每天各 Key 的用量只算一次（${upstreamType}）`, async (t) => {
    const SWITCH = SH("2026-10-11T09:00:00");
    const f = await setup(t, { upstreamType, keys: [9, 20, 13], channelKey: { 1: 9, 7: 13 }, windows: { 9: [-Infinity, Infinity], 20: [SWITCH, Infinity], 13: [Infinity, Infinity] } });
    await f.at("2026-10-10T10:00:00");
    const s1 = await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
    assert.equal(s1.started.length, 1, JSON.stringify(s1));
    for (const iso of ["2026-10-10T12:00:00", "2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T08:00:00"]) await f.round(iso);
    f.channelKey[1] = 20; f.channelKey[7] = 9; // 9 点：渠道 1 换成 Key 20，Key 9 挪给渠道 7
    await f.round("2026-10-11T09:00:00");
    const ruleA = (await f.rt.reconciliation.listRules())[0];
    await f.at("2026-10-11T10:00:00");
    const s2 = await f.profit.start({ ownStationId: f.own.id, channelIds: [7] });
    for (const iso of ["2026-10-11T12:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T09:00:00", "2026-10-13T01:00:00", "2026-10-13T09:00:00", "2026-10-14T09:00:00"]) await f.round(iso);
    const rules = await f.rt.reconciliation.listRules({ includeArchived: true });
    const report = [];
    for (const day of ["2026-10-10", "2026-10-11", "2026-10-12"]) {
      const start = SH(`${day}T00:00:00`), end = start + DAY * 1000;
      // 换 Key 那天（10-11）Key 9 先属于 A、后属于 B：只算在后绑的 B 上，每把 Key 的用量一天只算一次
      const truth = [9, 20, 13].reduce((sum, id) => sum + f.used(id, start, end), 0);
      const rows = f.costOn(day);
      report.push({ day, truth, got: rows.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0), rows: rows.map((row) => `${rules.find((r) => r.id === row.rule_id)?.channels.map((c) => c.channelId)}:${row.cost_usd}`) });
    }
    assert.deepEqual(report.filter((r) => Math.abs(r.got - r.truth) > 1e-6), []);
  });
}

// ===== #143 审核第二轮：决定 54（新建绑定的下限）和追加路径 =====
const dayTotals = (f, day) => { const rows = f.costOn(day); return { cost: rows.reduce((a, r) => a + Number(r.cost_usd || 0), 0), revenue: rows.reduce((a, r) => a + Number(r.revenue_usd || 0), 0) }; };
const settle = async (f, list) => { for (const iso of list) await f.round(iso); };
const LATER = ["2026-10-11T12:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T09:00:00", "2026-10-13T01:00:00", "2026-10-13T09:00:00", "2026-10-14T09:00:00"];

for (const upstreamType of ["newapi", "sub2api"]) {
  test(`决定 54（${upstreamType}）：渠道上午属于一条停掉的绑定，下午换了 Key 重新开始——停掉的和新建的各按整天算，收入只记一次（记在后绑的新建那条上，用户 10-30 定）`, async (t) => {
    const SWITCH = SH("2026-10-11T12:00:00");
    const f = await setup(t, { upstreamType, keys: [9, 20], channelKey: { 1: 9 }, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] } });
    await f.at("2026-10-10T10:00:00"); await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
    await settle(f, ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T09:00:00"]);
    await f.at("2026-10-11T11:00:00"); await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
    f.channelKey[1] = 20; await f.round("2026-10-11T12:00:00");
    await f.at("2026-10-11T14:00:00");
    const s = await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
    assert.equal(s.started.length, 1, JSON.stringify(s));
    await settle(f, LATER);
    const d = dayTotals(f, "2026-10-11");
    // 两条各按整天：成本 Key 9（到 12 点用过）+ Key 20（12 点起）；收入全天只记一次（记在后绑的新建那条上，停掉的那条这天收入 0）
    assert.deepEqual([d.cost, d.revenue], [12 * 3600 + 12 * 3600, 2 * DAY]);
  });

  test(`决定 54 走追加（${upstreamType}）：渠道上午属于停掉的绑定 C，下午换成 A 正在算的 Key——今天不让开始（COUNTED_EARLIER_TODAY，写明停的时刻和原来那把 Key），C 那天整天算（用户 10-30 定），A 那天不含这个渠道的收入；第二天 0 点起开始，算进 A`, async (t) => {
    const f = await setup(t, { upstreamType, keys: [9, 30], channelKey: { 1: 9, 6: 30 }, windows: { 30: [-Infinity, SH("2026-10-11T10:30:00")] } });
    await f.at("2026-10-10T10:00:00"); await f.profit.start({ ownStationId: f.own.id, channelIds: [1, 6] });
    await settle(f, ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T09:00:00"]);
    await f.at("2026-10-11T10:00:00"); await f.profit.stop({ ownStationId: f.own.id, channelIds: [6] });
    f.channelKey[6] = 9; await f.round("2026-10-11T10:30:00");
    await f.at("2026-10-11T11:00:00");
    const status = (await f.profit.status(f.own.id)).channels.find((channel) => channel.channelId === 6);
    assert.deepEqual([status.state, status.reason, status.stoppedAtMs, status.tokenName], ["blocked", "COUNTED_EARLIER_TODAY", SH("2026-10-11T10:00:00"), "Key 30"]);
    const today = await f.profit.start({ ownStationId: f.own.id, channelIds: [6] });
    assert.deepEqual([today.started, today.blocked.map((item) => [item.channelId, item.code, item.stoppedAtMs])], [[], [[6, "COUNTED_EARLIER_TODAY", SH("2026-10-11T10:00:00")]]], "今天不建");
    assert.equal((await f.rt.reconciliation.listRules()).length, 1, "只有 A 在算");
    await settle(f, ["2026-10-11T23:00:00", "2026-10-12T01:00:00"]);
    const d = dayTotals(f, "2026-10-11");
    // 收入：A 只有渠道 1（全天）；C（渠道 6）停掉那天整天算。成本：Key 9 全天（A）+ Key 30 到 10:30 的用量（C 整天）
    assert.deepEqual([d.cost, d.revenue], [DAY + 10.5 * 3600, 4 * DAY], "C 那把 Key 的钱算在 C 里，A 那天不含渠道 6 的收入");
    // 第二天 0 点以后可以开始：追加进 A
    await f.at("2026-10-12T00:30:00");
    assert.equal((await f.profit.status(f.own.id)).channels.find((channel) => channel.channelId === 6).state, "startable");
    const next = await f.profit.start({ ownStationId: f.own.id, channelIds: [6] });
    assert.equal(next.started.length, 1, JSON.stringify(next));
    await settle(f, ["2026-10-12T09:00:00", "2026-10-13T01:00:00"]);
    const d2 = dayTotals(f, "2026-10-12");
    assert.deepEqual([d2.cost, d2.revenue], [DAY, 4 * DAY], "第二天起渠道 6 正常算进 A：收入两个渠道各全天，成本 Key 9 全天");
  });

  test(`决定 54 走追加（${upstreamType}）：读不到今天停掉的绑定——先挡着，不开始也不追加（不当没有，不然会把今天已经算给停掉那条的收入再算一遍）；读得到了再开始`, async (t) => {
    const f = await setup(t, { upstreamType, keys: [9, 30], channelKey: { 1: 9, 6: 30 }, windows: { 30: [-Infinity, SH("2026-10-11T10:30:00")] } });
    await f.at("2026-10-10T10:00:00"); await f.profit.start({ ownStationId: f.own.id, channelIds: [1, 6] });
    await settle(f, ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T09:00:00"]);
    await f.at("2026-10-11T10:00:00"); await f.profit.stop({ ownStationId: f.own.id, channelIds: [6] });
    f.channelKey[6] = 9; await f.round("2026-10-11T10:30:00");
    await f.at("2026-10-11T11:00:00");
    const real = f.rt.reconciliation.listRecentlyArchivedRules.bind(f.rt.reconciliation);
    let failing = true;
    t.mock.method(f.rt.reconciliation, "listRecentlyArchivedRules", async (...args) => { if (failing) throw new Error("连接断了"); return real(...args); });
    assert.deepEqual(await f.profit.status(f.own.id), { ok: false, code: "HISTORY_UNAVAILABLE" });
    await assert.rejects(f.profit.start({ ownStationId: f.own.id, channelIds: [6] }), { code: "HISTORY_UNAVAILABLE" });
    assert.equal((await f.rt.reconciliation.listRules()).length, 1, "没建也没追加：只有 A 在算");
    failing = false;
    const status = (await f.profit.status(f.own.id)).channels.find((channel) => channel.channelId === 6);
    assert.deepEqual([status.state, status.reason], ["blocked", "COUNTED_EARLIER_TODAY"], "读得到了：回到原来的挡");
  });
}

// 几天合起来看（近 7 天、本月、开始算以来、自选范围）：每把 Key 只读它被记下的那些天。Key 挪到别的渠道以后，旧 Key 在这个渠道没用它的日子里不算（审核 2 H1）
for (const upstreamType of ["newapi", "sub2api"]) {
  test(`多天窗口：Key 挪给别的渠道以后，每个渠道只算它自己记下的那些天的 Key，不把窗口里所有天的 Key 并起来整窗读（${upstreamType}）`, async (t) => {
    const SWITCH = SH("2026-10-11T09:00:00");
    const f = await setup(t, { upstreamType, keys: [9, 20, 13], channelKey: { 1: 9, 7: 13 }, windows: { 9: [-Infinity, Infinity], 20: [SWITCH, Infinity], 13: [Infinity, Infinity] } });
    await f.at("2026-10-10T10:00:00");
    await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
    for (const iso of ["2026-10-10T12:00:00", "2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T08:00:00"]) await f.round(iso);
    f.channelKey[1] = 20; f.channelKey[7] = 9; // 9 点：渠道 1 换成 Key 20，Key 9 挪给渠道 7
    await f.round("2026-10-11T09:00:00");
    await f.at("2026-10-11T10:00:00");
    await f.profit.start({ ownStationId: f.own.id, channelIds: [7] });
    for (const iso of ["2026-10-11T12:00:00", "2026-10-12T01:00:00", "2026-10-12T09:00:00", "2026-10-13T09:00:00"]) await f.round(iso);
    const dayStart = (day) => SH(`${day}T00:00:00`);
    const live = await f.rt.reconciliation.queryRules({ preset: "custom", startMs: dayStart("2026-10-10"), endMs: dayStart("2026-10-13") }, { mode: "evaluate", force: true, origin: "manual" });
    const costOf = (channelId) => Number(live.results.find((row) => row.rule.channels.some((channel) => channel.channelId === channelId)).upstream.amountUsd);
    // 渠道 1：10-10 记 Key 9，10-11 记 Key 9 和 20（换 Key 那天），10-12 记 Key 20；渠道 7：10-11、10-12 记 Key 9。
    // 10-11 Key 9 两条绑定都记了：只算在后绑的渠道 7 上，渠道 1 那天只算 Key 20
    assert.equal(costOf(1), f.used(9, dayStart("2026-10-10"), dayStart("2026-10-11")) + f.used(20, dayStart("2026-10-11"), dayStart("2026-10-13")));
    assert.equal(costOf(7), f.used(9, dayStart("2026-10-11"), dayStart("2026-10-13")));
  });
}

// 开始算以来：已固定的日子取账本，只有没固定的日子才向上游现读（审核 2 性能项）
for (const upstreamType of ["newapi", "sub2api"]) {
  test(`开始算以来：数和整段现读一样，但已固定的日子不再向上游读，只读没固定的那几天（${upstreamType}）`, async (t) => {
    const f = await setup(t, { upstreamType, keys: [9], channelKey: { 1: 9 } });
    await f.at("2026-10-10T10:00:00");
    await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
    for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00", "2026-10-13T09:00:00"]) await f.round(iso);
    const dayStart = (day) => SH(`${day}T00:00:00`);
    const full = await f.rt.reconciliation.queryRules({ preset: "custom", startMs: dayStart("2026-10-10"), endMs: SH("2026-10-13T09:00:00"), noCap: true }, { mode: "evaluate", force: true, origin: "manual" });
    const expected = Number(full.results[0].upstream.amountUsd), expectedIncome = Number(full.results[0].downstream.amountUsd);
    const before = globalThis.fetch.mock.calls.length;
    const page = await f.rt.reconciliation.profitPage({ preset: "since" });
    assert.deepEqual([page.pageTotals.actualCostUsd, page.pageTotals.incomeUsd], [expected, expectedIncome], "收入、上游成本和整段现读一样");
    assert.equal(page.range.preset, "since");
    assert.equal(page.unaccountedUpstreamCostUsd, null, "这个范围下不显示「没算进利润的上游成本」（只读得到现读那一截，和别处对不上）");
    if (upstreamType === "newapi") {
      const starts = globalThis.fetch.mock.calls.slice(before).map((call) => new URL(String(call.arguments[0]))).filter((url) => url.host === "up.test" && url.pathname === "/api/log/self/stat")
        .map((url) => Number(url.searchParams.get("start_timestamp")) * 1000);
      assert.ok(starts.length > 0 && starts.every((start) => start >= dayStart("2026-10-13")), `只读 10-13（今天）这没固定的一天，读了：${starts.map((start) => new Date(start).toISOString())}`);
    }
  });
}

test("渠道的 Key 换到了另一个已经加了的上游里：从那一刻起这个渠道不算（已经算出来的日子留着），只提示、不进需处理；每日利润表下面写「它的 Key 也在上游「乙」里」", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9], channelKey: { 1: 9 } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T08:00:00"]) await f.round(iso);
  const booked = f.costOn("2026-10-10").length;
  assert.equal(booked, 1, "10-10 已经固定");
  const other = await f.store.add({ name: "乙", type: "fixed" });
  f.elsewhere[77] = other.id; f.channelKey[1] = 77; // 9 点：渠道 1 的 Key 换成了乙上游里的 Key 77
  await f.round("2026-10-11T09:00:00");
  const rule = (await f.rt.reconciliation.listRules())[0];
  assert.deepEqual([rule.keyIssue?.code, rule.tokenId], ["KEY_IN_OTHER_UPSTREAM", 9], "记成只提示的码，不换绑定的 Key");
  for (const iso of ["2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T09:00:00"]) await f.round(iso);
  assert.equal(f.costOn("2026-10-10").length, 1, "已经算出来的日子留着");
  assert.equal(f.costOn("2026-10-11").length, 0, "从换的那一刻起这个渠道不算，那天不固定");
  const page = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-10T00:00:00"), endMs: SH("2026-10-12T09:00:00") });
  assert.deepEqual(page.unsupportedChannels.map((item) => [item.channelId, item.reason, item.upstreamNames]), [[1, "KEY_IN_OTHER_UPSTREAM", ["乙"]]]);
  assert.equal(page.rows[0].attention, null, "不进需处理");
  // Key 回到原来的上游：下一轮自己解开
  f.channelKey[1] = 9; delete f.elsewhere[77];
  await f.round("2026-10-12T10:00:00");
  assert.equal((await f.rt.reconciliation.listRules())[0].keyIssue ?? null, null);
});

// 每日利润页的多天范围：已固定的日子取账本，旧日子不会按「现在的 Key」重读（审核 2 第二轮：换过 Key 以后 7 天、本月这类范围）
for (const upstreamType of ["newapi", "sub2api"]) {
  test(`多天范围：换过 Key 以后，已固定的日子取账本（数和每天账本之和一致），只现读最后没固定的那天（${upstreamType}）`, async (t) => {
    const SWITCH = SH("2026-10-11T09:00:00");
    const f = await setup(t, { upstreamType, keys: [9, 20], channelKey: { 1: 9 }, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] } });
    await f.at("2026-10-10T10:00:00");
    await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
    for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T08:00:00"]) await f.round(iso);
    f.channelKey[1] = 20; // 9 点换成 Key 20
    for (const iso of ["2026-10-11T09:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00", "2026-10-13T09:00:00"]) await f.round(iso);
    const days = ["2026-10-10", "2026-10-11", "2026-10-12"];
    const ledgerCost = days.reduce((sum, day) => sum + f.costOn(day).reduce((a, row) => a + Number(row.cost_usd || 0), 0), 0);
    const ledgerIncome = days.reduce((sum, day) => sum + f.costOn(day).reduce((a, row) => a + Number(row.revenue_usd || 0), 0), 0);
    assert.ok(days.every((day) => f.costOn(day).length === 1), "三天都已固定");
    const before = globalThis.fetch.mock.calls.length;
    const page = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-10T00:00:00"), endMs: SH("2026-10-13T00:00:00") });
    assert.deepEqual([page.pageTotals.actualCostUsd, page.pageTotals.incomeUsd], [ledgerCost, ledgerIncome], "整页的数 = 每天账本之和");
    if (upstreamType === "newapi") {
      const starts = globalThis.fetch.mock.calls.slice(before).map((call) => new URL(String(call.arguments[0]))).filter((url) => url.host === "up.test" && url.pathname === "/api/log/self/stat")
        .map((url) => Number(url.searchParams.get("start_timestamp")) * 1000);
      assert.ok(starts.every((start) => start >= SH("2026-10-12T00:00:00")), `只读最后一天，读了：${starts.map((start) => new Date(start).toISOString())}`);
    }
  });
}

// 逐天相加的端到端（每日利润页多天范围）：两把 Key 速率不同（Key 9 每秒 1 美元，Key 20 每秒 3 美元），收入每秒 2 美元。
// 10-10 开始（Key 9）；10-11 9 点换成 Key 20；10-12 14–16 点 Key 20 出现在别的上游里（那天是「—」、不算进合计，Key 回来也不补）；10-13 照常。
for (const upstreamType of ["newapi", "sub2api"]) {
  test(`多天范围逐天相加：换 Key 那天、半天开头、Key 挪走又回来的那天，每条渠道每天的数（${upstreamType}）`, async (t) => {
    const SWITCH = SH("2026-10-11T09:00:00");
    const f = await setup(t, { upstreamType, keys: [9, 20], channelKey: { 1: 9 }, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 } });
    const other = await f.store.add({ name: "乙", type: "fixed" });
    await f.at("2026-10-10T10:00:00");
    await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
    for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T08:00:00"]) await f.round(iso);
    f.channelKey[1] = 20;
    for (const iso of ["2026-10-11T09:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T09:00:00"]) await f.round(iso);
    f.elsewhere[20] = other.id; // 14 点：Key 20 出现在乙上游里
    await f.round("2026-10-12T14:00:00"); await f.round("2026-10-12T15:00:00");
    delete f.elsewhere[20]; // 16 点回来
    for (const iso of ["2026-10-12T16:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00", "2026-10-13T12:00:00", "2026-10-13T23:00:00", "2026-10-14T01:00:00", "2026-10-14T09:00:00"]) await f.round(iso);
    const H = 3600, D = 24 * H;
    // 每天（逐天相加的参照）：10-10 Key 9 整天；10-11 记了 Key 9 和 20，各整天；10-12 Key 20 整天但那天不算；10-13 Key 20 整天
    const day10 = D * 1, day11 = 9 * H * 1 + 15 * H * 3, day13 = D * 3, income = (days) => days * D * 2;
    assert.deepEqual([10, 11, 12, 13].map((d) => f.costOn(`2026-10-${d}`).length), [1, 1, 0, 1], "10-12 没固定（Key 在别的上游的那天不补）");
    assert.deepEqual([10, 11, 13].map((d) => Number(f.costOn(`2026-10-${d}`)[0].cost_usd)), [day10, day11, day13], "账本里每天的成本");
    assert.equal((await f.rt.reconciliation.listRules())[0].keyIssue ?? null, null, "Key 回来以后事项解开");
    // 整段：10-10 到 10-13 整天
    const whole = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-10T00:00:00"), endMs: SH("2026-10-14T00:00:00") });
    assert.deepEqual([whole.pageTotals.actualCostUsd, whole.pageTotals.incomeUsd], [day10 + day11 + day13, income(3)], "10-12 不算进合计");
    const cell = (page, day) => page.rows[0].daily.find((item) => item.day === day);
    assert.deepEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"].map((day) => cell(whole, day).state), ["fixed", "fixed", "attention", "fixed"]);
    assert.equal(cell(whole, "2026-10-12").reason, "KEY_IN_OTHER_UPSTREAM");
    // 头一天是半天：从 10-11 15:00 开始。只有今天是实时的：半天头不现读，是「—」、不进合计，只取 10-13 的账本；页面写「有 1 天还没固定」
    const half = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-11T15:00:00"), endMs: SH("2026-10-14T00:00:00") });
    assert.deepEqual([half.pageTotals.actualCostUsd, half.pageTotals.incomeUsd, half.notCountedDays.count], [day13, D * 2, 1]);
  });
}

for (const upstreamType of ["newapi", "sub2api"]) {
  test(`多天范围：头几天没固定（还没结账的整天）：都不现读，是「—」不进合计（${upstreamType}）`, async (t) => {
    const f = await setup(t, { upstreamType, keys: [9], channelKey: { 1: 9 } });
    await f.at("2026-10-10T10:00:00");
    await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
    await f.at("2026-10-13T09:00:00");
    const D = 24 * 3600;
    const page = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-10T00:00:00"), endMs: SH("2026-10-13T00:00:00") });
    // 只有今天是实时的：10-10、10-11、10-12（昨天）都没固定，一律不现读，是「—」、不进合计，页面写「有 3 天还没固定，没算进来」
    assert.deepEqual([page.pageTotals.actualCostUsd, page.pageTotals.incomeUsd], [null, null]);
    assert.deepEqual(page.notCountedDays, { count: 3 });
    const statCalls = globalThis.fetch.mock.calls.map((call) => new URL(String(call.arguments[0]))).filter((url) => url.pathname === "/api/log/self/stat" || url.pathname === "/api/log/stat");
    assert.equal(statCalls.length, 0, "一个读上游、读自营站点的请求都没有");
  });
}

test("多天范围：昨天还没固定，不现读，是「—」、不进合计、页面写一句；已固定的日子取账本，今天现读", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9], channelKey: { 1: 9 } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T09:00:00"]) await f.round(iso);
  await f.at("2026-10-13T09:00:00");
  const D = 24 * 3600, yesterdayStart = SH("2026-10-12T00:00:00") / 1000;
  const before = globalThis.fetch.mock.calls.length;
  const page = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-10T00:00:00"), endMs: SH("2026-10-13T09:00:00") });
  assert.equal(page.notCountedDays.count, 1, "昨天没固定，写「有 1 天还没固定，没算进来」");
  // 10-10、10-11 取账本，10-13 现读 9 小时；昨天 10-12 不进合计
  assert.equal(page.pageTotals.actualCostUsd, 2 * D + 9 * 3600);
  assert.equal(page.pageTotals.incomeUsd, 2 * (2 * D + 9 * 3600));
  const starts = globalThis.fetch.mock.calls.slice(before).map((call) => new URL(String(call.arguments[0]))).filter((url) => url.pathname === "/api/log/self/stat").map((url) => Number(url.searchParams.get("start_timestamp")));
  assert.ok(!starts.includes(yesterdayStart), "昨天一个请求都没发");
});

test("多天范围：有账本行、只是重算要人处理（RESETTLE_SHRUNK）的天照取账本，不丢；单天加起来等于多天合计", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9], channelKey: { 1: 9 } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00", "2026-10-13T09:00:00"]) await f.round(iso);
  const rule = (await f.rt.reconciliation.listRules())[0], now = SH("2026-10-13T09:00:00");
  await f.repository.recordSettlementState(rule.id, "2026-10-11", { op: "manual", reason: "RESETTLE_SHRUNK", sourceVersion: null, attempts: 0, manualSince: now, firstFailedAt: now, lastAttemptAt: now, nextAttemptAt: null, detail: { code: "RESETTLE_SHRUNK" } }, now);
  const range = (a, b) => f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH(`${a}T00:00:00`), endMs: SH(`${b}T00:00:00`) });
  const whole = await range("2026-10-10", "2026-10-13");
  const singles = [await range("2026-10-10", "2026-10-11"), await range("2026-10-11", "2026-10-12"), await range("2026-10-12", "2026-10-13")];
  assert.equal(whole.pageTotals.actualCostUsd, singles.reduce((sum, page) => sum + (page.pageTotals.actualCostUsd ?? 0), 0));
  assert.equal(whole.pageTotals.actualCostUsd, 3 * 24 * 3600, "10-11 也在合计里");
});

test("单看昨天或以前的一天：没固定就显示它的状态和原因，不去现读上游和自营站点；固定了读账本", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9], channelKey: { 1: 9 } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T09:00:00"]) await f.round(iso);
  await f.at("2026-10-13T09:00:00"); // 10-12 还没结账
  const range = (a, b) => f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH(`${a}T00:00:00`), endMs: SH(`${b}T00:00:00`) });
  const before = globalThis.fetch.mock.calls.length;
  const fixed = await range("2026-10-11", "2026-10-12");
  assert.equal(fixed.pageTotals.actualCostUsd, 24 * 3600, "10-11 已固定：读账本");
  const unfixed = await range("2026-10-12", "2026-10-13");
  assert.equal(unfixed.pageTotals.actualCostUsd, null, "10-12 没固定：不进合计");
  assert.equal(unfixed.rows[0].daily.find((day) => day.day === "2026-10-12").state, "reading", "显示还在读取");
  const reads = globalThis.fetch.mock.calls.slice(before).map((call) => new URL(String(call.arguments[0]))).filter((url) => url.pathname === "/api/log/self/stat" || url.pathname === "/api/log/stat");
  assert.equal(reads.length, 0, "过去的一天不读上游也不读自营站点");
});

// ===== 手动选 Key（不装读取服务）=====
// Key 9 每秒 1 美元、Key 20 每秒 3 美元；收入每个渠道每秒 2 美元
for (const upstreamType of ["newapi", "sub2api"]) {
  test(`手动选 Key：没绑过的渠道选上游和 Key 就开始算；换 Key 当天两把都记、第二天起只用新的，每天成本 = 当天用过的 Key 的用量（${upstreamType}）`, async (t) => {
    const SWITCH = SH("2026-10-11T09:00:00");
    const f = await setup(t, { upstreamType, keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 } });
    await f.at("2026-10-10T10:00:00");
    const options = await f.profit.options(f.own.id);
    assert.equal(options.ok, true);
    assert.deepEqual(options.upstreams.map((item) => item.id), [f.supplier.id]);
    assert.equal(options.channels.find((channel) => channel.channelId === 1).ruleId, null);
    await assert.rejects(f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 9 }), { code: "UPSTREAM_NOT_FOUND" }, "没绑过的渠道要先选上游");
    const first = await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
    assert.equal(first.changed, true);
    let rules = await f.rt.reconciliation.listRules();
    assert.deepEqual([rules.length, rules[0].tokenId, rules[0].channels.map((channel) => channel.channelId)], [1, 9, [1]]);
    const after = (await f.profit.options(f.own.id)).channels.find((channel) => channel.channelId === 1);
    assert.deepEqual([after.tokenId, after.upstreamStationId], [9, f.supplier.id]);
    assert.deepEqual(await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 9 }), { changed: false, ruleId: rules[0].id }, "选的和现在一样：什么也不做");
    await assert.rejects(f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: "other", tokenId: 20 }), { code: "CHANNEL_UPSTREAM_FIXED" });
    for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T08:00:00"]) await f.round(iso);
    // 10-11 9 点在 New API 里换了 Key，当天来控制台改
    await f.at("2026-10-11T09:30:00");
    assert.equal((await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 20 })).changed, true);
    rules = await f.rt.reconciliation.listRules();
    assert.equal(rules[0].tokenId, 20);
    const keys = (await f.repository.listDayKeys([rules[0].id], "2026-10-10", "2026-10-12"))[rules[0].id];
    assert.deepEqual(Object.fromEntries(Object.entries(keys).map(([day, list]) => [day, list.map((key) => key.tokenId)])), { "2026-10-10": [9], "2026-10-11": [9, 20] }, "换的那天两把都记");
    for (const iso of ["2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00"]) await f.round(iso);
    const H = 3600, D = 24 * H, cost = (day) => Number(f.costOn(day)[0]?.cost_usd ?? NaN);
    assert.equal(cost("2026-10-11"), 9 * H * 1 + 15 * H * 3, "换 Key 那天：旧、新两把各取整天");
    assert.equal(cost("2026-10-12"), D * 3, "第二天起只用新的");
  });

  test(`手动选 Key 兜底：渠道这天有收入、选的 Key 一点用量都没有——这天不固定、记需处理（CHANNEL_KEY_NO_USAGE）；改了 Key，被挡住的天按新 Key 算并固定（${upstreamType}）`, async (t) => {
    const SWITCH = SH("2026-10-11T09:00:00");
    const f = await setup(t, { upstreamType, keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 } });
    await f.at("2026-10-10T10:00:00");
    await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
    for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00", "2026-10-13T01:30:00", "2026-10-13T08:00:00"]) await f.round(iso);
    const rule = (await f.rt.reconciliation.listRules())[0];
    // 10-12 的 Key 9 一点用量都没有，渠道有收入：不固定
    assert.equal(f.costOn("2026-10-12").length, 0, "10-12 没固定");
    const state = (await f.repository.listSettlementStates([rule.id], { billDates: ["2026-10-12"] }))[0];
    assert.equal(state?.manualReason, "CHANNEL_KEY_NO_USAGE");
    // 10-11 那天 Key 9 上午还有用量：不挡（已知限制：换 Key 当天晚来改会少算新 Key 那半天）
    assert.equal(f.costOn("2026-10-11").length, 1);
    // 用户来改成 Key 20：10-12 按新 Key 重新算、固定
    await f.at("2026-10-13T09:00:00");
    const changed = await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 20 });
    assert.deepEqual(changed.rekeyedDays, ["2026-10-12"]);
    for (const iso of ["2026-10-13T09:30:00", "2026-10-13T10:00:00", "2026-10-13T12:00:00", "2026-10-13T14:00:00"]) await f.round(iso);
    assert.equal(f.costOn("2026-10-12").length, 1, "10-12 固定了");
    assert.equal(Number(f.costOn("2026-10-12")[0].cost_usd), 24 * 3600 * 3, "按新 Key 20 的整天用量");
  });
}

test("手动选 Key 兜底只在没配读取服务时判：配了读取服务的站点不判「Key 没有用量」", async (t) => {
  const SWITCH = SH("2026-10-11T09:00:00");
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: { 1: 9 }, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00"]) await f.round(iso);
  const states = await f.repository.listSettlementStates([(await f.rt.reconciliation.listRules())[0].id]);
  assert.ok(states.every((state) => state.manualReason !== "CHANNEL_KEY_NO_USAGE"), "配了读取服务的站点不判「Key 没有用量」");
});

// 10-13 以前建的绑定（legacy-v3，不是 isScopedBillingPolicy）：成本按分段上的 Key 读，手动换 Key 不能把换 Key 那天旧 Key 的一段丢掉（审核 2）
for (const upstreamType of ["newapi", "sub2api"]) {
  test(`手动选 Key：legacy-v3 的老绑定换 Key，换的那天旧、新两把各算整天（9 点前 Key 9 每秒 1、9 点后 Key 20 每秒 3），第二天起只算新的（${upstreamType}）`, async (t) => {
    const SWITCH = SH("2026-10-11T09:00:00");
    const f = await setup(t, { upstreamType, keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 } });
    await f.at("2026-10-09T10:00:00");
    await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
    // 把这条绑定还原成 10-13 以前建的老绑定：策略 legacy-v3、没有生效时刻，唯一的分段从建绑定那一刻起
    const row = f.repository.tables.rules[0], created = SH("2026-10-09T10:00:00");
    Object.assign(row, { billing_policy: "legacy-v3", billing_effective_from_ms: null, scope_version: 1, accounting_floor_ms: null });
    for (const segment of f.repository.tables.segments.filter((item) => item.rule_id === row.id)) segment.effective_from_ms = created;
    for (const iso of ["2026-10-09T23:00:00", "2026-10-10T01:00:00", "2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T08:00:00"]) await f.round(iso);
    await f.at("2026-10-11T09:30:00");
    assert.equal((await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 20 })).changed, true);
    for (const iso of ["2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00"]) await f.round(iso);
    const H = 3600, cost = (day) => Number(f.costOn(day)[0]?.cost_usd ?? NaN);
    assert.equal(cost("2026-10-10"), 24 * H * 1, "换 Key 以前的天只有 Key 9");
    assert.equal(cost("2026-10-11"), 9 * H * 1 + 15 * H * 3, "换 Key 那天：旧、新两把各取整天");
    assert.equal(cost("2026-10-12"), 24 * H * 3, "第二天起只用新的");
  });
}

// 真建成的 legacy-v3 绑定（repository.createRule 不给策略就是 legacy-v3，不是建完再改）：在 New API 里换了 Key，过了一阵才来控制台改——
// 前面还没固定的天、被重判的旧日子都要按当时的 Key（旧 Key）算，不能按新 Key 读
// Sub2API 的老绑定建绑定那天（10 点）不能按整天固定，这条用 New API 核；Key 逻辑两边是同一段
for (const upstreamType of ["newapi"]) {
  test(`手动选 Key：真建成的 legacy-v3 绑定，换 Key 以后前面没固定的天和重判已固定的旧日子仍按旧 Key（${upstreamType}）`, async (t) => {
    const SWITCH = SH("2026-10-11T00:30:00");
    const f = await setup(t, { upstreamType, keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 } });
    await f.at("2026-10-09T10:00:00");
    const station = f.store.get(f.supplier.id);
    const canonicalKey = canonicalBillingKey(station, { accountId: 42, userId: 42 }, 9);
    const rule = await f.repository.createRule({ upstreamStationId: f.supplier.id, ownStationId: f.own.id, tokenId: 9, tokenName: "Key 9", fixedGroup: "g1", timezone: "Asia/Shanghai",
      channels: [{ channelId: 1, name: "Channel 1" }], initialEffectiveFromMs: SH("2026-10-09T00:00:00"), costCoverage: "complete", provider: upstreamType, canonicalKey });
    assert.equal(rule.billingPolicy, "legacy-v3", "真的是 legacy-v3");
    // 10-09 固定；10-10 在 10-11 00:15 以后本来该固定，但用户还没来改，先不让轮询结（模拟「过了一阵才来改」：这几轮之间没有结账）
    for (const iso of ["2026-10-09T23:00:00", "2026-10-10T01:00:00", "2026-10-10T23:00:00"]) await f.round(iso);
    const H = 3600, cost = (day) => Number(f.costOn(day)[0]?.cost_usd ?? NaN);
    const day9 = cost("2026-10-09");
    assert.equal(day9, 24 * H * 1, "10-09 整天只有 Key 9");
    // 10-11 10:00 用户来把 Key 改成 20（10-10 还没固定）
    await f.at("2026-10-11T10:00:00");
    assert.equal((await f.rt.reconciliation.changeRuleKeyManual(rule.id, 20)) != null, true);
    // 重判已固定的 10-09：账本一行不变
    await f.repository.requestResettle(rule.id, ["2026-10-09"], { now: f.state.now });
    for (const iso of ["2026-10-11T12:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T08:00:00"]) await f.round(iso);
    assert.equal(cost("2026-10-10"), 24 * H * 1, "10-10 没固定的那天按旧 Key 9 算（不是新 Key 的 259200）");
    assert.equal(cost("2026-10-09"), day9, "重判已固定的 10-09 仍按旧 Key");
    assert.equal(cost("2026-10-11"), 0.5 * H * 1 + 23.5 * H * 3, "换 Key 当天旧、新两把各取整天：Key 9 到 0:30、Key 20 从 0:30 起");
  });
}

// ===== 今天就提醒换 Key（CHANNEL_KEY_IDLE_TODAY）=====
// Key 9 到 12:00 才有用量（之前一点都没有），渠道每秒 2 美元收入；没装读取服务、手动选的 Key
async function idleFixture(t, extra = {}) {
  const f = await setup(t, { upstreamType: "newapi", keys: [9], channelKey: {}, noAgent: true, windows: { 9: [SH("2026-10-10T12:00:00"), Infinity] }, ...extra });
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  const today = (iso) => f.at(iso).then(() => f.rt.reconciliation.profitPage({ preset: "today" }));
  return { f, today };
}

test("今天照读到的数算：有收入、Key 零用量，不到 1 小时照算进今天的合计、不加提醒；满 1 小时亮感叹号（提示，不是需处理），仍照算、进合计", async (t) => {
  const { f, today } = await idleFixture(t);
  await f.round("2026-10-10T10:30:00"); // 第一次看到这个情况
  const early = await today("2026-10-10T11:20:00");
  const row = early.rows[0];
  assert.deepEqual([row.attention, row.notice, row.counted], [null, null, true], "不到 1 小时：照算，没有提醒");
  assert.ok(row.incomeUsd > 0 && row.actualCostUsd === 0 && row.grossProfitUsd === row.incomeUsd, "收入照写、成本是读到的 0、毛利 = 收入");
  assert.deepEqual([early.pageTotals.incomeUsd, early.pageTotals.actualCostUsd, early.pageTotals.grossProfitUsd], [row.incomeUsd, 0, row.incomeUsd], "进今天的合计");
  const lit = await today("2026-10-10T11:31:00");
  const litRow = lit.rows[0];
  assert.equal(litRow.attention, null, "不是需处理");
  assert.equal(litRow.notice.code, "CHANNEL_KEY_IDLE_TODAY");
  assert.equal(litRow.notice.text, "今天有收入，但绑的 Key 一直没用量，可能换了 Key");
  assert.equal(litRow.notice.detail, "今天这个渠道的成本可能少算了。");
  assert.equal(litRow.notice.action.kind, "go_swap_key");
  assert.equal(litRow.notice.action.label, "去换 Key");
  assert.equal(litRow.notice.action.href, `/stations?action=swap-key&stationId=${f.supplier.id}&channelId=1`);
  assert.deepEqual([litRow.counted, litRow.actualCostUsd, lit.pageTotals.actualCostUsd, lit.pageTotals.grossProfitUsd], [true, 0, 0, litRow.incomeUsd], "仍照读到的数算、进合计，今天合计和这一行对得上");
  assert.equal(lit.counts.attentionChannels, 0, "不算进需处理的渠道数");
  const status = lit.rows.length && (await f.rt.reconciliation.queryRules({ preset: "today" }, { mode: "evaluate", force: true, origin: "manual" })).results[0].displayStatus;
  assert.equal(status.state, "live", "状态还是实时，不进需处理清单");
  assert.deepEqual(status.actions, []);
});

test("今天提醒换 Key：Key 有了用量，下一次实时读自己消失；解绑再绑同一把 Key 是撤销解绑，计时接着走", async (t) => {
  const { f, today } = await idleFixture(t);
  await f.round("2026-10-10T10:30:00");
  assert.equal((await today("2026-10-10T11:31:00")).rows[0].notice.code, "CHANNEL_KEY_IDLE_TODAY");
  const back = await today("2026-10-10T12:30:00"); // 12:00 起 Key 有用量了
  assert.equal(back.rows[0].notice, null);
  assert.ok(back.rows[0].counted && back.pageTotals.actualCostUsd > 0);
  // 解绑再绑同一把 Key（撤销解绑）：还是原来那条绑定，计时接着走
  const { f: g, today: todayG } = await idleFixture(t);
  await g.round("2026-10-10T10:30:00");
  assert.equal((await todayG("2026-10-10T11:31:00")).rows[0].notice.code, "CHANNEL_KEY_IDLE_TODAY");
  await g.profit.stop({ ownStationId: g.own.id, channelIds: [1] });
  await g.at("2026-10-10T11:40:00");
  await g.profit.selectKey({ ownStationId: g.own.id, channelId: 1, upstreamStationId: g.supplier.id, tokenId: 9 });
  assert.equal((await todayG("2026-10-10T11:50:00")).rows[0]?.notice?.code, "CHANNEL_KEY_IDLE_TODAY", "撤销解绑：还是原来那条绑定，计时不重来");
});

test("今天提醒换 Key：装了读取服务的站点不判；固定成本的上游不判", async (t) => {
  const withAgent = await setup(t, { upstreamType: "newapi", keys: [9], channelKey: { 1: 9 }, windows: { 9: [SH("2026-10-10T12:00:00"), Infinity] } });
  await withAgent.at("2026-10-10T10:00:00");
  await withAgent.profit.start({ ownStationId: withAgent.own.id, channelIds: [1] });
  await withAgent.round("2026-10-10T10:30:00");
  await withAgent.at("2026-10-10T11:31:00");
  const page = await withAgent.rt.reconciliation.profitPage({ preset: "today" });
  assert.equal(page.rows[0].notice, null);
  const { f, today } = await idleFixture(t);
  f.store.get(f.supplier.id).fixedPurchases = [{ amount: 100, days: 30, startDate: null }];
  await f.round("2026-10-10T10:30:00");
  assert.equal((await today("2026-10-10T11:31:00")).rows[0].notice, null);
});

test("CHANNEL_KEY_NO_USAGE：标题写是哪天、说明去掉旧说法，按钮「去上游资源」跳这个上游的渠道抽屉（lib 里同一条路由）", async () => {
  const issue = reconciliationIssue("CHANNEL_KEY_NO_USAGE");
  assert.equal(issue.title, "「{channel}」{day}有收入，但绑的 Key 这天一点用量都没有");
  assert.equal(issue.detail, "可能渠道换了 Key，这天先不固定。");
  assert.equal(issue.action, "go_swap_key");
  assert.doesNotMatch(JSON.stringify(issue), /选的 Key|选 Key/);
});

// ===== 多天范围按天算：中间一天被挡，不整行丢掉 =====
test("多天范围：中间一天 Key 没用量被挡（CHANNEL_KEY_NO_USAGE，状态表里要人处理）——这天不进合计、这天小格写需处理、行上亮需处理，其余已固定的天和今天照算", async (t) => {
  // Key 9 从 10-11 0 点才有用量：10-10 整天一点用量都没有，收入照有，结账时被挡
  const f = await setup(t, { upstreamType: "newapi", keys: [9], channelKey: {}, noAgent: true, windows: { 9: [SH("2026-10-11T00:00:00"), Infinity] } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  for (const iso of ["2026-10-11T01:00:00", "2026-10-12T01:00:00"]) await f.round(iso);
  assert.equal(f.costOn("2026-10-10").length, 0, "10-10 没结成（被挡）");
  assert.equal(f.costOn("2026-10-11").length, 1, "10-11 照常固定");
  await f.at("2026-10-12T09:00:00");
  const page = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-10T00:00:00"), endMs: SH("2026-10-12T09:00:00") });
  const row = page.rows[0];
  assert.deepEqual(row.daily.map((cell) => [cell.day, cell.state]), [["2026-10-10", "attention"], ["2026-10-11", "fixed"], ["2026-10-12", "today"]]);
  assert.deepEqual([row.daily[0].incomeUsd, row.daily[0].actualCostUsd, row.daily[0].grossUsd], [null, null, null], "被挡的天写「—」，不当 0");
  const booked = f.costOn("2026-10-11")[0];
  assert.equal(row.daily[1].incomeUsd, Number(booked.revenue_usd)); assert.equal(row.daily[1].actualCostUsd, Number(booked.cost_usd));
  assert.equal(row.counted, true, "有算进来的天，这一行就算进来");
  assert.equal(row.excludedDays, 1);
  assert.equal(row.attention.code, "CHANNEL_KEY_NO_USAGE");
  assert.equal(row.attention.action.kind, "go_swap_key");
  assert.equal(row.attention.action.href, `/stations?action=swap-key&stationId=${row.upstream.stationId}&channelId=${row.channels[0].channelId}`);
  const sum = (field) => row.daily.reduce((total, cell) => total + (cell[field] ?? 0), 0);
  assert.ok(Math.abs(sum("incomeUsd") - row.incomeUsd) < 1e-6 && Math.abs(sum("actualCostUsd") - row.actualCostUsd) < 1e-6, "每天加起来 = 这一行；被挡的 10-10 不在里面");
  assert.deepEqual([page.pageTotals.incomeUsd, page.pageTotals.actualCostUsd], [row.incomeUsd, row.actualCostUsd], "整页的数 = 这一行");
  assert.deepEqual([page.counts.countedChannels, page.counts.attentionChannels], [1, 1]);
});

// ===== 换 Key 一步完成：找新 Key 哪天开始用的（D）=====
// New API：Key 9 每秒 1 美元、Key 20 每秒 3 美元；收入每个渠道每秒 2 美元
const swapStatCalls = (token) => globalThis.fetch.mock.calls.map((call) => new URL(String(call.arguments[0])))
  .filter((url) => url.host === "up.test" && url.pathname === "/api/log/self/stat" && url.searchParams.get("token_name") === token);

test("换 Key 找 D：新 Key 从 10-12 15 点起有用量，查到 10-11 没用量就停；D 那天新旧两把都算、之后只算新的；D 那天已经固定的被重算，更早的不动", async (t) => {
  const SWITCH = SH("2026-10-12T15:00:00");
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00"]) await f.round(iso);
  const H = 3600, cost = (day) => Number(f.costOn(day).at(-1)?.cost_usd ?? NaN); // 最新一版（重算会写新版）
  assert.equal(cost("2026-10-12"), 15 * H * 1, "换 Key 当天按旧 Key 固定了，少算了新 Key 那 9 小时");
  await f.at("2026-10-13T10:00:00");
  const before = swapStatCalls("Key 20").length;
  const result = await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 20 });
  assert.deepEqual([result.fromDay, result.recomputedDays, result.tooOld, result.noRecentUsage], ["2026-10-12", 1, null, false]);
  assert.equal(swapStatCalls("Key 20").length - before, 3, "今天、昨天有用量，10-11 没用量就停：3 个请求");
  const rule = (await f.rt.reconciliation.listRules())[0];
  const keys = (await f.repository.listDayKeys([rule.id], "2026-10-10", "2026-10-13"))[rule.id];
  assert.deepEqual(Object.fromEntries(Object.entries(keys).map(([day, list]) => [day, list.map((key) => key.tokenId)])), { "2026-10-10": [9], "2026-10-11": [9], "2026-10-12": [9, 20], "2026-10-13": [20] });
  for (const iso of ["2026-10-13T11:00:00", "2026-10-13T12:00:00", "2026-10-13T23:00:00", "2026-10-14T01:00:00"]) await f.round(iso);
  assert.equal(cost("2026-10-12"), 15 * H * 1 + 9 * H * 3, "D 那天已经固定的被重算：旧、新两把各整天");
  assert.equal(cost("2026-10-11"), 24 * H * 1, "D 以前的不动");
  assert.equal(cost("2026-10-13"), 24 * H * 3, "D 之后只算新的");
});

test("换 Key 找 D：不早于这条绑定的开始日；最多查 31 天（请求次数有上限）", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, Infinity], 20: [-Infinity, Infinity] }, rates: { 9: 1, 20: 3 } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  await f.at("2026-10-13T10:00:00");
  let before = swapStatCalls("Key 20").length;
  const result = await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 20 });
  assert.equal(result.fromDay, "2026-10-10", "新 Key 一直有用量，也只查到绑定的开始日");
  assert.equal(swapStatCalls("Key 20").length - before, 4, "10-13、12、11、10 四天");
  // 绑得很早：只查 31 天
  const g = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, Infinity], 20: [-Infinity, Infinity] } });
  await g.at("2026-08-01T10:00:00");
  await g.profit.selectKey({ ownStationId: g.own.id, channelId: 1, upstreamStationId: g.supplier.id, tokenId: 9 });
  await g.at("2026-10-13T10:00:00");
  before = swapStatCalls("Key 20").length;
  const far = await g.profit.selectKey({ ownStationId: g.own.id, channelId: 1, tokenId: 20 });
  assert.equal(swapStatCalls("Key 20").length - before, 31, "最多查 31 天");
  assert.equal(far.fromDay, "2026-09-13");
});

test("换 Key：被 CHANNEL_KEY_NO_USAGE 挡住的天按新 Key 补上并固定，一起数进 recomputedDays", async (t) => {
  const SWITCH = SH("2026-10-12T10:00:00");
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SH("2026-10-12T00:00:00")], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00"]) await f.round(iso);
  const rule = (await f.rt.reconciliation.listRules())[0];
  assert.equal(f.costOn("2026-10-12").length, 0, "10-12 旧 Key 一点用量都没有：被挡住");
  assert.equal((await f.repository.listSettlementStates([rule.id], { billDates: ["2026-10-12"] }))[0]?.manualReason, "CHANNEL_KEY_NO_USAGE");
  await f.at("2026-10-13T10:00:00");
  const result = await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 20 });
  assert.deepEqual([result.fromDay, result.recomputedDays, result.rekeyedDays], ["2026-10-12", 1, ["2026-10-12"]]);
  for (const iso of ["2026-10-13T11:00:00", "2026-10-13T12:00:00", "2026-10-13T14:00:00"]) await f.round(iso);
  assert.equal(Number(f.costOn("2026-10-12")[0]?.cost_usd), 14 * 3600 * 3, "被挡的 10-12 按新 Key 补上、固定");
});

test("换 Key：新 Key 最近也没用量——从今天算（noRecentUsage），被挡住的天结账时兜底照样会挡，不会把 0 成本固定进账本", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SH("2026-10-12T00:00:00")], 20: [Infinity, Infinity] } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00", "2026-10-13T01:00:00"]) await f.round(iso);
  const rule = (await f.rt.reconciliation.listRules())[0];
  await f.at("2026-10-13T10:00:00");
  const before = swapStatCalls("Key 20").length;
  const result = await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 20 });
  assert.deepEqual([result.fromDay, result.noRecentUsage, result.tooOld], ["2026-10-13", true, null]);
  assert.equal(swapStatCalls("Key 20").length - before, 2, "今天、昨天都没用量：2 个请求");
  for (const iso of ["2026-10-13T11:00:00", "2026-10-13T12:00:00", "2026-10-13T14:00:00", "2026-10-13T23:00:00"]) await f.round(iso);
  assert.equal(f.costOn("2026-10-12").length, 0, "新 Key 那天也没用量：兜底照样挡，账本里没有 0 成本的一行");
  assert.equal((await f.repository.listSettlementStates([rule.id], { billDates: ["2026-10-12"] }))[0]?.manualReason, "CHANNEL_KEY_NO_USAGE");
});

// ===== 渠道按 Key 算利润 PR1：解绑再绑 / 解绑留在每日利润页 =====
test("选 Key：同一个上游、昨天或今天解绑的——重新打开那条绑定（撤销解绑，Key 不同再走换 Key）；更早解绑的、换了上游的新建，从今天 0 点算", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, Infinity], 20: [-Infinity, Infinity] }, rates: { 9: 1, 20: 3 } });
  const pick = (tokenId, extra = {}) => f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId, ...extra });
  const rules = (includeArchived) => f.rt.reconciliation.listRules({ includeArchived });
  await f.at("2026-10-10T10:00:00");
  const first = await pick(9);
  // 当天解绑、当天绑回同一把 Key：撤销解绑，还是那一条，「用户停的」记号清掉
  await f.at("2026-10-10T15:00:00");
  await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  assert.deepEqual((await f.rt.reconciliation.listChannelOptouts(f.own.id)).map((row) => row.channelId), [1]);
  await f.at("2026-10-10T16:00:00");
  const again = await pick(9);
  assert.deepEqual([again.reopened, again.ruleId], [true, first.ruleId], JSON.stringify(again));
  assert.deepEqual([(await rules(true)).length, (await rules(false)).length], [1, 1], "没有新建绑定");
  assert.deepEqual(await f.rt.reconciliation.listChannelOptouts(f.own.id), []);
  // 第二天解绑、绑回的是别的 Key：重新打开那条，再走换 Key（从新 Key 第一天有用量那天起）
  await f.at("2026-10-11T10:00:00");
  await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  await f.at("2026-10-11T11:00:00");
  const swapped = await pick(20);
  assert.deepEqual([swapped.reopened, swapped.ruleId, swapped.changed, typeof swapped.fromDay], [true, first.ruleId, true, "string"], JSON.stringify(swapped));
  assert.equal((await rules(false))[0].tokenId, 20);
  assert.equal((await rules(true)).length, 1);
  // 隔了一整天以上才绑回：新建一条，从今天 0 点算
  await f.at("2026-10-11T12:00:00");
  await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  await f.at("2026-10-13T10:00:00");
  const fresh = await pick(20);
  assert.notEqual(fresh.ruleId, first.ruleId);
  assert.equal((await rules(true)).length, 2);
  assert.equal(fresh.reopened, undefined);
});

test("每日利润页带上已解绑的绑定：解绑那天整天算、数留在页面里算进合计、行标已解绑；解绑得比范围起点早的不带", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, Infinity] } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  await f.round("2026-10-10T12:00:00");
  await f.at("2026-10-10T15:00:00");
  await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  const D = 24 * 3600;
  // 解绑当天：今天照样现读（读到现在）
  const today = await f.rt.reconciliation.profitPage({ preset: "today" });
  assert.deepEqual([today.rows.length, today.rows[0].bound, today.rows[0].unboundOn, today.rows[0].counted], [1, false, "2026-10-10", true]);
  assert.equal(today.rows[0].incomeUsd, 2 * 15 * 3600, "今天 0 点到现在的收入照读");
  assert.equal(today.pageTotals.grossProfitUsd, today.rows[0].grossProfitUsd);
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T09:00:00"]) await f.round(iso);
  const fact = f.costOn("2026-10-10")[0];
  assert.equal(Number(fact.cost_usd), D, "解绑那天成本整天（15 点解绑，也算到 24 点）");
  assert.equal(Number(fact.revenue_usd), 2 * D, "收入也整天");
  assert.equal(f.costOn("2026-10-11").length, 0, "解绑以后的日子不结");
  // 近 7 天：带上；只看今天（10-11）：解绑在昨天，不带
  const week = await f.rt.reconciliation.profitPage({ preset: "7d" });
  assert.deepEqual([week.rows.length, week.rows[0].bound, week.rows[0].unboundOn, week.rows[0].incomeUsd, week.rows[0].actualCostUsd, week.pageTotals.incomeUsd], [1, false, "2026-10-10", 2 * D, D, 2 * D]);
  assert.equal(week.rows[0].grossMarginRate, 0.5);
  assert.equal(week.notCountedDays.count, 0, "解绑以后的日子不算「还没固定」");
  assert.equal(week.counts.channels, 1);
  const todayAfter = await f.rt.reconciliation.profitPage({ preset: "today" });
  assert.equal(todayAfter.rows.length, 0, "只看今天：昨天解绑的不带");
});

// ===== 渠道按 Key 算利润 PR3：每把 Key 分开记账、分收入 =====
// 渠道 1 先用 Key 9（每秒 1 美元），10-12 15 点换成 Key 20（每秒 3 美元）；收入每个渠道每秒 2 美元。
// New API：分组倍率读目录（夹具里 g1 倍率 1）；Sub2API：标准计费 = 实际扣除 × 2（倍率 = 实际 ÷ 标准 = 0.5）
for (const upstreamType of ["newapi", "sub2api"]) {
  test(`每把 Key 分开记账（${upstreamType}）：换 Key 那天两把各一行，成本、倍率、原价用量写进账本；每日利润的 keys 按原价用量比例分收入，几项加起来等于渠道合计；计算明细按天、按 Key 分开`, async (t) => {
    const SWITCH = SH("2026-10-12T15:00:00");
    const f = await setup(t, { upstreamType, keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 }, standardRatio: upstreamType === "sub2api" ? 2 : null });
    await f.at("2026-10-10T10:00:00");
    await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
    for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00"]) await f.round(iso);
    await f.at("2026-10-13T10:00:00");
    const swapped = await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 20 });
    assert.equal(swapped.fromDay, "2026-10-12");
    for (const iso of ["2026-10-13T11:00:00", "2026-10-13T12:00:00", "2026-10-13T23:00:00", "2026-10-14T01:00:00"]) await f.round(iso);
    const H = 3600, rule = (await f.rt.reconciliation.listRules())[0];
    const keysOf = (day) => f.repository.tables.ledgerKeys.filter((row) => row.bill_date === day && row.rule_id === rule.id).sort((a, b) => a.token_id - b.token_id);
    // 10-11 只有 Key 9：一行；10-12 换 Key 那天：Key 9 到 15 点、Key 20 从 15 点起，各整天读
    assert.deepEqual(keysOf("2026-10-11").map((row) => [Number(row.token_id), Number(row.cost_usd)]), [[9, 24 * H]]);
    const day12 = keysOf("2026-10-12");
    assert.deepEqual(day12.map((row) => [Number(row.token_id), Number(row.cost_usd)]), [[9, 15 * H], [20, 9 * H * 3]]);
    const ratioOf = (tokenId) => Number(day12.find((row) => Number(row.token_id) === tokenId).ratio), rawOf = (tokenId) => Number(day12.find((row) => Number(row.token_id) === tokenId).raw_usd);
    if (upstreamType === "sub2api") assert.deepEqual([ratioOf(9), ratioOf(20), rawOf(9), rawOf(20)], [0.5, 0.5, 15 * H * 2, 9 * H * 3 * 2], "标准计费 total_cost 是实际扣除的 2 倍：倍率 = 实际 ÷ 标准，原价用量 = total_cost");
    else assert.deepEqual([ratioOf(9), ratioOf(20), rawOf(9), rawOf(20)], [1, 1, 15 * H, 9 * H * 3], "New API：分组倍率 1，原价用量 = 成本 ÷ 倍率");
    assert.equal(day12.reduce((sum, row) => sum + Number(row.cost_usd), 0), Number(f.costOn("2026-10-12")[0].cost_usd), "每把 Key 的成本加起来 = 账本里这天的上游成本");
    // 每日利润（10-10 到 10-12）：keys 两项，在用的 Key 20 在前
    const page = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-10T00:00:00"), endMs: SH("2026-10-13T00:00:00") });
    const [row] = page.rows;
    assert.deepEqual(row.keys.map((key) => [key.tokenId, key.state, key.firstDay, key.lastDay, key.days]), [[20, "active", "2026-10-12", "2026-10-12", 1], [9, "swapped", "2026-10-10", "2026-10-12", 3]]);
    assert.equal(row.keys.reduce((sum, key) => sum + key.costUsd, 0), row.actualCostUsd, "每把 Key 的成本加起来 = 渠道成本");
    assert.ok(Math.abs(row.keys.reduce((sum, key) => sum + key.incomeUsd, 0) - row.incomeUsd) < 1e-6, "分到的收入加起来 = 渠道收入");
    const k9 = row.keys.find((key) => key.tokenId === 9), k20 = row.keys.find((key) => key.tokenId === 20);
    // 10-12 那天收入 2 × 86400 按原价用量比例分：Key 9 : Key 20 = 15 : 27；10-10、10-11 收入全归 Key 9（只有一把）
    const day12Income = 2 * 24 * H, total = 15 + 27;
    assert.ok(Math.abs(k20.incomeUsd - day12Income * 27 / total) < 1e-6);
    assert.ok(Math.abs(k9.incomeUsd - (2 * 2 * 24 * H + day12Income * 15 / total)) < 1e-6);
    assert.deepEqual([k9.incomeBasis, k20.incomeBasis, k9.pendingDays, k20.pendingDays], ["raw", "raw", 0, 0]);
    assert.deepEqual([k20.ratio, k20.ratioKind], upstreamType === "sub2api" ? [0.5, "actual_over_standard"] : [1, "group"]);
    // 计算明细：这一天按 Key 分开，几项收入加起来等于这天收入，分摊说明写明
    const detail = await f.rt.reconciliation.profitDetail({ ruleIds: row.ruleIds, day: "2026-10-12" });
    assert.deepEqual(detail.keys.map((key) => key.tokenId), [20, 9]);
    assert.deepEqual([detail.split.basis, detail.split.shares.map((item) => [item.tokenId, item.percent])], ["raw", [[20, 64.29], [9, 35.71]]]);
    assert.deepEqual([detail.swappedUpstream, detail.keyChangeRatioDiffers], [false, false]);
    assert.ok(Math.abs(detail.keys.reduce((sum, key) => sum + key.incomeUsd, 0) - detail.income.usd) < 1e-6);
    const single = await f.rt.reconciliation.profitDetail({ ruleIds: row.ruleIds, day: "2026-10-11" });
    assert.deepEqual([single.keys.length, single.split.basis, single.keys[0].incomeUsd, single.keys[0].incomeBasis], [1, "single", single.income.usd, "single"]);
  });
}

// ===== 渠道按 Key 算利润 PR2：一把 Key 一天只算在一个渠道上 =====
for (const upstreamType of ["newapi", "sub2api"]) {
  test(`一把 Key 一天只算在一个渠道上（${upstreamType}）：渠道 1 当天解绑、同一把 Key 当天挪给渠道 7——这天这把 Key 只算在后绑的渠道 7 上，渠道 1 这天收入照算、成本不含这把 Key；每天各 Key 的用量只算一次`, async (t) => {
    const f = await setup(t, { upstreamType, keys: [9], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, Infinity] } });
    await f.at("2026-10-10T10:00:00");
    await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
    await f.round("2026-10-10T23:00:00");
    await f.round("2026-10-11T01:00:00");
    await f.at("2026-10-11T10:00:00");
    await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
    await f.at("2026-10-11T11:00:00");
    await f.profit.selectKey({ ownStationId: f.own.id, channelId: 7, upstreamStationId: f.supplier.id, tokenId: 9 });
    // 当天（今天现读）：渠道 1（已解绑）成本不含 Key 9、也不亮「可能换了 Key」；Key 9 这天的用量只在渠道 7 上算一次
    await f.at("2026-10-11T13:00:00");
    const live = await f.rt.reconciliation.profitPage({ preset: "today" });
    const liveRow = (channelId) => live.rows.find((row) => row.channels.some((channel) => channel.channelId === channelId));
    assert.deepEqual([liveRow(1).bound, liveRow(1).actualCostUsd, liveRow(1).notice, liveRow(1).counted], [false, 0, null, true]);
    assert.equal(liveRow(7).actualCostUsd, 13 * 3600, "渠道 7 今天读到 13 点：Key 9 整个今天");
    for (const iso of ["2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T09:00:00", "2026-10-13T01:00:00"]) await f.round(iso);
    const D = 24 * 3600, rules = await f.rt.reconciliation.listRules({ includeArchived: true });
    const byChannel = (channelId) => rules.find((rule) => rule.channels.some((channel) => channel.channelId === channelId));
    const rowOf = (day, channelId) => f.costOn(day).find((row) => row.rule_id === byChannel(channelId).id);
    assert.equal(Number(rowOf("2026-10-10", 1).cost_usd), D, "10-10 只有渠道 1 一条：Key 9 整天");
    // 10-11：渠道 1（解绑那天整天算）收入 2D、成本不含 Key 9（后绑的渠道 7 拿了它）；渠道 7 收入 2D、Key 9 整天
    assert.deepEqual([Number(rowOf("2026-10-11", 1).revenue_usd), Number(rowOf("2026-10-11", 1).cost_usd)], [2 * D, 0]);
    assert.deepEqual([Number(rowOf("2026-10-11", 7).revenue_usd), Number(rowOf("2026-10-11", 7).cost_usd)], [2 * D, D]);
    assert.equal(f.costOn("2026-10-11").reduce((sum, row) => sum + Number(row.cost_usd), 0), D, "Key 9 这天的用量只算一次");
    assert.equal((await f.repository.listSettlementStates(rules.map((rule) => rule.id))).filter((state) => state.manualReason).length, 0, "没有要人处理的");
    assert.equal(f.repository.tables.ledgerKeys.filter((row) => row.bill_date === "2026-10-11" && row.rule_id === byChannel(1).id).length, 0, "渠道 1 这天没有 Key 9 的 Key 行");
  });
}

test("一把 Key 一天只算在一个渠道上：后绑的绑定把这把 Key 补回已经固定的天，先绑的那条那几天自动重算（成本拿掉），少一半以上也不挡", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, Infinity], 20: [-Infinity, Infinity] }, rates: { 9: 1, 20: 3 } });
  const D = 24 * 3600;
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  await f.round("2026-10-10T23:00:00"); await f.round("2026-10-11T01:00:00");
  await f.at("2026-10-11T10:00:00");
  await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  await f.at("2026-10-11T11:00:00");
  // 渠道 7 后绑，先绑 Key 20；10-11 渠道 1 那条已经固定的（要到 10-12 凌晨）还没固定，所以先让它固定
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 7, upstreamStationId: f.supplier.id, tokenId: 20 });
  for (const iso of ["2026-10-11T23:00:00", "2026-10-12T01:00:00"]) await f.round(iso);
  const rules = await f.rt.reconciliation.listRules({ includeArchived: true });
  const ruleOf = (channelId) => rules.find((rule) => rule.channels.some((channel) => channel.channelId === channelId));
  const costOf = (day, channelId) => Number(f.costOn(day).filter((row) => row.rule_id === ruleOf(channelId).id).sort((x, y) => y.revision - x.revision)[0]?.cost_usd); // 最新一版
  assert.equal(costOf("2026-10-11", 1), D, "10-11 渠道 1 固定时 Key 9 整天算在它上面");
  // 10-12 渠道 7 换成 Key 9：新 Key 从哪天开始有用量查到 10-11（渠道 7 的开始日），10-11 补回渠道 7；先绑的渠道 1 那条 10-11 已固定的要重算
  await f.at("2026-10-12T10:00:00");
  const swapped = await f.profit.selectKey({ ownStationId: f.own.id, channelId: 7, tokenId: 9 });
  assert.equal(swapped.fromDay, "2026-10-11");
  const states = await f.repository.listSettlementStates([ruleOf(1).id]);
  assert.deepEqual(states.filter((state) => state.resettleRequestedAt != null).map((state) => [state.billDate, state.resettleReason]), [["2026-10-11", "key_owner"]]);
  for (const iso of ["2026-10-12T11:00:00", "2026-10-12T12:00:00", "2026-10-12T13:00:00", "2026-10-13T01:00:00"]) await f.round(iso);
  assert.equal(costOf("2026-10-11", 1), 0, "渠道 1 这天 Key 9 的成本拿掉了（少一半以上也没挡）");
  assert.equal(costOf("2026-10-11", 7), D + 3 * D, "渠道 7 这天：Key 9 整天 + 原来的 Key 20 整天（3 倍）");
  assert.equal((await f.repository.listSettlementStates([ruleOf(1).id])).filter((state) => state.manualReason).length, 0, "没有被 RESETTLE_SHRUNK 挡住");
});

test("每日利润多天按「渠道 × 天」挡：同一个渠道同一天换上游挂着两条绑定，只固定了一条的那天整天不算，不出现只有成本没有收入的假亏损；两条都固定了才算", async (t) => {
  const SWITCH = SH("2026-10-11T12:00:00");
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: { 1: 9 }, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] } });
  await f.at("2026-10-10T10:00:00"); await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T09:00:00"]) await f.round(iso);
  await f.at("2026-10-11T11:00:00"); await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  f.channelKey[1] = 20; await f.round("2026-10-11T12:00:00");
  await f.at("2026-10-11T14:00:00"); await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
  await settle(f, LATER);
  const range = { preset: "custom", startMs: SH("2026-10-10T00:00:00"), endMs: SH("2026-10-12T00:00:00") };
  const full = await f.rt.reconciliation.profitPage(range);
  assert.deepEqual([full.notCountedDays.count, full.rows.length, full.rows[0].counted], [0, 1, true]);
  const D = 24 * 3600, total = full.rows[0];
  assert.deepEqual([total.incomeUsd, total.actualCostUsd], [4 * D, 2 * D], "10-10 一整天 + 10-11 两条各整天（Key 9 到 12 点、Key 20 从 12 点起）");
  // 新建的那条 10-11 的账本行没了（比如还没固定）：10-11 整天不算，10-10 照算
  const fresh = (await f.rt.reconciliation.listRules()).find((rule) => !rule.archivedAt);
  f.repository.tables.ledger.splice(0, f.repository.tables.ledger.length, ...f.repository.tables.ledger.filter((row) => !(row.rule_id === fresh.id && row.bill_date === "2026-10-11")));
  const half = await f.rt.reconciliation.profitPage(range);
  assert.equal(half.notCountedDays.count, 1);
  assert.deepEqual([half.rows[0].incomeUsd, half.rows[0].actualCostUsd], [2 * D, D], "只剩 10-10：没有 10-11 那条旧绑定的成本（不出现只有成本没有收入的亏损）");
});

test("选 Key：渠道 1 解绑后旧 Key 已经给了渠道 7，再给渠道 1 选一把空闲的 Key——接着原来那条（重新打开和换 Key 一个事务，不去占旧 Key），不报错；选的 Key 被别处占着才报错，而且整体回滚、绑定还是解绑着", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20, 30], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, Infinity], 20: [-Infinity, Infinity], 30: [-Infinity, Infinity] }, rates: { 9: 1, 20: 3, 30: 2 } });
  const pick = (channelId, tokenId) => f.profit.selectKey({ ownStationId: f.own.id, channelId, upstreamStationId: f.supplier.id, tokenId });
  const rules = (includeArchived) => f.rt.reconciliation.listRules({ includeArchived });
  await f.at("2026-10-10T10:00:00");
  const first = await pick(1, 9);
  await f.at("2026-10-10T15:00:00");
  await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  await f.at("2026-10-10T16:00:00");
  await pick(7, 9); // 旧 Key 9 给了渠道 7
  const held = await pick(7, 9);
  assert.equal(held.changed, false);
  // 渠道 1 选一把空闲的 Key 30：接着原来那条，不报「这把 Key 已经在别的绑定里」
  await f.at("2026-10-10T17:00:00");
  const again = await pick(1, 30);
  assert.deepEqual([again.reopened, again.ruleId], [true, first.ruleId], JSON.stringify(again));
  const back = (await rules(false)).find((rule) => rule.id === first.ruleId);
  assert.deepEqual([back.tokenId, back.enabled, back.archivedAt], [30, true, null]);
  assert.equal((await rules(true)).length, 2, "没有新建绑定");
  assert.deepEqual(await f.rt.reconciliation.listChannelOptouts(f.own.id), []);
  // 渠道 1 再解绑，这回选的 Key 20 被别处占着（渠道 7 换成 20）：报错，整体回滚——绑定还是解绑着，没挂上别的 Key
  await f.at("2026-10-10T18:00:00");
  await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 7, tokenId: 20 });
  await f.at("2026-10-10T19:00:00");
  await assert.rejects(pick(1, 20), { code: "KEY_ALREADY_BOUND" });
  const stillOff = (await rules(true)).find((rule) => rule.id === first.ruleId);
  assert.deepEqual([stillOff.archivedAt != null, stillOff.enabled, stillOff.tokenId], [true, false, 30], "换 Key 失败：整体回滚，还是解绑着、Key 没变");
  assert.equal((await rules(false)).length, 1);
});

test("渠道 × 天按天挡：反过来旧绑定那天没固定、新绑定已固定也整天不算；看单独一天（昨天那种）两条里只有一条算得出时整行不算，不是假亏损也不是假盈利", async (t) => {
  const SWITCH = SH("2026-10-11T12:00:00");
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: { 1: 9 }, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 } });
  await f.at("2026-10-10T10:00:00"); await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T09:00:00"]) await f.round(iso);
  await f.at("2026-10-11T11:00:00"); await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  f.channelKey[1] = 20; await f.round("2026-10-11T12:00:00");
  await f.at("2026-10-11T14:00:00"); await f.profit.start({ ownStationId: f.own.id, channelIds: [1] });
  await settle(f, LATER);
  const rules = await f.rt.reconciliation.listRules({ includeArchived: true });
  const old = rules.find((rule) => rule.archivedAt), fresh = rules.find((rule) => !rule.archivedAt);
  const without = (rule) => f.repository.tables.ledger.splice(0, f.repository.tables.ledger.length, ...f.repository.tables.ledger.filter((row) => !(row.rule_id === rule.id && row.bill_date === "2026-10-11")));
  const D = 24 * 3600, day11 = { preset: "custom", startMs: SH("2026-10-11T00:00:00"), endMs: SH("2026-10-12T00:00:00") }, two = { preset: "custom", startMs: SH("2026-10-10T00:00:00"), endMs: SH("2026-10-12T00:00:00") };
  const kept = [...f.repository.tables.ledger];
  without(old); // 旧的（Key 9，每秒 1）那天没固定
  const noOld = await f.rt.reconciliation.profitPage(two);
  assert.deepEqual([noOld.rows[0].incomeUsd, noOld.rows[0].actualCostUsd, noOld.notCountedDays.count], [2 * D, D, 1], "10-11 整天不算：只剩 10-10 的收入和成本");
  const single = await f.rt.reconciliation.profitPage(day11);
  assert.deepEqual([single.rows[0].counted, single.rows[0].incomeUsd, single.rows[0].actualCostUsd, single.rows[0].grossProfitUsd], [false, null, null, null], "单独看 10-11：新绑定有数、旧的没有，整行不算");
  f.repository.tables.ledger.splice(0, f.repository.tables.ledger.length, ...kept);
  without(fresh); // 新的（Key 20，每秒 3）那天没固定
  const noNew = await f.rt.reconciliation.profitPage(two);
  assert.deepEqual([noNew.rows[0].incomeUsd, noNew.rows[0].actualCostUsd], [2 * D, D]);
  assert.equal((await f.rt.reconciliation.profitPage(day11)).rows[0].counted, false);
});

// 两把 Key 分组不同、倍率不同（New API）：Key 9 在 g1（倍率 1，每秒 1 美元），Key 20 在 g2（倍率 2，每秒 3 美元）；10-12 15 点换 Key。
// 收入按原价用量分：原价 = 成本 ÷ 倍率，不是按成本分
test("每把 Key 分开记账（New API，两把 Key 分组不同、倍率不同）：倍率各自记、原价用量 = 成本 ÷ 倍率，收入按原价用量比例分，几项相加等于渠道合计", async (t) => {
  const SWITCH = SH("2026-10-12T15:00:00");
  const f = await setup(t, { upstreamType: "newapi", keys: [9, 20], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SWITCH], 20: [SWITCH, Infinity] }, rates: { 9: 1, 20: 3 }, tokenGroups: { 20: "g2" }, groupRatios: { g1: 1, g2: 2 } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  for (const iso of ["2026-10-10T23:00:00", "2026-10-11T01:00:00", "2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T23:00:00"]) await f.round(iso);
  await f.at("2026-10-13T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, tokenId: 20 });
  for (const iso of ["2026-10-13T11:00:00", "2026-10-13T12:00:00", "2026-10-13T23:00:00", "2026-10-14T01:00:00"]) await f.round(iso);
  const H = 3600, rule = (await f.rt.reconciliation.listRules())[0];
  const day12 = f.repository.tables.ledgerKeys.filter((row) => row.bill_date === "2026-10-12" && row.rule_id === rule.id).sort((a, b) => a.token_id - b.token_id);
  assert.deepEqual(day12.map((row) => [Number(row.token_id), Number(row.cost_usd), Number(row.ratio), Number(row.raw_usd)]), [[9, 15 * H, 1, 15 * H], [20, 27 * H, 2, 13.5 * H]], "Key 20 的倍率 2：原价用量 = 27H ÷ 2");
  const page = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-12T00:00:00"), endMs: SH("2026-10-13T00:00:00") });
  const [row] = page.rows, k9 = row.keys.find((key) => key.tokenId === 9), k20 = row.keys.find((key) => key.tokenId === 20);
  const income = 2 * 24 * H;
  assert.ok(Math.abs(k9.incomeUsd - income * 15 / 28.5) < 1e-6 && Math.abs(k20.incomeUsd - income * 13.5 / 28.5) < 1e-6, "按原价用量 15 : 13.5 分，不是按成本 15 : 27");
  assert.deepEqual([k9.ratio, k20.ratio, k9.incomeBasis, k20.incomeBasis], [1, 2, "raw", "raw"]);
  assert.ok(Math.abs(k9.incomeUsd + k20.incomeUsd - row.incomeUsd) < 1e-6);
  assert.equal(k9.costUsd + k20.costUsd, row.actualCostUsd);
  const detail = await f.rt.reconciliation.profitDetail({ ruleIds: row.ruleIds, day: "2026-10-12" });
  assert.deepEqual([detail.keyChangeRatioDiffers, detail.split.basis], [true, "raw"]);
});

// 同一天真的换了上游：渠道 1 上午是上游 1 的 Key 9（到 10 点），解绑后 11 点绑到上游 2 的 Key 50，是两条不同的绑定
test("同一天换上游（两条绑定）：这天收入记在后绑的那条上，成本各算各的 Key 整天，每日利润按 Key 分收入，计算明细标出换了上游", async (t) => {
  const f = await setup(t, { upstreamType: "newapi", keys: [9], secondKeys: [50], channelKey: {}, noAgent: true, windows: { 9: [-Infinity, SH("2026-10-11T10:00:00")], 50: [SH("2026-10-11T11:00:00"), Infinity] }, rates: { 9: 1, 50: 2 } });
  await f.at("2026-10-10T10:00:00");
  await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier.id, tokenId: 9 });
  await f.round("2026-10-10T23:00:00"); await f.round("2026-10-11T01:00:00");
  await f.at("2026-10-11T10:00:00");
  await f.profit.stop({ ownStationId: f.own.id, channelIds: [1] });
  await f.at("2026-10-11T11:00:00");
  const moved = await f.profit.selectKey({ ownStationId: f.own.id, channelId: 1, upstreamStationId: f.supplier2.id, tokenId: 50 });
  assert.equal(moved.reopened, undefined, "换了上游：新建一条，不重新打开");
  for (const iso of ["2026-10-11T23:00:00", "2026-10-12T01:00:00", "2026-10-12T09:00:00"]) await f.round(iso);
  const H = 3600, D = 24 * H, rules = await f.rt.reconciliation.listRules({ includeArchived: true });
  const oldRule = rules.find((rule) => rule.archivedAt), newRule = rules.find((rule) => !rule.archivedAt);
  const rowOf = (rule) => f.costOn("2026-10-11").find((row) => row.rule_id === rule.id);
  assert.deepEqual([Number(rowOf(oldRule).revenue_usd), Number(rowOf(oldRule).cost_usd)], [0, 10 * H], "先绑的：收入 0，Key 9 到 10 点的整天成本");
  assert.deepEqual([Number(rowOf(newRule).revenue_usd), Number(rowOf(newRule).cost_usd)], [2 * D, 13 * H * 2], "后绑的：收入整天，Key 50 从 11 点起（每秒 2）");
  const page = await f.rt.reconciliation.profitPage({ preset: "custom", startMs: SH("2026-10-11T00:00:00"), endMs: SH("2026-10-12T00:00:00") });
  assert.equal(page.rows.length, 1, "一个渠道一行");
  const [row] = page.rows;
  assert.deepEqual([row.incomeUsd, row.actualCostUsd], [2 * D, 10 * H + 26 * H]);
  const k9 = row.keys.find((key) => key.tokenId === 9), k50 = row.keys.find((key) => key.tokenId === 50);
  assert.deepEqual([k9.upstream.name, k50.upstream.name, k9.state, k50.state], ["Up", "Up2", "swapped", "active"]);
  // 原价用量 = 成本（倍率 1）：收入按 10H : 26H 分，两边的上游不同也分
  assert.ok(Math.abs(k9.incomeUsd - 2 * D * 10 / 36) < 1e-6 && Math.abs(k50.incomeUsd - 2 * D * 26 / 36) < 1e-6);
  const detail = await f.rt.reconciliation.profitDetail({ ruleIds: row.ruleIds, day: "2026-10-11" });
  assert.deepEqual([detail.swappedUpstream, detail.split.basis, detail.keys.length], [true, "raw", 2]);
  assert.ok(Math.abs(detail.keys.reduce((sum, key) => sum + key.incomeUsd, 0) - detail.income.usd) < 1e-6);
});
