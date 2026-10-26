import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { INGEST, createOwnLogIngest } from "./own-log-ingest.js";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";
import { ownUsersKey } from "./own-helpers.js";
import { noteOwnRequest, resetOwnRequestBudget, INGEST_FLOOR_PER_MIN, INGEST_RESERVE, OWN_RATE_LIMIT } from "../lib/own-request-budget.js";
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
    controls.onRequest?.(requests.length);
    if (controls.delayMs) await new Promise((resolve) => setTimeout(resolve, controls.delayMs));
    const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
    const matched = logs.filter((log) => log.created_at >= start && log.created_at <= end).sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    const size = Number(url.searchParams.get("page_size")), page = Number(url.searchParams.get("p"));
    send(200, { success: true, data: { total: controls.noTotal ? undefined : matched.length, items: matched.slice((page - 1) * size, page * size) } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const own = { id: "own", type: "newapi", isOwn: true, baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "admin", resoldAdminKeys: [] };
  const rt = { _ownUsersCache: { key: ownUsersKey(own), startedAt: NOW - 1000, list: USERS, unknown: new Map() } };
  return { own, rt, requests };
}
const row = (id, atMs, extra = {}) => ({ id, type: 2, created_at: Math.floor(atMs / 1000), channel: 1, model_name: "m", group: "g", username: "alice", token_name: "k", token_id: 7, quota: 10, prompt_tokens: 100, completion_tokens: 10, other: "{}", ...extra });

test("第一次跑从昨天 0 点起，落后超过 1 小时每轮最多 15 页、追到 1 小时内每轮最多 6 页，一个小窗口一个小窗口往前读到现在−120 秒；桶和进度一起写；下一轮接着读；读完返回 caught-up", async (t) => {
  resetOwnRequestBudget();
  // 昨天 0 点起每 2 分钟一条，到现在（约 35 小时 → 1050 条），root 的两条当管理员自用
  const logs = []; let id = 1;
  for (let at = YESTERDAY_START; at < NOW; at += 120000) logs.push(row(id++, at, at % 3600000 === 0 ? { username: "root", quota: 50 } : {}));
  const { own, rt, requests } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore();
  let now = NOW;
  const ingest = createOwnLogIngest(rt, { store, now: () => now });
  const first = await ingest.ingestOnce(own);
  assert.ok(first.pages <= INGEST.MAX_PAGES_BEHIND && first.pages > INGEST.MAX_PAGES_PER_ROUND, `落后 35 小时：每轮最多 15 页、而且用上了：${first.pages}`);
  assert.equal((await store.getCursor("own")).coveredFromMs, YESTERDAY_START, "从昨天 0 点起");
  assert.ok(first.coveredToMs > YESTERDAY_START && first.coveredToMs <= NOW - INGEST.LAG_MS);
  assert.ok(requests.filter((r) => r.path === "/api/log/").every((r) => (r.end - r.start + 1) * 1000 <= INGEST.WINDOW_MAX_MS), "每个请求的窗口不超过 1 小时");
  // 一轮一轮读到追平
  let rounds = 1, total = first.pages, windows = first.windows;
  for (; rounds < 200; rounds += 1) {
    const behindBefore = now - INGEST.LAG_MS - (await store.getCursor("own")).coveredToMs;
    const result = await ingest.ingestOnce(own);
    total += result.pages || 0; windows += result.windows || 0;
    if (result.skipped === "caught-up") break;
    const cap = behindBefore > INGEST.BEHIND_MS ? INGEST.MAX_PAGES_BEHIND : INGEST.MAX_PAGES_PER_ROUND;
    assert.ok((result.pages || 0) <= cap, `落后 ${Math.round(behindBefore / 60000)} 分钟这轮最多 ${cap} 页：${result.pages}`);
    resetOwnRequestBudget(); // 额度窗口里不累积到上限（时间不动）
  }
  const cursor = await store.getCursor("own");
  assert.equal(cursor.coveredToMs, now - INGEST.LAG_MS, "读到现在−120 秒");
  // 追平以后只落后 30 分钟：每轮回到 6 页
  now += 30 * 60000; resetOwnRequestBudget();
  const steady = await ingest.ingestOnce(own);
  assert.ok(steady.pages > 0 && steady.pages <= INGEST.MAX_PAGES_PER_ROUND, `落后 1 小时内每轮最多 6 页：${steady.pages}`);
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  const horizonSec = Math.floor((now - INGEST.LAG_MS) / 1000) - 1;
  const expected = logs.filter((log) => log.created_at <= horizonSec);
  assert.equal(buckets.reduce((sum, b) => sum + b.requests, 0), expected.length, "每条日志进且只进一次桶");
  assert.equal(buckets.reduce((sum, b) => sum + b.adminQuota, 0), expected.filter((log) => log.username === "root").reduce((sum, log) => sum + log.quota, 0), "管理员自用按 R1 的规矩记");
  assert.ok(buckets.every((b) => b.slotMs % OWN_LOG_SLOT_MS === 0));
  // 稀的站点每个窗口至少 1 页（窗口会长到 1 小时）；加上条数 ÷ 100 和每轮最多白读一页，不该有大量重翻
  assert.ok(total <= windows + Math.ceil(expected.length / 100) + rounds, `翻页数：${total} 页、${windows} 个窗口、${rounds} 轮`);
});

test("窗口太满（超过 3 页）就对半切，最小 5 秒；稀的窗口翻倍到 1 小时；一个窗口这轮翻不完就不写、下一轮从头读", async (t) => {
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
  assert.ok(first > YESTERDAY_START, "切小以后读完了一个窗口");
  assert.ok(requests.filter((r) => r.path === "/api/log/").every((r) => (r.end - r.start + 1) * 1000 >= INGEST.WINDOW_MIN_MS), "窗口不小于 5 秒");
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
  // 剩给别人的额度不够：不是 0，保底每分钟还能发 INGEST_FLOOR_PER_MIN 个（总指挥 10-26 定，不然线上别的读占满时整站读永远发不出）
  const starved = await ingest.ingestOnce(own);
  assert.ok(!starved.skipped && starved.pages > 0 && starved.pages <= INGEST_FLOOR_PER_MIN, `额度不够时走保底：${starved.pages} 页`);
  const coveredAfterStarved = (await store.getCursor("own")).coveredToMs;
  const beforeBreak = requests.filter((r) => r.path === "/api/log/").length;
  resetOwnRequestBudget();
  fail = 429;
  const broken = await ingest.ingestOnce(own);
  assert.equal(broken.error, "UPSTREAM_REQUEST_FAILED");
  assert.equal(requests.filter((r) => r.path === "/api/log/").length - beforeBreak, 1, "429 以后这轮不再发");
  assert.equal((await store.getCursor("own")).coveredToMs, coveredAfterStarved, "窗口没写");
  assert.equal((await ingest.ingestOnce(own)).skipped, "break", "断路期间不读");
  fail = null; resetOwnRequestBudget();
  const ok = await ingest.ingestOnce(own);
  assert.ok(ok.windows >= 1 && (await store.getCursor("own")).coveredToMs > YESTERDAY_START, "恢复后从同一个窗口起点接着读");
});

test("窗口边界对齐到整秒：时钟不是整秒、每轮都在走，每条日志进且只进一次桶（审核 #123 中-1）", async (t) => {
  resetOwnRequestBudget();
  // 最近 40 分钟每秒 1 条；时钟从一个不整的毫秒起，每轮走 61.234 秒
  let now = NOW + 123;
  const logs = []; let id = 1;
  for (let at = now - 40 * 60000; at < now; at += 1000) logs.push(row(id++, at));
  const { own, rt } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", now - 40 * 60000 - 777); // 进度也不是整秒
  const ingest = createOwnLogIngest(rt, { store, now: () => now });
  for (let round = 0; round < 60; round += 1) {
    resetOwnRequestBudget();
    const result = await ingest.ingestOnce(own);
    assert.ok(!result.error, `读失败：${result.error}`);
    now += 61234;
  }
  const cursor = await store.getCursor("own");
  assert.equal(cursor.coveredToMs % 1000, 0, "进度落在整秒上");
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  const expected = logs.filter((log) => log.created_at * 1000 < cursor.coveredToMs).length;
  assert.equal(buckets.reduce((sum, b) => sum + b.requests, 0), expected, "边界那一秒没丢、也没重");
});

test("很忙的站点（每秒 12 条）追得上：窗口缩到几十秒，每轮都前进；落后超过 1 小时每轮最多 15 页（审核 #123 中-2）", async (t) => {
  resetOwnRequestBudget();
  // 落后 2 小时，这 2 小时每秒 12 条（= 720 条/分钟，超过了原来 1 分钟窗口 × 6 页能读的量）
  const logs = []; let id = 1;
  const from = NOW - 2 * 3600000;
  for (let at = from; at < from + 600000; at += 1000) for (let k = 0; k < 12; k += 1) logs.push(row(id++, at));
  const { own, rt, requests } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", from);
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  let before = from, rounds = 0;
  for (; rounds < 40; rounds += 1) {
    resetOwnRequestBudget();
    const result = await ingest.ingestOnce(own);
    console.log("DEBUG", rounds, JSON.stringify(result), ingest.windowSizes.get("own"));
    if (result.skipped === "caught-up") break;
    assert.ok(result.pages <= INGEST.MAX_PAGES_BEHIND, `每轮最多 15 页：${result.pages}`);
    const cursor = await store.getCursor("own");
    assert.ok(cursor.coveredToMs > before, `第 ${rounds + 1} 轮没前进`);
    before = cursor.coveredToMs;
  }
  assert.ok(rounds >= 5 && rounds < 40, `每秒 12 条的 10 分钟（7200 条）几轮读完：${rounds}`);
  // 每秒 12 条：3 页（300 条）装得下的窗口是 25 秒，密的那段窗口要切到 25 秒以内（下限 5 秒）
  const smallest = Math.min(...requests.filter((r) => r.path === "/api/log/").map((r) => r.end - r.start + 1));
  assert.ok(smallest <= 25 && smallest >= INGEST.WINDOW_MIN_MS / 1000, `密的那段窗口切到了 ${smallest} 秒`);
  assert.ok(requests.filter((r) => r.path === "/api/log/").every((r) => r.p <= INGEST.PAGES_PER_WINDOW), "每个窗口不超过 3 页");
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  assert.equal(buckets.reduce((sum, b) => sum + b.requests, 0), logs.filter((log) => log.created_at * 1000 < before).length, "不漏不重");
});

test("每个请求之前都看时间和断路器：站点慢（20 秒到了）就停、别的读取让断路器断开了也停，这个窗口不写（审核 #123 中-3）", async (t) => {
  resetOwnRequestBudget();
  // 一个窗口要翻 3 页：10 分钟 250 条
  const logs = []; let id = 1;
  for (let at = YESTERDAY_START; at < YESTERDAY_START + 600000; at += 2400) logs.push(row(id++, at));
  let now = NOW, clockPerRequest = 0, breakAt = 0;
  // 只数 /api/log/（管理员名单那一次不算）
  const site = await fakeSite(t, logs, { onRequest: () => { now += clockPerRequest; const n = site.requests.filter((r) => r.path === "/api/log/").length; if (breakAt && n === breakAt) noteOwnRequest(own.baseUrl + "/other", { status: 429, elapsedMs: 10, now }); } });
  const { own, rt, requests } = site;
  const store = new MemoryOwnLogStore();
  const ingest = createOwnLogIngest(rt, { store, now: () => now });
  clockPerRequest = 11000; // 每个请求 11 秒：第 2 个请求以后就过了 20 秒
  const slow = await ingest.ingestOnce(own);
  assert.equal(requests.filter((r) => r.path === "/api/log/").length, 2, "超过 20 秒以后不再发");
  assert.equal(slow.windows, 0);
  assert.equal((await store.getCursor("own")).coveredToMs, YESTERDAY_START, "翻了一半的窗口不写");
  clockPerRequest = 0; breakAt = 4; resetOwnRequestBudget(); // 第 4 个请求 = 这一轮的第 2 页
  const broken = await ingest.ingestOnce(own);
  assert.equal(requests.filter((r) => r.path === "/api/log/").length, 4, "第 2 个请求时别的读取碰到 429、断路器开了：第 3 页不发");
  assert.equal(broken.windows, 0);
  assert.equal((await store.getCursor("own")).coveredToMs, YESTERDAY_START);
});

test("站点不给 total：一页一页翻到不满一页为止；这轮额度翻不完就不写（审核 #123 低-7）", async (t) => {
  resetOwnRequestBudget();
  const logs = []; let id = 1;
  for (let at = YESTERDAY_START; at < YESTERDAY_START + 60000; at += 250) logs.push(row(id++, at)); // 1 分钟 240 条
  const { own, rt, requests } = await fakeSite(t, logs, { noTotal: true });
  const store = new MemoryOwnLogStore();
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  // 别的读取用掉了大半额度：这轮只剩 2 页
  for (let i = 0; i < OWN_RATE_LIMIT - INGEST_RESERVE - 2; i += 1) noteOwnRequest(own.baseUrl + "/x", { status: 200, elapsedMs: 10, now: NOW });
  ingest.windowSizes.set("own", 60000);
  const short = await ingest.ingestOnce(own);
  assert.equal(short.windows, 0, "2 页翻不完 240 条：不写");
  assert.equal((await store.getCursor("own")).coveredToMs, YESTERDAY_START);
  resetOwnRequestBudget();
  const full = await ingest.ingestOnce(own);
  assert.ok(full.windows >= 1);
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  const cursor = await store.getCursor("own");
  assert.equal(buckets.reduce((sum, b) => sum + b.requests, 0), logs.filter((log) => log.created_at * 1000 < cursor.coveredToMs).length, "没有 total 也不漏不重");
  assert.ok(requests.length > 0);
});

test("进度比保留期还旧（停机超过 35 天）：清掉从昨天 0 点重来；清理一批一批删到不满一批为止（审核 #123 低-4、低-6）", async (t) => {
  resetOwnRequestBudget();
  const { own, rt } = await fakeSite(t, [row(1, YESTERDAY_START + 1000)]);
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", NOW - 40 * 86400000);
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  await ingest.ingestOnce(own);
  assert.equal((await store.getCursor("own")).coveredFromMs, YESTERDAY_START, "从昨天 0 点重来");
  const old = []; for (let i = 0; i < 4500; i += 1) old.push({ slotMs: NOW - 40 * 86400000, channelId: i, model: "m", upstreamModel: "", group: "g", semantic: "openai", requests: 1 });
  await store.deleteStation("old"); await store.startCursor("old", 0);
  await store.applyWindow("old", { fromMs: 0, toMs: 1, buckets: old });
  assert.equal(await ingest.pruneIfDue(), 4500, "4500 行 = 3 批");
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

test("保底：别的读取一直占满额度（线上站点忙），整站读每轮也能发出 INGEST_FLOOR_PER_MIN 个请求、窗口接着切小，最后追平（总指挥 10-26 定）", async (t) => {
  resetOwnRequestBudget();
  // 落后 2 小时，每 2 分钟一条（60 条），密度不大，保底 2 页/分钟也追得上
  const logs = []; let id = 1;
  for (let at = NOW - 2 * 3600000; at < NOW - INGEST.LAG_MS; at += 120000) logs.push(row(id++, at));
  const { own, rt } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", NOW - 2 * 3600000);
  let now = NOW;
  const ingest = createOwnLogIngest(rt, { store, now: () => now });
  let rounds = 0;
  for (; rounds < 60; rounds += 1) {
    resetOwnRequestBudget();
    // 模拟别的读取占满这个站点的额度：整站读只能靠保底
    for (let i = 0; i < OWN_RATE_LIMIT - INGEST_RESERVE; i += 1) noteOwnRequest(own.baseUrl + "/other", { status: 200, elapsedMs: 10, now });
    const result = await ingest.ingestOnce(own);
    if (result.skipped === "caught-up") break;
    assert.ok(result.pages <= INGEST_FLOOR_PER_MIN, `每轮最多保底 ${INGEST_FLOOR_PER_MIN} 页：${result.pages}`);
  }
  assert.ok(rounds > 0 && rounds < 60, `保底慢慢追平：${rounds} 轮`);
  const cursor = await store.getCursor("own");
  assert.equal(cursor.coveredToMs, now - INGEST.LAG_MS, "最后追平");
});
