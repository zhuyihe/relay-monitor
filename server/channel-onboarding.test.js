import test from "node:test";
import assert from "node:assert/strict";
import { connectNewApiUpstream } from "./channel-onboarding.js";

function fixture(stations = []) {
  let writes = 0;
  let failNext = false;
  const rt = { store: {
    list: () => stations,
    async add(input) {
      writes += 1;
      await Promise.resolve();
      if (failNext) { failNext = false; throw new Error("保存失败，请稍后重试"); }
      const station = { ...input, id: `station-${writes}` };
      stations.push(station);
      return station;
    },
  } };
  return { rt, stations, writes: () => writes, fail: () => { failNext = true; } };
}
const input = { name: "Supplier", baseUrl: "https://up.example/", accessToken: "secret-pat" };
const metadata = async () => ({ userId: "7", tokens: [], groups: {} });

test("concurrent connections and a response retry share one persisted monitor and never return credentials", async () => {
  const state = fixture();
  const results = await Promise.all([connectNewApiUpstream(state.rt, input, metadata), connectNewApiUpstream(state.rt, input, metadata)]);
  results.push(await connectNewApiUpstream(state.rt, input, metadata));
  assert.equal(state.writes(), 1);
  assert.equal(state.stations[0].userId, "7");
  assert.deepEqual(results.map((result) => result.station.id), ["station-1", "station-1", "station-1"]);
  assert.deepEqual(results.map((result) => result.created), [true, false, false]);
  assert.equal(JSON.stringify(results).includes("secret-pat"), false);
});

test("different users at the same URL remain distinct and own/archived stations are not reused", async () => {
  const state = fixture([
    { id: "own", type: "newapi", baseUrl: input.baseUrl, userId: "7", isOwn: true },
    { id: "archived", type: "newapi", baseUrl: input.baseUrl, userId: "7", archivedAt: "2026-10-09" },
    { id: "another", type: "newapi", baseUrl: input.baseUrl, userId: "8" },
  ]);
  const result = await connectNewApiUpstream(state.rt, input, metadata);
  assert.equal(result.created, true);
  assert.equal(state.writes(), 1);
  assert.equal(state.stations.length, 4);
});

test("legacy account with identical PAT can be reused without a stored user ID", async () => {
  const state = fixture([{ id: "legacy", type: "newapi", baseUrl: input.baseUrl, accessToken: "Bearer secret-pat" }]);
  assert.equal((await connectNewApiUpstream(state.rt, input, metadata)).station.id, "legacy");
  assert.equal(state.writes(), 0);
});

test("failed provider verification is redacted and cannot persist a monitor", async () => {
  const state = fixture();
  await assert.rejects(connectNewApiUpstream(state.rt, input, async () => { throw new Error("token secret-pat denied"); }), (err) => !err.message.includes("secret-pat"));
  await assert.rejects(connectNewApiUpstream(state.rt, input, async () => ({})), /无法确认上游账号身份/);
  assert.equal(state.writes(), 0);
});

test("a rejected account write does not appear successful or poison the next connection", async () => {
  const state = fixture();
  state.fail();
  await assert.rejects(connectNewApiUpstream(state.rt, input, metadata), /保存失败/);
  assert.equal(state.stations.length, 0);
  const result = await connectNewApiUpstream(state.rt, input, metadata);
  assert.equal(result.created, true);
  assert.equal(state.stations.length, 1);
});
