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

const SH = (iso) => Date.parse(`${iso}+08:00`);
const KEY_AGENT_SECRET = "K7m2-xP9q" + "R4t".repeat(10);
const DAY = 86400;

async function setup(t, { upstreamType, keys = [9, 10, 11, 12], channelKey = { 1: 9, 2: 9, 3: 9, 4: 10, 5: 11, 6: 12 }, windows = {} }) {
  const state = { now: SH("2026-10-10T09:00:00") };
  t.mock.method(Date, "now", () => state.now);
  // windows[keyId] = [fromMs, toMs)：这把 Key 有用量的时段（每秒 1 美元）；没给就是一直在用
  const used = (keyId, fromMs, toMs) => { const [a, b] = windows[keyId] || [-Infinity, Infinity]; return Math.max(0, Math.min(toMs, b, state.now) - Math.max(fromMs, a)) / 1000; };
  const fake = upstreamType === "sub2api" ? createFakeSub2Api({ keys: keys.map((id) => ({ id, name: `Key ${id}` })),
    dayUsageUsd: (id, day) => { const start = SH(`${day}T00:00:00`); return used(Number(id), start, start + DAY * 1000); }, now: () => state.now }) : null;
  const reply = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push(`${url.host}${url.pathname}`);
    if (url.host === "up.test") {
      if (fake) { const hit = fake.handle(url); if (hit) return hit; return reply({ code: 404 }, 404); }
      if (url.pathname === "/api/user/self") return reply({ success: true, data: { id: 42, quota: 100, used_quota: 1 } });
      if (url.pathname === "/api/status") return reply({ success: true, data: { quota_per_unit: 100 } });
      if (url.pathname === "/api/user/self/groups") return reply({ success: true, data: { g1: { ratio: 1 } } });
      if (url.pathname === "/api/token/") return reply({ success: true, data: { total: keys.length, items: keys.map((id) => ({ id, user_id: 42, name: `Key ${id}`, status: 1, group: "g1", cross_group_retry: false })) } });
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
  const own = await store.add({ type: "newapi", baseUrl: "https://own.test", accessToken: "admin", isOwn: true, keyAgentUrl: "https://own.test/key-agent", keyAgentSecret: KEY_AGENT_SECRET });
  const supplier = await store.add(upstreamType === "sub2api" ? { name: "Up", type: "sub2api", baseUrl: "https://up.test", accessToken: "jwt", accountUse: "only_mine" }
    : { name: "Up", type: "newapi", baseUrl: "https://up.test", accessToken: "pat", accountUse: "only_mine" });
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
      slots: [{ index: 0, state: "identified", matches: [{ stationId: supplier.id, tokenId, tokenName: `Key ${tokenId}`, via: "fingerprint" }] }] })) });
  const inject = () => { const result = identified(); rt._keyAgentIdentifyCache = { at: state.now, stationId: own.id, result, lastGood: { etag: null, result, snapshotChannels: null, comparedAt: state.now } }; };
  const profit = createChannelProfitModule(rt, { identify: async () => identified() });
  const at = async (iso) => { state.now = SH(iso); inject(); await rt.channelOnboarding.sync(); };
  const round = async (iso) => { await at(iso); await rt.reconciliation.refreshDue(state.now); };
  const costOn = (day) => repository.tables.ledger.filter((row) => row.bill_date === day);
  return { state, rt, store, own, supplier, repository, profit, at, round, costOn, requests, channelKey, used };
}

for (const upstreamType of ["newapi", "sub2api"]) {
  test(`开始 / 停止算利润的钱（${upstreamType}）：开始（只勾一个、两把 Key）→ 停 → 当天再开始 → 当天开始当天停 → 跨零点开始；每天成本之和 = 该算的 Key 用量之和`, async (t) => {
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
      "2026-10-11": { 9: DAY, 10: DAY }, // 旧 [0,15:00) + 新从 15:00（floor）起
      "2026-10-12": { 9: DAY, 10: DAY, 11: 20 * 3600, 12: DAY },
      "2026-10-13": { 9: DAY, 10: DAY, 12: DAY },
      "2026-10-14": { 9: DAY, 10: DAY, 12: DAY },
    } : {
      "2026-10-10": { 9: DAY, 10: DAY },
      "2026-10-11": { 9: DAY, 10: DAY }, // C③：旧那天整天不算，新的整天算
      "2026-10-12": { 9: DAY, 10: DAY, 12: DAY }, // Key 11 当天开始当天停：整天不算
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
  test(`A 在算、当天 9 点换 Key，旧 Key 挪给新渠道 B，手动开始 B——每天所有行成本之和 = 各 Key 当天用量之和（${upstreamType}）`, async (t) => {
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
  test(`决定 54（${upstreamType}）：渠道上午属于一条停掉的绑定，下午换了 Key 重新开始——新建的绑定从停的那一刻起算（New API），Sub2API 停掉的那天整天不算、新的整天算，收入只算一次`, async (t) => {
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
    // New API：旧的 [0, 11) + 新的从 11 点起 → 收入全天一次；成本 Key 9 [0, 11) + Key 20 [12, 24)。Sub2API：旧的那天整天不算（C③），新的整天 → 收入全天一次；成本 Key 20 从 12 点起
    assert.deepEqual([d.cost, d.revenue], upstreamType === "newapi" ? [11 * 3600 + 12 * 3600, 2 * DAY] : [12 * 3600, 2 * DAY]);
  });

  test(`决定 54 走追加（${upstreamType}）：渠道上午属于停掉的绑定 C，下午换成 A 正在算的 Key——今天不让开始（COUNTED_EARLIER_TODAY，写明停的时刻和原来那把 Key），C 算到停的那一刻，A 那天不含这个渠道的收入；第二天 0 点起开始，算进 A`, async (t) => {
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
    // 收入：A 只有渠道 1（全天）；C（渠道 6）New API 算到 10 点；Sub2API 停掉的那天整天不算。成本：Key 9 全天（A）+ Key 30 [0, 10)（New API 的 C）
    assert.deepEqual([d.cost, d.revenue], upstreamType === "newapi" ? [DAY + 10 * 3600, 2 * DAY + 2 * 10 * 3600] : [DAY, 2 * DAY], "C 那把 Key 上午的钱算在 C 里，A 那天不含渠道 6 的收入");
    // 第二天 0 点以后可以开始：追加进 A
    await f.at("2026-10-12T00:30:00");
    assert.equal((await f.profit.status(f.own.id)).channels.find((channel) => channel.channelId === 6).state, "startable");
    const next = await f.profit.start({ ownStationId: f.own.id, channelIds: [6] });
    assert.equal(next.started.length, 1, JSON.stringify(next));
    await settle(f, ["2026-10-12T09:00:00", "2026-10-13T01:00:00"]);
    const d2 = dayTotals(f, "2026-10-12");
    assert.deepEqual([d2.cost, d2.revenue], [DAY, 4 * DAY], "第二天起渠道 6 正常算进 A：收入两个渠道各全天，成本 Key 9 全天");
  });
}
