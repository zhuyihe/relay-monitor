// 契约用例跑在内存实现上；MySQL 版在 db/schema.integration.test.js 里跑同一组用例。
import { defineReconciliationRepositoryContract } from "./test-support/reconciliation-repository-contract.js";
import { MemoryReconciliationRepository } from "./test-support/reconciliation-memory-repository.js";

defineReconciliationRepositoryContract({
  name: "memory",
  create: () => new MemoryReconciliationRepository(),
  failRequestWrites: ({ repository }) => {
    repository.hooks.beforeRequestWrite = () => { throw new Error("request write failed"); };
    return () => { delete repository.hooks.beforeRequestWrite; };
  },
  backdateRule: ({ repository, ruleId, createdAtMs }) => {
    repository.tables.rules.find((row) => row.id === ruleId).created_at = new Date(createdAtMs);
  },
  inspectSnapshot: ({ repository, ruleId, snapshotKey }) => {
    const row = repository.tables.snapshots.find((item) => item.rule_id === ruleId && item.snapshot_key === snapshotKey);
    return row ? { segmentId: row.segment_id, windowKind: row.window_kind, windowStartMs: Number(row.window_start_ms), windowEndMs: Number(row.window_end_ms),
      upstreamUsd: row.upstream_usd, healthCode: row.health_code, healthDetail: row.health_detail } : null;
  },
});
