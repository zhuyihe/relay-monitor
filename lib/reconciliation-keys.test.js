import assert from "node:assert/strict";
import test from "node:test";
import { claimedKeyWindows, keyClaimProblems, keyPiecesOf, segmentKeyTokens, sumKeyStats } from "./reconciliation-keys.js";

const metadata = { tokens: [{ id: 9, name: "oai", status: 1 }, { id: 10, name: "oai-2", status: 1 }] };

test("segmentKeyTokens：分段没带 Key 就是绑定自己那把；带了的按目录找，目录里没有的是已删的 Key（带上分段里记的名字）", () => {
  const ruleToken = metadata.tokens[0];
  assert.deepEqual(segmentKeyTokens({ segmentKeys: [], ruleToken, metadata, upstreamStationId: "up" }), [{ token: ruleToken, deleted: false, own: true }]);
  assert.deepEqual(segmentKeyTokens({ segmentKeys: undefined, ruleToken, metadata, upstreamStationId: "up" }), [{ token: ruleToken, deleted: false, own: true }]);
  const keys = [{ upstreamStationId: "up", tokenId: 9, tokenName: "oai" }, { upstreamStationId: "up", tokenId: 7, tokenName: "old" }];
  assert.deepEqual(segmentKeyTokens({ segmentKeys: keys, ruleToken, metadata, upstreamStationId: "up" }), [
    { token: metadata.tokens[0], deleted: false }, { token: { id: 7, name: "old", deleted: true }, deleted: true }]);
  const foreign = segmentKeyTokens({ segmentKeys: [{ upstreamStationId: "other", tokenId: 1 }], ruleToken, metadata, upstreamStationId: "up" });
  assert.equal(foreign[0].foreign, true, "别的上游的 Key 这一版读不了");
});

test("sumKeyStats：一把就是原样；New API 几把按额度相加再换成美元；有一把还在等整体就在等；有一把读不到金额整体读不到", () => {
  const one = { state: "complete", complete: true, quotaUnits: 100, quotaPerUnit: 100, amountUsd: 1 };
  assert.equal(sumKeyStats([one]), one, "一把：同一个对象，结果逐字不变");
  const a = { state: "complete", complete: true, quotaUnits: 100, quotaPerUnit: 100, amountUsd: 1, knownAmountUsd: 1, latestLogAtMs: 5 };
  const b = { state: "complete", complete: true, quotaUnits: 250, quotaPerUnit: 100, amountUsd: 2.5, knownAmountUsd: 2.5, latestLogAtMs: 9 };
  const sum = sumKeyStats([a, b]);
  assert.deepEqual([sum.state, sum.complete, sum.quotaUnits, sum.amountUsd, sum.knownAmountUsd, sum.latestLogAtMs, sum.keyCount], ["complete", true, 350, 3.5, 3.5, 9, 2]);
  const waiting = sumKeyStats([a, { ...b, state: "pending", complete: false, emptySecondWindow: true, amountUsd: null }]);
  assert.deepEqual([waiting.state, waiting.complete, waiting.amountUsd], ["pending", false, null]);
  const unknown = sumKeyStats([a, { ...b, quotaUnits: null, amountUsd: null, knownAmountUsd: null, state: "partial", complete: false }]);
  assert.deepEqual([unknown.state, unknown.amountUsd, unknown.knownAmountUsd, unknown.quotaUnits], ["partial", null, null, null]);
  // 单位不一样（换到另一个上游的 Key 在过渡段里和旧 Key 一起算：New API 的额度、Sub2API 的美元）：额度不加，各自的美元相加；有一把没有美元整体就没有
  const mixed = sumKeyStats([a, { ...b, quotaPerUnit: 500 }]);
  assert.deepEqual([mixed.quotaUnits, mixed.amountUsd], [null, 3.5]);
  const mixedUnknown = sumKeyStats([a, { ...b, quotaPerUnit: 500, amountUsd: null }]);
  assert.deepEqual([mixedUnknown.quotaUnits, mixedUnknown.amountUsd], [null, null]);
});

test("sumKeyStats：Sub2API（美元，没有额度）几把按美元相加", () => {
  const s = (cost) => ({ platform: "sub2api", state: "complete", complete: true, quotaUnits: null, quotaPerUnit: null, amountUsd: cost, knownAmountUsd: cost, actualCostUsd: cost });
  const sum = sumKeyStats([s(1.25), s(0.75)]);
  assert.deepEqual([sum.amountUsd, sum.knownAmountUsd, sum.actualCostUsd, sum.state], [2, 2, 2, "complete"]);
});

