import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { queryAdminTokens, queryKeyReconciliationStat, queryNewApiReconciliationMetadata, queryOwnChannels, queryReconciliationMetadata, queryStation } from "./providers.js";

test("渠道目录 HTTP 和业务错误回显本次 PAT 时，凭证轮换后的公开拒绝仍脱敏", async (t) => {
  const secret = "fixture-own-pat";
  let station, status = 500;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    station.accessToken = "replacement-pat";
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, message: `request rejected for ${secret}` }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (status of [500, 200]) {
    station = { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: `Bearer ${secret}` };
    await assert.rejects(queryOwnChannels(station), (error) => {
      assert.match(error.message, /已隐藏/);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("replacement-pat"), false);
      return true;
    });
  }
});

test("渠道目录网络错误脱敏本次 PAT 并保留错误码", async (t) => {
  const station = { baseUrl: "https://own.invalid", accessToken: "fixture-network-pat" };
  t.mock.method(globalThis, "fetch", async () => {
    const secret = station.accessToken;
    station.accessToken = "replacement-network-pat";
    throw Object.assign(new Error(`request failed for ${secret}`), { code: "ECONNRESET" });
  });
  await assert.rejects(queryOwnChannels(station), (error) => {
    assert.match(error.message, /已隐藏/);
    assert.equal(error.message.includes("fixture-network-pat"), false);
    assert.equal(error.code, "ECONNRESET");
    return true;
  });
});

test("发现渠道保留本站分组，同时不返回渠道调用密钥", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ status: 200, text: async () => JSON.stringify({ success: true,
    data: { total: 1, items: [{ id: 9, name: "supplier", base_url: "https://up.example", group: "sales-a, sales-b,sales-a,", key: "secret-call-key" }] },
  }) }));
  const [channel] = await queryOwnChannels({ baseUrl: "https://own.test", accessToken: "test-token" });
  assert.deepEqual(channel.groups, ["sales-a", "sales-b"]);
  assert.equal(channel.baseUrl, "https://up.example");
  assert.equal(JSON.stringify(channel).includes("secret-call-key"), false);
});

test("本站渠道超过 500 条时仍能拉到最后一页的新渠道", async (t) => {
  const requestedPages = [];
  const idSorts = new Set();
  t.mock.method(globalThis, "fetch", async (url) => {
    const page = Number(new URL(url).searchParams.get("p"));
    requestedPages.push(page);
    idSorts.add(new URL(url).searchParams.get("id_sort"));
    // 新版 NewAPI 把 p<1 当成第 1 页。
    const start = (Math.max(page, 1) - 1) * 100;
    const items = Array.from({ length: Math.max(0, Math.min(100, 501 - start)) }, (_, index) => ({
      id: start + index + 1,
      name: start + index === 500 ? "小福星-awsb_3-2.9" : `渠道 ${start + index + 1}`,
      status: 1,
    }));
    return { status: 200, text: async () => JSON.stringify({ success: true, data: { total: 501, items } }) };
  });

  const channels = await queryOwnChannels({ baseUrl: "https://own.test", accessToken: "test-token" });
  assert.equal(channels.length, 501);
  assert.equal(channels.totalValidated, true);
  assert.equal(channels.catalogueTotal, 501);
  assert.deepEqual(channels.at(-1), { id: 501, name: "小福星-awsb_3-2.9", type: 0, status: 1, baseUrl: "", groups: [] });
  assert.deepEqual(channels.map((channel) => channel.id), Array.from({ length: 501 }, (_, index) => index + 1));
  assert.deepEqual(requestedPages, [0, 2, 3, 4, 5, 6], "新版 p=0 已是第 1 页，不能再请求重复的 p=1");
  assert.deepEqual([...idSorts], ["true"], "每一页都要按 id 排序，翻页期间调整渠道优先级不能漏页或重页");
});

test("本站渠道目录缺页或格式错误时明确报错，不把部分列表当成完整列表", async (t) => {
  let malformed = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    const page = Number(new URL(url).searchParams.get("p"));
    const data = malformed ? {} : { total: 101, items: page <= 1
      ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `渠道 ${index + 1}` }))
      : [] };
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });
  const station = { baseUrl: "https://own.test", accessToken: "test-token" };

  await assert.rejects(() => queryOwnChannels(station), /分页不完整/);
  malformed = true;
  await assert.rejects(() => queryOwnChannels(station), /列表格式异常/);
});

test("旧版渠道目录没有 total 且每页不足 100 条时仍读完后续页", async (t) => {
  const requestedPages = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const page = Number(new URL(url).searchParams.get("p"));
    requestedPages.push(page);
    // 旧版 NewAPI 的 p 从 0 开始，data 直接是数组。
    const data = page <= 1 ? [{ id: page + 1, name: `渠道 ${page + 1}`, status: 1 }] : [];
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });

  const channels = await queryOwnChannels({ baseUrl: "https://own.test", accessToken: "test-token" });
  assert.deepEqual(channels.map((channel) => channel.id), [1, 2], "旧版第 0 页的渠道不能被跳过");
  assert.equal(channels.totalValidated, false, "无 total 的目录不能据一次缺项确认删除");
  assert.deepEqual(requestedPages, [0, 1, 2]);
});

test("渠道目录分页中途换了响应格式时报错，不拼接两种页码口径的结果", async (t) => {
  const requestedPages = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const page = Number(new URL(url).searchParams.get("p"));
    requestedPages.push(page);
    const items = Array.from({ length: 100 }, (_, index) => ({ id: page * 100 + index + 1, name: `渠道 ${page * 100 + index + 1}` }));
    const data = page === 0 ? items : { total: 300, items };
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });

  await assert.rejects(() => queryOwnChannels({ baseUrl: "https://own.test", accessToken: "test-token" }), /格式中途变化/);
  assert.deepEqual(requestedPages, [0, 1]);
});

test("渠道目录 total 缩减、重叠、坏 ID 或坏总量拒绝整批目录", async (t) => {
  let mode = "changed";
  t.mock.method(globalThis, "fetch", async (input) => {
    const first = new URL(String(input)).searchParams.get("p") === "0";
    const data = mode === "changed" ? first
      ? { total: 102, items: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) }
      : { total: 101, items: [{ id: 102 }] }
      : mode === "duplicate" ? first
        ? { total: 3, items: [{ id: 1 }, { id: 2 }] }
        : { total: 3, items: [{ id: "2" }, { id: 3 }] }
        : mode === "bad-id" ? { total: 1, items: [{ id: null }] }
          : mode === "over-count" ? { total: 1, items: [{ id: 1 }, { id: 2 }] }
            : { total: "", items: [] };
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });
  for (mode of ["changed", "duplicate", "bad-id", "over-count", "bad-total"]) {
    await assert.rejects(queryOwnChannels(ownStation), (error) => error.code === "CHANNEL_CATALOGUE_INVALID");
  }
});

