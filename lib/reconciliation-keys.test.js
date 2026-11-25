import assert from "node:assert/strict";
import test from "node:test";
import { segmentKeyTokens, sumKeyStats, observedKeyName, needsKeyIdBilling } from "./reconciliation-keys.js";

const metadata = { tokens: [{ id: 9, name: "oai", status: 1 }, { id: 10, name: "oai-2", status: 1 }] };

test("改名只按已核验的身份同步，改回原名仍按 ID 读账单；分段保留历史名字差异", () => {
  const rule = { tokenId: 9, tokenName: "old", canonicalKey: "account-key" };
  const token = { id: 9, name: "new" };
  for (const identity of [null, "other-account-key"]) assert.equal(observedKeyName(rule, token, identity), null);
  assert.equal(observedKeyName(rule, { ...token, id: 10 }, rule.canonicalKey), null);
  const history = observedKeyName(rule, token, rule.canonicalKey, 123);
  assert.deepEqual(history[rule.canonicalKey].names, ["old", "new"]);
  const renamed = { ...rule, tokenName: token.name, keyNameHistory: history };
  assert.equal(needsKeyIdBilling(renamed, token, rule.canonicalKey), true);
  const back = { ...token, name: "old" };
  const backRule = { ...renamed, tokenName: "old", keyNameHistory: observedKeyName(renamed, back, rule.canonicalKey, 124) };
  assert.equal(needsKeyIdBilling(backRule, back, rule.canonicalKey), true);
  assert.equal(needsKeyIdBilling({ ...backRule, tokenId: 10, tokenName: "another" }, { id: 10, name: "another" }, "another-key"), false);
  const [segment] = segmentKeyTokens({ segmentKeys: [{ tokenId: 9, tokenName: "old" }], metadata: { tokens: [token] } });
  assert.equal(segment.token.recordedName, "old");
  assert.equal(needsKeyIdBilling(null, segment.token, rule.canonicalKey), true);
});

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
  const reading = sumKeyStats([a, { ...b, state: "pending", complete: false, quotaUnits: null, amountUsd: null, knownAmountUsd: null }]);
  assert.deepEqual([reading.state, reading.complete, reading.amountUsd, reading.emptySecondWindow], ["pending", false, null, undefined], "日志读取中与不足一秒的窗口分开标记，多把 Key 汇总后仍继续等");
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
