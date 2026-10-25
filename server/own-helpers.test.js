import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateFlow, computeFlowBreakdown, computeProfit, joinPrev, mapCostChannels, matchCostStation, normalizeCostUrl,
  getOwnUsers, readOwnIncome, readOwnIncomeOrUnconfirmed, reconcileUsageCost, resolveOwnWindow, selectCostUpstreams, stationUsageCost,
  ownUsersKey, unconfirmedIncomeProfit, resoldAdminKeysOf, dedupeResoldKeys, readOwnAdminDirectory,
} from "./own-helpers.js";
import { History } from "../db/history.js";
import { dayStartInTz } from "../lib/business-time.js";

function incomeFixture() {
  const own = { id: "own", name: "自营", type: "newapi", baseUrl: "https://own.test", accessToken: "test", cnyPerUsd: 7 };
  const users = [{ id: 1, username: "root", role: 100 }, { id: 2, username: "customer", role: 1 }];
  // 缓存是 1 秒前发出的那次读取（比这次请求早），对不上时会重读
  const rt = { _ownUsersCache: { key: ownUsersKey(own), startedAt: Date.now() - 1000, list: users, unknown: new Map() } };
  const startMs = dayStartInTz("2026-10-13", "Asia/Shanghai");
  const window = { startMs, endMs: startMs + 2 * 86400000, tz: "Asia/Shanghai" };
  const rows = [{ key: "root", t: startMs + 3600000, cost: 100 }, { key: "customer", t: startMs + 86400000 + 3600000, cost: 10 }];
  return { own, users, rt, window, rows };
}

test("逐日收入跟随真实用户消费，管理员自用日不分走销售日的收入", async () => {
  const f = incomeFixture();
  const result = await readOwnIncome(f.rt, f.own, f.rows, f.window);
  assert.equal(result.incomeUsd, 10);
  assert.equal(result.adminUsageUsd, 100);
  assert.deepEqual(result.incomeDaily, [{ date: "2026-10-13", incomeCny: 0 }, { date: "2026-10-14", incomeCny: 70 }]);
});

test("转售管理员 Key 按实际发生日计收入，窗口合计与分日相加一致", async (t) => {
  const f = incomeFixture();
  f.own.resoldAdminKeys = [{ username: "root", tokenName: "sale" }];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(url.pathname, "/api/log/stat");
    assert.equal(url.searchParams.get("username"), "root");
    assert.equal(url.searchParams.get("token_name"), "sale");
    return Response.json({ success: true, data: { quota: Number(url.searchParams.get("start_timestamp")) === f.window.startMs / 1000 ? 20 * 500000 : 0 } });
  });
  const result = await readOwnIncome(f.rt, f.own, f.rows, f.window);
  assert.equal(calls.length, 2);
  assert.equal(result.incomeUsd, 30);
  assert.equal(result.adminUsageUsd, 80);
  assert.equal(result.resold.resoldUsd, 20);
  assert.deepEqual(result.incomeDaily, [{ date: "2026-10-13", incomeCny: 140 }, { date: "2026-10-14", incomeCny: 70 }]);
  assert.equal(result.incomeDaily.reduce((sum, d) => sum + d.incomeCny, 0), 210);
});

test("1 元收入分成 7 天仍合计 1 元，不逐项舍入成 0.98 元", async () => {
  const f = incomeFixture();
  f.own.cnyPerUsd = 1;
  const rows = Array.from({ length: 7 }, (_, i) => ({ key: "customer", t: f.window.startMs + i * 86400000 + 1000, cost: 1 / 7 }));
  const result = await readOwnIncome(f.rt, f.own, rows, { ...f.window, endMs: f.window.startMs + 7 * 86400000 });
  assert.equal(Math.round(result.incomeDaily.reduce((sum, d) => sum + d.incomeCny, 0) * 100), 100);
  assert.ok(result.incomeDaily.every((d) => d.incomeCny === 0.14 || d.incomeCny === 0.15));
});

// 用户列表接口：返回 list 里的用户，记下读了几次
function mockUserList(t, list) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname === "/api/user/") return Response.json({ success: true, data: { items: list, total: list.length } });
    throw new Error(`unexpected path ${url.pathname}`);
  });
  return calls;
}

