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

test("停止对账规则原子释放 Key 和渠道声明，并返回释放摘要", async () => {
  let active = true;
  let channelsReleased = false;
  const calls = [];
  const rule = {
    id: "rr_release", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "release-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1,
    archived_at: null, created_at: null, updated_at: null,
  };
  const pool = {
    async query(sql, params) {
      if (sql.startsWith("SELECT * FROM reconciliation_rules")) return [active && params[0] === "rr_release" ? [rule] : []];
      if (sql.startsWith("SELECT rule_id, channel_id")) return [[
        { rule_id: "rr_release", channel_id: 1, channel_name: "渠道一" },
        { rule_id: "rr_release", channel_id: 2, channel_name: "渠道二" },
      ]];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); },
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.startsWith("UPDATE reconciliation_rules")) {
            const affectedRows = active ? 1 : 0;
            active = false;
            return [{ affectedRows }];
          }
          if (sql.startsWith("UPDATE reconciliation_rule_channels")) {
            channelsReleased = true;
            return [{ affectedRows: 2 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
        async commit() { calls.push("commit"); },
        async rollback() { calls.push("rollback"); },
        release() { calls.push("release"); },
      };
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null } });

  assert.deepEqual(await module.archiveRule("rr_release"), {
    ruleId: "rr_release", tokenName: "release-key", fixedGroup: "fixed", releasedChannelCount: 2,
  });
  assert.equal(channelsReleased, true);
  assert.match(calls.find((call) => call.sql?.startsWith("UPDATE reconciliation_rules")).sql, /active_token_key = NULL/);
  assert.match(calls.find((call) => call.sql?.startsWith("UPDATE reconciliation_rule_channels")).sql, /active_channel_key = NULL/);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["begin", "commit", "release"]);
  await assert.rejects(() => module.archiveRule("rr_missing"), /不存在或已停止/);
  await assert.rejects(() => module.archiveRule("rr_release"), /不存在或已停止/);
});

