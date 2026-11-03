import { defineUpstreamSpendStoreContract } from "./test-support/upstream-spend-store-contract.js";
import { MemoryUpstreamSpendStore } from "./test-support/upstream-spend-memory-store.js";

defineUpstreamSpendStoreContract({ name: "memory", create: () => new MemoryUpstreamSpendStore() });
