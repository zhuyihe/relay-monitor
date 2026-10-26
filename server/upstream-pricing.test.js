import test from "node:test";
import assert from "node:assert/strict";
import { PRICING_RETRY_MS, PRICING_TTL_MS, createUpstreamPricing } from "./upstream-pricing.js";

const upstream = { id: "up", type: "newapi", baseUrl: "https://up.test", accessToken: "pat" };
const body = { success: true, data: [{ model_name: "gpt", quota_type: 0, model_ratio: 2, completion_ratio: 4 }], group_ratio: { default: 1 } };

test("价目表每个上游每小时读一次：一小时内都用缓存，并发的合成一次；Sub2API、自营站点不读（UPSTREAM_PRICE_UNSUPPORTED）", async () => {
  let now = 0, reads = 0;
  const pricing = createUpstreamPricing({}, { now: () => now, read: async () => { reads += 1; return body; } });
  const [a, b] = await Promise.all([pricing.pricingFor(upstream), pricing.pricingFor(upstream)]);
  assert.equal(reads, 1);
  assert.equal(a, b);
  now += PRICING_TTL_MS - 1;
  await pricing.pricingFor(upstream);
  assert.equal(reads, 1);
  now += 2;
  assert.equal((await pricing.pricingFor(upstream)).models.get("gpt").model_ratio, 2);
  assert.equal(reads, 2, "过了一小时再读");
  await assert.rejects(pricing.pricingFor({ ...upstream, type: "sub2api" }), (error) => error.code === "UPSTREAM_PRICE_UNSUPPORTED");
  await assert.rejects(pricing.pricingFor({ ...upstream, isOwn: true }), (error) => error.code === "UPSTREAM_PRICE_UNSUPPORTED");
});

test("读不到：10 分钟内不再读，抛带码的错（403 → MODEL_PRICE_UNREADABLE，网络错也归成它）；之前读到过的照旧给旧表", async () => {
  let now = 0, fail = true, reads = 0;
  const pricing = createUpstreamPricing({}, { now: () => now, read: async () => { reads += 1; if (fail) throw Object.assign(new Error("403"), { code: "MODEL_PRICE_UNREADABLE" }); return body; } });
  await assert.rejects(pricing.pricingFor(upstream), (error) => error.code === "MODEL_PRICE_UNREADABLE");
  await assert.rejects(pricing.pricingFor(upstream), (error) => error.code === "MODEL_PRICE_UNREADABLE");
  assert.equal(reads, 1, "10 分钟内不再读");
  now += PRICING_RETRY_MS + 1; fail = false;
  assert.equal((await pricing.pricingFor(upstream)).models.size, 1);
  now += PRICING_TTL_MS + 1; fail = true;
  assert.equal((await pricing.pricingFor(upstream)).models.size, 1, "读失败但有旧表：给旧表");
  const network = createUpstreamPricing({}, { now: () => 0, read: async () => { throw Object.assign(new Error("timeout"), { code: "UPSTREAM_REQUEST_FAILED" }); } });
  await assert.rejects(network.pricingFor(upstream), (error) => error.code === "MODEL_PRICE_UNREADABLE");
});
