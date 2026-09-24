import test from "node:test";
import assert from "node:assert/strict";
import { createReconciliationModule, mapWithConcurrency, reconciliationScopeFingerprint, resolveReconciliationWindow } from "./reconciliation.js";
import { ReconciliationRepository } from "./reconciliation-repository.js";
import { reconciliationSnapshotIdentity } from "../lib/reconciliation-snapshot.js";

test("快照读写共用同一逻辑窗口身份", () => {
  const scope = "same-scope";
  const sevenDay = { preset: "7d", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  assert.equal(reconciliationSnapshotIdentity(sevenDay, scope), "7d:1000:Asia/Shanghai:same-scope");
  assert.equal(reconciliationSnapshotIdentity({ ...sevenDay, endMs: 3000 }, scope), "7d:1000:Asia/Shanghai:same-scope");
  assert.equal(reconciliationSnapshotIdentity({ ...sevenDay, preset: "custom" }, scope), "custom:1000:2000:Asia/Shanghai:same-scope");
});

test("今天的较早慢查询不能复用或覆盖较晚查询的缓存", async () => {
  const rule = { id: "rr_today_cache", upstream_station_id: "missing", own_station_id: "own", token_id: 1, token_name: "key", fixed_group: "group", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segment = { id: "s1", rule_id: rule.id, group_name: "group", group_ratio: 1, effective_from_ms: 1, effective_to_ms: null, detected_at_ms: 1, timing_source: "operator_confirmed" };
  let releaseFirstLookup;
  let firstLookupReached;
  const firstLookup = new Promise((resolve) => { firstLookupReached = resolve; });
  let lookupCount = 0;
  const query = async (sql) => {
    if (sql.includes("FROM reconciliation_rules")) return [[rule]];
    if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [[segment]];
    if (sql.includes("FROM reconciliation_snapshots")) {
      if (++lookupCount === 1) {
        firstLookupReached();
        return new Promise((resolve) => { releaseFirstLookup = () => resolve([[]]); });
      }
      return [[]];
    }
    if (sql.includes("FROM reconciliation_alert_state")) return [[{ active: 1, first_seen_at: 1, last_seen_at: 1, last_notified_at: 1 }]];
    return [{ affectedRows: 1 }];
  };
  const pool = {
    query,
    async getConnection() {
      return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    },
  };
  const rt = { pool, store: { list: () => [], get: () => null, channels: [] } };
  const reconciliation = createReconciliationModule(rt);
  const input = { ruleIds: [rule.id], preset: "today", timezone: "Asia/Shanghai" };
  const older = reconciliation.queryRules(input, { force: true });
  await firstLookup;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const newer = reconciliation.queryRules(input, { force: true });
  let timeout;
  let newerResponse;
  try {
    newerResponse = await Promise.race([
      newer,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("较晚查询错误地等待了旧查询")), 1500); }),
    ]);
  } finally {
    clearTimeout(timeout);
    releaseFirstLookup();
  }
  const olderResponse = await older;
  const olderEnd = olderResponse.results[0].window.endMs;
  const newerEnd = newerResponse.results[0].window.endMs;
  assert.ok(newerEnd > olderEnd, "较晚的今天窗口必须独立查询，不能共用旧 in-flight 任务");
  assert.equal([...rt._reconciliationResultCache.values()][0].value.window.endMs, newerEnd,
    "较早完成的旧窗口不能覆盖较晚窗口的缓存");
});

test("成功快照查询不会因最新候选无效而漏掉较早有效账单", async () => {
  const window = { preset: "7d", startMs: 1000, endMs: 5000, timezone: "Asia/Shanghai" };
  const valid = {
    calculationVersion: 2, billingSource: "channel-log-stat", scopeFingerprint: "scope",
    window: { ...window, endMs: 4000 }, resultGeneratedAt: "2026-09-23T09:00:00.000Z",
    result: { calculation: { differenceUsd: 2, profitUsd: 2, riskDifferenceUsd: null, marginRate: 0.5 } },
  };
  const repository = new ReconciliationRepository({
    async query(sql) {
      assert.doesNotMatch(sql, /LIMIT 1(?!\d)/);
      return [[
        { health_code: "READY", source: "{not-json" },
        { health_code: "READY", source: JSON.stringify({ ...valid, calculationVersion: 1, resultGeneratedAt: "2026-09-23T10:00:00.000Z" }) },
        { health_code: "READY", source: JSON.stringify(valid) },
      ]];
    },
  });

  assert.equal((await repository.latestSuccessfulResult("rr", window, "scope"))?.generatedAt, valid.resultGeneratedAt);
});

