import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ERROR_KIND, INGEST, RETRY_SETTINGS_FAIL_TTL_MS, RETRY_SETTINGS_TTL_MS, cachedRetrySettings, createOwnLogIngest, readRetrySettings, samplePlan } from "./own-log-ingest.js";
import { ERROR_SPEC } from "./own-log-store.js";
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
    if (url.pathname === "/api/option/" && controls.options) return controls.options(send);
    if (url.pathname !== "/api/log/") return send(404, { success: false });
    const failAt = controls.failAt?.(requests.length);
    if (failAt) return send(failAt, { success: false, message: "boom" });
    controls.onRequest?.(requests.length);
    if (controls.delayMs) await new Promise((resolve) => setTimeout(resolve, controls.delayMs));
    const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
    const type = url.searchParams.get("type");
    requests[requests.length - 1].type = type;
    const matched = logs.filter((log) => log.created_at >= start && log.created_at <= end && (type == null || Number(log.type) === Number(type))).sort((a, b) => b.created_at - a.created_at || b.id - a.id);
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

test("窗口太满（超过 3 页）就对半切，最小 5 秒；稀的窗口翻倍到 1 小时；一个窗口这轮翻不完不发布、下一轮续读", async (t) => {
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

test("额度和断路：别的读取已经用掉大半额度就这轮不读；碰到 429 断路、这轮停下、窗口不写；读失败的窗口下一轮接着读", async (t) => {
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
  assert.ok(broken.windows >= 1, "下一轮从已暂存的第 3 页续读，完整窗口才正式入桶");
  assert.ok((await store.getCursor("own")).coveredToMs > YESTERDAY_START);
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

// 总指挥 10-26 定第三轮：停机、站点读不到、令牌失效造成的掉队，不管多久都不跳，照常按保底慢慢追——那几天开关本来是开着的，补得上就该补
test("控制台停两天再起来：不跳，前天照样按保底慢慢补上（没有 justTurnedOn 就不跳，不管落后多久）", async (t) => {
  resetOwnRequestBudget();
  const { own, rt } = await fakeSite(t, [row(1, YESTERDAY_START + 1000)]);
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", NOW - 40 * 86400000); // 停机 40 天，远超 35 天的保留期
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  await ingest.ingestOnce(own);
  assert.equal((await store.getCursor("own")).coveredFromMs, NOW - 40 * 86400000, "没传 justTurnedOn：进度起点不动，不跳，照旧从老地方往前追");
  assert.equal((await store.getCursor("own")).disabledFromMs, null, "没有跳过的缺口");
});

test("清理一批一批删到不满一批为止（审核 #123 低-4、低-6）", async (t) => {
  resetOwnRequestBudget();
  const { rt } = await fakeSite(t, [row(1, YESTERDAY_START + 1000)]);
  const store = new MemoryOwnLogStore();
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  const old = []; for (let i = 0; i < 4500; i += 1) old.push({ slotMs: NOW - 40 * 86400000, channelId: i, model: "m", upstreamModel: "", group: "g", semantic: "openai", requests: 1 });
  await store.startCursor("old", 0);
  await store.applyWindow("old", { fromMs: 0, toMs: 1, buckets: old });
  assert.equal(await ingest.pruneIfDue(), 4500, "4500 行 = 3 批");
});

test("开关关 10 天再打开：传 justTurnedOn 才跳到昨天 0 点，跳过的缺口记下来、桶不删（总指挥 10-26 定第三轮，决定 C）", async (t) => {
  resetOwnRequestBudget();
  const { own, rt } = await fakeSite(t, []); // 不给日志，避免追的时候自己把进度推到昨天，干扰断言
  const store = new MemoryOwnLogStore();
  const oldFrom = YESTERDAY_START - 10 * 86400000; // 10 天前还开着，之后关了
  await store.startCursor("own", oldFrom);
  await store.applyWindow("own", { fromMs: oldFrom, toMs: oldFrom + 1, buckets: [{ slotMs: oldFrom, channelId: 1, model: "m", upstreamModel: "", group: "g", semantic: "openai", requests: 1 }] });
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  await ingest.ingestOnce(own, { justTurnedOn: false });
  const before = await store.getCursor("own");
  assert.equal(before.disabledFromMs, null, "没传 justTurnedOn：这一轮不跳，没有缺口");
  assert.ok(before.coveredToMs < YESTERDAY_START, "10 天的缺口一轮追不完，还没到昨天 0 点");
  await ingest.ingestOnce(own, { justTurnedOn: true });
  const cursor = await store.getCursor("own");
  // 跳过去以后，这一轮剩下的额度接着往前读（不是跳完就停）：只断言跳到了昨天 0 点（或更后面）、缺口记对了
  assert.ok(cursor.coveredToMs >= YESTERDAY_START, "跳到了昨天 0 点（或这一轮接着往前读到了更后面）");
  assert.deepEqual([cursor.disabledFromMs, cursor.disabledToMs], [before.coveredToMs, YESTERDAY_START], "缺口是跳之前的进度到昨天 0 点这一段");
  assert.equal((await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER)).length, 1, "已经读进来的桶没删");
});

// 审核 R2 #125 第三轮 中-C：这一轮被额度、断路、管理员名单挡住，没真的走到跳不跳那一步时，skipChecked 不给 true——
// 调用方（server/reconciliation.js）据此不清「上一次是关着的」标记，下一轮还会再试，不会因为撞上这些挡路的原因就永远跳不过去
test("被额度、管理员名单挡住的那一轮没真的判断过跳不跳：不给 skipChecked，下一轮还会再试（审核 R2 #125 第三轮 中-C）", async (t) => {
  resetOwnRequestBudget();
  const oldFrom = YESTERDAY_START - 10 * 86400000;
  const store = new MemoryOwnLogStore();
  await store.startCursor("own", oldFrom);

  // 额度不够（断路/限流）：function 在判断跳不跳之前就退出
  {
    const { own, rt } = await fakeSite(t, []);
    for (let i = 0; i < 400; i += 1) noteOwnRequest(own.baseUrl + "/x", { status: 429, elapsedMs: 10, now: NOW });
    const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
    const result = await ingest.ingestOnce(own, { justTurnedOn: true });
    assert.equal(result.skipChecked, undefined, "被断路/限流挡住，没走到跳不跳那一步");
    assert.equal((await store.getCursor("own")).disabledFromMs, null, "没跳，缺口还没记");
  }
  resetOwnRequestBudget();

  // 管理员名单读不到：function 在判断跳不跳之前就退出（现在的站点读不到 /api/user/）
  {
    const { own } = await fakeSite(t, []);
    const bad = { ...own, baseUrl: "http://127.0.0.1:9" };
    const ingest = createOwnLogIngest({}, { store, now: () => NOW });
    const result = await ingest.ingestOnce(bad, { justTurnedOn: true });
    assert.equal(result.skipped, "admins");
    assert.equal(result.skipChecked, undefined, "被管理员名单挡住，没走到跳不跳那一步");
    assert.equal((await store.getCursor("own")).disabledFromMs, null, "没跳，缺口还没记");
  }

  // 这两轮都没真的判断过，下一轮（额度、名单都正常）应该还能跳——不会因为之前被挡住就再也跳不过去
  const { own, rt } = await fakeSite(t, []);
  const ingest = createOwnLogIngest(rt, { store, now: () => NOW });
  const result = await ingest.ingestOnce(own, { justTurnedOn: true });
  assert.equal(result.skipChecked, true, "这一轮真的走到了跳不跳那一步");
  assert.ok((await store.getCursor("own")).disabledFromMs != null, "这一轮才真的跳了、记下缺口");
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

// ===== 错误日志（type=5，模型供需第 1 步）：和消费日志同一条流水线，另一份进度和桶，只存次数 =====
const errRow = (id, atMs, extra = {}, other = {}) => ({ id, type: 5, created_at: Math.floor(atMs / 1000), channel: 1, model_name: "m", group: "g", username: "alice", token_name: "secret-key", token_id: 7, quota: 0,
  content: "用户的内容 sk-xxxx", other: JSON.stringify({ status_code: 429, error_code: "bad_response_status_code", admin_info: { use_channel: ["1"] }, ...other }), ...extra });
const errorIngest = (rt, store, now) => createOwnLogIngest(rt, { store, kind: ERROR_KIND, now });
const errorReads = (requests) => requests.filter((r) => r.path === "/api/log/");
const total = (buckets) => buckets.reduce((sum, bucket) => sum + bucket.count, 0);
const wholeSecondMs = (ms) => Math.floor(ms / 1000) * 1000;

// 漏了好几天（停机、站点读不到）才追：测试里直接把进度放在昨天 0 点，模拟「落后 35 小时」；第一次启动是从现在往后读，见下面「第一次只从现在往后读」
const startBehind = async (store, fromMs = YESTERDAY_START) => store.startCursor("own", fromMs, NOW);
const catchUp = async (ingest, own, { rounds = 200, each } = {}) => {
  for (let i = 0; i < rounds; i += 1) { resetOwnRequestBudget(); const r = await ingest.ingestOnce(own); each?.(r); if (r.skipped === "caught-up") return i + 1; }
  throw new Error("追不平");
};
const sameHour = (r) => Math.floor(r.start / 3600) === Math.floor(r.end / 3600);

test("错误日志：读 type=5，按原因、状态码、第几次尝试分桶；不读管理员名单；窗口最长 5 分钟、不跨小时；消费日志的进度和桶不受影响", async (t) => {
  resetOwnRequestBudget();
  const logs = [];
  logs.push(errRow(1, YESTERDAY_START + 3600000), errRow(2, YESTERDAY_START + 3600000 + 1000, {}, { status_code: 503, admin_info: { use_channel: ["1", "2"] } }), errRow(3, YESTERDAY_START + 7200000, { channel: 2 }, { status_code: 502, admin_info: { use_channel: ["2"] } }));
  logs.push(row(10, YESTERDAY_START + 3600000)); // 一条消费日志：错误日志那条流水线不该读到
  const { own, rt, requests } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore(ERROR_SPEC), consumeStore = new MemoryOwnLogStore();
  await startBehind(store);
  const ingest = errorIngest(rt, store, () => NOW);
  await catchUp(ingest, own);
  assert.ok(errorReads(requests).length > 0 && errorReads(requests).every((r) => r.type === "5"), "每个请求都带 type=5");
  assert.equal(requests.filter((r) => r.path === "/api/user/").length, 0, "错误日志不分管理员，不读用户列表");
  assert.ok(errorReads(requests).every((r) => (r.end - r.start + 1) * 1000 <= ERROR_KIND.limits.windowMaxMs && sameHour(r)), "窗口不超过 5 分钟、不跨小时");
  assert.equal((await store.getCursor("own")).coveredFromMs, YESTERDAY_START);
  assert.equal((await store.getCursor("own")).coveredToMs, NOW - INGEST.LAG_MS);
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(buckets.map((b) => [b.channelId, b.reason, b.status, b.attempt, b.count, b.sampled]).sort(), [[1, "rate_limit", 429, 1, 1, 0], [1, "upstream", 503, 2, 1, 0], [2, "upstream", 502, 1, 1, 0]], "条数少于 300 的窗口读全了，是实数（sampled 0）");
  assert.ok(buckets.every((b) => b.slotMs % 3600000 === 0 && b.model === "m" && b.group === "g"));
  assert.equal(await consumeStore.getCursor("own"), null, "另一份进度，消费日志的不动");
  assert.deepEqual(Object.keys(buckets[0]).sort(), ["attempt", "channelId", "count", "group", "model", "reason", "retryable", "sampled", "slotMs", "status", "table"], "只有次数，没有用户名、令牌名、原文");
  // 用户桶：日志里的 user_id（夹具里没写，记 0）；前两条在同一个小时（429 第 1 次、503 第 2 次），第三条在下一个小时（502 第 1 次）
  const userBuckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER, { table: "user" });
  assert.deepEqual(userBuckets.map((b) => [b.userId, b.model, b.reason, b.count, b.firstCount]).sort(), [[0, "m", "rate_limit", 1, 1], [0, "m", "upstream", 1, 0], [0, "m", "upstream", 1, 1]]);
});

test("第一次只从现在往后读：没有进度时进度从 现在−120 秒 起，不补过去的日志（站点里再老的错误也不读），第一轮一个请求都不发；满 5 分钟才读第一个窗口", async (t) => {
  resetOwnRequestBudget();
  let now = NOW;
  const { own, rt, requests } = await fakeSite(t, [errRow(1, YESTERDAY_START + 3600000), errRow(2, NOW - 3600000), errRow(3, NOW + 60000)]);
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  const ingest = errorIngest(rt, store, () => now);
  const first = await ingest.ingestOnce(own);
  assert.equal(first.skipped, "caught-up");
  assert.equal(errorReads(requests).length, 0, "第一轮不发请求");
  const cursor = await store.getCursor("own");
  assert.equal(cursor.coveredFromMs, wholeSecondMs(NOW - INGEST.LAG_MS));
  assert.equal(cursor.coveredToMs, cursor.coveredFromMs);
  now += 5 * 60000; resetOwnRequestBudget();
  assert.ok(!(await ingest.ingestOnce(own)).skipped);
  assert.deepEqual((await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER)).map((b) => b.count), [1], "只读到启动以后的那一条");
  assert.ok(errorReads(requests).every((r) => r.start * 1000 >= wholeSecondMs(NOW - INGEST.LAG_MS)), "没有一个请求从启动以前开始");
});

test("错误日志：暂存和桶里不留错误原文、用户名、令牌名（读到一半停下时看暂存）", async (t) => {
  resetOwnRequestBudget();
  // 落后不到 1 小时（每轮 3 页）：第一个 5 分钟窗口是空的（1 页），第二个窗口每秒 3 条（900 条）要读 3 页，这一轮只剩 2 页：停在窗口中间，暂存里留着没读完的窗口
  const start = NOW - 40 * 60000, logs = []; let id = 1;
  for (let at = start + 300000; at < start + 600000; at += 1000) for (let k = 0; k < 3; k += 1) logs.push(errRow(id++, at));
  const { own, rt } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  await store.startCursor("own", wholeSecondMs(start), NOW);
  const ingest = errorIngest(rt, store, () => NOW);
  let partial = null;
  for (let i = 0; i < 60 && !partial; i += 1) { resetOwnRequestBudget(); await ingest.ingestOnce(own); const pending = await store.getPending("own"); if (pending && pending.nextPage > 1) partial = pending; }
  assert.ok(partial, "有一轮停在窗口中间，暂存里有东西");
  const text = JSON.stringify([partial, ...[...store.tableBuckets.values()].map((table) => [...table.values()])]);
  for (const secret of ["alice", "secret-key", "sk-xxxx", "用户的内容"]) assert.ok(!text.includes(secret), `暂存和桶里不能有 ${secret}`);
});

test("错误日志每轮页数更少：落后 1 小时内最多 3 页、落后更多最多 6 页；窗口最长 5 分钟；落后不到 5 分钟又没有读到一半的窗口就不发请求；追平以后每 5 分钟才读一次", async (t) => {
  resetOwnRequestBudget();
  const logs = []; let id = 1;
  for (let at = YESTERDAY_START; at < NOW; at += 600000) logs.push(errRow(id++, at));
  let now = NOW;
  const { own, rt, requests } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  await startBehind(store);
  const ingest = errorIngest(rt, store, () => now);
  resetOwnRequestBudget();
  const first = await ingest.ingestOnce(own);
  assert.equal(first.pages, ERROR_KIND.limits.pagesBehind, `落后 35 小时：最多 6 页：${first.pages}`);
  let rounds = 1;
  for (; rounds < 200; rounds += 1) {
    const behind = now - INGEST.LAG_MS - (await store.getCursor("own")).coveredToMs;
    resetOwnRequestBudget();
    const r = await ingest.ingestOnce(own);
    if (r.skipped === "caught-up") break;
    assert.ok((r.pages || 0) <= (behind > INGEST.BEHIND_MS ? ERROR_KIND.limits.pagesBehind : ERROR_KIND.limits.pagesPerRound), `这轮 ${r.pages} 页，落后 ${Math.round(behind / 60000)} 分钟`);
  }
  assert.ok(errorReads(requests).every((r) => (r.end - r.start + 1) * 1000 <= ERROR_KIND.limits.windowMaxMs && sameHour(r)), "窗口不超过 5 分钟、不跨小时（窗口里 COUNT 要扫这段时间的全部日志）");
  assert.equal(ERROR_KIND.limits.windowMaxMs, 5 * 60000);
  assert.equal(total(await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER)), logs.filter((log) => log.created_at <= Math.floor((now - INGEST.LAG_MS) / 1000) - 1).length, "每条进且只进一次");
  // 追平了：之后每分钟轮询一次，落后不到 5 分钟都不发请求；满 5 分钟读一次（跨整点时窗口按整点切，这一次是 2 个窗口）
  const before = errorReads(requests).length;
  for (let minute = 1; minute <= 4; minute += 1) { now += 60000; resetOwnRequestBudget(); const r = await ingest.ingestOnce(own); assert.equal(r.skipped, "caught-up", `第 ${minute} 分钟`); }
  assert.equal(errorReads(requests).length, before, "不到 5 分钟一个请求都不发");
  now += 60000; resetOwnRequestBudget();
  const r5 = await ingest.ingestOnce(own);
  assert.ok(!r5.skipped && r5.pages >= 1 && r5.pages <= 2, `满 5 分钟读一次：${r5.pages} 页（跨整点时 2 页）`);
  assert.equal(errorReads(requests).length, before + r5.pages);
});

test("用户站没开错误日志（读到 0 条）：照常往前走、没有桶；落后 35 小时一次性追平也只 420 个请求（每个窗口 1 个）；追平以后每 5 分钟 1 个请求", async (t) => {
  resetOwnRequestBudget();
  let now = NOW;
  const { own, rt, requests } = await fakeSite(t, [row(1, YESTERDAY_START + 3600000)]); // 只有消费日志，没有错误日志
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  await startBehind(store);
  const ingest = errorIngest(rt, store, () => now);
  await catchUp(ingest, own, { each: (r) => assert.ok(!r.error, r.error) });
  assert.equal((await store.getCursor("own")).coveredToMs, now - INGEST.LAG_MS);
  assert.deepEqual(await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER), []);
  // 35 小时 ÷ 5 分钟 = 420 个窗口，每个 1 个请求（空窗口也是 1 页）
  assert.ok(errorReads(requests).length >= 420 && errorReads(requests).length <= 422, `读了 ${errorReads(requests).length} 个请求`);
  const before = errorReads(requests).length;
  for (let minute = 1; minute <= 30; minute += 1) { now += 60000; resetOwnRequestBudget(); await ingest.ingestOnce(own); }
  assert.ok(errorReads(requests).length - before <= 7 && errorReads(requests).length - before >= 5, `追平以后 30 分钟只读 5～7 次（跨整点多一个窗口）：${errorReads(requests).length - before}`);
});

test("错误日志采样：一个窗口最多读 3 页（300 条）当样本，总条数用请求自带的 total，样本里「渠道 × 模型 × 原因 × 状态码 × 第几次」的比例摊到 total 上，桶标成估算；读到一半停下下一轮接着读；每条只算一次", async (t) => {
  resetOwnRequestBudget();
  // 落后不到 1 小时（每轮 3 页）：第 1 个 5 分钟窗口只有 1 条（1 页）；第 2 个窗口 10 秒里每秒 70 条（700 条，同一秒的 70 条各有各的 id，429 和 503 各一半）：
  // 这一轮只剩 2 页，停在窗口中间，下一轮读第 3 页；后面再有零星 1 条
  const start = NOW - 40 * 60000, logs = []; let id = 1;
  logs.push(errRow(id++, start + 1000));
  for (let at = start + 300000; at < start + 310000; at += 1000) for (let k = 0; k < 70; k += 1) logs.push(errRow(id++, at, {}, k % 2 ? { status_code: 503 } : {}));
  logs.push(errRow(id++, start + 900000));
  const { own, rt, requests } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  await store.startCursor("own", wholeSecondMs(start), NOW);
  const ingest = errorIngest(rt, store, () => NOW);
  let maxPages = 0;
  await catchUp(ingest, own, { each: async (r) => { maxPages = Math.max(maxPages, r.pages || 0); } });
  const perWindow = new Map(); // 窗口 → 读了哪几页
  for (const r of errorReads(requests)) perWindow.set(`${r.start}-${r.end}`, [...(perWindow.get(`${r.start}-${r.end}`) || []), r.p]);
  assert.ok(maxPages <= ERROR_KIND.limits.pagesPerRound, `落后不到 1 小时每轮最多 3 页：${maxPages}`);
  assert.ok([...perWindow.values()].every((pages) => pages.length <= INGEST.PAGES_PER_WINDOW), "每个窗口最多读 3 页，窗口也没有被切小");
  assert.deepEqual([...perWindow.values()].find((pages) => pages.length === 3), [1, 4, 7], "700 条 = 7 页：读第 1 页、中间页（第 4 页）、最后一页（第 7 页），不是最新的 3 页");
  assert.ok(errorReads(requests).every((r) => (r.end - r.start + 1) * 1000 <= 300000), "窗口没被切小，也没被放大");
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  assert.equal(total(buckets), logs.length, "摊完以后加起来正好是窗口的总条数（含样本没读到的）：每条只算一次（续读不重不漏）");
  const by = (status) => buckets.filter((b) => b.status === status).reduce((sum, b) => sum + b.count, 0);
  assert.deepEqual([by(429), by(503)], [352, 350], "样本里 429 和 503 各一半，摊回 700 条：350 + 350，加上两条零星的 429");
  assert.ok(buckets.some((b) => b.sampled > 0), "摊过的桶标成估算");
  const sampledCount = buckets.filter((b) => b.sampled > 0).reduce((sum, b) => sum + b.count, 0);
  assert.ok(sampledCount >= 700, "估算的桶装的是那 700 条");
  // 用户桶也是摊过的：user_id 夹具里没写记 0，一共 702 条、第 1 次尝试 702 条
  const userBuckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER, { table: "user" });
  assert.equal(userBuckets.reduce((sum, b) => sum + b.count, 0), logs.length);
  assert.equal(userBuckets.reduce((sum, b) => sum + b.firstCount, 0), logs.length);
  assert.ok(userBuckets.some((b) => b.sampled > 0));
});