// 上游 Key 列表的替身：tokenData(p) 给出该页 data，其余对账元数据接口固定应答。
function mockUpstreamTokenPages(t, tokenData) {
  const requestedPages = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    let data = null;
    if (url.pathname === "/api/status") data = { quota_per_unit: 100 };
    else if (url.pathname === "/api/user/self/groups") data = { g: { ratio: 1 } };
    else if (url.pathname === "/api/token/") {
      const page = Number(url.searchParams.get("p"));
      requestedPages.push(page);
      data = tokenData(page);
    }
    return data
      ? { status: 200, text: async () => JSON.stringify({ success: true, data }) }
      : { status: 404, text: async () => JSON.stringify({ success: false }) };
  });
  return requestedPages;
}

const upstreamStation = { baseUrl: "https://upstream.test", accessToken: "pat", userId: "42" };
const upstreamToken = (id) => ({ id, name: `Key ${id}`, status: 1, group: "g" });

test("旧版上游 Key 列表从第 0 页读起，不漏掉第一页", async (t) => {
  // 旧版 NewAPI 的 p 从 0 开始，data 直接是数组，没有 total。
  const requestedPages = mockUpstreamTokenPages(t, (page) => (page <= 1 ? [upstreamToken(page + 1)] : []));

  const metadata = await queryNewApiReconciliationMetadata(upstreamStation);
  assert.deepEqual(metadata.tokens.map((token) => token.id), [1, 2], "旧版第 0 页的 Key 不能被跳过");
  assert.deepEqual(requestedPages, [0, 1, 2]);
});

test("新版上游 Key 列表超过一页时不重复请求与 p=0 相同的 p=1", async (t) => {
  const requestedPages = mockUpstreamTokenPages(t, (page) => {
    // 新版 NewAPI 把 p<1 当成第 1 页。
    const start = (Math.max(page, 1) - 1) * 100;
    return { total: 150, items: Array.from({ length: Math.max(0, Math.min(100, 150 - start)) }, (_, index) => upstreamToken(start + index + 1)) };
  });

  const metadata = await queryNewApiReconciliationMetadata(upstreamStation);
  assert.deepEqual(metadata.tokens.map((token) => token.id), Array.from({ length: 150 }, (_, index) => index + 1));
  assert.deepEqual(requestedPages, [0, 2]);
});

test("上游 Key 列表缺页、格式错误、中途换格式或翻页期间变化时明确报错，不把部分列表当成完整列表", async (t) => {
  let mode = "incomplete";
  mockUpstreamTokenPages(t, (page) => {
    if (mode === "malformed") return {};
    if (mode === "switch") return page === 0 ? [upstreamToken(1)] : { total: 2, items: [upstreamToken(2)] };
    // 共 101 把、按 id 倒序：读完第一页（101…2）后 id 60 被删，id 1 前移进第一页，第二页变空且 total 恰好等于已读数量。
    if (mode === "shrunk") return page <= 1
      ? { total: 101, items: Array.from({ length: 100 }, (_, index) => upstreamToken(101 - index)) }
      : { total: 100, items: [] };
    return { total: 101, items: page <= 1 ? Array.from({ length: 100 }, (_, index) => upstreamToken(index + 1)) : [] };
  });

  await assert.rejects(() => queryNewApiReconciliationMetadata(upstreamStation), /分页不完整/);
  mode = "malformed";
  await assert.rejects(() => queryNewApiReconciliationMetadata(upstreamStation), /列表格式异常/);
  mode = "switch";
  await assert.rejects(() => queryNewApiReconciliationMetadata(upstreamStation), /格式中途变化/);
  mode = "shrunk";
  await assert.rejects(() => queryNewApiReconciliationMetadata(upstreamStation), /翻页期间发生变化/, "漏读的 Key 可能与规则 Key 同名，不能当成完整列表");
});

function mockSub2Billing(t, baseName) {
  const state = { mode: "supported", requests: [], cost: 3.25 };
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    state.requests.push({ url, headers: init?.headers });
    let status = 200;
    let data;
    if (url.pathname === "/api/v1/settings/public") data = { turnstile_enabled: false };
    else if (url.pathname === "/api/v1/auth/login") data = { access_token: "fresh-jwt", refresh_token: "fresh-refresh", expires_in: 3600 };
    else if (url.pathname === "/api/v1/auth/me") data = { id: state.mode === "changed-identity" ? 43 : 42, email: "user@example.test" };
    else if (url.pathname === "/api/v1/keys") {
      data = { total: 1, items: [{ id: 9, user_id: state.mode === "foreign-key" ? 43 : 42,
        name: "upstream-key", status: "active", group_id: null, key: "raw-call-secret" }] };
    } else if (url.pathname.startsWith("/api/v1/keys/")) { status = 404; data = null; }
    else if (url.pathname === "/api/v1/usage/stats") {
      if (state.onStat) await state.onStat(url);
      if (state.mode === "auth-error") {
        return { status: 403, text: async () => JSON.stringify({ code: 403, message: "denied Bearer raw-secret" }) };
      }
      if (state.mode === "no-stat") { status = 404; data = null; }
      else if (state.mode === "missing-actual") data = { total_cost: 19 };
      else {
        const missingKey = url.searchParams.get("api_key_id") !== "9";
        const future = Date.parse(url.searchParams.get("start_date")) > Date.now();
        if (state.mode === "control-network" && future) throw new Error("temporary failure raw-secret");
        if (missingKey && state.mode !== "ignore-key") { status = 404; data = null; }
        else data = { total_cost: 19, total_actual_cost: future && state.mode !== "ignore-date" ? 0 : state.cost };
      }
    } else { status = 404; data = null; }
    return { status, text: async () => JSON.stringify({ code: status >= 300 ? status : 0, data }) };
  });
  state.station = { type: "sub2api", baseUrl: `https://${baseName}.test`, accessToken: "jwt" };
  return state;
}

const sub2Day = { startMs: Date.parse("2026-09-29T16:00:00Z"), endMs: Date.parse("2026-09-30T16:00:00Z"), timezone: "Asia/Shanghai" };

test("混合上游元数据以真实 New API 稳定账号验证，不信任配置中的不同用户 ID", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => {
    const path = new URL(String(input)).pathname;
    const data = path === "/api/user/self" ? { id: 42, quota: 1 }
      : path === "/api/status" ? { quota_per_unit: 100 }
        : path === "/api/user/self/groups" ? { g: { ratio: 1 } }
          : { total: 1, items: [upstreamToken(9)] };
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });
  const metadata = await queryReconciliationMetadata({ ...upstreamStation, type: "newapi" });
  assert.equal(metadata.accountId, "42");
  assert.equal(metadata.platform, "newapi");
  assert.equal(metadata.capability.state, "supported");
  await assert.rejects(queryReconciliationMetadata({ ...upstreamStation, type: "newapi", userId: "43" }),
    (error) => error.code === "UPSTREAM_IDENTITY_CHANGED");
});