test("停止对账规则遇到并发归档时不释放渠道且返回错误", async () => {
  const calls = [];
  const rule = {
    id: "rr_race", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "race-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1,
    archived_at: null, created_at: null, updated_at: null,
  };
  const pool = {
    async query(sql) {
      if (sql.startsWith("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.startsWith("SELECT rule_id, channel_id")) return [[{ rule_id: "rr_race", channel_id: 1, channel_name: "渠道" }]];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); },
        async query(sql) {
          calls.push(sql);
          if (sql.startsWith("UPDATE reconciliation_rules")) return [{ affectedRows: 0 }];
          if (sql.startsWith("UPDATE reconciliation_rule_channels")) throw new Error("channel release must not run");
          throw new Error(`unexpected transaction query: ${sql}`);
        },
        async commit() { calls.push("commit"); },
        async rollback() { calls.push("rollback"); },
        release() { calls.push("release"); },
      };
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null } });

  await assert.rejects(() => module.archiveRule("rr_race"), /不存在或已停止/);
  assert.equal(calls.some((call) => typeof call === "string" && call.startsWith("UPDATE reconciliation_rule_channels")), false);
  assert.deepEqual(calls.filter((call) => ["begin", "commit", "release"].includes(call)), ["begin", "commit", "release"]);
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

test("DST 切换日按时区日历零点计算昨天与近 7 天", () => {
  const timezone = "America/New_York";
  const springNow = Date.parse("2026-03-08T16:00:00.000Z"); // DST start day, 12:00 EDT
  const springYesterday = resolveReconciliationWindow({ preset: "yesterday", timezone }, springNow);
  assert.equal(springYesterday.startMs, Date.parse("2026-03-07T05:00:00.000Z"));
  assert.equal(springYesterday.endMs, Date.parse("2026-03-08T05:00:00.000Z"));
  assert.equal(resolveReconciliationWindow({ preset: "7d", timezone }, springNow).startMs, Date.parse("2026-03-02T05:00:00.000Z"));

  const fallNow = Date.parse("2026-11-01T17:00:00.000Z"); // DST end day, 12:00 EST
  const fallYesterday = resolveReconciliationWindow({ preset: "yesterday", timezone }, fallNow);
  assert.equal(fallYesterday.startMs, Date.parse("2026-10-31T04:00:00.000Z"));
  assert.equal(fallYesterday.endMs, Date.parse("2026-11-01T04:00:00.000Z"));
  assert.equal(resolveReconciliationWindow({ preset: "7d", timezone }, fallNow).startMs, Date.parse("2026-10-26T04:00:00.000Z"));
});

test("编辑规则不能替换上游账号或 Key，且拒绝发生在元数据读取之前", async () => {
  const rule = {
    id: "rr_identity", upstream_station_id: "upstream-a", own_station_id: "own", token_id: 9,
    token_name: "fixed-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1, archived_at: null,
  };
  let queries = 0;
  const pool = {
    async query(sql) {
      queries += 1;
      if (sql.startsWith("SELECT * FROM reconciliation_rules WHERE id")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      throw new Error(`metadata or update query must not run: ${sql}`);
    },
  };
  const module = createReconciliationModule({
    pool,
    store: {
      list: () => [{ id: "upstream-a", type: "newapi" }, { id: "own", type: "newapi", isOwn: true }],
      get: (id) => ({ id, type: "newapi" }),
    },
  });
  const input = { upstreamStationId: "upstream-a", tokenId: 10, salesChannelIds: [1], timezone: "Asia/Shanghai" };
  await assert.rejects(
    () => module.updateRule(rule.id, input),
    (error) => error.code === "RULE_IDENTITY_IMMUTABLE" && /新建规则/.test(error.message)
  );
  assert.equal(queries, 2);
});

test("编辑渠道或时区保留 Key 展示与分组，且不读取上游 Key 元数据", async (t) => {
  const { createServer } = await import("node:http");
  const paths = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    paths.push(path);
    const body = path === "/api/channel/"
      ? { success: true, data: { items: [{ id: 2, name: "渠道二", status: 1 }] } }
      : { success: false, message: "upstream metadata must not be read" };
    response.writeHead(body.success ? 200 : 500, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const row = {
    id: "rr_mutable", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "stable-key", fixed_group: "old-group", timezone: "Asia/Shanghai", enabled: 1, archived_at: null,
  };
  const pool = {
    async query(sql) {
      if (sql.startsWith("SELECT * FROM reconciliation_rules WHERE id")) return [[row]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("JOIN reconciliation_rule_channels")) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.startsWith("UPDATE reconciliation_rules")) {
            row.token_name = params[3];
            row.fixed_group = params[4];
            row.timezone = params[5];
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("DELETE FROM reconciliation_rule_channels") || sql.startsWith("INSERT INTO reconciliation_rule_channels")) return [{ affectedRows: 1 }];
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "upstream-pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  const updated = await module.updateRule(row.id, { upstreamStationId: "upstream", tokenId: 9, salesChannelIds: [2], timezone: "America/New_York" });

  assert.deepEqual(paths, ["/api/channel/"]);
  assert.equal(updated.tokenName, "stable-key");
  assert.equal(updated.fixedGroup, "old-group");
  assert.equal(updated.timezone, "America/New_York");
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
    pool: {
      async getConnection() { return connection; },
      async query(sql) {
        if (sql.includes("SELECT * FROM reconciliation_rules")) return [[{
          id: "rr-archived", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
          token_name: "archived-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1,
          archived_at: null, created_at: null, updated_at: null,
        }]];
        if (sql.includes("FROM reconciliation_rule_channels")) return [[{
          rule_id: "rr-archived", channel_id: 1, channel_name: "渠道",
        }]];
        throw new Error(`unexpected query: ${sql}`);
      },
    },
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

test("短于一秒的分段标记为不可核算，且不调用上游 stat 或本站收费接口", async (t) => {
  const { createServer } = await import("node:http");
  const aggregateCalls = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (["/api/log/self/stat", "/api/data/flow", "/api/data/"].includes(url.pathname)) aggregateCalls.push(url.pathname);
    const body = url.pathname === "/api/status" ? { success: true, data: { quota_per_unit: 100 } }
      : url.pathname === "/api/user/self" ? { success: true, data: { id: 1 } }
        : url.pathname === "/api/user/self/groups" ? { success: true, data: { fixed: { ratio: 1 } } }
          : url.pathname === "/api/token/" ? { success: true, data: { total: 1, items: [{ id: 9, name: "fixed-key", status: 1, group: "fixed", cross_group_retry: false }] } }
            : url.pathname === "/api/channel/" ? { success: true, data: { items: [{ id: 1, name: "渠道", status: 1 }] } }
              : { success: false };
    response.writeHead(body.success === false ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const rule = { id: "rr_short", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "fixed-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segment = { id: "s1", rule_id: rule.id, group_name: "fixed", group_ratio: 1, ratio_observed_at_ms: 1, ratio_source: "group_catalog", effective_from_ms: 0, effective_to_ms: null, detected_at_ms: 0, timing_source: "operator_confirmed" };
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道", channel_status: null }]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [[segment]];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql) {
          if (sql.includes("FOR UPDATE")) return [[segment]];
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1500, endMs: 1999 }, { force: true });

  assert.deepEqual(aggregateCalls, []);
  assert.equal(results[0].health.code, "UPSTREAM_DATA_UNAVAILABLE");
  assert.equal(results[0].upstream, null);
  assert.equal(results[0].downstream.amountUsd, null);
});

test("同名上游 Key 无法唯一归属时 fail closed，不能请求 stat 或计算利润", async (t) => {
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
            ? { success: true, data: { total: 2, items: [
              { id: 9, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
              { id: 10, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
            ] } }
            : null;
    assert.notEqual(url.pathname, "/api/log/self/stat", "ambiguous names must not be reconciled");
    response.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body || { success: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const rule = {
    id: "rr_duplicate", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "duplicate-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1, archived_at: null,
  };
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [[{
        id: "s1", rule_id: rule.id, group_name: "fixed", group_ratio: 1, effective_from_ms: 1000,
        effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed",
      }]];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 2000 }, { force: true });
  assert.equal(results[0].health.code, "KEY_INVALID_OR_DENIED");
  assert.match(results[0].health.detail, /名称不唯一/);
  assert.equal(results[0].calculation.differenceUsd, null);
});

test("创建规则遇到同名上游 Key 时 fail closed", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    const body = path === "/api/status" ? { success: true, data: { quota_per_unit: 100 } }
      : path === "/api/user/self" ? { success: true, data: { id: 1 } }
        : path === "/api/user/self/groups" ? { success: true, data: { fixed: { ratio: 1 } } }
          : path === "/api/token/" ? { success: true, data: { total: 2, items: [
            { id: 9, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
            { id: 10, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
          ] } }
            : path === "/api/channel/" ? { success: true, data: { items: [{ id: 1, name: "渠道", status: 1 }] } }
              : { success: false };
    response.writeHead(body.success === false ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const pool = {
    async query(sql) {
      return [[]];
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  const input = { upstreamStationId: "upstream", tokenId: 9, salesChannelIds: [1], timezone: "Asia/Shanghai" };
  await assert.rejects(() => module.createRule(input), (err) => err.code === "TOKEN_NAME_AMBIGUOUS");
});

test("跨分段窗口分别核算并以合计金额重算毛利率，同时保留渠道禁用状态", async (t) => {
  const { createServer } = await import("node:http");
  const statRequests = [];
  let upstreamBroken = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const start = Number(url.searchParams.get("start_timestamp"));
    let body;
    if (url.pathname === "/api/status") body = { success: true, data: { quota_per_unit: 100 } };
    else if (url.pathname === "/api/user/self") body = { success: true, data: { id: 7 } };
    else if (url.pathname === "/api/user/self/groups") body = { success: true, data: { g1: { ratio: 2.9 }, g2: { ratio: 2.6 } } };
    else if (url.pathname === "/api/token/") body = { success: true, data: { total: 1, items: [{ id: 9, name: "stable", status: 1, group: "g2", cross_group_retry: false }] } };
    else if (url.pathname === "/api/log/self/stat") {
      statRequests.push({ tokenName: url.searchParams.get("token_name"), group: url.searchParams.get("group"), start, end: Number(url.searchParams.get("end_timestamp")) });
      body = upstreamBroken ? { success: false, message: "stat unavailable" } : { success: true, data: { quota: start === 1000 ? 0 : 100 } };
    }
    else if (url.pathname === "/api/data/flow") body = { success: true, data: [{ channel_id: 1, channel_name: "渠道", quota: start === 1000 ? 200 : 100 }] };
    else if (url.pathname === "/api/data/") body = { success: true, data: [{ quota: start === 1000 ? 200 : 100 }] };
    else if (url.pathname === "/api/channel/") body = { success: true, data: { items: [{ id: 1, name: "渠道", status: 2 }] } };
    else body = { success: false };
    response.writeHead(body.success === false ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const rule = { id: "rr_segments", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [
    { id: "s1", rule_id: rule.id, group_name: "g1", group_ratio: 2.9, ratio_observed_at_ms: 1000001, ratio_source: "group_catalog", effective_from_ms: 1000000, effective_to_ms: 1030000, detected_at_ms: 1030000, timing_source: "operator_confirmed" },
    { id: "s2", rule_id: rule.id, group_name: "g2", group_ratio: 2.6, ratio_observed_at_ms: 1030001, ratio_source: "group_catalog", effective_from_ms: 1030000, effective_to_ms: null, detected_at_ms: 1030000, timing_source: "detected" },
  ];
  const snapshotSources = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道", channel_status: null }]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      if (sql.includes("FROM reconciliation_snapshots")) {
        return [snapshotSources.map((source) => ({ source: JSON.stringify(source) }))];
      }
      if (sql.includes("INSERT INTO reconciliation_snapshots")) {
        snapshotSources.push(JSON.parse(params.at(-1)));
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[segments.find((segment) => segment.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) { segments[0].group_ratio = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { segments[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
            segments.push({ id: params[0], rule_id: rule.id, group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), channels: [] } });
  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  const result = results[0];
  assert.equal(result.segments.length, 2);
  assert.equal(result.upstream.amountUsd, 1);
  assert.equal(result.downstream.amountUsd, 3);
  assert.equal(result.calculation.differenceUsd, 2);
  assert.equal(result.calculation.profitUsd, null, "an upstream-empty sales anomaly is a risk difference, never confirmed profit");
  assert.equal(result.calculation.riskDifferenceUsd, 2);
  assert.equal(result.calculation.marginRate, null, "an upstream-empty sales anomaly must invalidate the aggregate margin");
  assert.equal(result.downstream.channels[0].state, "manual_disabled");
  assert.equal(result.health.code, "UPSTREAM_EMPTY_WITH_SALES", "billing anomalies must outrank transition-timing notices");
  assert.ok(result.health.issues.some((issue) => issue.code === "UPSTREAM_EMPTY_WITH_SALES"));
  assert.deepEqual(statRequests, [
    { tokenName: "stable", group: null, start: 1000, end: 1029 },
    { tokenName: "stable", group: null, start: 1030, end: 1059 },
  ], "each half-open segment must query its own token-only window exactly once");
  assert.ok(result.health.issues.some((issue) => issue.code === "SALES_CHANNEL_DISABLED"));
  assert.ok(result.health.issues.some((issue) => issue.code === "SEGMENT_TIMING_UNCONFIRMED"));
  assert.deepEqual(snapshotSources[0].segment, {
    group: "g1", ratio: 2.9, ratioObservedAt: 1000001, ratioSource: "group_catalog", timingSource: "operator_confirmed",
  });
  upstreamBroken = true;
  const afterAnomaly = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(afterAnomaly.results[0].lastSuccessfulAt, undefined, "上游空消费异常不能作为后续失败的最近成功账单");
  assert.equal(afterAnomaly.results[0].health.stale, false);
  upstreamBroken = false;
  const second = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.ok(second.results[0].health.issues.some((issue) => issue.code === "SEGMENT_TIMING_UNCONFIRMED"), "unconfirmed timing must persist until an operator confirms it");
  const realNow = Date.now;
  let now = Date.parse("2026-09-20T04:26:08.000Z");
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const todayA = await module.queryRules({ ruleIds: [rule.id], preset: "today" }, { force: true });
  const todayAmount = todayA.results[0].upstream.amountUsd;
  const todaySuccessAt = todayA.results[0].lastSuccessfulAt;
  upstreamBroken = true;
  const restarted = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), channels: [] } });
  const restartedResult = await restarted.queryRules({
    ruleIds: [rule.id], preset: "today",
  }, { force: true });
  assert.equal(restartedResult.results[0].lastSuccessfulAt, todaySuccessAt, "a restarted process must preserve the persisted success time when partial collection fails");
  assert.equal(restartedResult.results[0].window.endMs, todayA.results[0].window.endMs, "a restarted process must retain the persisted data coverage window");
  assert.ok(restartedResult.results[0].requestedWindow.endMs >= restartedResult.results[0].window.endMs);
  now += 30000;
  const todayB = await module.queryRules({ ruleIds: [rule.id], preset: "today" }, { force: true });
  assert.equal(todayB.results[0].health.stale, true, "same-day today failures use the earlier successful result");
  assert.equal(todayB.results[0].upstream.amountUsd, todayAmount);
  assert.equal(todayB.results[0].lastSuccessfulAt, todaySuccessAt);
  assert.equal(todayB.results[0].window.endMs, todayA.results[0].window.endMs, "stale amounts retain their actual successful data window");
  assert.equal(todayB.results[0].lastSuccessfulWindow.endMs, todayA.results[0].window.endMs);
  assert.ok(todayB.results[0].requestedWindow.endMs > todayB.results[0].window.endMs, "the requested refresh window remains visible separately");
  now += 86400000;
  const nextDayToday = await module.queryRules({ ruleIds: [rule.id], preset: "today" }, { force: true });
  assert.equal(nextDayToday.results[0].upstream, null, "a different local day must not reuse yesterday's today result");
  assert.equal(nextDayToday.results[0].health.stale, false);
  const otherWindow = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1060000, endMs: 1120000 }, { force: true });
  assert.equal(otherWindow.results[0].upstream, null, "a failed second window must not reuse the first window's cost");
  assert.equal(otherWindow.results[0].lastSuccessfulAt, undefined);
  assert.equal(otherWindow.results[0].health.stale, false);
  const stale = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(stale.results[0].health.stale, false, "异常账单不能作为后续失败的陈旧成功账单");
  assert.equal(stale.results[0].lastSuccessfulAt, undefined);
});

test("检测到 group 或 ratio 变化时关闭旧分段、保留历史并只打开一个新分段", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: 2.9, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }];
  const calls = [];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FOR UPDATE")) return [[rows.find((row) => row.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { rows[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) { rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" }); return [{ affectedRows: 1 }]; }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  const segments = await repository.transitionSegment("rr", { group: "g2", ratio: 2.6, detectedAt: 2000 });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].effectiveTo, 2000);
  assert.equal(segments[1].group, "g2");
  assert.equal(segments[1].ratio, 2.6);
  assert.equal(segments.filter((segment) => segment.effectiveTo == null).length, 1);
  assert.equal(calls.filter((call) => call.sql.startsWith("INSERT INTO reconciliation_rule_segments")).length, 1);
});

test("首次观察到已知倍率会补全当前 legacy 分段，随后切组才可保留上一段倍率", async (t) => {
  const { createServer } = await import("node:http");
  let currentGroup = "AWS_Bedrock3";
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const body = url.pathname === "/api/status" ? { success: true, data: { quota_per_unit: 100 } }
      : url.pathname === "/api/user/self" ? { success: true, data: { id: 7 } }
        : url.pathname === "/api/user/self/groups" ? { success: true, data: { AWS_Bedrock3: { ratio: 2.9 }, AWS_Bedrock2: { ratio: 2.6 } } }
          : url.pathname === "/api/token/" ? { success: true, data: { total: 1, items: [{ id: 9, name: "stable", status: 1, group: currentGroup, cross_group_retry: false }] } }
            : url.pathname === "/api/log/self/stat" ? { success: true, data: { quota: 100 } }
              : url.pathname === "/api/data/flow" ? { success: true, data: [{ channel_id: 1, channel_name: "渠道", quota: 100 }] }
                : url.pathname === "/api/data/" ? { success: true, data: [{ quota: 100 }] }
                  : url.pathname === "/api/channel/" ? { success: true, data: { items: [{ id: 1, name: "渠道", status: 1 }] } }
                    : { success: false };
    response.writeHead(body.success === false ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const rule = { id: "rr_legacy_ratio", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "AWS_Bedrock3", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [{ id: "s_legacy", rule_id: rule.id, group_name: "AWS_Bedrock3", group_ratio: null, effective_from_ms: 0, effective_to_ms: null, detected_at_ms: 0, timing_source: "legacy" }];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道" }]];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[segments.find((segment) => segment.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) { segments[0].group_ratio = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { segments[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
            segments.push({ id: params[0], rule_id: rule.id, group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), channels: [] } });
  await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(segments[0].group_ratio, 2.9, "same-group first observation must backfill the current open segment ratio");
  assert.equal(segments.length, 1, "a normal single-group rule must not gain a segment while its ratio is first observed");
  currentGroup = "AWS_Bedrock2";
  await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].group_ratio, 2.9, "the closed predecessor keeps its observed ratio");
  assert.equal(segments[1].group_name, "AWS_Bedrock2");
  assert.equal(segments[1].group_ratio, 2.6);
});