test("采样分层取页：页是按时间倒序切的，样本要覆盖窗口的头、中、尾；窗口前半段才有的小渠道不会被摊成 0；页码只由 total 算，不多发请求", async (t) => {
  assert.deepEqual([0, 1, 250, 300].map((n) => samplePlan(n, 3)), [[], [1], [1, 2, 3], [1, 2, 3]], "不超过 3 页全读");
  assert.deepEqual([301, 400, 600, 15000].map((n) => samplePlan(n, 3)), [[1, 3, 4], [1, 3, 4], [1, 4, 6], [1, 76, 150]]);
  resetOwnRequestBudget();
  // 一个窗口 600 条：渠道 1 有 570 条（晚），渠道 2 只有 30 条而且最早（按时间倒序是最后 30 条，落在第 6 页）。只取最新 3 页会把渠道 2 估成 0
  const start = NOW - 30 * 60000, logs = []; let id = 1;
  for (let k = 0; k < 30; k += 1) logs.push(errRow(id++, start + 1000 + k * 1000, { channel: 2 }, { admin_info: { use_channel: ["2"] } }));
  for (let k = 0; k < 570; k += 1) logs.push(errRow(id++, start + 60000 + Math.floor(k / 5) * 1000, { channel: 1 }));
  const { own, rt, requests } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  await store.startCursor("own", wholeSecondMs(start), NOW);
  await catchUp(errorIngest(rt, store, () => NOW), own);
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  const by = (channelId) => buckets.filter((b) => b.channelId === channelId).reduce((sum, b) => sum + b.count, 0);
  assert.equal(by(1) + by(2), 600, "摊完正好是 600");
  assert.ok(by(2) > 0, `渠道 2 的 30 条在最后一页，分层取页取得到（只取最新 3 页会是 0）：${by(2)}`);
  assert.ok(buckets.every((b) => b.sampled === 1));
  assert.deepEqual(errorReads(requests).filter((r) => r.start === wholeSecondMs(start) / 1000).map((r) => r.p), [1, 4, 6], "600 条 = 6 页：第 1、4、6 页，一共 3 个请求");
});