test("没读到消费用户的角色时不默认其为客户：先重读一次用户列表，还没有才算确认不了", async (t) => {
  const f = incomeFixture();
  f.rt._ownUsersCache.list = f.users.filter((u) => u.username !== "root");
  const calls = mockUserList(t, f.users.filter((u) => u.username !== "root"));
  await assert.rejects(readOwnIncome(f.rt, f.own, f.rows, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
  assert.deepEqual(calls, ["/api/user/"], "只重读一次");
});

test("缓存里没有的用户（刚注册就有消费）：重读一次用户列表后照常算收入，缓存也更新", async (t) => {
  const f = incomeFixture();
  const newbie = { id: 3, username: "newbie", role: 1 };
  const calls = mockUserList(t, [...f.users, newbie]);
  const rows = [...f.rows, { key: "newbie", t: f.window.startMs + 86400000 + 7200000, cost: 5 }];
  const result = await readOwnIncome(f.rt, f.own, rows, f.window);
  assert.equal(result.incomeUsd, 15);
  assert.deepEqual(calls, ["/api/user/"]);
  assert.ok(f.rt._ownUsersCache.list.some((u) => u.username === "newbie"));
  // 用户都在缓存里时不重读
  calls.length = 0;
  await readOwnIncome(f.rt, f.own, rows, f.window);
  assert.deepEqual(calls, []);
});

test("readOwnIncomeOrUnconfirmed：确认不了时不中止，收入是 null；用 readOwnIncome 那次的用户列表，不再读一次；读不到时给原因", async (t) => {
  // 用户列表读不到：只读了一次（不在外层再读一次），usersUnavailable 带底层原因
  const f = incomeFixture();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return Response.json({ success: false, message: "unavailable" }, { status: 503 }); });
  const lost = await readOwnIncomeOrUnconfirmed({}, f.own, f.rows, f.window);
  assert.equal(lost.unconfirmed.code, "OWN_INCOME_UNCONFIRMED");
  assert.deepEqual([lost.users, lost.incomeUsd, lost.adminUsageUsd, lost.resold, lost.incomeDaily, lost.adminSet.size], [null, null, null, null, null, 0]);
  assert.equal(calls, 1);
  // 原文只进「查看详细原因」；读不到的是自营站点，繁忙说成「自营站点暂时读不到」，不说成上游繁忙
  assert.deepEqual(lost.usersUnavailable, { error: "unavailable", errorCode: "OWN_STATION_UNAVAILABLE" });
  // 用户列表读得到、转售记录没读全：users 照常给出，管理员照常标
  f.own.resoldAdminKeys = [{ username: "root", tokenName: "sale" }];
  const partial = await readOwnIncomeOrUnconfirmed(f.rt, f.own, f.rows, f.window);
  assert.equal(partial.unconfirmed.code, "OWN_INCOME_UNCONFIRMED");
  assert.equal(partial.users.length, 2);
  assert.deepEqual([...partial.adminSet], ["root"]);
  assert.deepEqual([partial.incomeUsd, partial.usersUnavailable], [null, null]);
  // 确认得了时和 readOwnIncome 一样，unconfirmed 是 null
  f.own.resoldAdminKeys = [];
  const ok = await readOwnIncomeOrUnconfirmed(f.rt, f.own, f.rows, f.window);
  assert.deepEqual([ok.unconfirmed, ok.incomeUsd], [null, 10]);
});

// 用户列表接口，每次读取都等 gate 放行；lists 按读取的先后给（不够时用最后一个），host 给别的站点时用 other
function gatedUserList(t, lists, other = []) {
  const state = { calls: 0, release: null };
  let gate = new Promise((resolve) => { state.release = resolve; });
  state.open = () => { state.release(); gate = Promise.resolve(); };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/api/user/");
    const list = url.host === "own.test" ? lists[Math.min(state.calls, lists.length - 1)] : other;
    state.calls += 1;
    await gate;
    return Response.json({ success: true, data: { items: list, total: list.length } });
  });
  return state;
}

test("用户列表：同一份配置并发的读取共用一次；要更晚发出的读取时，等进行中的那次读完再发一次，错开到达的几个请求都跟这一次", async (t) => {
  const f = incomeFixture();
  let now = Date.parse("2026-10-14T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  const newbie = { id: 3, username: "newbie", role: 1 };
  const users = gatedUserList(t, [f.users, [...f.users, newbie]]);
  const rt = {};
  const first = getOwnUsers(rt, f.own), second = getOwnUsers(rt, f.own);
  const later = [];
  for (let i = 0; i < 3; i += 1) { now += 5; later.push(getOwnUsers(rt, f.own, { since: now })); }
  assert.equal(users.calls, 1, "进行中的那次还没读完，先等它");
  users.open();
  const lists = await Promise.all([first, second, ...later]);
  assert.equal(users.calls, 2, "错开到达的三个请求合成一次");
  assert.deepEqual(lists.map((list) => list.length), [2, 2, 3, 3, 3], "后到的拿到的是那之后发出的读取");
});

// 写错时（缓存只按站点 id 认）这里会一直等着旧地址那次读取：给个超时，让它失败而不是卡住
test("用户列表：自营站点换了地址，不跟着旧地址那次读取；旧的那次后读完也不写进缓存", { timeout: 5000 }, async (t) => {
  const f = incomeFixture();
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const hosts = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const { host } = new URL(input);
    hosts.push(host);
    if (host === "own.test") { await oldGate; return Response.json({ success: true, data: { items: f.users, total: 2 } }); }
    return Response.json({ success: true, data: { items: [{ id: 9, username: "other", role: 100 }], total: 1 } });
  });
  const rt = {}, moved = { ...f.own, baseUrl: "https://moved.test" };
  const old = getOwnUsers(rt, f.own);
  assert.deepEqual((await getOwnUsers(rt, moved)).map((u) => u.username), ["other"]);
  releaseOld();
  assert.deepEqual((await old).map((u) => u.username), ["root", "customer"]);
  assert.equal(rt._ownUsersCache.key, ownUsersKey(moved), "旧地址那次后读完，不覆盖新地址的缓存");
  await getOwnUsers(rt, moved);
  assert.deepEqual(hosts, ["own.test", "moved.test"], "新地址的缓存照常用");
});