test("已迁移的倍率未知分段在上游首次返回倍率时补全当前分段", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "legacy" }];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[rows[0]]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) { rows[0].group_ratio = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { rows[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) { rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" }); return [{ affectedRows: 1 }]; }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const segments = await new ReconciliationRepository(pool).transitionSegment("rr", { group: "g1", ratio: 2.9, detectedAt: 2000 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].effectiveFrom, 1000);
  assert.equal(segments[0].effectiveTo, null);
  assert.equal(segments[0].ratio, 2.9);
});

test("首次检测已切组时用仍存在的旧组目录倍率补全旧段，再开启新段", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "AWS-Bedrock3", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "legacy", ratio_observed_at_ms: null, ratio_source: null }];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[rows.find((row) => row.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) {
            rows[0].group_ratio = params[0]; rows[0].ratio_observed_at_ms = params[1]; rows[0].ratio_source = "group_catalog";
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { rows[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
            rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], ratio_observed_at_ms: params[4], ratio_source: params[5], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  const result = await repository.reconcileCurrentSegment("rr", { group: "AWS-Bedrock2", ratio: 3, currentSegmentRatio: 2.9, detectedAt: 2000 });
  assert.equal(result.transitioned, true);
  assert.equal(result.ratioBackfilled, true);
  assert.deepEqual(result.segments.map((segment) => [segment.group, segment.ratio]), [["AWS-Bedrock3", 2.9], ["AWS-Bedrock2", 3]]);
  assert.equal(result.segments[0].ratioSource, "group_catalog");
  const repeated = await repository.reconcileCurrentSegment("rr", { group: "AWS-Bedrock2", ratio: 3, currentSegmentRatio: 3, detectedAt: 3000 });
  assert.equal(repeated.transitioned, false);
  assert.equal(repeated.ratioBackfilled, false);
  assert.equal(repeated.segments.length, 2, "unchanged refreshes must not create extra segments");
});

test("旧组已不在本轮目录时切组不会伪造旧段倍率", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "AWS-Bedrock3", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "legacy" }];
  const pool = {
    async query(sql) { if (sql.includes("FROM reconciliation_rule_segments")) return [rows]; throw new Error(`unexpected query: ${sql}`); },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[rows[0]]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { rows[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) { rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" }); return [{ affectedRows: 1 }]; }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const result = await new ReconciliationRepository(pool).reconcileCurrentSegment("rr", { group: "AWS-Bedrock2", ratio: 3, currentSegmentRatio: null, detectedAt: 2000 });
  assert.equal(result.ratioBackfilled, false);
  assert.equal(result.segments[0].ratio, null);
  assert.equal(result.segments[1].ratio, 3);
});

test("切回原分组仍保留新的历史分段", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: 2.9, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[rows.find((row) => row.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            rows.find((row) => row.id === params[1]).effective_to_ms = params[0];
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
            rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  await repository.transitionSegment("rr", { group: "g2", ratio: 2.6, detectedAt: 2000 });
  const segments = await repository.transitionSegment("rr", { group: "g1", ratio: 2.9, detectedAt: 3000 });
  assert.deepEqual(segments.map((segment) => segment.group), ["g1", "g2", "g1"]);
  assert.deepEqual(segments.map((segment) => segment.effectiveTo), [2000, 3000, null]);
});

test("修正切换时间锁定相邻分段，并在同一事务中清除受影响快照", async () => {
  const rows = [
    { id: "s1", rule_id: "rr", effective_from_ms: 1000, effective_to_ms: 2000, created_at: "2026-01-01" },
    { id: "s2", rule_id: "rr", effective_from_ms: 2000, effective_to_ms: 3000, created_at: "2026-01-02" },
    { id: "s3", rule_id: "rr", effective_from_ms: 3000, effective_to_ms: null, created_at: "2026-01-03" },
  ];
  const calls = [];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); },
        async commit() { calls.push("commit"); },
        async rollback() { calls.push("rollback"); },
        release() { calls.push("release"); },
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FOR UPDATE")) return [rows];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            rows[0].effective_to_ms = params[1];
            rows[1].effective_from_ms = params[3];
            return [{ affectedRows: 2 }];
          }
          if (sql.startsWith("DELETE FROM reconciliation_snapshots")) return [{ affectedRows: 2 }];
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const segments = await new ReconciliationRepository(pool).correctTransition("rr", "s2", 2500);
  assert.equal(segments[0].effectiveTo, 2500);
  assert.equal(segments[1].effectiveFrom, 2500);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["begin", "commit", "release"]);
  assert.ok(calls.some((call) => call.sql?.includes("FOR UPDATE")));
  const invalidation = calls.find((call) => call.sql?.startsWith("DELETE FROM reconciliation_snapshots"));
  assert.deepEqual(invalidation.params, ["rr", "s1", "s2"]);
});