test("应用层口径检查后、快照 INSERT 前发生编辑时，原子保存拒绝旧口径", async () => {
  const calls = [];
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); }, async commit() { calls.push("commit"); }, async rollback() { calls.push("rollback"); }, release() { calls.push("release"); },
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FROM reconciliation_rules")) return [[{ id: "rr", upstream_station_id: "up", own_station_id: "own", token_id: 1, token_name: "token", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null }]];
          if (sql.includes("FROM reconciliation_rule_channels")) return [[{ channel_id: 2, channel_name: "changed" }]];
          if (sql.includes("FROM reconciliation_rule_segments")) return [[{ id: "s1", rule_id: "rr", group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }]];
          throw new Error(`unexpected query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  const expectedScope = reconciliationScopeFingerprint({ upstreamStationId: "up", ownStationId: "own", tokenId: 1, tokenName: "token", timezone: "Asia/Shanghai", channels: [{ channelId: 1 }] }, [{ id: "s1", group: "g", ratio: 1, effectiveFrom: 1000, effectiveTo: null }]);

  assert.equal(await repository.saveSnapshotsForScope("rr", expectedScope, [{ snapshotKey: "key" }]), false);
  assert.equal(calls.some((call) => call.sql?.includes("INSERT INTO reconciliation_snapshots")), false);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["begin", "commit", "release"]);
});

test("较早成功或未确认快照都不能覆盖更晚的确认快照", async () => {
  const calls = [];
  const rule = { id: "rr", upstream_station_id: "up", own_station_id: "own", token_id: 1, token_name: "token", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [{ id: "s1", rule_id: "rr", group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }];
  const source = { window: { endMs: 5000 }, result: { calculation: { profitUsd: 1 } } };
  const pool = { async getConnection() { return {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
      if (sql.includes("FROM reconciliation_snapshots")) return [[{ source: JSON.stringify(source) }]];
      if (sql.includes("INSERT INTO reconciliation_snapshots")) throw new Error("superseded snapshot must not write");
      throw new Error(`unexpected query: ${sql}`);
    },
  }; } };
  const expected = reconciliationScopeFingerprint({ upstreamStationId: "up", ownStationId: "own", tokenId: 1, tokenName: "token", timezone: "Asia/Shanghai", channels: [] }, [{ id: "s1", group: "g", ratio: 1, effectiveFrom: 1000, effectiveTo: null }]);
  const repository = new ReconciliationRepository(pool);
  for (const profitUsd of [1, null]) {
    assert.equal(await repository.saveSnapshotsForScope("rr", expected, [{ snapshotKey: "7d:1000:Asia/Shanghai:scope:s1", source: { window: { endMs: 4000 }, result: { calculation: { profitUsd } } } }]), true);
  }
  assert.equal(calls.some((call) => call.sql?.includes("INSERT INTO reconciliation_snapshots")), false);
  assert.ok(calls.some((call) => call.sql.includes("FROM reconciliation_rules") && call.sql.includes("FOR UPDATE")), "同一规则的快照写入仍由规则行锁串行");
  assert.equal(calls.some((call) => call.sql.includes("FROM reconciliation_snapshots") && call.sql.includes("FOR UPDATE")), false, "快照行不加锁定读，避免不存在的键产生间隙锁死锁");
});

test("持久化成功账单只接受相同核算口径，并在 SQL 中限定候选快照", async () => {
  const window = { preset: "7d", startMs: 1000, endMs: 5000, timezone: "Asia/Shanghai" };
  const calls = [];
  const source = {
    calculationVersion: 2, billingSource: "channel-log-stat", scopeFingerprint: "current-scope",
    window: { ...window, endMs: 4000 }, resultGeneratedAt: "2026-09-23T10:00:00.000Z",
    result: { calculation: { differenceUsd: 2, profitUsd: 2, riskDifferenceUsd: null, marginRate: 0.5 } },
  };
  const repository = new ReconciliationRepository({
    async query(sql, params) {
      calls.push({ sql, params });
      return [[{ health_code: "READY", source: JSON.stringify(source) }]];
    },
  });

  assert.equal(await repository.latestSuccessfulResult("rr", window, "changed-scope"), null);
  await assert.rejects(() => repository.latestSuccessfulResult("rr", window), /必须指定核算口径/);
  assert.match(calls[0].sql, /snapshot_key LIKE \?/);
  assert.equal(calls[0].params[2], "7d:1000:Asia/Shanghai:changed-scope:%");
  assert.equal((await repository.latestSuccessfulResult("rr", window, "current-scope"))?.result.calculation.profitUsd, 2);
});

test("成功快照的前缀查询转义时区中的 LIKE 通配符", async () => {
  const calls = [];
  const repository = new ReconciliationRepository({ async query(sql, params) { calls.push({ sql, params }); return [[]]; } });
  await repository.latestSuccessfulResult("rr", { preset: "7d", startMs: 1000, endMs: 2000, timezone: "America/Port_of_Spain" }, "scope");
  assert.match(calls[0].sql, /ESCAPE '!'/);
  assert.equal(calls[0].params[2], "7d:1000:America/Port!_of!_Spain:scope:%");
});


test("多规则查询限制同时执行数且保持结果顺序", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency(Array.from({ length: 18 }, (_, index) => index), 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value % 3));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(result, Array.from({ length: 18 }, (_, index) => index * 2));
});

test("打开添加规则时可强制刷新本站渠道目录", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return {
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { total: 1, items: [
        { id: requests === 1 ? 312 : 333, name: requests === 1 ? "小福星-awsb-2.9" : "小福星-awsb_3-2.9", status: 1 },
      ] } }),
    };
  });
  const own = { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "test-token" };
  const reconciliation = createReconciliationModule({
    pool: { async query() { return [[]]; } },
    store: { list: () => [own], get: () => own },
  });

  assert.deepEqual((await reconciliation.getConfiguration()).channels.map((channel) => channel.id), [312]);
  assert.deepEqual((await reconciliation.getConfiguration()).channels.map((channel) => channel.id), [312]);
  assert.deepEqual((await reconciliation.getConfiguration({ forceChannels: true })).channels.map((channel) => channel.id), [333]);
  assert.equal(requests, 2);
});

test("并发强制刷新时较晚完成的旧目录不能覆盖最新渠道缓存", async (t) => {
  const pending = [];
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => pending.push(resolve)));
  const own = { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "test-token" };
  const reconciliation = createReconciliationModule({
    pool: { async query() { return [[]]; } },
    store: { list: () => [own], get: () => own },
  });
  const responseFor = (id) => ({
    status: 200,
    text: async () => JSON.stringify({ success: true, data: { total: 1, items: [{ id, name: `渠道 ${id}`, status: 1 }] } }),
  });

  const older = reconciliation.getConfiguration({ forceChannels: true });
  const newer = reconciliation.getConfiguration({ forceChannels: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1](responseFor(333));
  assert.deepEqual((await newer).channels.map((channel) => channel.id), [333]);
  pending[0](responseFor(312));
  assert.deepEqual((await older).channels.map((channel) => channel.id), [312]);
  assert.deepEqual((await reconciliation.getConfiguration()).channels.map((channel) => channel.id), [333]);
  assert.equal(pending.length, 2);
});

test("渠道目录失败时配置接口不回显上游错误中的令牌，服务端日志只记脱敏原因", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    status: 500,
    text: async () => JSON.stringify({ success: false, message: "Authorization: Bearer sk-sensitive-value; admin test-token rejected" }),
  }));
  const logged = [];
  t.mock.method(console, "error", (...args) => { logged.push(args.join(" ")); });
  const own = { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "test-token" };
  const reconciliation = createReconciliationModule({
    pool: { async query() { return [[]]; } },
    store: { list: () => [own], get: () => own },
  });

  const configuration = await reconciliation.getConfiguration();
  assert.equal(configuration.channels.length, 0);
  assert.match(configuration.channelsError, /本站渠道目录读取失败/);
  assert.doesNotMatch(JSON.stringify(configuration), /sk-sensitive-value|test-token/);
  assert.equal(logged.length, 1, "失败原因要留在服务端日志里便于排查");
  assert.match(logged[0], /本站渠道目录读取失败:.*rejected/);
  assert.doesNotMatch(logged[0], /sk-sensitive-value|test-token/);
});

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
          if (sql.startsWith("SELECT id FROM reconciliation_rules")) return [active ? [{ id: "rr_release" }] : []];
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
          if (sql.startsWith("SELECT id FROM reconciliation_rules")) return [[{ id: "rr_race" }]];
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

test("默认今天对账窗口按规则时区切零点，结束于当前时刻", () => {
  const now = Date.parse("2026-09-20T04:26:08.000Z"); // 上海 12:26:08
  const window = resolveReconciliationWindow({ timezone: "Asia/Shanghai" }, now);
  assert.equal(window.startMs, Date.parse("2026-09-19T16:00:00.000Z"));
  assert.equal(window.endMs, now);
  assert.equal(window.timezone, "Asia/Shanghai");
});

test("预设窗口都不会结束在当前时刻之后，自定义窗口超过当前时间会被拒绝", () => {
  const now = Date.parse("2026-09-20T04:26:08.000Z");
  for (const preset of ["today", "yesterday", "7d"]) {
    assert.ok(resolveReconciliationWindow({ preset, timezone: "Asia/Shanghai" }, now).endMs <= now, preset);
  }
  assert.equal(resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, now).endMs, now);
  assert.throws(() => resolveReconciliationWindow({ preset: "custom", timezone: "Asia/Shanghai", startMs: now - 1, endMs: now + 1 }, now), /不能超过当前时间/);
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
    const url = new URL(request.url, "http://x");
    const path = url.pathname;
    paths.push(path);
    const body = path === "/api/channel/"
      ? { success: true, data: { items: Number(url.searchParams.get("p")) <= 1 ? [{ id: 2, name: "渠道二", status: 1 }] : [] } }
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
          if (sql.startsWith("SELECT id FROM reconciliation_rules")) return [[{ id: row.id }]];
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

  assert.deepEqual(paths, ["/api/channel/", "/api/channel/"]);
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
  pool.getConnection = async () => ({
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    query: (...args) => pool.query(...args),
  });
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
    if (["/api/log/self/stat", "/api/log/stat", "/api/data/flow", "/api/data/"].includes(url.pathname)) aggregateCalls.push(url.pathname);
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
    const url = new URL(request.url, "http://x");
    const path = url.pathname;
    const body = path === "/api/status" ? { success: true, data: { quota_per_unit: 100 } }
      : path === "/api/user/self" ? { success: true, data: { id: 1 } }
        : path === "/api/user/self/groups" ? { success: true, data: { fixed: { ratio: 1 } } }
          : path === "/api/token/" ? { success: true, data: { total: 2, items: [
            { id: 9, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
            { id: 10, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
          ] } }
            : path === "/api/channel/" ? { success: true, data: { items: Number(url.searchParams.get("p")) <= 1 ? [{ id: 1, name: "渠道", status: 1 }] : [] } }
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
  let ownBillingBroken = false;
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
    else if (url.pathname === "/api/log/stat") {
      assert.equal(url.searchParams.get("channel"), "1");
      assert.equal(url.searchParams.has("channel_id"), false);
      body = ownBillingBroken
        ? { success: false, message: "channel stat unavailable" }
        : { success: true, data: { quota: start === 1000 ? 200 : 100 } };
    }
    else if (url.pathname === "/api/channel/") body = { success: true, data: { items: Number(url.searchParams.get("p")) <= 1 ? [{ id: 1, name: "渠道", status: 2 }] : [] } };
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
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道", channel_status: null }]];
          if (sql.includes("effective_to_ms IS NULL") && sql.includes("FOR UPDATE")) return [[segments.find((segment) => segment.effective_to_ms == null)]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) {
            snapshotSources.push(JSON.parse(params.at(-1)));
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("UPDATE reconciliation_rules SET token_name")) return [{ affectedRows: 1 }];
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
  assert.equal(result.downstream.billingSource, "channel-log-stat");
  assert.equal(result.downstream.calculationVersion, 2);
  assert.equal(result.downstream.billingCoverage, 1);
  assert.equal(result.calculation.differenceUsd, 2);
  assert.equal(result.calculation.profitUsd, null, "an upstream-empty sales anomaly is a risk difference, never confirmed profit");
  assert.equal(result.calculation.riskDifferenceUsd, 2);
  assert.equal(result.calculation.marginRate, null, "an upstream-empty sales anomaly must invalidate the aggregate margin");
  assert.equal(result.downstream.channels[0].state, "manual_disabled");
  assert.equal(result.health.code, "UPSTREAM_EMPTY_WITH_SALES", "billing anomalies must outrank transition-timing notices");
  assert.ok(result.health.issues.some((issue) => issue.code === "UPSTREAM_EMPTY_WITH_SALES"));
  assert.deepEqual([...statRequests].sort((left, right) => left.start - right.start), [
    { tokenName: "stable", group: null, start: 1000, end: 1029 },
    { tokenName: "stable", group: null, start: 1030, end: 1059 },
  ], "each half-open segment must query its own token-only window exactly once");
  assert.ok(result.health.issues.some((issue) => issue.code === "SALES_CHANNEL_DISABLED"));
  assert.ok(result.health.issues.some((issue) => issue.code === "SEGMENT_TIMING_UNCONFIRMED"));
  assert.deepEqual(snapshotSources[0].segment, {
    group: "g1", ratio: 2.9, ratioObservedAt: 1000001, ratioSource: "group_catalog", timingSource: "operator_confirmed",
  });
  assert.equal(snapshotSources[0].calculationVersion, 2);
  assert.equal(snapshotSources[0].billingSource, "channel-log-stat");
  assert.equal(snapshotSources[0].downstream.calculationVersion, 2);
  assert.deepEqual(
    snapshotSources.filter(Boolean).map((source) => source.downstream.channels),
    [
      [{ channelId: 1, quotaUnits: 200, amountUsd: 2 }],
      [{ channelId: 1, quotaUnits: 100, amountUsd: 1 }],
    ],
    "即使利润被阻断，每个分段也必须保存自己的渠道收费证据"
  );
  ownBillingBroken = true;
  const afterBillingFailure = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(afterBillingFailure.results[0].health.code, "OWN_BILLING_UNAVAILABLE");
  assert.equal(afterBillingFailure.results[0].downstream.amountUsd, null, "任一渠道账单失败后不得保留部分收费");
  assert.equal(afterBillingFailure.results[0].downstream.channels[0].quotaUnits, null);
  assert.equal(afterBillingFailure.results[0].downstream.channels[0].share, null, "账单不完整时渠道占比必须保持未知");
  assert.equal(afterBillingFailure.results[0].calculation.profitUsd, null);
  assert.equal(afterBillingFailure.results[0].calculation.marginRate, null);
  ownBillingBroken = false;
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

test("多分段查询不会按分段重复探测上游身份或两侧 /api/status", async (t) => {
  const { createServer } = await import("node:http");
  const upstreamCounts = {};
  const ownCounts = {};
  const statUsers = [];
  let ownStatusBroken = false;
  const serve = (counts, route) => createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    counts[url.pathname] = (counts[url.pathname] || 0) + 1;
    const body = route(url, request) || { success: false };
    response.writeHead(body.success === false ? 500 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const upstreamServer = serve(upstreamCounts, (url, request) => {
    if (url.pathname === "/api/status") return { success: true, data: { quota_per_unit: 100 } };
    if (url.pathname === "/api/user/self") return { success: true, data: { id: 7 } };
    if (url.pathname === "/api/user/self/groups") return { success: true, data: { g1: { ratio: 1 }, g2: { ratio: 2 } } };
    if (url.pathname === "/api/token/") return { success: true, data: { total: 1, items: [{ id: 9, name: "stable", status: 1, group: "g2", cross_group_retry: false }] } };
    if (url.pathname === "/api/log/self/stat") {
      statUsers.push(request.headers["new-api-user"]);
      return { success: true, data: { quota: 100 } };
    }
  });
  const ownServer = serve(ownCounts, (url) => {
    if (url.pathname === "/api/status") return ownStatusBroken ? { success: false, message: "status unavailable" } : { success: true, data: { quota_per_unit: 100 } };
    if (url.pathname === "/api/log/stat") return { success: true, data: { quota: 250 } };
    if (url.pathname === "/api/channel/") return { success: true, data: { total: 1, items: [{ id: 1, name: "渠道", status: 1 }] } };
  });
  await Promise.all([upstreamServer, ownServer].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
  t.after(() => { upstreamServer.close(); ownServer.close(); });
  const rule = { id: "rr_request_budget", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [1000000, 1030000, 1060000, 1090000].map((from, index) => ({
    id: `s${index + 1}`, rule_id: rule.id, group_name: index % 2 ? "g2" : "g1", group_ratio: index % 2 ? 2 : 1,
    ratio_observed_at_ms: from, ratio_source: "group_catalog",
    effective_from_ms: from, effective_to_ms: index === 3 ? null : from + 30000,
    detected_at_ms: from, timing_source: "operator_confirmed",
  }));
  const query = async (sql) => {
    if (sql.includes("FROM reconciliation_rules")) return [[rule]];
    if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道", channel_status: null }]];
    if (sql.includes("effective_to_ms IS NULL")) return [[segments[3]]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
    if (sql.includes("FROM reconciliation_snapshots") || sql.includes("reconciliation_alert_state")) return [[]];
    return [{ affectedRows: 1 }];
  };
  const pool = {
    query,
    async getConnection() {
      return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    },
  };
  const stations = [
    { id: "upstream", type: "newapi", baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, accessToken: "pat" },
    { id: "own", type: "newapi", isOwn: true, baseUrl: `http://127.0.0.1:${ownServer.address().port}`, accessToken: "admin" },
  ];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), channels: [] } });
  const window = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1120000 };

  const { results: [result] } = await module.queryRules(window, { force: true });
  assert.equal(result.segments.length, 4);
  assert.equal(result.health.code, "READY");
  assert.equal(result.upstream.amountUsd, 4);
  assert.equal(result.downstream.amountUsd, 10);
  assert.equal(result.calculation.profitUsd, 6);
  assert.deepEqual(upstreamCounts, {
    "/api/user/self": 1, "/api/status": 1, "/api/user/self/groups": 1, "/api/token/": 1, "/api/log/self/stat": 4,
  }, "上游身份与 /api/status 只在读取元数据时各探测一次，分段只请求自己的 stat");
  assert.deepEqual(statUsers, ["7", "7", "7", "7"], "分段 stat 复用元数据解析出的 PAT 身份");
  assert.deepEqual(ownCounts, { "/api/channel/": 1, "/api/status": 1, "/api/log/stat": 4 }, "本站 /api/status 每轮只读一次，由各分段共用");

  for (const counts of [upstreamCounts, ownCounts]) for (const path of Object.keys(counts)) delete counts[path];
  ownStatusBroken = true;
  const { results: [broken] } = await module.queryRules(window, { force: true });
  assert.equal(ownCounts["/api/status"], 1, "本站 /api/status 失败时也不会按分段重试");
  assert.deepEqual(broken.segments.map((segment) => segment.health.issues.map((issue) => issue.code)), Array(4).fill(["OWN_BILLING_UNAVAILABLE"]));
  assert.equal(broken.downstream.amountUsd, null);
  assert.equal(broken.calculation.profitUsd, null);
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
              : url.pathname === "/api/log/stat" ? { success: true, data: { quota: 100 } }
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
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道" }]];
          if (sql.includes("effective_to_ms IS NULL") && sql.includes("FOR UPDATE")) return [[segments.find((segment) => segment.effective_to_ms == null)]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) return [{ affectedRows: 1 }];
          if (sql.startsWith("UPDATE reconciliation_rules SET token_name")) return [{ affectedRows: 1 }];
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

