// OwnLogStore 的契约用例：内存实现（server/own-log-store.contract.test.js）和 MySQL（db/schema.integration.test.js）跑同一组
import test from "node:test";
import assert from "node:assert/strict";

const bucket = (extra = {}) => ({ slotMs: 3600000 * 10, channelId: 1, model: "m", upstreamModel: "", group: "g", semantic: "openai", requests: 2, promptTokens: 10, completionTokens: 5,
  cacheReadTokens: 1, cacheWriteTokens: 0, cacheWrite1hTokens: 0, quota: 100, adminQuota: 30, testQuota: 0, ...extra });

export function defineOwnLogStoreContract({ name, create, cleanup = async () => {}, teardown = null }) {
  test(`own log store contract: ${name}`, { timeout: 60000 }, async (t) => {
    const store = await create();
    const stations = [];
    const id = (suffix) => { const value = `olc-${Date.now() % 1e9}-${suffix}`.slice(0, 32); stations.push(value); return value; };
    t.after(async () => { for (const station of stations) await store.deleteStation(station); await cleanup(stations); await teardown?.(); });

    await t.test("进度：第一次从指定时刻起，已经有的不动", async () => {
      const station = id("a");
      assert.equal(await store.getCursor(station), null);
      assert.deepEqual([(await store.startCursor(station, 1000, 5)).coveredFromMs, (await store.startCursor(station, 9999, 6)).coveredFromMs], [1000, 1000]);
      assert.equal((await store.getCursor(station)).coveredToMs, 1000);
    });

    await t.test("读完一个窗口：进度挪到终点、数加进桶；同一个桶的数加起来；进度不在窗口起点就不写（返回 false）", async () => {
      const station = id("b");
      await store.startCursor(station, 1000);
      assert.equal(await store.applyWindow(station, { fromMs: 1000, toMs: 2000, buckets: [bucket()] }), true);
      assert.equal(await store.applyWindow(station, { fromMs: 1000, toMs: 2000, buckets: [bucket()] }), false, "同一个窗口不能加两次");
      assert.equal((await store.getCursor(station)).coveredToMs, 2000);
      assert.equal(await store.applyWindow(station, { fromMs: 2000, toMs: 3000, buckets: [bucket({ requests: 3, quota: 50 }), bucket({ channelId: 2 })] }), true);
      const listed = await store.listBuckets(station, 0, 3600000 * 100);
      assert.equal(listed.length, 2);
      const one = listed.find((b) => b.channelId === 1);
      assert.deepEqual([one.requests, one.quota, one.adminQuota, one.promptTokens], [5, 150, 60, 20]);
      assert.equal(await store.applyWindow(id("none"), { fromMs: 0, toMs: 1, buckets: [] }), false, "没有进度的站点不写");
    });

    await t.test("别的站点、别的小时的桶分开；按小时范围读；清理只删早的", async () => {
      const a = id("c"), b = id("d");
      await store.startCursor(a, 0); await store.startCursor(b, 0);
      await store.applyWindow(a, { fromMs: 0, toMs: 1, buckets: [bucket({ slotMs: 3600000 }), bucket({ slotMs: 7200000 })] });
      await store.applyWindow(b, { fromMs: 0, toMs: 1, buckets: [bucket({ slotMs: 3600000 })] });
      assert.equal((await store.listBuckets(a, 0, 7200000)).length, 1, "[from, to) 不含终点");
      assert.equal((await store.listBuckets(b, 0, 99999999)).length, 1);
      await store.pruneBuckets(7200000);
      assert.deepEqual([(await store.listBuckets(a, 0, 99999999)).length, (await store.listBuckets(b, 0, 99999999)).length], [1, 0], "清理按小时，不分站点（其余站点的早桶也清）");
    });

    await t.test("写失败整个窗口都不写：进度不动、桶不变", async () => {
      const station = id("e");
      await store.startCursor(station, 0);
      if (store.failNextApply !== undefined) {
        store.failNextApply = true;
        await assert.rejects(store.applyWindow(station, { fromMs: 0, toMs: 5, buckets: [bucket()] }));
        assert.equal((await store.getCursor(station)).coveredToMs, 0);
        assert.equal((await store.listBuckets(station, 0, 99999999)).length, 0);
      }
    });
  });
}
