import test from "node:test";
import assert from "node:assert/strict";
import { MERGE_BLOCKERS, mergedCostAliases, mergedStationPatches, mergeCandidates, planUpstreamMerges } from "./upstream-merge.js";

const identity = (accountId, baseUrl = "https://up.example.com", provider = "newapi") => ({ provider, baseUrl, accountId });
const station = (id, createdAt, overrides = {}) => ({
  id, name: `上游 ${id}`, type: "newapi", baseUrl: "https://up.example.com", createdAt, monitorEnabled: true, includeInProfit: true,
  costAliases: [], fixedPurchases: [], resoldAdminKeys: [], verifiedIdentity: identity("42"), ...overrides,
});

test("三样一样（类型、站点地址、账号 ID）才合：留下创建最早的", () => {
  const stations = [
    station("b", "2026-03-02T00:00:00.000Z"),
    station("a", "2026-03-01T00:00:00.000Z"),
    station("c", "2026-03-03T00:00:00.000Z", { baseUrl: "https://up.example.com/", verifiedIdentity: identity("42", "https://up.example.com/") }),
    station("other-account", "2026-03-01T00:00:00.000Z", { verifiedIdentity: identity("43") }),
    station("other-site", "2026-03-01T00:00:00.000Z", { baseUrl: "https://elsewhere.example.com", verifiedIdentity: identity("42", "https://elsewhere.example.com") }),
    station("sub2", "2026-03-01T00:00:00.000Z", { type: "sub2api", verifiedIdentity: identity("42", "https://up.example.com", "sub2api") }),
  ];
  const { groups } = planUpstreamMerges({ stations });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].retained.id, "a");
  assert.deepEqual(groups[0].merged.map((s) => s.id), ["b", "c"]);
  assert.deepEqual(groups[0].key, identity("42"));
  assert.equal(groups[0].canMerge, true);
});

test("创建时间一样按 id；读不出账号 ID 的、只用 Key 的、自营站点、已归档的、已合并的都不参与", () => {
  const same = "2026-03-01T00:00:00.000Z";
  const stations = [
    station("z", same), station("y", same),
    station("keyonly", same, { type: "newapi-key", verifiedIdentity: null }),
    station("unverified", same, { verifiedIdentity: null }),
    station("own", same, { isOwn: true }),
    station("archived", same, { archivedAt: "2026-04-01T00:00:00.000Z" }),
    station("merged", same, { mergedInto: "y" }),
  ];
  assert.deepEqual(mergeCandidates(stations).map((s) => s.id), ["z", "y"]);
  const { groups } = planUpstreamMerges({ stations });
  assert.equal(groups[0].retained.id, "y");
  assert.deepEqual(groups[0].merged.map((s) => s.id), ["z"]);
});

test("只有一个上游的账号不出清单", () => {
  assert.deepEqual(planUpstreamMerges({ stations: [station("a", "2026-03-01T00:00:00.000Z")] }).groups, []);
});

test("绑定和看余额的关联：数出会跟着改的，重复的关联算会被去掉的", () => {
  const stations = [station("a", "2026-03-01T00:00:00.000Z"), station("b", "2026-03-02T00:00:00.000Z"), station("c", "2026-03-03T00:00:00.000Z")];
  const rules = [
    { id: "r1", upstreamStationId: "b", tokenId: 5, enabled: true, activeKey: "canonical-5" },
    { id: "r2", upstreamStationId: "c", tokenId: 6, enabled: true, activeKey: "c:6" },
    { id: "r3", upstreamStationId: "a", tokenId: 7, enabled: true, activeKey: "a:7" },
    { id: "r4", upstreamStationId: "b", tokenId: 8, enabled: false, activeKey: null },
  ];
  const links = [
    { ownStationId: "own", channelId: 1, stationId: "a" },
    { ownStationId: "own", channelId: 1, stationId: "b" },
    { ownStationId: "own", channelId: 2, stationId: "b" },
    { ownStationId: "own", channelId: 2, stationId: "c" },
    { ownStationId: "own", channelId: 3, stationId: "c" },
  ];
  const [group] = planUpstreamMerges({ stations, rules, links }).groups;
  assert.deepEqual(group.ruleIds, ["r1", "r2", "r4"]);
  assert.equal(group.linkCount, 4);
  assert.equal(group.droppedLinkCount, 2);
  assert.equal(group.canMerge, true);
});