test("错误日志采样：窗口里不到 300 条（样本读全了）是实数；刚好 300 条也是实数；301 条就按样本摊成估算", async (t) => {
  resetOwnRequestBudget();
  const start = NOW - 30 * 60000, logs = []; let id = 1;
  for (let k = 0; k < 250; k += 1) logs.push(errRow(id++, start + 1000 + k)); // 窗口 1：250 条
  for (let k = 0; k < 300; k += 1) logs.push(errRow(id++, start + 301000 + k * 100, {}, { status_code: 503 })); // 窗口 2：刚好 300 条
  for (let k = 0; k < 301; k += 1) logs.push(errRow(id++, start + 601000 + k * 100, {}, { status_code: 502 })); // 窗口 3：301 条
  const { own, rt } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  await store.startCursor("own", wholeSecondMs(start), NOW);
  const ingest = errorIngest(rt, store, () => NOW);
  await catchUp(ingest, own);
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  const of = (status) => buckets.find((b) => b.status === status);
  assert.deepEqual([of(429).count, of(429).sampled], [250, 0]);
  assert.deepEqual([of(503).count, of(503).sampled], [300, 0], "刚好 3 页读全了：实数");
  assert.deepEqual([of(502).count, of(502).sampled], [301, 1], "301 条只读了 300 条样本：摊回 301，标估算");
});

