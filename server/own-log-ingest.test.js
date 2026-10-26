import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { INGEST, createOwnLogIngest } from "./own-log-ingest.js";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";
import { ownUsersKey } from "./own-helpers.js";
import { noteOwnRequest, resetOwnRequestBudget, INGEST_RESERVE, OWN_RATE_LIMIT } from "../lib/own-request-budget.js";
import { OWN_LOG_SLOT_MS } from "../lib/own-log-bucket.js";

// 业务时区上海：now 是 10-09 11:00，昨天 0 点是 10-07 16:00Z
const NOW = Date.parse("2026-10-09T03:00:00Z");
const YESTERDAY_START = Date.parse("2026-10-07T16:00:00Z");
const USERS = [{ id: 1, username: "root", role: 100 }, { id: 2, username: "alice", role: 1 }];

// 假站点：logs 按 created_at desc、id desc 分页；start/end 是包含式秒；记下每个请求；可以让某一页出错、返回慢
async function fakeSite(t, logs, controls = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://x");
    requests.push({ path: url.pathname, p: Number(url.searchParams.get("p") || 1), start: Number(url.searchParams.get("start_timestamp") || 0), end: Number(url.searchParams.get("end_timestamp") || 0) });
    const send = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (url.pathname === "/api/user/") return send(200, { success: true, data: { items: USERS, total: USERS.length } });
    if (url.pathname !== "/api/log/") return send(404, { success: false });
    const failAt = controls.failAt?.(requests.length);
    if (failAt) return send(failAt, { success: false, message: "boom" });
    if (controls.delayMs) await new Promise((resolve) => setTimeout(resolve, controls.delayMs));
    const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
    const matched = logs.filter((log) => log.created_at >= start && log.created_at <= end).sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    const size = Number(url.searchParams.get("page_size")), page = Number(url.searchParams.get("p"));
    send(200, { success: true, data: { total: matched.length, items: matched.slice((page - 1) * size, page * size) } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const own = { id: "own", type: "newapi", isOwn: true, baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "admin", resoldAdminKeys: [] };
  const rt = { _ownUsersCache: { key: ownUsersKey(own), startedAt: NOW - 1000, list: USERS, unknown: new Map() } };
  return { own, rt, requests };
}
const row = (id, atMs, extra = {}) => ({ id, type: 2, created_at: Math.floor(atMs / 1000), channel: 1, model_name: "m", group: "g", username: "alice", token_name: "k", token_id: 7, quota: 10, prompt_tokens: 100, completion_tokens: 10, other: "{}", ...extra });

test("第一次跑从昨天 0 点起，每轮最多 6 页，一个小窗口一个小窗口往前读到现在−120 秒；桶和进度一起写；下一轮接着读；读完返回 caught-up", async (t) => {
  resetOwnRequestBudget();
  // 昨天 0 点起每 2 分钟一条，到现在（约 35 小时 → 1050 条），root 的两条当管理员自用
  const logs = []; let id = 1;
  for (let at = YESTERDAY_START; at < NOW; at += 120000) logs.push(row(id++, at, at % 3600000 === 0 ? { username: "root", quota: 50 } : {}));
  const { own, rt, requests } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore();
  let now = NOW;
  const ingest = createOwnLogIngest(rt, { store, now: () => now });
  const first = await ingest.ingestOnce(own);
  assert.ok(first.pages <= INGEST.MAX_PAGES_PER_ROUND && first.pages > 0, `每轮最多 6 页：${first.pages}`);
  assert.equal((await store.getCursor("own")).coveredFromMs, YESTERDAY_START, "从昨天 0 点起");
  assert.ok(first.coveredToMs > YESTERDAY_START && first.coveredToMs <= NOW - INGEST.LAG_MS);
  assert.ok(requests.filter((r) => r.path === "/api/log/").every((r) => (r.end - r.start + 1) * 1000 <= INGEST.WINDOW_MAX_MS), "每个请求的窗口不超过 1 小时");
  // 一轮一轮读到追平
  let rounds = 1, total = first.pages, windows = first.windows;
  for (; rounds < 200; rounds += 1) {
    const result = await ingest.ingestOnce(own);
    total += result.pages || 0; windows += result.windows || 0;
    if (result.skipped === "caught-up") break;
    assert.ok((result.pages || 0) <= INGEST.MAX_PAGES_PER_ROUND);
    resetOwnRequestBudget(); // 额度窗口里不累积到上限（时间不动）
  }
  const cursor = await store.getCursor("own");
  assert.equal(cursor.coveredToMs, now - INGEST.LAG_MS, "读到现在−120 秒");
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  const horizonSec = Math.floor((now - INGEST.LAG_MS) / 1000) - 1;
  const expected = logs.filter((log) => log.created_at <= horizonSec);
  assert.equal(buckets.reduce((sum, b) => sum + b.requests, 0), expected.length, "每条日志进且只进一次桶");
  assert.equal(buckets.reduce((sum, b) => sum + b.adminQuota, 0), expected.filter((log) => log.username === "root").reduce((sum, log) => sum + log.quota, 0), "管理员自用按 R1 的规矩记");
  assert.ok(buckets.every((b) => b.slotMs % OWN_LOG_SLOT_MS === 0));
  // 稀的站点每个窗口至少 1 页（窗口会长到 1 小时）；加上条数 ÷ 100 和每轮最多白读一页，不该有大量重翻
  assert.ok(total <= windows + Math.ceil(expected.length / 100) + rounds, `翻页数：${total} 页、${windows} 个窗口、${rounds} 轮`);
});

test("窗口太满（超过 3 页）就对半切，最小 1 分钟；稀的窗口翻倍到 1 小时；一个窗口这轮翻不完就不写、下一轮从头读", async (t) => {
  resetOwnRequestBudget();
  // 第一个小时密（每秒 1 条 = 3600 条），之后每 10 分钟 1 条
  const logs = []; let id = 1;
  for (let at = YESTERDAY_START; at < YESTERDAY_START + 3600000; at += 1000) logs.push(row(id++, at));
  for (let at = YESTERDAY_START + 3600000; at < NOW; at += 600000) logs.push(row(id++, at));
  const { own, rt, requests } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore();
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  await ingest.ingestOnce(own);
  const first = (await store.getCursor("own")).coveredToMs;
  assert.ok(requests.some((r) => (r.end - r.start + 1) * 1000 < INGEST.WINDOW_START_MS), "密的那一小时把窗口切小了（10 分钟的窗口有 600 条、6 页，对半切）");
  // 任何一个窗口都没翻超过 3 页（翻页不深）：不切的话 10 分钟的窗口要翻 6 页
  const perWindow = new Map();
  for (const r of requests.filter((item) => item.path === "/api/log/")) perWindow.set(`${r.start}-${r.end}`, Math.max(perWindow.get(`${r.start}-${r.end}`) || 0, r.p));
  assert.ok([...perWindow.values()].every((pages) => pages <= INGEST.PAGES_PER_WINDOW), `每个窗口最多翻 ${INGEST.PAGES_PER_WINDOW} 页：${[...perWindow.values()].join(",")}`);
  assert.ok(first - YESTERDAY_START <= INGEST.WINDOW_START_MS, `第一轮只前进了一个小窗口：${(first - YESTERDAY_START) / 60000} 分钟`);
  assert.ok(first > YESTERDAY_START, "切小以后读完了一个窗口");
  const covered = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  assert.equal(covered.reduce((sum, b) => sum + b.requests, 0), logs.filter((log) => log.created_at * 1000 < first).length, "只写了读完的窗口，没有半个窗口");
  // 密的过去以后窗口翻倍
  for (let i = 0; i < 400; i += 1) { resetOwnRequestBudget(); const r = await ingest.ingestOnce(own); if (r.skipped === "caught-up") break; }
  assert.equal(ingest.windowSizes.get("own"), INGEST.WINDOW_MAX_MS, "稀的日子窗口回到 1 小时");
});

test("额度和断路：别的读取已经用掉大半额度就这轮不读；碰到 429 断路、这轮停下、窗口不写；读失败的窗口下一轮从头读", async (t) => {
  resetOwnRequestBudget();
  const logs = []; let id = 1;
  for (let at = YESTERDAY_START; at < NOW; at += 600000) logs.push(row(id++, at));
  let fail = null;
  const { own, rt, requests } = await fakeSite(t, logs, { failAt: () => fail });
  const store = new MemoryOwnLogStore();
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  for (let i = 0; i < OWN_RATE_LIMIT - INGEST_RESERVE; i += 1) noteOwnRequest(own.baseUrl + "/x", { status: 200, elapsedMs: 10, now: NOW });
  assert.deepEqual((await ingest.ingestOnce(own)).skipped, "budget", "剩给别人的额度不够：不读");
  resetOwnRequestBudget();
  fail = 429;
  const broken = await ingest.ingestOnce(own);
  assert.equal(broken.error, "UPSTREAM_REQUEST_FAILED");
  assert.equal(requests.filter((r) => r.path === "/api/log/").length, 1, "429 以后这轮不再发");
  assert.equal((await store.getCursor("own")).coveredToMs, YESTERDAY_START, "窗口没写");
  assert.equal((await ingest.ingestOnce(own)).skipped, "break", "断路期间不读");
  fail = null; resetOwnRequestBudget();
  const ok = await ingest.ingestOnce(own);
  assert.ok(ok.windows >= 1 && (await store.getCursor("own")).coveredToMs > YESTERDAY_START, "恢复后从同一个窗口起点接着读");
});

test("管理员名单读不到：这轮不读（桶里的管理员自用会算错）；清理只删 35 天前的桶", async (t) => {
  resetOwnRequestBudget();
  const { own, requests } = await fakeSite(t, [row(1, YESTERDAY_START + 1000)]);
  const rt = {}; // 没有缓存，要去读 /api/user/（假站点给）；换一个读不到的站点
  const store = new MemoryOwnLogStore();
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  const bad = { ...own, baseUrl: "http://127.0.0.1:9" };
  const result = await ingest.ingestOnce(bad);
  assert.equal(result.skipped, "admins");
  assert.equal(await store.getCursor("own"), null, "进度都没建");
  assert.equal(requests.length, 0);
  await store.startCursor("own", 0);
  await store.applyWindow("own", { fromMs: 0, toMs: 1, buckets: [{ slotMs: NOW - 40 * 86400000, channelId: 1, model: "m", upstreamModel: "", group: "g", semantic: "openai", requests: 1 }, { slotMs: NOW - 3600000, channelId: 1, model: "m", upstreamModel: "", group: "g", semantic: "openai", requests: 1 }] });
  assert.equal(await ingest.pruneIfDue(), 1);
  assert.equal(await ingest.pruneIfDue(), 0, "一小时内不再清");
});
