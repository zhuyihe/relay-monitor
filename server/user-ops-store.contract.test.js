import { defineUserOpsStoreContract } from "./test-support/user-ops-store-contract.js";
import { MemoryUserOpsStore } from "./test-support/user-ops-memory-store.js";

defineUserOpsStoreContract({ name: "memory", create: () => new MemoryUserOpsStore() });