test("错误日志共用请求额度和断路：额度被别的读取用掉时只走保底、断路期间一个请求都不发；断路好了接着读；出事的窗口下一轮从同一处接着读", async (t) => {
  resetOwnRequestBudget();
  const logs = [errRow(1, YESTERDAY_START + 600000)];
  let fail = null;
  const { own, rt, requests } = await fakeSite(t, logs, { failAt: () => fail });
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  await startBehind(store);
  const ingest = errorIngest(rt, store, () => NOW);
  for (let i = 0; i < OWN_RATE_LIMIT - INGEST_RESERVE; i += 1) noteOwnRequest(own.baseUrl + "/x", { status: 200, elapsedMs: 10, now: NOW });
  const starved = await ingest.ingestOnce(own);
  assert.ok(starved.pages <= INGEST_FLOOR_PER_MIN, `额度不够：只走保底 ${INGEST_FLOOR_PER_MIN} 页：${starved.pages}`);
  const covered = (await store.getCursor("own")).coveredToMs;
  resetOwnRequestBudget();
  fail = 429;
  const broken = await ingest.ingestOnce(own);
  assert.equal(broken.error, "UPSTREAM_REQUEST_FAILED");
  const sent = errorReads(requests).length;
  assert.equal((await ingest.ingestOnce(own)).skipped, "break", "断路期间不读");
  assert.equal(errorReads(requests).length, sent);
  assert.equal((await store.getCursor("own")).coveredToMs, covered, "出事的窗口没写");
  fail = null; resetOwnRequestBudget();
  assert.ok((await ingest.ingestOnce(own)).windows >= 1, "恢复后接着读");
});