test("修正切换时间锁定相邻分段，并保留旧快照作为历史证据", async () => {
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
  assert.equal(calls.some((call) => call.sql?.startsWith("DELETE FROM reconciliation_snapshots")), false);
});

test("查询中修正切换时间后，旧失败任务不会写入或缓存旧分段结果", async () => {
  const rule = { id: "rr_race_scope", upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [
    { id: "s1", rule_id: rule.id, group_name: "g1", group_ratio: 2, effective_from_ms: 1000, effective_to_ms: 2000, detected_at_ms: 2000, timing_source: "operator_confirmed" },
    { id: "s2", rule_id: rule.id, group_name: "g2", group_ratio: 3, effective_from_ms: 2000, effective_to_ms: null, detected_at_ms: 2000, timing_source: "detected" },
  ];
  let releaseOldRead;
  let delayOldRead = true;
  const writes = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) {
        if (delayOldRead) {
          delayOldRead = false;
          return new Promise((resolve) => { releaseOldRead = () => resolve([segments.map((row) => ({ ...row, effective_to_ms: row.id === "s1" ? 2000 : null, effective_from_ms: row.id === "s2" ? 2000 : row.effective_from_ms }))]); });
        }
        return [segments];
      }
      if (sql.includes("FROM reconciliation_snapshots")) return [[]];
      if (sql.includes("INSERT INTO reconciliation_snapshots")) { writes.push(params); return [{ affectedRows: 1 }]; }
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) { writes.push(params); return [{ affectedRows: 1 }]; }
          if (sql.includes("FOR UPDATE")) return [segments];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            segments[0].effective_to_ms = params[1];
            segments[1].effective_from_ms = params[3];
            segments[1].timing_source = "operator_confirmed";
            return [{ affectedRows: 2 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const rt = { pool, store: { list: () => [], get: () => null, channels: [] } };
  const module = createReconciliationModule(rt);
  const pending = module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 }, { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  await module.correctTransition(rule.id, "s2", 2500);
  releaseOldRead();
  const { results } = await pending;

  assert.equal(results[0].currentSegment.id, "s2");
  assert.equal(results[0].currentSegment.effectiveFrom, 2500);
  assert.equal(writes.length, 1, "only the restarted query may persist an unavailable snapshot");
  assert.equal(writes[0][1], "s2", "the old task must not write the pre-correction segment");
  assert.equal([...rt._reconciliationResultCache.values()][0].value.currentSegment.effectiveFrom, 2500);
});

test("加入同一 in-flight 查询的调用方在口径变化后也只拿到新口径结果", async () => {
  const rule = { id: "rr_joined_scope", upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [
    { id: "s1", rule_id: rule.id, group_name: "g1", group_ratio: 2, effective_from_ms: 1000, effective_to_ms: 2000, detected_at_ms: 2000, timing_source: "operator_confirmed" },
    { id: "s2", rule_id: rule.id, group_name: "g2", group_ratio: 3, effective_from_ms: 2000, effective_to_ms: null, detected_at_ms: 2000, timing_source: "detected" },
  ];
  let releaseOldRead;
  let delayOldRead = true;
  const writes = [];
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) {
        if (delayOldRead) {
          delayOldRead = false;
          return new Promise((resolve) => { releaseOldRead = () => resolve([segments.map((row) => ({ ...row, effective_to_ms: row.id === "s1" ? 2000 : null, effective_from_ms: row.id === "s2" ? 2000 : row.effective_from_ms }))]); });
        }
        return [segments];
      }
      if (sql.includes("FROM reconciliation_snapshots")) return [[]];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) { writes.push(params); return [{ affectedRows: 1 }]; }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            segments[0].effective_to_ms = params[1];
            segments[1].effective_from_ms = params[3];
            segments[1].timing_source = "operator_confirmed";
            return [{ affectedRows: 2 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null, channels: [] } });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const first = module.queryRules(input, { force: true });
  await tick();
  const joined = module.queryRules(input);
  for (let i = 0; i < 5; i += 1) await tick();
  await module.correctTransition(rule.id, "s2", 2500);
  releaseOldRead();
  const [firstResponse, joinedResponse] = await Promise.all([first, joined]);

  assert.equal(firstResponse.results[0].currentSegment.effectiveFrom, 2500);
  // 路由把结果序列化成 JSON；内部作废标记一旦漏出就会变成 null，前端读取 requestedWindow 时崩溃。
  const joinedJson = JSON.parse(JSON.stringify(joinedResponse));
  assert.notEqual(joinedJson.results[0], null);
  assert.equal(joinedJson.results[0].currentSegment.effectiveFrom, 2500);
  assert.equal(writes.length, 1, "两个调用方共享一次重跑，只写入一次新口径快照");
});

