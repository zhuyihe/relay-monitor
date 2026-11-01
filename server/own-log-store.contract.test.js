import { defineOwnLogStoreContract } from "./test-support/own-log-store-contract.js";
import { defineOwnErrorStoreContract } from "./test-support/own-error-store-contract.js";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";
import { ERROR_SPEC } from "./own-log-store.js";

defineOwnLogStoreContract({ name: "memory", create: () => new MemoryOwnLogStore() });
defineOwnErrorStoreContract({ name: "memory", create: () => new MemoryOwnLogStore(ERROR_SPEC), createConsume: () => new MemoryOwnLogStore() });