test("上游大面积出错（每秒 50 条）：一个窗口只读 3 页样本、总数摊上去，进度不会被一场事故拖在原地；每轮最多 6 页", async (t) => {
  resetOwnRequestBudget();
  // 昨天 0 点起 5 分钟里每秒 50 条 = 15000 条（150 页）：只读 3 页，总数用 total（15000）
  const logs = []; let id = 1;
  for (let at = YESTERDAY_START; at < YESTERDAY_START + 300000; at += 1000) for (let k = 0; k < 50; k += 1) logs.push(errRow(id++, at, {}, { status_code: 529 }));
  const { own, rt, requests } = await fakeSite(t, logs);
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  await startBehind(store);
  const ingest = errorIngest(rt, store, () => NOW);
  const perRound = [];
  await catchUp(ingest, own, { each: (r) => perRound.push(r.pages || 0) });
  assert.ok(perRound.every((pages) => pages <= ERROR_KIND.limits.pagesBehind), `每轮页数：${perRound.join(",")}`);
  assert.deepEqual(errorReads(requests).filter((r) => r.start === YESTERDAY_START / 1000).map((r) => r.p), [1, 76, 150], "事故的那个窗口 150 页：只读第 1 页、中间页、最后一页");
  assert.equal((await store.getCursor("own")).coveredToMs, NOW - INGEST.LAG_MS, "追平了，没有被拖在原地");
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  assert.ok(buckets.every((b) => b.reason === "upstream" && b.status === 529 && b.sampled === 1), "529 是上游故障、估算");
  assert.equal(total(buckets), logs.length, "摊上去的总数正好是 15000");
});

