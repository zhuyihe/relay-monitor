import { defineOwnLogStoreContract } from "./test-support/own-log-store-contract.js";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";

defineOwnLogStoreContract({ name: "memory", create: () => new MemoryOwnLogStore() });
