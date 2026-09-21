import test from "node:test";
import assert from "node:assert/strict";
import { createReconciliationModule, resolveReconciliationWindow } from "./reconciliation.js";
import { ReconciliationRepository } from "./reconciliation-repository.js";

test("同一个上游 Key 不能同时建立两条启用对账规则", async () => {
  const calls = [];
  const repository = new ReconciliationRepository({
    async query(sql, params) {
      calls.push({ sql, params });
      return [[{ id: "rr_existing", token_name: "oai", fixed_group: "oai" }]];
    },
  });

  assert.deepEqual(
    await repository.findTokenConflict("upstream-1", 42),
    { ruleId: "rr_existing", tokenName: "oai", fixedGroup: "oai" }
  );
  assert.deepEqual(calls[0].params, ["upstream-1", 42]);
  assert.match(calls[0].sql, /enabled = 1/);
  assert.match(calls[0].sql, /archived_at IS NULL/);
});

test("对账窗口按规则时区切今天零点，结束点保留当前时刻", () => {
  const now = Date.parse("2026-09-20T04:26:08.000Z"); // 上海 12:26:08
  const window = resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, now);
  assert.equal(window.startMs, Date.parse("2026-09-19T16:00:00.000Z"));
  assert.equal(window.endMs, now);
  assert.equal(window.timezone, "Asia/Shanghai");
});

test("自定义对账窗口使用半开区间并拒绝超过 31 天", () => {
  const startMs = Date.parse("2026-09-01T00:00:00.000Z");
  const endMs = Date.parse("2026-09-02T00:00:00.000Z");
  assert.deepEqual(
    resolveReconciliationWindow({ preset: "custom", timezone: "Asia/Shanghai", startMs, endMs }),
    { preset: "custom", timezone: "Asia/Shanghai", startMs, endMs }
  );
  assert.throws(
    () => resolveReconciliationWindow(
      { preset: "custom", startMs, endMs: startMs + 32 * 86400000 },
      startMs + 33 * 86400000
    ),
    /31 天/
  );
  assert.throws(
    () => resolveReconciliationWindow({ preset: "custom", startMs, endMs: endMs + 1 }, endMs),
    /不能超过当前时间/
  );
});

test("空渠道不会生成批量渠道插入", async () => {
  const queries = [];
  const connection = {
    async beginTransaction() {},
    async query(sql, params) {
      queries.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const repository = new ReconciliationRepository({
    async getConnection() { return connection; },
    async query() { return [[]]; },
  });
  const input = {
    upstreamStationId: "upstream-1", ownStationId: "own-1", tokenId: 42,
    tokenName: "oai", fixedGroup: "oai", timezone: "Asia/Shanghai", channels: [],
  };

  await repository.createRule(input);
  await repository.updateRule("rr-existing", input);

  assert.equal(queries.filter(({ sql }) => sql.includes("reconciliation_rule_channels") && sql.includes("INSERT")).length, 0);
});

test("归档规则会清理对应的上游日志缓存", async () => {
  const connection = {
    async beginTransaction() {},
    async query() { return [{ affectedRows: 1 }]; },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const rt = {
    pool: { async getConnection() { return connection; } },
    store: { list() { return []; }, get() { return null; } },
    _reconciliationTokenLogCaches: new Map([
      ["rr-archived:2026-09-20", { dayStartMs: Date.now(), facts: new Map() }],
      ["rr-remaining:2026-09-20", { dayStartMs: Date.now(), facts: new Map() }],
    ]),
  };

  await createReconciliationModule(rt).archiveRule("rr-archived");

  assert.equal(rt._reconciliationTokenLogCaches.has("rr-archived:2026-09-20"), false);
  assert.equal(rt._reconciliationTokenLogCaches.has("rr-remaining:2026-09-20"), true);
});
