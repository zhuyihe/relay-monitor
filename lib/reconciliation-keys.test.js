import assert from "node:assert/strict";
import test from "node:test";
import { keyPiecesOf, segmentKeyTokens, sumKeyStats } from "./reconciliation-keys.js";

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
  // 额度单位不一样（不该出现）：当读不到，不硬加
  const mixed = sumKeyStats([a, { ...b, quotaPerUnit: 500 }]);
  assert.deepEqual([mixed.quotaUnits, mixed.amountUsd], [null, null]);
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