test("查询期间口径持续变化时最多尝试 3 次，本轮返回待获取且不缓存", async () => {
  const rule = { id: "rr_unstable_scope", upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [{ id: "s1", rule_id: rule.id, group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }];
  let channelReads = 0;
  let segmentReads = 0;
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      // 每次读取都像刚被编辑过一样换一个渠道，口径指纹永远对不上。
      if (sql.includes("FROM reconciliation_rule_channels")) {
        channelReads += 1;
        // 重试一旦失去上限，就在这里失败而不是让测试挂死。
        if (channelReads > 20) throw new Error("口径重试没有上限");
        return [[{ rule_id: rule.id, channel_id: channelReads, channel_name: `渠道 ${channelReads}` }]];
      }
      if (sql.includes("FROM reconciliation_rule_segments")) {
        segmentReads += 1;
        return [segments];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() { throw new Error("口径不一致时不能开启快照写入事务"); },
  };
  const rt = { pool, store: { list: () => [], get: () => null, channels: [] } };
  const module = createReconciliationModule(rt);
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 };

  const { results } = await module.queryRules(input, { force: true });
  assert.equal(results[0].rule.id, rule.id);
  assert.equal(results[0].health.code, "PENDING", "口径被连续改动时只让这条规则本轮待获取，不能让整个查询失败");
  assert.equal(results[0].calculation.profitUsd, null);
  assert.equal(results[0].requestedWindow.endMs, 3000);
  assert.equal(segmentReads, 3, "每次尝试读取一次分段，总共只尝试 3 次");
  assert.equal(rt._reconciliationResultCache.size, 0, "待获取结果不能进缓存");

  await module.queryRules(input);
  assert.equal(segmentReads, 6, "下一轮非强制查询必须重新取数，不能命中待获取结果");
});

