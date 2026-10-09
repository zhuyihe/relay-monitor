import test from "node:test";
import assert from "node:assert/strict";
import { ChannelOnboardingRepository } from "./channel-onboarding-repository.js";
import { Store } from "../db/store.js";

function memoryPool() {
  const state = { links: new Map(), meta: new Map([["settings", { refreshIntervalSec: 90 }]]) };
  const calls = [];
  const key = (values) => JSON.stringify(values.slice(0, 3));
  async function query(sql, values = [], links = state.links) {
    calls.push({ sql, values });
    if (sql.startsWith("INSERT INTO channel_monitor_links")) {
      const previous = links.get(key(values));
      links.set(key(values), {
        own_station_id: values[0], channel_id: values[1], station_id: values[2], channel_revision: values[3],
        confirmed_at_ms: previous?.channel_revision === values[3] ? previous.confirmed_at_ms : values[4],
      });
    } else if (sql.startsWith("SELECT * FROM channel_monitor_links")) {
      if (sql.includes("channel_id = ?")) return [[links.get(key(values))].filter(Boolean)];
      let rows = [...links.values()];
      let index = 0;
      if (sql.includes("own_station_id = ?")) rows = rows.filter((row) => row.own_station_id === values[index++]);
      if (sql.includes("station_id = ?") && !sql.includes("own_station_id = ?")) {
        rows = rows.filter((row) => row.station_id === values[index]);
      } else if (sql.includes(" AND station_id = ?")) rows = rows.filter((row) => row.station_id === values[index]);
      return [rows];
    } else if (sql.startsWith("SELECT v FROM meta")) {
      return [state.meta.has(values[0]) ? [{ v: JSON.stringify(state.meta.get(values[0])) }] : []];
    } else if (sql.startsWith("INSERT INTO meta")) {
      const entries = sql.includes("VALUES ?") ? values[0] : [values];
      for (const [name, value] of entries) state.meta.set(name, JSON.parse(value));
    }
    return [[]];
  }
  const pool = {
    state, calls,
    query,
    failCommit: false,
    commitGate: null,
    async getConnection() {
      let draft;
      return {
        async beginTransaction() { draft = structuredClone(state.links); },
        query: (sql, values) => query(sql, values, draft),
        async commit() {
          if (pool.commitGate) await pool.commitGate();
          if (pool.failCommit) throw new Error("simulated commit failure");
          state.links = draft;
        },
        async rollback() {},
        release() {},
      };
    },
  };
  return pool;
}

const link = { ownStationId: "own", channelId: 7, stationId: "supplier", channelRevision: "rev1", confirmedAt: 1000 };

test("关联按来源与资源去重，重试及重启保留确认时间", async () => {
  const pool = memoryPool();
  const repository = new ChannelOnboardingRepository(pool);
  assert.deepEqual(await repository.saveLinks([link, { ...link, apiKey: "must-not-copy" }]), [link]);
  assert.deepEqual(await repository.saveLinks([{ ...link, confirmedAt: 2000 }]), [link]);
  const restarted = new ChannelOnboardingRepository(pool);
  assert.deepEqual(await restarted.listLinks({ ownStationId: "own" }), [link]);
  const second = { ...link, stationId: "key-monitor", confirmedAt: 1500 };
  await restarted.saveLinks([second]);
  assert.equal((await restarted.listLinks()).length, 2);
  assert.deepEqual(await restarted.listLinks({ stationId: "key-monitor" }), [second]);
  const changed = { ...link, channelRevision: "rev2", confirmedAt: 3000 };
  assert.deepEqual(await restarted.saveLinks([changed]), [changed]);
  assert.equal([...pool.state.links.values()].some((row) => "apiKey" in row), false);
});

test("关联只在整批事务提交后可读，失败回滚不产生半成品", async () => {
  const pool = memoryPool();
  const repository = new ChannelOnboardingRepository(pool);
  await repository.saveLinks([link]);
  let entered, release;
  const reached = new Promise((resolve) => { entered = resolve; });
  pool.commitGate = async () => { entered(); await new Promise((resolve) => { release = resolve; }); };
  const second = { ...link, channelId: 8 };
  const pending = repository.saveLinks([{ ...link, channelRevision: "rev2" }, second]);
  await reached;
  assert.deepEqual(await repository.listLinks(), [link]);
  pool.failCommit = true;
  release();
  await assert.rejects(pending, /commit failure/);
  assert.deepEqual(await new ChannelOnboardingRepository(pool).listLinks(), [link]);
  pool.commitGate = null;
  pool.failCommit = false;
  await repository.saveLinks([second]);
  assert.equal((await repository.listLinks()).length, 2);
});

test("目录使用独立 meta 键，Store 写透与重启读取互不覆盖", async () => {
  const pool = memoryPool();
  const repository = new ChannelOnboardingRepository(pool);
  assert.equal(await repository.getCatalogue(), null);
  const catalogue = { ownStationId: "own", sourceVersion: "config-1", syncedAt: 2000, channels: [{ id: 7 }] };
  await repository.saveCatalogue(catalogue);
  assert.deepEqual(pool.state.meta.get("settings"), { refreshIntervalSec: 90 });
  const store = new Store(pool);
  await store.updateSettings({ refreshIntervalSec: 60 });
  assert.deepEqual(await new ChannelOnboardingRepository(pool).getCatalogue(), catalogue);
  assert.equal(pool.state.meta.get("settings").refreshIntervalSec, 60);
});

test("目录保存失败保留最后成功副本且向调用方报错", async (t) => {
  const pool = memoryPool();
  const repository = new ChannelOnboardingRepository(pool);
  const previous = { ownStationId: "own", sourceVersion: "config-1", channels: [{ id: 7 }] };
  await repository.saveCatalogue(previous);
  const query = pool.query;
  t.mock.method(pool, "query", async (sql, values) => {
    if (sql.startsWith("INSERT INTO meta")) throw new Error("catalogue offline");
    return query(sql, values);
  });
  await assert.rejects(repository.saveCatalogue({ ...previous, channels: [] }), /catalogue offline/);
  assert.deepEqual(await new ChannelOnboardingRepository(pool).getCatalogue(), previous);
});

test("关联校验在写入前完成，空批次不改变记录", async () => {
  const pool = memoryPool();
  const repository = new ChannelOnboardingRepository(pool);
  await assert.rejects(repository.saveLinks([link, { ...link, channelId: 0 }]), /关联无效/);
  assert.equal((await repository.listLinks()).length, 0);
  assert.deepEqual(await repository.saveLinks([]), []);
});