test("keyPiecesOf：按段 ∩ 窗口切成几截，每截用自己那段的 Key；没换过 Key 的窗口返回 null（整窗单次取数，结果不变）", () => {
  const DAY = 86400000, w = { startMs: 10 * DAY, endMs: 11 * DAY, timezone: "UTC" };
  const seg = (from, to, ids, extra = {}) => Object.defineProperty({ id: `s${from}`, effectiveFrom: from, effectiveTo: to, ...extra }, "keys", { value: ids.map((tokenId) => ({ tokenId })), enumerable: false });
  const idsOf = (pieces) => pieces.map(({ segment, window }) => [segment.keys.map((key) => key.tokenId), window.startMs, window.endMs]);
  const a = 10 * DAY + 3 * 3600000, b = 10 * DAY + 15 * 3600000;
  // 换 Key：[0, a) 旧、[a, b) 两把、[b, ) 新 → 三截
  const changed = [seg(0, a, [9]), seg(a, b, [9, 10]), seg(b, null, [10])];
  assert.deepEqual(idsOf(keyPiecesOf(changed, w, 10)), [[[9], w.startMs, a], [[9, 10], a, b], [[10], b, w.endMs]]);
  // 窗口从过渡段中间起：第一截从窗口起点
  assert.deepEqual(idsOf(keyPiecesOf(changed, { ...w, startMs: a + 1000 }, 10)), [[[9, 10], a + 1000, b], [[10], b, w.endMs]]);
  // 窗口整个在换 Key 以后：和最新段一样，不用改（null）
  assert.equal(keyPiecesOf(changed, { ...w, startMs: b + DAY, endMs: b + 2 * DAY }, 10), null);
  // 窗口整个在换 Key 以前（换了以后回头读旧的一天）：一截，但用旧 Key，不能拿最新段的 Key
  assert.deepEqual(idsOf(keyPiecesOf(changed, { ...w, startMs: a - 2 * DAY, endMs: a - DAY }, 10)), [[[9], a - 2 * DAY, a - DAY]]);
  // 没换过 Key：只有一段、或者几段（倍率变了）用的 Key 一样——null；没带 Key 的段按绑定自己那把算
  assert.equal(keyPiecesOf([seg(0, null, [9])], w, 9), null);
  assert.equal(keyPiecesOf([seg(0, a, [9]), seg(a, null, [9])], w, 9), null, "只是倍率变了");
  assert.equal(keyPiecesOf([{ effectiveFrom: 0, effectiveTo: a }, { effectiveFrom: a, effectiveTo: null }], w, 9), null, "分段没带 Key：都是绑定自己那把");
  // 第一段的起点不当边界（核算起点那天从 0 点起整天算，段起点是当天中途）
  assert.deepEqual(idsOf(keyPiecesOf([seg(a, b, [9]), seg(b, null, [10])], w, 10)), [[[9], w.startMs, b], [[10], b, w.endMs]]);
  // 换过去又换回来（A、B、A）：三截，不合并不相邻的；相邻同 Key 的合成一截
  assert.deepEqual(idsOf(keyPiecesOf([seg(0, a, [9]), seg(a, b, [10]), seg(b, null, [9])], w, 9)), [[[9], w.startMs, a], [[10], a, b], [[9], b, w.endMs]]);
  assert.deepEqual(idsOf(keyPiecesOf([seg(0, a, [9]), seg(a, b, [9]), seg(b, null, [10])], w, 10)), [[[9], w.startMs, b], [[10], b, w.endMs]], "相邻两截 Key 一样合成一截");
  assert.equal(keyPiecesOf([], w, 9), null);
  assert.equal(keyPiecesOf(undefined, w, 9), null);
});

// ---- 结账前的 Key 占用检查 ----
const H = 3600000;
const key = (tokenId) => ({ upstreamStationId: "up", tokenId });
const claimant = (ruleId, claims, { startMs = 0, archivedAtMs = null } = {}) => ({ ruleId, startMs, archivedAtMs,
  claims: new Map(Object.entries(claims).map(([tokenId, windows]) => [`up:${tokenId}`, { key: key(Number(tokenId)), windows: windows.map(([a, b]) => ({ startMs: a * H, endMs: b * H })) }])) });
const KEYS = ["up:9", "up:10"];