// 测试中途可挂起的检查点：hold() 挂起调用方并让 reached 完成，release() 放行。
function holdPoint() {
  let reach;
  let release;
  const reached = new Promise((resolve) => { reach = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  return { reached, release, hold: () => { reach(); return released; } };
}

// 上游站点缺失的规则走不可用落库路径，不需要网络；成功账单查询、告警读取、快照事务提交都可挂起，
// 用来在查询中途插入切换时间修正。
function scopeRaceFixture(id, { beforeLookup = null, beforeAlertRead = null, beforeSnapshotCommit = null } = {}) {
  const rule = { id, upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [
    { id: "s1", rule_id: id, group_name: "g1", group_ratio: 2, effective_from_ms: 1000, effective_to_ms: 2000, detected_at_ms: 2000, timing_source: "operator_confirmed" },
    { id: "s2", rule_id: id, group_name: "g2", group_ratio: 3, effective_from_ms: 2000, effective_to_ms: null, detected_at_ms: 2000, timing_source: "detected" },
  ];
  const state = { writes: [], lookups: 0, alertInserts: 0 };
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
      if (sql.includes("FROM reconciliation_snapshots")) {
        state.lookups += 1;
        await beforeLookup?.(state.lookups);
        return [[]];
      }
      if (sql.includes("SELECT * FROM reconciliation_alert_state")) {
        await beforeAlertRead?.();
        return [[]];
      }
      if (sql.includes("INSERT INTO reconciliation_alert_state")) state.alertInserts += 1;
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      let wroteSnapshots = false;
      return {
        async beginTransaction() {}, async rollback() {}, release() {},
        async commit() { if (wroteSnapshots) await beforeSnapshotCommit?.(); },
        async query(sql, params) {
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) {
            wroteSnapshots = true;
            state.writes.push(params);
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            segments[0].effective_to_ms = params[1];
            segments[1].effective_from_ms = params[3];
            segments[1].timing_source = "operator_confirmed";
            return [{ affectedRows: 2 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const rt = { pool, store: { list: () => [], get: () => null, channels: [] } };
  const input = { ruleIds: [id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 };
  return { rule, state, rt, input, module: createReconciliationModule(rt) };
}

test("编辑后已有调用方按新口径另起任务时，旧任务直接等它，不重复取数和写快照", async () => {
  const lookups = [holdPoint(), holdPoint()];
  const { rule, state, module, input } = scopeRaceFixture("rr_join_newer", { beforeLookup: (count) => lookups[count - 1]?.hold() });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const older = module.queryRules(input, { force: true });
  await lookups[0].reached;
  await module.correctTransition(rule.id, "s2", 2500);
  const newer = module.queryRules(input, { force: true });
  await lookups[1].reached;
  lookups[0].release();
  for (let i = 0; i < 5; i += 1) await tick();
  lookups[1].release();
  const [olderResponse, newerResponse] = await Promise.all([older, newer]);

  assert.equal(olderResponse.results[0], newerResponse.results[0], "旧任务直接复用新口径任务的结果");
  assert.equal(olderResponse.results[0].currentSegment.effectiveFrom, 2500);
  assert.equal(state.lookups, 2, "旧任务作废后不能自己再重跑一轮");
  assert.equal(state.writes.length, 1, "两个任务只写入一次新口径快照");
  assert.equal(state.writes[0][1], "s2");
});

test("落库和通知期间口径被修正时，旧口径结果既不返回也不缓存", async () => {
  const alertRead = holdPoint();
  let held = false;
  const { rule, rt, module, input } = scopeRaceFixture("rr_generation_race", {
    beforeAlertRead: () => {
      if (held) return;
      held = true;
      return alertRead.hold();
    },
  });
  const pending = module.queryRules(input, { force: true });
  await alertRead.reached;
  await module.correctTransition(rule.id, "s2", 2500);
  alertRead.release();
  const { results } = await pending;

  assert.equal(results[0].currentSegment.effectiveFrom, 2500);
  assert.equal([...rt._reconciliationResultCache.values()][0].value.currentSegment.effectiveFrom, 2500);
});

test("快照事务提交后、通知前口径被修正时，不为旧口径记录告警", async () => {
  const commit = holdPoint();
  let held = false;
  const { rule, state, module, input } = scopeRaceFixture("rr_notify_race", {
    beforeSnapshotCommit: () => {
      if (held) return;
      held = true;
      return commit.hold();
    },
  });
  const pending = module.queryRules(input, { force: true });
  await commit.reached;
  await module.correctTransition(rule.id, "s2", 2500);
  commit.release();
  const { results } = await pending;

  assert.equal(results[0].currentSegment.effectiveFrom, 2500);
  assert.equal(state.alertInserts, 1, "只能按新口径记录一次告警状态");
});

// 真实取数路径的夹具：两侧 NewAPI 由 fetch 替身应答，数据库按 SQL 路由。
// 每个分段上游消费 $1、本站渠道收费 $2.5，利润 $1.5。
function liveReconciliationFixture(t, { segments: specs, onRequest = null }) {
  const ratios = { g1: 1, g2: 2 };
  const segments = specs.map(({ id, group, from, to = null }) => ({
    id, rule_id: "rr_live", group_name: group, group_ratio: ratios[group],
    ratio_observed_at_ms: from, ratio_source: "group_catalog",
    effective_from_ms: from, effective_to_ms: to, detected_at_ms: from, timing_source: "operator_confirmed",
  }));
  const open = segments.find((segment) => segment.effective_to_ms == null);
  const rule = { id: "rr_live", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: open.group_name, timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const state = { upstreamQuota: 100, ownQuota: 250, statCalls: [], requests: [], writes: 0, alertQueries: 0, snapshots: new Map() };
  const query = async (sql, params) => {
    if (sql.includes("INSERT INTO reconciliation_snapshots")) {
      state.writes += 1;
      state.snapshots.set(params[2], {
        rule_id: params[0], segment_id: params[1], snapshot_key: params[2], window_kind: params[3],
        window_start_ms: params[4], window_end_ms: params[5], health_code: params[16], health_detail: params[17],
        source: params[18], generated_at: new Date().toISOString(),
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SELECT source FROM reconciliation_snapshots")) return [[state.snapshots.get(params[1])].filter(Boolean)];
    if (sql.includes("FROM reconciliation_snapshots")) return [[...state.snapshots.values()]];
    if (sql.includes("reconciliation_alert_state")) {
      state.alertQueries += 1;
      return [[]];
    }
    if (sql.includes("effective_to_ms IS NULL")) return [[open]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
    if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道", channel_status: null }]];
    if (sql.includes("FROM reconciliation_rules")) return [[rule]];
    return [{ affectedRows: 1 }];
  };
  const pool = {
    query,
    async getConnection() {
      return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    },
  };
  const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const stat = (side, url, quota) => {
    state.statCalls.push({ side, start: Number(url.searchParams.get("start_timestamp")), end: Number(url.searchParams.get("end_timestamp")) });
    return quota == null ? reply(500, { success: false }) : reply(200, { success: true, data: { quota } });
  };
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    const request = { host: url.host, path: url.pathname, authorization: init.headers?.Authorization ?? null };
    state.requests.push(request);
    if (onRequest) await onRequest(request);
    if (url.pathname === "/api/status") return reply(200, { success: true, data: { quota_per_unit: 100, version: "v" } });
    if (url.host === "upstream.test") {
      if (url.pathname === "/api/user/self") return reply(200, { success: true, data: { id: 7 } });
      if (url.pathname === "/api/user/self/groups") return reply(200, { success: true, data: { g1: { ratio: 1 }, g2: { ratio: 2 } } });
      if (url.pathname === "/api/token/") return reply(200, { success: true, data: { total: 1, items: [{ id: 9, name: "stable", status: 1, group: rule.fixed_group, cross_group_retry: false }] } });
      if (url.pathname === "/api/log/self/stat") return stat("upstream", url, state.upstreamQuota);
    }
    if (url.host === "own.test") {
      if (url.pathname === "/api/channel/") return reply(200, { success: true, data: { total: 1, items: [{ id: 1, name: "渠道", status: 1 }] } });
      if (url.pathname === "/api/log/stat") return stat("own", url, state.ownQuota);
    }
    return reply(404, { success: false });
  });
  const stations = [
    { id: "upstream", name: "上游", type: "newapi", baseUrl: "https://upstream.test", accessToken: "pat" },
    { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "admin" },
  ];
  const rt = { pool, store: { list: () => stations, get: (stationId) => stations.find((station) => station.id === stationId) || null, channels: [] } };
  return { rule, state, stations, rt, module: createReconciliationModule(rt) };
}

test("今天窗口刚过零点不满一个统计秒时返回待获取：不取数、不写快照、不告警、不缓存", async (t) => {
  const dayStart = Date.parse("2026-09-19T16:00:00.000Z"); // Asia/Shanghai 2026-09-20 00:00
  const { rule, rt, state, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: dayStart - 3600000 }] });
  const realNow = Date.now;
  let now = dayStart + 500;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const input = { ruleIds: [rule.id], preset: "today", timezone: "Asia/Shanghai" };

  await module.refreshDue(now);
  const pending = await module.queryRules(input);
  assert.equal(pending.results[0].health.code, "PENDING");
  assert.equal(pending.results[0].calculation.profitUsd, null);
  assert.deepEqual(state.statCalls, [], "不满一秒的窗口不能向任何一侧请求统计");
  assert.equal(state.writes, 0, "待获取不能写入快照");
  assert.equal(state.alertQueries, 0, "待获取既不能告警也不能清除告警");
  assert.equal(rt._reconciliationResultCache.size, 0, "待获取不能进缓存");

  now = dayStart + 1500;
  const ready = await module.queryRules(input);
  assert.equal(ready.results[0].health.code, "READY", "满一个统计秒后，非强制查询必须立即重新核算");
  assert.equal(ready.results[0].calculation.profitUsd, 1.5);
});

test("规则刚创建不满一个统计秒时，今天和近 7 天都返回待获取", async (t) => {
  const createdAt = Date.parse("2026-09-20T04:26:08.200Z");
  const { rule, rt, state, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: createdAt }] });
  const realNow = Date.now;
  let now = createdAt + 700;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });

  for (const preset of ["today", "7d"]) {
    const { results } = await module.queryRules({ ruleIds: [rule.id], preset, timezone: "Asia/Shanghai" }, { force: true });
    assert.equal(results[0].health.code, "PENDING", `${preset} 不能把不满一秒的新分段当成上游数据不可用`);
  }
  assert.deepEqual(state.statCalls, []);
  assert.equal(state.writes, 0);
  assert.equal(state.alertQueries, 0);
  assert.equal(rt._reconciliationResultCache.size, 0);

  now = createdAt + 2000;
  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "today", timezone: "Asia/Shanghai" });
  assert.equal(results[0].health.code, "READY");
  assert.equal(results[0].calculation.profitUsd, 1.5);
});

test("近 7 天刚切段时跳过不满一秒的新分段，已结束的分段照常核算", async (t) => {
  const switchedAt = Date.parse("2026-09-20T04:26:08.000Z") + 900;
  const { rule, state, module } = liveReconciliationFixture(t, {
    segments: [
      { id: "s1", group: "g1", from: switchedAt - 3600000, to: switchedAt },
      { id: "s2", group: "g2", from: switchedAt },
    ],
  });
  const realNow = Date.now;
  Date.now = () => switchedAt + 300;
  t.after(() => { Date.now = realNow; });

  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "7d", timezone: "Asia/Shanghai" }, { force: true });
  assert.equal(results[0].health.code, "READY");
  assert.deepEqual(results[0].segments.map((segment) => segment.id), ["s1"]);
  assert.equal(results[0].currentSegment.id, "s2");
  assert.equal(results[0].calculation.profitUsd, 1.5);
  const expected = { start: Math.ceil((switchedAt - 3600000) / 1000), end: Math.floor(switchedAt / 1000) - 1 };
  for (const side of ["upstream", "own"]) {
    assert.deepEqual(state.statCalls.filter((call) => call.side === side).map(({ start, end }) => ({ start, end })), [expected], `${side} 只统计已结束分段`);
  }
});