test("Sub2API JWT 与密码读取相同稳定账号，目录不含密钥且 probe 不轮换共享令牌", async (t) => {
  const state = mockSub2Billing(t, "sub2-identity");
  const jwt = await queryReconciliationMetadata(state.station);
  const password = { ...state.station, type: "sub2api-password", email: "user@example.test", password: "test-password",
    s2Tokens: { accessToken: "shared-old-jwt", refreshToken: "shared-old-refresh", expiresAt: 1 } };
  const oldTokens = structuredClone(password.s2Tokens);
  const login = await queryReconciliationMetadata(password);
  assert.equal(jwt.accountId, login.accountId);
  assert.equal(jwt.accountId, "42");
  assert.deepEqual(password.s2Tokens, oldTokens);
  assert.equal(jwt.tokens[0].group, "");
  assert.equal(jwt.tokens[0].status, 1);
  assert.doesNotMatch(JSON.stringify(jwt), /raw-call-secret|test-password|shared-old/);
  state.mode = "foreign-key";
  await assert.rejects(queryReconciliationMetadata(state.station), (error) => error.code === "UPSTREAM_KEY_CATALOGUE_INVALID");
});

test("Sub2API Key 目录 total 中途变化/重复/格式变化不返回部分列表", async (t) => {
  let mode = "changed-total";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    const item = (id) => ({ id, name: `Key ${id}`, user_id: 42, status: "active", group_id: null });
    const first = url.searchParams.get("page") === "1";
    const data = url.pathname === "/api/v1/auth/me" ? { id: 42 }
      : mode === "changed-total" ? first ? { total: 3, items: [item(1), item(2)] } : { total: 2, items: [] }
        : mode === "duplicate" ? first ? { total: 3, items: [item(1), item(2)] } : { total: 3, items: [item(2)] }
          : { total: 1, items: null };
    return { status: 200, text: async () => JSON.stringify({ code: 0, data }) };
  });
  for (mode of ["changed-total", "duplicate", "malformed"]) {
    await assert.rejects(queryReconciliationMetadata({ type: "sub2api", baseUrl: "https://sub2-pages.test", accessToken: "jwt" }),
      (error) => error.code === "UPSTREAM_KEY_CATALOGUE_INVALID");
  }
});

test("Sub2API 正向非零和 Key/date 负控制通过后可精确取账，真实零保留，授权变化失效能力", async (t) => {
  const state = mockSub2Billing(t, "sub2-verified");
  const metadata = await queryReconciliationMetadata(state.station);
  const input = { token: metadata.tokens[0], metadata, ...sub2Day };
  const first = await queryKeyReconciliationStat(state.station, input);
  assert.equal(first.state, "complete");
  assert.equal(first.amountUsd, 3.25, "不能使用 total_cost 标准计费");
  assert.deepEqual(first.window, sub2Day);
  const main = state.requests.find((item) => item.url.pathname === "/api/v1/usage/stats");
  assert.equal(main.url.searchParams.get("api_key_id"), "9");
  assert.equal(main.url.searchParams.get("start_date"), "2026-09-30");
  assert.equal(main.url.searchParams.get("end_date"), "2026-09-30");
  assert.equal(main.url.searchParams.get("timezone"), "Asia/Shanghai");
  assert.equal((await queryReconciliationMetadata(state.station)).capability.state, "supported");
  const controlCount = state.requests.filter((item) => item.url.pathname.startsWith("/api/v1/keys/")).length;
  state.cost = 0;
  const zero = await queryKeyReconciliationStat(state.station, input);
  assert.equal(zero.amountUsd, 0);
  assert.equal(zero.state, "complete");
  assert.equal(state.requests.filter((item) => item.url.pathname.startsWith("/api/v1/keys/")).length, controlCount);
  const changed = { ...state.station, accessToken: "changed-jwt" };
  const changedMetadata = await queryReconciliationMetadata(changed);
  assert.equal(changedMetadata.capability.state, "unverified");
  const unverifiedZero = await queryKeyReconciliationStat(changed, { ...input, metadata: changedMetadata });
  assert.equal(unverifiedZero.state, "partial");
  assert.equal(unverifiedZero.knownAmountUsd, 0);
  assert.equal(unverifiedZero.amountUsd, null);
  state.mode = "missing-actual";
  await queryKeyReconciliationStat(state.station, input);
  assert.equal((await queryReconciliationMetadata(state.station)).capability.state, "unverified", "接口字段变化必须失效已验证能力");
});

test("Sub2API 忽略 Key/date 过滤或全零样本不会确认完整账单", async (t) => {
  const state = mockSub2Billing(t, "sub2-invalid-filters");
  for (const mode of ["ignore-key", "ignore-date", "supported"]) {
    state.mode = mode;
    if (mode === "supported") state.cost = 0;
    const station = { ...state.station, accessToken: mode };
    const metadata = await queryReconciliationMetadata(station);
    const bill = await queryKeyReconciliationStat(station, { token: metadata.tokens[0], metadata, ...sub2Day });
    assert.equal(bill.state, "partial");
    assert.equal(bill.complete, false);
    assert.equal(bill.amountUsd, null);
    assert.equal(bill.knownAmountUsd, state.cost);
  }
});

test("Sub2API 在途授权更新不能把旧能力证据缓存到新授权", async (t) => {
  const state = mockSub2Billing(t, "sub2-inflight-auth");
  const metadata = await queryReconciliationMetadata(state.station);
  let changed = false;
  state.onStat = () => {
    if (!changed) { changed = true; state.station.accessToken = "edited-jwt"; }
  };
  const first = await queryKeyReconciliationStat(state.station, { token: metadata.tokens[0], metadata, ...sub2Day });
  assert.equal(first.complete, true, "单次临时连接按调用开始时的授权完成；调用模块另行核验在途提交版本");
  const current = await queryReconciliationMetadata(state.station);
  assert.equal(current.capability.state, "unverified");
  state.cost = 0;
  const bill = await queryKeyReconciliationStat(state.station, { token: current.tokens[0], metadata: current, ...sub2Day });
  assert.equal(bill.complete, false);
  assert.equal(bill.knownAmountUsd, 0);
});

test("Sub2API 字段缺失/接口缺失不造零，暂时验证失败保留金额，鉴权错误脱敏", async (t) => {
  const state = mockSub2Billing(t, "sub2-errors");
  const metadata = await queryReconciliationMetadata(state.station);
  const input = { token: metadata.tokens[0], metadata, ...sub2Day };
  for (const mode of ["missing-actual", "no-stat"]) {
    state.mode = mode;
    const bill = await queryKeyReconciliationStat(state.station, input);
    assert.equal(bill.state, "unavailable");
    assert.equal(bill.knownAmountUsd, null);
    assert.equal(bill.capability.state, "unsupported");
  }
  state.mode = "control-network";
  const failedControl = await queryKeyReconciliationStat(state.station, input);
  assert.equal(failedControl.knownAmountUsd, 3.25);
  assert.equal(failedControl.capability.reason, "CAPABILITY_CHECK_FAILED");
  state.mode = "auth-error";
  await assert.rejects(queryKeyReconciliationStat(state.station, input),
    (error) => error.code === "UPSTREAM_AUTH_DENIED" && !error.message.includes("raw-secret"));
  state.mode = "changed-identity";
  await assert.rejects(queryKeyReconciliationStat(state.station, input), (error) => error.code === "UPSTREAM_IDENTITY_CHANGED");
});