test("claimedKeyWindows：每把 Key 在每一截里认领的时间段，相邻的并成一段；起算点以前的不算；段里没记 Key 用绑定自己那把", () => {
  const seg = (keys) => ({ keys });
  const pieces = [{ segment: seg([key(9)]), window: { startMs: 0, endMs: 5 * H } }, { segment: seg([key(9), key(10)]), window: { startMs: 5 * H, endMs: 7 * H } }, { segment: seg([key(10)]), window: { startMs: 7 * H, endMs: 24 * H } }];
  const claimed = claimedKeyWindows(pieces, { fallbackKey: key(9) });
  assert.deepEqual([...claimed.entries()].map(([id, entry]) => [id, entry.windows]), [["up:9", [{ startMs: 0, endMs: 7 * H }]], ["up:10", [{ startMs: 5 * H, endMs: 24 * H }]]]);
  assert.deepEqual([...claimedKeyWindows(pieces, { fallbackKey: key(9), claimFloors: new Map([["up:9", 6 * H]]) }).get("up:9").windows], [{ startMs: 6 * H, endMs: 7 * H }]);
  assert.deepEqual(claimedKeyWindows([{ segment: seg([]), window: { startMs: 0, endMs: 24 * H } }], { fallbackKey: key(9) }).get("up:9").windows, [{ startMs: 0, endMs: 24 * H }]);
});

test("keyClaimProblems：正常的换 Key、互换、停掉的绑定、Key 挪给没在算的渠道都没有问题", () => {
  // 互换：两条都在 9 点切开，各把 Key 前后相接
  assert.deepEqual(keyClaimProblems([claimant("a", { 9: [[0, 9]], 10: [[9, 24]] }), claimant("b", { 10: [[0, 9]], 9: [[9, 24]] })], KEYS), []);
  // 换 Key：新 Key 从 [a, b) 起认领，旧 Key 到 b 为止
  assert.deepEqual(keyClaimProblems([claimant("a", { 9: [[0, 9]], 10: [[8, 24]] })], KEYS), []);
  // 停掉的绑定：b 在 9 点停了，Key 9 后面没有人认领——不是漏
  assert.deepEqual(keyClaimProblems([claimant("a", { 9: [[0, 9]] }, { archivedAtMs: 9 * H }), claimant("b", { 10: [[0, 24]] })], KEYS), []);
  // Key 9 挪给了没在算的渠道：a 在 9 点把它放下，后面没有任何绑定认领
  assert.deepEqual(keyClaimProblems([claimant("a", { 9: [[0, 9]], 10: [[9, 24]] })], KEYS), []);
  // 停掉的绑定放下 Key，另一条在算的绑定晚几个小时才接手：停的那一刻起就不是在算，不算漏
  assert.deepEqual(keyClaimProblems([claimant("a", { 9: [[0, 9]] }, { archivedAtMs: 9 * H }), claimant("b", { 9: [[12, 24]] })], KEYS), []);
  // 后来才建的绑定：放下 Key 的时候它还没建
  assert.deepEqual(keyClaimProblems([claimant("a", { 9: [[0, 9]] }), claimant("b", { 9: [[12, 24]] }, { startMs: 11 * H })], KEYS), []);
});

test("keyClaimProblems：重叠（同一把 Key 同一段时间在两条绑定里）和空档（两条在算的绑定之间漏了一段）", () => {
  const overlap = keyClaimProblems([claimant("a", { 9: [[0, 12]] }), claimant("b", { 9: [[9, 24]] })], KEYS);
  assert.deepEqual(overlap.map((item) => [item.type, item.keyId, item.ruleIds, item.fromMs / H, item.toMs / H]), [["overlap", "up:9", ["a", "b"], 9, 12]]);
  const gap = keyClaimProblems([claimant("a", { 9: [[0, 9]] }), claimant("b", { 9: [[12, 24]] })], KEYS);
  assert.deepEqual(gap.map((item) => [item.type, item.keyId, item.ruleIds, item.fromMs / H, item.toMs / H]), [["gap", "up:9", ["a", "b"], 9, 12]]);
  // 一条绑定把一把 Key 认领成好几段（中间让给别人）：自己和自己不算重叠；中间让出去的那段别人接上了，没有空档
  assert.deepEqual(keyClaimProblems([claimant("a", { 9: [[0, 6], [12, 24]] }), claimant("b", { 9: [[6, 12]] })], KEYS), []);
  // 只看被检查那条绑定用到的 Key：别的 Key 上的问题不管
  assert.deepEqual(keyClaimProblems([claimant("a", { 9: [[0, 12]], 10: [[0, 24]] }), claimant("b", { 9: [[9, 24]] })], ["up:10"]), []);
  // 三条绑定：重叠只报相邻认领的两条，不重复报同一个问题
  assert.equal(keyClaimProblems([claimant("a", { 9: [[0, 10]] }), claimant("b", { 9: [[8, 16]] }), claimant("c", { 9: [[16, 24]] })], KEYS).length, 1);
});