test("一直对不上的用户名：重读一次，1 分钟内不再为它重读，过了 1 分钟再读；缓存刚过期时只读一次", async (t) => {
  const f = incomeFixture();
  let now = Date.parse("2026-10-14T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  const users = gatedUserList(t, [f.users]);
  users.open();
  f.rt._ownUsersCache.startedAt = now - 1000;
  const rows = [...f.rows, { key: "ghost", t: f.window.startMs + 7200000, cost: 3 }];
  await assert.rejects(readOwnIncome(f.rt, f.own, rows, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
  assert.equal(users.calls, 1);
  now += 30000;
  await assert.rejects(readOwnIncome(f.rt, f.own, rows, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
  assert.equal(users.calls, 1, "1 分钟内不再为 ghost 重读");
  now += 31000;
  await assert.rejects(readOwnIncome(f.rt, f.own, rows, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
  assert.equal(users.calls, 2, "过了 1 分钟再读一次（在 New API 改好后点「刷新」最多等 1 分钟）");
  // 缓存过期：这次发出的读取就是最新的，不再强制重读第二次
  now += 600001;
  await assert.rejects(readOwnIncome(f.rt, f.own, rows, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
  assert.equal(users.calls, 3, "缓存过期时只读一次");
  // 新读取带上上一份还没过期的名字：先为 ghost 重读、20 秒后为 ghost2 重读，再看 ghost 时不用又读一次
  now += 120000;
  const ghost2 = [...f.rows, { key: "ghost2", t: f.window.startMs + 7200000, cost: 3 }];
  await assert.rejects(readOwnIncome(f.rt, f.own, rows, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
  assert.equal(users.calls, 4);
  now += 20000;
  await assert.rejects(readOwnIncome(f.rt, f.own, ghost2, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
  assert.equal(users.calls, 5);
  now += 10000;
  await assert.rejects(readOwnIncome(f.rt, f.own, rows, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
  assert.equal(users.calls, 5, "ghost 在新读取里也记着，不再为它重读");
  // 窗口外、消费为 0 的陌生用户不触发重读
  now += 120000;
  const quiet = [...f.rows, { key: "zero", t: f.window.startMs + 3600000, cost: 0 }, { key: "outside", t: f.window.endMs + 3600000, cost: 9 }];
  await readOwnIncome(f.rt, f.own, quiet, f.window);
  assert.equal(users.calls, 5);
});

test("跟着别人进行中的读取拿到的列表比这次请求早：缺了刚注册的用户就再读一次，照常算出收入", async (t) => {
  const f = incomeFixture();
  let now = Date.parse("2026-10-14T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  const newbie = { id: 3, username: "newbie", role: 1 };
  const users = gatedUserList(t, [f.users, [...f.users, newbie]]);
  const rt = {};
  // 请求 A 发出读取时 newbie 还没注册；请求 B 拿到了 newbie 的消费，跟着 A 那次读取
  const a = readOwnIncome(rt, f.own, f.rows, f.window);
  now += 1000;
  const rows = [...f.rows, { key: "newbie", t: f.window.startMs + 86400000 + 7200000, cost: 5 }];
  const b = readOwnIncome(rt, f.own, rows, f.window);
  users.open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.incomeUsd, 10);
  assert.equal(rb.incomeUsd, 15);
  assert.equal(users.calls, 2);
});

test("重读用户列表没成：还用手里那份标管理员、算预收，只说收入确认不了", async (t) => {
  const f = incomeFixture();
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: false, message: "unavailable" }, { status: 503 }));
  const rows = [...f.rows, { key: "newbie", t: f.window.startMs + 7200000, cost: 5 }];
  const result = await readOwnIncomeOrUnconfirmed(f.rt, f.own, rows, f.window);
  assert.equal(result.unconfirmed.code, "OWN_INCOME_UNCONFIRMED");
  assert.equal(result.users.length, 2);
  assert.deepEqual([...result.adminSet], ["root"]);
  assert.equal(result.usersUnavailable, null);
});

test("转售 Key 所属的用户在缓存里还不是管理员（刚提成管理员）：先重读一次用户列表，读到是管理员就照常算", async (t) => {
  const f = incomeFixture();
  f.own.resoldAdminKeys = [{ username: "seller", tokenName: "sale" }];
  f.rt._ownUsersCache.list = [...f.users, { id: 4, username: "seller", role: 1 }];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname === "/api/user/") return Response.json({ success: true, data: { items: [...f.users, { id: 4, username: "seller", role: 10 }], total: 3 } });
    if (url.pathname === "/api/log/stat") return Response.json({ success: true, data: { quota: 0 } });
    throw new Error(`unexpected path ${url.pathname}`);
  });
  const result = await readOwnIncome(f.rt, f.own, f.rows, f.window);
  assert.equal(result.incomeUsd, 10);
  assert.equal(calls.filter((path) => path === "/api/user/").length, 1);
});

test("转售 Key 所属账号已经不是管理员：重读一次还对不上就忽略这条标记，不报读不到，照常算收入；设置页列出来标 inactive", async (t) => {
  const f = incomeFixture();
  f.own.resoldAdminKeys = [{ username: "customer", tokenName: "sale" }];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname === "/api/user/") return Response.json({ success: true, data: { items: f.users, total: 2 } }); // 重读一次，还是普通用户
    throw new Error(`不该读转售记录：标记不起作用，没有要读的 Key（${url.pathname}）`);
  });
  const result = await readOwnIncome(f.rt, f.own, f.rows, f.window);
  assert.equal(calls.filter((path) => path === "/api/user/").length, 1, "先重读了一次用户列表");
  assert.equal(result.incomeUsd, 10, "customer 的消费本来就算收入");
  assert.equal(result.adminUsageUsd, 100);
  assert.equal(result.resold.resoldUsd, 0);
  assert.deepEqual(result.resold.breakdown, [{ username: "customer", tokenName: "sale", usd: 0, inactive: true }]);
});

test("必要的角色或转售读取失败时收入不可确认", async (t) => {
  const f = incomeFixture();
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: false, message: "unavailable" }, { status: 503 }));
  await assert.rejects(readOwnIncome({}, f.own, f.rows, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
  f.own.resoldAdminKeys = [{ username: "root", tokenName: "sale" }];
  // 转售记录没读到：原因里说是哪把 Key，没读到的那几把随报错带出去（「利润怎么算」里标出来）
  await assert.rejects(readOwnIncome(f.rt, f.own, f.rows, f.window), (err) => {
    assert.equal(err.code, "OWN_INCOME_UNCONFIRMED");
    assert.match(err.message, /转售 Key「root \/ sale」的记录没读到/);
    // 读不到的是自营站点的转售记录：503 说「自营站点暂时读不到」（lib/error-copy.js ownStationErrorCode）
    assert.deepEqual(err.resoldErrors.map((k) => [k.username, k.tokenName, typeof k.error, k.errorCode]), [["root", "sale", "string", "OWN_STATION_UNAVAILABLE"]]);
    return true;
  });
});

test("转售记录 HTTP200 但金额缺失时不能当成零收入", async (t) => {
  const f = incomeFixture();
  f.own.resoldAdminKeys = [{ username: "root", tokenName: "sale" }];
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: {} }));
  await assert.rejects(readOwnIncome(f.rt, f.own, f.rows, f.window), { code: "OWN_INCOME_UNCONFIRMED" });
});

test("多个转售 Key 跨多日读取时整个窗口最多四个并发请求", async (t) => {
  const f = incomeFixture();
  f.own.resoldAdminKeys = Array.from({ length: 5 }, (_, i) => ({ username: "root", tokenName: `sale-${i}` }));
  let active = 0, maxActive = 0, calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    active++; calls++; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return Response.json({ success: true, data: { quota: 0 } });
  });
  await readOwnIncome(f.rt, f.own, f.rows, { ...f.window, endMs: f.window.startMs + 7 * 86400000 });
  assert.equal(calls, 35);
  assert.equal(maxActive, 4);
});