test("upstream unavailable retains persisted segment evidence in the response and snapshot", async () => {
  const rule = {
    id: "rr_unavailable", upstream_station_id: "missing-upstream", own_station_id: "own", token_id: 9,
    token_name: "stable", fixed_group: "g1", timezone: "Asia/Shanghai", enabled: 1, archived_at: null,
  };
  const snapshots = [];
  const snapshotRows = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [[{
        id: "s1", rule_id: rule.id, group_name: "g1", group_ratio: 2.9,
        ratio_observed_at_ms: 1234, ratio_source: "group_catalog", effective_from_ms: 1000,
        effective_to_ms: null, detected_at_ms: 1234, timing_source: "operator_confirmed",
      }]];
      if (sql.includes("FROM reconciliation_snapshots")) return [snapshotRows];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      if (sql.includes("INSERT INTO reconciliation_snapshots")) {
        snapshots.push({ segmentId: params[1], snapshotKey: params[2], source: JSON.parse(params.at(-1)) });
        snapshotRows.push({
          rule_id: params[0], segment_id: params[1], snapshot_key: params[2], window_kind: params[3],
          window_start_ms: params[4], window_end_ms: params[5], health_code: params[16], health_detail: params[17],
          source: params[18], generated_at: "2026-09-22T10:00:00.000Z",
        });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null, channels: [] } });
  const { results } = await module.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 2000,
  }, { force: true });

  assert.equal(results[0].health.code, "UPSTREAM_DATA_UNAVAILABLE");
  assert.equal(results[0].lastSuccessfulAt, undefined, "首次读取失败不能伪称有最近成功结果");
  assert.equal(results[0].currentSegment.group, "g1");
  assert.equal(results[0].currentSegment.ratio, 2.9);
  assert.equal(results[0].currentSegment.ratioObservedAt, 1234);
  assert.equal(results[0].currentSegment.ratioSource, "group_catalog");
  assert.deepEqual(results[0].transitionSegments.map((segment) => segment.id), ["s1"]);
  assert.equal(snapshots[0].segmentId, "s1");
  assert.match(snapshots[0].snapshotKey, /:s1$/);
  assert.deepEqual(snapshots[0].source.segment, {
    group: "g1", ratio: 2.9, ratioObservedAt: 1234, ratioSource: "group_catalog", timingSource: "operator_confirmed",
  });
  const restarted = createReconciliationModule({ pool, store: { list: () => [], get: () => null, channels: [] } });
  const second = await restarted.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 2000,
  }, { force: true });
  assert.equal(second.results[0].lastSuccessfulAt, undefined, "第一次失败快照不能被第二次失败恢复为最近成功");
  assert.equal(second.results[0].health.stale, false);
});