test("窗口完全在规则生效之前时照常核算为 0，不返回不会自行恢复的待获取", async (t) => {
  const createdAt = Date.parse("2026-09-20T02:00:00.000Z"); // Asia/Shanghai 2026-09-20 10:00
  const { rule, state, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: createdAt }] });
  const realNow = Date.now;
  Date.now = () => createdAt + 7200000;
  t.after(() => { Date.now = realNow; });

  const inputs = [
    { ruleIds: [rule.id], preset: "yesterday", timezone: "Asia/Shanghai" },
    { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: createdAt - 7200000, endMs: createdAt - 3600000 },
  ];
  for (const input of inputs) {
    const { results } = await module.queryRules(input, { force: true });
    assert.equal(results[0].health.code, "READY", `${input.preset} 窗口内规则尚未生效，应按 0 核算`);
    assert.equal(results[0].calculation.profitUsd, 0);
  }
  assert.deepEqual(state.statCalls, [], "没有相交分段时不需要请求任何一侧的统计");
});

test("今天和近 7 天中间有不满一秒的已结束分段时不能跳过，按不可核算处理", async (t) => {
  const switchedAt = Date.parse("2026-09-20T04:26:08.200Z");
  const { rule, state, module } = liveReconciliationFixture(t, {
    segments: [
      { id: "s1", group: "g1", from: switchedAt - 3600000, to: switchedAt },
      { id: "s2", group: "g2", from: switchedAt, to: switchedAt + 500 },
      { id: "s3", group: "g1", from: switchedAt + 500 },
    ],
  });
  const realNow = Date.now;
  Date.now = () => switchedAt + 3600000;
  t.after(() => { Date.now = realNow; });

  for (const preset of ["today", "7d"]) {
    state.statCalls.length = 0;
    const { results } = await module.queryRules({ ruleIds: [rule.id], preset, timezone: "Asia/Shanghai" }, { force: true });
    assert.equal(results[0].health.code, "UPSTREAM_DATA_UNAVAILABLE", `${preset} 只能跳过窗口末尾的不满一秒分段`);
    assert.equal(results[0].calculation.profitUsd, null);
    assert.deepEqual(results[0].segments.map((segment) => [segment.id, segment.health.code]), [["s1", "READY"], ["s2", "UPSTREAM_DATA_UNAVAILABLE"], ["s3", "READY"]]);
    assert.equal(state.statCalls.length, 4, `${preset} 两侧只统计 s1 和 s3`);
  }
});