test("错误日志清理 35 天前的桶；关→开传 justTurnedOn：进度比昨天 0 点还旧就挪到昨天 0 点，桶不删", async (t) => {
  resetOwnRequestBudget();
  const { own, rt } = await fakeSite(t, []);
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  const ingest = errorIngest(rt, store, () => NOW);
  await store.startCursor("own", NOW - 12 * 86400000, NOW);
  const slot = (ms) => Math.floor(ms / 3600000) * 3600000;
  const bucket = (ms, count) => ({ slotMs: slot(ms), channelId: 1, model: "m", group: "g", reason: "upstream", status: 503, attempt: 1, count });
  await store.applyWindow("own", { fromMs: NOW - 12 * 86400000, toMs: NOW - 12 * 86400000 + 1000, buckets: [bucket(NOW - 40 * 86400000, 3), bucket(NOW - 2 * 86400000, 2)] });
  const skipped = await ingest.ingestOnce(own, { justTurnedOn: true });
  assert.ok(skipped.skipChecked);
  const cursor = await store.getCursor("own");
  assert.equal(cursor.disabledFromMs, NOW - 12 * 86400000 + 1000, "跳过的缺口记下来");
  assert.ok(cursor.coveredToMs >= YESTERDAY_START);
  assert.equal((await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER)).length, 2, "桶不删");
  assert.equal(await ingest.pruneIfDue(), 1, "清掉 35 天前的那一个");
  assert.deepEqual((await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER)).map((b) => b.count), [2]);
});

