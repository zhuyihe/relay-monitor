import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { INGEST, createOwnLogIngest } from "./own-log-ingest.js";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";
import { ownUsersKey } from "./own-helpers.js";
import { resetOwnRequestBudget, noteOwnRequest, OWN_RATE_LIMIT, INGEST_RESERVE } from "../lib/own-request-budget.js";

const NOW = Date.parse("2026-11-01T08:00:00Z");
const FROM = NOW - 2 * 3600000;
const TO = FROM + 5000;
const USERS = [{ id: 1, username: "root", role: 100 }, { id: 2, username: "alice", role: 1 }];
const rows = (count) => Array.from({ length: count }, (_, i) => ({
  id: i + 1, type: 2, created_at: FROM / 1000 + i % 5,
  channel: 1, model_name: "m", group: "g", username: i % 10 ? "alice" : "root",
  token_name: "not-to-be-persisted", token_id: 7, quota: 10,
  prompt_tokens: 100, completion_tokens: 10,
  other: JSON.stringify({ cache_tokens: 20, should_not_be_persisted: "private" }),
}));

// All requests use the real provider parser. Controls affect only log responses,
// while the admin directory is cached as it is during a normal polling round.
async function site(t, logs, controls = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://test");
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/user/") return send(200, { success: true, data: { items: USERS, total: USERS.length } });
    if (url.pathname !== "/api/log/") return send(404, { success: false });
    const query = {
      page: Number(url.searchParams.get("p")),
      start: Number(url.searchParams.get("start_timestamp")),
      end: Number(url.searchParams.get("end_timestamp")),
    };
    requests.push(query);
    controls.onRequest?.(query);
    const failure = controls.fail?.(query);
    if (failure) return send(typeof failure === "number" ? failure : 429, { success: false, message: "retry later" });
    const matched = logs.filter((row) => row.created_at >= query.start && row.created_at <= query.end)
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    const data = {
      ...(controls.noTotal ? {} : { total: matched.length }),
      items: matched.slice((query.page - 1) * INGEST.PAGE_SIZE, query.page * INGEST.PAGE_SIZE),
    };
    controls.mutate?.(data, query, matched);
    return send(200, { success: true, data });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const own = { id: "own", type: "newapi", isOwn: true,
    baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "fake-admin-token", resoldAdminKeys: [] };
  const rt = { _ownUsersCache: { key: ownUsersKey(own), startedAt: NOW - 1000, list: USERS, unknown: new Map() } };
  return { own, rt, requests };
}

const fixedRequests = (requests) => requests.filter((r) => r.start === FROM / 1000 && r.end === TO / 1000 - 1);
const totals = async (store) => (await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER))
  .reduce((sum, b) => ({ requests: sum.requests + b.requests, quota: sum.quota + b.quota,
    adminQuota: sum.adminQuota + b.adminQuota, promptTokens: sum.promptTokens + b.promptTokens,
    cacheReadTokens: sum.cacheReadTokens + b.cacheReadTokens }),
  { requests: 0, quota: 0, adminQuota: 0, promptTokens: 0, cacheReadTokens: 0 });
const worker = (rt, store, now = () => NOW) => {
  const ingest = createOwnLogIngest(rt, { store, now });
  ingest.windowSizes.set("own", INGEST.WINDOW_MIN_MS);
  return ingest;
};

for (const noTotal of [false, true]) {
  test(`dense five-second window survives restart and resumes after the 15-page budget${noTotal ? " without total" : ""}`, async (t) => {
    resetOwnRequestBudget();
    const logs = rows(2176);
    const { own, rt, requests } = await site(t, logs, { noTotal });
    const store = new MemoryOwnLogStore();
    await store.startCursor("own", FROM);
    const first = await worker(rt, store).ingestOnce(own);
    assert.equal(first.pages, INGEST.MAX_PAGES_BEHIND);
    assert.equal(first.windows, 0);
    assert.equal((await store.getCursor("own")).coveredToMs, FROM);
    assert.equal((await totals(store)).requests, 0, "incomplete window stays outside report buckets");
    const pending = await store.getPending("own");
    assert.equal(pending.nextPage, 16);
    assert.equal(pending.seenIds.length, 1500);
    assert.equal(pending.complete, false);
    assert.ok(!JSON.stringify(pending).includes("not-to-be-persisted"));
    assert.ok(!JSON.stringify(pending).includes("private"));

    // Discard all worker state, retaining only the durable store.
    resetOwnRequestBudget();
    const beforeResume = requests.length;
    const second = await worker(rt, store).ingestOnce(own);
    assert.ok(!second.error, second.error);
    assert.ok(second.pages <= INGEST.MAX_PAGES_BEHIND);
    assert.equal(requests[beforeResume].page, 16, "restart reads the next durable page");
    assert.ok((await store.getCursor("own")).coveredToMs >= TO);
    assert.deepEqual(fixedRequests(requests).map((r) => r.page), Array.from({ length: 22 }, (_, i) => i + 1));
    assert.deepEqual(await totals(store), {
      requests: 2176, quota: 21760, adminQuota: 2180, promptTokens: 217600, cacheReadTokens: 43520,
    });
    resetOwnRequestBudget();
    await worker(rt, store).ingestOnce(own);
    assert.equal((await totals(store)).requests, logs.length, "later rounds cannot add a completed window twice");
  });
}