test("Sub2API 仅自然日，拒绝滚动窗口/未结束日，夏令时 23 小时日仍完整", async (t) => {
  const state = mockSub2Billing(t, "sub2-natural-days");
  const metadata = await queryReconciliationMetadata(state.station);
  const input = { token: metadata.tokens[0], metadata, ...sub2Day };
  await assert.rejects(queryKeyReconciliationStat(state.station, { ...input, startMs: input.startMs + 3600000 }),
    (error) => error.code === "UPSTREAM_WINDOW_UNSUPPORTED");
  await assert.rejects(queryKeyReconciliationStat(state.station, { ...input, startMs: Date.parse("2099-01-01T00:00:00Z"),
    endMs: Date.parse("2099-01-02T00:00:00Z"), timezone: "UTC" }), (error) => error.code === "UPSTREAM_WINDOW_PENDING");
  const dst = await queryKeyReconciliationStat(state.station, { ...input, startMs: Date.parse("2026-03-08T05:00:00Z"),
    endMs: Date.parse("2026-03-09T04:00:00Z"), timezone: "America/New_York" });
  assert.equal(dst.state, "complete");
  const query = state.requests.filter((item) => item.url.pathname === "/api/v1/usage/stats").at(-3).url;
  assert.equal(query.searchParams.get("start_date"), "2026-03-08");
  assert.equal(query.searchParams.get("end_date"), "2026-03-08");
});

// 本站管理端 Key 列表的替身：tokenData(p) 给出该页 data，并记录每次请求的页码与 New-Api-User 头。
function mockAdminTokenPages(t, tokenData) {
  const requestedPages = [];
  const userHeaders = new Set();
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const page = Number(new URL(String(input)).searchParams.get("p"));
    requestedPages.push(page);
    userHeaders.add(init?.headers?.["New-Api-User"]);
    return { status: 200, text: async () => JSON.stringify({ success: true, data: tokenData(page) }) };
  });
  return { requestedPages, userHeaders };
}

const ownStation = { baseUrl: "https://own.test", accessToken: "test-token" };
// 带上明文 key，用来确认返回值不会把它带出去。
const adminToken = (id) => ({ id, name: `Key ${id}`, status: 1, used_quota: 500000, remain_quota: 250000, key: `sk-secret-${id}` });

test("旧版管理端 Key 列表从第 0 页读起，不漏掉第一页", async (t) => {
  // 旧版 NewAPI 的 p 从 0 开始，data 直接是数组，没有 total。
  const { requestedPages, userHeaders } = mockAdminTokenPages(t, (page) => (page <= 1 ? [adminToken(page + 1)] : []));

  const tokens = await queryAdminTokens(ownStation, 7);
  assert.deepEqual(tokens.map((token) => token.id), [1, 2], "旧版第 0 页的 Key 不能被跳过");
  assert.deepEqual(tokens[0], { id: 1, name: "Key 1", status: 1, usedUsd: 1, remainUsd: 0.5 });
  assert.ok(!JSON.stringify(tokens).includes("sk-secret"), "返回值不能带明文 Key");
  assert.deepEqual(requestedPages, [0, 1, 2]);
  assert.deepEqual([...userHeaders], ["7"], "每一页都要带目标账号的 New-Api-User 头");
});

test("新版管理端 Key 列表超过一页时不重复请求与 p=0 相同的 p=1", async (t) => {
  const { requestedPages } = mockAdminTokenPages(t, (page) => {
    // 新版 NewAPI 把 p<1 当成第 1 页。
    const start = (Math.max(page, 1) - 1) * 100;
    return { total: 150, items: Array.from({ length: Math.max(0, Math.min(100, 150 - start)) }, (_, index) => adminToken(start + index + 1)) };
  });

  const tokens = await queryAdminTokens(ownStation, 7);
  assert.deepEqual(tokens.map((token) => token.id), Array.from({ length: 150 }, (_, index) => index + 1));
  assert.deepEqual(requestedPages, [0, 2]);
});

test("管理端 Key 列表仍最多读 5 页，读满后返回已读到的部分", async (t) => {
  const { requestedPages } = mockAdminTokenPages(t, (page) => {
    const start = (Math.max(page, 1) - 1) * 100;
    return { total: 700, items: Array.from({ length: Math.max(0, Math.min(100, 700 - start)) }, (_, index) => adminToken(start + index + 1)) };
  });

  const tokens = await queryAdminTokens(ownStation, 7);
  assert.equal(tokens.length, 500);
  assert.deepEqual(requestedPages, [0, 2, 3, 4, 5]);
});

test("管理端 Key 列表缺页、格式错误、中途换格式或整页重复时明确报错，不把部分列表当成完整列表", async (t) => {
  let mode = "incomplete";
  mockAdminTokenPages(t, (page) => {
    if (mode === "malformed") return {};
    if (mode === "switch") return page === 0 ? [adminToken(1)] : { total: 2, items: [adminToken(2)] };
    if (mode === "duplicate") return { total: 300, items: Array.from({ length: 100 }, (_, index) => adminToken(index + 1)) };
    return { total: 101, items: page <= 1 ? Array.from({ length: 100 }, (_, index) => adminToken(index + 1)) : [] };
  });

  await assert.rejects(() => queryAdminTokens(ownStation, 7), /分页不完整/);
  mode = "malformed";
  await assert.rejects(() => queryAdminTokens(ownStation, 7), /列表格式异常/);
  mode = "switch";
  await assert.rejects(() => queryAdminTokens(ownStation, 7), /格式中途变化/);
  mode = "duplicate";
  await assert.rejects(() => queryAdminTokens(ownStation, 7), /分页重复/);
});