const optionsReply = (items) => (send) => send(200, { success: true, data: items });
const retryOptions = (times, ranges) => [{ key: "RetryTimes", value: String(times) }, { key: "AutomaticRetryStatusCodes", value: ranges }, { key: "SomethingElse", value: "ignored" }];

test("站点的重试设置：读 GET /api/option/ 的 RetryTimes 和 AutomaticRetryStatusCodes，其余扔掉；1 小时内不重复读；没权限缓存 1 小时、读不到缓存 10 分钟并沿用上一次的；额度紧或断路不发请求", async (t) => {
  resetOwnRequestBudget();
  let mode = "ok", calls = 0;
  const { own, rt, requests } = await fakeSite(t, [], { options: (send) => { calls += 1; return mode === "ok" ? send(200, { success: true, data: retryOptions(3, "429，500-599") }) : mode === "denied" ? send(403, { success: false, message: "无权进行此操作，权限不足" }) : send(500, { success: false }); } });
  let now = NOW;
  const read = () => readRetrySettings(rt, own, { now });
  assert.deepEqual(await read(), { retryTimes: 3, retryRanges: [[429, 429], [500, 599]] });
  assert.deepEqual(cachedRetrySettings(rt, own), { retryTimes: 3, retryRanges: [[429, 429], [500, 599]] });
  assert.equal(requests.filter((r) => r.path === "/api/option/").length, 1);
  now += RETRY_SETTINGS_TTL_MS - 1000; await read();
  assert.equal(calls, 1, "1 小时内不重复读");
  mode = "denied"; now += 2000;
  assert.deepEqual(await read(), { retryTimes: 3, retryRanges: [[429, 429], [500, 599]] }, "过了 1 小时重读，没权限：沿用上一次读到的");
  assert.equal(calls, 2);
  now += RETRY_SETTINGS_TTL_MS - 1000; await read();
  assert.equal(calls, 2, "没权限也缓存 1 小时");
  mode = "fail"; now += 2000; resetOwnRequestBudget();
  await read();
  assert.equal(calls, 3);
  now += RETRY_SETTINGS_FAIL_TTL_MS - 1000; await read();
  assert.equal(calls, 3, "读不到缓存 10 分钟");
  mode = "ok"; now += 2000; resetOwnRequestBudget(); // 上一次 500 让断路器开了一会儿（真实时钟），这里时钟是假的
  assert.equal((await read()).retryTimes, 3);
  assert.equal(calls, 4, "10 分钟后再试");
  // 额度紧 / 断路：不发请求，沿用上一次的
  now += RETRY_SETTINGS_TTL_MS + 1000; resetOwnRequestBudget();
  for (let i = 0; i < OWN_RATE_LIMIT; i += 1) noteOwnRequest(own.baseUrl + "/x", { status: 200, elapsedMs: 10, now });
  assert.deepEqual(await read(), { retryTimes: 3, retryRanges: [[429, 429], [500, 599]] });
  assert.equal(calls, 4, "额度用满：不发");
  resetOwnRequestBudget(); noteOwnRequest(own.baseUrl + "/x", { status: 429, now });
  await read();
  assert.equal(calls, 4, "断路：不发");
});