test("挡着不能合的事：监控状态不一样、算不算利润不一样、被合掉的有固定成本、改指向后同一把 Key 撞上", () => {
  const base = [station("a", "2026-03-01T00:00:00.000Z"), station("b", "2026-03-02T00:00:00.000Z")];
  const codes = (stations, rules = []) => planUpstreamMerges({ stations, rules }).groups[0].blockers.map((item) => item.code);
  assert.deepEqual(codes([base[0], { ...base[1], monitorEnabled: false }]), [MERGE_BLOCKERS.MONITOR_MISMATCH]);
  assert.deepEqual(codes([base[0], { ...base[1], includeInProfit: false }]), [MERGE_BLOCKERS.PROFIT_MISMATCH]);
  assert.deepEqual(codes([base[0], { ...base[1], fixedPurchases: [{ amount: 1, days: 30, startDate: null }] }]), [MERGE_BLOCKERS.MERGED_HAS_FIXED_COST]);
  assert.deepEqual(codes([base[0], { ...base[1], resoldAdminKeys: [{ username: "u", tokenName: "t" }] }]), [MERGE_BLOCKERS.MERGED_HAS_RESOLD_KEYS]);
  assert.deepEqual(codes([{ ...base[0], fixedPurchases: [{ amount: 1, days: 30, startDate: null }] }, base[1]]), [], "留下的有固定成本不挡");
  assert.deepEqual(codes(base, [
    { id: "r1", upstreamStationId: "a", tokenId: 5, enabled: true, activeKey: "a:5" },
    { id: "r2", upstreamStationId: "b", tokenId: 5, enabled: true, activeKey: "b:5" },
  ]), [MERGE_BLOCKERS.RULE_KEY_CONFLICT]);
  assert.deepEqual(codes(base, [
    { id: "r1", upstreamStationId: "a", tokenId: 5, enabled: true, activeKey: "canon" },
    { id: "r2", upstreamStationId: "b", tokenId: 5, enabled: true, activeKey: "b:5" },
  ]), [], "键里带了账号（canonicalKey）的和上游 id 无关，不撞");
  const blocked = planUpstreamMerges({ stations: [base[0], { ...base[1], monitorEnabled: false }] }).groups[0];
  assert.equal(blocked.canMerge, false);
  assert.deepEqual(blocked.blockers[0], { code: MERGE_BLOCKERS.MONITOR_MISMATCH, detail: "有的在监控、有的暂停了", monitoredIds: ["a"], pausedIds: ["b"], differsIds: ["b"] });
  const profit = planUpstreamMerges({ stations: [base[0], { ...base[1], includeInProfit: false }] }).groups[0];
  assert.deepEqual(profit.blockers[0], { code: MERGE_BLOCKERS.PROFIT_MISMATCH, detail: "有的算进利润、有的不算", countedIds: ["a"], uncountedIds: ["b"], differsIds: ["b"] });
  const fixed = planUpstreamMerges({ stations: [base[0], { ...base[1], fixedPurchases: [{ amount: 1, days: 30, startDate: null }] }] }).groups[0];
  assert.equal(fixed.blockers[0].stationId, "b");
  // 一组里几个上游有几项不一样：一项一条，同一把 Key 撞了的排最前
  const [many] = planUpstreamMerges({ stations: [base[0], { ...base[1], monitorEnabled: false, includeInProfit: false }], rules: [
    { id: "r1", upstreamStationId: "a", tokenId: 5, tokenName: "oai", enabled: true, activeKey: "a:5" },
    { id: "r2", upstreamStationId: "b", tokenId: 5, tokenName: "oai", enabled: true, activeKey: "b:5" }] }).groups;
  assert.deepEqual(many.blockers.map((item) => item.code), [MERGE_BLOCKERS.RULE_KEY_CONFLICT, MERGE_BLOCKERS.MONITOR_MISMATCH, MERGE_BLOCKERS.PROFIT_MISMATCH]);
});

test("合并以后留下的那个的别名：自己的、被合掉的别名，不重复，不记留下那个自己的地址（只差结尾的 / 也算同一个）", () => {
  const retained = station("a", "2026-03-01T00:00:00.000Z", { costAliases: ["http://internal-a"] });
  const merged = [
    station("b", "2026-03-02T00:00:00.000Z", { baseUrl: "https://up.example.com/", verifiedIdentity: identity("42", "https://up.example.com/"),
      costAliases: ["http://internal-a", "http://10.0.0.8:8080"] }),
    station("c", "2026-03-03T00:00:00.000Z", { costAliases: ["http://internal-c", "https://up.example.com"] }),
  ];
  assert.deepEqual(mergedCostAliases(retained, merged), ["http://internal-a", "http://10.0.0.8:8080", "http://internal-c"]);
  const [group] = planUpstreamMerges({ stations: [retained, ...merged] }).groups;
  assert.deepEqual(group.costAliasesAfter, ["http://internal-a", "http://10.0.0.8:8080", "http://internal-c"]);
});

test("上游文档的改动：留下的只改别名，被合掉的记并进了谁和时刻", () => {
  const [group] = planUpstreamMerges({ stations: [station("a", "2026-03-01T00:00:00.000Z"), station("b", "2026-03-02T00:00:00.000Z", { costAliases: ["http://internal-b"] })] }).groups;
  assert.deepEqual(mergedStationPatches(group, { nowIso: "2026-10-26T00:00:00.000Z" }),
    { retained: { costAliases: ["http://internal-b"] }, merged: { b: { mergedInto: "a", mergedAt: "2026-10-26T00:00:00.000Z" } } });
});

test("同一把 Key 撞上：写清是哪把 Key（编号和名字）、在哪两个上游下", () => {
  const stations = [station("a", "2026-03-01T00:00:00.000Z"), station("b", "2026-03-02T00:00:00.000Z"), station("c", "2026-03-03T00:00:00.000Z")];
  const [group] = planUpstreamMerges({ stations, rules: [
    { id: "r1", upstreamStationId: "a", tokenId: 5, tokenName: "oai", enabled: true, activeKey: "a:5" },
    { id: "r2", upstreamStationId: "b", tokenId: 5, tokenName: "oai", enabled: true, activeKey: "b:5" },
    { id: "r3", upstreamStationId: "b", tokenId: 7, tokenName: "claude", enabled: true, activeKey: "b:7" },
    { id: "r4", upstreamStationId: "c", tokenId: 7, tokenName: "claude", enabled: true, activeKey: "c:7" },
  ] }).groups;
  assert.deepEqual(group.blockers, [
    { code: MERGE_BLOCKERS.RULE_KEY_CONFLICT, detail: "Key #5 已经有一条绑定在用", tokenId: 5, tokenName: "oai", ruleId: "r2", stationIds: ["a", "b"] },
    { code: MERGE_BLOCKERS.RULE_KEY_CONFLICT, detail: "Key #7 已经有一条绑定在用", tokenId: 7, tokenName: "claude", ruleId: "r4", stationIds: ["b", "c"] },
  ]);
});