function seededHex(seed, length) {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;
  let out = "";
  while (out.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out += (state >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

test("Sub2API password login solves a Cap challenge and sends turnstile_token", async (t) => {
  const challengeToken = "local-challenge";
  const challengeSpec = { c: 2, s: 8, d: 1 };
  let origin;
  let loginBody;

  const server = createServer(async (request, response) => {
    if (request.url === "/api/v1/settings/public") {
      return sendJson(response, {
        code: 0,
        data: {
          turnstile_enabled: true,
          captcha_provider: "cap",
          cap_api_endpoint: `${origin}/cap`,
          cap_site_key: "local-site",
        },
      });
    }
    if (request.url === "/cap/local-site/challenge" && request.method === "POST") {
      return sendJson(response, { challenge: challengeSpec, token: challengeToken });
    }
    if (request.url === "/cap/local-site/redeem" && request.method === "POST") {
      const body = await readJson(request);
      assert.equal(body.token, challengeToken);
      assert.equal(body.solutions.length, challengeSpec.c);
      for (let i = 0; i < body.solutions.length; i++) {
        const n = i + 1;
        const salt = seededHex(`${challengeToken}${n}`, challengeSpec.s);
        const target = seededHex(`${challengeToken}${n}d`, challengeSpec.d);
        const hash = createHash("sha256").update(`${salt}${body.solutions[i]}`).digest("hex");
        assert.ok(hash.startsWith(target));
      }
      return sendJson(response, { success: true, token: "local-cap-token", expires: Date.now() + 60000 });
    }
    if (request.url === "/api/v1/auth/login" && request.method === "POST") {
      loginBody = await readJson(request);
      return sendJson(response, {
        code: 0,
        data: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          user: { email: "user@example.com" },
        },
      });
    }
    if (request.url === "/api/v1/auth/me") {
      assert.equal(request.headers.authorization, "Bearer access-token");
      return sendJson(response, {
        code: 0,
        data: { email: "user@example.com", balance: 12.5, total_recharged: 20 },
      });
    }
    if (request.url === "/api/v1/usage/dashboard/stats") {
      return sendJson(response, {
        code: 0,
        data: { today_actual_cost: 1.25, today_requests: 3, today_tokens: 4000 },
      });
    }
    sendJson(response, { error: "not found" }, 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;

  const station = {
    type: "sub2api-password",
    baseUrl: origin,
    email: "user@example.com",
    password: "secret123",
  };
  const { result, tokensChanged } = await queryStation(station);

  assert.equal(result.ok, true);
  assert.equal(result.remaining, 12.5);
  assert.equal(result.used, 7.5);
  assert.equal(result.todayUsed, 1.25);
  assert.equal(tokensChanged, true);
  assert.deepEqual(loginBody, {
    email: "user@example.com",
    password: "secret123",
    turnstile_token: "local-cap-token",
  });
  assert.equal(station.s2Tokens.refreshToken, "refresh-token");
});

test("流向数据把用户/分组/模型/渠道口径归一化", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/data/flow");
    assert.equal(request.headers.authorization, "adm");
    assert.equal(request.headers["new-api-user"], "6");
    assert.equal(url.searchParams.get("start_timestamp"), "1000");
    assert.equal(url.searchParams.get("end_timestamp"), "1059"); // 结束值包含式，减到窗内最后一秒
    sendJson(response, {
      success: true,
      data: [
        { username: "a", use_group: "grok", model_name: "grok-4.6", channel_id: 7, channel_name: "sol", token_used: 400, count: 596, quota: 76000000 },
        { username: "b", use_group: "", model_name: "gpt-4o", channel_id: 1, token_used: 100, count: 3, quota: 500000 },
      ],
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnFlow } = await import("./providers.js");

  const rows = await queryOwnFlow({ baseUrl: origin, accessToken: "adm", userId: "6" }, 1000000, 1060000);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    user: "a", group: "grok", model: "grok-4.6", channelId: 7, channelName: "sol",
    tokenName: "", tokens: 400, cost: 152, requests: 596,
  });
  assert.equal(rows[1].channelName, ""); // 没有 channel_name 时留空，由调用方兜底
});

test("渠道对账用固定 Key 名称查询分段统计，不用当前分组过滤旧日志", async (t) => {
  let selfCalls = 0;
  let expectedUserId = "42";
  let flowCalls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { version: "test", quota_per_unit: 100 } });
    }
    if (url.pathname === "/api/user/self") {
      selfCalls += 1;
      assert.equal(request.headers.authorization, "Bearer pat");
      assert.equal(request.headers["new-api-user"], undefined);
      return sendJson(response, { success: true, data: { id: 42 } });
    }
    if (["/api/token/", "/api/user/self/groups", "/api/log/self/stat"].includes(url.pathname)) {
      assert.equal(request.headers.authorization, "Bearer pat");
      assert.equal(request.headers["new-api-user"], expectedUserId);
    }
    if (url.pathname === "/api/token/") {
      return sendJson(response, { success: true, data: { total: 1, items: [
        { id: 9, name: "oai", status: 1, group: "oai", cross_group_retry: false, key: "sk-masked" },
      ] } });
    }
    if (url.pathname === "/api/user/self/groups") {
      return sendJson(response, { success: true, data: { oai: { ratio: 2.3, desc: "OpenAI" } } });
    }
    if (url.pathname === "/api/log/self/stat") {
      assert.equal(url.searchParams.get("type"), "2");
      assert.equal(url.searchParams.get("token_name"), "oai");
      assert.equal(url.searchParams.has("group"), false);
      assert.equal(url.searchParams.get("start_timestamp"), "1000");
      assert.equal(url.searchParams.get("end_timestamp"), "1059");
      assert.equal(url.searchParams.has("p"), false);
      assert.equal(url.searchParams.has("page_size"), false);
      // A compatible fork may include non-consumption quota when type=0.
      const rows = [{ type: 2, quota: 400 }, { type: 1, quota: 1000 }];
      const type = Number(url.searchParams.get("type") || 0);
      const quota = rows.filter((row) => !type || row.type === type).reduce((sum, row) => sum + row.quota, 0);
      return sendJson(response, { success: true, data: { quota, rpm: 2, tpm: 3 } });
    }
    if (url.pathname === "/api/log/stat") {
      assert.equal(url.searchParams.get("type"), "2");
      assert.equal(url.searchParams.get("channel"), "1");
      assert.equal(url.searchParams.has("channel_id"), false);
      assert.equal(url.searchParams.get("start_timestamp"), "1000");
      assert.equal(url.searchParams.get("end_timestamp"), "1059");
      return sendJson(response, { success: true, data: { quota: 500 } });
    }
    if (url.pathname === "/api/data/flow") {
      flowCalls += 1;
      return sendJson(response, { success: true, data: [
        { channel_id: 1, channel_name: "渠道 A", quota: 500, token_used: 2, count: 1 },
        { channel_id: 2, channel_name: "渠道 B", quota: 300, token_used: 1, count: 1 },
      ] });
    }
    if (url.pathname === "/api/data/") {
      return sendJson(response, { success: true, data: [
        { model_name: "gpt", created_at: 1000, quota: 800, token_used: 3, count: 2 },
      ] });
    }
    return sendJson(response, { error: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryNewApiReconciliationMetadata, queryNewApiTokenStat, queryOwnChannelRevenue } = await import("./providers.js");
  const station = { baseUrl: origin, accessToken: "pat" };

  const metadata = await queryNewApiReconciliationMetadata(station);
  assert.equal(selfCalls, 1);
  assert.deepEqual(metadata.groups.oai, { ratio: 2.3, description: "OpenAI" });
  assert.equal(metadata.tokens[0].id, 9);
  assert.equal(metadata.tokens[0].maskedKey, "sk-masked");
  assert.equal(metadata.userId, "42", "元数据要带出已解析的 PAT 身份，供分段统计复用");

  const upstream = await queryNewApiTokenStat(station, { tokenName: "oai", startMs: 1000000, endMs: 1060000 });
  assert.equal(selfCalls, 2);
  assert.equal(upstream.quotaUnits, 400);
  assert.equal(upstream.quotaPerUnit, 100);
  assert.equal(upstream.quotaUnits / upstream.quotaPerUnit, 4);

  expectedUserId = "configured-user";
  const configuredStation = { baseUrl: origin, accessToken: "pat", userId: expectedUserId };
  assert.equal((await queryNewApiReconciliationMetadata(configuredStation)).userId, "configured-user");
  assert.equal(selfCalls, 2);
  await queryNewApiTokenStat(configuredStation, { tokenName: "oai", startMs: 1000000, endMs: 1060000 });
  assert.equal(selfCalls, 2);

  const downstream = await queryOwnChannelRevenue(station, { channelIds: [1], startMs: 1000000, endMs: 1060000 });
  assert.equal(downstream.quotaUnits, 500);
  assert.equal(downstream.channels[0].amountUsd, 5);
  assert.equal(downstream.successfulCount, 1);
  assert.equal(downstream.billingSource, "channel-log-stat");
  assert.equal(downstream.calculationVersion, 3);
  assert.equal(flowCalls, 0, "财务收费不得请求 /api/data/flow");
});

test("对账分段复用已读到的 PAT 身份与 /api/status，复用值无效时照样报错", async (t) => {
  const paths = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    paths.push(url.pathname);
    if (url.pathname === "/api/log/self/stat") {
      assert.equal(request.headers["new-api-user"], "42");
      return sendJson(response, { success: true, data: { quota: 400 } });
    }
    if (url.pathname === "/api/log/stat") return sendJson(response, { success: true, data: { quota: 500 } });
    return sendJson(response, { error: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryNewApiTokenStat, queryOwnChannelRevenue } = await import("./providers.js");
  const station = { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "pat" };
  const window = { startMs: 1000000, endMs: 1060000 };

  const upstream = await queryNewApiTokenStat(station, { tokenName: "oai", ...window, userId: "42", status: { quotaPerUnit: 100, version: "v" } });
  assert.equal(upstream.quotaUnits / upstream.quotaPerUnit, 4);
  assert.equal(upstream.version, "v");
  let loads = 0;
  const loadStatus = async () => { loads += 1; return { quotaPerUnit: 100, version: "own" }; };
  const downstream = await queryOwnChannelRevenue(station, { channelIds: [1, 2], ...window, loadStatus });
  assert.equal(downstream.amountUsd, 10);
  assert.equal(loads, 1);
  assert.deepEqual(paths.filter((path) => path === "/api/status" || path === "/api/user/self"), [], "复用时不得再探测身份或站点状态");

  await assert.rejects(
    () => queryNewApiTokenStat(station, { tokenName: "oai", ...window, userId: "42", status: { quotaPerUnit: 0, version: "v" } }),
    /quota_per_unit/
  );
  const unavailable = await queryOwnChannelRevenue(station, { channelIds: [1], ...window, loadStatus: async () => ({ version: "own" }) });
  assert.equal(unavailable.state, "partial");
  assert.equal(unavailable.knownAmountUsd, null);
  const empty = await queryOwnChannelRevenue(station, { channelIds: [1], startMs: 1500, endMs: 1999, loadStatus: () => assert.fail("空秒窗口不应读取站点状态") });
  assert.equal(empty.emptySecondWindow, true);
});

test("演示站点的对账统计只包含请求的消费日志类型", async () => {
  const { mockNewApiSelfLogStat, mockNewApiLogStat } = await import("../server/demo.js");
  const headers = { Authorization: "Bearer pat" };
  const query = "start_timestamp=1000&end_timestamp=2000";
  const selfConsume = mockNewApiSelfLogStat(new Request(`http://demo/api/log/self/stat?${query}&type=2`, { headers }));
  const selfOther = mockNewApiSelfLogStat(new Request(`http://demo/api/log/self/stat?${query}&type=1`, { headers }));
  const ownConsume = mockNewApiLogStat(new Request(`http://demo/api/log/stat?${query}&type=2`, { headers }));
  const ownOther = mockNewApiLogStat(new Request(`http://demo/api/log/stat?${query}&type=1`, { headers }));
  assert.ok(selfConsume.body.data.quota > 0);
  assert.equal(selfOther.body.data.quota, 0);
  assert.ok(ownConsume.body.data.quota > 0);
  assert.equal(ownOther.body.data.quota, 0);
});

test("渠道对账以渠道账单 stat 为收费事实源，不使用偏低的 flow 聚合", async (t) => {
  let flowCalls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 500000 } });
    }
    if (url.pathname === "/api/log/stat") {
      assert.equal(url.searchParams.get("type"), "2");
      assert.equal(url.searchParams.get("channel"), "312");
      assert.equal(url.searchParams.has("channel_id"), false);
      return sendJson(response, { success: true, data: { quota: 4821634 } });
    }
    if (url.pathname === "/api/data/flow") {
      flowCalls += 1;
      return sendJson(response, { success: true, data: [{ channel_id: 312, quota: 3355887 }] });
    }
    return sendJson(response, { success: false }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnChannelRevenue } = await import("./providers.js");

  const result = await queryOwnChannelRevenue(
    { baseUrl: origin, accessToken: "admin" },
    { channelIds: [312], startMs: 1000000, endMs: 1060000 }
  );

  assert.equal(result.quotaUnits, 4821634);
  assert.equal(result.amountUsd, 9.643268);
  assert.equal(result.channels[0].quotaUnits, 4821634);
  assert.equal(flowCalls, 0, "财务收费不得回退到 /api/data/flow");
});