test("实际分日收入保留负向调整，仍与整窗金额守恒", async () => {
  const f = incomeFixture();
  f.own.cnyPerUsd = 1;
  const rows = [{ key: "customer", t: f.window.startMs + 1000, cost: 1 }, { key: "customer", t: f.window.startMs + 86400000 + 1000, cost: -0.25 }];
  const result = await readOwnIncome(f.rt, f.own, rows, f.window);
  assert.equal(result.incomeUsd, 0.75);
  assert.deepEqual(result.incomeDaily.map((d) => d.incomeCny), [1, -0.25]);
});

test("成本渠道支持主地址、api 后缀和显式别名匹配", () => {
  const publicStation = { id: "public", baseUrl: "https://relay.example.com/" };
  const internalStation = {
    id: "internal",
    baseUrl: "https://public.example.com",
    costAliases: ["sub2api-internal", "http://10.0.0.8:8080/api/"],
  };

  assert.equal(normalizeCostUrl(" HTTPS://Relay.Example.com/ "), "relay.example.com");
  assert.equal(matchCostStation([publicStation], "https://relay.example.com/api"), publicStation);
  assert.equal(matchCostStation([internalStation], "http://sub2api-internal/v1"), internalStation);
  assert.equal(matchCostStation([internalStation], "http://10.0.0.8:8080"), internalStation);
  assert.equal(matchCostStation([publicStation], "https://other.example.com"), null);
});

test("用量接口返回零但余额下降时改用历史成本", () => {
  assert.deepEqual(reconcileUsageCost(0, 34.24), {
    usd: 34.24,
    mode: "history",
    note: "用量是 0，改按余额变化估算",
  });
});