test("两侧都已应答的上游空消费异常不能被旧的确认利润掩盖，数据源不可用时才回退", async (t) => {
  const { rule, state, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 1000 }] });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const confirmed = await module.queryRules(input, { force: true });
  assert.equal(confirmed.results[0].calculation.profitUsd, 1.5);
  assert.equal(state.writes, 1);
  const savedSource = [...state.snapshots.values()][0].source;

  state.upstreamQuota = 0;
  const anomaly = await module.queryRules(input, { force: true });
  assert.equal(anomaly.results[0].health.code, "UPSTREAM_EMPTY_WITH_SALES");
  assert.equal(anomaly.results[0].health.stale, false, "两侧都已应答时展示本轮异常，不能回退到旧账单");
  assert.equal(anomaly.results[0].calculation.profitUsd, null);
  assert.equal(anomaly.results[0].calculation.riskDifferenceUsd, 2.5);
  assert.equal(state.writes, 1, "未确认的异常不能覆盖同一窗口的成功快照");
  assert.equal([...state.snapshots.values()][0].source, savedSource);

  state.upstreamQuota = null;
  const unavailable = await module.queryRules(input, { force: true });
  assert.equal(unavailable.results[0].health.code, "UPSTREAM_DATA_UNAVAILABLE");
  assert.equal(unavailable.results[0].health.stale, true, "上游取不到数据时才回退到最近成功账单");
  assert.equal(unavailable.results[0].calculation.profitUsd, 1.5);
  assert.equal(state.writes, 1);
});

