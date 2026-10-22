import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { BILLING_CAPABILITY_IDENTITY_SCHEME, billingCapabilityAliases, createBillingCapabilityStorage, wrappedBillingIdentity } from "./billing-capability-storage.js";
import { MemoryReconciliationRepository } from "../server/test-support/reconciliation-memory-repository.js";
import { queryKeyReconciliationStat } from "./providers.js";

const KEY = "billing-storage-fixture-key";
const digestOf = (s) => createHash("sha256").update(s).digest("hex");
const capability = (verifiedAt) => ({ state: "supported", currency: "USD", window: "natural-day", verifiedAt, reason: "RUNTIME_FILTERS_VERIFIED" });

test("域分隔包装规范化十六进制，不泄露 SHA；账单身份密钥变化完全隔离", () => {
  const digest = digestOf("weak password fixture");
  const aliases = billingCapabilityAliases(KEY, digest);
  assert.equal(aliases[0], wrappedBillingIdentity(KEY, digest.toUpperCase()));
  assert.notEqual(aliases[0], digest);
  assert.notEqual(aliases[0], createHmac("sha256", KEY).update(digest).digest("hex"));
  assert.ok(aliases.every((id) => /^[a-f0-9]{64}$/.test(id)));
  assert.ok(billingCapabilityAliases("another-key", digest).every((id) => !aliases.includes(id)));
  assert.throws(() => wrappedBillingIdentity(null, digest), /密钥/);
  assert.throws(() => wrappedBillingIdentity(KEY, "not-a-digest"), /摘要/);
});

test("只读两种历史别名并取较新的核验结果，不迁移、不写库；新密钥不能借旧能力", async () => {
  const repository = new MemoryReconciliationRepository();
  const digest = digestOf("one-account"), [plain, oldHmac] = billingCapabilityAliases(KEY, digest);
  await repository.saveBillingCapability(plain, capability(1000));
  await repository.saveBillingCapability(oldHmac, capability(2000));
  repository.log.capabilityWrites.length = 0;
  const before = structuredClone(repository.tables.capabilities);
  const store = createBillingCapabilityStorage(repository, { key: KEY });
  assert.equal(store.identityKey, undefined, "provider 不应再生成持久化 HMAC 身份");
  assert.deepEqual(await store.get(digest), capability(2000));
  assert.equal(await createBillingCapabilityStorage(repository, { key: "new-key" }).get(digest), null);
  assert.deepEqual(repository.tables.capabilities, before);
  assert.deepEqual(repository.log.capabilityWrites, []);
});

test("新写仅 W(D)，撤销原子删掉 W(D) 和旧 S3 别名，旧能力不会复活", async () => {
  const repository = new MemoryReconciliationRepository();
  const digest = digestOf("delete-both-aliases"), [plain, oldHmac] = billingCapabilityAliases(KEY, digest);
  await repository.saveBillingCapability(oldHmac, capability(1000));
  let changes = 0;
  const store = createBillingCapabilityStorage(repository, { key: () => KEY, onChange: () => changes++ });
  await store.set(digest, capability(2000));
  assert.deepEqual(repository.tables.capabilities.map((r) => [r.identity, r.identity_scheme]).sort(),
    [[plain, BILLING_CAPABILITY_IDENTITY_SCHEME], [oldHmac, BILLING_CAPABILITY_IDENTITY_SCHEME]].sort());
  await store.delete(digest);
  assert.equal(repository.tables.capabilities.length, 0);
  assert.equal(await store.get(digest), null);
  assert.deepEqual(repository.log.capabilityWrites.at(-1).identity, [plain, oldHmac]);
  assert.equal(changes, 2);
});

for (const original of ["sha", "s3-hmac"]) {
  test(`由 ${original} 迁移的旧能力：零消费只读请求仍是完整零账单，零写入和零重新核验`, async (t) => {
    const now = Date.parse("2026-10-11T04:00:00Z");
    t.mock.method(Date, "now", () => now);
    const station = { type: "sub2api", baseUrl: `https://billing-storage-${original}.test`, accessToken: "raw-jwt" };
    const digest = digestOf(JSON.stringify([station.baseUrl, "7", "Asia/Shanghai", "token", "raw-jwt", null]));
    const repository = new MemoryReconciliationRepository();
    const alias = billingCapabilityAliases(KEY, digest)[original === "sha" ? 0 : 1];
    await repository.saveBillingCapability(alias, capability(now - 400 * 86400000));
    repository.log.capabilityWrites.length = 0;
    const before = structuredClone(repository.tables.capabilities);
    let controls = 0;
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/auth/me") return Response.json({ code: 0, data: { id: 7 } });
      if (url.pathname === "/api/v1/usage/stats") return Response.json({ code: 0, data: { total_actual_cost: 0 } });
      controls++;
      throw new Error(`unexpected verification ${url.pathname}`);
    });
    const token = { id: 9, name: "key", status: 1 };
    const stat = await queryKeyReconciliationStat(station, { token, metadata: { accountId: "7", tokens: [token] },
      startMs: Date.parse("2026-10-09T16:00:00Z"), endMs: Date.parse("2026-10-10T16:00:00Z"), timezone: "Asia/Shanghai",
      capabilityStore: createBillingCapabilityStorage(repository, { key: KEY }), readOnly: true });
    assert.deepEqual([stat.state, stat.complete, stat.amountUsd], ["complete", true, 0]);
    assert.equal(controls, 0);
    assert.deepEqual(repository.log.capabilityWrites, []);
    assert.deepEqual(repository.tables.capabilities, before);
  });
}
