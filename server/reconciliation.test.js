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

test("默认今天对账窗口按规则时区切零点，结束点比当前时刻晚一小时", () => {
  const now = Date.parse("2026-09-20T04:26:08.000Z"); // 上海 12:26:08
  const window = resolveReconciliationWindow({ timezone: "Asia/Shanghai" }, now);
  assert.equal(window.startMs, Date.parse("2026-09-19T16:00:00.000Z"));
  assert.equal(window.endMs, now + 60 * 60 * 1000);
  assert.equal(window.timezone, "Asia/Shanghai");
});

test("昨天和近 7 天对账窗口保留原有结束时间语义", () => {
  const now = Date.parse("2026-09-20T04:26:08.000Z"); // 上海 12:26:08
  const dayStart = Date.parse("2026-09-19T16:00:00.000Z");
  assert.deepEqual(
    resolveReconciliationWindow({ preset: "yesterday", timezone: "Asia/Shanghai" }, now),
    { preset: "yesterday", timezone: "Asia/Shanghai", startMs: dayStart - 86400000, endMs: dayStart }
  );
  assert.deepEqual(
    resolveReconciliationWindow({ preset: "7d", timezone: "Asia/Shanghai" }, now),
    { preset: "7d", timezone: "Asia/Shanghai", startMs: dayStart - 6 * 86400000, endMs: now }
  );
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

test("归档规则会清理对应的对账结果缓存", async () => {
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
    _reconciliationResultCache: new Map([
      ["rr-archived:today:1:2:Asia/Shanghai", { at: Date.now(), value: {} }],
      ["rr-remaining:today:1:2:Asia/Shanghai", { at: Date.now(), value: {} }],
    ]),
  };

  await createReconciliationModule(rt).archiveRule("rr-archived");

  assert.equal(rt._reconciliationResultCache.has("rr-archived:today:1:2:Asia/Shanghai"), false);
  assert.equal(rt._reconciliationResultCache.has("rr-remaining:today:1:2:Asia/Shanghai"), true);
});

test("统计接口不会绕过已变更的固定 Key 元数据", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const body = url.pathname === "/api/status"
      ? { success: true, data: { quota_per_unit: 100 } }
      : url.pathname === "/api/user/self"
        ? { success: true, data: { id: 42 } }
      : url.pathname === "/api/user/self/groups"
        ? { success: true, data: { fixed: { ratio: 1 } } }
        : url.pathname === "/api/token/"
          ? { success: true, data: { total: 1, items: [{ id: 9, name: "renamed-key", status: 1, group: "fixed", cross_group_retry: false }] } }
          : null;
    assert.notEqual(url.pathname, "/api/log/self/stat", "changed Key must be rejected before stat aggregation");
    response.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body || { success: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const rule = {
    id: "rr_test", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "original-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1,
    archived_at: null, created_at: null, updated_at: null,
  };
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: "rr_test", channel_id: 1, channel_name: "渠道" }]];
      return [[]];
    },
  };
  const stations = [
    { id: "upstream", type: "newapi", baseUrl, accessToken: "pat" },
    { id: "own", type: "newapi", isOwn: true },
  ];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  const { results } = await module.queryRules({
    ruleIds: ["rr_test"], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000,
  }, { force: true });
  const result = results[0];
  assert.equal(result.health.code, "KEY_INVALID_OR_DENIED");
  assert.match(result.health.detail, /名称已变化/);
});
