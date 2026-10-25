import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.js";
import { fakePool } from "./test-support/fake-pool.js";

const doc = (id, extra = {}) => ({ id, name: id, type: "newapi", baseUrl: "https://up.example.com", ...extra });
const mergeInput = (retainedId, mergedIds, within) => ({
  retainedId, mergedIds, within,
  patchesFor: () => ({ retained: { costAliases: ["http://internal-b"] }, merged: Object.fromEntries(mergedIds.map((id) => [id, { mergedInto: retainedId, mergedAt: "2026-10-26T00:00:00.000Z" }])) }),
});

test("合并掉的上游从所有列表里消失，get 和 includeMerged 还看得到；留下的只改别名", async () => {
  const store = await new Store(fakePool([doc("a", { costAliases: ["http://internal-a"] }), doc("b")])).load();
  const calls = [];
  const result = await store.mergeUpstreams({ ...mergeInput("a", ["b"], async (conn) => { calls.push("within"); assert.equal(typeof conn.query, "function"); }),
    patchesFor: () => ({ retained: { costAliases: ["http://internal-a", "http://internal-b"] }, merged: { b: { mergedInto: "a", mergedAt: "2026-10-26T00:00:00.000Z" } } }) });
  assert.deepEqual(calls, ["within"]);
  assert.equal(result.merged[0].id, "b");
  for (const options of [{}, { includeArchived: true }, { includeUnmonitored: true }, { includeArchived: true, includeUnmonitored: true }]) {
    assert.deepEqual(store.list(options).map((s) => s.id), ["a"], JSON.stringify(options));
  }
  assert.deepEqual(store.list({ includeMerged: true }).map((s) => s.id), ["a", "b"]);
  assert.equal(store.getWithMerged("b").mergedInto, "a");
  assert.equal(store.get("b"), undefined, "被合并掉的上游当找不到");
  assert.deepEqual(store.get("a").costAliases, ["http://internal-a", "http://internal-b"]);
  assert.equal(store.get("a").mergedInto, undefined);
});

test("合并：within 在同一个连接、同一个事务里，上游文档写完以后、commit 之前执行；within 报错整个回滚，内存里的上游不变", async (t) => {
  const pool = fakePool([doc("a"), doc("b")]), conn = await pool.getConnection(), store = await new Store(pool).load();
  const order = [];
  t.mock.method(conn, "beginTransaction", async () => { order.push("begin"); });
  t.mock.method(conn, "commit", async () => { order.push("commit"); });
  t.mock.method(conn, "rollback", async () => { order.push("rollback"); });
  t.mock.method(conn, "query", async (sql) => { order.push(sql.split(" ").slice(0, 3).join(" ")); return [[]]; });
  const marks = () => order.filter((x) => ["begin", "within", "commit", "rollback"].includes(x));

  await assert.rejects(store.mergeUpstreams(mergeInput("a", ["b"], async (c) => {
    assert.equal(c, conn);
    order.push("within");
    throw Object.assign(new Error("绑定变了"), { code: "UPSTREAM_MERGE_STALE" });
  })), { code: "UPSTREAM_MERGE_STALE" });
  assert.deepEqual(marks(), ["begin", "within", "rollback"]);
  assert.equal(store.get("b").mergedInto, undefined);
  assert.equal(store.get("a").costAliases?.length ?? 0, 0);
  assert.deepEqual(store.list().map((s) => s.id), ["a", "b"]);

  // 别的错照旧说「保存失败」，不把库的报错原文往外送
  await assert.rejects(store.mergeUpstreams(mergeInput("a", ["b"], async () => { throw Object.assign(new Error("boom"), { code: "ER_LOCK_DEADLOCK" }); })), { code: "SAVE_FAILED" });

  order.length = 0;
  await store.mergeUpstreams(mergeInput("a", ["b"], async () => { order.push("within"); }));
  assert.deepEqual(marks(), ["begin", "within", "commit"]);
  assert.ok(order.indexOf("within") > order.findIndex((x) => x.startsWith("INSERT INTO stations")), "上游文档先写，within 在后，同一个事务");
});

test("合并：留下的或被合掉的已经变了（被合过、已归档、没有了）就拒绝，什么都不写", async () => {
  const store = await new Store(fakePool([doc("a"), doc("b", { mergedInto: "a" }), doc("c", { archivedAt: "2026-01-01T00:00:00.000Z" })])).load();
  const never = async () => assert.fail("must not run");
  for (const mergedIds of [["b"], ["c"], ["gone"]]) {
    await assert.rejects(store.mergeUpstreams(mergeInput("a", mergedIds, never)), { code: "UPSTREAM_MERGE_STALE" }, mergedIds.join());
  }
  await assert.rejects(store.mergeUpstreams(mergeInput("gone", ["a"], never)), { code: "UPSTREAM_MERGE_STALE" });
});

test("拿到锁以后按那一刻的上游文档重新算改动：patchesFor 抛 UPSTREAM_MERGE_STALE 就什么都不写", async () => {
  const store = await new Store(fakePool([doc("a"), doc("b")])).load();
  const seen = [];
  await assert.rejects(store.mergeUpstreams({ retainedId: "a", mergedIds: ["b"], within: async () => assert.fail("must not run"),
    patchesFor: (retained, merged) => { seen.push([retained.id, merged.map((s) => s.id)]); throw Object.assign(new Error("变了"), { code: "UPSTREAM_MERGE_STALE" }); } }), { code: "UPSTREAM_MERGE_STALE" });
  assert.deepEqual(seen, [["a", ["b"]]]);
  assert.equal(store.get("b").mergedInto, undefined);
});