test("站点没有这两项设置（版本太老）或没读到过：重试次数、范围是 null，按 rc.30 的默认；没有「没读到过」的缓存时 cachedRetrySettings 是 null", async (t) => {
  resetOwnRequestBudget();
  const { own, rt } = await fakeSite(t, [], { options: optionsReply([{ key: "Other", value: "1" }]) });
  assert.equal(cachedRetrySettings(rt, own), null);
  assert.deepEqual(await readRetrySettings(rt, own, { now: NOW }), { retryTimes: null, retryRanges: null });
  resetOwnRequestBudget();
  const bad = await fakeSite(t, [], { options: optionsReply(retryOptions("abc", 42)) });
  assert.deepEqual(await readRetrySettings(bad.rt, bad.own, { now: NOW }), { retryTimes: null, retryRanges: null }, "写得不对的当没有");
  resetOwnRequestBudget();
  const empty = await fakeSite(t, [], { options: optionsReply(retryOptions(0, "")) });
  assert.deepEqual(await readRetrySettings(empty.rt, empty.own, { now: NOW }), { retryTimes: 0, retryRanges: [] }, "重试 0 次、范围是空的：就是不重试，不当成没读到");
});

test("错误日志的「能不能重试」跟着站点的重试范围走：读得到范围就按它，读不到按默认；范围变了，没读完的暂存丢掉重读（口径变了不能混）", async (t) => {
  resetOwnRequestBudget();
  const logs = [errRow(1, YESTERDAY_START + 600000, {}, { status_code: 503 }), errRow(2, YESTERDAY_START + 600000, {}, { status_code: 429 })];
  const run = async (options) => {
    resetOwnRequestBudget();
    const site = await fakeSite(t, logs, { options });
    const store = new MemoryOwnLogStore(ERROR_SPEC);
    await startBehind(store);
    const ingest = errorIngest(site.rt, store, () => NOW);
    await catchUp(ingest, site.own);
    return (await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER)).map((b) => [b.status, b.retryable]).sort();
  };
  assert.deepEqual(await run(optionsReply(retryOptions(3, "429"))), [[429, 1], [503, 0]], "站点只重试 429：503 不能重试");
  assert.deepEqual(await run(optionsReply(retryOptions(3, "429,500-599"))), [[429, 1], [503, 1]]);
  assert.deepEqual(await run(undefined), [[429, 1], [503, 1]], "站点读不到设置：按默认范围，503 能重试");
  assert.deepEqual(await run((send) => send(403, { success: false, message: "无权" })), [[429, 1], [503, 1]], "没权限：同样按默认");
});

test("重试设置变了（口径指纹变了）：这一窗口没读完的暂存丢掉，下一轮从同一处重读", async (t) => {
  resetOwnRequestBudget();
  const start = NOW - 40 * 60000, logs = []; let id = 1;
  for (let at = start + 300000; at < start + 600000; at += 1000) for (let k = 0; k < 5; k += 1) logs.push(errRow(id++, at, {}, { status_code: 503 }));
  let ranges = "429,500-599";
  const { own, rt } = await fakeSite(t, logs, { options: (send) => send(200, { success: true, data: retryOptions(3, ranges) }) });
  const store = new MemoryOwnLogStore(ERROR_SPEC);
  await store.startCursor("own", wholeSecondMs(start), NOW);
  let now = NOW;
  const ingest = errorIngest(rt, store, () => now);
  let partial = null;
  for (let i = 0; i < 40 && !partial; i += 1) { resetOwnRequestBudget(); await ingest.ingestOnce(own); const pending = await store.getPending("own"); if (pending && pending.nextPage > 1) partial = pending; }
  assert.ok(partial, "停在窗口中间");
  ranges = "429"; now += RETRY_SETTINGS_TTL_MS + 1000; rt._ownRetrySettings.clear(); resetOwnRequestBudget();
  const changed = await ingest.ingestOnce(own);
  assert.equal(changed.error, "pending-classification-changed");
  assert.equal(await store.getPending("own"), null, "没读完的暂存丢了");
  await catchUp(ingest, own, { rounds: 80 });
  const buckets = await store.listBuckets("own", 0, Number.MAX_SAFE_INTEGER);
  assert.equal(total(buckets), logs.length, "重读以后每条只进一次（窗口里 1500 条，读 300 条样本摊回 1500）");
  const olderRows = logs.filter((log) => log.created_at * 1000 < partial.fromMs).length;
  assert.equal(buckets.filter((b) => b.retryable === 1).reduce((sum, b) => sum + b.count, 0), olderRows, "口径变之前已经读完入桶的窗口留着旧口径，没读完的窗口全按新口径（503 不能重试）重读");
  assert.ok(buckets.some((b) => b.retryable === 0));
});
