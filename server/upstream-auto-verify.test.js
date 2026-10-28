import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_VERIFY_BACKOFF_MS, createAutoVerifier } from "./upstream-auto-verify.js";

const identity = { provider: "newapi", baseUrl: "https://a.test", accountId: "7" };
function setup({ stations, failKeys = false } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const list = stations || [{ id: "u1", type: "newapi", baseUrl: "https://a.test", verifiedIdentity: null }];
  const rt = {
    store: { list: () => list, get: (id) => list.find((s) => s.id === id) },
    reconciliation: {
      getUpstreamKeys: async (id, opts) => { calls.push(["keys", id, opts.tokenId ?? null]); if (failKeys) throw new Error("down"); return { identity, resourceVersion: "v1" }; },
      listRules: async () => [{ id: "r1", upstreamStationId: "u1", enabled: true, tokenId: 5, timezone: "Asia/Shanghai" }],
    },
    channelOnboarding: { confirmResourceIdentity: async (id) => { calls.push(["confirm", id]); } },
  };
  return { verifier: createAutoVerifier(rt, { now: () => clock }), calls, tick: (ms) => { clock += ms; } };
}

test("加上游马上试：读 Key 目录、确认身份、再拿一把绑了的 Key 试读完整账单", async () => {
  const f = setup();
  assert.equal(await f.verifier.verifySoon({ id: "u1", type: "newapi" }), true);
  assert.deepEqual(f.calls, [["keys", "u1", null], ["confirm", "u1"], ["keys", "u1", 5]]);
});

test("定时一天一次：没到点不读，过了一天再读；失败按退避再试，成功后清零", async () => {
  const f = setup({ failKeys: true });
  await f.verifier.verifyDue(); assert.equal(f.calls.length, 1);
  await f.verifier.verifyDue(); assert.equal(f.calls.length, 1, "没到退避时间不再读");
  f.tick(AUTO_VERIFY_BACKOFF_MS[0] + 1); await f.verifier.verifyDue(); assert.equal(f.calls.length, 2);
  f.tick(AUTO_VERIFY_BACKOFF_MS[1] + 1); await f.verifier.verifyDue(); assert.equal(f.calls.length, 3, "第二次退避更长");
  const ok = setup();
  await ok.verifier.verifyDue(); const n = ok.calls.length;
  ok.tick(3600 * 1000); await ok.verifier.verifyDue(); assert.equal(ok.calls.length, n, "成功后一天内不再读");
  ok.tick(24 * 3600 * 1000); await ok.verifier.verifyDue(); assert.ok(ok.calls.length > n);
});

test("自营站点、归档的、只用 Key 的、没在监控的上游不试", async () => {
  const f = setup({ stations: [{ id: "o", type: "newapi", isOwn: true }, { id: "a", type: "newapi", archivedAt: "x" }, { id: "k", type: "newapi-key" }, { id: "m", type: "newapi", monitorEnabled: false }] });
  await f.verifier.verifyDue();
  assert.deepEqual(f.calls, []);
});
