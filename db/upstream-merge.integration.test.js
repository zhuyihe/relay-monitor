import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { ensureSchema } from "./pool.js";
import { Store } from "./store.js";
import { isCiphertext, secretKeyOf } from "./secrets.js";
import { applyUpstreamMerge, listMergeRecords, planNow, previewUpstreamMerges, undoUpstreamMerge } from "../server/upstream-merge.js";
import { undoMerges } from "./k-unmerge.js";
import { listMerges } from "./upstream-merge-repository.js";
import { ReconciliationRepository } from "../server/reconciliation-repository.js";
import { businessTimeZone, dayKeyInTz, shiftDayLabel } from "../lib/business-time.js";

// Opt-in only: this fixture drops and recreates tables in one disposable local schema (same guard as schema.integration.test.js,
// except the name may carry a suffix, e.g. relay_monitor_test_k1a, so a local run does not share tables with another test schema).
const port = Number(process.env.DB_PORT);
const TEST_NAME = /^relay_monitor_test(_[a-z0-9]+)?$/;
if (process.env.ONBOARDING_SCHEMA_TEST !== "1"
  || !["127.0.0.1", "localhost"].includes(process.env.DB_HOST)
  || !TEST_NAME.test(process.env.DB_NAME || "")
  || !TEST_NAME.test(process.env.DB_USER || "")
  || !process.env.DB_PASSWORD
  || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Refusing SQL integration test: explicit ONBOARDING_SCHEMA_TEST=1, localhost, port, test credentials and relay_monitor_test schema are required");
}

const TABLES = ["upstream_merge_log", "channel_monitor_links", "reconciliation_ledger", "reconciliation_billing_capabilities", "reconciliation_alert_state",
  "reconciliation_snapshots", "reconciliation_rule_segments", "reconciliation_rule_channels", "reconciliation_rules", "station_daily_usage", "history_points", "meta", "stations"];
const secretKey = secretKeyOf(Buffer.alloc(32, 7).toString("base64"));
const identity = (accountId) => ({ provider: "newapi", baseUrl: "https://up.example.com", accountId });
const CREATED = { a: "2026-03-01T00:00:00.000Z", b: "2026-03-02T00:00:00.000Z", c: "2026-03-03T00:00:00.000Z", d: "2026-03-04T00:00:00.000Z" };

