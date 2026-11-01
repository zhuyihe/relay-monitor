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

    await t.test("skipCursor：挪进度不删桶，记下跳过的缺口（总指挥 10-26 定第三轮）", async () => {
      const station = id("f");
      await store.startCursor(station, 1000);
      await store.applyWindow(station, { fromMs: 1000, toMs: 2000, buckets: [bucket()] });
      const after = await store.skipCursor(station, 9000, 99);
      assert.deepEqual([after.coveredToMs, after.disabledFromMs, after.disabledToMs, after.updatedAtMs], [9000, 2000, 9000, 99]);
      assert.equal((await store.listBuckets(station, 0, 99999999)).length, 1, "桶还在，不清掉");
    });

    await t.test("skipCursor：第二次关→开，两段缺口并成一段记（偏保守，审核 R2 #125 第三轮 中-E）", async () => {
      const station = id("g");
      await store.startCursor(station, 1000);
      await store.skipCursor(station, 9000, 99); // 第一次关→开，缺口 [1000, 9000)
      await store.applyWindow(station, { fromMs: 9000, toMs: 9500, buckets: [bucket()] }); // 中间这段「开着」读到了一点
      const after = await store.skipCursor(station, 20000, 199); // 第二次关→开，缺口原本是 [9500, 20000)
      assert.deepEqual([after.disabledFromMs, after.disabledToMs], [1000, 20000], "并成一段，起点还是第一次的起点");
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

    await t.test("暂存窗口跨实例读取；返回值不共享引用；旧 revision 不能覆盖新页", async () => {
      const station = id("pending");
      const pending = { fromMs: 1000, toMs: 6000, nextPage: 2, total: 2176, seenIds: [1, 2], buckets: [bucket()], complete: false, classificationKey: "test-classification" };
      assert.equal(await store.getPending(station), null);
      assert.equal(await store.savePending(station, pending), false, "没有 cursor 不写暂存");
      await store.startCursor(station, 1000);
      const saved = await store.savePending(station, pending);
      assert.ok(saved.revision);
      const savedRevision = saved.revision;
      saved.seenIds.push(999); pending.buckets[0].quota = 999;
      const loaded = await store.getPending(station);
      assert.deepEqual(loaded.seenIds, [1, 2]);
      assert.equal(loaded.buckets[0].quota, 100);
      loaded.seenIds.push(998);
      assert.deepEqual((await store.getPending(station)).seenIds, [1, 2]);
      assert.equal(await store.savePending(station, { ...loaded, nextPage: 3 }), false, "已有暂存不能当作首次保存");
      const next = await store.savePending(station, { ...loaded, nextPage: 3 }, { expectedRevision: savedRevision });
      assert.ok(next.revision && next.revision !== savedRevision);
      assert.equal(await store.savePending(station, { ...loaded, nextPage: 4 }, { expectedRevision: savedRevision }), false, "旧 worker 不能覆盖新进度");
      assert.equal(await store.savePending(station, { ...next, fromMs: 2000 }, { expectedRevision: next.revision }), false, "cursor 必须正好停在窗口起点");
      assert.equal(await store.savePending(station, { ...next, toMs: 9000 }, { expectedRevision: next.revision }), false, "续读期间不能更换窗口终点");
      assert.equal((await store.getCursor(station)).coveredToMs, 1000, "暂存不是已完成覆盖");
      assert.equal((await store.listBuckets(station, 0, 99999999)).length, 0, "半个窗口不能影响报表");
    });

    await t.test("完成窗口必须核对 revision、边界及 complete；提交后暂存和桶/进度原子切换", async () => {
      const station = id("commit");
      await store.startCursor(station, 1000);
      const initial = await store.savePending(station, { fromMs: 1000, toMs: 6000, nextPage: 2, total: 2, seenIds: [1], buckets: [bucket()], complete: false });
      const apply = (extra = {}) => store.applyWindow(station, { fromMs: 1000, toMs: 6000, buckets: [bucket()], pendingRevision: initial.revision, ...extra });
      assert.equal(await apply(), false, "未完成不能推进覆盖");
      const done = await store.savePending(station, { ...initial, nextPage: 3, seenIds: [1, 2], complete: true }, { expectedRevision: initial.revision });
      assert.equal(await apply(), false, "旧 revision 不能提交");
      assert.equal(await apply({ pendingRevision: done.revision, toMs: 7000 }), false, "终点必须一致");
      if (store.failNextApply !== undefined) {
        store.failNextApply = true;
        await assert.rejects(apply({ pendingRevision: done.revision }));
        assert.equal((await store.getPending(station)).revision, done.revision, "失败时保留已经读完的暂存，恢复后不用重读");
        assert.equal((await store.getCursor(station)).coveredToMs, 1000);
        assert.equal((await store.listBuckets(station, 0, 99999999)).length, 0);
      }
      assert.equal(await apply({ pendingRevision: done.revision }), true);
      assert.equal(await store.getPending(station), null);
      assert.equal((await store.getCursor(station)).coveredToMs, 6000);
      assert.equal((await store.listBuckets(station, 0, 99999999))[0].quota, 100);
      assert.equal(await apply({ pendingRevision: done.revision }), false, "已提交窗口不能重复计数");
    });

    await t.test("跳过、普通窗口提交和删除都清暂存；旧 worker 不能把它写回来", async () => {
      for (const operation of ["skip", "apply", "delete"]) {
        const station = id(operation);
        await store.startCursor(station, 1000);
        const pending = await store.savePending(station, { fromMs: 1000, toMs: 6000, nextPage: 2, seenIds: [1], buckets: [], complete: false });
        if (operation === "skip") await store.skipCursor(station, 9000);
        else if (operation === "apply") await store.applyWindow(station, { fromMs: 1000, toMs: 6000, buckets: [] });
        else await store.deleteStation(station);
        assert.equal(await store.getPending(station), null);
        assert.equal(await store.savePending(station, { ...pending, nextPage: 3 }, { expectedRevision: pending.revision }), false);
        if (operation === "delete") {
          await store.startCursor(station, 1000);
          const replacement = await store.savePending(station, { ...pending, nextPage: 2 });
          assert.notEqual(replacement.revision, pending.revision, "重建同一站点同一窗口也是新 revision");
          assert.equal(await store.savePending(station, { ...pending, nextPage: 4 }, { expectedRevision: pending.revision }), false, "防 ABA");
        }
      }
    });

    await t.test("并发保存同一个 revision 只允许一个成功；并发提交只计一次", async () => {
      const station = id("race");
      await store.startCursor(station, 1000);
      const initial = await store.savePending(station, { fromMs: 1000, toMs: 6000, nextPage: 2, seenIds: [1], buckets: [bucket()], complete: false });
      const candidates = await Promise.all([3, 4].map((nextPage) => store.savePending(station, { ...initial, nextPage, complete: true }, { expectedRevision: initial.revision })));
      assert.equal(candidates.filter(Boolean).length, 1);
      const done = candidates.find(Boolean);
      const results = await Promise.all([1, 2].map(() => store.applyWindow(station, { fromMs: 1000, toMs: 6000, buckets: done.buckets, pendingRevision: done.revision })));
      assert.deepEqual(results.sort(), [false, true]);
      assert.equal((await store.listBuckets(station, 0, 99999999))[0].quota, 100);
    });

    await t.test("废弃暂存只丢未提交内容；保留 cursor 和桶，旧 revision 不能删掉新暂存", async () => {
      const station = id("discard");
      await store.startCursor(station, 1000);
      await store.applyWindow(station, { fromMs: 1000, toMs: 2000, buckets: [bucket()] });
      const initial = await store.savePending(station, { fromMs: 2000, toMs: 7000, nextPage: 2, seenIds: [1], buckets: [bucket()], complete: false });
      const beforeCursor = await store.getCursor(station), beforeBuckets = await store.listBuckets(station, 0, 99999999);
      assert.equal(await store.discardPending(station, { fromMs: 1000, expectedRevision: initial.revision }), false, "覆盖起点必须匹配");
      const next = await store.savePending(station, { ...initial, nextPage: 3 }, { expectedRevision: initial.revision });
      assert.equal(await store.discardPending(station, { fromMs: 2000, expectedRevision: initial.revision }), false, "旧 revision 不能删除新一页");
      assert.equal((await store.getPending(station)).revision, next.revision);
      assert.equal(await store.discardPending(station, { fromMs: 2000, expectedRevision: next.revision }), true);
      assert.equal(await store.getPending(station), null);
      assert.deepEqual(await store.getCursor(station), beforeCursor, "废弃后仍从原覆盖起点重读");
      assert.deepEqual(await store.listBuckets(station, 0, 99999999), beforeBuckets, "已经完成的桶不变");
      assert.equal(await store.discardPending(station, { fromMs: 2000, expectedRevision: next.revision }), false, "暂存已经清掉不算成功");
      const replacement = await store.savePending(station, { ...initial, nextPage: 2 });
      assert.ok(replacement);
      assert.equal(await store.discardPending(station, { fromMs: 2000, expectedRevision: next.revision }), false, "重读后旧 revision 仍不能误删");
      assert.equal((await store.getPending(station)).revision, replacement.revision);
      assert.equal(await store.discardPending(id("missing"), { fromMs: 2000, expectedRevision: replacement.revision }), false);
    });

    await t.test("旧版本推进 cursor 留下 stale 暂存：按已观测覆盖位置 CAS 清理，绝不回退覆盖或改桶", async () => {
      const station = id("stale");
      await store.startCursor(station, 1000);
      await store.applyWindow(station, { fromMs: 1000, toMs: 2000, buckets: [bucket()] });
      const pending = await store.savePending(station, { fromMs: 2000, toMs: 7000, nextPage: 2, seenIds: [1], buckets: [bucket()], complete: false });
      // 模拟回滚后的旧版本：它不知道暂存表，只推进已有 cursor。
      if (store.pool) await store.pool.query("UPDATE own_log_cursor SET covered_to_ms = ?, updated_at_ms = ? WHERE station_id = ?", [7000, 99, station]);
      else Object.assign(store.cursors.get(station), { coveredToMs: 7000, updatedAtMs: 99 });
      const beforeCursor = await store.getCursor(station), beforeBuckets = await store.listBuckets(station, 0, 99999999);
      assert.equal(await store.discardPending(station, { fromMs: pending.fromMs, expectedRevision: pending.revision }), false, "默认仍要求 cursor 在原窗口起点");
      assert.equal(await store.discardPending(station, { fromMs: pending.fromMs, expectedRevision: pending.revision, expectedCoveredToMs: 6000 }), false, "旧观测位置不能清理");
      assert.equal(await store.discardPending(station, { fromMs: 3000, expectedRevision: pending.revision, expectedCoveredToMs: 7000 }), false, "仍须核对被删除暂存的起点");
      assert.equal(await store.discardPending(station, { fromMs: pending.fromMs, expectedRevision: "stale-revision", expectedCoveredToMs: 7000 }), false, "仍须核对 revision");
      assert.equal((await store.getPending(station)).revision, pending.revision);
      assert.equal(await store.discardPending(station, { fromMs: pending.fromMs, expectedRevision: pending.revision, expectedCoveredToMs: 7000 }), true);
      assert.equal(await store.getPending(station), null);
      assert.deepEqual(await store.getCursor(station), beforeCursor);
      assert.deepEqual(await store.listBuckets(station, 0, 99999999), beforeBuckets);
    });
  });
}