test("多分段两侧取数并行发出", async (t) => {
  let arrived = 0;
  let releaseStats;
  const allStatsInFlight = new Promise((resolve) => { releaseStats = resolve; });
  const { rule, module } = liveReconciliationFixture(t, {
    segments: [
      { id: "s1", group: "g1", from: 1000000, to: 1030000 },
      { id: "s2", group: "g2", from: 1030000 },
    ],
    // 两个分段 × 两侧共 4 个统计请求全部发出后才统一应答；串行取数会卡在第一个分段。
    onRequest: async ({ path }) => {
      if (!path.startsWith("/api/log/")) return;
      if (++arrived === 4) releaseStats();
      await allStatsInFlight;
    },
  });
  let timeout;
  try {
    const { results } = await Promise.race([
      module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("分段取数被串行化")), 2000); }),
    ]);
    assert.equal(results[0].health.code, "READY");
    assert.equal(results[0].calculation.profitUsd, 3);
  } finally {
    clearTimeout(timeout);
    releaseStats();
  }
});

test("站点凭据原地改写后，元数据和渠道目录缓存不再复用旧凭据读到的数据", async (t) => {
  let hold = null;
  const { stations, state, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    onRequest: (request) => hold?.(request),
  });
  const requestsTo = (host, path) => state.requests.filter((request) => request.host === host && request.path === path);

  await module.getUpstreamKeys("upstream");
  await module.getUpstreamKeys("upstream");
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 1, "同一凭据在有效期内复用缓存");
  stations[0].accessToken = "pat-2";
  await module.getUpstreamKeys("upstream");
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 2, "换了 PAT 后必须重新读取");
  assert.equal(requestsTo("upstream.test", "/api/token/").at(-1).authorization, "Bearer pat-2");

  // 请求发出后凭据才被改写：缓存要记在发起请求时的凭据名下，不能把旧 PAT 读到的数据当成新 PAT 的。
  const identityProbe = holdPoint();
  hold = (request) => {
    if (request.path !== "/api/user/self") return;
    hold = null;
    return identityProbe.hold();
  };
  const inFlight = module.getUpstreamKeys("upstream", { force: true });
  await identityProbe.reached;
  stations[0].accessToken = "pat-3";
  identityProbe.release();
  await inFlight;
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 3);
  assert.equal(requestsTo("upstream.test", "/api/token/").at(-1).authorization, "Bearer pat-2");
  await module.getUpstreamKeys("upstream");
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 4, "旧 PAT 读到的数据不能记到新 PAT 名下");

  await module.getConfiguration();
  await module.getConfiguration();
  assert.equal(requestsTo("own.test", "/api/channel/").length, 1);
  stations[1].accessToken = "admin-2";
  const configuration = await module.getConfiguration();
  assert.equal(requestsTo("own.test", "/api/channel/").length, 2, "换了本站管理员令牌后必须重新读取渠道目录");
  assert.equal(requestsTo("own.test", "/api/channel/").at(-1).authorization, "admin-2");
  assert.equal(configuration.channelsError, null);
});

test("列出规则后才被停止的规则从本轮结果中去掉，其余规则照常返回", async () => {
  const active = { id: "rr_active", upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const archived = { ...active, id: "rr_archived", token_id: 10 };
  const segment = { id: "s1", rule_id: active.id, group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" };
  const query = async (sql, params) => {
    if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [[segment]];
    // 规则列表里还有它，按 id 读取时它已被停止。
    if (sql.includes("FROM reconciliation_rules")) return sql.includes("WHERE id = ?") ? [params[0] === archived.id ? [] : [active]] : [[active, archived]];
    if (sql.includes("FROM reconciliation_snapshots") || sql.includes("reconciliation_alert_state")) return [[]];
    return [{ affectedRows: 1 }];
  };
  const pool = {
    query,
    async getConnection() {
      return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null, channels: [] } });

  const { results } = await module.queryRules({ ruleIds: [active.id, archived.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 }, { force: true });
  assert.deepEqual(results.map((result) => result.rule.id), [active.id]);
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
  pool.getConnection = async () => ({
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    query: (...args) => pool.query(...args),
  });
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
    calculationVersion: 2,
    billingSource: "channel-log-stat",
    scopeFingerprint: reconciliationScopeFingerprint({
      upstreamStationId: "missing-upstream", ownStationId: "own", tokenId: 9, tokenName: "stable", timezone: "Asia/Shanghai", channels: [],
    }, [{ id: "s1", group: "g1", ratio: 2.9, effectiveFrom: 1000, effectiveTo: null }]),
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
    source: JSON.stringify({ calculationVersion: 2, billingSource: "channel-log-stat", scopeFingerprint: "scope", window: first, resultGeneratedAt: "2026-09-20T04:26:08.000Z", result: { upstream: { amountUsd: 2.5 }, calculation: { differenceUsd: 2.5, profitUsd: 2.5, riskDifferenceUsd: null, marginRate: 0.5 } } }),
  }];
  const repository = new ReconciliationRepository({
    async query() { return [rows]; },
  });
  const sameDay = { ...first, endMs: first.endMs + 30000 };
  assert.equal((await repository.latestSuccessfulResult("rr", sameDay, "scope"))?.result.upstream.amountUsd, 2.5);
  const nextDay = resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, Date.parse("2026-09-21T04:26:08.000Z"));
  assert.equal(await repository.latestSuccessfulResult("rr", nextDay, "scope"), null);
});

test("零利润的完整账单仍可作为最近成功结果恢复", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "READY", source: JSON.stringify({
        calculationVersion: 2, billingSource: "channel-log-stat", scopeFingerprint: "scope",
        window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: 0, profitUsd: 0, riskDifferenceUsd: null, marginRate: 0 } },
      }) }]];
    },
  });
  const result = await repository.latestSuccessfulResult("rr", window, "scope");
  assert.equal(result?.result.calculation.profitUsd, 0);
  assert.equal(result?.result.calculation.marginRate, 0);
});

test("旧版 flow 收费快照即使曾有利润也不能作为最近成功账单复用", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "READY", source: JSON.stringify({
        scopeFingerprint: "scope", window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: 2.5, profitUsd: 2.5, riskDifferenceUsd: null, marginRate: 0.5 } },
      }) }]];
    },
  });

  assert.equal(await repository.latestSuccessfulResult("rr", window, "scope"), null);
});

test("非确认的旧快照不会被兼容逻辑伪造成利润", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "UPSTREAM_EMPTY_WITH_SALES", source: JSON.stringify({
        scopeFingerprint: "scope", window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: 2.5, marginRate: 0.5 } },
      }) }]];
    },
  });
  assert.equal(await repository.latestSuccessfulResult("rr", window, "scope"), null);
});

test("仓储不会把失败或异常快照当作最近成功账单", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "UPSTREAM_DATA_UNAVAILABLE", source: JSON.stringify({
        scopeFingerprint: "scope", window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null } },
      }) }]];
    },
  });
  assert.equal(await repository.latestSuccessfulResult("rr", window, "scope"), null);
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