// 一张表的全部内容（按主键排好），包括 updated_at：合并不能把绑定顶到「最近改过」的最前面
async function dump(pool, table, order) {
  const [rows] = await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`);
  return JSON.parse(JSON.stringify(rows));
}
const dumpAll = async (pool) => ({
  rules: await dump(pool, "reconciliation_rules", "id"),
  links: await dump(pool, "channel_monitor_links", "own_station_id, channel_id, station_id"),
  channels: await dump(pool, "reconciliation_rule_channels", "rule_id, channel_id"),
  segments: await dump(pool, "reconciliation_rule_segments", "id"),
  snapshots: await dump(pool, "reconciliation_snapshots", "id"),
  ledger: await dump(pool, "reconciliation_ledger", "rule_id, bill_date, revision"),
  history: await dump(pool, "history_points", "station_id, t"),
  stations: await dump(pool, "stations", "id"),
});

test("合并重复上游：文档、绑定、关联、日志同一个事务；账本不动；改回以后和合并前逐字相同", { timeout: 60000 }, async (t) => {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, connectionLimit: 8 });
  t.after(() => pool.end());
  for (const table of TABLES) await pool.query(`DROP TABLE IF EXISTS ${table}`);
  await ensureSchema(pool);

  const store = await new Store(pool, { secretKey }).load();
  const ids = {};
  for (const [name, accountId] of [["a", "42"], ["b", "42"], ["c", "42"], ["d", "99"]]) {
    const station = await store.add({ name: `上游 ${name}`, type: "newapi", baseUrl: "https://up.example.com", accessToken: `token-${name}`, userId: "1" },
      { verifiedIdentity: identity(accountId) });
    // 创建时间由 Store 定成「现在」，测试里要固定先后
    await store._changeStation(station.id, (s) => { s.createdAt = CREATED[name]; });
    ids[name] = station.id;
  }
  await store._changeStation(ids.b, (s) => { s.costAliases = ["http://internal-b"]; s.cnyPerUsd = 7; });
  await store._changeStation(ids.a, (s) => { s.costAliases = ["http://internal-a"]; });
  const rt = { pool, store };

  const rule = (id, upstream, token, activeKey, canonicalKey = null, extra = {}) => pool.query(
    `INSERT INTO reconciliation_rules (id, upstream_station_id, own_station_id, token_id, token_name, fixed_group, active_token_key, canonical_key, enabled, archived_at)
     VALUES (?, ?, 'own', ?, ?, 'g', ?, ?, ?, ?)`, [id, upstream, token, `Key ${token}`, activeKey, canonicalKey, extra.enabled ?? 1, extra.archivedAt ?? null]);
  await rule("r_b", ids.b, 5, `${ids.b}:5`);
  await rule("r_c", ids.c, 6, "canon-6", "canon-6");
  await rule("r_a", ids.a, 7, `${ids.a}:7`);
  await rule("r_old", ids.b, 8, null, null, { enabled: 0, archivedAt: "2026-05-01 00:00:00" });
  await rule("r_d", ids.d, 9, `${ids.d}:9`);
  for (const [ownId, channel, station] of [["own", 1, ids.a], ["own", 1, ids.b], ["own", 2, ids.b], ["own", 3, ids.c], ["own", 4, ids.d]]) {
    await pool.query("INSERT INTO channel_monitor_links (own_station_id, channel_id, station_id, channel_revision, confirmed_at_ms) VALUES (?, ?, ?, 'rev', 1000)", [ownId, channel, station]);
  }
  await pool.query("INSERT INTO reconciliation_rule_channels (rule_id, channel_id, channel_name, active_channel_key) VALUES ('r_b', 2, '渠道二', 'own:2')");
  await pool.query(`INSERT INTO reconciliation_ledger (rule_id, bill_date, revision, timezone, window_start_ms, window_end_ms, revenue_usd, cost_usd, source, settled_at)
    VALUES ('r_b', '2026-10-08', 1, 'UTC', 0, 86400000, 10, 6, 'settle', '2026-10-09 00:20:00.000')`);
  await pool.query("INSERT INTO history_points (station_id, t, remaining, used) VALUES (?, 1, 5, 1)", [ids.b]);

  // updated_at 是秒精度，测试跑得比一秒快：先拨到过去，合并要是动了它才看得出来
  await pool.query("UPDATE reconciliation_rules SET updated_at = TIMESTAMP('2026-01-01 00:00:00') + INTERVAL (id = 'r_a') DAY");
  // 对账仓库读出来的绑定（页面、结账读的就是这个形状）：合并前后除了上游是谁，逐字相同，顺序也一样
  const reconciliation = new ReconciliationRepository(pool);
  const rulesView = async () => (await reconciliation.listRules({ includeArchived: true })).map((item) => ({ ...item, upstreamStationId: "*" }));
  const rulesOrder = async () => (await reconciliation.listRules({ includeArchived: true })).map((item) => item.id);
  const viewBefore = await rulesView(), orderBefore = await rulesOrder();
  const before = await dumpAll(pool);
  const secretsBefore = structuredClone(store.get(ids.b));

  await t.test("清单：一组（a 留下，b、c 并进去），d 是另一个账号不动；只读，什么都不改", async () => {
    const { groups, counts, records } = await previewUpstreamMerges(rt, { estimate: false });
    assert.deepEqual(counts, { mergeable: 1, blocked: 0, accounts: 1, upstreams: 3 });
    assert.deepEqual(records, []);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].retained.id, ids.a);
    assert.deepEqual(groups[0].merged.map((s) => s.id), [ids.b, ids.c]);
    assert.deepEqual(groups[0].ruleIds, ["r_b", "r_c", "r_old"]);
    assert.equal(groups[0].linkCount, 3);
    assert.equal(groups[0].droppedLinkCount, 1);
    assert.deepEqual(groups[0].costAliasesAfter, ["http://internal-a", "http://internal-b"]);
    assert.equal(groups[0].canMerge, true);
    assert.deepEqual(await dumpAll(pool), before);
  });

  await t.test("合并前后的成本估算：读成本估算页同一份每日消耗，每个上游按自己的汇率，合并后只算留下的", async () => {
    const today = dayKeyInTz(Date.now(), businessTimeZone());
    const earlier = shiftDayLabel(today, -10);
    for (const [date, usd] of [[today, 10], [earlier, 100]]) {
      for (const id of [ids.a, ids.b, ids.c, ids.d]) await pool.query("INSERT INTO station_daily_usage (station_id, date, used_usd) VALUES (?, ?, ?)", [id, date, usd]);
    }
    try {
      const { groups } = await previewUpstreamMerges(rt);
      const [week, month] = groups[0].estimate.windows;
      // 30 天里只有 2 天有记录：和成本估算页一样标估算（approx）
      assert.deepEqual([week.approx, month.approx], [true, true]);
      assert.deepEqual([week.days, week.before.cny, week.after.cny], [7, 10 * 1 + 10 * 7 + 10 * 1, 10]);
      assert.deepEqual([month.days, month.before.cny, month.after.cny], [30, 110 + 770 + 110, 110]);
      assert.deepEqual(month.before.upstreams.map((u) => [u.stationId, u.cny]), [[ids.a, 110], [ids.b, 770], [ids.c, 110]]);
      assert.deepEqual(month.after.upstreams.map((u) => u.stationId), [ids.a]);
      // 读不到每日消耗时估算是 null，清单本身照出
      const broken = await previewUpstreamMerges({ ...rt, pool: { query: async (sql, params) => { if (/station_daily_usage/.test(sql)) throw new Error("boom"); return pool.query(sql, params); } } });
      assert.equal(broken.groups[0].estimate, null);
      assert.equal(broken.groups.length, 1);
    } finally {
      await pool.query("DELETE FROM station_daily_usage");
    }
  });

  await t.test("没有成功的合并时，库里没有合并日志", async () => {
    assert.deepEqual(await listMerges(pool), []);
  });

  await t.test("事务回滚：绑定那一侧发现和计划不一样，上游文档也不改（内存里也不改）", async () => {
    const { groups } = await planNow(rt);
    const group = structuredClone(groups[0]);
    group.ruleIds = ["r_b"];
    const { applyMergeRows } = await import("./upstream-merge-repository.js");
    await assert.rejects(store.mergeUpstreams({
      retainedId: group.retained.id, mergedIds: group.merged.map((s) => s.id),
      patches: { retained: { costAliases: ["x"] }, merged: { [ids.b]: { mergedInto: ids.a }, [ids.c]: { mergedInto: ids.a } } },
      within: (conn) => applyMergeRows(conn, group, { mergeId: "mg_test", nowMs: 1, oldRetainedAliases: [] }),
    }), { code: "UPSTREAM_MERGE_STALE" });
    assert.deepEqual(await dumpAll(pool), before);
    assert.equal(store.get(ids.b).mergedInto, undefined);
    assert.deepEqual(store.get(ids.a).costAliases, ["http://internal-a"]);
    assert.equal(store.list().length, 4);
  });

  await t.test("事务回滚：算完计划以后、写绑定时才撞上唯一键，已经写进去的上游文档也退回，不留日志", async () => {
    const { groups } = await planNow(rt);
    const group = groups[0];
    const { applyMergeRows } = await import("./upstream-merge-repository.js");
    // 计划之后有人让 d 的绑定占了「a:5」，r_b 改指向 a 时就撞上
    await pool.query("UPDATE reconciliation_rules SET active_token_key = ?, updated_at = updated_at WHERE id = 'r_d'", [`${ids.a}:5`]);
    try {
      await assert.rejects(store.mergeUpstreams({
        retainedId: group.retained.id, mergedIds: group.merged.map((s) => s.id),
        patches: { retained: { costAliases: ["x"] }, merged: { [ids.b]: { mergedInto: ids.a }, [ids.c]: { mergedInto: ids.a } } },
        within: (conn) => applyMergeRows(conn, group, { mergeId: "mg_test", nowMs: 1, oldRetainedAliases: [] }),
      }), { code: "UPSTREAM_MERGE_CONFLICT" });
      const [[ruleB]] = await pool.query("SELECT upstream_station_id, active_token_key FROM reconciliation_rules WHERE id = 'r_b'");
      assert.deepEqual({ ...ruleB }, { upstream_station_id: ids.b, active_token_key: `${ids.b}:5` });
      const [[docB]] = await pool.query("SELECT doc FROM stations WHERE id = ?", [ids.b]);
      assert.equal(docB.doc.mergedInto, undefined);
      const [[docA]] = await pool.query("SELECT doc FROM stations WHERE id = ?", [ids.a]);
      assert.deepEqual(docA.doc.costAliases, ["http://internal-a"]);
      assert.equal(store.get(ids.b).mergedInto, undefined);
      assert.deepEqual(store.get(ids.a).costAliases, ["http://internal-a"]);
      assert.deepEqual(await listMerges(pool), []);
      // 这时再点合并，清单本身就会把这一组挡住（同一把 Key 撞上了），并且写清是哪把 Key、在哪两个上游下（这里是 d 的绑定占着 a:5，所以是 d 和 b）
      await assert.rejects(applyUpstreamMerge(rt, { retainedId: ids.a, mergedIds: [ids.b, ids.c] }), { code: "UPSTREAM_MERGE_BLOCKED" });
      const blocked = await previewUpstreamMerges(rt, { estimate: false });
      assert.deepEqual(blocked.counts, { mergeable: 0, blocked: 1, accounts: 1, upstreams: 3 });
      assert.deepEqual(blocked.groups[0].blockers, [{ code: "RULE_KEY_CONFLICT", detail: "Key #5 已经有一条绑定在用", tokenId: 5, tokenName: "Key 5", ruleId: "r_b", stationIds: [ids.d, ids.b].sort() }]);
    } finally {
      await pool.query("UPDATE reconciliation_rules SET active_token_key = ?, updated_at = updated_at WHERE id = 'r_d'", [`${ids.d}:9`]);
    }
  });

  await t.test("合并：上游文档、绑定、关联、日志一起改；账本、快照、历史点、别的账号不动", async () => {
    const result = await applyUpstreamMerge(rt, { retainedId: ids.a, mergedIds: [ids.b, ids.c] }, { now: Date.parse("2026-10-26T00:00:00.000Z") });
    assert.equal(result.rules, 3);
    assert.equal(result.linksMoved, 2);
    assert.equal(result.linksDropped, 1);
    const after = await dumpAll(pool);
    // 账本、快照、规则的渠道、分段、历史点原样
    for (const key of ["ledger", "snapshots", "channels", "segments", "history"]) assert.deepEqual(after[key], before[key], key);
    // 绑定：只有 upstream_station_id（和没有 canonical 的 active_token_key）变了
    const ruleOf = (dumped, id) => dumped.rules.find((r) => r.id === id);
    assert.equal(ruleOf(after, "r_b").upstream_station_id, ids.a);
    assert.equal(ruleOf(after, "r_b").active_token_key, `${ids.a}:5`);
    assert.equal(ruleOf(after, "r_c").upstream_station_id, ids.a);
    assert.equal(ruleOf(after, "r_c").active_token_key, "canon-6");
    assert.equal(ruleOf(after, "r_old").active_token_key, null);
    assert.equal(ruleOf(after, "r_old").upstream_station_id, ids.a);
    assert.deepEqual(ruleOf(after, "r_d"), ruleOf(before, "r_d"));
    assert.deepEqual(ruleOf(after, "r_a"), ruleOf(before, "r_a"));
    for (const id of ["r_b", "r_c", "r_old"]) {
      const { upstream_station_id: _u, active_token_key: _k, ...rest } = ruleOf(after, id);
      const { upstream_station_id: _u0, active_token_key: _k0, ...rest0 } = ruleOf(before, id);
      assert.deepEqual(rest, rest0, id);
    }
    assert.deepEqual(after.links.map((l) => [l.channel_id, l.station_id]), [[1, ids.a], [2, ids.a], [3, ids.a], [4, ids.d]]);
    assert.deepEqual(await rulesView(), viewBefore, "对账仓库读出的绑定，除了上游是谁，逐字相同");
    assert.deepEqual(await rulesOrder(), orderBefore, "绑定在列表里的顺序不变");
    assert.deepEqual((await reconciliation.listRules({ includeArchived: true })).filter((item) => ["r_b", "r_c", "r_old"].includes(item.id)).map((item) => item.upstreamStationId), [ids.a, ids.a, ids.a].map(String));
    // 上游：b、c 记上并进了 a，a 的别名并进了 b 的；凭据照样加密存着、没动
    const docs = Object.fromEntries(after.stations.map((s) => [s.id, s.doc]));
    assert.equal(docs[ids.b].mergedInto, ids.a);
    assert.equal(docs[ids.c].mergedInto, ids.a);
    assert.equal(docs[ids.b].mergedAt, "2026-10-26T00:00:00.000Z");
    assert.deepEqual(docs[ids.a].costAliases, ["http://internal-a", "http://internal-b"]);
    assert.equal(docs[ids.d].mergedInto, undefined);
    for (const name of ["a", "b", "c", "d"]) assert.ok(isCiphertext(docs[ids[name]].accessToken), `${name} 的令牌还是密文`);
    assert.equal(docs[ids.b].accessToken, before.stations.find((s) => s.id === ids.b).doc.accessToken);
    // 内存里：b、c 从所有列表消失，get 还能取到
    assert.deepEqual(store.list({ includeUnmonitored: true, includeArchived: true }).map((s) => s.id).sort(), [ids.a, ids.d].sort());
    assert.equal(store.get(ids.b).mergedInto, ids.a);
    assert.deepEqual(store.list({ includeMerged: true }).length, 4);
    // 日志
    const merges = await listMerges(pool);
    assert.equal(merges.length, 1);
    assert.equal(merges[0].retainedId, ids.a);
    assert.deepEqual(merges[0].mergedIds.sort(), [ids.b, ids.c].sort());
    assert.deepEqual(merges[0].rows.map((r) => r.kind).sort(),
      ["link_dropped", "link_moved", "link_moved", "rule", "rule", "rule", "station_merged", "station_merged", "station_retained"]);
    // 重新读库：另一个 Store 实例看到的一样，密钥解得开
    const reloaded = await new Store(pool, { secretKey }).load();
    assert.deepEqual(reloaded.list({ includeUnmonitored: true, includeArchived: true }).map((s) => s.id).sort(), [ids.a, ids.d].sort());
    assert.equal(reloaded.get(ids.b).accessToken, "token-b");
    assert.equal(reloaded.get(ids.b).mergedInto, ids.a);
  });

  await t.test("合并以后再看清单：没有可合的了；再合同一组报清单变了", async () => {
    assert.deepEqual((await previewUpstreamMerges(rt, { estimate: false })).groups, []);
    await assert.rejects(applyUpstreamMerge(rt, { retainedId: ids.a, mergedIds: [ids.b, ids.c] }), { code: "UPSTREAM_MERGE_STALE" });
  });

  await t.test("改回：列出要改什么、不 apply 不改；apply 以后库里和合并前逐字相同，上游重新出现", async () => {
    const dry = await undoMerges(pool);
    assert.equal(dry.merges.length, 1);
    assert.deepEqual(dry.applied, []);
    const stillMerged = await dumpAll(pool);
    assert.equal(stillMerged.stations.find((s) => s.id === ids.b).doc.mergedInto, ids.a);
    const done = await undoMerges(pool, { apply: true, now: 5 });
    assert.equal(done.applied.length, 1);
    const restored = await dumpAll(pool);
    assert.deepEqual(restored, before);
    assert.deepEqual(await listMerges(pool), []);
    const [logRows] = await pool.query("SELECT DISTINCT undone_at_ms FROM upstream_merge_log");
    assert.deepEqual(logRows.map((r) => Number(r.undone_at_ms)), [5]);
    const reloaded = await new Store(pool, { secretKey }).load();
    assert.equal(reloaded.list().length, 4);
    assert.deepEqual(reloaded.get(ids.a).costAliases, ["http://internal-a"]);
    assert.deepEqual(reloaded.get(ids.b), { ...secretsBefore, balance: reloaded.get(ids.b).balance });
  });

  let again;
  await t.test("改回以后可以再合并一次", async () => {
    again = await new Store(pool, { secretKey }).load();
    const result = await applyUpstreamMerge({ pool, store: again }, { retainedId: ids.a, mergedIds: [ids.b, ids.c] });
    assert.equal(result.rules, 3);
  });

  await t.test("合并记录带名字；服务在跑时退回：Store 在同一个事务里改文档，合并以后用户自己加的别名留着，其余和合并前逐字相同", async () => {
    const live = { pool, store: again };
    const [record] = (await listMergeRecords(live)).filter((item) => !item.undoneAtMs);
    assert.deepEqual({ retained: record.retained, merged: record.merged.map((m) => m.name).sort(), undoable: record.undoable, undoBlocked: record.undoBlocked },
      { retained: { id: ids.a, name: "上游 a" }, merged: ["上游 b", "上游 c"], undoable: true, undoBlocked: null });
    await again._changeStation(ids.a, (st) => { st.costAliases = [...st.costAliases, "http://user-added"]; });
    const result = await undoUpstreamMerge(live, { mergeId: record.mergeId }, { now: 9 });
    assert.equal(result.retainedId, ids.a);
    const restored = await dumpAll(pool);
    for (const key of ["rules", "links", "channels", "segments", "snapshots", "ledger", "history"]) assert.deepEqual(restored[key], before[key], key);
    assert.equal(again.list().length, 4);
    assert.deepEqual(again.get(ids.a).costAliases, ["http://internal-a", "http://user-added"]);
    assert.equal(again.get(ids.b).mergedInto, undefined);
    const docs = Object.fromEntries(restored.stations.map((st) => [st.id, st.doc]));
    assert.equal(docs[ids.b].mergedInto, undefined);
    assert.equal(docs[ids.b].mergedAt, undefined);
    assert.deepEqual(docs[ids.a].costAliases, ["http://internal-a", "http://user-added"]);
    for (const name of ["a", "b", "c", "d"]) assert.equal(docs[ids[name]].accessToken, before.stations.find((st) => st.id === ids[name]).doc.accessToken, name);
    const records = await listMergeRecords(live);
    assert.deepEqual(records.filter((item) => item.undoneAtMs === 9).map((item) => item.undoable), [false]);
    await assert.rejects(undoUpstreamMerge(live, { mergeId: record.mergeId }), { code: "UPSTREAM_MERGE_STALE" });
  });

  await t.test("被合掉的上游后来删了：退回不了，说是哪个，什么都不改", async () => {
    const store2 = await new Store(pool, { secretKey }).load();
    const live = { pool, store: store2 };
    await applyUpstreamMerge(live, { retainedId: ids.a, mergedIds: [ids.b, ids.c] });
    await store2.remove(ids.b);
    const [record] = (await listMergeRecords(live)).filter((item) => !item.undoneAtMs);
    assert.equal(record.undoable, false);
    assert.deepEqual(record.undoBlocked, { code: "UPSTREAM_DELETED", detail: "「上游 b」已经删了，退回不了", stationId: ids.b });
    const frozen = await dumpAll(pool);
    await assert.rejects(undoUpstreamMerge(live, { mergeId: record.mergeId }), { code: "UPSTREAM_MERGE_BLOCKED" });
    assert.deepEqual(await dumpAll(pool), frozen);
  });
});