test("进程重启后只恢复同一完整窗口的持久化成功账单，失败不覆盖该快照", async () => {
  const rule = {
    id: "rr_persisted", upstream_station_id: "missing-upstream", own_station_id: "own", token_id: 9,
    token_name: "stable", fixed_group: "g1", timezone: "Asia/Shanghai", enabled: 1, archived_at: null,
  };
  const writes = [];
  const source = {
    window: { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" },
    resultGeneratedAt: "2026-09-22T10:00:00.000Z",
    segment: { group: "g1", ratio: 2.9, ratioObservedAt: 1234, ratioSource: "group_catalog", timingSource: "operator_confirmed" },
    downstream: { channels: [{ channelId: 1, quotaUnits: 500 }] },
    result: {
      currentSegment: { id: "s1", group: "g1", ratio: 2.9 }, transitionSegments: [], segments: [],
      upstream: { quotaUnits: 250, quotaPerUnit: 100, amountUsd: 2.5 },
      downstream: { quotaUnits: 500, quotaPerUnit: 100, amountUsd: 5, coverage: 1, channels: [] },
      calculation: { differenceUsd: 2.5, marginRate: 0.5 },
    },
  };
  const pool = {
    async query(sql, params) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [[{
        id: "s1", rule_id: rule.id, group_name: "g1", group_ratio: 2.9,
        ratio_observed_at_ms: 1234, ratio_source: "group_catalog", effective_from_ms: 1000,
        effective_to_ms: null, detected_at_ms: 1234, timing_source: "operator_confirmed",
      }]];
      if (sql.includes("FROM reconciliation_snapshots")) return [[{
        rule_id: rule.id, segment_id: "s1", snapshot_key: "custom:1000:2000:s1", window_kind: "custom",
        window_start_ms: 1000, window_end_ms: 2000, upstream_quota: 250, upstream_quota_per_unit: 100, upstream_usd: 2.5,
        downstream_quota: 500, downstream_quota_per_unit: 100, downstream_usd: 5, difference_usd: 2.5, margin_rate: 0.5,
        coverage: 1, health_code: "READY", health_detail: null, source: JSON.stringify(source), generated_at: "2026-09-22T10:00:00.000Z",
      }]];
      if (sql.includes("INSERT INTO reconciliation_snapshots")) { writes.push(params); return [{ affectedRows: 1 }]; }
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null, channels: [] } });
  const { results } = await module.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 2000,
  }, { force: true });

  assert.equal(results[0].upstream.amountUsd, 2.5);
  assert.equal(results[0].downstream.amountUsd, 5);
  assert.equal(results[0].lastSuccessfulAt, "2026-09-22T10:00:00.000Z");
  assert.equal(results[0].health.stale, true);
  assert.equal(results[0].calculation.profitUsd, 2.5, "旧成功快照的差额应恢复为确认利润");
  assert.equal(results[0].calculation.riskDifferenceUsd, null);
  assert.equal(results[0].calculation.marginRate, 0.5);
  assert.equal(writes.length, 0, "a failed refresh must not upsert over the most recent successful snapshot");
});

