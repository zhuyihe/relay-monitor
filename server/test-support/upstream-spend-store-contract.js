// UpstreamSpendStore 的契约用例：内存实现（server/upstream-spend-store.contract.test.js）和 MySQL（db/schema.integration.test.js）跑同一组
import test from "node:test";
import assert from "node:assert/strict";

export function defineUpstreamSpendStoreContract({ name, create, cleanup = async () => {}, teardown = null }) {
  test(`upstream spend store contract: ${name}`, { timeout: 60000 }, async (t) => {
    const store = await create();
    const stations = [];
    const id = (suffix) => { const value = `usc-${Date.now() % 1e9}-${suffix}`.slice(0, 32); stations.push(value); return value; };
    t.after(async () => { for (const station of stations) await store.deleteStation(station); await cleanup(stations); await teardown?.(); });

    await t.test("每天的花费：同一天再写是覆盖；按日期范围（含两头）读、升序；别的站点分开；负数当 0", async () => {
      const a = id("a"), b = id("b");
      await store.putDays(a, [{ day: "2026-10-03", usd: 3.5 }, { day: "2026-10-01", usd: 1 }, { day: "2026-10-02", usd: 0 }]);
      await store.putDays(a, [{ day: "2026-10-02", usd: 2.25 }, { day: "2026-10-04", usd: -1 }]);
      await store.putDays(b, [{ day: "2026-10-02", usd: 999 }]);
      assert.deepEqual((await store.listDays([a], "2026-10-01", "2026-10-04")).map((row) => [row.day, row.usd]), [["2026-10-01", 1], ["2026-10-02", 2.25], ["2026-10-03", 3.5], ["2026-10-04", 0]]);
      assert.deepEqual((await store.listDays([a], "2026-10-02", "2026-10-03")).map((row) => row.day), ["2026-10-02", "2026-10-03"], "含两头");
      assert.deepEqual((await store.listDays([a, b], "2026-10-02", "2026-10-02")).map((row) => [row.stationId === a ? "a" : "b", row.usd]), [["a", 2.25], ["b", 999]]);
      assert.deepEqual(await store.listDays([], "2026-10-01", "2026-10-04"), []);
      assert.equal(await store.putDays(a, []), 0);
    });

    await t.test("读取状态：一个站点一行，再存是覆盖；读到哪天、对方给不给读", async () => {
      const a = id("c"), b = id("d");
      await store.saveState(a, { status: "ok", source: "dashboard", readThrough: "2026-10-05", checkedAt: 1000 });
      await store.saveState(b, { status: "denied", deniedCode: "UPSTREAM_FEATURE_UNSUPPORTED", checkedAt: 2000 });
      await store.saveState(a, { status: "ok", source: "stat", readThrough: "2026-10-06", checkedAt: 3000 });
      const states = await store.listStates();
      assert.deepEqual(states.get(a), { stationId: a, status: "ok", source: "stat", readThrough: "2026-10-06", deniedCode: null, checkedAt: 3000 });
      assert.deepEqual(states.get(b), { stationId: b, status: "denied", source: null, readThrough: null, deniedCode: "UPSTREAM_FEATURE_UNSUPPORTED", checkedAt: 2000 });
    });

    await t.test("留 40 天：prune 删掉指定日期（不含）以前的；站点删除时天数和状态一起删", async () => {
      const a = id("e"), b = id("f");
      await store.putDays(a, [{ day: "2026-09-01", usd: 1 }, { day: "2026-09-02", usd: 1 }, { day: "2026-09-03", usd: 1 }]);
      await store.putDays(b, [{ day: "2026-09-01", usd: 1 }]);
      await store.saveState(a, { status: "ok", source: "dashboard", readThrough: "2026-09-03", checkedAt: 1 });
      assert.ok((await store.prune("2026-09-03")) >= 3, "9 月 1 日、2 日（两个站点共 3 行）被删");
      assert.deepEqual((await store.listDays([a, b], "2026-09-01", "2026-09-30")).map((row) => row.day), ["2026-09-03"]);
      await store.deleteStation(a);
      assert.deepEqual(await store.listDays([a], "2026-09-01", "2026-09-30"), []);
      assert.equal((await store.listStates()).has(a), false);
    });
  });
}