test("多渠道账单按去重渠道并行查询并只汇总一次", async (t) => {
  const requestedChannels = [];
  let active = 0;
  let maxActive = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 100 } });
    }
    if (url.pathname === "/api/log/stat") {
      const channelId = Number(url.searchParams.get("channel"));
      requestedChannels.push(channelId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return setTimeout(() => {
        active -= 1;
        sendJson(response, { success: true, data: { quota: channelId === 1 ? 250 : 350 } });
      }, 15);
    }
    return sendJson(response, { success: false }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryOwnChannelRevenue } = await import("./providers.js");
  const result = await queryOwnChannelRevenue(
    { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "admin" },
    { channelIds: [1, 1, 2], startMs: 1000000, endMs: 1060000 }
  );

  assert.deepEqual(requestedChannels.sort((a, b) => a - b), [1, 2]);
  assert.ok(maxActive > 1, "不同渠道应并行读取账单统计");
  assert.equal(result.quotaUnits, 600);
  assert.equal(result.amountUsd, 6);
  assert.deepEqual(result.channels.map((channel) => [channel.channelId, channel.quotaUnits, channel.amountUsd]), [
    [1, 250, 2.5],
    [2, 350, 3.5],
  ]);
});

test("渠道账单失败或 quota 缺失保留成功明细，完整金额仍失败关闭，quota=0 仍有效", async (t) => {
  let mode = "zero";
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 100 } });
    }
    if (url.pathname === "/api/log/stat") {
      const channelId = Number(url.searchParams.get("channel"));
      if (channelId === 2 && mode === "http-error") return sendJson(response, { success: false }, 500);
      if (channelId === 2 && mode === "missing") return sendJson(response, { success: true, data: {} });
      if (channelId === 2 && mode === "null") return sendJson(response, { success: true, data: { quota: null } });
      if (channelId === 2 && mode === "blank") return sendJson(response, { success: true, data: { quota: "  " } });
      if (channelId === 2 && mode === "boolean") return sendJson(response, { success: true, data: { quota: false } });
      if (channelId === 2 && mode === "negative") return sendJson(response, { success: true, data: { quota: -1 } });
      if (channelId === 2 && mode === "array") return sendJson(response, { success: true, data: { quota: [] } });
      if (channelId === 2 && mode === "object") return sendJson(response, { success: true, data: { quota: {} } });
      if (mode === "overflow") return sendJson(response, { success: true, data: { quota: Number.MAX_VALUE } });
      return sendJson(response, { success: true, data: { quota: channelId === 1 ? 0 : 100 } });
    }
    return sendJson(response, { success: false }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryOwnChannelRevenue } = await import("./providers.js");
  const station = { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "admin" };
  const window = { channelIds: [1], startMs: 1000000, endMs: 1060000 };

  const zero = await queryOwnChannelRevenue(station, window);
  assert.equal(zero.quotaUnits, 0);
  assert.equal(zero.channels[0].amountUsd, 0);

  mode = "http-error";
  let partial = await queryOwnChannelRevenue(station, { ...window, channelIds: [1, 2] });
  assert.equal(partial.state, "partial");
  assert.equal(partial.amountUsd, null);
  mode = "missing";
  partial = await queryOwnChannelRevenue(station, { ...window, channelIds: [1, 2] });
  assert.equal(partial.state, "partial");
  for (const invalidMode of ["null", "blank", "boolean", "negative", "array", "object", "overflow"]) {
    mode = invalidMode;
    partial = await queryOwnChannelRevenue(station, { ...window, channelIds: [1, 2] });
    assert.equal(partial.state, "partial", invalidMode);
    assert.equal(partial.amountUsd, null, invalidMode);
  }
});

