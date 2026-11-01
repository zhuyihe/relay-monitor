// UserOpsStore 的契约用例：内存实现（server/user-ops-store.contract.test.js）和 MySQL（db/schema.integration.test.js）跑同一组
import test from "node:test";
import assert from "node:assert/strict";

export function defineUserOpsStoreContract({ name, create, cleanup = async () => {}, teardown = null }) {
  test(`user ops store contract: ${name}`, { timeout: 60000 }, async (t) => {
    const store = await create();
    const stations = [];
    const id = (suffix) => { const value = `uoc-${Date.now() % 1e9}-${suffix}`.slice(0, 32); stations.push(value); return value; };
    t.after(async () => { for (const station of stations) await store.deleteStation(station); await cleanup(stations); await teardown?.(); });
    const H = 3600000;

    await t.test("按小时的用量：同一小时再写是覆盖，不是相加；按时间范围读；别的站点分开", async () => {
      const a = id("a"), b = id("b");
      await store.upsertUsageHours(a, [{ username: "u1", hourMs: 10 * H, quota: 100, requests: 2 }, { username: "u1", hourMs: 11 * H, quota: 50, requests: 1 }, { username: "u2", hourMs: 10 * H, quota: 7, requests: 1 }]);
      await store.upsertUsageHours(a, [{ username: "u1", hourMs: 11 * H, quota: 80, requests: 3 }]);
      await store.upsertUsageHours(b, [{ username: "u1", hourMs: 10 * H, quota: 999, requests: 9 }]);
      const all = await store.listUsageHours(a, 0, 100 * H);
      assert.equal(all.length, 3);
      assert.equal(all.find((row) => row.username === "u1" && row.hourMs === 11 * H).quota, 80, "覆盖");
      assert.equal((await store.listUsageHours(a, 11 * H, 12 * H)).length, 1, "[from, to) 半开");
      assert.equal((await store.listUsageHours(b, 0, 100 * H))[0].quota, 999);
      assert.equal(await store.upsertUsageHours(a, []), 0);
    });

    await t.test("余额快照：同一时刻不重复；最新一条；按起点读、每个用户升序", async () => {
      const a = id("c");
      await store.addBalancePoints(a, [{ userId: 1, t: 1000, balanceUsd: 5 }, { userId: 1, t: 2000, balanceUsd: 4 }, { userId: 2, t: 1500, balanceUsd: 9.5 }]);
      await store.addBalancePoints(a, [{ userId: 1, t: 2000, balanceUsd: 99 }, { userId: 1, t: 3000, balanceUsd: 3 }]);
      const last = await store.lastBalancePoints(a);
      assert.deepEqual([last.get(1), last.get(2)], [{ t: 3000, balanceUsd: 3 }, { t: 1500, balanceUsd: 9.5 }]);
      const listed = await store.listBalancePoints(a, 1500);
      assert.deepEqual(listed.get(1), [[2000, 4], [3000, 3]], "已有的同一时刻不被覆盖");
      assert.deepEqual(listed.get(2), [[1500, 9.5]]);
    });

    await t.test("一个用户的用量和快照（抽屉用）：只给这个用户、按时间升序", async () => {
      const a = id("h");
      await store.upsertUsageHours(a, [{ username: "u1", hourMs: 12 * H, quota: 5, requests: 1 }, { username: "u1", hourMs: 10 * H, quota: 7, requests: 1 }, { username: "u2", hourMs: 11 * H, quota: 9, requests: 1 }]);
      assert.deepEqual(await store.listUserUsageHours(a, "u1", 0, 100 * H), [{ hourMs: 10 * H, quota: 7 }, { hourMs: 12 * H, quota: 5 }]);
      assert.deepEqual(await store.listUserUsageHours(a, "u1", 11 * H, 100 * H), [{ hourMs: 12 * H, quota: 5 }]);
      await store.addBalancePoints(a, [{ userId: 1, t: 3000, balanceUsd: 3 }, { userId: 1, t: 1000, balanceUsd: 5 }, { userId: 2, t: 2000, balanceUsd: 9 }]);
      assert.deepEqual(await store.listUserBalancePoints(a, 1, 0), [[1000, 5], [3000, 3]]);
      assert.deepEqual(await store.listUserBalancePoints(a, 1, 2000), [[3000, 3]]);
    });

    await t.test("进度：只更新给到的字段，没有的站点是 null", async () => {
      const a = id("d");
      assert.equal(await store.getProgress(a), null);
      await store.saveProgress(a, { backfillCursorMs: 100, backfillTargetMs: 10, backfillStartedMs: 100 });
      await store.saveProgress(a, { usageSyncedMs: 555 });
      const progress = await store.getProgress(a);
      assert.deepEqual([progress.backfillCursorMs, progress.backfillTargetMs, progress.backfillStartedMs, progress.usageSyncedMs, progress.balanceSyncedMs], [100, 10, 100, 555, null]);
      await store.saveProgress(a, { backfillCursorMs: 50 });
      assert.equal((await store.getProgress(a)).backfillCursorMs, 50);
      assert.equal((await store.getProgress(a)).usageSyncedMs, 555);
    });

    await t.test("提醒状态：存、改、按站点读", async () => {
      const a = id("e"), b = id("f");
      await store.saveAlertState(a, 7, { level: 1, notifiedAt: 1000, lastBalanceUsd: 3.5 });
      await store.saveAlertState(a, 7, { level: 2, notifiedAt: 2000, lastBalanceUsd: 1.5 });
      await store.saveAlertState(a, 8, { level: 0, notifiedAt: null, lastBalanceUsd: null });
      await store.saveAlertState(b, 7, { level: 1, notifiedAt: 1, lastBalanceUsd: 1 });
      const states = await store.getAlertStates(a);
      assert.deepEqual(states.get(7), { level: 2, notifiedAt: 2000, lastBalanceUsd: 1.5 });
      assert.deepEqual(states.get(8), { level: 0, notifiedAt: null, lastBalanceUsd: null });
      assert.equal(states.size, 2);
    });

    await t.test("邮件状态：存、改、按站点读；不存邮箱", async () => {
      const a = id("m"), b = id("n");
      await store.saveMailState(a, 7, { level: 1, retryAt: 5000, tries: 1 });
      await store.saveMailState(a, 7, { level: 1, retryAt: null, tries: 1 });
      await store.saveMailState(a, 8, { level: 2, retryAt: 9000, tries: 2 });
      await store.saveMailState(b, 7, { level: 1, retryAt: 1, tries: 1 });
      const states = await store.getMailStates(a);
      assert.deepEqual(states.get(7), { level: 1, retryAt: null, tries: 1 });
      assert.deepEqual(states.get(8), { level: 2, retryAt: 9000, tries: 2 });
      assert.equal(states.size, 2);
      await store.deleteStation(a);
      assert.equal((await store.getMailStates(a)).size, 0);
      assert.equal((await store.getMailStates(b)).size, 1);
    });

    await t.test("清理：只删早的、按批；删站点全清", async () => {
      const a = id("g");
      await store.upsertUsageHours(a, [{ username: "u", hourMs: 1 * H, quota: 1, requests: 1 }, { username: "u", hourMs: 50 * H, quota: 1, requests: 1 }]);
      await store.addBalancePoints(a, [{ userId: 1, t: 1 * H, balanceUsd: 1 }, { userId: 1, t: 50 * H, balanceUsd: 1 }]);
      assert.deepEqual(await store.prune(a, { usageBeforeMs: 10 * H, balanceBeforeMs: 10 * H }), { usage: 1, balance: 1 });
      assert.equal((await store.listUsageHours(a, 0, 100 * H)).length, 1);
      assert.equal((await store.listBalancePoints(a, 0)).get(1).length, 1);
      await store.saveProgress(a, { usageSyncedMs: 1 });
      await store.saveAlertState(a, 1, { level: 1, notifiedAt: 1, lastBalanceUsd: 1 });
      await store.deleteStation(a);
      assert.deepEqual([(await store.listUsageHours(a, 0, 100 * H)).length, (await store.listBalancePoints(a, 0)).size, await store.getProgress(a), (await store.getAlertStates(a)).size], [0, 0, null, 0]);
    });
  });
}
