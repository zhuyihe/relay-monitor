// 错误日志计数那份存取（OwnLogStore 用 ERROR_SPEC，own_error_cursor / own_error_pending / own_error_buckets）的契约用例：
// 内存实现（server/own-log-store.contract.test.js）和 MySQL（db/schema.integration.test.js）跑同一组。进度、暂存、事务和消费日志是同一份代码（own-log-store-contract.js 管）；
// 这里只验错误日志自己的：桶的键和计数加起来、第几次尝试和原因分开存、清理和删站点、和消费日志的三张表互不相干。
import test from "node:test";
import assert from "node:assert/strict";

const bucket = (extra = {}) => ({ slotMs: 3600000 * 10, channelId: 1, model: "m", group: "g", reason: "rate_limit", status: 429, attempt: 1, count: 2, ...extra });

export function defineOwnErrorStoreContract({ name, create, createConsume = null }) {
  test(`own error store contract: ${name}`, { timeout: 60000 }, async (t) => {
    const store = await create();
    const consume = createConsume ? await createConsume() : null;
    const stations = [];
    const id = (suffix) => { const value = `oec-${Date.now() % 1e9}-${suffix}`.slice(0, 32); stations.push(value); return value; };
    t.after(async () => { for (const station of stations) { await store.deleteStation(station); await consume?.deleteStation(station); } });

    await t.test("同一个桶的次数加起来；原因、状态码、第几次尝试、渠道、模型、分组任何一项不同就是另一个桶；进度不在窗口起点不写", async () => {
      const station = id("a");
      await store.startCursor(station, 1000);
      assert.equal(await store.applyWindow(station, { fromMs: 1000, toMs: 2000, buckets: [bucket(), bucket({ reason: "upstream", status: 503 }), bucket({ attempt: 2 })] }), true);
      assert.equal(await store.applyWindow(station, { fromMs: 1000, toMs: 2000, buckets: [bucket()] }), false, "同一个窗口不能加两次");
      assert.equal(await store.applyWindow(station, { fromMs: 2000, toMs: 3000, buckets: [bucket({ count: 3 }), bucket({ channelId: 2 }), bucket({ model: "other" }), bucket({ group: "vip" }), bucket({ status: 0, reason: "other" })] }), true);
      const listed = await store.listBuckets(station, 0, 3600000 * 100);
      assert.equal(listed.length, 7);
      const one = listed.find((b) => b.channelId === 1 && b.model === "m" && b.group === "g" && b.reason === "rate_limit" && b.status === 429 && b.attempt === 1);
      assert.equal(one.count, 5, "2 + 3");
      assert.deepEqual(Object.keys(one).sort(), ["attempt", "channelId", "count", "group", "model", "reason", "slotMs", "status"]);
      assert.deepEqual(listed.map((b) => b.attempt).sort(), [1, 1, 1, 1, 1, 1, 2]);
      assert.equal(await store.applyWindow(id("none"), { fromMs: 0, toMs: 1, buckets: [] }), false, "没有进度的站点不写");
    });

    await t.test("第几次尝试只存 1、2、3；渠道 0（读不到渠道）能存；名字太长截到列宽", async () => {
      const station = id("b");
      await store.startCursor(station, 0);
      await store.applyWindow(station, { fromMs: 0, toMs: 1, buckets: [bucket({ attempt: 9 }), bucket({ attempt: 0, model: "x".repeat(300) }), bucket({ channelId: 0, group: "y".repeat(100) })] });
      const listed = await store.listBuckets(station, 0, 99999999);
      assert.deepEqual(listed.map((b) => b.attempt).sort(), [1, 1, 3]);
      assert.ok(listed.some((b) => b.channelId === 0));
      assert.ok(listed.every((b) => b.model.length <= 128 && b.group.length <= 64));
    });

    await t.test("别的站点、别的小时的桶分开；按小时范围读；清理只删早的", async () => {
      const a = id("c"), b = id("d");
      await store.startCursor(a, 0); await store.startCursor(b, 0);
      await store.applyWindow(a, { fromMs: 0, toMs: 1, buckets: [bucket({ slotMs: 3600000 }), bucket({ slotMs: 7200000 })] });
      await store.applyWindow(b, { fromMs: 0, toMs: 1, buckets: [bucket({ slotMs: 3600000 })] });
      assert.equal((await store.listBuckets(a, 0, 7200000)).length, 1, "[from, to) 不含终点");
      assert.equal((await store.listBuckets(b, 0, 99999999)).length, 1);
      await store.pruneBuckets(7200000);
      assert.deepEqual([(await store.listBuckets(a, 0, 99999999)).length, (await store.listBuckets(b, 0, 99999999)).length], [1, 0], "清理按小时，不分站点");
    });

    if (consume) await t.test("和消费日志的进度、桶互不相干：删错误日志的站点数据不动消费日志的，反过来也一样", async () => {
      const station = id("e");
      await store.startCursor(station, 1000); await consume.startCursor(station, 5000);
      await store.applyWindow(station, { fromMs: 1000, toMs: 2000, buckets: [bucket()] });
      assert.equal((await store.getCursor(station)).coveredToMs, 2000);
      assert.equal((await consume.getCursor(station)).coveredToMs, 5000, "消费日志的进度不动");
      await store.deleteStation(station);
      assert.deepEqual([await store.getCursor(station), (await consume.getCursor(station))?.coveredToMs, (await store.listBuckets(station, 0, 99999999)).length], [null, 5000, 0]);
    });

    await t.test("删站点：进度、暂存、桶都清掉，别的站点不受影响", async () => {
      const a = id("f"), b = id("g");
      await store.startCursor(a, 0); await store.startCursor(b, 0);
      await store.applyWindow(a, { fromMs: 0, toMs: 10, buckets: [bucket()] });
      await store.applyWindow(b, { fromMs: 0, toMs: 10, buckets: [bucket()] });
      await store.savePending(a, { fromMs: 10, toMs: 20, nextPage: 2, total: 5, seenIds: [1], buckets: [], complete: false, classificationKey: "k" });
      await store.deleteStation(a);
      assert.deepEqual([await store.getCursor(a), await store.getPending(a), (await store.listBuckets(a, 0, 99999999)).length], [null, null, 0]);
      assert.equal((await store.listBuckets(b, 0, 99999999)).length, 1);
    });
  });
}