test("无效 quota_per_unit、未知倍率与负上游 quota 不会被隐式换算为零", async (t) => {
  let quotaPerUnit = 100;
  let upstreamQuota = 100;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    const body = url.pathname === "/api/status" ? { success: true, data: { quota_per_unit: quotaPerUnit } }
      : url.pathname === "/api/user/self" ? { success: true, data: { id: 7 } }
        : url.pathname === "/api/user/self/groups" ? { success: true, data: { g: { ratio: null } } }
          : url.pathname === "/api/token/" ? { success: true, data: { total: 1, items: [{ id: 9, name: "stable", status: 1, group: "g", cross_group_retry: false }] } }
            : url.pathname === "/api/log/self/stat" ? { success: true, data: { quota: upstreamQuota } }
              : { success: false };
    return { status: body.success ? 200 : 404, text: async () => JSON.stringify(body) };
  });
  const { queryNewApiStatus, queryNewApiReconciliationMetadata, queryNewApiTokenStat } = await import("./providers.js");
  const station = { baseUrl: "https://numeric.test", accessToken: "pat" };
  for (const invalid of [null, "", false]) {
    quotaPerUnit = invalid;
    await assert.rejects(() => queryNewApiStatus(station), /quota_per_unit/);
  }
  quotaPerUnit = 100;
  const metadata = await queryNewApiReconciliationMetadata(station);
  assert.equal(metadata.groups.g.ratio, null);
  for (const invalid of [null, "", true, -1]) {
    upstreamQuota = invalid;
    await assert.rejects(
      () => queryNewApiTokenStat(station, { tokenName: "stable", startMs: 1000000, endMs: 1060000 }),
      (error) => error.code === "UPSTREAM_STAT_UNAVAILABLE"
    );
  }
  for (const validZero of [0, "0"]) {
    upstreamQuota = validZero;
    assert.equal((await queryNewApiTokenStat(station, { tokenName: "stable", startMs: 1000000, endMs: 1060000 })).quotaUnits, 0);
  }
});

test("渠道账单部分失败仍保留成功渠道的原始 quota 与已获取小计", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 100 } });
    }
    if (url.pathname === "/api/log/stat") {
      const channelId = Number(url.searchParams.get("channel"));
      if (channelId === 2) return sendJson(response, { success: false, message: "denied" }, 403);
      return sendJson(response, { success: true, data: { quota: 250 } });
    }
    return sendJson(response, { success: false }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryOwnChannelRevenue } = await import("./providers.js");

  const result = await queryOwnChannelRevenue(
    { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "admin" },
    { channelIds: [1, 2], startMs: 1000000, endMs: 1060000 }
  );

  assert.equal(result.state, "partial");
  assert.equal(result.amountUsd, null);
  assert.equal(result.knownAmountUsd, 2.5);
  assert.equal(result.successfulCount, 1);
  assert.equal(result.expectedCount, 2);
  assert.deepEqual(result.channels.map((channel) => [channel.channelId, channel.billingState, channel.quotaUnits, channel.amountUsd]), [
    [1, "complete", 250, 2.5],
    [2, "unavailable", null, null],
  ]);
});

test("非整秒窗口只归属完全落在窗口内的 NewAPI 秒，和分段位置无关", async () => {
  const { unixSecondWindow } = await import("./providers.js");
  assert.deepEqual(unixSecondWindow(1000, 1500), { start: 1, end: 0, empty: true });
  assert.deepEqual(unixSecondWindow(1500, 3000), { start: 2, end: 2 });
  assert.deepEqual(unixSecondWindow(1500, 1999), { start: 2, end: 0, empty: true });
});

test("空秒窗口不会请求上下游 API，并明确返回无可核算秒", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    sendJson(response, { success: true, data: {} });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const station = { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "pat" };
  const { queryOwnData, queryOwnFlow, queryOwnChannelRevenue, queryNewApiTokenStat } = await import("./providers.js");

  const ownData = await queryOwnData(station, 1500, 1999, "model");
  const ownFlow = await queryOwnFlow(station, 1500, 1999);
  const ownRevenue = await queryOwnChannelRevenue(station, { channelIds: [1], startMs: 1500, endMs: 1999 });
  const upstream = await queryNewApiTokenStat(station, { tokenName: "fixed-key", startMs: 1500, endMs: 1999 });

  assert.equal(requests, 0);
  assert.equal(ownData.emptySecondWindow, true);
  assert.equal(ownFlow.emptySecondWindow, true);
  assert.equal(ownRevenue.emptySecondWindow, true);
  assert.equal(upstream.emptySecondWindow, true);
});