test("round deadline preserves two finished pages and resumes page three", async (t) => {
  resetOwnRequestBudget();
  let now = NOW;
  let clockPerRequest = 11000;
  const { own, rt, requests } = await site(t, rows(250), { onRequest: () => { now += clockPerRequest; } });
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", FROM);
  const first = await worker(rt, store, () => now).ingestOnce(own);
  assert.equal(first.pages, 2);
  assert.equal(first.windows, 0);
  assert.equal((await store.getPending("own")).nextPage, 3);
  assert.equal((await store.getCursor("own")).coveredToMs, FROM);
  assert.equal((await totals(store)).requests, 0);
  clockPerRequest = 0;
  resetOwnRequestBudget();
  const beforeResume = requests.length;
  await worker(rt, store, () => now).ingestOnce(own);
  assert.equal(requests[beforeResume].page, 3);
  assert.equal((await totals(store)).requests, 250);
});

test("HTTP failure retries only the failed page after restart", async (t) => {
  resetOwnRequestBudget();
  let fail = true;
  const { own, rt, requests } = await site(t, rows(250), { fail: (q) => fail && q.page === 3 });
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", FROM);
  const result = await worker(rt, store).ingestOnce(own);
  assert.ok(result.error);
  assert.equal((await store.getPending("own")).nextPage, 3);
  assert.equal((await store.getCursor("own")).coveredToMs, FROM);
  assert.equal((await totals(store)).requests, 0);
  fail = false;
  resetOwnRequestBudget();
  const beforeResume = requests.length;
  await worker(rt, store).ingestOnce(own);
  assert.equal(requests[beforeResume].page, 3);
  assert.deepEqual(fixedRequests(requests).map((r) => r.page), [1, 2, 3, 3]);
  assert.equal((await totals(store)).requests, 250);
});

test("completed staging survives transaction failure and commits without re-reading logs", async (t) => {
  resetOwnRequestBudget();
  const { own, rt, requests } = await site(t, rows(250));
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", FROM);
  store.failNextApply = true;
  let failed;
  try { failed = await worker(rt, store).ingestOnce(own); }
  catch (error) { failed = { error }; }
  assert.ok(failed.error);
  assert.equal((await store.getCursor("own")).coveredToMs, FROM);
  assert.equal((await totals(store)).requests, 0);
  assert.equal((await store.getPending("own")).complete, true);
  const pagesBefore = fixedRequests(requests).length;
  resetOwnRequestBudget();
  await worker(rt, store).ingestOnce(own);
  assert.equal(fixedRequests(requests).length, pagesBefore, "ready-to-commit staging needs no upstream replay");
  assert.equal((await totals(store)).requests, 250);
});

for (const kind of ["duplicate-page", "changed-total", "invalid-id", "out-of-window"]) {
  test(`unsafe pagination (${kind}) cannot move coverage or publish partial buckets`, async (t) => {
    resetOwnRequestBudget();
    const { own, rt } = await site(t, rows(250), {
      mutate: (data, query, matched) => {
        if (query.page !== 2) return;
        if (kind === "duplicate-page") data.items = matched.slice(0, INGEST.PAGE_SIZE);
        if (kind === "changed-total") data.total += 1;
        if (kind === "invalid-id") data.items[0] = { ...data.items[0], id: "bad-id" };
        if (kind === "out-of-window") data.items[0] = { ...data.items[0], created_at: TO / 1000 };
      },
    });
    const store = new MemoryOwnLogStore();
    await store.startCursor("own", FROM);
    const result = await worker(rt, store).ingestOnce(own);
    assert.ok(result.error, "inconsistent response must stop this window");
    assert.equal((await store.getCursor("own")).coveredToMs, FROM);
    assert.equal((await totals(store)).requests, 0);
    if (kind === "changed-total") assert.equal(await store.getPending("own"), null, "changed source discards unpublished staging");
    else assert.equal((await store.getPending("own")).nextPage, 2, "unsafe page never becomes durable progress");
  });
}


test("changed source total discards only staging and restarts the same window from page one", async (t) => {
  resetOwnRequestBudget();
  const logs = rows(2176);
  const { own, rt, requests } = await site(t, logs);
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", FROM);
  await worker(rt, store).ingestOnce(own);
  assert.equal((await store.getPending("own")).nextPage, 16);
  logs.push({ ...logs[0], id: 2177 });
  resetOwnRequestBudget();
  const changed = await worker(rt, store).ingestOnce(own);
  assert.ok(changed.error);
  assert.equal(await store.getPending("own"), null);
  assert.equal((await store.getCursor("own")).coveredToMs, FROM);
  assert.equal((await totals(store)).requests, 0);
  resetOwnRequestBudget();
  const beforeRestart = requests.length;
  await worker(rt, store).ingestOnce(own);
  assert.equal(requests[beforeRestart].page, 1, "changed snapshot is read anew, not resumed halfway");
  resetOwnRequestBudget();
  await worker(rt, store).ingestOnce(own);
  assert.equal((await totals(store)).requests, 2177);
  assert.equal((await totals(store)).quota, 21770);
});