test("未出现在 New API 渠道中的监控上游仍计入成本", () => {
  const own = { id: "own", isOwn: true };
  const visible = { id: "visible", baseUrl: "https://visible.example.com" };
  const behindSub2Api = { id: "hidden", baseUrl: "https://hidden.example.com" };
  const excluded = { id: "observe", baseUrl: "https://observe.example.com", includeInProfit: false };
  const channels = [{ name: "Sub2API 统一入口", baseUrl: "http://sub2api-internal", status: 1, type: 1 }];

  const selected = selectCostUpstreams([own, visible, behindSub2Api, excluded], own.id);
  assert.deepEqual(selected.included.map((s) => s.id), [visible.id, behindSub2Api.id]);
  assert.deepEqual(selected.excluded.map((s) => s.id), [excluded.id]);

  const attribution = mapCostChannels(selected.included, channels);
  assert.equal(attribution.matched.size, 0);
  assert.equal(attribution.unmatched.size, 1);
});

test("账单专用授权硬排除成本，不能被 includeInProfit 覆盖", () => {
  const own = { id: "own", isOwn: true };
  const grant = { id: "grant", monitorEnabled: false, includeInProfit: true };
  const monitored = { id: "monitored", includeInProfit: true };
  const result = selectCostUpstreams([own, grant, monitored], own.id);
  assert.deepEqual(result.included, [monitored]);
  assert.deepEqual(result.excluded, []);
});

test("读不到用量时改按余额历史，并带上报错的码", async () => {
  const rt = { history: { usedBetween: () => 1.5 } };
  const window = { startMs: 0, endMs: 86_400_000, tz: "Asia/Shanghai" };
  const keyOnly = await stationUsageCost(rt, { id: "k", type: "newapi-key", baseUrl: "https://key.test", apiKey: "sk-x" }, window);
  assert.equal(keyOnly.usd, 1.5);
  assert.equal(keyOnly.mode, "history");
  assert.equal(keyOnly.errorCode, "UPSTREAM_FEATURE_UNSUPPORTED");
  const unknown = await stationUsageCost(rt, { id: "u", type: "mystery", baseUrl: "https://u.test" }, window);
  assert.equal(unknown.errorCode, "UNSUPPORTED_UPSTREAM_TYPE");
});

test("用量接口有有效成本时保持接口口径", () => {
  assert.deepEqual(reconcileUsageCost(4.1675, 4.16), {
    usd: 4.1675,
    mode: "usage",
    note: null,
  });
});

test("流向数据按维度聚合并与上一等长窗口对比", () => {
  const cur = [
    { user: "a", group: "grok", model: "grok-4.6", channelId: 7, channelName: "sol", tokens: 100, cost: 152, requests: 596 },
    { user: "b", group: "default", model: "gpt-4o", channelId: 1, channelName: "luna", tokens: 900, cost: 20, requests: 30 },
  ];
  const prev = [
    { user: "a", group: "grok", model: "grok-4.6", channelId: 7, channelName: "sol", tokens: 90, cost: 11, requests: 49 },
  ];
  const byGroup = joinPrev(
    aggregateFlow(cur, (r) => r.group, "group"),
    aggregateFlow(prev, (r) => r.group, "group"),
    "group"
  );
  assert.deepEqual(byGroup.map((r) => [r.group, r.cost, r.prevCost, r.deltaPct, r.isNew]), [
    ["grok", 152, 11, 1281.8, false],
    ["default", 20, 0, null, true],
  ]);

  // 空维度值（没有分组的行）不参与聚合，否则会多出一行「」
  assert.equal(aggregateFlow([{ group: "", tokens: 1, cost: 1, requests: 1 }], (r) => r.group, "group").length, 0);
});

test("展示窗口的上一窗与当窗等长且左移整窗", () => {
  const sp = new URLSearchParams({ range: "7d", tz: "Asia/Shanghai" });
  const w = resolveOwnWindow(sp);
  assert.equal(w.range, "7d");
  assert.equal(w.spanDays, 7);
  assert.equal(w.startMs - w.prevStart, 7 * 86400000);
  assert.equal(w.now - w.startMs, w.prevEnd - w.prevStart);

  const today = resolveOwnWindow(new URLSearchParams({ range: "today", tz: "Asia/Shanghai" }));
  assert.equal(today.startMs - today.prevStart, 86400000); // 今天 → 昨天同一时刻为止
});

test("展示窗口统一按业务时区划日，不跟随浏览器传来的 tz", () => {
  const now = Date.UTC(2026, 9, 14, 2, 30); // 北京时间 10 月 14 日 10:30，洛杉矶仍是 13 日
  const fromBrowser = resolveOwnWindow(new URLSearchParams({ range: "today", tz: "America/Los_Angeles" }), now);
  const plain = resolveOwnWindow(new URLSearchParams({ range: "today" }), now);
  assert.equal(fromBrowser.tz, "Asia/Shanghai");
  assert.equal(fromBrowser.startMs, Date.UTC(2026, 9, 13, 16));
  assert.deepEqual(fromBrowser, plain);
  assert.equal(resolveOwnWindow(new URLSearchParams({ range: "nope" }), now).range, "7d");
});