test("其余秒级用量与日志查询在空窗口不发 HTTP，并保留空数据返回形状", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    sendJson(response, { success: true, data: {} });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const station = { type: "newapi", baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "pat" };
  const { queryStationUsage, queryOwnLogAudit, queryLogStat } = await import("./providers.js");

  const usage = await queryStationUsage(station, { startMs: 1500, endMs: 1999 });
  const audit = await queryOwnLogAudit(station, { startMs: 1500, endMs: 1999 });
  const stat = await queryLogStat(station, { username: "admin", tokenName: "resold", startMs: 1500, endMs: 1999 });

  assert.equal(requests, 0);
  assert.equal(usage.emptySecondWindow, true);
  assert.deepEqual(usage.models, []);
  assert.deepEqual(usage.trend, []);
  assert.equal(audit.emptySecondWindow, true);
  assert.equal(audit.scanned, 0);
  assert.equal(audit.totals, null);
  assert.equal(stat, 0);
});

test("演示 NewAPI 的 PAT 身份响应包含稳定用户 ID", async () => {
  const { mockNewApiUserSelf } = await import("../server/demo.js");
  const result = mockNewApiUserSelf(new Request("http://demo", { headers: { Authorization: "Bearer pat" } }), "demo");
  assert.equal(result.status, 200);
  assert.equal(Number.isInteger(result.body.data.id) && result.body.data.id > 0, true);
});

test("渠道对账不会透传上游错误中的凭证内容", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 100 } });
    }
    if (url.pathname === "/api/user/self") {
      return sendJson(response, { success: true, data: { id: 42 } });
    }
    if (url.pathname === "/api/user/self/groups") {
      return sendJson(response, { success: false, message: "permission denied: Authorization Bearer pat_secret" });
    }
    if (url.pathname === "/api/token/") {
      return sendJson(response, { success: true, data: { total: 0, items: [] } });
    }
    return sendJson(response, { error: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const metadata = await queryNewApiReconciliationMetadata({ baseUrl: origin, accessToken: "pat" });
  assert.equal(metadata.groupsAvailable, false);
  assert.equal(metadata.groupError, "上游分组目录读取失败");
  assert.doesNotMatch(metadata.groupError, /pat_secret/);
});

test("上游统计使用已有 Bearer PAT 且认证失败不会泄露凭证", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 100 } });
    }
    assert.equal(request.headers.authorization, "Bearer already-prefixed");
    return sendJson(response, { success: false, message: "permission denied: Bearer secret-value" }, 403);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryNewApiTokenStat } = await import("./providers.js");

  await assert.rejects(
    queryNewApiTokenStat({ baseUrl: origin, accessToken: "Bearer already-prefixed" }, {
      tokenName: "fixed-key", startMs: 1000000, endMs: 1060000,
    }),
    (err) => err.code === "UPSTREAM_AUTH_DENIED" && !/secret-value|already-prefixed/.test(err.message)
  );
});

test("日志精算把缓存读写算进真实 token，并按语义避免重复计数", async (t) => {
  // Claude 语义：prompt_tokens 只是未命中缓存的输入，缓存读写额外计费（看板漏计的就是这块）
  const claudeRow = (i) => ({
    id: i, created_at: 1700000000 + i, model_name: "claude-sonnet-4-5", username: "u1",
    prompt_tokens: 1000, completion_tokens: 2000, quota: 500000, channel: 3, channel_name: "Claude-Max", group: "claude",
    other: JSON.stringify({
      usage_semantic: "anthropic", claude: true, cache_tokens: 300000, cache_write_tokens: 20000,
      model_ratio: 5, group_ratio: 1, completion_ratio: 5,
    }),
  });
  // OpenAI 语义：缓存 token 本就含在 prompt_tokens 里，真实 token 不能再加一遍
  const gptRow = {
    id: 99, created_at: 1700000500, model_name: "gpt-4o", username: "u2",
    prompt_tokens: 250000, completion_tokens: 1000, quota: 1000000, channel: 1, channel_name: "luna", group: "default",
    other: JSON.stringify({ cache_tokens: 100000, model_ratio: 2.5, group_ratio: 1, completion_ratio: 4, matched_tier: ">200k" }),
  };
  const pages = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/log/");
    assert.equal(url.searchParams.get("type"), "2");
    assert.equal(url.searchParams.get("page_size"), "100");
    const p = Number(url.searchParams.get("p"));
    pages.push(p);
    const items = p === 1 ? Array.from({ length: 100 }, (_, i) => claudeRow(i + 1)) : p === 2 ? [gptRow] : [];
    sendJson(response, { success: true, data: { page: p, page_size: 100, total: 101, items } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnLogAudit } = await import("./providers.js");

  const r = await queryOwnLogAudit({ baseUrl: origin, accessToken: "adm" }, {
    startMs: 1700000000000, endMs: 1700001000000, maxRows: 4000,
  });
  assert.equal(r.scanned, 101);
  assert.equal(r.total, 101);
  assert.equal(r.truncated, false);
  assert.deepEqual(pages.slice(0, 2), [1, 2]);

  const claude = r.byModel.find((m) => m.model === "claude-sonnet-4-5");
  assert.equal(claude.billedTokens, 100 * 3000); // 看板口径
  assert.equal(claude.cacheReadTokens, 100 * 300000);
  assert.equal(claude.cacheWriteTokens, 100 * 20000);
  assert.equal(claude.trueTokens, 100 * (3000 + 300000 + 20000)); // 真实口径
  assert.equal(claude.anthropicPct, 100);
  assert.equal(claude.longRequests, 100); // 输入 321000 ≥ 20 万，属长上下文
  assert.deepEqual(claude.avgModelRatio, 5);

  const gpt = r.byModel.find((m) => m.model === "gpt-4o");
  assert.equal(gpt.billedTokens, 251000);
  assert.equal(gpt.trueTokens, 251000); // 缓存 token 已在 prompt 内，不再叠加
  assert.equal(gpt.cacheReadTokens, 100000);
  assert.equal(gpt.longRequests, 1);
  assert.deepEqual(gpt.tiers, [{ name: ">200k", requests: 1 }]);

  assert.equal(r.totals.requests, 101);
  assert.equal(r.byChannel.map((c) => c.channel).sort().join(","), "Claude-Max,luna");
  assert.equal(r.byGroup.length, 2);
});

test("日志精算按条数上限截断并如实报告覆盖范围", async (t) => {
  const server = createServer((request, response) => {
    const p = Number(new URL(request.url, "http://x").searchParams.get("p"));
    sendJson(response, {
      success: true,
      data: {
        total: 5000,
        items: Array.from({ length: 100 }, (_, i) => ({
          id: p * 1000 + i, created_at: 1700000000 - (p - 1) * 100 - i,
          model_name: "m", username: "u", prompt_tokens: 1, completion_tokens: 1, quota: 500, other: "",
        })),
      },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryOwnLogAudit } = await import("./providers.js");

  const r = await queryOwnLogAudit(
    { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "adm" },
    { startMs: 1600000000000, endMs: 1700001000000, maxRows: 300 }
  );
  assert.equal(r.scanned, 300);
  assert.equal(r.truncated, true);
  assert.equal(r.toMs, 1700000000000);
  assert.equal(r.fromMs, (1700000000 - 2 * 100 - 99) * 1000); // 只覆盖最近 3 页
});
