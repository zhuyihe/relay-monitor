// 账单能力的持久化身份版本。provider 只持有进程内 SHA 摘要，库里只保存域分隔的 HMAC。
// legacy 可能是旧 SHA，也可能是 S3 的 HMAC，无法从 64 位十六进制猜出格式：升级时统一包一层。
import { createHmac } from "node:crypto";

export const BILLING_CAPABILITY_IDENTITY_SCHEME = "wrapped-v2";
export const LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME = "legacy";
const DOMAIN = "billing-capability-storage-v2:";
const DIGEST = /^[a-f0-9]{64}$/i;

function normalizedDigest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error("账单能力身份摘要格式无效");
  return value.toLowerCase();
}

function checkedKey(key) {
  if (typeof key !== "string" || !key) throw new Error("账单身份密钥未就绪");
  return key;
}

export function wrappedBillingIdentity(key, digest) {
  return createHmac("sha256", checkedKey(key)).update(DOMAIN + normalizedDigest(digest)).digest("hex");
}

// 一个连接身份在库里可能的两种存法：新写的 W(D)，和 S3 存的 HMAC(key, D) 迁移后包成的 W(HMAC)。S3 的算法只在这里还认
export function billingCapabilityAliases(key, digest) {
  const normalized = normalizedDigest(digest);
  const oldHmac = createHmac("sha256", checkedKey(key)).update(normalized).digest("hex");
  return [wrappedBillingIdentity(key, normalized), wrappedBillingIdentity(key, oldHmac)];
}

// 升级时把库里一行旧格式（legacy）的身份包成 wrapped-v2（db/pool.js 的 rehashBillingCapabilities）。
// 旧格式是 S3 之前的裸 sha256 或 S3 的 HMAC，都是 64 位十六进制；格式不对的行返回 null，迁移时跳过，不挡启动
export function wrapLegacyBillingIdentity(key, identity) {
  return typeof identity === "string" && DIGEST.test(identity) ? wrappedBillingIdentity(key, identity) : null;
}

// get 只读两种历史来源的包装身份，不在页面查询时迁移；新写只写 W(D)。
// 不暴露 identityKey，确保 provider 不会把存储算法混进进程内身份、核验退避或作废集合。
export function createBillingCapabilityStorage(repository, { key, onChange = () => {} }) {
  const keyOf = () => typeof key === "function" ? key() : key;
  return {
    async get(digest) {
      const candidates = await Promise.all(billingCapabilityAliases(keyOf(), digest)
        .map((identity) => repository.getBillingCapability(identity, BILLING_CAPABILITY_IDENTITY_SCHEME)));
      return candidates.filter(Boolean).sort((a, b) => Number(b.verifiedAt) - Number(a.verifiedAt))[0] || null;
    },
    async set(digest, capability) {
      try { await repository.saveBillingCapability(wrappedBillingIdentity(keyOf(), digest), capability, BILLING_CAPABILITY_IDENTITY_SCHEME); }
      finally { onChange(); }
    },
    async delete(digest) {
      // 一条 SQL 原子删除两别名，不能删掉新行后又从旧 S3 别名读回已作废的能力。
      try { await repository.deleteBillingCapability(billingCapabilityAliases(keyOf(), digest), BILLING_CAPABILITY_IDENTITY_SCHEME); }
      finally { onChange(); }
    },
  };
}