test("持久化 today 成功账单可用于同日较晚窗口，不能跨本地日期复用", async () => {
  const first = resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, Date.parse("2026-09-20T04:26:08.000Z"));
  const rows = [{
    health_code: "READY",
    source: JSON.stringify({ window: first, resultGeneratedAt: "2026-09-20T04:26:08.000Z", result: { upstream: { amountUsd: 2.5 }, calculation: { differenceUsd: 2.5, profitUsd: 2.5, riskDifferenceUsd: null, marginRate: 0.5 } } }),
  }];
  const repository = new ReconciliationRepository({
    async query() { return [rows]; },
  });
  const sameDay = { ...first, endMs: first.endMs + 30000 };
  assert.equal((await repository.latestSuccessfulResult("rr", sameDay))?.result.upstream.amountUsd, 2.5);
  const nextDay = resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, Date.parse("2026-09-21T04:26:08.000Z"));
  assert.equal(await repository.latestSuccessfulResult("rr", nextDay), null);
});

test("零利润的完整账单仍可作为最近成功结果恢复", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "READY", source: JSON.stringify({
        window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: 0, profitUsd: 0, riskDifferenceUsd: null, marginRate: 0 } },
      }) }]];
    },
  });
  const result = await repository.latestSuccessfulResult("rr", window);
  assert.equal(result?.result.calculation.profitUsd, 0);
  assert.equal(result?.result.calculation.marginRate, 0);
});