test("changed administrator classification replays unpublished staging with one consistent policy", async (t) => {
  resetOwnRequestBudget();
  const logs = rows(2176);
  const { own, rt, requests } = await site(t, logs);
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", FROM);
  await worker(rt, store).ingestOnce(own);
  assert.equal((await store.getPending("own")).nextPage, 16);
  // Directory policy changes between rounds: alice has become an administrator.
  rt._ownUsersCache.list = USERS.map((user) => user.username === "alice" ? { ...user, role: 10 } : user);
  resetOwnRequestBudget();
  const beforeChange = requests.length;
  const changed = await worker(rt, store).ingestOnce(own);
  assert.ok(changed.error);
  assert.equal(requests.length, beforeChange, "classification mismatch requires no log request");
  assert.equal(await store.getPending("own"), null);
  assert.equal((await store.getCursor("own")).coveredToMs, FROM);
  assert.equal((await totals(store)).requests, 0);
  resetOwnRequestBudget();
  const beforeReplay = requests.length;
  await worker(rt, store).ingestOnce(own);
  assert.equal(requests[beforeReplay].page, 1);
  resetOwnRequestBudget();
  await worker(rt, store).ingestOnce(own);
  assert.equal((await totals(store)).requests, logs.length);
  assert.equal((await totals(store)).adminQuota, logs.length * 10, "all pages use the new directory policy");
});


test("failed requests still consume the per-minute safety floor", async (t) => {
  resetOwnRequestBudget();
  const { own, rt, requests } = await site(t, rows(250), { fail: () => 400 });
  const at = Date.now();
  rt._ownUsersCache.startedAt = at - 1000;
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", FROM);
  for (let i = 0; i < OWN_RATE_LIMIT - INGEST_RESERVE; i += 1)
    noteOwnRequest(own.baseUrl, { status: 200, elapsedMs: 1, now: at });
  const ingest = worker(rt, store, () => at);
  assert.equal((await ingest.ingestOnce(own)).pages, 1);
  assert.equal((await ingest.ingestOnce(own)).pages, 1);
  const exhausted = await ingest.ingestOnce(own);
  assert.equal(exhausted.pages, 0);
  assert.equal(exhausted.skipped, "budget");
  assert.equal(requests.length, 2, "failure returns must not reset the reserved request allowance");
  assert.equal((await store.getCursor("own")).coveredToMs, FROM);
});

test("unknown total cannot silently accept a partially overlapping page", async (t) => {
  resetOwnRequestBudget();
  const { own, rt } = await site(t, rows(250), {
    noTotal: true,
    mutate: (data, query, matched) => {
      if (query.page === 2) data.items[0] = matched[0];
    },
  });
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", FROM);
  const result = await worker(rt, store).ingestOnce(own);
  assert.ok(result.error);
  assert.equal((await store.getCursor("own")).coveredToMs, FROM);
  assert.equal((await totals(store)).requests, 0);
  const pending = await store.getPending("own");
  assert.equal(pending.nextPage, 2);
  assert.equal(pending.seenIds.length, 100, "99 new rows from the unsafe page must not be persisted");
});

test("staging left by an older version is discarded if the authoritative cursor advanced", async (t) => {
  resetOwnRequestBudget();
  const logs = [...rows(2176), { ...rows(1)[0], id: 3000, created_at: TO / 1000 + 1 }];
  const { own, rt, requests } = await site(t, logs);
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", FROM);
  await worker(rt, store).ingestOnce(own);
  assert.equal((await store.getPending("own")).nextPage, 16);
  // An older collector can advance the cursor without knowing this new staging table.
  // Its committed report buckets are independent; only cursor/staging compatibility is under test.
  store.cursors.get("own").coveredToMs = TO;
  resetOwnRequestBudget();
  const beforeCleanup = requests.length;
  const stale = await worker(rt, store).ingestOnce(own);
  assert.ok(stale.error);
  assert.equal(requests.length, beforeCleanup, "stale staging is cleared before requesting more logs");
  assert.equal(await store.getPending("own"), null);
  assert.equal((await store.getCursor("own")).coveredToMs, TO);
  resetOwnRequestBudget();
  const beforeResume = requests.length;
  await worker(rt, store).ingestOnce(own);
  assert.equal(requests[beforeResume].page, 1);
  assert.equal(requests[beforeResume].start, TO / 1000, "resume follows the committed cursor rather than stale staging");
  assert.equal((await totals(store)).requests, 1, "completed history is not replayed");
});