test("利润拆成毛利与净利：固定付费上游只按摊销计，余额推算截止到窗口终点", async () => {
  const SH = "Asia/Shanghai";
  const startMs = dayStartInTz("2026-10-13", SH);
  const now = startMs + 86400000; // 日报口径：算完整的 10 月 13 日
  const own = { id: "own", name: "自营", isOwn: true, type: "newapi", cnyPerUsd: 2 };
  // newapi-key 没有用量明细接口，会直接退回余额历史，不发网络请求
  const usage = { id: "u", name: "按量上游", type: "newapi-key", cnyPerUsd: 7 };
  const fixed = {
    id: "f", name: "包月上游", type: "newapi-key", cnyPerUsd: 7,
    fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-10-01" }],
  };
  const history = new History({ query: async () => [[]] });
  history.data.u = [[startMs - 1000, 10], [startMs + 3600000, 9], [now - 1000, 8], [now + 3600000, 5]];
  // 包月上游的余额下降不能再算一遍成本
  history.data.f = [[startMs - 1000, 10], [startMs + 3600000, 4]];
  const rt = {
    store: { list: () => [own, usage, fixed] },
    history,
    _ownChannelsCache: { at: Date.now(), stationId: "own", list: [] },
  };
  const p = await computeProfit(rt, own, 50, 0, { startMs, now, tz: SH, range: "7d", resold: null });
  assert.equal(p.error, undefined);
  assert.equal(p.incomeCny, 100);
  // 只计到 now 为止：10 → 8，今天的 8 → 5 不算
  assert.equal(p.upstreamCostCny, 14);
  assert.equal(p.fixedCostCny, 10);
  assert.equal(p.grossProfitCny, 86);
  assert.equal(p.netProfitCny, 76);
  assert.equal(p.grossMarginPct, 86);
  assert.equal(p.netMarginPct, 76);
  // 旧字段保持兼容：利润即净利
  assert.equal(p.totalCostCny, 24);
  assert.equal(p.profitCny, 76);
  assert.equal(p.marginPct, 76);
  assert.deepEqual(p.costs.map((c) => [c.stationId, c.mode]), [["u", "history"], ["f", "fixed"]]);
  const f = p.costs.find((c) => c.mode === "fixed");
  assert.deepEqual([f.active, f.expired, f.upcoming, f.total], [1, 0, 0, 1]);
  assert.deepEqual(p.costs.map((c) => c.channels), [["没有对上的渠道"], ["没有对上的渠道"]]);
  assert.deepEqual(p.warningCodes, ["estimated_cost"]);
  assert.deepEqual(p.warnings, ["1 个上游按余额变化估算"]);
  assert.deepEqual(p.rateUnsetStations, []);
  assert.equal(p.complete, true);
});