test("非确认的旧快照不会被兼容逻辑伪造成利润", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "UPSTREAM_EMPTY_WITH_SALES", source: JSON.stringify({
        window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: 2.5, marginRate: 0.5 } },
      }) }]];
    },
  });
  assert.equal(await repository.latestSuccessfulResult("rr", window), null);
});

test("仓储不会把失败或异常快照当作最近成功账单", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "UPSTREAM_DATA_UNAVAILABLE", source: JSON.stringify({
        window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null } },
      }) }]];
    },
  });
  assert.equal(await repository.latestSuccessfulResult("rr", window), null);
});

test("known catalogue ratios backfill closed legacy segments without changing boundaries", async () => {
  const rows = [
    { id: "old", rule_id: "rr", group_name: "AWS-Bedrock3", group_ratio: null, effective_from_ms: 1000, effective_to_ms: 2000, detected_at_ms: 2000, timing_source: "detected" },
    { id: "current", rule_id: "rr", group_name: "AWS-Bedrock2", group_ratio: 3, effective_from_ms: 2000, effective_to_ms: null, detected_at_ms: 2000, timing_source: "operator_confirmed" },
  ];
  const calls = [];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); }, async commit() { calls.push("commit"); }, async rollback() {}, release() { calls.push("release"); },
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FOR UPDATE")) return [rows];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) {
            const row = rows.find((item) => item.id === params[2]);
            row.group_ratio = params[0];
            row.ratio_observed_at_ms = params[1];
            row.ratio_source = "group_catalog";
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  assert.equal(await repository.backfillMissingSegmentRatios("rr", {
    "AWS-Bedrock3": { ratio: 2.9 }, "AWS-Bedrock2": { ratio: 3 }, Missing: { ratio: null },
  }, 3000), 1);
  assert.equal(rows[0].group_ratio, 2.9);
  assert.equal(rows[0].ratio_observed_at_ms, 3000);
  assert.equal(rows[0].ratio_source, "group_catalog");
  assert.deepEqual(rows.map((row) => [row.id, row.effective_from_ms, row.effective_to_ms]), [["old", 1000, 2000], ["current", 2000, null]]);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["begin", "commit", "release"]);
});
