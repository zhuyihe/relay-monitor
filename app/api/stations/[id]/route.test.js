import test from "node:test";
import assert from "node:assert/strict";
import { purgeStation } from "./purge.js";

test("彻底删除先清除历史；历史清除失败后保留资源以便重试", async () => {
  let purgeAttempts = 0;
  let removeCalls = 0;
  const station = { id: "station-1" };
  const rt = {
    store: {
      get: () => station,
      remove: async () => { removeCalls += 1; return true; },
    },
    history: {
      purge: async () => {
        purgeAttempts += 1;
        if (purgeAttempts === 1) throw new Error("history database unavailable");
      },
    },
  };

  await assert.rejects(purgeStation(rt, station.id), /history database unavailable/);
  assert.equal(removeCalls, 0);

  assert.deepEqual(await purgeStation(rt, station.id), { ok: true, alreadyPurged: false });
  assert.equal(removeCalls, 1);
});