test("利润提示：售价和汇率分开说，按码返回，没设置汇率的上游单独列出", async () => {
  const SH = "Asia/Shanghai";
  const startMs = dayStartInTz("2026-10-13", SH);
  const now = startMs + 86400000;
  const own = { id: "own", name: "自营", isOwn: true, type: "newapi" };
  const usage = { id: "u", name: "按量上游", type: "newapi-key", baseUrl: "https://u.test" };
  const rated = { id: "r", name: "有汇率", type: "newapi-key", cnyPerUsd: 7 };
  // 固定成本不用汇率，没设置也不提
  const fixed = { id: "f", name: "包月上游", type: "newapi-key", fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-09-01" }] };
  const off = { id: "x", name: "不算的上游", type: "newapi-key", includeInProfit: false };
  const history = new History({ query: async () => [[]] });
  history.data.u = [[startMs - 1000, 10], [now - 1000, 9]];
  const channels = [
    { name: "直连", baseUrl: "", status: 1, type: 1 },
    { name: "直连 2", baseUrl: "", status: 1, type: 14 },
    { name: "u 渠道", baseUrl: "https://u.test", status: 1, type: 1 },
  ];
  const rt = { store: { list: () => [own, usage, rated, fixed, off] }, history, _ownChannelsCache: { at: Date.now(), stationId: "own", list: channels } };
  const p = await computeProfit(rt, own, 10, 0, { startMs, now, tz: SH, range: "7d", resold: null });
  assert.equal(p.error, undefined);
  assert.deepEqual(p.warningCodes, ["unmatched_channels", "estimated_cost", "sell_price_unset", "rate_unset", "excluded_upstreams"]);
  assert.deepEqual(p.warnings, [
    "2 个在用的渠道没对上上游；已添加的上游照常算成本",
    "2 个上游按余额变化估算",
    "自营 没设置售价，暂按 1 美元额度 = 1 元算",
    "按量上游 没设置汇率，暂按 1 美元 = 1 元算",
    "不算的上游 不算进利润",
  ]);
  assert.deepEqual(p.rateUnsetStations, [{ id: "u", name: "按量上游" }]);
  assert.equal(p.complete, false);
  // 官方渠道不分类型合成一行
  assert.deepEqual(p.unmatched.map((u) => [u.label, u.enabled, u.total]), [["官方渠道", 2, 2]]);
  const f = p.costs.find((c) => c.mode === "fixed");
  assert.deepEqual([f.active, f.expired, f.upcoming, f.total, f.note], [0, 1, 0, 1, "已到期"]);
  assert.deepEqual(p.costs.find((c) => c.stationId === "u").channels, ["u 渠道"]);
});

test("收入确认不了时的利润：两项成本照常算，收入、管理员自用、转售、毛利、净利都是 null；转售 Key 照常列出；原因带底层原文", async () => {
  const SH = "Asia/Shanghai";
  const startMs = dayStartInTz("2026-10-13", SH);
  const now = startMs + 86400000;
  const own = { id: "own", name: "自营", isOwn: true, type: "newapi", cnyPerUsd: 2, resoldAdminKeys: [{ username: "root", tokenName: "sale" }] };
  const fixed = { id: "f", name: "包月上游", type: "newapi-key", cnyPerUsd: 7, fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-10-01" }] };
  const history = new History({ query: async () => [[]] });
  const rt = { store: { list: () => [own, fixed] }, history, _ownChannelsCache: { at: Date.now(), stationId: "own", list: [] } };
  const err = Object.assign(new Error("转售记录没读全，收入和利润暂时算不出", { cause: new Error("HTTP 503 stat unavailable") }), { code: "OWN_INCOME_UNCONFIRMED" });
  const p = await unconfirmedIncomeProfit(rt, own, err, { startMs, now, tz: SH, range: "7d" });
  assert.equal(p.error, undefined);
  assert.equal(p.fixedCostCny, 10);
  assert.equal(p.upstreamCostCny, 0);
  for (const key of ["incomeCny", "adminUsageCny", "resoldCny", "grossProfitCny", "netProfitCny", "grossMarginPct", "netMarginPct", "profitCny", "marginPct"]) assert.equal(p[key], null, key);
  assert.deepEqual(p.resoldKeys, [{ username: "root", tokenName: "sale", usd: null, cny: null }]);
  assert.equal(p.incomeUnconfirmed.errorCode, "OWN_INCOME_UNCONFIRMED");
  assert.match(p.incomeUnconfirmed.error, /HTTP 503 stat unavailable/);
  // 没读到的那把转售 Key 带上报错；只关乎收入的提示（没设置售价）不说，别的照常
  // 同一账号两把转售 Key，只有 sale 没读到；自营站点没设置售价，另有一个不算进利润的上游
  const unpriced = { ...own, cnyPerUsd: null, resoldAdminKeys: [{ username: "root", tokenName: "sale" }, { username: "root", tokenName: "promo" }] };
  const skipped = { id: "skip", name: "不算的上游", type: "newapi", includeInProfit: false };
  const withSkipped = { ...rt, store: { list: () => [unpriced, fixed, skipped] } };
  const failedKey = Object.assign(new Error("转售 Key「root / sale」的记录没读到"), { code: "OWN_INCOME_UNCONFIRMED",
    resoldErrors: [{ username: "root", tokenName: "sale", usd: 0, error: "HTTP 503 stat unavailable", errorCode: "UPSTREAM_REQUEST_FAILED" }] });
  const full = await computeProfit(withSkipped, unpriced, 0, 0, { startMs, now, tz: SH, range: "7d", resold: null });
  assert.deepEqual(full.warningCodes, ["sell_price_unset", "excluded_upstreams"]);
  assert.equal(full.complete, false);
  const q = await unconfirmedIncomeProfit(withSkipped, unpriced, failedKey, { startMs, now, tz: SH, range: "7d" });
  assert.deepEqual(q.resoldKeys, [
    { username: "root", tokenName: "sale", usd: null, cny: null, error: "HTTP 503 stat unavailable", errorCode: "UPSTREAM_REQUEST_FAILED" },
    { username: "root", tokenName: "promo", usd: null, cny: null },
  ]);
  // 去掉售价那条以后，提示的文字和码还是一一对上
  assert.deepEqual([q.warnings, q.warningCodes], [["不算的上游 不算进利润"], ["excluded_upstreams"]]);
  assert.equal(q.complete, true, "没设置售价只影响收入，不算数据不完整");
  // 成本也算不出：整块报错，收入确认不了的原因照样带着
  const broken = { ...rt, store: { list: () => { throw new Error("store down"); } } };
  const both = await unconfirmedIncomeProfit(broken, own, err, { startMs, now, tz: SH, range: "7d" });
  assert.match(both.error, /store down/);
  assert.equal(both.incomeUnconfirmed.errorCode, "OWN_INCOME_UNCONFIRMED");
});


test("读自营站点没成时说自营站点：通用的繁忙、连不上和认不出的是「自营站点暂时读不到」，内容不对的另说，有自己那句话的照旧", async (t) => {
  const own = { id: "own", type: "newapi", isOwn: true, name: "Own", baseUrl: "https://own.example", accessToken: "t", cnyPerUsd: 1 };
  const rt = { store: { list: () => [own] }, history: new History({ query: async () => [[]] }) };
  let reply;
  t.mock.method(globalThis, "fetch", async () => reply());
  const window = { startMs: Date.parse("2026-10-07T16:00:00Z"), now: Date.parse("2026-10-08T16:00:00Z"), tz: "Asia/Shanghai", range: "7d", resold: null };
  const fail = (status, message = "unavailable") => () => Response.json({ success: false, message }, { status });
  // [情况, 回复, 利润（读渠道列表）的码, 分组和渠道数据的码]
  const cases = [
    ["503", fail(503), "OWN_STATION_UNAVAILABLE", "OWN_STATION_UNAVAILABLE"],
    ["连不上", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }, "OWN_STATION_UNAVAILABLE", "OWN_STATION_UNAVAILABLE"],
    ["认不出", fail(200, "something odd happened"), "OWN_STATION_UNAVAILABLE", "OWN_STATION_UNAVAILABLE"],
    ["登录信息过期", fail(401, "unauthorized"), "AUTHENTICATION_FAILED", "AUTHENTICATION_FAILED"],
    // 404：渠道列表说「地址或类型可能不对」，旧版 New API 没有分组和渠道数据接口说「对方的版本不支持」
    ["404", fail(404, "not found"), "ENDPOINT_MISMATCH", "UPSTREAM_FEATURE_UNSUPPORTED"],
  ];
  for (const [name, answer, profitCode, flowCode] of cases) {
    reply = answer;
    delete rt._ownChannelsCache;
    const profit = await computeProfit(rt, own, 0, 0, window);
    assert.equal(profit.errorCode, profitCode, `利润：${name}`);
    const flow = await computeFlowBreakdown(own, { startMs: window.startMs, endMs: window.now, prevStartMs: window.startMs - 86400000, prevEndMs: window.startMs, totalCostUsd: 0 });
    assert.equal(flow.errorCode, flowCode, `分组和渠道数据：${name}`);
  }
  // 渠道列表返回一张网页（登录页、防火墙页）：说「自营站点返回的内容不对」，不说成上游的问题
  reply = () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
  delete rt._ownChannelsCache;
  assert.equal((await computeProfit(rt, own, 0, 0, window)).errorCode, "OWN_STATION_RESPONSE_INVALID");
});

test("利润说明里的名字用显示名：自营站点、上游没起名字时写「自营站点」「未命名上游」，句子不缺主语", async () => {
  const SH = "Asia/Shanghai";
  const startMs = dayStartInTz("2026-10-13", SH);
  const now = startMs + 86400000;
  const own = { id: "own", type: "newapi", isOwn: true, name: "", baseUrl: "https://own.example", accessToken: "t", cnyPerUsd: null };
  // newapi-key 没有用量明细接口，直接按余额变化估算，不发网络请求
  const unnamed = { id: "u", name: " ", type: "newapi-key", cnyPerUsd: null };
  const skipped = { id: "s", name: "", type: "newapi-key", cnyPerUsd: 7, includeInProfit: false };
  const history = new History({ query: async () => [[]] });
  history.data.u = [[startMs - 1000, 10], [startMs + 3600000, 9]];
  const rt = { store: { list: () => [own, unnamed, skipped] }, history, _ownChannelsCache: { at: Date.now(), stationId: "own", list: [] } };
  const p = await computeProfit(rt, own, 5, 0, { startMs, now, tz: SH, range: "7d", resold: null });
  assert.equal(p.error, undefined);
  assert.ok(p.warnings.includes("自营站点 没设置售价，暂按 1 美元额度 = 1 元算"), p.warnings.join(" | "));
  assert.ok(p.warnings.includes("未命名上游 没设置汇率，暂按 1 美元 = 1 元算"), p.warnings.join(" | "));
  assert.ok(p.warnings.includes("未命名上游 不算进利润"), p.warnings.join(" | "));
});

test("转售 Key 同一个账号下同名只算一把（大小写不分）：存了两条也只扣回一次（审核 R1 中-1、低-5）", () => {
  const keys = [{ username: "root", tokenName: "sale" }, { username: "root", tokenName: "sale" }, { username: "Root", tokenName: "SALE" }, { username: "root", tokenName: "other" }, { username: "alice", tokenName: "sale" }];
  assert.deepEqual(resoldAdminKeysOf({ resoldAdminKeys: keys }).map((key) => [key.username, key.tokenName]), [["root", "sale"], ["root", "other"], ["alice", "sale"]]);
  assert.deepEqual(dedupeResoldKeys(null), []);
});

test("转售 Key 的主人不是管理员：重读过还对不上，1 分钟内不再为它重读整份用户列表（审核 R1 中-2）", async (t) => {
  const f = incomeFixture();
  f.own.resoldAdminKeys = [{ username: "customer", tokenName: "sale" }];
  let userReads = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/api/user/");
    userReads += 1;
    return Response.json({ success: true, data: { items: f.users, total: f.users.length } });
  });
  for (let i = 0; i < 5; i += 1) await readOwnAdminDirectory(f.rt, f.own);
  assert.ok(userReads <= 1, `5 次只读了 ${userReads} 次用户列表`);
});

test("结账（带 fresh）读用户列表：转售 Key 的主人不是管理员时，每次只读一份新的，不为同一个名字再重读一遍（审核 R1 第三轮中-2）", async (t) => {
  const f = incomeFixture();
  f.own.resoldAdminKeys = [{ username: "customer", tokenName: "sale" }];
  let userReads = 0;
  t.mock.method(globalThis, "fetch", async () => { userReads += 1; return Response.json({ success: true, data: { items: f.users, total: f.users.length } }); });
  for (let i = 0; i < 5; i += 1) await readOwnAdminDirectory(f.rt, f.own, { fresh: true });
  assert.ok(userReads <= 5, `5 次各读一份新的，一共不超过 5 次（以前是 10 次）：${userReads}`);
});
